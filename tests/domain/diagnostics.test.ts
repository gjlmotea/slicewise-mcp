import { describe, expect, it } from 'vitest';

import { describeParameter, knownParameterKeys, rangeWarning } from '../../src/domain/parameters/catalog.js';
import {
  isKnownParameterKey,
  KNOWN_PARAMETER_KEYS,
  unknownParameterKeys,
} from '../../src/domain/parameters/known-keys.js';
import { getSymptom, listSymptoms, matchSymptoms } from '../../src/domain/parameters/diagnostics.js';

describe('matchSymptoms', () => {
  it('比對中文描述', () => {
    const matches = matchSymptoms('印出來底部一圈胖出來');
    expect(matches[0]?.symptom.id).toBe('elephant-foot');
  });

  it('比對英文描述', () => {
    const matches = matchSymptoms('corners are warping off the plate');
    expect(matches[0]?.symptom.id).toBe('warping');
  });

  it('命中越多關鍵詞排越前面', () => {
    const matches = matchSymptoms('牽絲 拉絲 到處都是毛絲');
    expect(matches[0]?.symptom.id).toBe('stringing');
    expect(matches[0]?.score).toBeGreaterThan(1);
  });

  it('比對不到時回空陣列，不做模糊猜測', () => {
    // 猜錯症狀會給出讓情況更糟的建議，所以寧可回空。
    expect(matchSymptoms('這台機器的顏色不好看')).toEqual([]);
  });
});

describe('症狀表', () => {
  it('每個症狀至少有一項處置建議', () => {
    for (const symptom of listSymptoms()) {
      expect(symptom.remedies.length).toBeGreaterThan(0);
    }
  });

  it('每一項建議都必須說明代價', () => {
    // 沒有免費的參數調整；不講代價的建議等於誤導。
    for (const symptom of listSymptoms()) {
      for (const remedy of symptom.remedies) {
        expect(remedy.cost.length).toBeGreaterThan(0);
        expect(remedy.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it('所有建議指向的參數都收錄在 catalog 裡', () => {
    // 一次列出所有缺口，不要一個一個修 —— 逐次失敗會讓補洞變成打地鼠。
    const known = new Set(knownParameterKeys());
    const missing = listSymptoms().flatMap((symptom) =>
      symptom.remedies
        .filter((remedy) => !known.has(remedy.key))
        .map((remedy) => `${symptom.id} -> ${remedy.key}`),
    );
    expect(missing).toEqual([]);
  });

  it('id 唯一', () => {
    const ids = listSymptoms().map((symptom) => symptom.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getSymptom 取得已知症狀', () => {
    expect(getSymptom('warping')?.label).toContain('翹邊');
    expect(getSymptom('不存在')).toBeUndefined();
  });
});

describe('參數 catalog', () => {
  it('每個參數都有升與降兩個方向的說明', () => {
    for (const key of knownParameterKeys()) {
      const spec = describeParameter(key);
      expect(spec?.raising.length).toBeGreaterThan(0);
      expect(spec?.lowering.length).toBeGreaterThan(0);
      expect(spec?.whatItDoes.length).toBeGreaterThan(0);
    }
  });

  it('catalog 收錄的每個 key 都真的存在於 BambuStudio', () => {
    // 參數名稱打錯時 BambuStudio 會靜默忽略，所以 catalog 本身必須先對得上真實 key 空間。
    const bogus = knownParameterKeys().filter((key) => !isKnownParameterKey(key));
    expect(bogus).toEqual([]);
  });

  it('related 指向的也必須是真實 key', () => {
    // related 是「順便看一下這幾個」，可以指向 catalog 沒收錄的參數
    // （catalog 是 568 個 key 裡的精選），但不能指向根本不存在的名稱。
    const bogus = knownParameterKeys().flatMap((key) =>
      (describeParameter(key)?.related ?? [])
        .filter((related) => !isKnownParameterKey(related))
        .map((related) => `${key} -> ${related}`),
    );
    expect(bogus).toEqual([]);
  });
});

describe('rangeWarning', () => {
  it('超出建議上限時附上調高的代價', () => {
    const warning = rangeWarning('layer_height', '0.5');
    expect(warning).toBeDefined();
    expect(warning).toMatch(/高於建議上限/);
  });

  it('低於建議下限時附上調低的代價', () => {
    expect(rangeWarning('nozzle_temperature', '120')).toMatch(/低於建議下限/);
  });

  it('落在區間內不警告', () => {
    expect(rangeWarning('layer_height', '0.2')).toBeUndefined();
  });

  it('處理帶百分號的值', () => {
    expect(rangeWarning('sparse_infill_density', '15%')).toBeUndefined();
    expect(rangeWarning('sparse_infill_density', '150%')).toMatch(/高於建議上限/);
  });

  it('catalog 沒收錄或非數值時不警告', () => {
    expect(rangeWarning('不存在的參數', '1')).toBeUndefined();
    expect(rangeWarning('brim_type', 'auto_brim')).toBeUndefined();
  });
});

describe('known-keys 基準', () => {
  it('涵蓋 BambuStudio 展平後的完整 key 空間', () => {
    expect(KNOWN_PARAMETER_KEYS.size).toBe(568);
  });

  it('抓出打錯的 key', () => {
    // BambuStudio 對不認識的 key 是靜默忽略，使用者會以為改了其實沒改。
    expect(isKnownParameterKey('layer_height')).toBe(true);
    expect(isKnownParameterKey('layer_hieght')).toBe(false);
    expect(unknownParameterKeys(['layer_height', 'sparse_infill_density', 'nope'])).toEqual(['nope']);
  });
});
