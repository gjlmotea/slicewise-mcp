import { z } from 'zod';

/**
 * 工具的輸入與輸出 schema。
 *
 * MCP SDK 的 `registerTool` 收的是 ZodRawShape（欄位物件），不是 `z.object(...)`。
 */

const presetKind = z.enum(['machine', 'process', 'filament']);

/** preset 值：單值或每個 extruder 一項的陣列。 */
const presetValue = z.union([z.string(), z.array(z.string())]);

const overrides = z
  .record(z.string(), presetValue)
  .describe('要覆寫的參數，key 是 BambuStudio 的設定名稱（例如 layer_height、sparse_infill_density）。');

export const getStatusInputSchema = {};

export const statusOutputSchema = {
  version: z.string(),
  dataDir: z.string(),
  profileId: z.string().optional(),
  slicerPath: z.string(),
  slicerAvailable: z.boolean(),
  presetCounts: z.object({
    machine: z.number(),
    process: z.number(),
    filament: z.number(),
  }),
  currentSelection: z.object({
    machine: z.string().optional(),
    process: z.string().optional(),
    filaments: z.array(z.string()).optional(),
  }),
  allowedModelRoots: z.array(z.string()),
  outputConfigured: z.boolean(),
  catalogs: z.array(
    z.object({ source: z.string(), integration: z.string(), ready: z.boolean() }),
  ),
  inheritanceFlattening: z.literal(true),
};

export const listPresetsInputSchema = {
  kind: presetKind,
  search: z.string().optional().describe('名稱子字串過濾，不分大小寫。'),
  includeAbstract: z
    .boolean()
    .optional()
    .describe('是否包含只供繼承、無法在 UI 選用的中間層 preset。預設 false。'),
  limit: z.number().int().min(1).max(200).optional(),
};

export const listPresetsOutputSchema = {
  kind: presetKind,
  total: z.number(),
  returned: z.number(),
  entries: z.array(
    z.object({
      name: z.string(),
      origin: z.enum(['system', 'user']),
      instantiable: z.boolean(),
      inherits: z.string().optional(),
      relativePath: z.string(),
    }),
  ),
};

export const resolvePresetInputSchema = {
  name: z.string(),
  kind: presetKind,
  keys: z
    .array(z.string())
    .optional()
    .describe('只回傳這些參數。不給就回全部（process 約 200 個 key）。'),
};

export const resolvePresetOutputSchema = {
  name: z.string(),
  kind: presetKind,
  origin: z.enum(['system', 'user']),
  inheritanceChain: z.array(z.string()).describe('由葉到根的繼承鏈。'),
  settingCount: z.number(),
  settings: z.record(z.string(), presetValue),
  provenance: z
    .record(z.string(), z.string())
    .describe(
      '每個 key 實際來自繼承鏈的哪一層。機器 G-code 可能來自該層的模板條目，' +
        '名稱形如「<preset> template machine_start_gcode」。',
    ),
};

export const comparePresetsInputSchema = {
  left: z.string(),
  right: z.string(),
  kind: presetKind,
  limit: z.number().int().min(1).max(500).optional(),
};

export const comparePresetsOutputSchema = {
  left: z.string(),
  right: z.string(),
  differenceCount: z.number(),
  differences: z.array(
    z.object({
      key: z.string(),
      left: presetValue.optional(),
      right: presetValue.optional(),
    }),
  ),
};

export const describeParametersInputSchema = {
  keys: z.array(z.string()).optional(),
  group: z
    .enum([
      'quality',
      'strength',
      'speed',
      'adhesion',
      'support',
      'temperature',
      'cooling',
      'retraction',
      'accuracy',
      'surface',
    ])
    .optional(),
};

export const describeParametersOutputSchema = {
  specs: z.array(
    z.object({
      key: z.string(),
      owner: presetKind,
      group: z.string(),
      label: z.string(),
      valueType: z.string(),
      unit: z.string().optional(),
      typicalRange: z.object({ min: z.number(), max: z.number() }).optional(),
      enumValues: z.array(z.string()).optional(),
      whatItDoes: z.string(),
      raising: z.string(),
      lowering: z.string(),
      related: z.array(z.string()),
    }),
  ),
  unknown: z.array(z.string()).describe('catalog 未收錄的 key。'),
};

export const diagnoseInputSchema = {
  symptom: z.string().optional().describe('用自然語言描述現象，例如「底部一圈胖出來」。'),
  symptomId: z.string().optional().describe('已知症狀代號，跳過文字比對。'),
  material: z.string().optional().describe('材料，例如 PLA／ABS／PETG／TPU；有對應註記時會一併回傳。'),
};

