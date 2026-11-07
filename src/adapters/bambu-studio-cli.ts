import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type {
  OverrideAuditEntry,
  ParameterOverrides,
  PresetKind,
  PresetRecord,
  PresetValue,
  SliceRequest,
  SliceResult,
} from '../domain/contracts.js';
import { looksLikeZip } from '../domain/model/threemf-reader.js';
import { filamentColourArgs } from '../domain/slicing/filament-colours.js';
import { parseGcodeStats } from '../domain/slicing/gcode-stats.js';
import { routeOverrides, type OverrideRouting } from '../domain/slicing/overrides.js';
import { readZipDirectory, extractEntry, readZipEntry } from '../domain/slicing/zip.js';
import { toFlattenedPresetFile, valuesEqual } from '../domain/presets/resolver.js';
import type { PresetStore } from '../ports/preset-store.js';
import type { Slicer } from '../ports/slicer.js';

/**
 * BambuStudio command-line adapter.
 *
 * The single most important rule here: **never hand a raw preset path to the CLI**.
 *
 * When BambuStudio CLI loads the JSON given to `--load-settings` it does not resolve
 * `inherits`: only the keys the leaf preset declares itself take effect, and everything
 * else falls back to the executable's built-in defaults. Measured on a 20 mm cube with
 * X1C / 0.20mm Standard / PLA Basic: loading the leaf presets directly gave 10m 11s and
 * 20% infill; flattening first gave 8m 45s and 15% infill (the factory preset's real
 * values). This is BambuStudio#1704.
 *
 * So every slice first flattens all three presets, writes them as temporary JSON and
 * passes those to the CLI; after slicing, the settings that actually took effect are
 * read back from the output and audited.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

export function defaultExecutablePath(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
    case 'win32':
      return join(
        process.env['ProgramFiles'] ?? 'C:\\Program Files',
        'Bambu Studio',
        'bambu-studio.exe',
      );
    default:
      return join(homedir(), '.local', 'bin', 'bambu-studio');
  }
}

export type BambuStudioCliOptions = {
  readonly executablePath?: string;
  readonly timeoutMs?: number;
  /** Output directory for sliced files. When unset the slice tool refuses to run rather than writing somewhere arbitrary on the user's file system. */
  readonly outputDir?: string;
};

export class BambuStudioCli implements Slicer {
  readonly executablePath: string;
  readonly outputDir: string | undefined;
  readonly #timeoutMs: number;
  readonly #presets: PresetStore;

  constructor(presets: PresetStore, options: BambuStudioCliOptions = {}) {
    this.#presets = presets;
    this.executablePath = options.executablePath ?? defaultExecutablePath();
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.outputDir = options.outputDir;
  }

  available(): boolean {
    return existsSync(this.executablePath);
  }

  async version(): Promise<string | undefined> {
    if (!this.available()) return undefined;
    const result = await this.#run(['--help'], 20_000);
    // The version is printed on the first line of the help output: `BambuStudio-02.07.01.62:`
    const match = /BambuStudio-([\d.]+)/.exec(`${result.stdout}\n${result.stderr}`);
    return match?.[1];
  }

