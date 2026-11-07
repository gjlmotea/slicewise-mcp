import { basename, isAbsolute, relative, resolve as resolvePath } from 'node:path';

import type {
  ParameterOverrides,
  PresetIndexEntry,
  PresetKind,
  PresetRecord,
  PresetValue,
  PrintabilityReport,
  ResolvedPreset,
  Vec3,
  SlicePlacement,
  SliceResult,
} from '../domain/contracts.js';
import {
  describeParameter,
  listParameters,
  ownerOf,
  rangeWarning,
  type ParameterGroup,
  type ParameterSpec,
} from '../domain/parameters/catalog.js';
import { isKnownParameterKey } from '../domain/parameters/known-keys.js';
import {
  optimizePrintInPlace,
  type OptimizationChange,
} from '../domain/parameters/optimizer.js';
import {
  applicableConditional,
  CONCERN_LABELS,
  getGoal,
  listGoals,
  matchGoal,
  type ConditionalMove,
  type GoalConcern,
  type GoalMove,
} from '../domain/parameters/goals.js';
import {
  explainRemedy,
  getSymptom,
  listSymptoms,
  matchSymptoms,
  type Symptom,
} from '../domain/parameters/diagnostics.js';
import { analysePrintability, DEFAULT_PRINTABILITY_OPTIONS } from '../domain/model/printability.js';
import { buildPrimitive, meshBounds, type PrimitiveShape } from '../domain/model/primitives.js';
import { inspectModel, parseStl } from '../domain/model/stl.js';
import { loadMesh, type MeshFileFormat } from '../domain/model/mesh-file.js';
import {
  analyseClearance,
  DEFAULT_CLEARANCE_OPTIONS,
  DEFAULT_MIN_DISTANCE_OPTIONS,
  type ClearanceReport,
} from '../domain/model/clearance.js';
import {
  buildBambuProject,
  isPartSubtype,
  readProjectStructure,
  trianglesToIndexedMesh,
  type ModelPart,
  type PartSubtype,
  type ProjectObject,
} from '../domain/model/threemf.js';
import { readZipEntry } from '../domain/slicing/zip.js';
import { diffPresets, type PresetDiffEntry } from '../domain/presets/resolver.js';
import type { ModelCatalog, ModelSearchResult } from '../ports/model-catalog.js';
import type { PresetStore, WriteUserPresetResult } from '../ports/preset-store.js';
import type { Slicer } from '../ports/slicer.js';

export type ModelFileReader = (path: string) => Buffer;

export type BambuServiceDependencies = {
  readonly presets: PresetStore;
  readonly slicer: Slicer;
  readonly catalogs: readonly ModelCatalog[];
  readonly readModelFile: ModelFileReader;
  /** 寫入輸出目錄；回傳完整路徑。未設定輸出目錄時為 undefined。 */
  readonly writeOutputFile?: (fileName: string, data: Buffer) => string;
  /**
   * 允許讀取模型檔的根目錄。
   *
   * `vibe/mcp` 架構原則第 4 條：不把任意檔案路徑暴露給 MCP Client。
   * 空陣列代表未設定，所有讀檔工具一律拒絕。
   */
  readonly allowedModelRoots: readonly string[];
  readonly version: string;
  readonly currentSelection: {
    readonly machine?: string;
    readonly process?: string;
    readonly filaments?: readonly string[];
  };
};

export type ServiceStatus = {
  readonly version: string;
  readonly dataDir: string;
  readonly profileId: string | undefined;
  readonly slicerPath: string;
  readonly slicerAvailable: boolean;
  readonly presetCounts: Readonly<Record<PresetKind, number>>;
  readonly currentSelection: BambuServiceDependencies['currentSelection'];
  readonly allowedModelRoots: readonly string[];
  readonly outputConfigured: boolean;
  readonly catalogs: readonly { readonly source: string; readonly integration: string; readonly ready: boolean }[];
  /** 這個 server 一律先展平 preset 繼承鏈再切片。 */
  readonly inheritanceFlattening: true;
};

export class PathNotAllowedError extends Error {
  constructor(path: string, roots: readonly string[]) {
    super(
      roots.length === 0
        ? `未設定 BAMBU_MODEL_DIR，拒絕讀取 ${path}。請在啟動設定中指定允許的模型目錄。`
        : `${path} 不在允許的模型目錄內：${roots.join('、')}`,
    );
    this.name = 'PathNotAllowedError';
  }
}