export const diagnoseOutputSchema = {
  matched: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      mechanism: z.string(),
      remedies: z.array(
        z.object({
          key: z.string(),
          direction: z.string(),
          suggested: z.string().optional(),
          rationale: z.string(),
          cost: z.string(),
          parameterLabel: z.string().optional(),
          parameterUnit: z.string().optional(),
          typicalRange: z.object({ min: z.number(), max: z.number() }).optional(),
        }),
      ),
      materialNote: z.string().optional(),
      notAParameterProblem: z.string().optional(),
    }),
  ),
  available: z.array(z.object({ id: z.string(), label: z.string() })),
  note: z.string().optional(),
};

export const planSettingsInputSchema = {
  goal: z
    .string()
    .optional()
    .describe('用自然語言說你要什麼，例如「不要印壞、慢慢印高品質」或「趕時間」。'),
  goalId: z
    .enum(['safe', 'fast', 'strong', 'surface', 'economical'])
    .optional()
    .describe('直接指定目標，跳過文字比對。'),
  modelPath: z
    .string()
    .optional()
    .describe('給了模型就會先做可列印性分析，依幾何追加條件式調整（例如底面積過小時加寬 brim）。'),
  processPreset: z.string().optional().describe('不給就用 Bambu Studio 目前選用的。'),
  filamentPreset: z.string().optional(),
  material: z.string().optional().describe('PLA／PETG／ABS／ASA／TPU；有對應註記時一併回傳。'),
};

export const planSettingsOutputSchema = {
  goal: z
    .object({
      id: z.string(),
      label: z.string(),
      optimisesFor: z.string(),
      tradesAway: z.string(),
      materialNote: z.string().optional(),
      notAParameterProblem: z.string().optional(),
    })
    .optional(),
  available: z.array(z.object({ id: z.string(), label: z.string() })),
  moves: z.array(
    z.object({
      key: z.string(),
      concern: z.string(),
      concernLabel: z.string(),
      direction: z.string(),
      suggested: z.string().optional(),
      rationale: z.string(),
      cost: z.string(),
      parameterLabel: z.string().optional(),
      unit: z.string().optional(),
      currentValue: presetValue.optional().describe('目前 preset 裡的值。'),
      valueShape: z
        .enum(['scalar', 'per-extruder', 'unknown'])
        .describe('per-extruder 的參數要用陣列覆寫，塞純量會落空。'),
      ownedBy: z.string().optional(),
      triggeredBy: z.string().optional().describe('由哪一項可列印性發現觸發；空的代表是該目標的基本調整。'),
      triggerReason: z.string().optional(),
    }),
  ),
  printability: z
    .object({
      fitsBuildVolume: z.boolean(),
      overhangAreaRatio: z.number(),
      findings: z.array(
        z.object({ code: z.string(), severity: z.string(), summary: z.string() }),
      ),
    })
    .optional(),
  note: z.string().optional(),
};

export const optimizePrintInPlaceInputSchema = {
  name: z
    .string()
    .optional()
    .describe('新使用者 preset 名稱。不給就以來源名稱加上「自動穩定版」。'),
  processPreset: z
    .string()
    .optional()
    .describe('來源 process preset；不給就用 Bambu Studio 目前選用的。可指定既有使用者 preset。'),
  includeBrimEars: z
    .boolean()
    .optional()
    .describe('是否一併開啟 5 mm Brim Ears。預設 false，因為活動間隙必須先看第一層預覽。'),
  overwrite: z.boolean().optional().describe('同名 preset 已存在時是否取代。預設 false。'),
};

export const optimizePrintInPlaceOutputSchema = {
  name: z.string(),
  sourcePreset: z.string(),
  basePreset: z.string(),
  path: z.string(),
  created: z.boolean(),
  overwritten: z.boolean(),
  overrides,
  changes: z.array(
    z.object({
      key: z.string(),
      before: presetValue.optional(),
      after: presetValue,
      rationale: z.string(),
    }),
  ),
  preservedKeys: z.array(z.string()),
  warnings: z.array(z.string()),
  manualActions: z.array(z.string()),
  nextStep: z.string(),
};

export const saveUserPresetInputSchema = {
  name: z.string().describe('新 preset 的名稱，會顯示在 Bambu Studio 的下拉選單。'),
  kind: presetKind,
  inherits: z.string().describe('要繼承的原廠 preset 名稱。'),
  overrides,
  overwrite: z.boolean().optional().describe('同名已存在時是否取代。預設 false。'),
};

