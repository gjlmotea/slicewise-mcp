/**
 * Bambu Studio companion MCP 的領域契約。
 *
 * 這一層不認識檔案系統、子行程與網路；所有外部能力都由 ports 定義、adapters 實作。
 */

/** Bambu Studio 的三種 preset 類別。 */
export type PresetKind = 'machine' | 'process' | 'filament';

export const PRESET_KINDS: readonly PresetKind[] = ['machine', 'process', 'filament'];

/** preset 的來源：原廠 vendor 目錄或使用者目錄。 */
export type PresetOrigin = 'system' | 'user';

/**
 * preset 的原始值恆為字串或字串陣列（多噴頭機種用陣列），
 * 少數 metadata 欄位是純字串。這裡不做型別窄化，交由 catalog 解讀。
 */
export type PresetValue = string | readonly string[];

export type PresetRecord = Readonly<Record<string, PresetValue>>;

/** preset 索引項目：只有身分與位置，不含內容。 */
export type PresetIndexEntry = {
  readonly name: string;
  readonly kind: PresetKind;
  readonly origin: PresetOrigin;
  /** 相對於資料根的路徑，僅供人類定位與除錯。 */
  readonly relativePath: string;
  /** 是否可在 UI 直接選用；`false` 代表它只是繼承用的中間層。 */
  readonly instantiable: boolean;
  /** 直接父層 preset 名稱。 */
  readonly inherits?: string;
};

/** 展平後的 preset：繼承鏈已解析，不再帶 `inherits`。 */
export type ResolvedPreset = {
  readonly name: string;
  readonly kind: PresetKind;
  readonly origin: PresetOrigin;
  /** 由葉節點到根的繼承鏈，第一個元素就是 `name`。 */
  readonly inheritanceChain: readonly string[];
  /** 展平後的完整設定。 */
  readonly settings: PresetRecord;
  /** 每個 key 實際來自繼承鏈的哪一層，用來解釋「這個值哪來的」。 */
  readonly provenance: Readonly<Record<string, string>>;
};

/** 使用者要求覆寫的參數。 */
export type ParameterOverrides = Readonly<Record<string, PresetValue>>;

/** 一次切片請求。 */
export type SliceRequest = {
  /** 待切片的模型檔絕對路徑（.stl／.3mf／.obj／.step）。 */
  readonly modelPath: string;
  readonly machinePreset: string;
  readonly processPreset: string;
  readonly filamentPresets: readonly string[];
  readonly overrides: ParameterOverrides;
  /** 幾何擺放，直接對應 CLI flag。 */
  readonly placement?: SlicePlacement;
  /** 要切的盤號；0 代表全部。 */
  readonly plate?: number;
};

export type SlicePlacement = {
  readonly arrange?: boolean;
  readonly orient?: boolean;
  readonly ensureOnBed?: boolean;
  readonly scale?: number;
  readonly rotate?: number;
  readonly rotateX?: number;
  readonly rotateY?: number;
};

/** 從切片產物讀回來的客觀統計，全部來自 G-code 標頭，不是估算。 */
export type SliceStats = {
  readonly layerCount: number;
  readonly maxZHeight: number;
  readonly layerHeight: number;
  /** 秒。來自 `; model printing time`。 */
  readonly modelPrintTimeSeconds?: number;
  readonly totalEstimatedTimeSeconds?: number;
  /** 整盤合計，含換色沖洗與擦料塔。多色時是各色加總。 */
  readonly filamentGrams?: number;
  /** 整盤合計，多色時是各色加總。 */
  readonly filamentLengthMm?: number;
  readonly filamentCostCny?: number;
  /** 多色時每一色的用量；單色不回傳。 */
  readonly filamentBreakdown?: readonly FilamentUsage[];
};

export type FilamentUsage = {
  /** 耗材槽編號（1 起算），取自 G-code 標頭的 `; filament:`。 */
  readonly filament?: number;
  readonly grams?: number;
  readonly lengthMm?: number;
};

export type SliceOutcome = {
  readonly ok: true;
  readonly outputPath: string;
  readonly stats: SliceStats;
  /** 切片實際採用的完整設定，從產物 3MF 讀回，是唯一可信的事後真相。 */
  readonly appliedSettings: PresetRecord;
  /** 這次覆寫是否真的落到產物上；任何一項落空都會列在這裡。 */
  readonly overrideAudit: readonly OverrideAuditEntry[];
  readonly warnings: readonly string[];
};

export type OverrideAuditEntry = {
  readonly key: string;
  readonly requested: PresetValue;
  readonly applied: PresetValue | undefined;
  readonly honoured: boolean;
};

export type SliceFailure = {
  readonly ok: false;
  readonly reason: string;
  readonly stderrTail: readonly string[];
};

export type SliceResult = SliceOutcome | SliceFailure;

/** 模型幾何摘要。 */
export type ModelInspection = {
  readonly triangleCount: number;
  readonly boundingBox: BoundingBox;
  readonly volumeMm3: number;
  readonly surfaceAreaMm2: number;
  /** 每條邊都恰好被兩個三角形共用時為 true。 */
  readonly closed: boolean;
  readonly degenerateTriangles: number;
  readonly openEdges: number;
};

export type BoundingBox = {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly size: Vec3;
};

export type Vec3 = { readonly x: number; readonly y: number; readonly z: number };

/** 可列印性檢查的單一發現。 */
export type PrintabilityFinding = {
  readonly code: PrintabilityCode;
  readonly severity: 'blocker' | 'warning' | 'note';
  readonly summary: string;
  readonly detail: string;
  /** 建議調整的參數 key；空陣列代表這題不是靠參數解的。 */
  readonly relatedParameters: readonly string[];
};

export type PrintabilityCode =
  | 'exceeds-build-volume'
  | 'non-manifold'
  | 'degenerate-geometry'
  | 'steep-overhang'
  | 'thin-feature'
  | 'small-footprint'
  | 'tall-and-narrow'
  | 'large-flat-area'
  | 'floating-part';

export type PrintabilityReport = {
  readonly inspection: ModelInspection;
  readonly buildVolume: Vec3;
  readonly fitsBuildVolume: boolean;
  /** 需要支撐的三角形面積佔比（0–1）。 */
  readonly overhangAreaRatio: number;
  /** 沒有接到列印板的實體；空陣列代表每一塊都站得住。 */
  readonly floatingBodies: readonly {
    readonly name: string;
    readonly partNames: readonly string[];
    readonly liftMm: number;
    readonly nearestBody: string | undefined;
    readonly gapMm: number | undefined;
    readonly gapAt: Vec3 | undefined;
  }[];
  readonly findings: readonly PrintabilityFinding[];
};
