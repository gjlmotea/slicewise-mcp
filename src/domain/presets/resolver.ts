import type {
  PresetIndexEntry,
  PresetKind,
  PresetOrigin,
  PresetRecord,
  PresetValue,
  ResolvedPreset,
} from '../contracts.js';

/**
 * Flattening preset inheritance.
 *
 * This is the reason this whole server exists. When the BambuStudio CLI loads a preset JSON with
 * `--load-settings`, it **does not resolve `inherits`**: only the keys the leaf preset declares
 * itself take effect, and everything else falls back to the StaticPrintConfig defaults built into
 * the executable, not the values from Bambu Lab's system presets.
 *
 * Measured (X1C / 0.20mm Standard / PLA Basic / 20 mm cube):
 *
 * | key                       | CLI loads leaf directly | flattened        |
 * |---------------------------|-------------------------|------------------|
 * | sparse_infill_density     | 20% (built-in default)  | 15% (system)     |
 * | top_shell_layers          | 4                       | 5                |
 * | elefant_foot_compensation | 0                       | 0.15             |
 * | enable_arc_fitting        | 0                       | 1                |
 * | brim_width                | 0                       | 5                |
 * | print time                | 10m 11s                 | 8m 45s           |
 *
 * This is exactly the cause of bambulab/BambuStudio#1704 (CLI and GUI slicing results differ;
 * still unfixed). So this server always flattens first and then hands the result to the CLI; it
 * never feeds a raw preset path straight in.
 */

/** Pure metadata fields: they describe the preset itself and are not sliceable settings. */
const METADATA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'name',
  'from',
  'setting_id',
  'instantiation',
  'description',
  'version',
  'inherits',
  'filament_id',
  'is_custom_defined',
  'update_time',
]);

export function isMetadataKey(key: string): boolean {
  return METADATA_KEYS.has(key);
}

/** Ability to read a preset's raw JSON; injected by the preset store so the domain stays pure. */
export type RawPresetReader = (name: string, kind: PresetKind) => RawPreset | undefined;

/**
 * Reads the G-code templates named after a given preset.
 *
 * Since BambuStudio 02.07, machine-specific G-code (`machine_start_gcode`, `change_filament_gcode`,
 * `layer_change_gcode`, `machine_end_gcode`, `time_lapse_gcode`, `wrapping_detection_gcode`) is no
 * longer written in the preset JSON. Instead it is registered separately in `BBL.json` as
 * `<preset name> template <key>` entries, containing only `name`, `instantiation: "false"` and that
 * one key. The leaf preset does not declare these keys itself, so following `inherits` alone falls
 * all the way back to the generic start sequence in `fdm_machine_common` (G28 / G29 / `M109 S205`,
 * two purge lines drawn at X10) — which is not the real start procedure of any Bambu printer.
 *
 * Each returned body contains only that one template key.
 */
export type TemplateReader = (owner: string, kind: PresetKind) => readonly RawPreset[];

export type RawPreset = {
  readonly name: string;
  readonly kind: PresetKind;
  readonly origin: PresetOrigin;
  readonly body: Readonly<Record<string, unknown>>;
};

export class PresetResolutionError extends Error {
  constructor(
    message: string,
    readonly chain: readonly string[],
  ) {
    super(message);
    this.name = 'PresetResolutionError';
  }
}

/**
 * Walks up `inherits` to the root, then overrides layer by layer from the root down to the leaf.
 *
 * It also records which layer each key came from, so `bambu_resolve_preset` can answer
 * "which system layer supplied this value" — instead of making the user dig through four layers of JSON.
 *
 * When `readTemplates` is given, each layer first applies its own body, and system layers then apply
 * the G-code templates named after that layer (see {@link TemplateReader}). This order follows the
 * actual GUI values: the six P2S 0.4 templates match the GUI project settings verbatim. A child
 * layer's templates therefore override its parent's (X1 Carbon 0.6 has its own templates and also
 * inherits 0.4), while a child with no templates keeps its parent's (P2S 0.2 / 0.6 / 0.8 all inherit
 * the P2S 0.4 templates). The source layer of a template value is recorded as the template entry name.
 */
