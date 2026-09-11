import type { PresetIndexEntry, PresetKind, PresetValue, ResolvedPreset } from '../domain/contracts.js';
import type { RawPreset } from '../domain/presets/resolver.js';

/**
 * preset 儲存庫：BambuStudio 的資料目錄。
 *
 * 讀取涵蓋原廠 vendor profile 與使用者自訂 profile；
 * 寫入只允許寫進使用者 profile 目錄，永遠不碰原廠目錄。
 */
export interface PresetStore {
  /** 資料根目錄，用於狀態回報與錯誤訊息。 */
  readonly dataDir: string;

  /** 目前綁定的使用者 profile 目錄名（BambuStudio 以帳號 id 命名）。 */
  readonly profileId: string | undefined;

  /** 列出索引；不讀取內容。 */
  list(kind: PresetKind): readonly PresetIndexEntry[];

  /** 讀單一 preset 的原始 JSON。 */
  readRaw(name: string, kind: PresetKind): RawPreset | undefined;

  /** 展平繼承鏈。 */
  resolve(name: string, kind: PresetKind): ResolvedPreset;

  /**
   * 寫入使用者 preset，讓它出現在 Bambu Studio 的下拉選單裡。
   *
   * 這是「讓 AI 調整的參數真的進到 GUI」的唯一合法途徑：
   * BambuStudio 沒有 plugin API（見 bambulab/BambuStudio#9614），
   * 但它啟動時會掃描使用者 profile 目錄。
   */
  writeUserPreset(request: WriteUserPresetRequest): WriteUserPresetResult;
}

export type WriteUserPresetRequest = {
  readonly name: string;
  readonly kind: PresetKind;
  /** 要繼承的原廠 preset；使用者 preset 一律掛在原廠 preset 底下。 */
  readonly inherits: string;
  /** 相對於父層的覆寫值。 */
  readonly overrides: Readonly<Record<string, PresetValue>>;
  /** 已存在同名 preset 時是否覆寫。預設 false。 */
  readonly overwrite?: boolean;
};

export type WriteUserPresetResult = {
  readonly path: string;
  readonly created: boolean;
  readonly overwritten: boolean;
};

export class PresetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetStoreError';
  }
}
