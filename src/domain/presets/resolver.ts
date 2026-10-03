import type {
  PresetIndexEntry,
  PresetKind,
  PresetOrigin,
  PresetRecord,
  PresetValue,
  ResolvedPreset,
} from '../contracts.js';

/**
 * preset 繼承展平。
 *
 * 這是整包 server 存在的理由。BambuStudio CLI 以 `--load-settings` 載入 preset JSON 時
 * **不會解析 `inherits`**：只有葉節點自己宣告的 key 會生效，其餘全部掉回執行檔內建的
 * StaticPrintConfig 預設值，而不是 Bambu Lab 原廠 preset 的值。
 *
 * 實測（X1C ／ 0.20mm Standard ／ PLA Basic ／ 20 mm 方塊）：
 *
 * | key                       | CLI 直接載入葉節點 | 展平後      |
 * |---------------------------|--------------------|-------------|
 * | sparse_infill_density     | 20%（內建預設）    | 15%（原廠） |
 * | top_shell_layers          | 4                  | 5           |
 * | elefant_foot_compensation | 0                  | 0.15        |
 * | enable_arc_fitting        | 0                  | 1           |
 * | brim_width                | 0                  | 5           |
 * | 列印時間                  | 10m 11s            | 8m 45s      |
 *
 * 這正是 bambulab/BambuStudio#1704（CLI 與 GUI 切片結果不一致，至今未修）的成因。
 * 因此本 server 一律先展平再交給 CLI，絕不把原始 preset 路徑直接餵進去。
 */

/** 純 metadata 欄位：描述 preset 自身，不是可切片的設定值。 */
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

/** 讀取 preset 原始 JSON 的能力；由 preset store 注入，讓 domain 保持純函式。 */
export type RawPresetReader = (name: string, kind: PresetKind) => RawPreset | undefined;

/**
 * 讀取以某個 preset 命名的 G-code 模板。
 *
 * BambuStudio 02.07 起，機型專屬的 G-code（`machine_start_gcode`、`change_filament_gcode`、
 * `layer_change_gcode`、`machine_end_gcode`、`time_lapse_gcode`、`wrapping_detection_gcode`）
 * 不再寫在 preset JSON 裡，而是在 `BBL.json` 另外登記成 `<preset 名稱> template <key>` 條目，
 * 內容只有 `name`、`instantiation: "false"` 與那一個 key。葉節點本身不宣告這些 key，
 * 只走 `inherits` 會一路退回 `fdm_machine_common` 的通用開機段（G28／G29／`M109 S205`、
 * 在 X10 畫兩條擠出線）—— 那不是任何一台 Bambu 機器的真開機程序。
 *
 * 回傳的每一筆 body 只含模板那一個 key。
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
 * 沿 `inherits` 往上走到根，然後由根往葉逐層覆蓋。
 *
 * 同時記錄每個 key 的來源層，讓 `bambu_resolve_preset` 能回答
 * 「這個值是原廠哪一層給的」——而不是要使用者自己翻四層 JSON。
 *
 * 有 `readTemplates` 時，每一層先套自己的本體，原廠層再套以該層命名的 G-code 模板（見
 * {@link TemplateReader}）。這個順序以 GUI 的實際值為準：P2S 0.4 的六個模板與 GUI 專案設定
 * 逐字相同。子層的模板因此蓋過父層的模板（X1 Carbon 0.6 有自己的模板、同時繼承 0.4），
 * 沒有模板的子層則沿用父層的（P2S 0.2／0.6／0.8 都繼承 P2S 0.4 的模板）。
 * 模板值的來源層記成模板條目名稱。
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
      throw new PresetResolutionError(`preset 繼承出現循環：${[...chain, cursor].join(' -> ')}`, chain);
    }
    seen.add(cursor);

    const raw = read(cursor, kind);
    if (raw === undefined) {
      throw new PresetResolutionError(
        chain.length === 0
          ? `找不到 ${kind} preset：${cursor}`
          : `preset ${chain[chain.length - 1] ?? name} 繼承了不存在的 ${kind} preset：${cursor}`,
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

  // layers[0] 是葉節點，所以由後往前覆蓋：根先寫入，葉最後覆蓋。
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer === undefined) continue;
    apply(layer);
    // 模板是原廠條目，只跟原廠層走：使用者若建了同名 preset 並自訂 G-code，
    // 不能反過來被原廠模板蓋掉。
    if (layer.origin !== 'system') continue;
    for (const template of readTemplates?.(layer.name, kind) ?? []) apply(template);
  }

  const root = layers[0];
  /* c8 ignore next -- 迴圈至少推入一層，layers[0] 不可能是 undefined */
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
 * Bambu preset 的值只有兩種合法形狀：字串，或字串陣列（每個 extruder 一項）。
 * 其他型別代表 preset 檔損毀或格式改版，直接忽略而不是硬轉，以免把壞值餵進切片。
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
 * 產生要餵給 CLI 的展平 JSON。
 *
 * 刻意保留 `type`／`name`／`from`／`instantiation`：CLI 靠 `type` 判斷這是 machine
 * 還是 process 設定檔。`inherits` 一定要移除，否則 CLI 又會走回那條壞掉的路徑。
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
 * 兩份展平 preset 的差異。用於 `bambu_compare_presets`，以及在切片後
 * 稽核「我要求的覆寫有沒有真的生效」。
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
  // 單噴頭機種的同一個 key，可能一邊寫成 "200"、另一邊寫成 ["200"]。
  const left = Array.isArray(a) ? a : [a as string];
  const right = Array.isArray(b) ? b : [b as string];
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/** 從索引項目挑出可直接選用的 preset，過濾掉純繼承用的中間層。 */
export function instantiableOnly(entries: readonly PresetIndexEntry[]): readonly PresetIndexEntry[] {
  return entries.filter((entry) => entry.instantiable);
}