  async slice(request: SliceRequest): Promise<SliceResult> {
    if (!this.available()) {
      return {
        ok: false,
        reason: `BambuStudio executable not found: ${this.executablePath}. Set BAMBU_STUDIO_PATH.`,
        stderrTail: [],
      };
    }
    if (this.outputDir === undefined) {
      return {
        ok: false,
        reason: 'BAMBU_OUTPUT_DIR is not set; the slice tool will not write to a directory it has not been given.',
        stderrTail: [],
      };
    }
    if (!existsSync(request.modelPath)) {
      return { ok: false, reason: `Model file not found: ${request.modelPath}`, stderrTail: [] };
    }

    const workDir = mkdtempSync(join(tmpdir(), 'bambu-mcp-slice-'));
    const warnings: string[] = [];

    try {
      const routed = this.#routeOverrides(request);
      warnings.push(...routed.warnings);

      const projectColours = readProjectFilamentColours(request.modelPath);
      const colourArgs = filamentColourArgs({
        filamentPresets: request.filamentPresets,
        projectColours,
        overrides: request.overrides,
      });
      if (colourArgs.length > 0) {
        warnings.push(
          `Passed the project's ${projectColours?.length ?? 0} filament slot colours to the CLI: when the loaded filament presets share a name, ` +
            'the CLI treats them as the same spool and turns off the prime tower, whereas the GUI tells them apart by colour.',
        );
      }

      const machinePath = this.#writeFlattened(workDir, 'machine', request.machinePreset, routed.buckets.machine);
      const processPath = this.#writeFlattened(workDir, 'process', request.processPreset, routed.buckets.process);
      const filamentPaths = request.filamentPresets.map((name, index) =>
        this.#writeFlattened(workDir, 'filament', name, routed.buckets.filament, index),
      );

      const outputName = `${basename(request.modelPath).replace(/\.[^.]+$/, '')}.gcode.3mf`;
      const expectedOutput = join(this.outputDir, outputName);

      // Delete any previous output with the same name first.
      //
      // Otherwise there is a nasty failure mode: this slice fails, but the file from the
      // previous run is still there, `existsSync` is true, and we report the previous
      // run's stats as this run's result. The tool would lie, and convincingly (every
      // number looks plausible, it just belongs to a different run).
      if (existsSync(expectedOutput)) {
        rmSync(expectedOutput, { force: true });
      }
      const argv = [
        '--load-settings',
        `${machinePath};${processPath}`,
        '--load-filaments',
        filamentPaths.join(';'),
        ...placementArgs(request),
        ...colourArgs,
        ...routed.commandLine,
        '--outputdir',
        this.outputDir,
        '--slice',
        String(request.plate ?? 0),
        '--export-3mf',
        outputName,
        request.modelPath,
      ];

      const run = await this.#run(argv, this.#timeoutMs);
      const outputPath = expectedOutput;

      if (!existsSync(outputPath)) {
        return {
          ok: false,
          reason:
            run.timedOut === true
              ? `Slicing timed out (${this.#timeoutMs / 1000}s)`
              : 'Slicing produced no output file; see stderr.',
          stderrTail: tail(run.stderr, 20),
        };
      }

      const readBack = readSliceOutput(outputPath);
      if (readBack === undefined) {
        return {
          ok: false,
          reason: `Could not parse output ${outputName}; it may not be a complete 3MF.`,
          stderrTail: tail(run.stderr, 20),
        };
      }

      const overrideAudit = auditOverrides(request.overrides, readBack.settings);
      for (const entry of overrideAudit) {
        if (!entry.honoured) {
          warnings.push(
            `Override not honoured: ${entry.key} requested ${JSON.stringify(entry.requested)}, ` +
              `output actually has ${JSON.stringify(entry.applied)}. ` +
              unhonouredReason(entry.key),
          );
        }
      }

      if (readBack.stats === undefined) {
        return {
          ok: false,
          reason: 'No G-code stats header found in the output; slicing may have failed partway.',
          stderrTail: tail(run.stderr, 20),
        };
      }

      return {
        ok: true,
        outputPath,
        stats: readBack.stats,
        appliedSettings: readBack.settings,
        overrideAudit,
        warnings,
      };
    } finally {
      // ART-001: intermediate artefacts are not left on disk.
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Flatten all three presets and let a pure function decide where each override lands. */
  #routeOverrides(request: SliceRequest): OverrideRouting {
    return routeOverrides(request.overrides, {
      machine: this.#presets.resolve(request.machinePreset, 'machine').settings,
      process: this.#presets.resolve(request.processPreset, 'process').settings,
      filament:
        request.filamentPresets[0] === undefined
          ? {}
          : this.#presets.resolve(request.filamentPresets[0], 'filament').settings,
    });
  }

  #writeFlattened(
    workDir: string,
    kind: PresetKind,
    presetName: string,
    overrides: ParameterOverrides,
    index = 0,
  ): string {
    const resolved = this.#presets.resolve(presetName, kind);
    const body = toFlattenedPresetFile(resolved, overrides);
    const path = join(workDir, `${kind}-${index}.json`);
    writeFileSync(path, JSON.stringify(body, null, 1), 'utf8');
    return path;
  }

  #run(argv: readonly string[], timeoutMs: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const child = spawn(this.executablePath, [...argv], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Even without a GUI session, BambuStudio still needs HOME to locate its data directory.
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const finish = (code: number | null): void => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, ...(timedOut ? { timedOut } : {}) });
      };

      child.on('error', (error) => {
        stderr += `\nspawn error: ${error.message}`;
        finish(null);
      });
      child.on('close', finish);
    });
  }
}

type RunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut?: boolean;
};

function placementArgs(request: SliceRequest): readonly string[] {
  const placement = request.placement;
  if (placement === undefined) return [];
  const args: string[] = [];
  if (placement.arrange !== undefined) args.push('--arrange', placement.arrange ? '1' : '0');
  if (placement.orient !== undefined) args.push('--orient', placement.orient ? '1' : '0');
  if (placement.ensureOnBed === true) args.push('--ensure-on-bed');
  if (placement.scale !== undefined) args.push('--scale', String(placement.scale));
  if (placement.rotate !== undefined) args.push('--rotate', String(placement.rotate));
  if (placement.rotateX !== undefined) args.push('--rotate-x', String(placement.rotateX));
  if (placement.rotateY !== undefined) args.push('--rotate-y', String(placement.rotateY));
  return args;
}

/**
 * Project filament colours of the input 3MF (`filament_colour` in `Metadata/project_settings.config`).
 * Returns undefined when the file is not a ZIP, not a Bambu project, or cannot be read: better
 * not to intervene than to guess.
 */
export function readProjectFilamentColours(path: string): readonly string[] | undefined {
  try {
    const buffer = readFileSync(path);
    if (!looksLikeZip(buffer)) return undefined;
    const entry = readZipEntry(buffer, 'Metadata/project_settings.config');
    if (entry === undefined) return undefined;
    const parsed: unknown = JSON.parse(entry.toString('utf8'));
    const colours = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['filament_colour']
      : undefined;
    return Array.isArray(colours) && colours.every((colour) => typeof colour === 'string')
      ? (colours as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

function unhonouredReason(key: string): string {
  if (key === 'enable_prime_tower') {
    return (
      'When the loaded filament presets share a name and there are no distinct colours to tell them apart, ' +
      'the CLI treats them as the same spool and forces the prime tower off. ' +
      'For multi-colour projects, make sure the 3MF stores a colour for each slot, or pass different filament presets.'
    );
  }
  return 'This key may not belong to any loaded preset, or the CLI ignored it.';
}

/** Read back the settings that actually took effect and the G-code stats from the output 3MF. */
export function readSliceOutput(
  path: string,
): { settings: PresetRecord; stats: ReturnType<typeof parseGcodeStats> } | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return undefined;
  }

  let entries;
  try {
    entries = readZipDirectory(buffer);
  } catch {
    return undefined;
  }

  const settingsEntry = entries.find((entry) => entry.name === 'Metadata/project_settings.config');
  if (settingsEntry === undefined) return undefined;

  let settings: PresetRecord;
  try {
    const parsed: unknown = JSON.parse(extractEntry(buffer, settingsEntry).toString('utf8'));
    settings = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as PresetRecord;
  } catch {
    return undefined;
  }

  // When the plate number is unknown, take the first plate's G-code.
  const gcodeEntry = entries
    .filter((entry) => /^Metadata\/plate_\d+\.gcode$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  const stats =
    gcodeEntry === undefined
      ? undefined
      : parseGcodeStats(extractEntry(buffer, gcodeEntry).toString('utf8'));

  return { settings, stats };
}

/** Compare what was requested with what the output actually has; every miss must be surfaced. */
export function auditOverrides(
  requested: ParameterOverrides,
  applied: PresetRecord,
): readonly OverrideAuditEntry[] {
  return Object.entries(requested).map(([key, value]) => {
    const actual = applied[key];
    return {
      key,
      requested: value,
      applied: actual,
      honoured: valuesEqual(normaliseForCompare(value), normaliseForCompare(actual)),
    };
  });
}

/**
 * Normalise before comparing.
 *
 * Percentages in the output are written as `"15%"`, but the user may give just `"15"`;
 * numbers may be `"0.28"` versus `"0.280000"`. Neither counts as a failed override.
 */
function normaliseForCompare(value: PresetValue | undefined): PresetValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((item) => normaliseScalar(item));
  return normaliseScalar(value as string);
}

function normaliseScalar(value: string): string {
  const trimmed = value.trim().replace(/%$/, '');
  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric) && /^-?\d*\.?\d+$/.test(trimmed)) {
    return String(numeric);
  }
  return trimmed;
}

function tail(text: string, lines: number): readonly string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-lines);
}
