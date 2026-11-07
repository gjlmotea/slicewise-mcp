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

describe('goal table', () => {
  it('every goal states what it optimises for and what it trades away', () => {
    // There is no universally best setting. A goal that does not say what it sacrifices is misleading.
    for (const goal of listGoals()) {
      expect(goal.optimisesFor.length).toBeGreaterThan(0);
      expect(goal.tradesAway.length).toBeGreaterThan(0);
      expect(goal.moves.length).toBeGreaterThan(0);
    }
  });

  it('every adjustment has a rationale and a cost', () => {
    const bare = allMoves().filter(
      ({ move }) => move.rationale.length === 0 || move.cost.length === 0,
    );
    expect(bare).toEqual([]);
  });

  it('every adjustment points at a real BambuStudio parameter', () => {
    // BambuStudio silently ignores a misspelled parameter name, so the user thinks it was changed when it was not.
    const bogus = allMoves()
      .filter(({ move }) => !isKnownParameterKey(move.key))
      .map(({ goal, move }) => `${goal} -> ${move.key}`);
    expect(bogus).toEqual([]);
  });

  it('goal ids are unique', () => {
    const ids = listGoals().map((goal) => goal.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every concern has a label', () => {
    const used = new Set(allMoves().map(({ move }) => move.concern));
    for (const concern of used) {
      expect(CONCERN_LABELS[concern]).toBeTruthy();
    }
  });
});

describe('matchGoal', () => {
  it('matches how users actually phrase it in Chinese', () => {
    expect(matchGoal('不要印壞')?.id).toBe('safe');
    expect(matchGoal('慢慢印，高品質')?.id).toBe('safe');
    expect(matchGoal('避免翹起來')?.id).toBe('safe');
    expect(matchGoal('噴頭會撞到')?.id).toBe('safe');
    expect(matchGoal('趕時間，越快越好')?.id).toBe('fast');
    expect(matchGoal('這個要受力，不要斷')?.id).toBe('strong');
  });

  it('matches English', () => {
    expect(matchGoal('make it reliable, no fail')?.id).toBe('safe');
    expect(matchGoal('as fast as possible')?.id).toBe('fast');
  });

  it('returns undefined when nothing matches instead of guessing', () => {
    // Guessing the wrong goal costs more than guessing the wrong symptom — the whole set of parameters moves the opposite way.
    expect(matchGoal('這台機器的顏色不好看')).toBeUndefined(); // "this machine's colour looks bad"
    expect(matchGoal('今天天氣真好')).toBeUndefined(); // "nice weather today"
  });

  it('Chinese aliases are at least two characters so negations and unrelated words do not trigger them', () => {
    // Regression test: single-character aliases once made 勉強 ("reluctantly") match strong and
    // 不好看 ("looks bad") match surface.
    const short = listGoals().flatMap((goal) =>
      goal.aliases.filter((alias) => /[\u4e00-\u9fff]/.test(alias) && alias.length < 2)
        .map((alias) => `${goal.id}: ${alias}`),
    );
    expect(short).toEqual([]);
    expect(matchGoal('這件事我勉強可以接受')).toBeUndefined(); // "I can reluctantly accept this"
  });
});

describe('safe goal', () => {
  const safe = getGoal('safe')!;

  it('covers both the adhesion and the collision failure modes', () => {
    const concerns = new Set(safe.moves.map((move) => move.concern));
    expect(concerns.has('adhesion')).toBe(true);
    expect(concerns.has('collision')).toBe(true);
    expect(concerns.has('quality')).toBe(true);
  });

  it('the anti-collision set includes Z hop and overhang slowdown; avoiding printed walls is filed under surface quality', () => {
    const keys = safe.moves.filter((move) => move.concern === 'collision').map((move) => move.key);
    expect(keys).toContain('filament_z_hop');
    // Curling is the main cause of collisions, so overhang slowdown belongs to collision, not quality.
    expect(keys).toContain('enable_overhang_speed');
    // The documented purpose of reduce_crossing_wall is avoiding surface blobs; in a test on a bowl-shaped
    // part, enabling it raised unlifted outer-wall crossings from 0 to 10, so it can no longer be an
    // anti-collision recommendation.
    expect(keys).not.toContain('reduce_crossing_wall');
    const quality = safe.moves.filter((move) => move.concern === 'quality').map((move) => move.key);
    expect(quality).toContain('reduce_crossing_wall');
  });

  it('enum suggestions use the actual BambuStudio strings', () => {
    // These strings were checked against the PrintConfig.cpp source and real presets.
    const suggested = Object.fromEntries(
      [...safe.moves, ...safe.conditional].map((move) => [move.key, move.suggested]),
    );
    expect(suggested['filament_z_hop_types']).toBe('Spiral Lift');
    expect(suggested['brim_type']).toBe('outer_only');
    expect(suggested['draft_shield']).toBe('enabled');
    expect(suggested['initial_layer_speed']).toBe('20 mm/s');
    expect(suggested['initial_layer_infill_speed']).toBe('30 mm/s');
  });

  it('the surface goal uses the actual Bambu Studio value for Monotonic line', () => {
    const surface = getGoal('surface')!;
    expect(surface.moves.find((move) => move.key === 'top_surface_pattern')?.suggested).toBe(
      'monotonicline',
    );
  });

  it('points out what parameters cannot fix', () => {
    expect(safe.notAParameterProblem).toMatch(/clean the bed|orientation/);
  });

  it('the ABS note also warns that reducing cooling makes curling worse', () => {
    // This is a real conflict inside the safe goal: fighting warping wants the fan off, avoiding collisions wants it on.
    expect(safe.materialNotes?.['ABS']).toMatch(/curl|warp/);
  });
});

describe('applicableConditional', () => {
  const safe = getGoal('safe')!;

  it('adds nothing when there are no matching findings', () => {
    expect(applicableConditional(safe, [])).toEqual([]);
  });

  it('widens the brim when the footprint is too small', () => {
    const moves = applicableConditional(safe, ['small-footprint']);
    expect(moves.map((move) => move.key)).toEqual(['brim_width']);
    expect(moves[0]?.because).toMatch(/knock over/);
  });

  it('only suggests support for steep overhangs', () => {
    expect(applicableConditional(safe, ['steep-overhang']).map((m) => m.key)).toEqual([
      'enable_support',
    ]);
  });

  it('adds all of them when there are several findings', () => {
    const codes: readonly PrintabilityCode[] = ['small-footprint', 'tall-and-narrow', 'large-flat-area'];
    expect(applicableConditional(safe, codes)).toHaveLength(3);
  });

  it('unrelated findings do not trigger anything', () => {
    expect(applicableConditional(safe, ['non-manifold', 'degenerate-geometry'])).toEqual([]);
  });
});

describe('goals and the catalog', () => {
  it('the catalog covers most goal adjustments', () => {
    // 100% is not required — the catalog is curated, and goals can point into a wider key space.
    // But low coverage means the catalog needs filling in.
    const known = new Set(knownParameterKeys());
    const moves = allMoves();
    const covered = moves.filter(({ move }) => known.has(move.key)).length;
    expect(covered / moves.length).toBeGreaterThan(0.7);
  });
});
