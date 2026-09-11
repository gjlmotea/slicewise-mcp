import { describeParameter } from './catalog.js';

/**
 * 症狀導向的參數診斷。
 *
 * 使用者不會說「請把 elefant_foot_compensation 調到 0.15」，會說「底部一圈胖出來」。
 * 這份表把可觀察的失敗現象對應到有序的處置建議：先試最有效、最低代價的，
 * 而不是一次把十個參數全動了讓人無法歸因。
 */

export type RemedyDirection = 'increase' | 'decrease' | 'set' | 'enable' | 'disable';

export type Remedy = {
  readonly key: string;
  readonly direction: RemedyDirection;
  /** 建議值；`set` 一定要給，其餘為建議落點。 */
  readonly suggested?: string;
  /** 為什麼這樣調。 */
  readonly rationale: string;
  /**
   * 這一步的代價。沒有免費的參數調整，把代價講出來使用者才能決定要不要接受。
   */
  readonly cost: string;
};

export type Symptom = {
  readonly id: string;
  readonly label: string;
  /** 用來比對自由文字輸入的關鍵詞，中英混合。 */
  readonly aliases: readonly string[];
  readonly mechanism: string;
  /** 依「先試這個」排序。 */
  readonly remedies: readonly Remedy[];
  /** 材料相關的補充。 */
  readonly materialNotes?: Readonly<Record<string, string>>;
  /** 這個症狀不是參數能解的部分。誠實講出來比硬給參數好。 */
  readonly notAParameterProblem?: string;
};

