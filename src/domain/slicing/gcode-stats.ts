import type { FilamentUsage, SliceStats } from '../contracts.js';

/**
 * 從 BambuStudio 產出的 G-code 標頭解析客觀統計。
 *
 * 這些數字是切片器自己算的，不是我們估的。任何回報給使用者的「這樣改省了多少時間」
 * 都必須來自這裡，不能用參數推估 —— 推估會系統性偏離真實結果。
 *
 * 欄位名稱以本機 BambuStudio 02.07.01.62 的實際輸出為準：
 *
 * ```
 * ; model printing time: 8m 45s; total estimated time: 9m 5s
 * ; total layer number: 100
 * ; total filament length [mm] : 1236.35
 * ; total filament weight [g] : 3.75
 * ; max_z_height: 20.00
 * ; layer_height = 0.2
 * ```
 *
 * 多色列印時用量欄位是「每一色一個值」，順序對應 `; filament:` 列出的耗材槽：
 *
 * ```
 * ; total filament length [mm] : 1563.48,1350.27,1834.46,9897.65
 * ; total filament weight [g] : 4.66,4.03,5.47,29.52
 * ; filament: 2,3,4,5
 * ```
 *
 * 每一色的值已含換色沖洗與擦料塔用量（與 GUI「切片結果」表的 Total 欄相同），
 * 所以合計就是整盤用量。只取第一個值會把四色盤的 43.68 g 報成 4.66 g。
 */

/** 解析 `1h 2m 3s` 這類時間片段。 */
export function parseDurationSeconds(text: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)\s*([hms])\b/g;
  let total = 0;
  let matched = false;

  for (const match of text.matchAll(pattern)) {
    const amount = Number.parseFloat(match[1] ?? '');
    const unit = match[2];
    if (!Number.isFinite(amount)) continue;
    matched = true;
    if (unit === 'h') total += amount * 3600;
    else if (unit === 'm') total += amount * 60;
    else total += amount;
  }

  return matched ? Math.round(total) : undefined;
}

function firstNumber(text: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (match === null) return undefined;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

/** 解析 `4.66,4.03,5.47` 這種逗號分隔的數列；任何一項不是數字就整個不採信。 */
function numberList(text: string): readonly number[] | undefined {
  const items = text.split(',').map((item) => item.trim());
  if (items.length === 0 || items.some((item) => !/^-?\d+(?:\.\d+)?$/.test(item))) return undefined;
  return items.map((item) => Number.parseFloat(item));
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum(values: readonly number[]): number {
  return roundHundredths(values.reduce((total, value) => total + value, 0));
}

type HeaderField = { readonly key: string; readonly value: string };

/**
 * 逐行拆出 `; key = value` 或 `; key : value`。
 *
 * 注意欄位名稱本身含有 `[mm]`、`[cm^3]` 這類方括號，所以不能用「切第一個非文字字元」，
 * 必須明確找 `=` 或 `:`。
 */
function parseHeaderLine(line: string): HeaderField | undefined {
  if (!line.startsWith(';')) return undefined;
  const body = line.slice(1).trim();
  const separator = body.search(/[=:]/);
  if (separator < 0) return undefined;
  return {
    key: body.slice(0, separator).trim().toLowerCase(),
    value: body.slice(separator + 1).trim(),
  };
}

export function parseGcodeStats(gcode: string): SliceStats | undefined {
  // 統計欄位集中在檔頭與檔尾；只取兩端，避免掃描數十 MB 的路徑本體。
  const head = gcode.slice(0, 64 * 1024);
  const tail = gcode.length > 128 * 1024 ? gcode.slice(gcode.length - 64 * 1024) : '';
  const lines = [...head.split('\n'), ...tail.split('\n')];

  let layerCount: number | undefined;
  let maxZHeight: number | undefined;
  let layerHeight: number | undefined;
  let modelPrintTimeSeconds: number | undefined;
  let totalEstimatedTimeSeconds: number | undefined;
  let filamentWeights: readonly number[] | undefined;
  let filamentLengths: readonly number[] | undefined;
  let filamentSlots: readonly number[] | undefined;

  for (const line of lines) {
    const field = parseHeaderLine(line);
    if (field === undefined) continue;
    const { key, value } = field;

    switch (key) {
      case 'total layer number':
        layerCount ??= firstNumber(value);
        break;
      case 'max_z_height':
        maxZHeight ??= firstNumber(value);
        break;
      case 'layer_height':
        layerHeight ??= firstNumber(value);
        break;
      case 'total filament weight [g]':
        filamentWeights ??= numberList(value);
        break;
      case 'total filament length [mm]':
        filamentLengths ??= numberList(value);
        break;
      case 'filament': {
        // 只收正整數清單：這是耗材槽編號，不是設定值。
        const slots = numberList(value);
        if (slots !== undefined && slots.every((slot) => Number.isInteger(slot) && slot > 0)) {
          filamentSlots ??= slots;
        }
        break;
      }
      case 'model printing time': {
        // 這一行同時塞了兩個時間：
        //   `8m 45s; total estimated time: 9m 5s`
        // 必須先以分號切開，否則兩段時間會被加在一起。
        const [printing, ...rest] = value.split(';');
        modelPrintTimeSeconds ??= parseDurationSeconds(printing ?? '');
        const trailing = rest.join(';');
        const colon = trailing.indexOf(':');
        if (colon >= 0) {
          totalEstimatedTimeSeconds ??= parseDurationSeconds(trailing.slice(colon + 1));
        }
        break;
      }
      case 'total estimated time':
        totalEstimatedTimeSeconds ??= parseDurationSeconds(value);
        break;
      default:
        break;
    }
  }

  if (layerCount === undefined || maxZHeight === undefined || layerHeight === undefined) {
    return undefined;
  }

  const filamentBreakdown = breakdown(filamentWeights, filamentLengths, filamentSlots);

  return {
    layerCount,
    maxZHeight,
    layerHeight,
    ...(modelPrintTimeSeconds === undefined ? {} : { modelPrintTimeSeconds }),
    ...(totalEstimatedTimeSeconds === undefined ? {} : { totalEstimatedTimeSeconds }),
    ...(filamentWeights === undefined ? {} : { filamentGrams: sum(filamentWeights) }),
    ...(filamentLengths === undefined ? {} : { filamentLengthMm: sum(filamentLengths) }),
    ...(filamentBreakdown === undefined ? {} : { filamentBreakdown }),
  };
}

/**
 * 多色時逐色列出用量。單色不回傳 —— 那只是把合計再講一次。
 * 槽位編號只在與用量欄位數量一致時才採用，對不上就不硬配。
 */
function breakdown(
  weights: readonly number[] | undefined,
  lengths: readonly number[] | undefined,
  slots: readonly number[] | undefined,
): readonly FilamentUsage[] | undefined {
  const count = Math.max(weights?.length ?? 0, lengths?.length ?? 0);
  if (count < 2) return undefined;
  const slotsMatch = slots?.length === count;

  return Array.from({ length: count }, (_, index) => {
    const slot = slotsMatch ? slots?.[index] : undefined;
    const grams = weights?.length === count ? weights[index] : undefined;
    const lengthMm = lengths?.length === count ? lengths[index] : undefined;
    return {
      ...(slot === undefined ? {} : { filament: slot }),
      ...(grams === undefined ? {} : { grams }),
      ...(lengthMm === undefined ? {} : { lengthMm }),
    };
  });
}

/** 把秒數轉成人類可讀字串，用於工具回覆的摘要句。 */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.round(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}