export const saveUserPresetOutputSchema = {
  path: z.string(),
  created: z.boolean(),
  overwritten: z.boolean(),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export const sliceInputSchema = {
  modelPath: z.string().describe('模型檔絕對路徑，必須位於允許的模型目錄內。'),
  machinePreset: z.string().optional(),
  processPreset: z.string().optional(),
  filamentPresets: z.array(z.string()).optional(),
  overrides: overrides.optional(),
  placement: z
    .object({
      arrange: z.boolean().optional(),
      orient: z.boolean().optional(),
      ensureOnBed: z.boolean().optional(),
      scale: z.number().positive().optional(),
      rotate: z.number().optional(),
      rotateX: z.number().optional(),
      rotateY: z.number().optional(),
    })
    .optional(),
  plate: z.number().int().min(0).optional(),
  reportSettings: z
    .array(z.string())
    .optional()
    .describe(
      '從產物讀回這些參數實際生效的值。用來確認切片真的採用了 preset 的值，' +
        '而不是切片器內建的預設值。',
    ),
};

export const sliceOutputSchema = {
  ok: z.boolean(),
  outputPath: z.string().optional(),
  reason: z.string().optional(),
  stderrTail: z.array(z.string()).optional(),
  stats: z
    .object({
      layerCount: z.number(),
      maxZHeight: z.number(),
      layerHeight: z.number(),
      modelPrintTimeSeconds: z.number().optional(),
      totalEstimatedTimeSeconds: z.number().optional(),
      filamentGrams: z.number().optional().describe('整盤合計（含換色沖洗與擦料塔）；多色時是各色加總。'),
      filamentLengthMm: z.number().optional().describe('整盤合計；多色時是各色加總。'),
      filamentBreakdown: z
        .array(
          z.object({
            filament: z.number().optional().describe('耗材槽編號（1 起算）。'),
            grams: z.number().optional(),
            lengthMm: z.number().optional(),
          }),
        )
        .optional()
        .describe('多色時每一色的用量；單色不回傳。'),
    })
    .optional(),
  overrideAudit: z
    .array(
      z.object({
        key: z.string(),
        requested: presetValue,
        applied: presetValue.optional(),
        honoured: z.boolean(),
      }),
    )
    .optional(),
  appliedSettings: z
    .record(z.string(), presetValue)
    .optional()
    .describe('reportSettings 要求的參數在產物中的實際值。'),
  warnings: z.array(z.string()).optional(),
};

export const inspectModelInputSchema = {
  modelPath: z.string(),
};

const boundingBox = z.object({
  min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  size: z.object({ x: z.number(), y: z.number(), z: z.number() }),
});

export const inspectModelOutputSchema = {
  triangleCount: z.number(),
  boundingBox,
  volumeMm3: z.number(),
  surfaceAreaMm2: z.number(),
  closed: z.boolean(),
  degenerateTriangles: z.number(),
  openEdges: z.number(),
  format: z.enum(['stl', '3mf']).optional().describe('實際判讀出來的格式，依內容而非副檔名。'),
  partCount: z.number().optional(),
  parts: z.array(z.object({ name: z.string(), triangleCount: z.number() })).optional(),
};

export const measureClearanceInputSchema = {
  modelPath: z.string().describe('3MF 的絕對路徑，必須位於允許的模型目錄內。'),
  minimumClearanceMm: z
    .number()
    .positive()
    .optional()
    .describe('可靠印出的最小間隙。預設 0.15（0.4 噴頭 PLA 的實務下限）。'),
  reportThresholdMm: z
    .number()
    .positive()
    .optional()
    .describe('超過這個距離的零件配對不列入報告。預設 2 mm。'),
  samplingMm: z
    .number()
    .positive()
    .optional()
    .describe('表面取樣間距，越小越準也越慢。預設 0.2 mm。'),
};

export const measureClearanceOutputSchema = {
  format: z.string(),
  partCount: z.number(),
  bodies: z.array(
    z.object({
      name: z.string(),
      partNames: z.array(z.string()),
      extruders: z.array(z.string()),
      triangleCount: z.number(),
      boundingBox,
    }),
  ),
  pairs: z.array(
    z.object({
      a: z.string(),
      b: z.string(),
      gapMm: z.number(),
      at: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      verdict: z.enum(['will-fuse', 'marginal', 'adequate']),
      enclosure: z.enum(['a-encloses-b', 'b-encloses-a', 'neither']),
    }),
  ),
  tightestGapMm: z.number().optional(),
  minimumClearanceMm: z.number(),
  findings: z.array(z.string()),
  recommendation: z
    .object({
      xy_contour_compensation: z.string(),
      xy_hole_compensation: z.string(),
      rationale: z.string(),
    })
    .optional(),
};

export const checkPrintabilityInputSchema = {
  modelPath: z.string(),
  buildVolume: z
    .object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() })
    .optional()
    .describe('預設為 Bambu Lab P1S／X1C 的 256×256×256 mm。'),
  overhangThresholdDegrees: z
    .number()
    .min(0)
    .max(90)
    .optional()
    .describe('與垂直面的夾角；0° 是垂直牆，90° 是水平天花板。預設 45。'),
  lineWidthMm: z.number().positive().optional(),
};