const SYMPTOMS: readonly Symptom[] = [
  {
    id: 'warping',
    label: '翹邊／邊角翹起',
    aliases: ['翹邊', '翹曲', '邊角翹', '捲邊', 'warp', 'warping', 'curling', 'lifting'],
    mechanism:
      '上層冷卻收縮時把已固化的下層往上拉。截面越大、材料收縮率越高、環境溫度越低就越嚴重。',
    remedies: [
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'increase',
        suggested: '+5 ~ +10 °C',
        rationale: '提高首層熱床溫度讓底層保持軟黏，抵抗上層的收縮拉力。',
        cost: '底部可能略微外擴，需要一併看象腿。',
      },
      {
        key: 'brim_type',
        direction: 'set',
        suggested: 'outer_only',
        rationale: '增加附著面積，用機械方式把邊角壓住。',
        cost: '需要後處理拆除，邊緣會留下痕跡。',
      },
      {
        key: 'brim_width',
        direction: 'increase',
        suggested: '5 ~ 8 mm',
        rationale: '翹曲力隨截面積上升，brim 要夠寬才拉得住。',
        cost: '耗材與拆除工作增加。',
      },
      {
        key: 'fan_max_speed',
        direction: 'decrease',
        suggested: 'ABS／ASA 降到 20% 以下',
        rationale: '減少強制冷卻造成的溫差梯度，這是收縮應力的來源。',
        cost: '懸空與小特徵品質下降。',
      },
      {
        key: 'draft_shield',
        direction: 'set',
        suggested: 'enabled',
        rationale: '開放式機型印高收縮材料時，隔絕氣流比調任何冷卻參數都有效。',
        cost: '耗材與時間明顯增加。',
      },
    ],
    materialNotes: {
      PLA: '收縮率低，翹邊通常是熱床髒污或校平問題，先清潔再調參數。',
      ABS: '收縮率高，必須關風扇並封閉腔體，參數只能補救不能根治。',
      ASA: '同 ABS。',
      PETG: '收縮中等，但過度附著反而會拉壞熱床表面，brim 適度即可。',
    },
    notAParameterProblem:
      '熱床有油污、PEI 板磨損、或熱床校平偏差，都會表現成翹邊。先用異丙醇清潔並確認校平，再動參數。',
  },
  {
    id: 'first-layer-adhesion',
    label: '首層不黏／局部缺料',
    aliases: ['首層', '第一層', '不黏', '沒黏住', '脫落', 'first layer', 'adhesion', 'not sticking'],
    mechanism: '噴頭與熱床距離過大、溫度不足，或擠出量不夠，導致線材沒有被壓進板材紋理。',
    remedies: [
      {
        key: 'initial_layer_print_height',
        direction: 'increase',
        suggested: '0.25 mm',
        rationale: '較厚的首層能吸收校平誤差與熱床不平。',
        cost: '首層尺寸精度下降。',
      },
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'increase',
        suggested: '+5 °C',
        rationale: '提高熔接性。',
        cost: '象腿風險上升。',
      },
      {
        key: 'initial_layer_flow_ratio',
        direction: 'increase',
        suggested: '1.02 ~ 1.05',
        rationale: '略微過擠出讓首層被壓實、填滿板材紋理。',
        cost: '過高會在首層堆出毛邊並加重象腿。',
      },
      {
        key: 'initial_layer_speed',
        direction: 'decrease',
        suggested: '30 ~ 50 mm/s',
        rationale: '慢速給材料時間熔接與攤平。',
        cost: '首層時間拉長。',
      },
    ],
    notAParameterProblem:
      '這個症狀最常見的成因是熱床髒污與校平。Bambu 的自動校平不會補償油污，先清潔板材。',
  },
  {
    id: 'elephant-foot',
    label: '象腿／底部外擴',
    // 使用者實際的講法是「底部一圈胖出來」而不是教科書名詞，
    // 所以 alias 要涵蓋口語片段，不能只放正式名稱。
    aliases: [
      '象腿',
      '底部一圈',
      '底部胖',
      '底部外擴',
      '底部凸',
      '第一層胖',
      '裙邊',
      'elephant foot',
      'elephant-foot',
    ],
    mechanism: '首層被噴頭壓扁且尚未凝固就承受上層重量，向外擠出形成裙邊。',
    remedies: [
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        suggested: '0.15 ~ 0.25 mm',
        rationale: '直接把首層輪廓向內縮，抵銷外擴量。',
        cost: '過大會讓首層附著面積變小而脫落。',
      },
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'decrease',
        suggested: '-5 °C',
        rationale: '降低底部軟化程度。',
        cost: '附著力下降，與翹邊是拉鋸關係。',
      },
      {
        key: 'initial_layer_print_height',
        direction: 'decrease',
        suggested: '0.2 mm',
        rationale: '減少被壓扁的量。',
        cost: '對校平誤差更敏感。',
      },
    ],
  },
  {
    id: 'stringing',
    label: '牽絲／拉絲',
    aliases: ['牽絲', '拉絲', '蜘蛛絲', '毛絲', 'string', 'stringing', 'oozing', 'wisp'],
    mechanism: '空跑時噴頭內的熔融材料因重力與殘壓滲出，在兩點之間拉成細絲。',
    remedies: [
      {
        key: 'nozzle_temperature',
        direction: 'decrease',
        suggested: '-5 ~ -10 °C',
        rationale: '降低流動性是抑制滲料最有效的單一手段。',
        cost: '層間結合變弱，過低會欠擠出。',
      },
      {
        key: 'filament_retraction_length',
        direction: 'increase',
        suggested: '直驅 0.8 ~ 1.2 mm',
        rationale: '把殘壓抽掉。',
        cost: '過長會造成下一段起始欠擠出。',
      },
      {
        key: 'filament_retraction_speed',
        direction: 'increase',
        suggested: '30 ~ 40 mm/s',
        rationale: '斷料更乾脆。',
        cost: 'TPU 等軟料會被磨損。',
      },
      {
        key: 'filament_z_hop',
        direction: 'increase',
        suggested: '0.2 ~ 0.4 mm',
        rationale: '讓噴頭離開表面，殘絲不會黏回模型。',
        cost: '時間增加，且可能在抬起點留下小尖點。',
      },
    ],
    materialNotes: {
      PETG: '天生易牽絲，回抽調整效果有限，優先降溫並確保料乾燥。',
      TPU: '不要加大回抽速度，改用降溫與降速處理。',
    },
    notAParameterProblem:
      '受潮的線材會在噴頭內汽化並噴出毛絲，任何回抽設定都救不了。先烘乾再談參數。',
  },
  {
    id: 'layer-delamination',
    label: '層裂／層間剝離',
    aliases: ['層裂', '分層', '剝離', '裂開', '層間', 'delamination', 'layer separation', 'cracking'],
    mechanism: '上下層熔接不足，界面強度低於材料本體，受力或收縮時沿層面裂開。',
    remedies: [
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+5 ~ +10 °C',
        rationale: '提高熔接深度，這是層間強度最直接的槓桿。',
        cost: '牽絲與懸空下垂變嚴重。',
      },
      {
        key: 'fan_max_speed',
        direction: 'decrease',
        suggested: 'ABS／ASA 0 ~ 20%',
        rationale: '過度冷卻讓上一層在新層貼上前就固化。',
        cost: '懸空品質下降。',
      },
      {
        key: 'line_width',
        direction: 'increase',
        suggested: '0.45 ~ 0.5 mm',
        rationale: '加大接觸面積。',
        cost: '細節解析度下降。',
      },
      {
        key: 'layer_height',
        direction: 'decrease',
        suggested: '0.16 ~ 0.2 mm',
        rationale: '薄層的相對熔接比例較高。',
        cost: '時間增加。',
      },
    ],
  },
  {
    id: 'overhang-droop',
    label: '懸空下垂／斜面起毛',
    aliases: ['懸空', '下垂', '垂下來', '斜面', '起毛', 'overhang', 'droop', 'sagging', 'curl'],
    mechanism: '懸空處下方無支撐，擠出的線在固化前因重力下沉並被噴頭拖動。',
    remedies: [
      {
        key: 'enable_overhang_speed',
        direction: 'enable',
        rationale: '依懸空程度自動分四段降速，讓風扇有時間固化。',
        cost: '時間增加，但只作用在懸空段。',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        suggested: 'PLA 100%',
        rationale: '快速固化是懸空品質的關鍵。',
        cost: 'ABS／ASA 會因此翹曲，需權衡。',
      },
      {
        key: 'slow_down_layer_time',
        direction: 'increase',
        suggested: '8 ~ 12 s',
        rationale: '小截面層要有足夠冷卻時間。',
        cost: '總時間增加。',
      },
      {
        key: 'support_threshold_angle',
        direction: 'decrease',
        suggested: '30°',
        rationale: '參數調到極限仍不行時，就該讓支撐介入。',
        cost: '耗材、時間與後處理增加，接觸面留疤。',
      },
    ],
    notAParameterProblem: '把模型轉個角度重新擺放，往往比任何參數都有效。先考慮擺放方向。',
  },
  {
    id: 'top-surface-holes',
    label: '頂面有洞／枕紋',
    aliases: ['頂面', '頂層', '有洞', '枕紋', '凹陷', 'pillowing', 'top surface', 'holes'],
    mechanism: '頂層實心層在稀疏填充上方跨距過大，來不及支撐就下沉。',
    remedies: [
      {
        key: 'top_shell_layers',
        direction: 'increase',
        suggested: '5 ~ 6',
        rationale: '多幾層才能把前一層的空隙逐步補平。',
        cost: '時間增加。',
      },
      {
        key: 'sparse_infill_density',
        direction: 'increase',
        suggested: '20 ~ 25%',
        rationale: '縮短頂層需要跨越的距離。',
        cost: '耗材與時間增加。',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        rationale: '頂層跨距本質上是短橋接，冷卻能讓它挺住。',
        cost: '高收縮材料要小心翹曲。',
      },
      {
        key: 'ironing_type',
        direction: 'set',
        suggested: 'top',
        rationale: '前面都做了還有輕微紋路時，用熨燙收尾。',
        cost: '每個頂面都要額外掃一遍，時間增加明顯。',
      },
    ],
  },
  {
    id: 'ringing',
    label: '振紋／鬼影',
    aliases: ['振紋', '鬼影', '波紋', '重影', 'ringing', 'ghosting', 'vibration', 'artifact'],
    mechanism: '機構在轉角急停急起時的慣性振動被複製到表面。',
    remedies: [
      {
        key: 'outer_wall_speed',
        direction: 'decrease',
        suggested: '-30%',
        rationale: '外牆是唯一看得到的路徑，降速代價最低。',
        cost: '總時間增加有限。',
      },
      {
        key: 'default_acceleration',
        direction: 'decrease',
        suggested: '-30%',
        rationale: '振紋的成因是加速度而不是速度本身。',
        cost: '所有路徑都變慢，時間增加明顯。',
      },
    ],
    notAParameterProblem:
      'Bambu 機型有輸入整形（input shaping）。皮帶張力、機器沒放平、或放在會晃的桌子上，都比參數更可能是主因。',
  },
  {
    id: 'dimensional-accuracy',
    label: '尺寸不準／孔太小裝不進去',
    aliases: ['尺寸', '不準', '孔太小', '裝不進', '公差', '配合', 'dimension', 'tolerance', 'hole', 'fit'],
    mechanism: '擠出線寬與轉角內縮讓內孔偏小、外形偏大，這是 FDM 的系統性偏差不是隨機誤差。',
    remedies: [
      {
        key: 'xy_hole_compensation',
        direction: 'increase',
        suggested: '0.1 ~ 0.2 mm',
        rationale: '只擴大孔洞，不動外形。',
        cost: '過大會讓配合變鬆。',
      },
      {
        key: 'xy_contour_compensation',
        direction: 'decrease',
        suggested: '-0.05 ~ -0.1 mm',
        rationale: '外形偏大時單獨縮小輪廓。',
        cost: '會同時影響所有外側特徵。',
      },
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        rationale: '底部幾層的外擴常被誤判成整體尺寸不準。',
        cost: '過大影響首層附著。',
      },
      {
        key: 'precise_z_height',
        direction: 'enable',
        rationale: '總高不是層高整數倍時會有誤差。',
        cost: '最後幾層層高不一致。',
      },
    ],
    notAParameterProblem:
      '先印一個尺寸校正塊量測實際偏差量，再決定補償值。沒有量測就調補償只是換一種猜。',
  },
  {
    id: 'under-extrusion',
    label: '欠擠出／線變細斷續',
    aliases: ['欠擠出', '缺料', '線太細', '斷斷續續', '有縫', 'under extrusion', 'underextrusion', 'gaps'],
    mechanism: '需求流量超過熱端熔化能力，或進料受阻。',
    remedies: [
      {
        key: 'filament_max_volumetric_speed',
        direction: 'decrease',
        suggested: 'PLA 12 ~ 15 mm³/s',
        rationale: '這是真正的天花板；速度設再高也只會欠擠出。',
        cost: '所有速度被壓低，時間增加。',
      },
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+10 °C',
        rationale: '提高熔化速率以支撐目標流量。',
        cost: '牽絲與懸空下垂變嚴重。',
      },
      {
        key: 'sparse_infill_speed',
        direction: 'decrease',
        rationale: '填充通常是流量需求的峰值來源。',
        cost: '時間增加。',
      },
    ],
    notAParameterProblem:
      '噴頭部分堵塞、擠出齒輪打滑、線材受潮或纏繞，都會表現成欠擠出。先看擠出機是否正常出料。',
  },
  {
    id: 'seam-visible',
    label: '接縫明顯',
    aliases: ['接縫', '縫', '疤', 'Z 縫', 'seam', 'z seam', 'blob'],
    mechanism: '每層起訖點的壓力變化在同一位置累積成一條可見的疤。',
    remedies: [
      {
        key: 'has_scarf_joint_seam',
        direction: 'enable',
        rationale: '斜接縫把起訖做成漸變，是目前最有效的手段。',
        cost: '略增時間。',
      },
      {
        key: 'seam_position',
        direction: 'set',
        suggested: 'back',
        rationale: '把縫統一藏到背面。',
        cost: '背面必須是不需要看的那面。',
      },
      {
        key: 'seam_position',
        direction: 'set',
        suggested: 'aligned',
        rationale: '排成一條直線，觀感上比隨機散點乾淨。',
        cost: '仍看得到一條線。',
      },
    ],
  },
  {
    id: 'support-removal',
    label: '支撐拆不下來／拆完留疤',
    aliases: ['支撐', '拆不掉', '難拆', '留疤', 'support', 'removal', 'scar'],
    mechanism: '支撐與模型的間隙太小導致熔接在一起，或太大導致懸空面下垂。',
    remedies: [
      {
        key: 'support_top_z_distance',
        direction: 'increase',
        suggested: '0.2 mm（等於一層）',
        rationale: '留出一層間隙讓支撐可以剝離。',
        cost: '接觸面會有輕微下垂紋路。',
      },
      {
        key: 'support_type',
        direction: 'set',
        suggested: 'tree(auto)',
        rationale: '樹狀支撐接觸點少、好拆，且省料。',
        cost: '大面積水平懸空的支撐力不足。',
      },
      {
        key: 'support_threshold_angle',
        direction: 'increase',
        suggested: '45 ~ 55°',
        rationale: '減少不必要的支撐，能自撐的地方就別加。',
        cost: '過大會讓真正需要支撐的地方失敗。',
      },
    ],
  },
  {
    id: 'print-too-slow',
    label: '列印太慢',
    aliases: ['太慢', '很慢', '時間太長', '加速', 'slow', 'too slow', 'faster', 'speed up'],
    mechanism: '時間主要由填充路徑長度、層數與流量上限決定，而不是由外牆速度決定。',
    remedies: [
      {
        key: 'layer_height',
        direction: 'increase',
        suggested: '0.24 ~ 0.28 mm',
        rationale: '層數近乎線性下降，是省時效果最大的單一參數。',
        cost: '曲面階梯紋明顯，小特徵解析度下降。',
      },
      {
        key: 'sparse_infill_density',
        direction: 'decrease',
        suggested: '10 ~ 15%',
        rationale: '填充通常佔總時間最大宗且不影響外觀。',
        cost: '剛性下降，頂面需要靠 top_shell_layers 補。',
      },
      {
        key: 'sparse_infill_pattern',
        direction: 'set',
        suggested: 'lightning',
        rationale: '只在頂面需要處長出支撐柱，省料省時最極端。',
        cost: '幾乎沒有結構強度，只適合外觀件。',
      },
      {
        key: 'filament_max_volumetric_speed',
        direction: 'increase',
        rationale: '所有速度設定都被這個值壓著，不放寬它調速度是白調。',
        cost: '超過熱端能力就會欠擠出，必須實測驗證。',
      },
    ],
  },
  {
    id: 'bridging-sag',
    label: '橋接下垂',
    aliases: ['橋接', '跨空', '架橋', '下垂', 'bridge', 'bridging', 'sag'],
    mechanism: '跨越空隙的線材在兩端固定前因重力下沉。',
    remedies: [
      {
        key: 'bridge_flow',
        direction: 'decrease',
        suggested: '0.9',
        rationale: '略微欠擠出讓線被拉緊而不是垂下。',
        cost: '過低會斷線。',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        suggested: '100%',
        rationale: '橋接段必須立即固化。',
        cost: '高收縮材料翹曲。',
      },
      {
        key: 'bridge_speed',
        direction: 'increase',
        suggested: '50 mm/s',
        rationale: '較快的橫越讓線被拉直。',
        cost: '過快會拉斷。',
      },
    ],
  },
  {
    id: 'print-in-place-fused',
    label: '列印即組裝的零件黏死／轉不動',
    aliases: [
      '黏死',
      '黏住',
      '轉不動',
      '卡死',
      '動不了',
      '不能轉',
      '融在一起',
      '熔在一起',
      '連在一起',
      '齒輪轉不動',
      '關節卡住',
      '鉸鏈打不開',
      '列印即組裝',
      '免組裝',
      'print in place',
      'print-in-place',
      'fused',
      'stuck',
      'seized',
      "won't spin",
      'not moving',
    ],
    mechanism:
      '相鄰零件之間的設計間隙小於印表機能解析的最小寬度。熔融的塑膠有寬度也會塌陷，' +
      '兩道相隔 0.1 mm 的外牆在還沒固化時就已經碰到彼此並焊住。' +
      '0.4 噴頭印 PLA 的實務下限大約是 0.15–0.20 mm；低於這個數字就是在賭。' +
      '首層還會再壞一次：被壓扁的第一層向外擴，把底部先黏起來。',
    remedies: [
      {
        key: 'xy_contour_compensation',
        direction: 'decrease',
        suggested: '-0.05 mm',
        rationale:
          '把所有實體外輪廓每側縮 0.05 mm。相對的兩個面各縮一次，間隙就長 0.10 mm。' +
          '這是唯一不用改模型就能加大間隙的辦法。',
        cost: '所有外形尺寸縮小 0.1 mm，齒厚變薄、背隙變大。玩具無所謂，配合件要留意。',
      },
      {
        key: 'xy_hole_compensation',
        direction: 'increase',
        suggested: '+0.05 mm',
        rationale:
          '被別的零件包住的那一側（例如內齒圈的內齒面、軸承的外圈內壁）在切片器眼中是「孔」，' +
          '不吃 xy_contour_compensation。只調外輪廓的話，這種介面的間隙只會長一半。',
        cost: '所有孔徑變大 0.1 mm；本來就緊配的銷孔會變鬆。',
      },
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        suggested: '0.20 ~ 0.25 mm',
        rationale:
          '首層被壓扁後向外擴，會在最底下那一兩層把零件先焊在一起 —— 上面印得再好都沒用。' +
          '象腿補償把首層往內縮，抵銷這個外擴。',
        cost: '首層附著面積略減。底面積小的模型要一併加 brim。',
      },
      {
        key: 'detect_thin_wall',
        direction: 'disable',
        rationale:
          '薄壁偵測會嘗試把窄於一條線寬的區域補出材料 —— 那正是你要留空的間隙。' +
          'Bambu 原廠預設是關的，但有些從別的切片器轉過來的 preset 會開著。',
        cost: '模型上真正的薄壁特徵可能缺料。',
      },
      {
        key: 'initial_layer_speed',
        direction: 'decrease',
        suggested: '30 mm/s',
        rationale: '首層慢一點，擠出量穩定，不會有多餘的材料被推進縫裡。只影響一層，代價很小。',
        cost: '首層時間增加，總量上可忽略。',
      },
      {
        key: 'enable_prime_tower',
        direction: 'enable',
        rationale:
          '多色列印時每次換料都會殘留舊料。沒有擦拭塔，那些料會吐在模型上；' +
          '掉進 0.1 mm 的齒縫裡就等於把機構焊死。',
        cost: '耗材與時間增加，需要額外的板面空間。',
      },
    ],
    materialNotes: {
      PLA: '剛性高、幾乎不收縮，間隙夠就會順。是列印即組裝機構最好處理的材料。',
      PETG: '層間黏性強、容易牽絲，同樣的間隙比 PLA 更容易黏死。建議再多讓 0.05 mm。',
      TPU: '軟，扳得開但轉起來會拖。列印即組裝的轉動機構不建議用。',
      ABS: '收縮率高，冷卻後間隙會變，而且變多少不容易預測。',
    },
    notAParameterProblem:
      '先量再調。用 bambu_measure_clearance 讀出設計間隙到底是多少 —— ' +
      '如果原始設計只留 0.05 mm，那不是參數能救的，補償再怎麼加也會把齒形吃掉。' +
      '那種情況要嘛整體放大列印（間隙等比例放大），要嘛換一個模型。' +
      '另外：拆件時不要硬扳。扳開的齒面是撕裂面，粗糙且不可逆，之後永遠不會順。',
  },
  {
    id: 'weak-part',
    label: '成品不夠強／容易斷',
    aliases: ['不夠強', '強度', '容易斷', '脆', '受力', 'weak', 'strength', 'break', 'brittle'],
    mechanism: 'FDM 件的弱軸永遠是 Z 向層間。強度來自牆層與層間熔接，不是填充密度。',
    remedies: [
      {
        key: 'wall_loops',
        direction: 'increase',
        suggested: '4 ~ 5',
        rationale: '增加牆層的強度／重量效率遠高於增加填充。',
        cost: '時間與耗材增加。',
      },
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+10 °C',
        rationale: '層間熔接是主要失效面。',
        cost: '牽絲與懸空品質下降。',
      },
      {
        key: 'sparse_infill_density',
        direction: 'increase',
        suggested: '30 ~ 40%',
        rationale: '前兩項做完後再考慮；超過 40% 效益遞減。',
        cost: '時間與耗材大幅增加。',
      },
      {
        key: 'sparse_infill_pattern',
        direction: 'set',
        suggested: 'cubic',
        rationale: '三維方向都有支撐，比 grid 各向均衡。',
        cost: '略慢於 grid。',
      },
    ],
    notAParameterProblem:
      '受力方向與列印方向的關係，比任何參數都重要。把零件轉成讓受力沿著 XY 而不是 Z，效果數倍於調參數。',
  },
];

