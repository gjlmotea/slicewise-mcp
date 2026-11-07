import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BambuService, ComposePartSpec } from '../application/bambu-service.js';
import type { PresetKind } from '../domain/contracts.js';
import { formatDuration } from '../domain/slicing/gcode-stats.js';
import {
  checkPrintabilityInputSchema,
  checkPrintabilityOutputSchema,
  comparePresetsInputSchema,
  comparePresetsOutputSchema,
  composeModelInputSchema,
  composeModelOutputSchema,
  inspectProjectInputSchema,
  inspectProjectOutputSchema,
  describeParametersInputSchema,
  describeParametersOutputSchema,
  diagnoseInputSchema,
  diagnoseOutputSchema,
  getStatusInputSchema,
  inspectModelInputSchema,
  inspectModelOutputSchema,
  listPresetsInputSchema,
  listPresetsOutputSchema,
  measureClearanceInputSchema,
  measureClearanceOutputSchema,
  optimizePrintInPlaceInputSchema,
  optimizePrintInPlaceOutputSchema,
  planSettingsInputSchema,
  planSettingsOutputSchema,
  resolvePresetInputSchema,
  resolvePresetOutputSchema,
  saveUserPresetInputSchema,
  saveUserPresetOutputSchema,
  searchModelsInputSchema,
  searchModelsOutputSchema,
  sliceInputSchema,
  sliceOutputSchema,
  statusOutputSchema,
} from './schemas.js';

type ToolDependencies = { readonly service: BambuService };

function ok(payload: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload,
    isError: false,
  };
}

