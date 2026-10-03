import type { PrintabilityCode } from '../contracts.js';
import type { RemedyDirection } from './diagnostics.js';

/**
 * 目標導向的參數規劃。
 *
 * `diagnostics.ts` 是**事後**的：東西印壞了，從現象回推該調什麼。
 * 這裡是**事前**的：還沒印，先講清楚你要什麼，據此排出一組調整。
 *
 * 兩者刻意分開，因為思路相反 —— 診斷要收斂到單一成因，規劃要在互相衝突的
 * 目標之間取捨。同一個參數在不同目標下的方向可能完全相反：
 * 求快要把 `fan_max_speed` 留著全開好讓層時間縮短，求 ABS 不翹卻要把它關掉。
 */

/** 這個調整是在對付什麼。輸出時依此分組，比一長串平鋪的參數清單有用得多。 */
export type GoalConcern =
  | 'adhesion'
  | 'collision'
  | 'quality'
  | 'strength'
  | 'time'
  | 'material';

export const CONCERN_LABELS: Readonly<Record<GoalConcern, string>> = {
  adhesion: '附著與翹曲',
  collision: '噴頭碰撞',
  quality: '表面品質',
  strength: '結構強度',
  time: '列印時間',
  material: '耗材用量',
};

export type GoalMove = {
  readonly key: string;
  readonly direction: RemedyDirection;
  readonly suggested?: string;
  readonly concern: GoalConcern;
  readonly rationale: string;
  readonly cost: string;
};

/** 只在模型幾何符合條件時才加入的調整。 */
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
  /** 依「先做這個」排序。 */
  readonly moves: readonly GoalMove[];
  readonly conditional: readonly ConditionalMove[];
  readonly materialNotes?: Readonly<Record<string, string>>;
  readonly notAParameterProblem?: string;
};

