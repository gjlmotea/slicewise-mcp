import type { ParameterOverrides, PresetRecord, PresetValue } from '../contracts.js';

/**
 * 可以安全自動套用的 print-in-place 製程調整。
 *
 * 這裡刻意不碰熱床溫度、風扇與流量：它們屬於 filament preset，必須知道實際材料
 * （普通 PLA 與 Silk PLA 不能混用同一份未校正設定）。預設明確關閉全域 brim，因為
 * Bambu 的內建預設是 Auto Brim，可能黏死 print-in-place 的活動間隙；局部 Brim Ears
 * 必須在第一層預覽確認。
 */

export type OptimizationChange = {
  readonly key: string;
  readonly before: PresetValue | undefined;
  readonly after: PresetValue;
  readonly rationale: string;
};

export type PrintInPlaceOptimization = {
  readonly overrides: ParameterOverrides;
  readonly changes: readonly OptimizationChange[];
  readonly manualActions: readonly string[];
};

export function optimizePrintInPlace(
  effective: PresetRecord,
  preserved: ParameterOverrides = {},
  options: { readonly includeBrimEars?: boolean } = {},
): PrintInPlaceOptimization {
  const overrides: Record<string, PresetValue> = { ...preserved };
  const changes: OptimizationChange[] = [];

  const set = (key: string, after: PresetValue, rationale: string): void => {
    overrides[key] = after;
    if (!sameValue(effective[key], after)) {
      changes.push({ key, before: effective[key], after, rationale });
    }
  };

  set(
    'initial_layer_speed',
    valueLike(effective['initial_layer_speed'], '20'),
    '把首層外框降到 20 mm/s，增加小接觸面的熔接與壓實時間。',
  );
  set(
    'initial_layer_infill_speed',
    valueLike(effective['initial_layer_infill_speed'], '30'),
    '首層填充也限在 30 mm/s，避免外框黏住後被高速填充路徑再次扯鬆。',
  );
  set(
    'outer_wall_speed',
    capNumericValue(effective['outer_wall_speed'], 60),
    '外牆最多 60 mm/s，降低小零件晃動、噴頭擦撞與可見振紋。',
  );
  set(
    'enable_overhang_speed',
    valueLike(effective['enable_overhang_speed'], '1'),
    '維持懸空分段減速，讓邊緣定型後再印下一層，降低捲翹碰撞。',
  );
  set(
    'reduce_crossing_wall',
    valueLike(effective['reduce_crossing_wall'], '1'),
    '空跑繞開已印牆面，降低噴頭把小齒輪或滾輪帶離熱床的機率。',
  );
  set(
    'top_surface_pattern',
    'monotonicline',
    '固定使用 Bambu Studio 的 Monotonic line，避免 Hilbert Curve 類的規律腦紋。',
  );
  set('ironing_type', 'no ironing', '預設關閉熨燙，先排除它造成的頂面堆料與額外走線。');
  set('fuzzy_skin', 'none', '關閉絨面，避免把刻意的隨機表面誤認成列印瑕疵。');

  if (options.includeBrimEars === true) {
    set('brim_type', 'brim_ears', '只使用 Brim Ears，不以整圈 brim 填入活動零件間隙。');
    set('brim_width', '5', '5 mm 是兼顧抓地與拆除的保守起點。');
    set('brim_object_gap', '0.15', '保留 0.15 mm 間距，讓耳朵較容易拆除。');
  } else {
    set('brim_type', 'no_brim', '明確關閉 Bambu 預設的 Auto Brim，避免把免組裝活動間隙黏住。');
  }

  return {
    overrides,
    changes,
    manualActions: [
      options.includeBrimEars === true
        ? '切片後只看第一層，確認 Brim Ears 沒有跨過齒輪或活動零件間隙；有跨過就關閉並改用手動畫耳朵。'
        : '局部小零件仍不穩時，手動畫 3–5 mm Brim Ears；切片後只看第一層，確認沒有跨過齒輪或活動間隙。',
      '列印前用洗碗精與清水洗板、不要摸列印區，並確認 Studio 選到實際使用的熱床板。',
      '送印時開啟熱床調平與流量動態校正；金色若是 Silk PLA，請使用 Silk 材料 preset，不要和普通 PLA 共用未校正流量。',
    ],
  };
}

function valueLike(current: PresetValue | undefined, scalar: string): PresetValue {
  if (!Array.isArray(current)) return scalar;
  return current.map(() => scalar);
}

function capNumericValue(current: PresetValue | undefined, maximum: number): PresetValue {
  if (Array.isArray(current)) {
    return current.map((value) => capNumericString(value, maximum));
  }
  return capNumericString(typeof current === 'string' ? current : undefined, maximum);
}

function capNumericString(current: string | undefined, maximum: number): string {
  const numeric = current === undefined ? Number.NaN : Number.parseFloat(current);
  return Number.isFinite(numeric) ? String(Math.min(numeric, maximum)) : String(maximum);
}

function sameValue(left: PresetValue | undefined, right: PresetValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
