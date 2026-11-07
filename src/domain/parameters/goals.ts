import type { PrintabilityCode } from '../contracts.js';
import type { RemedyDirection } from './diagnostics.js';

/**
 * Goal-driven parameter planning.
 *
 * `diagnostics.ts` works **after the fact**: something printed badly, and we reason back from the
 * symptom to what should be changed. This module works **before the fact**: nothing has been
 * printed yet, the caller states what they want, and we lay out a set of adjustments from that.
 *
 * The two are kept apart on purpose because they think in opposite directions — diagnosis has to
 * converge on a single cause, while planning has to trade off goals that conflict with each other.
 * The same parameter can move in completely opposite directions under different goals: going fast
 * wants `fan_max_speed` left at full so layer times stay short, while keeping ABS from warping
 * wants it turned off.
 */

/** What an adjustment is fighting against. Output is grouped by this, which is far more useful than one long flat list of parameters. */
export type GoalConcern =
  | 'adhesion'
  | 'collision'
  | 'quality'
  | 'strength'
  | 'time'
  | 'material';

export const CONCERN_LABELS: Readonly<Record<GoalConcern, string>> = {
  adhesion: 'Adhesion and warping',
  collision: 'Nozzle collisions',
  quality: 'Surface quality',
  strength: 'Structural strength',
  time: 'Print time',
  material: 'Filament usage',
};

export type GoalMove = {
  readonly key: string;
  readonly direction: RemedyDirection;
  readonly suggested?: string;
  readonly concern: GoalConcern;
  readonly rationale: string;
  readonly cost: string;
};

/** An adjustment that is only added when the model geometry meets a condition. */
export type ConditionalMove = GoalMove & {
  readonly when: PrintabilityCode;
  readonly because: string;
};

export type PrintGoal = {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly optimisesFor: string;
  readonly tradesAway: string;
  /** Ordered by "do this first". */
  readonly moves: readonly GoalMove[];
  readonly conditional: readonly ConditionalMove[];
  readonly materialNotes?: Readonly<Record<string, string>>;
  readonly notAParameterProblem?: string;
};