export class BambuService {
  readonly #deps: BambuServiceDependencies;

  constructor(dependencies: BambuServiceDependencies) {
    this.#deps = dependencies;
  }

  status(): ServiceStatus {
    const { presets, slicer, catalogs } = this.#deps;
    return {
      version: this.#deps.version,
      dataDir: presets.dataDir,
      profileId: presets.profileId,
      slicerPath: slicer.executablePath,
      slicerAvailable: slicer.available(),
      // 只算可實際選用的 preset。原廠索引裡有大量 fdm_* 中間層純粹供繼承，
      // 把它們算進去會讓「你有幾個 preset 可以用」這個數字失真。
      presetCounts: {
        machine: countSelectable(presets.list('machine')),
        process: countSelectable(presets.list('process')),
        filament: countSelectable(presets.list('filament')),
      },
      currentSelection: this.#deps.currentSelection,
      allowedModelRoots: this.#deps.allowedModelRoots,
      outputConfigured: 'outputDir' in slicer && (slicer as { outputDir?: string }).outputDir !== undefined,
      catalogs: catalogs.map((catalog) => ({
        source: catalog.source,
        integration: catalog.integration,
        ready: catalog.ready(),
      })),
      inheritanceFlattening: true,
    };
  }

  // ── preset ─────────────────────────────────────────────────────────────

  listPresets(
    kind: PresetKind,
    options: { readonly search?: string; readonly instantiableOnly?: boolean; readonly limit?: number } = {},
  ): { readonly total: number; readonly entries: readonly PresetIndexEntry[] } {
    let entries = this.#deps.presets.list(kind);

    if (options.instantiableOnly !== false) {
      entries = entries.filter((entry) => entry.instantiable);
    }
    if (options.search !== undefined && options.search.trim() !== '') {
      const needle = options.search.trim().toLowerCase();
      entries = entries.filter((entry) => entry.name.toLowerCase().includes(needle));
    }

    const total = entries.length;
    const limit = options.limit ?? 50;
    return { total, entries: entries.slice(0, limit) };
  }

  /**
   * 展平 preset 並回報每個值的來源層。
   *
   * `keys` 可以只取關心的參數；不給就回全部（process 約 200 個 key，
   * 全倒給模型意義不大，所以預設會被工具層限制）。
   */
  resolvePreset(name: string, kind: PresetKind, keys?: readonly string[]): ResolvedPreset {
    const resolved = this.#deps.presets.resolve(name, kind);
    if (keys === undefined || keys.length === 0) return resolved;

    const settings: Record<string, PresetValue> = {};
    const provenance: Record<string, string> = {};
    for (const key of keys) {
      const value = resolved.settings[key];
      if (value === undefined) continue;
      settings[key] = value;
      const source = resolved.provenance[key];
      if (source !== undefined) provenance[key] = source;
    }
    return { ...resolved, settings, provenance };
  }

  comparePresets(
    left: string,
    right: string,
    kind: PresetKind,
  ): { readonly left: string; readonly right: string; readonly differences: readonly PresetDiffEntry[] } {
    const a = this.#deps.presets.resolve(left, kind);
    const b = this.#deps.presets.resolve(right, kind);
    return { left, right, differences: diffPresets(a.settings, b.settings) };
  }

