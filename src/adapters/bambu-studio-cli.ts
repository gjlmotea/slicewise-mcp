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
 * BambuStudio 命令列 adapter。
 *
 * 這裡最重要的一件事是：**永遠不把原始 preset 路徑交給 CLI**。
 *
 * BambuStudio CLI 載入 `--load-settings` 指定的 JSON 時不解析 `inherits`，
 * 只有葉節點自己宣告的 key 生效，其餘掉回執行檔內建預設值。實測 20 mm 方塊，
 * X1C ／ 0.20mm Standard ／ PLA Basic：直接載入葉節點得到 10m 11s、填充 20%，
 * 展平後得到 8m 45s、填充 15%（原廠 preset 的真值）。這就是 BambuStudio#1704。
 *
 * 因此每次切片都先展平三種 preset、寫成暫存 JSON 再交給 CLI，切完再從產物讀回
 * 實際生效的設定做稽核。
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
  /** 產物輸出目錄。未設定時切片工具會拒絕執行，不會亂寫使用者的檔案系統。 */
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
    // 版本印在 help 的第一行：`BambuStudio-02.07.01.62:`
    const match = /BambuStudio-([\d.]+)/.exec(`${result.stdout}\n${result.stderr}`);
    return match?.[1];
  }

  async slice(request: SliceRequest): Promise<SliceResult> {
    if (!this.available()) {
      return {
        ok: false,
        reason: `找不到 BambuStudio 執行檔：${this.executablePath}。請設定 BAMBU_STUDIO_PATH。`,
        stderrTail: [],
      };
    }
    if (this.outputDir === undefined) {
      return {
        ok: false,
        reason: '未設定 BAMBU_OUTPUT_DIR；切片工具不會寫入未經授權的目錄。',
        stderrTail: [],
      };
    }
    if (!existsSync(request.modelPath)) {
      return { ok: false, reason: `找不到模型檔：${request.modelPath}`, stderrTail: [] };
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
          `已把專案的 ${projectColours?.length ?? 0} 格耗材顏色交給 CLI：載入的耗材設定同名時，` +
            'CLI 會把它們當成同一卷料而關掉擦料塔，GUI 則看顏色分辨。',
        );
      }

      const machinePath = this.#writeFlattened(workDir, 'machine', request.machinePreset, routed.buckets.machine);
      const processPath = this.#writeFlattened(workDir, 'process', request.processPreset, routed.buckets.process);
      const filamentPaths = request.filamentPresets.map((name, index) =>
        this.#writeFlattened(workDir, 'filament', name, routed.buckets.filament, index),
      );

      const outputName = `${basename(request.modelPath).replace(/\.[^.]+$/, '')}.gcode.3mf`;
      const expectedOutput = join(this.outputDir, outputName);

      // 先刪掉同名舊產物。
      //
      // 不刪的話會有一個很惡劣的失敗模式：這次切片失敗了，但上一次的檔案還在，
      // `existsSync` 為真，於是我們把上一次的統計當成這次的結果回報 —— 工具會說謊，
      // 而且謊得很有說服力（數字全都合理，只是屬於別次執行）。
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
              ? `切片逾時（${this.#timeoutMs / 1000}s）`
              : '切片沒有產生輸出檔；詳見 stderr。',
          stderrTail: tail(run.stderr, 20),
        };
      }

      const readBack = readSliceOutput(outputPath);
      if (readBack === undefined) {
        return {
          ok: false,
          reason: `產物 ${outputName} 無法解析；可能不是完整的 3MF。`,
          stderrTail: tail(run.stderr, 20),
        };
      }

      const overrideAudit = auditOverrides(request.overrides, readBack.settings);
      for (const entry of overrideAudit) {
        if (!entry.honoured) {
          warnings.push(
            `覆寫未生效：${entry.key} 要求 ${JSON.stringify(entry.requested)}，` +
              `產物實際為 ${JSON.stringify(entry.applied)}。` +
              unhonouredReason(entry.key),
          );
        }
      }

      if (readBack.stats === undefined) {
        return {
          ok: false,
          reason: '產物中找不到 G-code 統計標頭；切片可能中途失敗。',
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
      // ART-001：過程資產不留在磁碟上。
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** 展平三種 preset，交給純函式決定覆寫的落點。 */
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
        // BambuStudio 在無 GUI session 下仍需要 HOME 才能定位資料目錄。
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
 * 輸入 3MF 的專案耗材顏色（`Metadata/project_settings.config` 的 `filament_colour`）。
 * 不是 ZIP、不是 Bambu 專案、或讀不到時回傳 undefined —— 寧可不介入也不要猜。
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
      'CLI 在載入的耗材設定同名、又沒有不同顏色可分辨時，會把它們當成同一卷料而強制關掉擦料塔。' +
      '多色專案請確認 3MF 內存有各格顏色，或改給不同的耗材 preset。'
    );
  }
  return '這個 key 可能不屬於任何已載入的 preset，或被 CLI 忽略。';
}

/** 從產物 3MF 讀回實際生效的設定與 G-code 統計。 */
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

  // 盤號未知時取第一個 plate 的 G-code。
  const gcodeEntry = entries
    .filter((entry) => /^Metadata\/plate_\d+\.gcode$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  const stats =
    gcodeEntry === undefined
      ? undefined
      : parseGcodeStats(extractEntry(buffer, gcodeEntry).toString('utf8'));

  return { settings, stats };
}

/** 比對「我要求的」與「產物實際的」，任何落空都要浮出來。 */
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
 * 比對前正規化。
 *
 * 產物裡的百分比寫成 `"15%"`，但使用者可能只給 `"15"`；
 * 數值可能是 `"0.28"` 對 `"0.280000"`。這些不算覆寫失敗。
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