const SAFE: PrintGoal = {
  id: 'safe',
  label: 'Safe, no failures',
  // Chinese aliases are always at least two characters. Single-character aliases (穩 "steady",
  // 快 "fast", 強 "strong") get triggered by negations and unrelated words — 勉強 ("reluctantly")
  // would match strong, and 顏色不好看 ("the colour looks bad") would match surface. Matching the
  // wrong goal means the whole set of parameters moves the wrong way, so a missed match is
  // preferable to a false one.
  aliases: [
    '不要失敗', '不要印壞', '避免印壞', '印壞', '印錯', '穩妥', '保守', '慢慢印',
    '慢一點', '不要翹', '翹起來', '撞到', '碰撞', '高品質',
    'safe', 'reliable', 'careful', 'no fail',
  ],
  optimisesFor:
    'Keep the chance of failure as low as possible: no warping, no detaching from the plate, ' +
    'no nozzle strikes on already-printed sections, and a consistent surface.',
  tradesAway: 'Time. These settings are noticeably slower than the stock preset and use slightly more filament.',
  moves: [
    // ── Nozzle collisions ─────────────────────────────────────────────
    // This is the most expensive failure mode: a strike usually scraps the whole part, and can
    // knock the nozzle out of alignment or send the part flying.
    {
      key: 'filament_z_hop',
      direction: 'increase',
      suggested: '0.4 mm',
      concern: 'collision',
      rationale:
        'Lifts the nozzle during travel so it does not drag across printed surfaces. If the surface ' +
        'has even a slight curl or a blob of leftover material, a nozzle that does not lift will hit it head-on.',
      cost: 'Every lift and drop adds time, and lift points occasionally leave a small pip.',
    },
    {
      key: 'filament_z_hop_types',
      direction: 'set',
      suggested: 'Spiral Lift',
      concern: 'collision',
      rationale:
        'Spiral lift rises while it moves, unlike Normal Lift, which goes straight up first and then ' +
        'travels — one fewer hard stop, and no thin strand pulled out on the spot. ' +
        'Valid values: Auto Lift / Normal Lift / Slope Lift / Spiral Lift.',
      cost: 'Almost none; the travel path is slightly longer.',
    },
    {
      key: 'enable_overhang_speed',
      direction: 'enable',
      concern: 'collision',
      rationale:
        'Overhangs that do not solidify in time curl upward, and the curled edge sits right in the ' +
        'nozzle path for the next layer — this is how collisions usually start. Slowing down in stages ' +
        'gives the fan time to set it in place.',
      cost: 'Overhang sections print slower.',
    },
    {
      key: 'slow_down_layer_time',
      direction: 'increase',
      suggested: '10 ~ 15 s',
      concern: 'collision',
      rationale:
        'If a small cross-section layer finishes too quickly, the next layer goes onto one that is ' +
        'still soft, and the accumulated deformation also ends up pushing into the nozzle. ' +
        'Forcing each layer to take at least this long gives it time to set.',
      cost: 'Tall thin parts or models with many tips get noticeably slower.',
    },

    // ── Adhesion and warping ──────────────────────────────────────────
    {
      key: 'brim_type',
      direction: 'set',
      suggested: 'outer_only',
      concern: 'adhesion',
      rationale:
        'Adds a skirt of material around the outside that mechanically holds the edges down. Warping ' +
        'force concentrates at the corners, and a brim is the most direct and effective counter. ' +
        'Valid values: auto_brim / brim_ears / outer_only / inner_only / outer_and_inner / no_brim.',
      cost: 'Has to be removed, and leaves marks on the edge.',
    },
    {
      key: 'brim_width',
      direction: 'increase',
      suggested: '5 mm',
      concern: 'adhesion',
      rationale: 'Warping force grows with footprint area; the brim has to be wide enough to hold it.',
      cost: 'More filament and more removal work.',
    },
    {
      key: 'hot_plate_temp_initial_layer',
      direction: 'increase',
      suggested: '+5 °C',
      concern: 'adhesion',
      rationale:
        'A slightly hotter bed for the first layer keeps the bottom soft and tacky, resisting the ' +
        'shrinkage pull as the upper layers cool.',
      cost: 'The bottom may spread slightly; check elephant\'s foot compensation alongside it.',
    },
    {
      key: 'initial_layer_speed',
      direction: 'decrease',
      suggested: '20 mm/s',
      concern: 'adhesion',
      rationale:
        'Laying the first layer down slowly gives the material time to fuse and press into the plate ' +
        'texture. It only affects one layer, so the time cost is small.',
      cost: 'First-layer time goes up; negligible over the whole print.',
    },
    {
      key: 'initial_layer_infill_speed',
      direction: 'decrease',
      suggested: '30 mm/s',
      concern: 'adhesion',
      rationale:
        'Even once the first-layer perimeters have stuck, high-speed infill can still tug parts with a ' +
        'small contact area loose; slow the infill down as well.',
      cost: 'Only adds first-layer time; negligible over the whole print.',
    },

    // ── Surface quality ───────────────────────────────────────────────
    {
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: 'lower to 60% of the current value',
      concern: 'quality',
      rationale:
        'The outer wall is the only visible path, so slowing it improves the surface most directly, ' +
        'and since it is only a small share of the total path, the time cost is far lower than slowing everything down.',
      cost: 'A small increase in time.',
    },
    {
      key: 'default_acceleration',
      direction: 'decrease',
      suggested: 'lower to 50% of the current value',
      concern: 'quality',
      rationale:
        'Ringing is caused by acceleration, not speed. Bambu stock presets often set it to 10000 mm/s²; ' +
        'halving it for reliability is still fast.',
      cost: 'Every path slows down; a clear increase in time.',
    },
    {
      key: 'has_scarf_joint_seam',
      direction: 'enable',
      concern: 'quality',
      rationale:
        'A scarf joint seam makes the start and end of each layer a gradual transition, so the seam is ' +
        'nearly invisible and there is one less spot prone to blobbing.',
      cost: 'Slightly more time.',
    },
    {
      key: 'reduce_crossing_wall',
      direction: 'enable',
      suggested: '1',
      concern: 'quality',
      rationale:
        'Routes travel moves around printed walls instead of across them, reducing surface blobs and ' +
        'scratches. Stock presets have it off by default (0).',
      cost:
        'Longer travel paths and more print time. Do not treat it as an anti-collision setting: ' +
        'Bambu\'s Auto Lift already lifts when crossing outer walls, and in a test on a bowl-shaped part, ' +
        'enabling it actually raised the number of unlifted outer-wall crossings from 0 to 10.',
    },
  ],

  conditional: [
    {
      when: 'small-footprint',
      because: 'Tall parts with a small footprint are the easiest for the nozzle to knock over mid-print.',
      key: 'brim_width',
      direction: 'increase',
      suggested: '8 ~ 10 mm',
      concern: 'adhesion',
      rationale:
        'When the contact area is too small, a wider brim has to make up the grip, or the whole part gets dragged away.',
      cost: 'Noticeably more removal work.',
    },
    {
      when: 'tall-and-narrow',
      because:
        'Tall thin parts wobble during fast moves, and the upper half is especially prone to accumulating error and pushing into the nozzle.',
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: 'lower to 40% of the current value',
      concern: 'collision',
      rationale: 'The wobble comes from the inertia of acceleration and deceleration; go one step lower than usual.',
      cost: 'A larger increase in time.',
    },
    {
      when: 'steep-overhang',
      because: 'Steep overhangs are where curling comes from, and a curled edge sits right in the nozzle path.',
      key: 'enable_support',
      direction: 'enable',
      concern: 'collision',
      rationale:
        'When parameters pushed to their limit still cannot hold the curl down, it is time for support. ' +
        'Try reorienting the part first, and only enable support if no orientation works.',
      cost: 'More filament, time and post-processing, and the contact surfaces will be scarred.',
    },
    {
      when: 'large-flat-area',
      because:
        'Shrinkage stress in a large flat bottom concentrates at the corners — the classic shape for warping.',
      key: 'draft_shield',
      direction: 'set',
      suggested: 'enabled',
      concern: 'adhesion',
      rationale:
        'Blocking airflow works better than tuning any cooling parameter, especially for high-shrinkage materials. ' +
        'Valid values: disabled / limited / enabled.',
      cost: 'Noticeably more filament and time.',
    },
  ],

  materialNotes: {
    PLA:
      'Low shrinkage; warping is usually a dirty bed or a levelling problem. Cooling can stay at full, ' +
      'which helps both overhangs and collision avoidance.',
    PETG:
      'Strings easily and bonds too strongly to the bed; a moderate brim is enough — too much adhesion ' +
      'can actually damage a PEI plate.',
    ABS: 'High shrinkage: fan_max_speed must be held below 20% and draft_shield enabled; ' +
      'but reducing cooling makes overhangs curl more easily, so strengthen the anti-collision set as well.',
    ASA: 'Same as ABS.',
    TPU: 'Do not raise retraction speed; flexible filament barely warps on its own, so focus on collision avoidance and slow speeds.',
  },

  notAParameterProblem:
    'The three most effective things are not parameters: clean the bed with isopropyl alcohol, ' +
    'rotate the model to an orientation where loads and overhangs both make sense, ' +
    'and stand by and watch while the first layer prints. Parameters can only lower the failure rate; they cannot replace these.',
};