  saveUserPreset(request: {
    readonly name: string;
    readonly kind: PresetKind;
    readonly inherits: string;
    readonly overrides: ParameterOverrides;
    readonly overwrite?: boolean;
  }): { readonly result: WriteUserPresetResult; readonly warnings: readonly string[] } {
    const warnings: string[] = [];

    // 對照父層檢查：覆寫一個父層沒有的 key，通常是打錯名字或放錯 preset 種類。
    // BambuStudio 對不認識的 key 是靜默忽略，使用者會以為改了其實沒改，所以必須先講。
    const parent = this.#deps.presets.resolve(request.inherits, request.kind);
    for (const [key, value] of Object.entries(request.overrides)) {
      if (!(key in parent.settings)) {
        if (!isKnownParameterKey(key)) {
          warnings.push(`${key} 不是 BambuStudio 的參數名稱；請確認拼字。Bambu Studio 會靜默忽略它。`);
        } else {
          const owner = ownerOf(key);
          warnings.push(owner === request.kind
            ? `${key} 是有效的 ${request.kind} 參數，但父 preset 沒有宣告；請在切片產物中確認它有生效。`
            : `${key} 是有效參數但不屬於 ${request.kind} preset` +
                (owner === undefined ? '' : `（應該寫進 ${owner} preset）`) +
                '；寫在這裡會被忽略。');
        }
        continue;
      }
      if (typeof value === 'string') {
        const warning = rangeWarning(key, value);
        if (warning !== undefined) warnings.push(warning);
      }
    }

    return { result: this.#deps.presets.writeUserPreset(request), warnings };
  }

  /**
   * 建立一份保守的 print-in-place 使用者 process preset。
   *
   * 可以從原廠 preset 或既有使用者 preset 開始；後者會保留葉節點裡已存在的尺寸校正，
   * 但輸出的繼承關係仍直接指向原廠 preset，避免累積多層使用者繼承。
   */
  optimizePrintInPlacePreset(request: OptimizePrintInPlaceRequest): OptimizePrintInPlaceResult {
    const sourcePreset = request.processPreset ?? this.#deps.currentSelection.process;
    if (sourcePreset === undefined) {
      throw new Error('找不到目前的 process preset；請先在 Bambu Studio 選好，或明確指定 processPreset。');
    }

    const sourceRaw = this.#deps.presets.readRaw(sourcePreset, 'process');
    if (sourceRaw === undefined) {
      throw new Error(`找不到 process preset：${sourcePreset}`);
    }

    let basePreset = sourcePreset;
    let preserved: ParameterOverrides = {};
    if (sourceRaw.origin === 'user') {
      const parentName = sourceRaw.body['inherits'];
      if (typeof parentName !== 'string' || parentName.trim() === '') {
        throw new Error(`使用者 preset「${sourcePreset}」沒有可辨識的原廠 inherits。`);
      }
      const parentRaw = this.#deps.presets.readRaw(parentName, 'process');
      if (parentRaw?.origin !== 'system') {
        throw new Error(
          `使用者 preset「${sourcePreset}」不是直接繼承原廠 preset；` +
            '不自動展開多層使用者繼承，避免覆蓋來源不明的調整。',
        );
      }
      basePreset = parentName;
      preserved = extractDeclaredOverrides(sourceRaw.body, this.#deps.presets.resolve(basePreset, 'process').settings);
    }

    const effective = this.#deps.presets.resolve(sourcePreset, 'process').settings;
    const optimized = optimizePrintInPlace(effective, preserved, {
      ...(request.includeBrimEars === undefined ? {} : { includeBrimEars: request.includeBrimEars }),
    });
    const name = request.name?.trim() || `${sourcePreset} 自動穩定版`;
    const saved = this.saveUserPreset({
      name,
      kind: 'process',
      inherits: basePreset,
      overrides: optimized.overrides,
      ...(request.overwrite === undefined ? {} : { overwrite: request.overwrite }),
    });

    return {
      name,
      sourcePreset,
      basePreset,
      result: saved.result,
      overrides: optimized.overrides,
      changes: optimized.changes,
      preservedKeys: Object.keys(preserved).sort(),
      warnings: saved.warnings,
      manualActions: optimized.manualActions,
    };
  }

  // ── 參數知識 ───────────────────────────────────────────────────────────

  describeParameters(options: {
    readonly keys?: readonly string[];
    readonly group?: ParameterGroup;
  }): { readonly specs: readonly ParameterSpec[]; readonly unknown: readonly string[] } {
    if (options.keys !== undefined && options.keys.length > 0) {
      const specs: ParameterSpec[] = [];
      const missing: string[] = [];
      for (const key of options.keys) {
        const spec = describeParameter(key);
        if (spec === undefined) missing.push(key);
        else specs.push(spec);
      }
      return { specs, unknown: missing };
    }
    return { specs: listParameters(options.group), unknown: [] };
  }

  diagnose(options: { readonly symptom?: string; readonly symptomId?: string; readonly material?: string }): {
    readonly matched: readonly ReturnType<typeof formatSymptom>[];
    readonly available: readonly { readonly id: string; readonly label: string }[];
    readonly note: string | undefined;
  } {
    const available = listSymptoms().map((symptom) => ({ id: symptom.id, label: symptom.label }));

    if (options.symptomId !== undefined) {
      const symptom = getSymptom(options.symptomId);
      return symptom === undefined
        ? { matched: [], available, note: `沒有這個症狀代號：${options.symptomId}` }
        : { matched: [formatSymptom(symptom, options.material)], available, note: undefined };
    }

    if (options.symptom === undefined || options.symptom.trim() === '') {
      return { matched: [], available, note: '請描述現象，或直接指定 symptomId。' };
    }

    const matches = matchSymptoms(options.symptom);
    if (matches.length === 0) {
      return {
        matched: [],
        available,
        note:
          '沒有比對到已知症狀。刻意不做模糊猜測 —— 猜錯會給出讓情況更糟的建議。' +
          '請從 available 挑一個 symptomId，或換個描述詞。',
      };
    }

    return {
      matched: matches.slice(0, 3).map((match) => formatSymptom(match.symptom, options.material)),
      available,
      note: undefined,
    };
  }

  // ── 切片 ───────────────────────────────────────────────────────────────

  async slice(request: {
    readonly modelPath: string;
    readonly machinePreset?: string;
    readonly processPreset?: string;
    readonly filamentPresets?: readonly string[];
    readonly overrides?: ParameterOverrides;
    readonly placement?: SlicePlacement;
    readonly plate?: number;
  }): Promise<SliceResult> {
    const modelPath = this.#assertAllowed(request.modelPath);
    const selection = this.#deps.currentSelection;

    const machinePreset = request.machinePreset ?? selection.machine;
    const processPreset = request.processPreset ?? selection.process;
    const filamentPresets = request.filamentPresets ?? selection.filaments?.slice(0, 1) ?? [];

    if (machinePreset === undefined || processPreset === undefined || filamentPresets.length === 0) {
      return {
        ok: false,
        reason:
          '缺少 preset。請指定 machinePreset／processPreset／filamentPresets，' +
          '或先在 Bambu Studio 選好機器與材料讓本 server 讀到預設值。',
        stderrTail: [],
      };
    }

    return this.#deps.slicer.slice({
      modelPath,
      machinePreset,
      processPreset,
      filamentPresets,
      overrides: request.overrides ?? {},
      ...(request.placement === undefined ? {} : { placement: request.placement }),
      ...(request.plate === undefined ? {} : { plate: request.plate }),
    });
  }

