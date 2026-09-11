import type { ParameterOverrides, PresetKind, PresetRecord, PresetValue } from '../contracts.js';
import { ownerOf } from '../parameters/catalog.js';
import { isKnownParameterKey } from '../parameters/known-keys.js';

/**
 * 決定每個覆寫參數要落到哪裡。
 *
 * 這是純函式，因為它是兩個真實 bug 的發生地：
 *
 * 1. 未知參數曾被當成 CLI flag 送出去。BambuStudio 遇到不認識的 flag 會讓**整次切片失敗**，
 *    所以一個手滑的參數名會毀掉一次完全正常的切片。現在直接丟棄並警告。
 * 2. 判斷歸屬時若只信 catalog，catalog 沒收錄的參數就會被誤送命令列。
 *    現在先看這個 key 實際存在於哪一份展平後的 preset，catalog 只是後備。
 */

export type OverrideRouting = {
  /** 依 preset 種類分好的覆寫，會被寫進展平後的暫存 JSON。 */
  readonly buckets: Readonly<Record<PresetKind, ParameterOverrides>>;
  /** 不屬於任何已載入 preset、但確實是有效參數，改由命令列送出。 */
  readonly commandLine: readonly string[];
  /** 完全無法辨識、已丟棄的參數。 */
  readonly dropped: readonly string[];
  readonly warnings: readonly string[];
};

export function routeOverrides(
  overrides: ParameterOverrides,
  resolved: Readonly<Record<PresetKind, PresetRecord>>,
): OverrideRouting {
  const buckets: Record<PresetKind, Record<string, PresetValue>> = {
    machine: {},
    process: {},
    filament: {},
  };
  const commandLine: string[] = [];
  const dropped: string[] = [];
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    // 先看它實際出現在哪一份 preset —— 這比 catalog 可靠，因為 catalog 只是精選。
    const owner =
      (['process', 'filament', 'machine'] as const).find((kind) => key in resolved[kind]) ??
      ownerOf(key);

    if (owner !== undefined) {
      buckets[owner][key] = value;
      continue;
    }

    if (!isKnownParameterKey(key)) {
      dropped.push(key);
      warnings.push(
        `${key} 不是 BambuStudio 的參數名稱，已略過（未送出）。請確認拼字；` +
          '把未知參數送給 CLI 會讓整次切片失敗，所以這裡選擇丟棄而不是嘗試。',
      );
      continue;
    }

    warnings.push(
      `${key} 不屬於任何已載入的 preset，改以命令列覆寫；切片後請看 overrideAudit 確認有沒有生效。`,
    );
    commandLine.push(`--${key.replaceAll('_', '-')}=${serialise(value)}`);
  }

  return { buckets, commandLine, dropped, warnings };
}

/**
 * 多噴頭參數是每個 extruder 一項的陣列，命令列以逗號串接。
 * `Array.isArray` 不會窄化 `readonly string[]`，所以用明確的型別判斷。
 */
function serialise(value: PresetValue): string {
  return typeof value === 'string' ? value : value.join(',');
}
