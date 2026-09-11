import type { PresetKind } from '../contracts.js';

/**
 * 參數知識層。
 *
 * BambuStudio 展平後有 550 個以上的設定 key，但把整份倒給模型只會得到亂調。
 * 這份 catalog 挑出真正會改變列印結果的參數，記錄它的語意、單位、合理範圍、
 * 調高與調低各自的代價，以及彼此的牽連關係。
 *
 * 每個 key 都對照過本機 BambuStudio 02.07.01.62 展平後的實際設定，
 * 不是憑印象寫的參數名。
 */

export type ParameterValueType = 'length-mm' | 'percentage' | 'temperature-c' | 'speed-mms' | 'angle-deg' | 'count' | 'boolean' | 'enum' | 'ratio';

export type ParameterSpec = {
  readonly key: string;
  /** 這個 key 歸哪一種 preset 管；寫使用者 preset 時必須放對檔案。 */
  readonly owner: PresetKind;
  readonly group: ParameterGroup;
  readonly label: string;
  readonly valueType: ParameterValueType;
  readonly unit?: string;
  /** 建議操作區間；超出通常代表你在解錯的問題。 */
  readonly typicalRange?: { readonly min: number; readonly max: number };
  readonly enumValues?: readonly string[];
  /** 這個參數在做什麼。 */
  readonly whatItDoes: string;
  /** 調高會怎樣。 */
  readonly raising: string;
  /** 調低會怎樣。 */
  readonly lowering: string;
  /** 一起看的參數。 */
  readonly related: readonly string[];
};

export type ParameterGroup =
  | 'quality'
  | 'strength'
  | 'speed'
  | 'adhesion'
  | 'support'
  | 'temperature'
  | 'cooling'
  | 'retraction'
  | 'accuracy'
  | 'surface';

