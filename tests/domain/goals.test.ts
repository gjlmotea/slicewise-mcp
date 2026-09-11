import { describe, expect, it } from 'vitest';

import type { PrintabilityCode } from '../../src/domain/contracts.js';
import { knownParameterKeys } from '../../src/domain/parameters/catalog.js';
import {
  applicableConditional,
  CONCERN_LABELS,
  getGoal,
  listGoals,
  matchGoal,
} from '../../src/domain/parameters/goals.js';
import { isKnownParameterKey } from '../../src/domain/parameters/known-keys.js';

function allMoves() {
  return listGoals().flatMap((goal) =>
    [...goal.moves, ...goal.conditional].map((move) => ({ goal: goal.id, move })),
  );
}

describe('目標表', () => {
  it('每個目標都說明了優化什麼、犧牲什麼', () => {
    // 沒有普世最佳解。不講犧牲什麼的目標等於誤導。
    for (const goal of listGoals()) {
      expect(goal.optimisesFor.length).toBeGreaterThan(0);
      expect(goal.tradesAway.length).toBeGreaterThan(0);
      expect(goal.moves.length).toBeGreaterThan(0);
    }
  });

  it('每個調整都有原理與代價', () => {
    const bare = allMoves().filter(
      ({ move }) => move.rationale.length === 0 || move.cost.length === 0,
    );
    expect(bare).toEqual([]);
  });

  it('所有調整指向的都是真實 BambuStudio 參數', () => {
    // 參數名打錯 BambuStudio 會靜默忽略，使用者以為調了其實沒調。
    const bogus = allMoves()
      .filter(({ move }) => !isKnownParameterKey(move.key))
      .map(({ goal, move }) => `${goal} -> ${move.key}`);
    expect(bogus).toEqual([]);
  });

  it('goal id 唯一', () => {
    const ids = listGoals().map((goal) => goal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每個 concern 都有對應的中文標籤', () => {
    const used = new Set(allMoves().map(({ move }) => move.concern));
    for (const concern of used) {
      expect(CONCERN_LABELS[concern]).toBeTruthy();
    }
  });
});

describe('matchGoal', () => {
  it('比對得到使用者實際的講法', () => {
    expect(matchGoal('不要印壞')?.id).toBe('safe');
    expect(matchGoal('慢慢印，高品質')?.id).toBe('safe');
    expect(matchGoal('避免翹起來')?.id).toBe('safe');
    expect(matchGoal('噴頭會撞到')?.id).toBe('safe');
    expect(matchGoal('趕時間，越快越好')?.id).toBe('fast');
    expect(matchGoal('這個要受力，不要斷')?.id).toBe('strong');
  });

  it('比對得到英文', () => {
    expect(matchGoal('make it reliable, no fail')?.id).toBe('safe');
    expect(matchGoal('as fast as possible')?.id).toBe('fast');
  });

  it('比對不到時回 undefined，不猜', () => {
    // 目標猜錯的代價比症狀猜錯更大 —— 會把整組參數往反方向調。
    expect(matchGoal('這台機器的顏色不好看')).toBeUndefined();
    expect(matchGoal('今天天氣真好')).toBeUndefined();
  });

  it('alias 至少兩個字，避免被否定句與無關詞誤觸', () => {
    // 回歸測試：曾經用單字元 alias，「勉強」命中 strong、「不好看」命中 surface。
    const short = listGoals().flatMap((goal) =>
      goal.aliases.filter((alias) => /[\u4e00-\u9fff]/.test(alias) && alias.length < 2)
        .map((alias) => `${goal.id}: ${alias}`),
    );
    expect(short).toEqual([]);
    expect(matchGoal('這件事我勉強可以接受')).toBeUndefined();
  });
});

describe('safe 目標', () => {
  const safe = getGoal('safe')!;

  it('同時涵蓋附著與碰撞兩種失敗模式', () => {
    const concerns = new Set(safe.moves.map((move) => move.concern));
    expect(concerns.has('adhesion')).toBe(true);
    expect(concerns.has('collision')).toBe(true);
    expect(concerns.has('quality')).toBe(true);
  });

  it('防撞組包含 Z 抬升與繞開已印牆面', () => {
    const keys = safe.moves.filter((move) => move.concern === 'collision').map((move) => move.key);
    expect(keys).toContain('filament_z_hop');
    expect(keys).toContain('reduce_crossing_wall');
    // 捲翹是碰撞的主要起因，所以懸空降速歸在防撞而不是品質。
    expect(keys).toContain('enable_overhang_speed');
  });

  it('列舉型建議值使用 BambuStudio 的實際字串', () => {
    // 這些字串已對照原始碼 PrintConfig.cpp 與實際 preset 確認。
    const suggested = Object.fromEntries(
      [...safe.moves, ...safe.conditional].map((move) => [move.key, move.suggested]),
    );
    expect(suggested['filament_z_hop_types']).toBe('Spiral Lift');
    expect(suggested['brim_type']).toBe('outer_only');
    expect(suggested['draft_shield']).toBe('enabled');
    expect(suggested['initial_layer_speed']).toBe('20 mm/s');
    expect(suggested['initial_layer_infill_speed']).toBe('30 mm/s');
  });

  it('外觀目標使用 Bambu Studio 的 Monotonic line 實際值', () => {
    const surface = getGoal('surface')!;
    expect(surface.moves.find((move) => move.key === 'top_surface_pattern')?.suggested).toBe(
      'monotonicline',
    );
  });

  it('點出不是參數能解的部分', () => {
    expect(safe.notAParameterProblem).toMatch(/清乾淨|方向/);
  });

  it('ABS 註記同時提醒降低冷卻會加重捲翹', () => {
    // 這是 safe 目標內部真實存在的衝突：抗翹要關風扇，防撞要開風扇。
    expect(safe.materialNotes?.['ABS']).toMatch(/捲翹|翹/);
  });
});

describe('applicableConditional', () => {
  const safe = getGoal('safe')!;

  it('沒有對應發現時不追加任何調整', () => {
    expect(applicableConditional(safe, [])).toEqual([]);
  });

  it('底面積過小時加寬 brim', () => {
    const moves = applicableConditional(safe, ['small-footprint']);
    expect(moves.map((move) => move.key)).toEqual(['brim_width']);
    expect(moves[0]?.because).toMatch(/撞倒/);
  });

  it('陡峭懸空時才建議開支撐', () => {
    expect(applicableConditional(safe, ['steep-overhang']).map((m) => m.key)).toEqual([
      'enable_support',
    ]);
  });

  it('多個發現時全部追加', () => {
    const codes: readonly PrintabilityCode[] = ['small-footprint', 'tall-and-narrow', 'large-flat-area'];
    expect(applicableConditional(safe, codes)).toHaveLength(3);
  });

  it('不相干的發現不觸發', () => {
    expect(applicableConditional(safe, ['non-manifold', 'degenerate-geometry'])).toEqual([]);
  });
});

describe('目標與 catalog 的關係', () => {
  it('catalog 收錄的參數涵蓋大部分目標調整', () => {
    // 不要求百分之百 —— catalog 是精選，目標可以指向更廣的 key 空間。
    // 但涵蓋率太低代表 catalog 該補了。
    const known = new Set(knownParameterKeys());
    const moves = allMoves();
    const covered = moves.filter(({ move }) => known.has(move.key)).length;
    expect(covered / moves.length).toBeGreaterThan(0.7);
  });
});