const SAFE: PrintGoal = {
  id: 'safe',
  label: '穩妥不失敗',
  // alias 一律至少兩個字。單字元（穩／快／強）會被否定句與無關詞誤觸 ——
  // 「勉強」會命中 strong、「顏色不好看」會命中 surface。目標比對錯的代價是
  // 整組參數往反方向調，所以寧可漏比對也不要誤比對。
  aliases: [
    '不要失敗', '不要印壞', '避免印壞', '印壞', '印錯', '穩妥', '保守', '慢慢印',
    '慢一點', '不要翹', '翹起來', '撞到', '碰撞', '高品質',
    'safe', 'reliable', 'careful', 'no fail',
  ],
  optimisesFor: '把失敗機率壓到最低：不翹邊、不脫落、噴頭不撞到已印的部分、表面穩定。',
  tradesAway: '時間。這組設定會比原廠 preset 慢上不少，而且耗材略增。',
  moves: [
    // ── 噴頭碰撞 ───────────────────────────────────────────────────────
    // 這是最貴的失敗模式：撞到通常整件報廢，還可能把噴頭撞歪或把件撞飛。
    {
      key: 'filament_z_hop',
      direction: 'increase',
      suggested: '0.4 mm',
      concern: 'collision',
      rationale:
        '空跑時抬起噴頭，讓它不會擦過已印表面。表面若有一點點捲翹或殘料，' +
        '沒抬升的噴頭就會直接撞上去。',
      cost: '每次抬降都增加時間，抬起點偶爾會留下小尖點。',
    },
    {
      key: 'filament_z_hop_types',
      direction: 'set',
      suggested: 'Spiral Lift',
      concern: 'collision',
      rationale:
        '螺旋抬升在移動中同時上升，不像 Normal Lift 先垂直抬再走 —— 少一次急停，' +
        '也不會在原地拉出細絲。合法值：Auto Lift／Normal Lift／Slope Lift／Spiral Lift。',
      cost: '幾乎沒有；路徑略長。',
    },
    {
      key: 'enable_overhang_speed',
      direction: 'enable',
      concern: 'collision',
      rationale:
        '懸空處來不及固化就會向上捲翹，捲起來的邊緣正好卡在下一層的噴頭路徑上 —— ' +
        '碰撞往往是這樣開始的。分段降速讓風扇有時間把它固定住。',
      cost: '懸空段變慢。',
    },
    {
      key: 'slow_down_layer_time',
      direction: 'increase',
      suggested: '10 ~ 15 s',
      concern: 'collision',
      rationale:
        '小截面層若太快完成，上一層還軟就疊上去，累積變形後同樣會頂到噴頭。' +
        '強制每層至少花這麼久，給它時間定型。',
      cost: '細高件或尖端多的模型會明顯變慢。',
    },

    // ── 附著與翹曲 ─────────────────────────────────────────────────────
    {
      key: 'brim_type',
      direction: 'set',
      suggested: 'outer_only',
      concern: 'adhesion',
      rationale:
        '在外圍加一圈裙邊，用機械方式把邊角壓住。翹曲力集中在四角，' +
        'brim 是最直接有效的對策。合法值：auto_brim／brim_ears／outer_only／inner_only／outer_and_inner／no_brim。',
      cost: '要拆除，邊緣會留下痕跡。',
    },
    {
      key: 'brim_width',
      direction: 'increase',
      suggested: '5 mm',
      concern: 'adhesion',
      rationale: '翹曲力隨底面積上升，brim 要夠寬才拉得住。',
      cost: '耗材與拆除工作增加。',
    },
    {
      key: 'hot_plate_temp_initial_layer',
      direction: 'increase',
      suggested: '+5 °C',
      concern: 'adhesion',
      rationale: '首層熱床溫度高一點讓底部保持軟黏，抵抗上層冷卻時的收縮拉力。',
      cost: '底部可能略微外擴，要一併看象腿補償。',
    },
    {
      key: 'initial_layer_speed',
      direction: 'decrease',
      suggested: '20 mm/s',
      concern: 'adhesion',
      rationale: '首層慢慢鋪，材料才有時間熔接並壓進板材紋理。只影響一層，時間代價很小。',
      cost: '首層時間增加，總量上可忽略。',
    },
    {
      key: 'initial_layer_infill_speed',
      direction: 'decrease',
      suggested: '30 mm/s',
      concern: 'adhesion',
      rationale: '首層外框黏住後，高速填充仍可能把小接觸面的零件扯鬆；填充也要一起降速。',
      cost: '只增加首層時間，總量上可忽略。',
    },

    // ── 表面品質 ───────────────────────────────────────────────────────
    {
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: '降到原值的 60%',
      concern: 'quality',
      rationale:
        '外牆是唯一看得見的路徑，降速對表面的改善最直接，而它只佔總路徑一小部分，' +
        '時間代價遠低於全面降速。',
      cost: '時間小幅增加。',
    },
    {
      key: 'default_acceleration',
      direction: 'decrease',
      suggested: '降到原值的 50%',
      concern: 'quality',
      rationale:
        '振紋的成因是加速度不是速度。Bambu 原廠常設到 10000 mm/s²，' +
        '追求穩定時砍半仍然很快。',
      cost: '所有路徑變慢，時間增加明顯。',
    },
    {
      key: 'has_scarf_joint_seam',
      direction: 'enable',
      concern: 'quality',
      rationale: '斜接縫把每層起訖做成漸變，接縫幾乎看不見，也少一個容易堆料凸起的點。',
      cost: '略增時間。',
    },
    {
      key: 'reduce_crossing_wall',
      direction: 'enable',
      suggested: '1',
      concern: 'quality',
      rationale:
        '讓空跑路徑繞開已印的牆，而不是從上面跨過去，減少表面料瘤與刮痕。原廠 preset 預設是關的（0）。',
      cost:
        '路徑變長，列印時間增加。別把它當防撞設定：Bambu 的 Auto Lift 跨外牆時本來就會抬升，' +
        '實測一個碗形件開啟後，未抬升的跨外牆空跑反而從 0 次變 10 次。',
    },
  ],

  conditional: [
    {
      when: 'small-footprint',
      because: '底面積小的高件在列印中最容易被噴頭撞倒。',
      key: 'brim_width',
      direction: 'increase',
      suggested: '8 ~ 10 mm',
      concern: 'adhesion',
      rationale: '接觸面不足時要靠更寬的 brim 補足抓地力，否則整件會被帶走。',
      cost: '拆除工作明顯增加。',
    },
    {
      when: 'tall-and-narrow',
      because: '細高件在高速移動時會晃動，上半部特別容易累積誤差並頂到噴頭。',
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: '降到原值的 40%',
      concern: 'collision',
      rationale: '晃動來自加減速的慣性；比一般情況再降一級。',
      cost: '時間增加較多。',
    },
    {
      when: 'steep-overhang',
      because: '陡峭懸空是捲翹的來源，而捲翹起來的邊緣正好卡在噴頭路徑上。',
      key: 'enable_support',
      direction: 'enable',
      concern: 'collision',
      rationale:
        '參數調到極限仍壓不住捲翹時，就該讓支撐介入。' +
        '先考慮換擺放方向，方向無解才開支撐。',
      cost: '耗材、時間與後處理增加，接觸面會留疤。',
    },
    {
      when: 'large-flat-area',
      because: '大面積底面的收縮應力集中在四角，是翹邊的典型形狀。',
      key: 'draft_shield',
      direction: 'set',
      suggested: 'enabled',
      concern: 'adhesion',
      rationale:
        '隔絕氣流比調任何冷卻參數都有效，高收縮材料尤其明顯。' +
        '合法值：disabled／limited／enabled。',
      cost: '耗材與時間明顯增加。',
    },
  ],

  materialNotes: {
    PLA: '收縮率低，翹邊多半是熱床髒污或校平問題。冷卻可以全開，對懸空與防撞都有利。',
    PETG: '易牽絲且對熱床附著過強，brim 適度即可，過度附著反而會傷 PEI 板。',
    ABS: '收縮率高，必須把 fan_max_speed 壓到 20% 以下並開 draft_shield；' +
      '但降低冷卻會讓懸空更容易捲翹，防撞那組要一併加強。',
    ASA: '同 ABS。',
    TPU: '不要加大回抽速度；軟料本身不太翹，重點放在防撞與慢速。',
  },

  notAParameterProblem:
    '最有效的三件事都不是參數：熱床用異丙醇清乾淨、把模型轉到讓受力與懸空都合理的方向、' +
    '以及第一層印的時候在旁邊看著。參數只能降低失敗率，不能取代這些。',
};

