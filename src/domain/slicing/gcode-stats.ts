import type { SliceStats } from '../contracts.js';

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
  let filamentGrams: number | undefined;
  let filamentLengthMm: number | undefined;

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
        filamentGrams ??= firstNumber(value);
        break;
      case 'total filament length [mm]':
        filamentLengthMm ??= firstNumber(value);
        break;
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

  return {
    layerCount,
    maxZHeight,
    layerHeight,
    ...(modelPrintTimeSeconds === undefined ? {} : { modelPrintTimeSeconds }),
    ...(totalEstimatedTimeSeconds === undefined ? {} : { totalEstimatedTimeSeconds }),
    ...(filamentGrams === undefined ? {} : { filamentGrams }),
    ...(filamentLengthMm === undefined ? {} : { filamentLengthMm }),
  };
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