const SPECS: readonly ParameterSpec[] = [
  // ── 品質與層 ───────────────────────────────────────────────────────────
  {
    key: 'layer_height',
    owner: 'process',
    group: 'quality',
    label: '層高',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.06, max: 0.32 },
    whatItDoes: '每一層的厚度，是列印時間與表面品質之間最強的單一槓桿。上限約為噴頭直徑的 75%。',
    raising: '層數變少、時間近乎線性下降，但階梯紋明顯、曲面變粗、層間結合面積增加所以 Z 向強度略升。',
    lowering: '曲面細緻、小特徵解析度變好，但時間大幅增加，且過薄時擠出量不穩定容易欠擠出。',
    related: ['initial_layer_print_height', 'line_width', 'layer_height'],
  },
  {
    key: 'initial_layer_print_height',
    owner: 'process',
    group: 'adhesion',
    label: '首層層高',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.1, max: 0.3 },
    whatItDoes: '第一層的厚度。厚一點可以吸收熱床不平與校平誤差，是首層不黏最先該動的參數之一。',
    raising: '對熱床不平容忍度變高、附著更穩，但首層尺寸精度變差、象腿風險上升。',
    lowering: '首層尺寸更準，但對校平誤差極度敏感，容易局部不黏。',
    related: ['initial_layer_line_width', 'initial_layer_flow_ratio', 'elefant_foot_compensation'],
  },
  {
    key: 'initial_layer_line_width',
    owner: 'process',
    group: 'adhesion',
    label: '首層線寬',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.3, max: 0.7 },
    whatItDoes: '第一層的擠出線寬。加寬能增加與熱床的接觸面積。',
    raising: '附著面積變大、首層更穩，但象腿與邊緣毛邊風險上升。',
    lowering: '首層輪廓更銳利，但附著力下降。',
    related: ['initial_layer_print_height', 'initial_layer_flow_ratio', 'line_width'],
  },
  {
    key: 'initial_layer_flow_ratio',
    owner: 'process',
    group: 'adhesion',
    label: '首層流量倍率',
    valueType: 'ratio',
    typicalRange: { min: 0.9, max: 1.1 },
    whatItDoes: '第一層的擠出倍率。略微過擠出可以把材料壓進板材紋理裡。',
    raising: '首層被壓實、附著明顯改善，過高會堆出毛邊並加重象腿。',
    lowering: '首層更平整，但容易出現線與線之間的縫隙而附著不良。',
    related: ['initial_layer_print_height', 'initial_layer_line_width', 'elefant_foot_compensation'],
  },
  {
    key: 'initial_layer_speed',
    owner: 'process',
    group: 'adhesion',
    label: '首層速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 100 },
    whatItDoes: '第一層的列印速度。慢速讓材料有時間熔接並攤平。',
    raising: '省時，但附著品質下降。',
    lowering: '附著明顯改善，只影響一層所以總時間代價很小。',
    related: ['initial_layer_infill_speed', 'initial_layer_flow_ratio', 'hot_plate_temp_initial_layer'],
  },
  {
    key: 'initial_layer_infill_speed',
    owner: 'process',
    group: 'adhesion',
    label: '首層填充速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 120 },
    whatItDoes: '第一層內部實心區的速度。外框即使已黏住，高速填充仍可能把小接觸面扯離熱床。',
    raising: '首層較快，但小零件與尖角更容易被拖動。',
    lowering: '首層附著更穩，代價只集中在第一層。',
    related: ['initial_layer_speed', 'initial_layer_flow_ratio'],
  },
  {
    key: 'line_width',
    owner: 'process',
    group: 'quality',
    label: '線寬',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.3, max: 0.65 },
    whatItDoes: '預設擠出線寬。通常設在噴頭直徑的 100%–125%。',
    raising: '流量增加、列印變快、層間黏合變好，但細節解析度下降。',
    lowering: '細節較好，但流量下降拖慢速度，過細時壁面容易有空隙。',
    related: ['inner_wall_line_width', 'initial_layer_line_width', 'layer_height'],
  },

  // ── 強度 ──────────────────────────────────────────────────────────────
  {
    key: 'wall_loops',
    owner: 'process',
    group: 'strength',
    label: '牆層數',
    valueType: 'count',
    typicalRange: { min: 2, max: 5 },
    whatItDoes: '每層的周壁圈數。對受力件而言，增加牆層比增加填充密度更有效率。',
    raising: '強度、尤其抗彎與螺絲咬合明顯提升，時間與耗材增加；孔洞內縮風險上升。',
    lowering: '省時省料，但薄壁件會變軟、易分層破裂。',
    related: ['sparse_infill_density', 'top_shell_layers', 'alternate_extra_wall'],
  },
  {
    key: 'sparse_infill_density',
    owner: 'process',
    group: 'strength',
    label: '填充密度',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: '內部填充佔比。超過約 40% 之後強度增益就開始不划算，該改動牆層數。',
    raising: '剛性與頂面支撐變好，但時間、耗材與翹曲內應力都上升。',
    lowering: '快且輕，但頂層容易塌陷（枕紋）、整體變軟。',
    related: ['sparse_infill_pattern', 'wall_loops', 'top_shell_layers'],
  },
  {
    key: 'sparse_infill_pattern',
    owner: 'process',
    group: 'strength',
    label: '填充圖樣',
    valueType: 'enum',
    enumValues: ['grid', 'gyroid', 'cubic', 'adaptivecubic', 'honeycomb', 'line', 'triangles', 'lightning', 'crosshatch'],
    whatItDoes: '填充的幾何結構，決定各向強度與列印速度。',
    raising: 'gyroid 各向同性且無自交、cubic 兼顧強度與速度、lightning 只撐頂面極省料。',
    lowering: 'grid 快但每層自交會撞噴頭、line 最弱。',
    related: ['sparse_infill_density', 'infill_direction'],
  },
  {
    key: 'top_shell_layers',
    owner: 'process',
    group: 'surface',
    label: '頂層層數',
    valueType: 'count',
    typicalRange: { min: 3, max: 8 },
    whatItDoes: '頂面實心層數。頂面有洞或凹陷時，先加這個而不是加填充。',
    raising: '頂面更平整密實，時間增加。',
    lowering: '省時，但低填充密度下頂面會塌出枕紋與孔洞。',
    related: ['sparse_infill_density', 'top_surface_pattern', 'bottom_shell_layers'],
  },
  {
    key: 'bottom_shell_layers',
    owner: 'process',
    group: 'surface',
    label: '底層層數',
    valueType: 'count',
    typicalRange: { min: 2, max: 6 },
    whatItDoes: '底面實心層數。',
    raising: '底面更密實、不透光，時間增加。',
    lowering: '省時，但底面可能出現孔隙。',
    related: ['top_shell_layers', 'initial_layer_print_height'],
  },

  // ── 附著與翹曲 ────────────────────────────────────────────────────────
  {
    key: 'brim_type',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim 類型',
    valueType: 'enum',
    enumValues: ['auto_brim', 'brim_ears', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'],
    whatItDoes: '在模型周圍加印裙邊以增加附著面積，是對抗翹邊與小底面脫落最直接的手段。',
    raising: 'outer_only／auto_brim 附著最穩；brim_ears 只在尖角加耳朵，省料又好拆。',
    lowering: 'no_brim 表面乾淨不用後處理，但高收縮材料或小底面容易翹起脫落。',
    related: ['brim_width', 'brim_object_gap', 'hot_plate_temp'],
  },
  {
    key: 'brim_width',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim 寬度',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 10 },
    whatItDoes: 'Brim 向外延伸的寬度。',
    raising: '抓地力提升，但耗材與拆除工作變多，且可能在表面留下痕跡。',
    lowering: '好拆，但抗翹能力下降。',
    related: ['brim_type', 'brim_object_gap'],
  },
  {
    key: 'brim_object_gap',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim 與模型間距',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.3 },
    whatItDoes: '控制 brim 與模型之間保留多少間距，直接影響抓地力與拆除難度。',
    raising: '更好拆、不易黏死活動間隙，但抓地力下降。',
    lowering: '抓得更牢，但可能難拆或在 print-in-place 間隙形成黏連。',
    related: ['brim_type', 'brim_width'],
  },
  {
    key: 'elefant_foot_compensation',
    owner: 'process',
    group: 'accuracy',
    label: '象腿補償',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.4 },
    whatItDoes: '把第一層向內縮，抵銷首層被壓扁而外擴的「象腿」。Bambu 原廠 preset 預設 0.15。',
    raising: '底部邊緣更接近設計尺寸，過大會讓首層附著面積變小而脫落。',
    lowering: '底緣外擴，配合面（例如插銷孔）會裝不進去。',
    related: ['initial_layer_print_height', 'xy_contour_compensation'],
  },
  {
    key: 'hot_plate_temp_initial_layer',
    owner: 'filament',
    group: 'temperature',
    label: '首層熱床溫度',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 0, max: 110 },
    whatItDoes: '第一層的熱床溫度。附著問題先動這個，再動機械手段。',
    raising: '附著力提升，但過高會讓底部軟化外擴、加重象腿。',
    lowering: '底面更銳利，但容易翹邊或整件脫落。',
    related: ['hot_plate_temp', 'brim_type', 'initial_layer_print_height'],
  },
  {
    key: 'draft_shield',
    owner: 'process',
    group: 'adhesion',
    label: '防風牆',
    valueType: 'enum',
    enumValues: ['disabled', 'limited', 'enabled'],
    whatItDoes: '在模型外圍加印一圈高牆隔絕氣流，抑制 ABS／ASA 這類高收縮材料的翹曲。',
    raising: '保溫效果好、翹曲大幅下降，但耗材與時間明顯增加。',
    lowering: '省料，開放式機型印高收縮材料時翹曲風險高。',
    related: ['brim_type', 'chamber_temperatures'],
  },

  // ── 溫度 ──────────────────────────────────────────────────────────────
  {
    key: 'nozzle_temperature',
    owner: 'filament',
    group: 'temperature',
    label: '噴頭溫度',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 170, max: 300 },
    whatItDoes: '主要列印溫度。同時影響層間結合強度、牽絲程度與表面光澤。',
    raising: '層間結合變強、流動性變好可以印更快，但牽絲、滲料與過熱下垂變嚴重。',
    lowering: '細節銳利、牽絲減少，但層裂風險上升，過低會欠擠出甚至堵頭。',
    related: ['nozzle_temperature_initial_layer', 'filament_retraction_length', 'fan_max_speed'],
  },
  {
    key: 'nozzle_temperature_initial_layer',
    owner: 'filament',
    group: 'temperature',
    label: '首層噴頭溫度',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 170, max: 300 },
    whatItDoes: '第一層的噴頭溫度，通常比主體高 5 °C 幫助熔接到熱床。',
    raising: '首層附著更好。',
    lowering: '首層附著變差。',
    related: ['nozzle_temperature', 'hot_plate_temp_initial_layer'],
  },

  // ── 冷卻 ──────────────────────────────────────────────────────────────
  {
    key: 'fan_max_speed',
    owner: 'filament',
    group: 'cooling',
    label: '最大風扇轉速',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: '模型冷卻風扇上限。PLA 幾乎全開，ABS／ASA 必須壓低否則層裂。',
    raising: '懸空與橋接更挺、細節更銳利，但層間結合變弱、高收縮材料翹曲加劇。',
    lowering: '層間結合變強、翹曲下降，但懸空會下垂、小件會過熱變形。',
    related: ['fan_min_speed', 'slow_down_layer_time', 'nozzle_temperature'],
  },
  {
    key: 'fan_min_speed',
    owner: 'filament',
    group: 'cooling',
    label: '最小風扇轉速',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: '一般列印時的風扇下限。',
    raising: '整體冷卻更強。',
    lowering: '層間結合更好。',
    related: ['fan_max_speed', 'slow_down_layer_time'],
  },
  {
    key: 'slow_down_layer_time',
    owner: 'filament',
    group: 'cooling',
    label: '單層最短時間',
    valueType: 'count',
    unit: 's',
    typicalRange: { min: 0, max: 30 },
    whatItDoes: '單層若快於這個秒數就自動減速，給前一層時間凝固。小尖端變形時最有效。',
    raising: '小截面不再過熱糊掉，但總時間增加。',
    lowering: '快，但小件頂端會軟塌。',
    related: ['fan_max_speed', 'outer_wall_speed'],
  },

  // ── 回抽與牽絲 ────────────────────────────────────────────────────────
  {
    key: 'filament_retraction_length',
    owner: 'filament',
    group: 'retraction',
    label: '回抽長度',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 2 },
    whatItDoes: '空跑前回抽的料量。直驅擠出機（Bambu 全系列）通常 0.4–1.0 mm 就夠。',
    raising: '牽絲與滲料減少，但過長會在噴頭內造成空洞導致下一段欠擠出，也增加堵頭風險。',
    lowering: '流量恢復快，但牽絲變多。',
    related: ['filament_retraction_speed', 'filament_z_hop', 'nozzle_temperature'],
  },
  {
    key: 'filament_retraction_speed',
    owner: 'filament',
    group: 'retraction',
    label: '回抽速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 15, max: 60 },
    whatItDoes: '回抽的速度。',
    raising: '斷料更乾脆、牽絲更少，但軟料（TPU）會被磨損甚至卡住。',
    lowering: '對軟料友善，牽絲增加。',
    related: ['filament_retraction_length', 'deretraction_speed'],
  },
  {
    key: 'filament_z_hop',
    owner: 'filament',
    group: 'retraction',
    label: 'Z 抬升',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 1 },
    whatItDoes: '空跑時抬起噴頭，避免刮到已列印表面或撞倒翹起的邊角。',
    raising: '表面刮痕與撞件風險下降，但每次抬降都增加時間，也可能多留下拉絲點。',
    lowering: '快，但噴頭可能刮傷頂面。',
    related: ['filament_retraction_length', 'reduce_crossing_wall'],
  },

  // ── 懸空與橋接 ────────────────────────────────────────────────────────
  {
    key: 'enable_overhang_speed',
    owner: 'process',
    group: 'quality',
    label: '懸空自動減速',
    valueType: 'boolean',
    whatItDoes: '依懸空程度分四段自動降速，讓擠出的線有時間被風扇固化。',
    raising: '懸空面品質大幅改善。',
    lowering: '快，但斜面下緣會捲翹起毛。',
    related: ['overhang_1_4_speed', 'enable_overhang_bridge_fan', 'fan_max_speed'],
  },
  {
    key: 'bridge_flow',
    owner: 'process',
    group: 'quality',
    label: '橋接流量',
    valueType: 'ratio',
    typicalRange: { min: 0.5, max: 1.2 },
    whatItDoes: '橋接段的擠出倍率。略低於 1 可以讓橋線被拉緊而不下垂。',
    raising: '橋線較粗實但容易下垂。',
    lowering: '橋線繃得更直，過低會斷線。',
    related: ['bridge_speed', 'enable_overhang_bridge_fan'],
  },
  {
    key: 'bridge_speed',
    owner: 'process',
    group: 'quality',
    label: '橋接速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 80 },
    whatItDoes: '跨空段的列印速度。',
    raising: '橋線被拉得更直，但過快會拉斷。',
    lowering: '下垂變嚴重。',
    related: ['bridge_flow', 'fan_max_speed'],
  },

  // ── 支撐 ──────────────────────────────────────────────────────────────
  {
    key: 'enable_support',
    owner: 'process',
    group: 'support',
    label: '啟用支撐',
    valueType: 'boolean',
    whatItDoes: '是否產生支撐結構。',
    raising: '陡峭懸空可印，但耗材、時間與後處理增加，接觸面會留疤。',
    lowering: '表面乾淨，但超過臨界角的懸空會失敗。',
    related: ['support_type', 'support_threshold_angle', 'support_top_z_distance'],
  },
  {
    key: 'support_type',
    owner: 'process',
    group: 'support',
    label: '支撐類型',
    valueType: 'enum',
    enumValues: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)', 'hybrid(auto)'],
    whatItDoes: 'normal 是柱狀網格，tree 是樹狀分支。',
    raising: 'tree 省料好拆、對有機造型友善；normal 對大片平坦懸空較穩。',
    lowering: 'tree 對大面積水平懸空支撐力不足。',
    related: ['enable_support', 'tree_support_branch_angle'],
  },
  {
    key: 'support_threshold_angle',
    owner: 'process',
    group: 'support',
    label: '支撐臨界角',
    valueType: 'angle-deg',
    unit: '°',
    typicalRange: { min: 20, max: 60 },
    whatItDoes: '超過這個角度（相對垂直）的懸空才加支撐。FDM 一般 45° 以內可自撐。',
    raising: '支撐變少、表面乾淨，但陡峭面可能垮掉。',
    lowering: '支撐變多、成功率高，但耗材與後處理增加。',
    related: ['enable_support', 'support_type'],
  },
  {
    key: 'support_top_z_distance',
    owner: 'process',
    group: 'support',
    label: '支撐頂部間隙',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.4 },
    whatItDoes: '支撐與模型之間的垂直留隙，直接決定好不好拆與表面留疤程度。',
    raising: '容易拆除，但懸空面下垂變明顯。',
    lowering: '支撐面更平整，但可能與模型熔在一起拆不下來。',
    related: ['enable_support', 'support_base_pattern'],
  },

  // ── 精度 ──────────────────────────────────────────────────────────────
  {
    key: 'xy_hole_compensation',
    owner: 'process',
    group: 'accuracy',
    label: '孔洞 XY 補償',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: -0.2, max: 0.3 },
    whatItDoes: '補償孔洞因擠出線內縮而印小的現象。正值把孔擴大。',
    raising: '孔變大，銷子與螺絲更好裝。',
    lowering: '孔變小。',
    related: ['xy_contour_compensation', 'elefant_foot_compensation'],
  },
  {
    key: 'xy_contour_compensation',
    owner: 'process',
    group: 'accuracy',
    label: '外輪廓 XY 補償',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: -0.3, max: 0.2 },
    whatItDoes: '整體外輪廓的尺寸補償。負值縮小外形。',
    raising: '外形變大。',
    lowering: '外形變小，配合件更好插入。',
    related: ['xy_hole_compensation', 'elefant_foot_compensation'],
  },
  {
    key: 'detect_thin_wall',
    owner: 'process',
    group: 'accuracy',
    label: '薄壁偵測',
    valueType: 'boolean',
    whatItDoes:
      '偵測窄於一條擠出線寬的區域，並嘗試用可變線寬把它補出來。Bambu 原廠預設是關的（0）。',
    raising:
      '開啟後模型上真正的薄片、刀刃邊緣不會缺料。代價是切片器會去填「它以為是薄壁」的窄縫 —— ' +
      '列印即組裝機構刻意留的間隙就是這種窄縫，一開就被填掉、零件焊死。',
    lowering: '關閉後窄於線寬的特徵直接略過不印，該留空的間隙會被留下來。',
    related: ['xy_contour_compensation', 'xy_hole_compensation', 'outer_wall_line_width'],
  },
  {
    key: 'precise_outer_wall',
    owner: 'process',
    group: 'accuracy',
    label: '精準外牆',
    valueType: 'boolean',
    whatItDoes:
      '調整外牆與內牆之間的間距，讓成品外形尺寸更接近模型標稱值，代價是牆之間可能出現細縫。',
    raising: '外形尺寸更準，配合件更好對。',
    lowering: '外形略大於標稱值，但牆與牆之間結合得更緊實。',
    related: ['xy_contour_compensation', 'outer_wall_line_width', 'wall_loops'],
  },
  {
    key: 'enable_prime_tower',
    owner: 'process',
    group: 'quality',
    label: '擦拭塔',
    valueType: 'boolean',
    whatItDoes:
      '多色／多材料列印時，在板面上另外印一座塔，每次換料先在塔上把舊料擠乾淨再回到模型。',
    raising:
      '換色乾淨，模型上不會出現前一個顏色的殘留，也不會有溢料掉進模型的縫隙裡。',
    lowering:
      '省時間與耗材，但殘料會吐在模型上。對列印即組裝的機構特別致命 —— ' +
      '一滴溢料掉進 0.1 mm 的齒縫就等於把它焊死。',
    related: ['prime_tower_width', 'flush_into_objects', 'flush_into_infill'],
  },
  {
    key: 'flush_into_objects',
    owner: 'process',
    group: 'quality',
    label: '沖刷進物件',
    valueType: 'boolean',
    whatItDoes:
      '把換色要沖掉的舊料擠進模型本體，取代擦拭塔。省料，但那些料會留在成品裡面。',
    raising: '耗材與時間下降。',
    lowering:
      '換色殘料不會進到模型內部，顏色界線乾淨。需要配合擦拭塔，否則料無處可去。',
    related: ['enable_prime_tower', 'flush_into_infill'],
  },
  {
    key: 'flush_into_infill',
    owner: 'process',
    group: 'quality',
    label: '沖刷進填充',
    valueType: 'boolean',
    whatItDoes: '把換色要沖掉的舊料擠進稀疏填充區域。比 flush_into_objects 溫和，只影響看不到的內部。',
    raising: '省下擦拭塔的耗材；填充區顏色會混雜，但外觀看不出來。',
    lowering: '填充保持單一材料，適合需要確定材料性質的結構件。',
    related: ['enable_prime_tower', 'flush_into_objects', 'sparse_infill_density'],
  },
  {
    key: 'precise_z_height',
    owner: 'process',
    group: 'accuracy',
    label: '精確 Z 高度',
    valueType: 'boolean',
    whatItDoes: '微調最後幾層的層高，讓成品總高精確等於模型高度。',
    raising: '總高精準，適合有配合關係的零件。',
    lowering: '總高會被層高整除誤差影響。',
    related: ['layer_height'],
  },
  {
    key: 'seam_position',
    owner: 'process',
    group: 'surface',
    label: '接縫位置',
    valueType: 'enum',
    enumValues: ['nearest', 'aligned', 'back', 'random'],
    whatItDoes: '每層起訖點的擺放策略，決定接縫痕跡的可見度。',
    raising: 'back 把縫藏到背面、aligned 排成一直線最不礙眼。',
    lowering: 'random 把縫打散成雜點，圓柱體上反而更明顯。',
    related: ['has_scarf_joint_seam', 'wall_loops'],
  },
  {
    key: 'has_scarf_joint_seam',
    owner: 'process',
    group: 'surface',
    label: '斜接縫',
    valueType: 'boolean',
    whatItDoes: '把接縫做成斜向漸變而不是垂直對接，大幅降低縫痕。',
    raising: '接縫幾乎看不見，稍微增加時間。',
    lowering: '接縫是傳統的一條垂直線。',
    related: ['seam_position'],
  },

  // ── 速度 ──────────────────────────────────────────────────────────────
  {
    key: 'outer_wall_speed',
    owner: 'process',
    group: 'speed',
    label: '外牆速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 30, max: 300 },
    whatItDoes: '外側可見牆面的速度，是表面品質最敏感的速度參數。',
    raising: '省時，但振紋、尺寸偏差與轉角瑕疵變明顯。',
    lowering: '表面明顯變好，總時間增加有限（外牆只佔一小部分路徑）。',
    related: ['inner_wall_speed', 'outer_wall_acceleration', 'default_acceleration'],
  },
  {
    key: 'reduce_crossing_wall',
    owner: 'process',
    group: 'speed',
    label: '避免跨越已印牆面',
    valueType: 'boolean',
    whatItDoes: '讓空跑路徑繞開已印牆面，減少刮痕與噴頭把小零件撞鬆的機率。',
    raising: '防撞與表面品質較好，但空跑路徑變長。',
    lowering: '路徑較短，但更容易跨牆擦撞。',
    related: ['outer_wall_speed', 'filament_z_hop'],
  },
  {
    key: 'sparse_infill_speed',
    owner: 'process',
    group: 'speed',
    label: '填充速度',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 50, max: 500 },
    whatItDoes: '內部填充速度，通常是總時間的主要來源，且不影響外觀。',
    raising: '省時效果最大，但受限於 filament_max_volumetric_speed，超過就會欠擠出。',
    lowering: '填充更紮實。',
    related: ['filament_max_volumetric_speed', 'sparse_infill_density'],
  },
  {
    key: 'default_acceleration',
    owner: 'process',
    group: 'speed',
    label: '預設加速度',
    valueType: 'count',
    unit: 'mm/s²',
    typicalRange: { min: 500, max: 20000 },
    whatItDoes: '整體加速度上限，決定小特徵能不能真的達到設定速度。',
    raising: '實際列印時間下降，但振紋（ringing）與噪音增加。',
    lowering: '表面更乾淨，時間拉長。',
    related: ['outer_wall_acceleration', 'initial_layer_acceleration'],
  },
  {
    key: 'filament_max_volumetric_speed',
    owner: 'filament',
    group: 'speed',
    label: '最大體積流量',
    valueType: 'count',
    unit: 'mm³/s',
    typicalRange: { min: 2, max: 32 },
    whatItDoes: '這捲料每秒最多能熔多少，是所有速度設定真正的天花板。',
    raising: '可以印更快，但超過熱端能力就會欠擠出、線變細甚至斷料。',
    lowering: '擠出穩定，但所有速度設定都會被壓下來。',
    related: ['sparse_infill_speed', 'nozzle_temperature'],
  },

  // ── 表面 ──────────────────────────────────────────────────────────────
  {
    key: 'ironing_type',
    owner: 'process',
    group: 'surface',
    label: '熨燙',
    valueType: 'enum',
    enumValues: ['no ironing', 'top', 'topmost', 'solid'],
    whatItDoes: '列印完頂面後再用噴頭低流量掃過一次抹平。',
    raising: '頂面接近光滑，但每個頂面都要多花不少時間。',
    lowering: '頂面看得到走線紋路。',
    related: ['ironing_flow', 'ironing_spacing', 'top_surface_pattern'],
  },
  {
    key: 'top_surface_pattern',
    owner: 'process',
    group: 'surface',
    label: '頂面圖樣',
    valueType: 'enum',
    enumValues: ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords'],
    whatItDoes: '頂面實心層的走線方式。',
    raising: 'monotonicline 讓相鄰線條維持一致方向與順序，反光一致、觀感最乾淨。',
    lowering: 'zig-zag 來回走會造成明暗交錯的紋路。',
    related: ['ironing_type', 'top_shell_layers'],
  },
  {
    key: 'fuzzy_skin',
    owner: 'process',
    group: 'surface',
    label: '絨面',
    valueType: 'enum',
    enumValues: ['none', 'external', 'all', 'allwalls'],
    whatItDoes: '在外牆加入隨機抖動做出磨砂質感，也能掩蓋層紋與接縫。',
    raising: '質感明顯、握感好，但尺寸精度下降。',
    lowering: '表面平滑但層紋可見。',
    related: ['seam_position'],
  },
];