const FAST: PrintGoal = {
  id: 'fast',
  label: 'Save time',
  aliases: ['省時', '趕時間', '越快越好', '快一點', '很快', 'fast', 'quick', 'speed'],
  optimisesFor: 'Total print time.',
  tradesAway: 'Surface quality and structural strength.',
  moves: [
    {
      key: 'layer_height',
      direction: 'increase',
      suggested: '0.28 mm (about 0.32 max on a 0.4 nozzle)',
      concern: 'time',
      rationale: 'Layer count drops almost linearly; this is the single parameter with the biggest time savings.',
      cost: 'Visible stair-stepping on curves, and lower resolution on small features.',
    },
    {
      key: 'sparse_infill_density',
      direction: 'decrease',
      suggested: '10%',
      concern: 'time',
      rationale: 'Infill is usually the largest share of total time, and it does not affect appearance.',
      cost: 'Lower stiffness; the top surface has to rely on top_shell_layers.',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'lightning',
      concern: 'time',
      rationale: 'Only grows support columns where the top surface needs them; the most extreme time and material saver.',
      cost: 'Almost no structural strength; only suitable for display parts.',
    },
    {
      key: 'filament_max_volumetric_speed',
      direction: 'increase',
      concern: 'time',
      rationale: 'Every speed setting is capped by this value; raising speeds without loosening it does nothing.',
      cost: 'Going past what the hotend can melt causes under-extrusion; it must be verified by testing.',
    },
  ],
  conditional: [],
  notAParameterProblem: 'Switching to a 0.6 nozzle saves far more time than any combination of parameters.',
};

const STRONG: PrintGoal = {
  id: 'strong',
  label: 'Load-bearing strength',
  aliases: [
    '強度', '受力', '結構件', '不要斷', '耐用', '承重',
    'strong', 'strength', 'functional', 'durable',
  ],
  optimisesFor: 'Mechanical strength, especially bending resistance and screw holding.',
  tradesAway: 'Time and filament.',
  moves: [
    {
      key: 'wall_loops',
      direction: 'increase',
      suggested: '4 ~ 5',
      concern: 'strength',
      rationale: 'Adding walls gives far better strength per gram than adding infill density.',
      cost: 'More time and filament.',
    },
    {
      key: 'nozzle_temperature',
      direction: 'increase',
      suggested: '+10 °C',
      concern: 'strength',
      rationale:
        'The weak axis of an FDM part is always the Z-direction layer bond; deeper fusion between layers is where strength really comes from.',
      cost: 'Worse stringing and more sagging on overhangs.',
    },
    {
      key: 'sparse_infill_density',
      direction: 'increase',
      suggested: '30 ~ 40%',
      concern: 'strength',
      rationale: 'Consider this only after the first two; returns diminish above 40%.',
      cost: 'Large increase in time and filament.',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'cubic',
      concern: 'strength',
      rationale: 'Supports in all three directions, more evenly balanced than grid.',
      cost: 'Slightly slower than grid.',
    },
  ],
  conditional: [],
  notAParameterProblem:
    'How the load direction relates to the print direction matters more than any parameter. Rotating ' +
    'the part so the load runs along XY rather than Z is several times more effective than tuning parameters.',
};