function fail(payload: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload,
    isError: true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Drop fields whose value is undefined.
 *
 * zod's `.optional()` produces `T | undefined`, but this project enables `exactOptionalPropertyTypes`,
 * where "absent" and "present but undefined" are different things. Passing the value straight through is
 * rejected by the type checker, and actually passing undefined would override the downstream defaults.
 */
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as { [K in keyof T]?: NonNullable<T[K]> };
}

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, { service }: ToolDependencies): void {
  // ── Status ──────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_get_status',
    {
      title: 'Get Bambu Studio companion status',
      description:
        'Reports the BambuStudio data directory, whether the slicer executable is available, preset counts, ' +
        'the machine and filaments currently selected in Studio, the allowed model directories, and the ' +
        'integration level of each model platform. Use it first to see what this server can do on this machine. ' +
        'No side effects.',
      inputSchema: getStatusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      const status = service.status();
      const parts = [
        `BambuStudio data directory ${status.dataDir}`,
        status.slicerAvailable ? 'slicer available' : `slicer not available (${status.slicerPath})`,
        `presets: machine ${status.presetCounts.machine} / process ${status.presetCounts.process} / filament ${status.presetCounts.filament}`,
        'every slice flattens the preset inheritance chain first',
      ];
      return ok({ ...status }, parts.join('; ') + '.');
    },
  );

  // ── Presets ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_list_presets',
    {
      title: 'List presets',
      description:
        'Lists machine, process or filament presets. By default only presets selectable in the UI are returned; ' +
        'intermediate presets that exist only to be inherited from (e.g. fdm_process_common) are filtered out. ' +
        'Names listed here do not show real setting values; use bambu_resolve_preset for that. No side effects.',
      inputSchema: listPresetsInputSchema,
      outputSchema: listPresetsOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      const kind = args.kind as PresetKind;
      try {
        const { total, entries } = service.listPresets(kind, {
          ...(args.search === undefined ? {} : { search: args.search }),
          instantiableOnly: args.includeAbstract !== true,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        return ok(
          {
            kind,
            total,
            returned: entries.length,
            entries: entries.map((entry) => ({
              name: entry.name,
              origin: entry.origin,
              instantiable: entry.instantiable,
              ...(entry.inherits === undefined ? {} : { inherits: entry.inherits }),
              relativePath: entry.relativePath,
            })),
          },
          `${kind} presets: ${total} in total, ${entries.length} returned.`,
        );
      } catch (error) {
        return fail({ kind, total: 0, returned: 0, entries: [] }, message(error));
      }
    },
  );

  server.registerTool(
    'bambu_resolve_preset',
    {
      title: 'Flatten a preset inheritance chain',
      description:
        'Flattens a preset\'s inherits chain into the complete settings and records which level each value comes from. ' +
        'A BambuStudio leaf preset usually declares only a few dozen keys and inherits everything else from its parents, ' +
        'so to know the real value of any parameter you must look at the flattened result, not the leaf preset file. ' +
        'Use this whenever you need an actual setting value. No side effects.',
      inputSchema: resolvePresetInputSchema,
      outputSchema: resolvePresetOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      const kind = args.kind as PresetKind;
      try {
        const resolved = service.resolvePreset(args.name, kind, args.keys);
        return ok(
          {
            name: resolved.name,
            kind: resolved.kind,
            origin: resolved.origin,
            inheritanceChain: resolved.inheritanceChain,
            settingCount: Object.keys(resolved.settings).length,
            settings: resolved.settings,
            provenance: resolved.provenance,
          },
          `${args.name} has ${Object.keys(resolved.settings).length} settings after flattening; ` +
            `inheritance chain: ${resolved.inheritanceChain.join(' <- ')}.`,
        );
      } catch (error) {
        return fail(
          {
            name: args.name,
            kind,
            origin: 'system',
            inheritanceChain: [],
            settingCount: 0,
            settings: {},
            provenance: {},
          },
          message(error),
        );
      }
    },
  );

  server.registerTool(
    'bambu_compare_presets',
    {
      title: 'Compare two presets',
      description:
        'Flattens two presets of the same kind and lists the settings that differ. Use it to answer questions like ' +
        '"what exactly is the difference between 0.20 Standard and 0.20 Strength" without reading four levels of JSON by hand. ' +
        'No side effects.',
      inputSchema: comparePresetsInputSchema,
      outputSchema: comparePresetsOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      const kind = args.kind as PresetKind;
      try {
        const result = service.comparePresets(args.left, args.right, kind);
        const limit = args.limit ?? 100;
        return ok(
          {
            left: result.left,
            right: result.right,
            differenceCount: result.differences.length,
            differences: result.differences.slice(0, limit).map((entry) => ({
              key: entry.key,
              ...(entry.left === undefined ? {} : { left: entry.left }),
              ...(entry.right === undefined ? {} : { right: entry.right }),
            })),
          },
          `${args.left} and ${args.right} differ in ${result.differences.length} settings.`,
        );
      } catch (error) {
        return fail(
          { left: args.left, right: args.right, differenceCount: 0, differences: [] },
          message(error),
        );
      }
    },
  );

  // ── Parameter knowledge ─────────────────────────────────────────────────
  server.registerTool(
    'bambu_describe_parameters',
    {
      title: 'Explain parameters and their trade-offs',
      description:
        'Explains what a parameter does, its unit, its typical range, the cost of raising or lowering it, and related parameters. ' +
        'Call this before changing any parameter, instead of tuning by what merely sounds reasonable. No side effects.',
      inputSchema: describeParametersInputSchema,
      outputSchema: describeParametersOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      const { specs, unknown } = service.describeParameters({
        ...(args.keys === undefined ? {} : { keys: args.keys }),
        ...(args.group === undefined ? {} : { group: args.group }),
      });
      return ok(
        {
          specs: specs.map((spec) => ({
            key: spec.key,
            owner: spec.owner,
            group: spec.group,
            label: spec.label,
            valueType: spec.valueType,
            ...(spec.unit === undefined ? {} : { unit: spec.unit }),
            ...(spec.typicalRange === undefined ? {} : { typicalRange: spec.typicalRange }),
            ...(spec.enumValues === undefined ? {} : { enumValues: spec.enumValues }),
            whatItDoes: spec.whatItDoes,
            raising: spec.raising,
            lowering: spec.lowering,
            related: spec.related,
          })),
          unknown,
        },
        unknown.length === 0
          ? `Parameter descriptions returned: ${specs.length}.`
          : `Parameter descriptions returned: ${specs.length}; not in the catalog: ${unknown.join(', ')}.`,
      );
    },
  );

  server.registerTool(
    'bambu_diagnose',
    {
      title: 'Diagnose a print failure from its symptom',
      description:
        'Takes an observed symptom (warping, stringing, layer separation, elephant\'s foot, holes in the top surface, ...) ' +
        'and returns an ordered list of remedies, each with its mechanism, a suggested value and its cost. ' +
        'Use it when the user describes what went wrong rather than which parameter to change; apply one remedy at a time. ' +
        'If no known symptom matches, it says so instead of guessing. It also points out problems that no parameter can fix. ' +
        'No side effects.',
      inputSchema: diagnoseInputSchema,
      outputSchema: diagnoseOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = service.diagnose({
        ...(args.symptom === undefined ? {} : { symptom: args.symptom }),
        ...(args.symptomId === undefined ? {} : { symptomId: args.symptomId }),
        ...(args.material === undefined ? {} : { material: args.material }),
      });
      return ok(
        {
          matched: result.matched.map((entry) => ({
            id: entry.id,
            label: entry.label,
            mechanism: entry.mechanism,
            remedies: entry.remedies.map((remedy) => ({
              key: remedy.key,
              direction: remedy.direction,
              ...(remedy.suggested === undefined ? {} : { suggested: remedy.suggested }),
              rationale: remedy.rationale,
              cost: remedy.cost,
              ...(remedy.parameterLabel === undefined ? {} : { parameterLabel: remedy.parameterLabel }),
              ...(remedy.parameterUnit === undefined ? {} : { parameterUnit: remedy.parameterUnit }),
              ...(remedy.typicalRange === undefined ? {} : { typicalRange: remedy.typicalRange }),
            })),
            ...(entry.materialNote === undefined ? {} : { materialNote: entry.materialNote }),
            ...(entry.notAParameterProblem === undefined
              ? {}
              : { notAParameterProblem: entry.notAParameterProblem }),
          })),
          available: result.available,
          ...(result.note === undefined ? {} : { note: result.note }),
        },
        result.matched.length === 0
          ? (result.note ?? 'No symptom matched.')
          : `Matched: ${result.matched.map((entry) => entry.label).join(', ')}.`,
      );
    },
  );

  server.registerTool(
    'bambu_plan_settings',
    {
      title: 'Plan settings for a goal',
      description:
        'Given what you want (safe and failure-free / fast / strong under load / good surface / economical), returns ordered ' +
        'parameter adjustments grouped by what they counter: adhesion and warping, nozzle collisions, surface quality, ' +
        'structural strength, time, filament. Each move includes its mechanism, a suggested value, its cost, and ' +
        '**the actual value in the current preset and its shape** ' +
        '(per-extruder parameters must be overridden with an array; a scalar is silently not applied). ' +
        'If modelPath is given, a printability analysis runs first and conditional adjustments are added based on the geometry. ' +
        'This is for planning before a print; to work back from a print that already failed, use bambu_diagnose. ' +
        'It only returns a plan and changes nothing. No side effects.',
      inputSchema: planSettingsInputSchema,
      outputSchema: planSettingsOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const plan = service.planSettings(compact(args));
        const byConcern = new Map<string, number>();
        for (const move of plan.moves) {
          byConcern.set(move.concernLabel, (byConcern.get(move.concernLabel) ?? 0) + 1);
        }
        const triggered = plan.moves.filter((move) => move.triggeredBy !== undefined);

        return ok(
          {
            ...(plan.goal === undefined
              ? {}
              : {
                  goal: {
                    id: plan.goal.id,
                    label: plan.goal.label,
                    optimisesFor: plan.goal.optimisesFor,
                    tradesAway: plan.goal.tradesAway,
                    ...(plan.goal.materialNote === undefined
                      ? {}
                      : { materialNote: plan.goal.materialNote }),
                    ...(plan.goal.notAParameterProblem === undefined
                      ? {}
                      : { notAParameterProblem: plan.goal.notAParameterProblem }),
                  },
                }),
            available: plan.available,
            moves: plan.moves.map((move) => ({
              key: move.key,
              concern: move.concern,
              concernLabel: move.concernLabel,
              direction: move.direction,
              ...(move.suggested === undefined ? {} : { suggested: move.suggested }),
              rationale: move.rationale,
              cost: move.cost,
              ...(move.parameterLabel === undefined ? {} : { parameterLabel: move.parameterLabel }),
              ...(move.unit === undefined ? {} : { unit: move.unit }),
              ...(move.currentValue === undefined ? {} : { currentValue: move.currentValue }),
              valueShape: move.valueShape,
              ...(move.ownedBy === undefined ? {} : { ownedBy: move.ownedBy }),
              ...(move.triggeredBy === undefined ? {} : { triggeredBy: move.triggeredBy }),
              ...(move.triggerReason === undefined ? {} : { triggerReason: move.triggerReason }),
            })),
            ...(plan.printability === undefined
              ? {}
              : {
                  printability: {
                    fitsBuildVolume: plan.printability.fitsBuildVolume,
                    overhangAreaRatio: plan.printability.overhangAreaRatio,
                    findings: plan.printability.findings.map((finding) => ({
                      code: finding.code,
                      severity: finding.severity,
                      summary: finding.summary,
                    })),
                  },
                }),
            ...(plan.note === undefined ? {} : { note: plan.note }),
          },
          plan.goal === undefined
            ? (plan.note ?? 'No goal matched.')
            : `Goal "${plan.goal.label}": ${plan.moves.length} adjustments (` +
              [...byConcern].map(([label, count]) => `${label} ${count}`).join(', ') +
              `)` +
              (triggered.length === 0 ? '.' : `, ${triggered.length} of them triggered by the model geometry.`),
        );
      } catch (error) {
        return fail({ available: [], moves: [] }, message(error));
      }
    },
  );

  server.registerTool(
    'bambu_optimize_print_in_place',
    {
      title: 'Create a stabilised print-in-place preset',
      description:
        'Creates an auto-stabilised copy of the given (or currently selected) process preset that can be used directly in Bambu Studio. ' +
        'Use it when small print-in-place parts detach from the bed or get dragged off by the nozzle. ' +
        'It applies exactly: first-layer outer wall 20 mm/s, first-layer infill 30 mm/s, outer wall capped at 60 mm/s, ' +
        'slowdown for overhangs, avoid crossing printed walls, Monotonic line, and ironing and Fuzzy Skin turned off. ' +
        'If the source is an existing user preset, its leaf-level calibrations (dimensions, elephant\'s foot, etc.) are kept, ' +
        'but the new file still inherits directly from the system preset. ' +
        'By default Auto Brim is explicitly turned off so the brim does not fuse gear clearances; Brim Ears can be requested explicitly, ' +
        'and you will still be reminded to check the first layer. ' +
        'It does not change filament temperature, cooling or flow, because regular PLA and Silk PLA must be calibrated separately. ' +
        'Writes a file to the user profile directory; takes effect after Bambu Studio is restarted.',
      inputSchema: optimizePrintInPlaceInputSchema,
      outputSchema: optimizePrintInPlaceOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const optimized = service.optimizePrintInPlacePreset(compact(args));
        return ok(
          {
            name: optimized.name,
            sourcePreset: optimized.sourcePreset,
            basePreset: optimized.basePreset,
            path: optimized.result.path,
            created: optimized.result.created,
            overwritten: optimized.result.overwritten,
            overrides: optimized.overrides,
            changes: optimized.changes.map((change) => ({
              key: change.key,
              ...(change.before === undefined ? {} : { before: change.before }),
              after: change.after,
              rationale: change.rationale,
            })),
            preservedKeys: optimized.preservedKeys,
            warnings: optimized.warnings,
            manualActions: optimized.manualActions,
            nextStep: 'Close Bambu Studio normally and reopen it, then select this preset in the Process dropdown.',
          },
          `${optimized.result.overwritten ? 'Updated' : 'Created'} "${optimized.name}"; ` +
            `settings adjusted automatically: ${optimized.changes.length}; existing overrides kept: ${optimized.preservedKeys.length}.`,
        );
      } catch (error) {
        return fail(
          {
            name: args.name ?? '',
            sourcePreset: args.processPreset ?? '',
            basePreset: '',
            path: '',
            created: false,
            overwritten: false,
            overrides: {},
            changes: [],
            preservedKeys: [],
            warnings: [],
            manualActions: [],
            nextStep: '',
          },
          message(error),
        );
      }
    },
  );

  // ── Writing to Studio ───────────────────────────────────────────────────
  server.registerTool(
    'bambu_save_user_preset',
    {
      title: 'Save a user preset to Bambu Studio',
      description:
        'Creates a custom preset that inherits from a system preset, in the BambuStudio user profile directory; ' +
        'it appears in the dropdown after Bambu Studio is restarted. ' +
        'BambuStudio has no plugin API (see bambulab/BambuStudio#9614), so this is the only way to get parameters ' +
        'tuned by an AI into the GUI. Writes a file; an existing preset with the same name is never silently overwritten.',
      inputSchema: saveUserPresetInputSchema,
      outputSchema: saveUserPresetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const { result, warnings } = service.saveUserPreset({
          name: args.name,
          kind: args.kind as PresetKind,
          inherits: args.inherits,
          overrides: args.overrides,
          ...(args.overwrite === undefined ? {} : { overwrite: args.overwrite }),
        });
        return ok(
          {
            path: result.path,
            created: result.created,
            overwritten: result.overwritten,
            warnings,
            nextStep: 'Restart Bambu Studio and this preset will appear in the matching dropdown.',
          },
          `${result.overwritten ? 'Replaced' : 'Created'} preset "${args.name}": ${result.path}.` +
            (warnings.length === 0 ? '' : ` Warnings: ${warnings.length}.`),
        );
      } catch (error) {
        return fail(
          { path: '', created: false, overwritten: false, warnings: [], nextStep: '' },
          message(error),
        );
      }
    },
  );

  // ── Slicing ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_slice',
    {
      title: 'Slice (after flattening the inheritance chain)',
      description:
        'Slices with the BambuStudio CLI and reports real statistics: layer count, print time, filament weight. ' +
        'Presets are flattened before they are passed to the CLI; feeding the raw presets to the CLI makes every inherited ' +
        'parameter fall back to the built-in default (BambuStudio#1704), so do not call the CLI directly. ' +
        'After slicing, it reads the settings that actually took effect back from the output and audits each override you requested; ' +
        'an overrideAudit entry with honoured = false was not applied. ' +
        'Starts a child process and writes a .gcode.3mf to the configured output directory. ' +
        'It does not send anything to a printer or start a print.',
      inputSchema: sliceInputSchema,
      outputSchema: sliceOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await service.slice({
          modelPath: args.modelPath,
          ...(args.machinePreset === undefined ? {} : { machinePreset: args.machinePreset }),
          ...(args.processPreset === undefined ? {} : { processPreset: args.processPreset }),
          ...(args.filamentPresets === undefined ? {} : { filamentPresets: args.filamentPresets }),
          ...(args.overrides === undefined ? {} : { overrides: args.overrides }),
          ...(args.placement === undefined ? {} : { placement: compact(args.placement) }),
          ...(args.plate === undefined ? {} : { plate: args.plate }),
        });

        if (!result.ok) {
          return fail({ ok: false, reason: result.reason, stderrTail: result.stderrTail }, result.reason);
        }

        const time = result.stats.totalEstimatedTimeSeconds ?? result.stats.modelPrintTimeSeconds;
        const missed = result.overrideAudit.filter((entry) => !entry.honoured);

        // Report only the requested parameters. The output has 568 keys; dumping all of them back is useless to the model.
        const reported: Record<string, unknown> = {};
        for (const key of args.reportSettings ?? []) {
          const value = result.appliedSettings[key];
          if (value !== undefined) reported[key] = value;
        }

        return ok(
          {
            ok: true,
            outputPath: result.outputPath,
            stats: result.stats,
            ...(args.reportSettings === undefined ? {} : { appliedSettings: reported }),
            overrideAudit: result.overrideAudit.map((entry) => ({
              key: entry.key,
              requested: entry.requested,
              ...(entry.applied === undefined ? {} : { applied: entry.applied }),
              honoured: entry.honoured,
            })),
            warnings: result.warnings,
          },
          `Sliced: ${result.stats.layerCount} layers` +
            (time === undefined ? '' : `, about ${formatDuration(time)}`) +
            (result.stats.filamentGrams === undefined
              ? ''
              : `, ${result.stats.filamentGrams} g` +
                (result.stats.filamentBreakdown === undefined
                  ? ''
                  : ` (total of ${result.stats.filamentBreakdown.length} colours)`)) +
            '.' +
            (missed.length === 0
              ? ''
              : ` Warning: ${missed.length} override(s) not honoured (${missed.map((entry) => entry.key).join(', ')}).`),
        );
      } catch (error) {
        return fail({ ok: false, reason: message(error), stderrTail: [] }, message(error));
      }
    },
  );

  // ── Models ──────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_inspect_model',
    {
      title: 'Inspect model geometry',
      description:
        'Parses an STL (binary or ASCII), 3MF or OBJ and reports triangle count, bounding box, volume, surface area, ' +
        'and whether the mesh is closed. The format is detected from the file content, not the extension. ' +
        'For 3MF and OBJ it also reports the part count and part list ' +
        '(3MF coordinates have the placement transform applied; OBJ is split into parts by o / g, and Tinkercad\'s colour export is OBJ). ' +
        'Reads only files inside the allowed directories. No side effects.',
      inputSchema: inspectModelInputSchema,
      outputSchema: inspectModelOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const inspection = service.inspect(args.modelPath);
        const size = inspection.boundingBox.size;
        return ok(
          { ...inspection },
          `${inspection.format.toUpperCase()}, ${inspection.triangleCount} triangles` +
            (inspection.partCount > 1 ? ` (${inspection.partCount} parts)` : '') +
            `, size ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} mm, ` +
            (inspection.closed ? 'mesh closed.' : `mesh not closed (${inspection.openEdges} open edges).`),
        );
      } catch (error) {
        return fail(
          {
            triangleCount: 0,
            boundingBox: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: 0, y: 0, z: 0 },
              size: { x: 0, y: 0, z: 0 },
            },
            volumeMm3: 0,
            surfaceAreaMm2: 0,
            closed: false,
            degenerateTriangles: 0,
            openEdges: 0,
          },
          message(error),
        );
      }
    },
  );

  server.registerTool(
    'bambu_check_printability',
    {
      title: 'Check printability',
      description:
        'Finds problems visible before slicing: exceeding the build volume, floating bodies that do not touch the plate, ' +
        'an unclosed mesh, the share of steep overhangs, too small a base area, too high an aspect ratio, features that are too thin, ' +
        'and warping risk on large bottom surfaces. Each finding lists the related parameters. ' +
        'Floating detection splits the mesh into shells, merges shells that touch or intersect into bodies, merges shells fully enclosed ' +
        'by another body into it, then checks whether each body reaches the plate and measures the gap to the nearest body: ' +
        'a narrow gap means the parts were not joined in the model (turning on support would make them print as separate pieces); ' +
        'only a wide gap really needs support. ' +
        'Accepts STL, 3MF and OBJ. ' +
        'This is geometric analysis, not a slicing simulation; thin walls inside the model only show up when actually sliced. No side effects.',
      inputSchema: checkPrintabilityInputSchema,
      outputSchema: checkPrintabilityOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const report = service.checkPrintability(args.modelPath, {
          ...(args.buildVolume === undefined ? {} : { buildVolume: args.buildVolume }),
          ...(args.overhangThresholdDegrees === undefined
            ? {}
            : { overhangThresholdDegrees: args.overhangThresholdDegrees }),
          ...(args.lineWidthMm === undefined ? {} : { lineWidthMm: args.lineWidthMm }),
        });
        const blockers = report.findings.filter((finding) => finding.severity === 'blocker');
        return ok(
          { ...report },
          blockers.length > 0
            ? `Blocking problems (${blockers.length}): ${blockers.map((finding) => finding.summary).join('; ')}.`
            : `Printable. Findings: ${report.findings.length}; overhangs are ${(report.overhangAreaRatio * 100).toFixed(1)}% of the surface area.`,
        );
      } catch (error) {
        return fail(
          {
            inspection: {
              triangleCount: 0,
              boundingBox: {
                min: { x: 0, y: 0, z: 0 },
                max: { x: 0, y: 0, z: 0 },
                size: { x: 0, y: 0, z: 0 },
              },
              volumeMm3: 0,
              surfaceAreaMm2: 0,
              closed: false,
              degenerateTriangles: 0,
              openEdges: 0,
            },
            buildVolume: { x: 0, y: 0, z: 0 },
            fitsBuildVolume: false,
            overhangAreaRatio: 0,
            floatingBodies: [],
            findings: [],
          },
          message(error),
        );
      }
    },
  );

  server.registerTool(
    'bambu_measure_clearance',
    {
      title: 'Measure clearance between parts',
      description:
        'Measures the smallest clearance between the parts in a 3MF or OBJ, to judge whether a print-in-place mechanism will fuse when printed. ' +
        'Parts that touch each other are first merged into rigid bodies before comparing, because Bambu also stores ' +
        'the colour-change segments of a single solid as separate parts; without merging, one piece would be reported as "clearance 0". ' +
        'When the clearance is too small it suggests compensation, distinguishing outer contours from holes ' +
        '(the enclosed side is a hole to the slicer and is controlled by a different parameter). ' +
        'STL has no part boundaries, so it cannot be measured. No side effects.',
      inputSchema: measureClearanceInputSchema,
      outputSchema: measureClearanceOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const report = service.measureClearance(args.modelPath, {
          ...(args.minimumClearanceMm === undefined
            ? {}
            : { minimumClearanceMm: args.minimumClearanceMm }),
          ...(args.reportThresholdMm === undefined ? {} : { reportThresholdMm: args.reportThresholdMm }),
          ...(args.samplingMm === undefined ? {} : { samplingMm: args.samplingMm }),
        });

        const fusing = report.pairs.filter((pair) => pair.verdict === 'will-fuse').length;
        const summary =
          report.tightestGapMm === undefined
            ? `${report.bodies.length} bodies; no part pairs within the reporting threshold.`
            : `${report.bodies.length} bodies, ${report.pairs.length} interfaces, ` +
              `tightest ${report.tightestGapMm.toFixed(3)} mm` +
              (fusing > 0
                ? `; ${fusing} of them are below ${report.minimumClearanceMm} mm and will fuse.`
                : '; all within the reliable range.');

        return ok({ ...report }, summary);
      } catch (error) {
        return fail(
          {
            format: 'unknown',
            partCount: 0,
            bodies: [],
            pairs: [],
            minimumClearanceMm: 0,
            findings: [],
          },
          message(error),
        );
      }
    },
  );

  // ── Composing 3MF ───────────────────────────────────────────────────────
  server.registerTool(
    'bambu_compose_model',
    {
      title: 'Compose a 3MF with negative / modifier parts',
      description:
        'Builds a Bambu project 3MF from a base body STL plus extra parts. A negative part (negative_part) cuts away where it overlaps, ' +
        'a modifier (modifier_part) applies different settings to its region, and support_blocker / support_enforcer control support. ' +
        'In a Bambu model each of these is just one more part with a label, so no geometry (boolean) engine is needed. ' +
        'The output can be read back item by item with bambu_inspect_project, or passed straight to bambu_slice. ' +
        'Writes a file to the output directory.',
      inputSchema: composeModelInputSchema,
      outputSchema: composeModelOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = service.composeModel({
          name: args.name,
          basePath: args.basePath,
          ...(args.baseName === undefined ? {} : { baseName: args.baseName }),
          parts: args.parts.map((part) => ({
            name: part.name,
            subtype: part.subtype,
            shape: compact(part.shape) as ComposePartSpec['shape'],
            ...(part.position === undefined ? {} : { position: part.position }),
            ...(part.settings === undefined ? {} : { settings: part.settings }),
          })),
          ...(args.plateCentre === undefined ? {} : { plateCentre: args.plateCentre }),
        });

        const ineffective = result.parts.filter((part) => !part.intersectsBody);
        return ok(
          {
            outputPath: result.outputPath,
            byteLength: result.byteLength,
            parts: result.parts.map((part) => ({ ...part })),
            warnings: result.warnings,
            nextStep:
              'Check the part structure with bambu_inspect_project, or slice directly with bambu_slice; ' +
              'comparing max_z_height and filament weight with and without the parts confirms that the negative parts really took effect.',
          },
          `Wrote ${result.outputPath} (${result.parts.length} parts).` +
            (ineffective.length === 0
              ? ''
              : ` Warning: no intersection with the base body, so no effect: ${ineffective.map((part) => part.name).join(', ')}.`),
        );
      } catch (error) {
        return fail(
          { outputPath: '', byteLength: 0, parts: [], warnings: [], nextStep: '' },
          message(error),
        );
      }
    },
  );

  server.registerTool(
    'bambu_inspect_project',
    {
      title: 'Read back the part structure of a 3MF',
      description:
        'Reads the objects and parts from a Bambu project 3MF, including each part\'s subtype and per-part settings. ' +
        'Use it to verify that what was written is really in the file; this is the key advantage of working with files ' +
        'over the GUI: you can compare item by item instead of only looking at the screen. ' +
        'It also flags subtypes that BambuStudio does not recognise. No side effects.',
      inputSchema: inspectProjectInputSchema,
      outputSchema: inspectProjectOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const objects = service.inspectProject(args.projectPath);
        const partCount = objects.reduce((sum, object) => sum + object.parts.length, 0);
        const unrecognised = objects
          .flatMap((object) => object.parts)
          .filter((part) => !part.recognised);
        return ok(
          {
            objects: objects.map((object) => ({
              id: object.id,
              ...(object.name === undefined ? {} : { name: object.name }),
              parts: object.parts.map((part) => ({
                id: part.id,
                subtype: part.subtype,
                recognised: part.recognised,
                ...(part.name === undefined ? {} : { name: part.name }),
                settings: part.settings,
              })),
            })),
          },
          `Objects: ${objects.length}, parts: ${partCount}.` +
            (unrecognised.length === 0
              ? ''
              : ` Warning: ${unrecognised.length} part(s) have a subtype BambuStudio does not recognise and will be treated as normal_part.`),
        );
      } catch (error) {
        return fail({ objects: [] }, message(error));
      }
    },
  );

  // ── Search ──────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_search_models',
    {
      title: 'Search for 3D models',
      description:
        'Searches for models across platforms. Thingiverse uses its official API (requires THINGIVERSE_TOKEN). ' +
        'MakerWorld and Printables have no official public API, so for them only a search link is returned for a person to open; ' +
        'this is a deliberate downgrade: no scraping or private endpoints pretending to be an API. ' +
        'Do not claim to have searched or downloaded models from those platforms. Does not download any model. Accesses the internet.',
      inputSchema: searchModelsInputSchema,
      outputSchema: searchModelsOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const results = await service.searchModels(args.query, args.sources, args.limit ?? 10);
      const hitCount = results.reduce((sum, result) => sum + result.hits.length, 0);
      const handoffs = results.filter((result) => result.integration === 'handoff-only');
      return ok(
        {
          query: args.query,
          results: results.map((result) => ({
            source: result.source,
            integration: result.integration,
            hits: result.hits.map((hit) => ({ ...hit })),
            ...(result.handoffUrl === undefined ? {} : { handoffUrl: result.handoffUrl }),
            notes: result.notes,
          })),
        },
        `Results found: ${hitCount}` +
          (handoffs.length === 0
            ? '.'
            : `; no official API for ${handoffs.map((result) => result.source).join(', ')}, so only search links are provided.`),
      );
    },
  );
}