const BY_KEY: ReadonlyMap<string, ParameterSpec> = new Map(SPECS.map((spec) => [spec.key, spec]));

export function listParameters(group?: ParameterGroup): readonly ParameterSpec[] {
  return group === undefined ? SPECS : SPECS.filter((spec) => spec.group === group);
}

export function describeParameter(key: string): ParameterSpec | undefined {
  return BY_KEY.get(key);
}

export function knownParameterKeys(): readonly string[] {
  return SPECS.map((spec) => spec.key);
}

/**
 * 判斷一個 key 該寫進哪一種 preset 檔。
 * catalog 沒收錄的 key 回傳 undefined —— 呼叫端必須靠展平後的實際 preset 內容判定，
 * 不可以亂猜，否則會把 filament 的 key 寫進 process 檔而被 CLI 靜默忽略。
 */
export function ownerOf(key: string): PresetKind | undefined {
  return BY_KEY.get(key)?.owner;
}

/**
 * 對照數值是否落在建議區間。超出不代表非法（使用者可能真的要做極端測試），
 * 但要明確回報，不能默默吞掉。
 */
export function rangeWarning(key: string, value: string): string | undefined {
  const spec = BY_KEY.get(key);
  if (spec?.typicalRange === undefined) return undefined;
  const numeric = Number.parseFloat(value.replace('%', ''));
  if (!Number.isFinite(numeric)) return undefined;
  const { min, max } = spec.typicalRange;
  if (numeric < min) {
    return `${key}=${value} 低於建議下限 ${min}${spec.unit ?? ''}：${spec.lowering}`;
  }
  if (numeric > max) {
    return `${key}=${value} 高於建議上限 ${max}${spec.unit ?? ''}：${spec.raising}`;
  }
  return undefined;
}
