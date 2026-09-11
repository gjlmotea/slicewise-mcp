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
 * 拿掉值為 undefined 的欄位。
 *
 * zod 的 `.optional()` 產出 `T | undefined`，但本專案開了 `exactOptionalPropertyTypes`，
 * 「不存在」與「存在但為 undefined」是兩件事。直接轉交會被型別系統擋下來，
 * 而且真的傳 undefined 進去會覆蓋掉下游的預設值。
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
  // ── 狀態 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_get_status',
    {
      title: '讀取 Bambu Studio companion 狀態',
      description:
        '回報 BambuStudio 資料目錄、切片執行檔是否可用、preset 數量、目前在 Studio 選用的機器與材料、' +
        '允許的模型目錄，以及各模型平台的整合層級。無副作用。',
      inputSchema: getStatusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      const status = service.status();
      const parts = [
        `BambuStudio 資料目錄 ${status.dataDir}`,
        status.slicerAvailable ? '切片器可用' : `切片器不可用（${status.slicerPath}）`,
        `preset：machine ${status.presetCounts.machine}／process ${status.presetCounts.process}／filament ${status.presetCounts.filament}`,
        '所有切片都會先展平 preset 繼承鏈',
      ];
      return ok({ ...status }, parts.join('；') + '。');
    },
  );

  // ── preset ───────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_list_presets',
    {
      title: '列出 preset',
      description:
        '列出機器、製程或材料 preset。預設只回可在 UI 選用的 preset，' +
        '過濾掉只供繼承的中間層（例如 fdm_process_common）。無副作用。',
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
          `${kind} preset 共 ${total} 個，回傳 ${entries.length} 個。`,
        );
      } catch (error) {
        return fail({ kind, total: 0, returned: 0, entries: [] }, message(error));
      }
    },
  );

  server.registerTool(
    'bambu_resolve_preset',
    {
      title: '展平 preset 繼承鏈',
      description:
        '把 preset 的 inherits 鏈展平成完整設定，並標明每個值來自哪一層。' +
        'BambuStudio 的葉節點 preset 通常只宣告數十個 key，其餘全部繼承自上層 —— ' +
        '要知道某個參數的真實值，必須看展平結果而不是葉節點檔案。無副作用。',
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
          `${args.name} 展平後有 ${Object.keys(resolved.settings).length} 個設定，` +
            `繼承鏈：${resolved.inheritanceChain.join(' <- ')}。`,
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
      title: '比較兩個 preset',
      description:
        '展平兩個同類 preset 後列出差異。用來回答「0.20 Standard 跟 0.20 Strength 到底差在哪」' +
        '這種問題，不必人工翻四層 JSON。無副作用。',
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
          `${args.left} 與 ${args.right} 有 ${result.differences.length} 個設定不同。`,
        );
      } catch (error) {
        return fail(
          { left: args.left, right: args.right, differenceCount: 0, differences: [] },
          message(error),
        );
      }
    },
  );

  // ── 參數知識 ─────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_describe_parameters',
    {
      title: '查參數的意義與代價',
      description:
        '說明參數在做什麼、單位、建議區間，以及調高與調低各自的代價與牽連參數。' +
        '調任何參數之前先查這個，避免用「聽起來合理」的方式亂調。無副作用。',
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
          ? `回傳 ${specs.length} 個參數說明。`
          : `回傳 ${specs.length} 個參數說明；catalog 未收錄：${unknown.join('、')}。`,
      );
    },
  );

  server.registerTool(
    'bambu_diagnose',
    {
      title: '從列印失敗現象推參數',
      description:
        '輸入觀察到的現象（翹邊、牽絲、層裂、象腿、頂面有洞……），回傳有序的處置建議：' +
        '每一步都附上原理、建議值與代價。比對不到已知症狀時會明說，不會猜。' +
        '也會指出哪些問題根本不是參數能解的。無副作用。',
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
          ? (result.note ?? '沒有比對到症狀。')
          : `比對到 ${result.matched.map((entry) => entry.label).join('、')}。`,
      );
    },
  );

  server.registerTool(
    'bambu_plan_settings',
    {
      title: '依目標規劃參數',
      description:
        '說出你要什麼（穩妥不失敗／省時／受力強度／外觀表面／省料），回傳有序的參數調整，' +
        '依「在對付什麼」分組：附著與翹曲、噴頭碰撞、表面品質、結構強度、時間、耗材。' +
        '每一項都附原理、建議值、代價，以及**目前 preset 裡的實際值與它的形狀**' +
        '（per-extruder 參數要用陣列覆寫，塞純量會落空）。' +
        '給了 modelPath 會先做可列印性分析，依幾何追加條件式調整。' +
        '這是事前規劃；已經印壞了要回推成因請用 bambu_diagnose。無副作用。',
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
            ? (plan.note ?? '沒有比對到目標。')
            : `目標「${plan.goal.label}」：${plan.moves.length} 項調整（` +
              [...byConcern].map(([label, count]) => `${label} ${count}`).join('、') +
              `）` +
              (triggered.length === 0 ? '。' : `，其中 ${triggered.length} 項由模型幾何觸發。`),
        );
      } catch (error) {
        return fail({ available: [], moves: [] }, message(error));
      }
    },
  );

  server.registerTool(
    'bambu_optimize_print_in_place',
    {
      title: '自動建立 print-in-place 穩定 preset',
      description:
        '從指定或目前的 process preset 建立一份可直接在 Bambu Studio 使用的自動穩定版。' +
        '會精確套用首層外框 20 mm/s、首層填充 30 mm/s、外牆上限 60 mm/s、懸空減速、' +
        '繞開已印牆面、Monotonic line、關閉熨燙與 Fuzzy Skin。' +
        '若來源是既有使用者 preset，會保留其中的尺寸／象腿等葉節點校正，但新檔仍直接繼承原廠 preset。' +
        '預設明確關閉 Auto Brim，避免黏死齒輪間隙；可明確要求 Brim Ears，且仍會提醒檢查第一層。' +
        '不修改材料溫度、冷卻或流量，因為普通 PLA 與 Silk PLA 必須分開校正。會寫入使用者 profile。',
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
            nextStep: '正常關閉並重新開啟 Bambu Studio 後，在 Process 下拉選單選用這份 preset。',
          },
          `${optimized.result.overwritten ? '已更新' : '已建立'}「${optimized.name}」；` +
            `自動調整 ${optimized.changes.length} 項，保留 ${optimized.preservedKeys.length} 項既有覆寫。`,
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

  // ── 寫入 Studio ──────────────────────────────────────────────────────
  server.registerTool(
    'bambu_save_user_preset',
    {
      title: '寫入使用者 preset 到 Bambu Studio',
      description:
        '在 BambuStudio 使用者 profile 目錄建立一個繼承原廠 preset 的自訂 preset，' +
        '重啟 Bambu Studio 後會出現在下拉選單。' +
        'BambuStudio 沒有 plugin API（見 bambulab/BambuStudio#9614），這是讓 AI 調整的參數' +
        '進到 GUI 的唯一途徑。會寫檔；同名 preset 不會靜默覆蓋。',
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
            nextStep: '重新啟動 Bambu Studio，這個 preset 就會出現在對應的下拉選單裡。',
          },
          `${result.overwritten ? '已取代' : '已建立'} preset「${args.name}」：${result.path}。` +
            (warnings.length === 0 ? '' : `另有 ${warnings.length} 項提醒。`),
        );
      } catch (error) {
        return fail(
          { path: '', created: false, overwritten: false, warnings: [], nextStep: '' },
          message(error),
        );
      }
    },
  );

  // ── 切片 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_slice',
    {
      title: '切片（展平繼承鏈後執行）',
      description:
        '用 BambuStudio CLI 切片並回報真實統計：層數、列印時間、耗材重量。' +
        'preset 會先展平再交給 CLI —— 直接餵原始 preset 給 CLI 會讓繼承來的參數全部掉回內建預設值' +
        '（BambuStudio#1704）。切完會從產物讀回實際生效的設定，逐項稽核你要求的覆寫有沒有落實。' +
        '會啟動子行程並寫出 .gcode.3mf 到設定的輸出目錄。',
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

        // 只回報被要求的參數。產物有 568 個 key，整包倒回去對模型沒有意義。
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
          `切片完成：${result.stats.layerCount} 層` +
            (time === undefined ? '' : `、約 ${formatDuration(time)}`) +
            (result.stats.filamentGrams === undefined ? '' : `、${result.stats.filamentGrams} g`) +
            '。' +
            (missed.length === 0
              ? ''
              : ` 注意：${missed.length} 項覆寫未生效（${missed.map((entry) => entry.key).join('、')}）。`),
        );
      } catch (error) {
        return fail({ ok: false, reason: message(error), stderrTail: [] }, message(error));
      }
    },
  );

  // ── 模型 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_inspect_model',
    {
      title: '檢查模型幾何',
      description:
        '解析 STL（binary 或 ASCII）或 3MF，回報三角形數、外框尺寸、體積、表面積與網格是否封閉。' +
        '格式依檔案內容判斷，不看副檔名。3MF 會一併回報零件數與零件清單（座標已套用擺放 transform）。' +
        '只讀允許目錄內的檔案。無副作用。',
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
          `${inspection.format.toUpperCase()}，${inspection.triangleCount} 個三角形` +
            (inspection.partCount > 1 ? `（${inspection.partCount} 個零件）` : '') +
            `，尺寸 ${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)} mm，` +
            (inspection.closed ? '網格封閉。' : `網格未封閉（${inspection.openEdges} 條開放邊）。`),
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
      title: '列印可行性檢查',
      description:
        '切片前先看得出來的問題：超出列印範圍、網格未封閉、陡峭懸空佔比、底面積過小、' +
        '高寬比過大、特徵過薄、大面積底面的翹曲風險。每一項都附上相關參數。' +
        '這是幾何分析不是切片模擬，模型內部的薄壁必須實際切片才看得到。無副作用。',
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
            ? `有 ${blockers.length} 項阻斷問題：${blockers.map((finding) => finding.summary).join('；')}。`
            : `可以列印。共 ${report.findings.length} 項提醒，懸空面積佔 ${(report.overhangAreaRatio * 100).toFixed(1)}%。`,
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
      title: '量測零件之間的間隙',
      description:
        '量出 3MF 裡各零件之間的最小間隙，判斷列印即組裝（print-in-place）的機構印完會不會黏死。' +
        '會先把互相接觸的零件併成剛體再比對 —— Bambu 把「同一顆實體的換色段落」也存成獨立零件，' +
        '不併就會把同一塊東西報成「間隙 0」。間隙不足時會給出補償建議，並區分外輪廓與孔洞' +
        '（被包住的那一側在切片器眼中是孔，吃的是不同的參數）。STL 沒有零件邊界，量不了。無副作用。',
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
            ? `${report.bodies.length} 顆實體，沒有距離在門檻內的零件配對。`
            : `${report.bodies.length} 顆實體、${report.pairs.length} 組介面，` +
              `最緊 ${report.tightestGapMm.toFixed(3)} mm` +
              (fusing > 0
                ? `，其中 ${fusing} 組低於 ${report.minimumClearanceMm} mm 會黏死。`
                : '，都在可靠區間。');

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

  // ── 組裝 3MF ─────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_compose_model',
    {
      title: '組裝含挖除體／修飾體的 3MF',
      description:
        '用「本體 STL + 附加零件」組出 Bambu 專案 3MF。挖除體（negative_part）挖掉重疊處、' +
        '修飾體（modifier_part）讓該區域套用不同參數、support_blocker／support_enforcer 控制支撐。' +
        '這些在 Bambu 的模型裡就是「多一個零件加一個標籤」，不需要幾何運算引擎。' +
        '產出可以用 bambu_inspect_project 逐項讀回驗證，或直接餵給 bambu_slice。會寫檔到輸出目錄。',
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
              '用 bambu_inspect_project 確認零件結構，或直接用 bambu_slice 切片；' +
              '比較加零件前後的 max_z_height 與耗材重量就能確認挖除體真的生效。',
          },
          `已寫出 ${result.outputPath}（${result.parts.length} 個零件）。` +
            (ineffective.length === 0
              ? ''
              : ` 注意：${ineffective.map((part) => part.name).join('、')} 與本體沒有交集，不會有效果。`),
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
      title: '讀回 3MF 的零件結構',
      description:
        '從 Bambu 專案 3MF 讀出物件與零件，包含每個零件的 subtype 與零件層級設定。' +
        '用來驗證寫進去的東西真的在裡面 —— 這是檔案路線相對 GUI 的關鍵優勢：可以逐項比對，' +
        '不是只能看畫面。也會標出 BambuStudio 認不得的 subtype。無副作用。',
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
          `${objects.length} 個物件、${partCount} 個零件。` +
            (unrecognised.length === 0
              ? ''
              : ` 警告：${unrecognised.length} 個零件的 subtype 不被 BambuStudio 認得，會被當成 normal_part。`),
        );
      } catch (error) {
        return fail({ objects: [] }, message(error));
      }
    },
  );

  // ── 搜尋 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'bambu_search_models',
    {
      title: '搜尋 3D 模型',
      description:
        '跨平台查模型。Thingiverse 走官方 API（需 THINGIVERSE_TOKEN）。' +
        'MakerWorld 與 Printables 沒有官方公開介面，只回傳查詢連結由人自行開啟 —— ' +
        '這是刻意的能力降級，不用爬蟲或私有 endpoint 假裝有 API。會連外網。',
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
        `找到 ${hitCount} 筆結果` +
          (handoffs.length === 0
            ? '。'
            : `；${handoffs.map((result) => result.source).join('、')} 沒有官方 API，只提供查詢連結。`),
      );
    },
  );
}