const BY_ID: ReadonlyMap<string, Symptom> = new Map(SYMPTOMS.map((symptom) => [symptom.id, symptom]));

export function listSymptoms(): readonly Symptom[] {
  return SYMPTOMS;
}

export function getSymptom(id: string): Symptom | undefined {
  return BY_ID.get(id);
}

export type SymptomMatch = {
  readonly symptom: Symptom;
  /** 命中的關鍵詞數量，用於排序。 */
  readonly score: number;
  readonly matchedAliases: readonly string[];
};

/**
 * 以自由文字比對症狀。
 *
 * 刻意不做模糊比對或編輯距離：寧可回報「沒有把握」讓呼叫端改用 `listSymptoms`，
 * 也不要把「翹邊」誤判成「牽絲」然後給出一組會讓情況更糟的建議。
 */
export function matchSymptoms(text: string): readonly SymptomMatch[] {
  const haystack = text.toLowerCase();
  const matches: SymptomMatch[] = [];

  for (const symptom of SYMPTOMS) {
    const matched = symptom.aliases.filter((alias) => haystack.includes(alias.toLowerCase()));
    if (matched.length > 0) {
      matches.push({ symptom, score: matched.length, matchedAliases: matched });
    }
  }

  return matches.sort((a, b) => b.score - a.score || a.symptom.id.localeCompare(b.symptom.id));
}

/** 把處置建議展開成含參數說明的完整敘述，供工具回傳。 */
export function explainRemedy(remedy: Remedy): {
  readonly key: string;
  readonly direction: RemedyDirection;
  readonly suggested: string | undefined;
  readonly rationale: string;
  readonly cost: string;
  readonly parameterLabel: string | undefined;
  readonly parameterUnit: string | undefined;
  readonly typicalRange: { readonly min: number; readonly max: number } | undefined;
} {
  const spec = describeParameter(remedy.key);
  return {
    key: remedy.key,
    direction: remedy.direction,
    suggested: remedy.suggested,
    rationale: remedy.rationale,
    cost: remedy.cost,
    parameterLabel: spec?.label,
    parameterUnit: spec?.unit,
    typicalRange: spec?.typicalRange,
  };
}