  // ── 模型 ───────────────────────────────────────────────────────────────

  /**
   * 幾何量測。STL、3MF 與 OBJ 都吃 —— 判斷看內容不看副檔名。
   *
   * 3MF 會多回零件數與零件清單：多零件的 3MF 拿「合起來的體積」當單一實體看是會誤導的，
   * 使用者要的通常是「這裡面有幾塊東西」。
   */
  inspect(modelPath: string): ReturnType<typeof inspectModel> & {
    readonly format: MeshFileFormat;
    readonly partCount: number;
    readonly parts: readonly { readonly name: string; readonly triangleCount: number }[];
  } {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));
    const combined = inspectModel(mesh.triangles);

    // 封閉性必須逐零件算，不能把所有三角形倒在一起算。
    //
    // 多零件 3MF 常有貼合的切面：兩個零件在同一個平面上各有一片三角形，邊完全重合。
    // 合在一起數的話那條邊會被四個三角形共用，「恰好兩個」的判準就把它算成破洞 ——
    // 行星齒輪陀螺實測會冒出 3675 條假的開放邊，而每個零件其實都是封閉的。
    const perPart = mesh.parts.map((part) => inspectModel(part.triangles));
    const openEdges = perPart.reduce((sum, part) => sum + part.openEdges, 0);

    return {
      ...combined,
      closed: perPart.every((part) => part.closed),
      openEdges,
      degenerateTriangles: perPart.reduce((sum, part) => sum + part.degenerateTriangles, 0),
      format: mesh.format,
      partCount: mesh.parts.length,
      parts: mesh.parts.map((part) => ({ name: part.name, triangleCount: part.triangles.length })),
    };
  }

  /**
   * 零件之間的間隙。列印即組裝的模型能不能動就看這個。
   *
   * 只有 3MF 與 OBJ 有多零件資訊；STL 是單一三角形湯，沒有零件邊界可分，所以會直說量不了，
   * 而不是回一個看起來像答案的空報告。
   */
  measureClearance(
    modelPath: string,
    options: {
      readonly minimumClearanceMm?: number;
      readonly reportThresholdMm?: number;
      readonly samplingMm?: number;
    } = {},
  ): ClearanceReport {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));

    if (mesh.format === 'stl') {
      throw new Error(
        'STL 沒有零件邊界，量不出零件之間的間隙 —— 整個檔案就是一堆沒有分組的三角形。' +
          '請改用 3MF（Bambu 專案檔或多零件 3MF；MakerWorld 與 Bambu Studio 匯出的都是）或 OBJ（Tinkercad 的彩色匯出）。',
      );
    }

    return analyseClearance(
      mesh.parts,
      mesh.format,
      {
        minimumClearanceMm: options.minimumClearanceMm ?? DEFAULT_CLEARANCE_OPTIONS.minimumClearanceMm,
        reportThresholdMm: options.reportThresholdMm ?? DEFAULT_CLEARANCE_OPTIONS.reportThresholdMm,
        fuseEpsilonMm: DEFAULT_CLEARANCE_OPTIONS.fuseEpsilonMm,
      },
      {
        samplingMm: options.samplingMm ?? DEFAULT_MIN_DISTANCE_OPTIONS.samplingMm,
        maxSamples: DEFAULT_MIN_DISTANCE_OPTIONS.maxSamples,
      },
    );
  }

  checkPrintability(
    modelPath: string,
    options: {
      readonly buildVolume?: { readonly x: number; readonly y: number; readonly z: number };
      readonly overhangThresholdDegrees?: number;
      readonly lineWidthMm?: number;
    } = {},
  ): PrintabilityReport {
    const path = this.#assertAllowed(modelPath);
    const mesh = loadMesh(this.#deps.readModelFile(path), basename(path));
    return analysePrintability(
      mesh.triangles,
      {
        buildVolume: options.buildVolume ?? DEFAULT_PRINTABILITY_OPTIONS.buildVolume,
        overhangThresholdDegrees:
          options.overhangThresholdDegrees ?? DEFAULT_PRINTABILITY_OPTIONS.overhangThresholdDegrees,
        lineWidthMm: options.lineWidthMm ?? DEFAULT_PRINTABILITY_OPTIONS.lineWidthMm,
      },
      mesh.parts,
    );
  }

  // ── 目標導向規劃 ───────────────────────────────────────────────────────

  /**
   * 依目標排出一組參數調整，並在有模型時依幾何追加條件式調整。
   *
   * 會一併回報每個參數「目前的值」以及它的形狀。形狀很重要：不少參數在 preset 裡是
   * 每噴頭一項的陣列（例如 `filament_z_hop` 是 `["nil","0.6"]`，`"nil"` 是字面值代表未設定），
   * 拿一個純量去覆寫多噴頭參數會落空。把現況擺在建議旁邊，才不會調了個寂寞。
   */
  planSettings(request: PlanRequest): PlanResult {
    const goal =
      request.goalId !== undefined
        ? getGoal(request.goalId)
        : request.goal === undefined
          ? undefined
          : matchGoal(request.goal);

    const available = listGoals().map((entry) => ({ id: entry.id, label: entry.label }));

    if (goal === undefined) {
      return {
        goal: undefined,
        available,
        moves: [],
        printability: undefined,
        note:
          request.goal === undefined && request.goalId === undefined
            ? '請說明你要什麼（例如「不要印壞、慢慢印」或「趕時間」），或直接指定 goalId。'
            : '沒有比對到已知目標。刻意不猜 —— 目標猜錯會把整組參數往反方向調。請從 available 挑一個。',
      };
    }

    // 有模型就先看幾何，用來觸發條件式調整。
    let printability: PrintabilityReport | undefined;
    if (request.modelPath !== undefined) {
      printability = this.checkPrintability(request.modelPath);
    }

    const triggered = applicableConditional(
      goal,
      printability?.findings.map((finding) => finding.code) ?? [],
    );

    const resolved = this.#resolveForLookup(request);

    // 兩份清單分開映射，避免 union 把 ConditionalMove 專屬的欄位型別擦掉。
    const describe = (move: GoalMove, trigger?: ConditionalMove): PlannedMove => {
      const current = lookupCurrent(move.key, resolved);
      const spec = describeParameter(move.key);
      return {
        key: move.key,
        concern: move.concern,
        concernLabel: CONCERN_LABELS[move.concern],
        direction: move.direction,
        suggested: move.suggested,
        rationale: move.rationale,
        cost: move.cost,
        parameterLabel: spec?.label,
        unit: spec?.unit,
        currentValue: current.value,
        valueShape: current.shape,
        ownedBy: current.owner,
        triggeredBy: trigger?.when,
        triggerReason: trigger?.because,
      };
    };

    const moves: readonly PlannedMove[] = [
      ...goal.moves.map((move) => describe(move)),
      ...triggered.map((move) => describe(move, move)),
    ];

    const materialKey = request.material?.trim().toUpperCase();
    const materialNote =
      materialKey === undefined || goal.materialNotes === undefined
        ? undefined
        : goal.materialNotes[materialKey];

    return {
      goal: {
        id: goal.id,
        label: goal.label,
        optimisesFor: goal.optimisesFor,
        tradesAway: goal.tradesAway,
        materialNote,
        notAParameterProblem: goal.notAParameterProblem,
      },
      available,
      moves,
      printability,
      note: undefined,
    };
  }

  /** 只解析呼叫端指定的 preset；沒指定就退回 Studio 目前的選擇，都沒有就不查現值。 */
  #resolveForLookup(request: PlanRequest): Partial<Record<PresetKind, PresetRecord>> {
    const out: Partial<Record<PresetKind, PresetRecord>> = {};
    const processName = request.processPreset ?? this.#deps.currentSelection.process;
    const filamentName = request.filamentPreset ?? this.#deps.currentSelection.filaments?.[0];

    for (const [kind, name] of [
      ['process', processName],
      ['filament', filamentName],
    ] as const) {
      if (name === undefined) continue;
      try {
        out[kind] = this.#deps.presets.resolve(name, kind).settings;
      } catch {
        // preset 名稱不存在時不讓整個規劃失敗；現值留空即可。
      }
    }
    return out;
  }

  // ── 組裝 3MF ───────────────────────────────────────────────────────────

  /**
   * 用「本體 + 附加零件」組出一個 Bambu 專案 3MF。
   *
   * 這是非破壞性編輯：挖除體、局部參數區與支撐強制／阻擋在 Bambu 的模型裡就是
   * 「多一個零件加一個 subtype 標籤」，不需要幾何運算引擎，也不需要驅動 GUI。
   */
  composeModel(request: ComposeRequest): ComposeResult {
    const write = this.#deps.writeOutputFile;
    if (write === undefined) {
      throw new Error('未設定 BAMBU_OUTPUT_DIR；不會寫入未經授權的目錄。');
    }

    const warnings: string[] = [];
    const basePath = this.#assertAllowed(request.basePath);
    const baseTriangles = parseStl(this.#deps.readModelFile(basePath));
    const baseMesh = trianglesToIndexedMesh(baseTriangles);
    const baseBounds = meshBounds(baseMesh);

    const parts: ModelPart[] = [
      { name: request.baseName ?? 'body', subtype: 'normal_part', mesh: baseMesh },
    ];
    const summaries: PartSummary[] = [
      {
        name: parts[0]?.name ?? 'body',
        subtype: 'normal_part',
        triangleCount: baseMesh.triangles.length,
        bounds: baseBounds,
        intersectsBody: true,
      },
    ];

    for (const spec of request.parts) {
      if (!isPartSubtype(spec.subtype)) {
        throw new Error(
          `不合法的零件類型：${spec.subtype}。` +
            'BambuStudio 對認不得的字串是靜默回退成 normal_part —— ' +
            '「挖掉一塊」會變成「加上一塊實心」，而且不會有任何錯誤訊息。',
        );
      }

      const mesh =
        spec.shape.kind === 'stl'
          ? trianglesToIndexedMesh(parseStl(this.#deps.readModelFile(this.#assertAllowed(spec.shape.path))))
          : buildPrimitive(spec.shape, spec.position ?? { x: 0, y: 0, z: 0 });

      const bounds = meshBounds(mesh);
      const intersects = boundsOverlap(baseBounds, bounds);

      if (!intersects) {
        warnings.push(
          `零件「${spec.name}」與本體沒有交集，不會有任何效果。` +
            `本體範圍 ${fmtBounds(baseBounds)}，此零件 ${fmtBounds(bounds)}。`,
        );
      }

      for (const key of Object.keys(spec.settings ?? {})) {
        if (!isKnownParameterKey(key)) {
          warnings.push(`零件「${spec.name}」的設定 ${key} 不是 BambuStudio 的參數名稱，會被忽略。`);
        }
      }
      if (spec.settings !== undefined && spec.subtype !== 'modifier_part') {
        warnings.push(
          `零件「${spec.name}」帶了設定但類型是 ${spec.subtype}；` +
            '零件層級設定只有 modifier_part 會生效。',
        );
      }

      parts.push({
        name: spec.name,
        subtype: spec.subtype,
        mesh,
        ...(spec.settings === undefined ? {} : { settings: spec.settings }),
      });
      summaries.push({
        name: spec.name,
        subtype: spec.subtype,
        triangleCount: mesh.triangles.length,
        bounds,
        intersectsBody: intersects,
      });
    }

    const buffer = buildBambuProject({
      objectName: request.name,
      parts,
      ...(request.plateCentre === undefined ? {} : { plateCentre: request.plateCentre }),
    });

    const fileName = request.name.endsWith('.3mf') ? request.name : `${request.name}.3mf`;
    const outputPath = write(fileName, buffer);

    return { outputPath, parts: summaries, warnings, byteLength: buffer.length };
  }

  /** 讀回 3MF 的物件與零件結構，用來確認寫進去的東西真的在裡面。 */
  inspectProject(projectPath: string): readonly ProjectObject[] {
    const path = this.#assertAllowed(projectPath);
    const entry = readZipEntry(this.#deps.readModelFile(path), 'Metadata/model_settings.config');
    if (entry === undefined) {
      throw new Error(`${projectPath} 裡沒有 Metadata/model_settings.config；這不是 Bambu 專案 3MF。`);
    }
    return readProjectStructure(entry.toString('utf8'));
  }

  // ── 搜尋 ───────────────────────────────────────────────────────────────

  async searchModels(
    query: string,
    sources: readonly string[] | undefined,
    limit: number,
  ): Promise<readonly ModelSearchResult[]> {
    const selected =
      sources === undefined || sources.length === 0
        ? this.#deps.catalogs
        : this.#deps.catalogs.filter((catalog) => sources.includes(catalog.source));

    return Promise.all(selected.map((catalog) => catalog.search(query, limit)));
  }

  // ── 內部 ───────────────────────────────────────────────────────────────

  /**
   * 檔案路徑必須落在允許的根目錄內。
   *
   * 用 `relative()` 判斷而不是字串 prefix 比對：後者會讓 `/models-evil` 通過
   * `/models` 的檢查。同時解析 `..` 以防路徑穿越。
   */
  #assertAllowed(candidate: string): string {
    const roots = this.#deps.allowedModelRoots;
    const absolute = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(candidate);

    for (const root of roots) {
      const rel = relative(resolvePath(root), absolute);
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        return absolute;
      }
    }
    throw new PathNotAllowedError(candidate, roots);
  }
}

export type PlanRequest = {
  readonly goal?: string;
  readonly goalId?: string;
  readonly processPreset?: string;
  readonly filamentPreset?: string;
  readonly modelPath?: string;
  readonly material?: string;
};

export type PlannedMove = {
  readonly key: string;
  readonly concern: GoalConcern;
  readonly concernLabel: string;
  readonly direction: string;
  readonly suggested: string | undefined;
  readonly rationale: string;
  readonly cost: string;
  readonly parameterLabel: string | undefined;
  readonly unit: string | undefined;
  readonly currentValue: PresetValue | undefined;
  readonly valueShape: 'scalar' | 'per-extruder' | 'unknown';
  readonly ownedBy: PresetKind | undefined;
  readonly triggeredBy: string | undefined;
  readonly triggerReason: string | undefined;
};

export type PlanResult = {
  readonly goal:
    | {
        readonly id: string;
        readonly label: string;
        readonly optimisesFor: string;
        readonly tradesAway: string;
        readonly materialNote: string | undefined;
        readonly notAParameterProblem: string | undefined;
      }
    | undefined;
  readonly available: readonly { readonly id: string; readonly label: string }[];
  readonly moves: readonly PlannedMove[];
  readonly printability: PrintabilityReport | undefined;
  readonly note: string | undefined;
};

export type OptimizePrintInPlaceRequest = {
  readonly name?: string;
  readonly processPreset?: string;
  readonly includeBrimEars?: boolean;
  readonly overwrite?: boolean;
};

export type OptimizePrintInPlaceResult = {
  readonly name: string;
  readonly sourcePreset: string;
  readonly basePreset: string;
  readonly result: WriteUserPresetResult;
  readonly overrides: ParameterOverrides;
  readonly changes: readonly OptimizationChange[];
  readonly preservedKeys: readonly string[];
  readonly warnings: readonly string[];
  readonly manualActions: readonly string[];
};

/** 只保留使用者 preset 葉節點裡真正的 process 覆寫，不把 metadata 帶進新檔。 */
function extractDeclaredOverrides(
  body: Readonly<Record<string, unknown>>,
  parent: PresetRecord,
): ParameterOverrides {
  const overrides: Record<string, PresetValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(key in parent) && ownerOf(key) !== 'process') continue;
    if (typeof value === 'string') {
      overrides[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      overrides[key] = value;
    }
  }
  return overrides;
}