export function resolvePreset(
  name: string,
  kind: PresetKind,
  read: RawPresetReader,
  readTemplates?: TemplateReader,
): ResolvedPreset {
  const chain: string[] = [];
  const layers: RawPreset[] = [];
  const seen = new Set<string>();

  let cursor: string | undefined = name;
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw new PresetResolutionError(`Preset inheritance cycle: ${[...chain, cursor].join(' -> ')}`, chain);
    }
    seen.add(cursor);

    const raw = read(cursor, kind);
    if (raw === undefined) {
      throw new PresetResolutionError(
        chain.length === 0
          ? `${kind} preset not found: ${cursor}`
          : `Preset ${chain[chain.length - 1] ?? name} inherits a ${kind} preset that does not exist: ${cursor}`,
        chain,
      );
    }

    chain.push(cursor);
    layers.push(raw);
    cursor = readInherits(raw.body);
  }

  const settings: Record<string, PresetValue> = {};
  const provenance: Record<string, string> = {};
  const apply = (source: RawPreset): void => {
    for (const [key, value] of Object.entries(source.body)) {
      if (isMetadataKey(key)) continue;
      const normalised = normaliseValue(value);
      if (normalised === undefined) continue;
      settings[key] = normalised;
      provenance[key] = source.name;
    }
  };

  // layers[0] is the leaf, so override from back to front: the root is written first, the leaf last.
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer === undefined) continue;
    apply(layer);
    // Templates are system entries and only follow system layers: if the user created a preset with
    // the same name and custom G-code, the system template must not override it.
    if (layer.origin !== 'system') continue;
    for (const template of readTemplates?.(layer.name, kind) ?? []) apply(template);
  }

  const root = layers[0];
  /* c8 ignore next -- the loop pushes at least one layer, so layers[0] cannot be undefined */
  const origin: PresetOrigin = root?.origin ?? 'system';

  return {
    name,
    kind,
    origin,
    inheritanceChain: chain,
    settings,
    provenance,
  };
}

function readInherits(body: Readonly<Record<string, unknown>>): string | undefined {
  const value = body['inherits'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A Bambu preset value has only two valid shapes: a string, or an array of strings (one per extruder).
 * Any other type means the preset file is corrupt or the format changed; it is ignored rather than
 * forcibly converted, so a bad value never gets fed into slicing.
 */
export function normaliseValue(value: unknown): PresetValue | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') items.push(item);
      else if (typeof item === 'number' && Number.isFinite(item)) items.push(String(item));
      else return undefined;
    }
    return items;
  }
  return undefined;
}

/**
 * Builds the flattened JSON to feed to the CLI.
 *
 * `type` / `name` / `from` / `instantiation` are kept on purpose: the CLI relies on `type` to tell
 * whether this is a machine or a process settings file. `inherits` must be removed, or the CLI goes
 * back down that broken path.
 */
export function toFlattenedPresetFile(
  resolved: ResolvedPreset,
  overrides: Readonly<Record<string, PresetValue>> = {},
): Record<string, PresetValue> {
  const file: Record<string, PresetValue> = {
    type: presetTypeTag(resolved.kind),
    name: resolved.name,
    from: 'system',
    instantiation: 'true',
  };
  for (const [key, value] of Object.entries(resolved.settings)) {
    file[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    file[key] = value;
  }
  return file;
}

function presetTypeTag(kind: PresetKind): string {
  switch (kind) {
    case 'machine':
      return 'machine';
    case 'process':
      return 'process';
    case 'filament':
      return 'filament';
  }
}

/**
 * Difference between two flattened presets. Used by `bambu_compare_presets`, and after slicing to
 * audit "were the overrides I asked for actually honoured".
 */
export type PresetDiffEntry = {
  readonly key: string;
  readonly left: PresetValue | undefined;
  readonly right: PresetValue | undefined;
};

export function diffPresets(left: PresetRecord, right: PresetRecord): readonly PresetDiffEntry[] {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const entries: PresetDiffEntry[] = [];
  for (const key of [...keys].sort()) {
    const a = left[key];
    const b = right[key];
    if (!valuesEqual(a, b)) {
      entries.push({ key, left: a, right: b });
    }
  }
  return entries;
}

export function valuesEqual(a: PresetValue | undefined, b: PresetValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  // On single-nozzle printers the same key may be written as "200" on one side and ["200"] on the other.
  const left = Array.isArray(a) ? a : [a as string];
  const right = Array.isArray(b) ? b : [b as string];
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** Picks the presets that can be selected directly from index entries, filtering out intermediate layers that exist only for inheritance. */
export function instantiableOnly(entries: readonly PresetIndexEntry[]): readonly PresetIndexEntry[] {
  return entries.filter((entry) => entry.instantiable);
}