const SURFACE: PrintGoal = {
  id: 'surface',
  label: 'Surface finish',
  aliases: ['外觀', '光滑', '質感', '表面品質', '漂亮', 'surface', 'finish', 'smooth'],
  optimisesFor: 'Flatness and consistency of the visible surfaces.',
  tradesAway: 'Time.',
  moves: [
    {
      key: 'layer_height',
      direction: 'decrease',
      suggested: '0.12 ~ 0.16 mm',
      concern: 'quality',
      rationale: 'Stair-stepping on curves is determined directly by layer height.',
      cost: 'More layers; time rises almost linearly.',
    },
    {
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: 'lower to 50% of the current value',
      concern: 'quality',
      rationale: 'The outer wall is the only visible path; slowing it is the cheapest change with the most direct payoff.',
      cost: 'A small increase in time.',
    },
    {
      key: 'has_scarf_joint_seam',
      direction: 'enable',
      concern: 'quality',
      rationale: 'A scarf joint turns the seam into a gradual transition; currently the most effective way to hide the Z seam.',
      cost: 'Slightly more time.',
    },
    {
      key: 'top_surface_pattern',
      direction: 'set',
      suggested: 'monotonicline',
      concern: 'quality',
      rationale:
        'Bambu Studio\'s Monotonic line keeps adjacent lines in a consistent direction and order, giving the most even reflections.',
      cost: 'None.',
    },
    {
      key: 'ironing_type',
      direction: 'set',
      suggested: 'top',
      concern: 'quality',
      rationale: 'If lines are still visible after everything above, finish with ironing.',
      cost: 'Every top surface gets an extra pass; a clear increase in time.',
    },
  ],
  conditional: [],
};

const ECONOMICAL: PrintGoal = {
  id: 'economical',
  label: 'Save filament',
  aliases: [
    '省料', '省材料', '便宜', '輕量',
    'economical', 'cheap', 'save filament', 'lightweight',
  ],
  optimisesFor: 'Filament weight.',
  tradesAway: 'Strength.',
  moves: [
    {
      key: 'sparse_infill_density',
      direction: 'decrease',
      suggested: '8 ~ 10%',
      concern: 'material',
      rationale: 'Infill is the largest adjustable consumer of filament.',
      cost: 'Lower stiffness.',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'lightning',
      concern: 'material',
      rationale: 'Only grows material where it is needed to hold up the top surface.',
      cost: 'Almost no structural strength.',
    },
    {
      key: 'wall_loops',
      direction: 'decrease',
      suggested: '2',
      concern: 'material',
      rationale: 'Walls take up more volume than you would expect.',
      cost: 'A clear drop in strength; not suitable for load-bearing parts.',
    },
    {
      key: 'enable_support',
      direction: 'disable',
      concern: 'material',
      rationale: 'Support is pure waste material; if orientation can avoid it, avoid it.',
      cost: 'Steep overhangs will fail.',
    },
  ],
  conditional: [],
};

const GOALS: readonly PrintGoal[] = [SAFE, FAST, STRONG, SURFACE, ECONOMICAL];

const BY_ID: ReadonlyMap<string, PrintGoal> = new Map(GOALS.map((goal) => [goal.id, goal]));

export function listGoals(): readonly PrintGoal[] {
  return GOALS;
}

export function getGoal(id: string): PrintGoal | undefined {
  return BY_ID.get(id);
}

/**
 * Match a goal against free text.
 *
 * Like `matchSymptoms`, this refuses to guess on fuzzy input: if nothing matches it returns
 * nothing, and the caller picks from the list. Guessing the wrong goal costs more than guessing
 * the wrong symptom — the whole set of adjustments moves in the opposite direction.
 */
export function matchGoal(text: string): PrintGoal | undefined {
  const haystack = text.toLowerCase();
  let best: { goal: PrintGoal; hits: number } | undefined;

  for (const goal of GOALS) {
    const hits = goal.aliases.filter((alias) => haystack.includes(alias.toLowerCase())).length;
    if (hits > 0 && (best === undefined || hits > best.hits)) {
      best = { goal, hits };
    }
  }
  return best?.goal;
}

/** Pick the conditional adjustments to add, based on the model's printability findings. */
export function applicableConditional(
  goal: PrintGoal,
  findingCodes: readonly PrintabilityCode[],
): readonly ConditionalMove[] {
  const present = new Set(findingCodes);
  return goal.conditional.filter((move) => present.has(move.when));
}