export const checkPrintabilityOutputSchema = {
  inspection: z.object({
    triangleCount: z.number(),
    boundingBox,
    volumeMm3: z.number(),
    surfaceAreaMm2: z.number(),
    closed: z.boolean(),
    degenerateTriangles: z.number(),
    openEdges: z.number(),
  }),
  buildVolume: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  fitsBuildVolume: z.boolean(),
  overhangAreaRatio: z.number(),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['blocker', 'warning', 'note']),
      summary: z.string(),
      detail: z.string(),
      relatedParameters: z.array(z.string()),
    }),
  ),
};

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

const shape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), size: vec3 }),
  z.object({
    kind: z.literal('cylinder'),
    diameter: z.number().positive(),
    height: z.number().positive(),
    segments: z.number().int().min(8).max(128).optional(),
  }),
  z.object({
    kind: z.literal('sphere'),
    diameter: z.number().positive(),
    segments: z.number().int().min(8).max(128).optional(),
  }),
  z.object({ kind: z.literal('stl'), path: z.string() }),
]);

export const composeModelInputSchema = {
  name: z.string().min(1).describe('輸出檔名（會自動補 .3mf）與物件名稱。不得包含路徑分隔符。'),
  basePath: z.string().describe('本體 STL 的路徑，必須位於允許的模型目錄內。'),
  baseName: z.string().optional().describe('本體零件的顯示名稱，預設 body。'),
  parts: z
    .array(
      z.object({
        name: z.string().min(1),
        subtype: z
          .enum(['negative_part', 'modifier_part', 'support_blocker', 'support_enforcer', 'normal_part'])
          .describe(
            'negative_part 挖除、modifier_part 局部參數區、support_blocker／support_enforcer 控制支撐、' +
              'normal_part 追加實體。BambuStudio 對認不得的字串會靜默當成 normal_part，所以只接受這五個。',
          ),
        shape,
        position: vec3.optional().describe('原始形狀的中心點，與本體同一個座標系。stl 形狀忽略此欄位。'),
        settings: z
          .record(z.string(), presetValue)
          .optional()
          .describe('零件層級設定，只有 modifier_part 會生效。'),
      }),
    )
    .min(1),
  plateCentre: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('物件在列印板上的落點，預設 256×256 板的中心 (128, 128)。'),
};

export const composeModelOutputSchema = {
  outputPath: z.string(),
  byteLength: z.number(),
  parts: z.array(
    z.object({
      name: z.string(),
      subtype: z.string(),
      triangleCount: z.number(),
      bounds: z.object({ min: vec3, max: vec3 }),
      intersectsBody: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
  nextStep: z.string(),
};

export const inspectProjectInputSchema = {
  projectPath: z.string().describe('Bambu 專案 3MF 的路徑。'),
};

export const inspectProjectOutputSchema = {
  objects: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      parts: z.array(
        z.object({
          id: z.string(),
          subtype: z.string(),
          recognised: z.boolean(),
          name: z.string().optional(),
          settings: z.record(z.string(), z.string()),
        }),
      ),
    }),
  ),
};

export const searchModelsInputSchema = {
  query: z.string().min(1),
  sources: z
    .array(z.string())
    .optional()
    .describe('限定平台；不給就全查。可用值見 bambu_get_status 的 catalogs。'),
  limit: z.number().int().min(1).max(30).optional(),
};

export const searchModelsOutputSchema = {
  query: z.string(),
  results: z.array(
    z.object({
      source: z.string(),
      integration: z.enum(['official-api', 'handoff-only']),
      hits: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          creator: z.string().optional(),
          license: z.string().optional(),
          thumbnailUrl: z.string().optional(),
          likes: z.number().optional(),
          downloads: z.number().optional(),
        }),
      ),
      handoffUrl: z.string().optional(),
      notes: z.array(z.string()),
    }),
  ),
};