const FAST: PrintGoal = {
  id: 'fast',
  label: '省時',
  aliases: ['省時', '趕時間', '越快越好', '快一點', '很快', 'fast', 'quick', 'speed'],
  optimisesFor: '總列印時間。',
  tradesAway: '表面品質與結構強度。',
  moves: [
    {
      key: 'layer_height',
      direction: 'increase',
      suggested: '0.28 mm（0.4 噴頭上限約 0.32）',
      concern: 'time',
      rationale: '層數近乎線性下降，是省時效果最大的單一參數。',
      cost: '曲面階梯紋明顯，小特徵解析度下降。',
    },
    {
      key: 'sparse_infill_density',
      direction: 'decrease',
      suggested: '10%',
      concern: 'time',
      rationale: '填充通常佔總時間最大宗，而且不影響外觀。',
      cost: '剛性下降，頂面需要靠 top_shell_layers 補。',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'lightning',
      concern: 'time',
      rationale: '只在頂面需要處長出支撐柱，省時省料最極端。',
      cost: '幾乎沒有結構強度，只適合純外觀件。',
    },
    {
      key: 'filament_max_volumetric_speed',
      direction: 'increase',
      concern: 'time',
      rationale: '所有速度設定都被這個值壓著，不放寬它調速度是白調。',
      cost: '超過熱端能力就會欠擠出，必須實測驗證。',
    },
  ],
  conditional: [],
  notAParameterProblem: '換 0.6 噴頭的省時幅度遠大於任何參數組合。',
};