/**
 * 查一個參數目前的值與形狀。
 *
 * 形狀決定覆寫要怎麼寫：`per-extruder` 的參數要給陣列，塞純量會落空。
 * 兩種 preset 都找不到時回 `unknown` —— 不是保證不存在，只是這兩份 preset 沒宣告。
 */
function lookupCurrent(
  key: string,
  resolved: Partial<Record<PresetKind, PresetRecord>>,
): {
  readonly value: PresetValue | undefined;
  readonly shape: 'scalar' | 'per-extruder' | 'unknown';
  readonly owner: PresetKind | undefined;
} {
  for (const kind of ['process', 'filament', 'machine'] as const) {
    const value = resolved[kind]?.[key];
    if (value === undefined) continue;
    return {
      value,
      shape: Array.isArray(value) ? 'per-extruder' : 'scalar',
      owner: kind,
    };
  }
  return { value: undefined, shape: 'unknown', owner: ownerOf(key) };
}

export type ComposePartSpec = {
  readonly name: string;
  readonly subtype: PartSubtype;
  readonly shape: PrimitiveShape | { readonly kind: 'stl'; readonly path: string };
  readonly position?: Vec3;
  readonly settings?: Readonly<Record<string, PresetValue>>;
};

export type ComposeRequest = {
  readonly name: string;
  readonly basePath: string;
  readonly baseName?: string;
  readonly parts: readonly ComposePartSpec[];
  readonly plateCentre?: { readonly x: number; readonly y: number };
};

