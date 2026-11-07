import { describeParameter } from './catalog.js';

/**
 * Symptom-driven parameter diagnosis.
 *
 * Users don't say "set elefant_foot_compensation to 0.15"; they say "the bottom bulges out all the way round".
 * This table maps observable failures to an ordered list of remedies: try the most effective, lowest-cost
 * change first, instead of changing ten parameters at once so that nobody can tell which one helped.
 */

export type RemedyDirection = 'increase' | 'decrease' | 'set' | 'enable' | 'disable';

export type Remedy = {
  readonly key: string;
  readonly direction: RemedyDirection;
  /** Suggested value; required for `set`, otherwise a suggested target. */
  readonly suggested?: string;
  /** Why this change helps. */
  readonly rationale: string;
  /**
   * What this step costs. No parameter change is free; stating the cost lets the user decide whether to accept it.
   */
  readonly cost: string;
};

export type Symptom = {
  readonly id: string;
  readonly label: string;
  /** Keywords used to match free-text input, in both Chinese and English. */
  readonly aliases: readonly string[];
  readonly mechanism: string;
  /** Ordered so that the remedy to try first comes first. */
  readonly remedies: readonly Remedy[];
  /** Material-specific notes. */
  readonly materialNotes?: Readonly<Record<string, string>>;
  /** The part of this symptom that parameters cannot fix. Saying so honestly beats forcing a parameter answer. */
  readonly notAParameterProblem?: string;
};