const STRONG: PrintGoal = {
  id: 'strong',
  label: '受力強度',
  aliases: ['強度', '受力', '結構件', '不要斷', '耐用', '承重', 'strong', 'strength', 'functional'],
  optimisesFor: '機械強度，尤其抗彎與螺絲咬合。',
  tradesAway: '時間與耗材。',
  moves: [
    {
      key: 'wall_loops',
      direction: 'increase',
      suggested: '4 ~ 5',
      concern: 'strength',
      rationale: '增加牆層的強度／重量效率遠高於增加填充密度。',
      cost: '時間與耗材增加。',
    },
    {
      key: 'nozzle_temperature',
      direction: 'increase',
      suggested: '+10 °C',
      concern: 'strength',
      rationale: 'FDM 件的弱軸永遠是 Z 向層間，提高熔接深度才是真正的強度來源。',
      cost: '牽絲與懸空下垂變嚴重。',
    },
    {
      key: 'sparse_infill_density',
      direction: 'increase',
      suggested: '30 ~ 40%',
      concern: 'strength',
      rationale: '前兩項做完後再考慮；超過 40% 效益遞減。',
      cost: '時間與耗材大幅增加。',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'cubic',
      concern: 'strength',
      rationale: '三維方向都有支撐，比 grid 各向均衡。',
      cost: '略慢於 grid。',
    },
  ],
  conditional: [],
  notAParameterProblem:
    '受力方向與列印方向的關係比任何參數都重要。把零件轉成讓受力沿著 XY 而不是 Z，效果數倍於調參數。',
};

const SURFACE: PrintGoal = {
  id: 'surface',
  label: '外觀表面',
  aliases: ['外觀', '光滑', '質感', '表面品質', '漂亮', 'surface', 'finish', 'smooth'],
  optimisesFor: '可見表面的平整度與一致性。',
  tradesAway: '時間。',
  moves: [
    {
      key: 'layer_height',
      direction: 'decrease',
      suggested: '0.12 ~ 0.16 mm',
      concern: 'quality',
      rationale: '曲面階梯紋直接由層高決定。',
      cost: '層數增加，時間近乎線性上升。',
    },
    {
      key: 'outer_wall_speed',
      direction: 'decrease',
      suggested: '降到原值的 50%',
      concern: 'quality',
      rationale: '外牆是唯一看得見的路徑，降速代價最低、回報最直接。',
      cost: '時間小幅增加。',
    },
    {
      key: 'has_scarf_joint_seam',
      direction: 'enable',
      concern: 'quality',
      rationale: '斜接縫把接縫做成漸變，是目前消除 Z 縫最有效的手段。',
      cost: '略增時間。',
    },
    {
      key: 'top_surface_pattern',
      direction: 'set',
      suggested: 'monotonicline',
      concern: 'quality',
      rationale: 'Bambu Studio 的 Monotonic line 讓相鄰線條維持一致方向與順序，反光最整齊。',
      cost: '無。',
    },
    {
      key: 'ironing_type',
      direction: 'set',
      suggested: 'top',
      concern: 'quality',
      rationale: '前面都做了還有紋路時，用熨燙收尾。',
      cost: '每個頂面都要多掃一遍，時間增加明顯。',
    },
  ],
  conditional: [],
};

const ECONOMICAL: PrintGoal = {
  id: 'economical',
  label: '省料',
  aliases: ['省料', '省材料', '便宜', '輕量', 'economical', 'cheap'],
  optimisesFor: '耗材重量。',
  tradesAway: '強度。',
  moves: [
    {
      key: 'sparse_infill_density',
      direction: 'decrease',
      suggested: '8 ~ 10%',
      concern: 'material',
      rationale: '填充是耗材最大的可調項。',
      cost: '剛性下降。',
    },
    {
      key: 'sparse_infill_pattern',
      direction: 'set',
      suggested: 'lightning',
      concern: 'material',
      rationale: '只在需要撐住頂面處長料。',
      cost: '幾乎無結構強度。',
    },
    {
      key: 'wall_loops',
      direction: 'decrease',
      suggested: '2',
      concern: 'material',
      rationale: '牆層佔的體積比想像中大。',
      cost: '強度下降明顯，不適合受力件。',
    },
    {
      key: 'enable_support',
      direction: 'disable',
      concern: 'material',
      rationale: '支撐是純浪費的材料；能靠擺放角度避掉就避掉。',
      cost: '陡峭懸空會失敗。',
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
 * 以自由文字比對目標。
 *
 * 與 `matchSymptoms` 同樣拒絕模糊猜測：比對不到就回空，讓呼叫端從清單裡挑。
 * 目標猜錯的代價比症狀猜錯更大 —— 會整組往反方向調。
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

/** 依模型的可列印性發現挑出該追加的條件式調整。 */
export function applicableConditional(
  goal: PrintGoal,
  findingCodes: readonly PrintabilityCode[],
): readonly ConditionalMove[] {
  const present = new Set(findingCodes);
  return goal.conditional.filter((move) => present.has(move.when));
}