export type Bounds = { readonly min: Vec3; readonly max: Vec3 };

export type PartSummary = {
  readonly name: string;
  readonly subtype: PartSubtype;
  readonly triangleCount: number;
  readonly bounds: Bounds;
  readonly intersectsBody: boolean;
};

export type ComposeResult = {
  readonly outputPath: string;
  readonly parts: readonly PartSummary[];
  readonly warnings: readonly string[];
  readonly byteLength: number;
};

/**
 * 外框是否相交。
 *
 * 用來抓「挖除體擺錯位置、完全沒碰到本體」這種錯誤 —— 那會產生一個合法但毫無作用的
 * 3MF，切完發現什麼都沒變，卻不知道為什麼。外框相交不代表實體相交，
 * 所以只作警告不作阻擋。
 */
function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min.x < b.max.x && a.max.x > b.min.x &&
    a.min.y < b.max.y && a.max.y > b.min.y &&
    a.min.z < b.max.z && a.max.z > b.min.z
  );
}

function fmtBounds(b: Bounds): string {
  return `(${b.min.x.toFixed(1)}, ${b.min.y.toFixed(1)}, ${b.min.z.toFixed(1)}) – (${b.max.x.toFixed(1)}, ${b.max.y.toFixed(1)}, ${b.max.z.toFixed(1)})`;
}

function countSelectable(entries: readonly PresetIndexEntry[]): number {
  return entries.filter((entry) => entry.instantiable).length;
}

function formatSymptom(symptom: Symptom, material: string | undefined): {
  readonly id: string;
  readonly label: string;
  readonly mechanism: string;
  readonly remedies: readonly ReturnType<typeof explainRemedy>[];
  readonly materialNote: string | undefined;
  readonly notAParameterProblem: string | undefined;
} {
  const key = material?.trim().toUpperCase();
  const materialNote =
    key === undefined || symptom.materialNotes === undefined
      ? undefined
      : symptom.materialNotes[key];

  return {
    id: symptom.id,
    label: symptom.label,
    mechanism: symptom.mechanism,
    remedies: symptom.remedies.map(explainRemedy),
    materialNote,
    notAParameterProblem: symptom.notAParameterProblem,
  };
}

export type { PresetRecord };