const SYMPTOMS: readonly Symptom[] = [
  {
    id: 'warping',
    label: 'Warping / corners lifting',
    aliases: [
      '翹邊',
      '翹曲',
      '邊角翹',
      '捲邊',
      'warp',
      'warping',
      'warped',
      'curling',
      'lifting',
      'corners lifting',
    ],
    mechanism:
      'As the upper layers cool they shrink and pull the already-solid layers below them upward. ' +
      'It gets worse with a larger cross-section, a higher-shrinkage material and colder surroundings.',
    remedies: [
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'increase',
        suggested: '+5 to +10 °C',
        rationale:
          'A hotter first-layer bed keeps the bottom layer soft and tacky so it resists the pull of the shrinking layers above.',
        cost: "The base may flare out slightly; check for elephant's foot at the same time.",
      },
      {
        key: 'brim_type',
        direction: 'set',
        suggested: 'outer_only',
        rationale: 'Adds contact area and holds the corners down mechanically.',
        cost: 'Has to be removed afterwards and leaves marks along the bottom edge.',
      },
      {
        key: 'brim_width',
        direction: 'increase',
        suggested: '5–8 mm',
        rationale: 'Warping force grows with the cross-section, so the brim has to be wide enough to hold.',
        cost: 'More filament and more removal work.',
      },
      {
        key: 'fan_max_speed',
        direction: 'decrease',
        suggested: 'Below 20% for ABS/ASA',
        rationale:
          'Less forced cooling means a smaller temperature gradient, and that gradient is where the shrinkage stress comes from.',
        cost: 'Overhangs and small features get worse.',
      },
      {
        key: 'draft_shield',
        direction: 'set',
        suggested: 'enabled',
        rationale:
          'On an open-frame printer running a high-shrinkage material, keeping drafts out does more than any cooling setting.',
        cost: 'Noticeably more filament and time.',
      },
    ],
    materialNotes: {
      PLA: 'Low shrinkage. Warping with PLA is usually a dirty plate or a levelling problem; clean the plate before changing parameters.',
      ABS: 'High shrinkage. Turn the part fan off and enclose the printer; parameters can only mitigate it, not cure it.',
      ASA: 'Same as ABS.',
      PETG: 'Moderate shrinkage, but too much adhesion can tear the plate surface when the part comes off; keep the brim modest.',
    },
    notAParameterProblem:
      'Grease on the plate, a worn PEI sheet or an off bed level all show up as warping. ' +
      'Clean the plate with isopropyl alcohol and check the levelling before changing parameters.',
  },
  {
    id: 'first-layer-adhesion',
    label: 'First layer not sticking / gaps in the first layer',
    aliases: [
      '首層',
      '第一層',
      '不黏',
      '沒黏住',
      '脫落',
      'first layer',
      'first-layer',
      'adhesion',
      'not sticking',
      "won't stick",
    ],
    mechanism:
      'The nozzle is too far from the plate, the temperature is too low, or too little material is extruded, ' +
      'so the line is not pressed into the plate texture.',
    remedies: [
      {
        key: 'initial_layer_print_height',
        direction: 'increase',
        suggested: '0.25 mm',
        rationale: 'A thicker first layer absorbs levelling error and an uneven plate.',
        cost: 'Lower dimensional accuracy on the first layer.',
      },
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'increase',
        suggested: '+5 °C',
        rationale: 'Improves bonding to the plate.',
        cost: "Higher risk of elephant's foot.",
      },
      {
        key: 'initial_layer_flow_ratio',
        direction: 'increase',
        suggested: '1.02–1.05',
        rationale: 'Slight over-extrusion presses the first layer down so it fills the plate texture.',
        cost: "Too much leaves ridges on the first layer and makes elephant's foot worse.",
      },
      {
        key: 'initial_layer_speed',
        direction: 'decrease',
        suggested: '30–50 mm/s',
        rationale: 'Going slower gives the material time to bond and spread out.',
        cost: 'The first layer takes longer.',
      },
    ],
    notAParameterProblem:
      'The most common causes of this symptom are a dirty plate and levelling. ' +
      "Bambu's automatic bed levelling does not compensate for grease; clean the plate first.",
  },
  {
    id: 'knocked-over',
    label: 'Knocked over / came off the plate mid-print',
    aliases: [
      '撞倒',
      '撞掉',
      '撞飛',
      '被撞',
      '脫床',
      '翻倒',
      '倒下',
      '被噴頭帶走',
      'knocked over',
      'knocked off',
      'knocked loose',
      'toppled',
      'fell over',
      'broke loose',
      'came off the bed',
      'came off the plate',
    ],
    mechanism:
      'If the first layers stuck fine and the part only fell partway through, the problem is usually leverage, ' +
      'not the first layer. When the nozzle hits the part high up, the tipping moment is "force × height", and ' +
      'the only thing resisting it is plate adhesion × "footprint radius". A part with a small base that is tall ' +
      'or wider at the top than at the bottom (bowls, cups, inverted cones, figurines) gains leverage with every ' +
      'layer. Real case: a bowl 31 mm tall and 38 mm wide at the top, standing on a 17 mm foot, had only about ' +
      '200 mm² of first layer on the plate.',
    remedies: [
      {
        key: 'brim_type',
        direction: 'set',
        suggested: 'outer_only',
        rationale:
          'Increases both the contact area and the footprint radius that resists tipping. Set it on that object only ' +
          '(the Objects settings in the GUI, or the object-level brim_type in the 3MF) so the other parts do not get ' +
          "brim marks. Bambu's stock auto_brim often decides not to add one.",
        cost: 'The brim has to be removed and leaves a mark along the bottom edge of the object.',
      },
      {
        key: 'brim_width',
        direction: 'increase',
        suggested: '8–10 mm',
        rationale:
          'A small base needs a wide brim to make a difference: adding 8 mm to the bowl above raised its first-layer ' +
          'contact from about 200 mm² to about 770 mm² (3.9×) and its footprint radius from 8.5 mm to about 16 mm.',
        cost: 'More filament and more removal work; brims that come too close to other objects fuse to them.',
      },
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'increase',
        suggested: '+5 °C',
        rationale:
          'A small contact patch relies entirely on adhesion, and a slightly hotter first-layer bed holds it better.',
        cost: "The base may flare out slightly; check for elephant's foot as well.",
      },
    ],
    materialNotes: {
      PLA: 'Low shrinkage, so a fall is usually down to leverage and adhesion, not warping.',
      ABS: 'The bottom edge lifts first and the nozzle then catches the lifted edge and knocks the part over; start with the warping remedies.',
      ASA: 'Same as ABS.',
    },
    notAParameterProblem:
      'Run bambu_check_printability first and look for small-footprint or tall-and-narrow; if another orientation ' +
      'puts a large face on the plate, change that first. Grease makes a small contact patch fail outright: wash a ' +
      'textured PEI plate with dish soap and water. Do not reach for reduce_crossing_wall first: Bambu\'s stock ' +
      'Auto Lift already lifts the nozzle on travel moves that cross outer walls, and on the bowl above, enabling ' +
      'it actually raised the number of un-lifted travel moves across outer walls from 0 to 10.',
  },
  {
    id: 'elephant-foot',
    label: "Elephant's foot / flared base",
    // Users actually say "the bottom bulges out all the way round" rather than the textbook term,
    // so the aliases have to cover colloquial fragments, not just the formal name.
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
      "elephant's foot",
      'flared base',
      'bulging base',
    ],
    mechanism:
      'The first layer is squashed by the nozzle and, before it has set, has to carry the weight of the layers ' +
      'above, so it squeezes outward into a lip.',
    remedies: [
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        suggested: '0.15–0.25 mm',
        rationale: 'Pulls the first-layer outline inward to cancel out the flare.',
        cost: 'Too much shrinks the first-layer contact area and the part can come loose.',
      },
      {
        key: 'hot_plate_temp_initial_layer',
        direction: 'decrease',
        suggested: '-5 °C',
        rationale: 'Keeps the bottom layers from softening as much.',
        cost: 'Less adhesion; this trades directly against warping.',
      },
      {
        key: 'initial_layer_print_height',
        direction: 'decrease',
        suggested: '0.2 mm',
        rationale: 'Less material gets squashed.',
        cost: 'More sensitive to levelling error.',
      },
    ],
  },
  {
    id: 'stringing',
    label: 'Stringing / oozing',
    aliases: ['牽絲', '拉絲', '蜘蛛絲', '毛絲', 'string', 'stringing', 'oozing', 'wisp', 'hairy'],
    mechanism:
      'During travel moves, molten material in the nozzle oozes out under gravity and residual pressure and is ' +
      'drawn into fine strings between two points.',
    remedies: [
      {
        key: 'nozzle_temperature',
        direction: 'decrease',
        suggested: '-5 to -10 °C',
        rationale: 'Making the melt less runny is the single most effective way to stop oozing.',
        cost: 'Weaker layer bonding; too low and it under-extrudes.',
      },
      {
        key: 'filament_retraction_length',
        direction: 'increase',
        suggested: 'Direct drive: 0.8–1.2 mm',
        rationale: 'Relieves the residual pressure in the nozzle.',
        cost: 'Too long causes under-extrusion at the start of the next line.',
      },
      {
        key: 'filament_retraction_speed',
        direction: 'increase',
        suggested: '30–40 mm/s',
        rationale: 'Gives a cleaner break in the filament.',
        cost: 'Soft filaments such as TPU get ground down by the extruder gears.',
      },
      {
        key: 'filament_z_hop',
        direction: 'increase',
        suggested: '0.2–0.4 mm',
        rationale: 'Lifts the nozzle off the surface so leftover strands are not dragged back onto the model.',
        cost: 'Adds time and can leave small blips where the nozzle lifts.',
      },
    ],
    materialNotes: {
      PETG: 'Strings by nature, and retraction tuning only helps so much; lower the temperature and make sure the filament is dry first.',
      TPU: 'Do not raise the retraction speed; lower the temperature and the speed instead.',
    },
    notAParameterProblem:
      'Wet filament boils in the nozzle and spits out fine hairs, and no retraction setting can fix that. ' +
      'Dry the filament before tuning anything.',
  },
  {
    id: 'layer-delamination',
    label: 'Layer splitting / delamination',
    aliases: [
      '層裂',
      '分層',
      '剝離',
      '裂開',
      '層間',
      'delamination',
      'layer separation',
      'cracking',
      'layer split',
      'layers separating',
    ],
    mechanism:
      'The layers have not fused well enough, so the interface is weaker than the material itself and the part ' +
      'splits along a layer under load or shrinkage.',
    remedies: [
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+5 to +10 °C',
        rationale: 'Fuses each layer more deeply into the one below; this is the most direct lever on layer strength.',
        cost: 'More stringing and more overhang droop.',
      },
      {
        key: 'fan_max_speed',
        direction: 'decrease',
        suggested: 'ABS/ASA: 0–20%',
        rationale: 'Over-cooling lets the previous layer set before the new layer lands on it.',
        cost: 'Overhangs get worse.',
      },
      {
        key: 'line_width',
        direction: 'increase',
        suggested: '0.45–0.5 mm',
        rationale: 'Increases the contact area between layers.',
        cost: 'Less fine detail.',
      },
      {
        key: 'layer_height',
        direction: 'decrease',
        suggested: '0.16–0.2 mm',
        rationale: 'Thinner layers have a larger fused fraction relative to their height.',
        cost: 'Longer print.',
      },
    ],
  },
  {
    id: 'overhang-droop',
    label: 'Overhang droop / rough sloped surfaces',
    aliases: ['懸空', '下垂', '垂下來', '斜面', '起毛', 'overhang', 'droop', 'sagging', 'curl'],
    mechanism:
      'Nothing supports the overhang from below, so the extruded line sinks under gravity before it sets and ' +
      'gets dragged by the nozzle.',
    remedies: [
      {
        key: 'enable_overhang_speed',
        direction: 'enable',
        rationale:
          'Slows down automatically in four steps according to how steep the overhang is, giving the fan time to set the plastic.',
        cost: 'Adds time, but only on overhang sections.',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        suggested: 'PLA: 100%',
        rationale: 'Fast solidification is the key to overhang quality.',
        cost: 'ABS/ASA will warp as a result; weigh the trade-off.',
      },
      {
        key: 'slow_down_layer_time',
        direction: 'increase',
        suggested: '8–12 s',
        rationale: 'Layers with a small cross-section need enough time to cool.',
        cost: 'Longer total print time.',
      },
      {
        key: 'support_threshold_angle',
        direction: 'decrease',
        suggested: '30°',
        rationale: 'When parameters pushed to their limits still are not enough, it is time to let supports take over.',
        cost: 'More filament, time and post-processing, and scars where the supports touched.',
      },
    ],
    notAParameterProblem:
      'Re-orienting the model is often more effective than any parameter. Consider the orientation first.',
  },
  {
    id: 'top-surface-holes',
    label: 'Holes in the top surface / pillowing',
    aliases: ['頂面', '頂層', '有洞', '枕紋', '凹陷', 'pillowing', 'top surface', 'top layer', 'holes'],
    mechanism:
      'The solid top layers have to span too far across the sparse infill and sag before there is anything to hold them up.',
    remedies: [
      {
        key: 'top_shell_layers',
        direction: 'increase',
        suggested: '5–6',
        rationale: 'Each extra layer closes more of the gaps left by the one below it.',
        cost: 'Longer print.',
      },
      {
        key: 'sparse_infill_density',
        direction: 'increase',
        suggested: '20–25%',
        rationale: 'Shortens the distance the top layers have to span.',
        cost: 'More filament and time.',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        rationale: 'Spanning the infill is essentially a series of short bridges, and cooling lets them hold.',
        cost: 'Watch for warping with high-shrinkage materials.',
      },
      {
        key: 'ironing_type',
        direction: 'set',
        suggested: 'top',
        rationale: 'If faint texture remains after the steps above, finish the surface with ironing.',
        cost: 'Every top surface gets an extra pass; noticeably longer print.',
      },
    ],
  },
  {
    id: 'ringing',
    label: 'Ringing / ghosting',
    aliases: ['振紋', '鬼影', '波紋', '重影', 'ringing', 'ghosting', 'vibration', 'artifact', 'echoing', 'ripples'],
    mechanism: 'Vibration from the motion system stopping and starting sharply at corners gets copied into the surface.',
    remedies: [
      {
        key: 'outer_wall_speed',
        direction: 'decrease',
        suggested: '-30%',
        rationale: 'The outer wall is the only path you can see, so slowing it down costs the least.',
        cost: 'Only a small increase in total print time.',
      },
      {
        key: 'default_acceleration',
        direction: 'decrease',
        suggested: '-30%',
        rationale: 'Ringing comes from acceleration, not from speed itself.',
        cost: 'Every path slows down; noticeably longer print.',
      },
    ],
    notAParameterProblem:
      'Bambu printers have input shaping. Loose belts, a printer that is not standing level or a wobbly table are ' +
      'more likely causes than any parameter.',
  },
  {
    id: 'dimensional-accuracy',
    label: 'Dimensions off / holes too small to fit',
    aliases: [
      '尺寸',
      '不準',
      '孔太小',
      '裝不進',
      '公差',
      '配合',
      'dimension',
      'tolerance',
      'hole',
      'fit',
      'too tight',
      'accuracy',
    ],
    mechanism:
      'Extrusion width and the inward pull at corners make holes come out small and outer shapes come out large. ' +
      'This is a systematic FDM bias, not random error.',
    remedies: [
      {
        key: 'xy_hole_compensation',
        direction: 'increase',
        suggested: '0.1–0.2 mm',
        rationale: 'Enlarges holes only, without touching outer shapes.',
        cost: 'Too much makes fits loose.',
      },
      {
        key: 'xy_contour_compensation',
        direction: 'decrease',
        suggested: '-0.05 to -0.1 mm',
        rationale: 'Shrinks only the outer contour when outer shapes come out large.',
        cost: 'Affects every outer feature at once.',
      },
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        rationale: 'Flare in the bottom few layers is often mistaken for an overall dimensional error.',
        cost: 'Too much hurts first-layer adhesion.',
      },
      {
        key: 'precise_z_height',
        direction: 'enable',
        rationale: 'The total height comes out wrong when it is not a whole multiple of the layer height.',
        cost: 'The last few layers end up with uneven heights.',
      },
    ],
    notAParameterProblem:
      'Print a calibration block and measure the actual error before choosing compensation values. ' +
      'Adjusting compensation without measuring is just a different way of guessing.',
  },
  {
    id: 'under-extrusion',
    label: 'Under-extrusion / thin or broken lines',
    aliases: [
      '欠擠出',
      '缺料',
      '線太細',
      '斷斷續續',
      '有縫',
      'under extrusion',
      'underextrusion',
      'under-extrusion',
      'under-extruding',
      'gaps',
    ],
    mechanism: 'The requested flow exceeds what the hotend can melt, or the filament feed is obstructed.',
    remedies: [
      {
        key: 'filament_max_volumetric_speed',
        direction: 'decrease',
        suggested: 'PLA: 12–15 mm³/s',
        rationale: 'This is the real ceiling; setting speeds higher than it allows only produces under-extrusion.',
        cost: 'Every speed gets capped lower, so the print takes longer.',
      },
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+10 °C',
        rationale: 'Raises the melt rate so the hotend can keep up with the target flow.',
        cost: 'More stringing and more overhang droop.',
      },
      {
        key: 'sparse_infill_speed',
        direction: 'decrease',
        rationale: 'Infill is usually where the peak flow demand comes from.',
        cost: 'Longer print.',
      },
    ],
    notAParameterProblem:
      'A partly clogged nozzle, slipping extruder gears, and wet or tangled filament all look like under-extrusion. ' +
      'Check that the extruder is feeding properly first.',
  },
  {
    id: 'seam-visible',
    label: 'Visible seam',
    aliases: ['接縫', '縫', '疤', 'Z 縫', 'seam', 'z seam', 'z-seam', 'blob', 'zits'],
    mechanism:
      'The pressure change where each layer starts and ends builds up at the same spot into a visible scar.',
    remedies: [
      {
        key: 'has_scarf_joint_seam',
        direction: 'enable',
        rationale: 'A scarf seam ramps the start and end in gradually; it is currently the most effective option.',
        cost: 'Slightly longer print.',
      },
      {
        key: 'seam_position',
        direction: 'set',
        suggested: 'back',
        rationale: 'Hides the seam on the back of the part.',
        cost: 'The back has to be a side nobody needs to look at.',
      },
      {
        key: 'seam_position',
        direction: 'set',
        suggested: 'aligned',
        rationale: 'Lines the seam up into one straight line, which looks cleaner than randomly scattered spots.',
        cost: 'One line is still visible.',
      },
    ],
  },
  {
    id: 'support-removal',
    label: "Supports won't come off / leave scars",
    aliases: ['支撐', '拆不掉', '難拆', '留疤', 'support', 'removal', 'scar', 'hard to remove'],
    mechanism:
      'The gap between support and model is too small, so they fuse together, or too large, so the supported surface droops.',
    remedies: [
      {
        key: 'support_top_z_distance',
        direction: 'increase',
        suggested: '0.2 mm (one layer)',
        rationale: 'Leaves a one-layer gap so the support can be peeled off.',
        cost: 'Faint droop marks on the supported surface.',
      },
      {
        key: 'support_type',
        direction: 'set',
        suggested: 'tree(auto)',
        rationale: 'Tree supports have fewer contact points, come off easily and use less filament.',
        cost: 'Not enough holding power under large flat horizontal overhangs.',
      },
      {
        key: 'support_threshold_angle',
        direction: 'increase',
        suggested: '45–55°',
        rationale: 'Cuts out unnecessary supports; where the model can hold itself up, leave them out.',
        cost: 'Too high and the areas that really need support fail.',
      },
    ],
  },
  {
    id: 'print-too-slow',
    label: 'Print takes too long',
    aliases: [
      '太慢',
      '很慢',
      '時間太長',
      '加速',
      'slow',
      'too slow',
      'faster',
      'speed up',
      'takes too long',
      'print time',
    ],
    mechanism:
      'Print time is driven mainly by infill path length, layer count and the flow ceiling, not by outer wall speed.',
    remedies: [
      {
        key: 'layer_height',
        direction: 'increase',
        suggested: '0.24–0.28 mm',
        rationale: 'Layer count drops almost linearly; this is the single parameter that saves the most time.',
        cost: 'Visible stair-stepping on curved surfaces and less resolution on small features.',
      },
      {
        key: 'sparse_infill_density',
        direction: 'decrease',
        suggested: '10–15%',
        rationale: 'Infill usually takes the largest share of the time and does not affect appearance.',
        cost: 'Less stiffness; top surfaces need more top_shell_layers to make up for it.',
      },
      {
        key: 'sparse_infill_pattern',
        direction: 'set',
        suggested: 'lightning',
        rationale:
          'Grows support columns only where the top surfaces need them; the most aggressive way to save filament and time.',
        cost: 'Almost no structural strength; only suitable for display parts.',
      },
      {
        key: 'filament_max_volumetric_speed',
        direction: 'increase',
        rationale:
          'Every speed setting is capped by this value; raising speeds without raising this cap changes nothing.',
        cost: "Beyond the hotend's capacity it under-extrudes; it has to be verified with a test print.",
      },
    ],
  },
  {
    id: 'bridging-sag',
    label: 'Sagging bridges',
    aliases: ['橋接', '跨空', '架橋', '下垂', 'bridge', 'bridging', 'sag'],
    mechanism: 'Filament spanning a gap sinks under gravity before both ends are anchored.',
    remedies: [
      {
        key: 'bridge_flow',
        direction: 'decrease',
        suggested: '0.9',
        rationale: 'Slight under-extrusion pulls the line taut instead of letting it hang.',
        cost: 'Too low and the line breaks.',
      },
      {
        key: 'fan_max_speed',
        direction: 'increase',
        suggested: '100%',
        rationale: 'Bridges have to set immediately.',
        cost: 'High-shrinkage materials warp.',
      },
      {
        key: 'bridge_speed',
        direction: 'increase',
        suggested: '50 mm/s',
        rationale: 'Crossing faster pulls the line straight.',
        cost: 'Too fast and the line snaps.',
      },
    ],
  },
  {
    id: 'print-in-place-fused',
    label: "Print-in-place parts fused / won't move",
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
      "won't turn",
      "won't move",
      'welded',
    ],
    mechanism:
      'The designed clearance between neighbouring parts is smaller than the narrowest gap the printer can resolve. ' +
      'Molten plastic has width and slumps, so two outer walls 0.1 mm apart touch and weld together before they set. ' +
      'With a 0.4 mm nozzle and PLA the practical minimum is about 0.15–0.20 mm; anything below that is a gamble. ' +
      'The first layer makes it worse again: the squashed first layer spreads outward and welds the bottom together first.',
    remedies: [
      {
        key: 'xy_contour_compensation',
        direction: 'decrease',
        suggested: '-0.05 mm',
        rationale:
          'Shrinks every solid outer contour by 0.05 mm per side. Two facing surfaces each shrink once, so the clearance ' +
          'grows by 0.10 mm. This is the only way to widen the clearance without editing the model.',
        cost:
          'Every outer dimension shrinks by 0.1 mm: thinner gear teeth, more backlash. Fine for toys; watch out on parts that have to fit something.',
      },
      {
        key: 'xy_hole_compensation',
        direction: 'increase',
        suggested: '+0.05 mm',
        rationale:
          'The side that wraps around another part (for example the teeth of a ring gear, or the inner wall of a ' +
          'bearing\'s outer race) is a "hole" to the slicer and is not affected by xy_contour_compensation. If you ' +
          'adjust only the outer contours, the clearance at such interfaces grows by only half as much.',
        cost: 'Every hole grows by 0.1 mm; pin holes that were a snug fit become loose.',
      },
      {
        key: 'elefant_foot_compensation',
        direction: 'increase',
        suggested: '0.20–0.25 mm',
        rationale:
          'The squashed first layer spreads outward and welds the parts together in the bottom one or two layers, ' +
          "no matter how well everything above prints. Elephant's foot compensation pulls the first layer inward to " +
          'cancel out that spread.',
        cost: 'Slightly less first-layer contact area. Add a brim as well on models with a small footprint.',
      },
      {
        key: 'detect_thin_wall',
        direction: 'disable',
        rationale:
          'Thin wall detection tries to fill regions narrower than one line width with material, and that is exactly ' +
          "the clearance you want to keep open. Bambu's stock default is off, but some presets carried over from " +
          'other slicers turn it on.',
        cost: 'Genuinely thin wall features on the model may come out with material missing.',
      },
      {
        key: 'initial_layer_speed',
        direction: 'decrease',
        suggested: '30 mm/s',
        rationale:
          'A slower first layer keeps extrusion steady so no excess material gets pushed into the gaps. ' +
          'It affects only one layer, so the cost is small.',
        cost: 'The first layer takes longer; negligible over the whole print.',
      },
      {
        key: 'enable_prime_tower',
        direction: 'enable',
        rationale:
          'In multi-colour prints every filament change leaves some of the old filament behind. Without a prime tower ' +
          'that material gets purged onto the model, and if it drops into a 0.1 mm gear gap the mechanism is welded shut.',
        cost: 'More filament and time, and the tower needs extra space on the plate.',
      },
    ],
    materialNotes: {
      PLA: 'Stiff and barely shrinks, so it moves freely as long as the clearance is big enough. The easiest material for print-in-place mechanisms.',
      PETG: 'Layers bond strongly and it strings easily, so the same clearance fuses more readily than with PLA. Allow another 0.05 mm.',
      TPU: 'Soft: you can pull the parts free, but they drag when they turn. Not recommended for rotating print-in-place mechanisms.',
      ABS: 'High shrinkage; the clearance changes as the part cools, and by how much is hard to predict.',
    },
    notAParameterProblem:
      'Measure before tuning. Use bambu_measure_clearance to find out what the designed clearance actually is. ' +
      'If the original design leaves only 0.05 mm, no parameter will save it: enough compensation to open it up ' +
      'will eat away the tooth profile. In that case either scale the whole print up (the clearance scales with it) ' +
      'or use a different model. Also, do not force the parts apart. A tooth face that has been forced free is a torn ' +
      'surface, rough and irreversible, and it will never run smoothly afterwards.',
  },
  {
    id: 'weak-part',
    label: 'Part not strong enough / breaks easily',
    aliases: [
      '不夠強',
      '強度',
      '容易斷',
      '脆',
      '受力',
      'weak',
      'strength',
      'break',
      'brittle',
      'fragile',
      'snaps',
      'snapped',
    ],
    mechanism:
      'The weak axis of an FDM part is always Z, between the layers. Strength comes from the walls and from layer ' +
      'fusion, not from infill density.',
    remedies: [
      {
        key: 'wall_loops',
        direction: 'increase',
        suggested: '4–5',
        rationale: 'Adding walls gives far more strength per gram than adding infill.',
        cost: 'More time and filament.',
      },
      {
        key: 'nozzle_temperature',
        direction: 'increase',
        suggested: '+10 °C',
        rationale: 'The layer interface is the main failure plane, and a hotter nozzle fuses it better.',
        cost: 'More stringing and worse overhangs.',
      },
      {
        key: 'sparse_infill_density',
        direction: 'increase',
        suggested: '30–40%',
        rationale: 'Only consider this after the first two; above 40% the returns diminish.',
        cost: 'Much more time and filament.',
      },
      {
        key: 'sparse_infill_pattern',
        direction: 'set',
        suggested: 'cubic',
        rationale: 'Braced in all three directions, so it is more even than grid.',
        cost: 'Slightly slower than grid.',
      },
    ],
    notAParameterProblem:
      'How the load direction relates to the print orientation matters more than any parameter. Orient the part so ' +
      'the load runs along XY rather than Z; the gain is several times what parameter tuning can give.',
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
  /** Number of matched keywords, used for ranking. */
  readonly score: number;
  readonly matchedAliases: readonly string[];
};

/**
 * Matches symptoms against free text.
 *
 * Deliberately no fuzzy matching or edit distance: it is better to report "not confident" and let the caller
 * fall back to `listSymptoms` than to mistake warping for stringing and hand out remedies that make things worse.
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

/** Expands a remedy into a full description, including the parameter details, for tool output. */
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
