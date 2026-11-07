import type { PresetKind } from '../contracts.js';

/**
 * Parameter knowledge layer.
 *
 * Once flattened, BambuStudio has more than 550 setting keys, but dumping all of them on a
 * model only produces random tuning. This catalog picks the parameters that actually change
 * the print result and records their meaning, unit, sensible range, the cost of raising and
 * of lowering each one, and how they relate to each other.
 *
 * Every key has been checked against the actual flattened settings of a local
 * BambuStudio 02.07.01.62, not written from memory.
 */

export type ParameterValueType = 'length-mm' | 'percentage' | 'temperature-c' | 'speed-mms' | 'angle-deg' | 'count' | 'boolean' | 'enum' | 'ratio';

export type ParameterSpec = {
  readonly key: string;
  /** Which kind of preset owns this key; when writing a user preset it must go in the right file. */
  readonly owner: PresetKind;
  readonly group: ParameterGroup;
  readonly label: string;
  readonly valueType: ParameterValueType;
  readonly unit?: string;
  /** Recommended working range; going outside it usually means you are solving the wrong problem. */
  readonly typicalRange?: { readonly min: number; readonly max: number };
  readonly enumValues?: readonly string[];
  /** What this parameter does. */
  readonly whatItDoes: string;
  /** What happens when you raise it. */
  readonly raising: string;
  /** What happens when you lower it. */
  readonly lowering: string;
  /** Parameters to look at together with this one. */
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
  // ── Quality and layers ────────────────────────────────────────────────
  {
    key: 'layer_height',
    owner: 'process',
    group: 'quality',
    label: 'Layer height',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.06, max: 0.32 },
    whatItDoes: 'Thickness of each layer; the strongest single lever between print time and surface quality. The upper limit is about 75% of the nozzle diameter.',
    raising: 'Fewer layers and an almost linear drop in time, but visible stair-stepping, coarser curves, and slightly higher Z strength because the bonded area between layers grows.',
    lowering: 'Finer curves and better resolution on small features, but much longer prints, and when too thin the extrusion becomes unstable and prone to under-extrusion.',
    related: ['initial_layer_print_height', 'line_width', 'layer_height'],
  },
  {
    key: 'initial_layer_print_height',
    owner: 'process',
    group: 'adhesion',
    label: 'Initial layer height',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.1, max: 0.3 },
    whatItDoes: 'Thickness of the first layer. A thicker one absorbs an uneven bed and levelling error, and it is one of the first parameters to change when the first layer does not stick.',
    raising: 'More tolerant of an uneven bed and steadier adhesion, but worse first-layer dimensional accuracy and a higher elephant\'s foot risk.',
    lowering: 'More accurate first-layer dimensions, but extremely sensitive to levelling error and prone to patches that do not stick.',
    related: ['initial_layer_line_width', 'initial_layer_flow_ratio', 'elefant_foot_compensation'],
  },
  {
    key: 'initial_layer_line_width',
    owner: 'process',
    group: 'adhesion',
    label: 'Initial layer line width',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.3, max: 0.7 },
    whatItDoes: 'Extrusion line width of the first layer. Widening it increases the contact area with the bed.',
    raising: 'Larger adhesion area and a steadier first layer, but a higher risk of elephant\'s foot and edge flash.',
    lowering: 'Sharper first-layer outline, but weaker adhesion.',
    related: ['initial_layer_print_height', 'initial_layer_flow_ratio', 'line_width'],
  },
  {
    key: 'initial_layer_flow_ratio',
    owner: 'process',
    group: 'adhesion',
    label: 'Initial layer flow ratio',
    valueType: 'ratio',
    typicalRange: { min: 0.9, max: 1.1 },
    whatItDoes: 'Extrusion multiplier for the first layer. Slight over-extrusion presses material into the texture of the plate.',
    raising: 'The first layer is squished in and adhesion clearly improves; too high piles up flash and worsens elephant\'s foot.',
    lowering: 'A flatter first layer, but gaps tend to appear between lines and adhesion suffers.',
    related: ['initial_layer_print_height', 'initial_layer_line_width', 'elefant_foot_compensation'],
  },
  {
    key: 'initial_layer_speed',
    owner: 'process',
    group: 'adhesion',
    label: 'Initial layer speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 100 },
    whatItDoes: 'Print speed of the first layer. Going slowly gives the material time to fuse and spread out.',
    raising: 'Saves time, but adhesion quality drops.',
    lowering: 'Adhesion clearly improves, and since it only affects one layer the total time cost is small.',
    related: ['initial_layer_infill_speed', 'initial_layer_flow_ratio', 'hot_plate_temp_initial_layer'],
  },
  {
    key: 'initial_layer_infill_speed',
    owner: 'process',
    group: 'adhesion',
    label: 'Initial layer infill speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 120 },
    whatItDoes: 'Speed of the solid interior of the first layer. Even when the outline has stuck, fast infill can still pull a small contact area off the bed.',
    raising: 'A faster first layer, but small parts and sharp corners are more easily dragged along.',
    lowering: 'Steadier first-layer adhesion; the cost is confined to the first layer.',
    related: ['initial_layer_speed', 'initial_layer_flow_ratio'],
  },
  {
    key: 'line_width',
    owner: 'process',
    group: 'quality',
    label: 'Line width',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0.3, max: 0.65 },
    whatItDoes: 'Default extrusion line width. Usually set to 100%–125% of the nozzle diameter.',
    raising: 'Higher flow, faster printing and better layer bonding, but lower detail resolution.',
    lowering: 'Better detail, but lower flow slows the print, and when too thin the walls tend to have gaps.',
    related: ['inner_wall_line_width', 'initial_layer_line_width', 'layer_height'],
  },

  // ── Strength ──────────────────────────────────────────────────────────
  {
    key: 'wall_loops',
    owner: 'process',
    group: 'strength',
    label: 'Wall loops',
    valueType: 'count',
    typicalRange: { min: 2, max: 5 },
    whatItDoes: 'Number of perimeter loops per layer. For load-bearing parts, adding walls is more efficient than raising infill density.',
    raising: 'Clearly stronger, especially in bending and screw retention; more time and filament, and a higher risk of holes shrinking.',
    lowering: 'Saves time and filament, but thin-walled parts become flexible and prone to delaminating and cracking.',
    related: ['sparse_infill_density', 'top_shell_layers', 'alternate_extra_wall'],
  },
  {
    key: 'sparse_infill_density',
    owner: 'process',
    group: 'strength',
    label: 'Sparse infill density',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: 'Fraction of the interior filled with infill. Beyond about 40% the strength gain stops being worth it; change the wall loops instead.',
    raising: 'Better stiffness and top-surface support, but more time, filament and warping-inducing internal stress.',
    lowering: 'Fast and light, but the top layers tend to sag (pillowing) and the part becomes flexible overall.',
    related: ['sparse_infill_pattern', 'wall_loops', 'top_shell_layers'],
  },
  {
    key: 'sparse_infill_pattern',
    owner: 'process',
    group: 'strength',
    label: 'Sparse infill pattern',
    valueType: 'enum',
    enumValues: ['grid', 'gyroid', 'cubic', 'adaptivecubic', 'honeycomb', 'line', 'triangles', 'lightning', 'crosshatch'],
    whatItDoes: 'Geometry of the infill, which determines strength in each direction and print speed.',
    raising: 'gyroid is isotropic and never crosses itself; cubic balances strength and speed; lightning only supports the top surfaces and uses very little filament.',
    lowering: 'grid is fast but crosses itself on every layer, which the nozzle can hit; line is the weakest.',
    related: ['sparse_infill_density', 'infill_direction'],
  },
  {
    key: 'top_shell_layers',
    owner: 'process',
    group: 'surface',
    label: 'Top shell layers',
    valueType: 'count',
    typicalRange: { min: 3, max: 8 },
    whatItDoes: 'Number of solid top layers. When the top surface has holes or dips, add these first rather than more infill.',
    raising: 'A flatter, denser top surface; more time.',
    lowering: 'Saves time, but at low infill density the top surface sags into pillowing and holes.',
    related: ['sparse_infill_density', 'top_surface_pattern', 'bottom_shell_layers'],
  },
  {
    key: 'bottom_shell_layers',
    owner: 'process',
    group: 'surface',
    label: 'Bottom shell layers',
    valueType: 'count',
    typicalRange: { min: 2, max: 6 },
    whatItDoes: 'Number of solid bottom layers.',
    raising: 'A denser, opaque bottom surface; more time.',
    lowering: 'Saves time, but the bottom surface may show gaps.',
    related: ['top_shell_layers', 'initial_layer_print_height'],
  },

  // ── Adhesion and warping ──────────────────────────────────────────────
  {
    key: 'brim_type',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim type',
    valueType: 'enum',
    enumValues: ['auto_brim', 'brim_ears', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'],
    whatItDoes: 'Prints a skirt-like brim around the model to increase the adhesion area; the most direct countermeasure against warping and small footprints coming loose.',
    raising: 'outer_only / auto_brim give the steadiest adhesion; brim_ears only adds ears at sharp corners, using less filament and coming off easily.',
    lowering: 'no_brim leaves a clean surface with no post-processing, but high-shrinkage materials or small footprints tend to lift and come loose.',
    related: ['brim_width', 'brim_object_gap', 'hot_plate_temp'],
  },
  {
    key: 'brim_width',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim width',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 10 },
    whatItDoes: 'How far the brim extends outward.',
    raising: 'Better grip, but more filament and removal work, and it may leave marks on the surface.',
    lowering: 'Easy to remove, but less resistance to warping.',
    related: ['brim_type', 'brim_object_gap'],
  },
  {
    key: 'brim_object_gap',
    owner: 'process',
    group: 'adhesion',
    label: 'Brim-object gap',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.3 },
    whatItDoes: 'How much gap is left between the brim and the model; directly affects grip and how hard the brim is to remove.',
    raising: 'Easier to remove and less likely to fuse moving clearances, but less grip.',
    lowering: 'Holds more firmly, but may be hard to remove or bridge across print-in-place clearances.',
    related: ['brim_type', 'brim_width'],
  },
  {
    key: 'elefant_foot_compensation',
    owner: 'process',
    group: 'accuracy',
    label: 'Elephant foot compensation',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.4 },
    whatItDoes: 'Shrinks the first layer inward to cancel the "elephant\'s foot" caused by the squished first layer spreading outward. Bambu\'s stock presets default to 0.15.',
    raising: 'The bottom edge comes closer to the design dimensions; too much shrinks the first-layer contact area and the part comes loose.',
    lowering: 'The bottom edge flares out, and mating features (such as pin holes) will not fit.',
    related: ['initial_layer_print_height', 'xy_contour_compensation'],
  },
  {
    key: 'hot_plate_temp_initial_layer',
    owner: 'filament',
    group: 'temperature',
    label: 'Initial layer bed temperature',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 0, max: 110 },
    whatItDoes: 'Bed temperature for the first layer. For adhesion problems change this first, before mechanical measures.',
    raising: 'Better adhesion, but too high softens the bottom so it spreads outward, worsening elephant\'s foot.',
    lowering: 'A sharper bottom surface, but prone to warping or the whole part coming loose.',
    related: ['hot_plate_temp', 'brim_type', 'initial_layer_print_height'],
  },
  {
    key: 'draft_shield',
    owner: 'process',
    group: 'adhesion',
    label: 'Draft shield',
    valueType: 'enum',
    enumValues: ['disabled', 'limited', 'enabled'],
    whatItDoes: 'Prints a tall wall around the model to block airflow, suppressing warping of high-shrinkage materials such as ABS / ASA.',
    raising: 'Good heat retention and much less warping, but noticeably more filament and time.',
    lowering: 'Saves filament; on open-frame printers, high-shrinkage materials carry a high warping risk.',
    related: ['brim_type', 'chamber_temperatures'],
  },

  // ── Temperature ───────────────────────────────────────────────────────
  {
    key: 'nozzle_temperature',
    owner: 'filament',
    group: 'temperature',
    label: 'Nozzle temperature',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 170, max: 300 },
    whatItDoes: 'Main printing temperature. Affects layer bond strength, stringing and surface gloss all at once.',
    raising: 'Stronger layer bonding and better flow allow faster printing, but stringing, oozing and heat sag get worse.',
    lowering: 'Sharper detail and less stringing, but a higher risk of layer splitting; too low causes under-extrusion or even a clog.',
    related: ['nozzle_temperature_initial_layer', 'filament_retraction_length', 'fan_max_speed'],
  },
  {
    key: 'nozzle_temperature_initial_layer',
    owner: 'filament',
    group: 'temperature',
    label: 'Initial layer nozzle temperature',
    valueType: 'temperature-c',
    unit: '°C',
    typicalRange: { min: 170, max: 300 },
    whatItDoes: 'Nozzle temperature for the first layer, usually 5 °C above the rest to help it fuse to the bed.',
    raising: 'Better first-layer adhesion.',
    lowering: 'Worse first-layer adhesion.',
    related: ['nozzle_temperature', 'hot_plate_temp_initial_layer'],
  },

  // ── Cooling ───────────────────────────────────────────────────────────
  {
    key: 'fan_max_speed',
    owner: 'filament',
    group: 'cooling',
    label: 'Maximum fan speed',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: 'Upper limit of the part cooling fan. PLA runs it almost fully on; ABS / ASA must keep it low or the layers split.',
    raising: 'Overhangs and bridges hold up better and detail is sharper, but layer bonding weakens and high-shrinkage materials warp more.',
    lowering: 'Stronger layer bonding and less warping, but overhangs droop and small parts overheat and deform.',
    related: ['fan_min_speed', 'slow_down_layer_time', 'nozzle_temperature'],
  },
  {
    key: 'fan_min_speed',
    owner: 'filament',
    group: 'cooling',
    label: 'Minimum fan speed',
    valueType: 'percentage',
    unit: '%',
    typicalRange: { min: 0, max: 100 },
    whatItDoes: 'Lower limit of the fan during normal printing.',
    raising: 'Stronger cooling overall.',
    lowering: 'Better layer bonding.',
    related: ['fan_max_speed', 'slow_down_layer_time'],
  },
  {
    key: 'slow_down_layer_time',
    owner: 'filament',
    group: 'cooling',
    label: 'Minimum layer time',
    valueType: 'count',
    unit: 's',
    typicalRange: { min: 0, max: 30 },
    whatItDoes: 'If a layer would finish faster than this many seconds, the printer slows down automatically to give the previous layer time to solidify. Most effective when small tips deform.',
    raising: 'Small cross-sections no longer overheat into a blob, but total time increases.',
    lowering: 'Fast, but the tops of small parts go soft and slump.',
    related: ['fan_max_speed', 'outer_wall_speed'],
  },

  // ── Retraction and stringing ──────────────────────────────────────────
  {
    key: 'filament_retraction_length',
    owner: 'filament',
    group: 'retraction',
    label: 'Retraction length',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 2 },
    whatItDoes: 'Amount of filament retracted before a travel move. Direct-drive extruders (every Bambu model) usually need only 0.4–1.0 mm.',
    raising: 'Less stringing and oozing, but too long leaves a void in the nozzle that under-extrudes the next segment, and raises the clog risk.',
    lowering: 'Flow recovers quickly, but more stringing.',
    related: ['filament_retraction_speed', 'filament_z_hop', 'nozzle_temperature'],
  },
  {
    key: 'filament_retraction_speed',
    owner: 'filament',
    group: 'retraction',
    label: 'Retraction speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 15, max: 60 },
    whatItDoes: 'Speed of the retraction.',
    raising: 'Cleaner break-off and less stringing, but soft filament (TPU) gets ground down or even jams.',
    lowering: 'Gentle on soft filament; more stringing.',
    related: ['filament_retraction_length', 'deretraction_speed'],
  },
  {
    key: 'filament_z_hop',
    owner: 'filament',
    group: 'retraction',
    label: 'Z hop',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 1 },
    whatItDoes: 'Lifts the nozzle during travel moves so it does not scrape printed surfaces or knock over curled-up edges and corners.',
    raising: 'Lower risk of surface scratches and collisions, but every lift and lower adds time and may leave extra stringing points.',
    lowering: 'Fast, but the nozzle may scratch top surfaces.',
    related: ['filament_retraction_length', 'reduce_crossing_wall', 'z_hop'],
  },
  {
    key: 'z_hop',
    owner: 'machine',
    group: 'retraction',
    label: 'Z hop (machine default)',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 1 },
    whatItDoes:
      'Machine-level travel lift height; almost every stock Bambu printer uses 0.4 mm. The filament-level filament_z_hop overrides it when it is not nil, ' +
      'so the value actually in effect has to be read from the sliced output, not from this level alone.',
    raising: 'Less likely to brush against printed surfaces when crossing them, but every lift and lower adds time and may leave extra stringing points.',
    lowering: 'Fast, but the nozzle may scratch top surfaces or hit a curled-up edge.',
    related: ['z_hop_types', 'filament_z_hop', 'retract_lift_above', 'retract_lift_below'],
  },
  {
    key: 'z_hop_types',
    owner: 'machine',
    group: 'retraction',
    label: 'Z hop type (machine default)',
    valueType: 'enum',
    enumValues: ['Auto Lift', 'Normal Lift', 'Slope Lift', 'Spiral Lift'],
    whatItDoes:
      'Trajectory of the lift. Stock Bambu printers all use Auto Lift, letting the slicer decide when to lift; in a measured slice of a bowl-shaped part, ' +
      'every travel move that crossed an outer wall was lifted. The filament-level filament_z_hop_types overrides it when it is not nil ' +
      '(many stock filaments set Spiral Lift).',
    raising: 'Spiral Lift / Slope Lift rise while moving, avoiding one abrupt stop and making it less likely to pull a fine string on the spot.',
    lowering: 'Normal Lift rises vertically first and then travels; the simplest path, but it pauses on the spot for a moment longer.',
    related: ['z_hop', 'filament_z_hop_types', 'reduce_crossing_wall'],
  },

  // ── Overhangs and bridges ─────────────────────────────────────────────
  {
    key: 'enable_overhang_speed',
    owner: 'process',
    group: 'quality',
    label: 'Slow down for overhang',
    valueType: 'boolean',
    whatItDoes: 'Automatically slows down in four steps according to how far the overhang extends, giving the extruded line time to be set by the fan.',
    raising: 'Much better overhang surface quality.',
    lowering: 'Fast, but the lower edge of sloped surfaces curls up and gets fuzzy.',
    related: ['overhang_1_4_speed', 'enable_overhang_bridge_fan', 'fan_max_speed'],
  },
  {
    key: 'bridge_flow',
    owner: 'process',
    group: 'quality',
    label: 'Bridge flow',
    valueType: 'ratio',
    typicalRange: { min: 0.5, max: 1.2 },
    whatItDoes: 'Extrusion multiplier for bridge segments. Slightly below 1 keeps bridge lines taut so they do not droop.',
    raising: 'Thicker, more solid bridge lines that droop more easily.',
    lowering: 'Bridge lines pulled straighter; too low and they break.',
    related: ['bridge_speed', 'enable_overhang_bridge_fan'],
  },
  {
    key: 'bridge_speed',
    owner: 'process',
    group: 'quality',
    label: 'Bridge speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 20, max: 80 },
    whatItDoes: 'Print speed across unsupported spans.',
    raising: 'Bridge lines are pulled straighter, but too fast pulls them apart.',
    lowering: 'Drooping gets worse.',
    related: ['bridge_flow', 'fan_max_speed'],
  },

  // ── Support ───────────────────────────────────────────────────────────
  {
    key: 'enable_support',
    owner: 'process',
    group: 'support',
    label: 'Enable support',
    valueType: 'boolean',
    whatItDoes: 'Whether to generate support structures.',
    raising: 'Steep overhangs become printable, but filament, time and post-processing increase, and contact surfaces are left scarred.',
    lowering: 'Clean surfaces, but overhangs beyond the critical angle fail.',
    related: ['support_type', 'support_threshold_angle', 'support_top_z_distance'],
  },
  {
    key: 'support_type',
    owner: 'process',
    group: 'support',
    label: 'Support type',
    valueType: 'enum',
    enumValues: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)', 'hybrid(auto)'],
    whatItDoes: 'normal is a columnar grid; tree is branching.',
    raising: 'tree uses less filament, removes easily and suits organic shapes; normal is steadier under large flat overhangs.',
    lowering: 'tree does not support large horizontal overhangs well enough.',
    related: ['enable_support', 'tree_support_branch_angle'],
  },
  {
    key: 'support_threshold_angle',
    owner: 'process',
    group: 'support',
    label: 'Support threshold angle',
    valueType: 'angle-deg',
    unit: '°',
    typicalRange: { min: 20, max: 60 },
    whatItDoes: 'Only overhangs beyond this angle (measured from vertical) get support. FDM can generally support itself up to 45°.',
    raising: 'Less support and cleaner surfaces, but steep faces may collapse.',
    lowering: 'More support and a higher success rate, but more filament and post-processing.',
    related: ['enable_support', 'support_type'],
  },
  {
    key: 'support_top_z_distance',
    owner: 'process',
    group: 'support',
    label: 'Support top Z distance',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: 0, max: 0.4 },
    whatItDoes: 'Vertical gap between support and model; directly determines how easily supports come off and how much they scar the surface.',
    raising: 'Easy to remove, but the overhang surface droops more visibly.',
    lowering: 'A flatter supported surface, but supports may fuse with the model and refuse to come off.',
    related: ['enable_support', 'support_base_pattern'],
  },

  // ── Accuracy ──────────────────────────────────────────────────────────
  {
    key: 'xy_hole_compensation',
    owner: 'process',
    group: 'accuracy',
    label: 'X-Y hole compensation',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: -0.2, max: 0.3 },
    whatItDoes: 'Compensates for holes printing undersized because extrusion lines pull inward. Positive values enlarge holes.',
    raising: 'Larger holes; pins and screws go in more easily.',
    lowering: 'Smaller holes.',
    related: ['xy_contour_compensation', 'elefant_foot_compensation'],
  },
  {
    key: 'xy_contour_compensation',
    owner: 'process',
    group: 'accuracy',
    label: 'X-Y contour compensation',
    valueType: 'length-mm',
    unit: 'mm',
    typicalRange: { min: -0.3, max: 0.2 },
    whatItDoes: 'Dimensional compensation for the whole outer contour. Negative values shrink the outline.',
    raising: 'Larger outline.',
    lowering: 'Smaller outline; mating parts insert more easily.',
    related: ['xy_hole_compensation', 'elefant_foot_compensation'],
  },
  {
    key: 'detect_thin_wall',
    owner: 'process',
    group: 'accuracy',
    label: 'Detect thin wall',
    valueType: 'boolean',
    whatItDoes:
      'Detects regions narrower than one extrusion line width and tries to fill them with variable line width. Off (0) by default in Bambu\'s stock presets.',
    raising:
      'When on, genuinely thin fins and blade edges on the model are not left out. The cost is that the slicer fills narrow slots it takes for thin walls — ' +
      'the clearances a print-in-place mechanism deliberately leaves are exactly such slots; turn it on and they get filled, fusing the parts together.',
    lowering: 'When off, features narrower than a line width are skipped, so the clearances that should stay empty are kept.',
    related: ['xy_contour_compensation', 'xy_hole_compensation', 'outer_wall_line_width'],
  },
  {
    key: 'precise_outer_wall',
    owner: 'process',
    group: 'accuracy',
    label: 'Precise wall',
    valueType: 'boolean',
    whatItDoes:
      'Adjusts the spacing between the outer wall and the inner walls so the printed outline comes closer to the model\'s nominal dimensions, at the cost of possible fine gaps between walls.',
    raising: 'More accurate outer dimensions; mating parts line up better.',
    lowering: 'The outline is slightly larger than nominal, but the walls bond more tightly to each other.',
    related: ['xy_contour_compensation', 'outer_wall_line_width', 'wall_loops'],
  },
  {
    key: 'enable_prime_tower',
    owner: 'process',
    group: 'quality',
    label: 'Prime tower',
    valueType: 'boolean',
    whatItDoes:
      'For multi-colour / multi-material prints, prints a separate tower on the plate; at each filament change the old filament is purged on the tower before returning to the model.',
    raising:
      'Clean colour changes: no traces of the previous colour on the model, and no oozed filament dropping into the model\'s gaps.',
    lowering:
      'Saves time and filament, but purged material ends up on the model. Particularly fatal for print-in-place mechanisms — ' +
      'one drop of ooze falling into a 0.1 mm gear gap is enough to fuse it solid.',
    related: ['prime_tower_width', 'flush_into_objects', 'flush_into_infill'],
  },
  {
    key: 'flush_into_objects',
    owner: 'process',
    group: 'quality',
    label: 'Flush into this object',
    valueType: 'boolean',
    whatItDoes:
      'Extrudes the old filament that a colour change has to flush into the model itself instead of the prime tower. Saves filament, but that material stays inside the finished part.',
    raising: 'Less filament and time.',
    lowering:
      'Colour-change leftovers stay out of the model\'s interior and colour boundaries stay clean. Needs the prime tower, otherwise the filament has nowhere to go.',
    related: ['enable_prime_tower', 'flush_into_infill'],
  },
  {
    key: 'flush_into_infill',
    owner: 'process',
    group: 'quality',
    label: 'Flush into objects\' infill',
    valueType: 'boolean',
    whatItDoes: 'Extrudes the old filament that a colour change has to flush into the sparse infill. Gentler than flush_into_objects, affecting only the hidden interior.',
    raising: 'Saves prime tower filament; the infill colours get mixed, but this is not visible from outside.',
    lowering: 'The infill stays a single material, which suits structural parts whose material properties must be certain.',
    related: ['enable_prime_tower', 'flush_into_objects', 'sparse_infill_density'],
  },
  {
    key: 'precise_z_height',
    owner: 'process',
    group: 'accuracy',
    label: 'Precise Z height',
    valueType: 'boolean',
    whatItDoes: 'Fine-tunes the height of the last few layers so the total height of the print matches the model height exactly.',
    raising: 'Accurate total height, suited to parts with mating relationships.',
    lowering: 'Total height is affected by the rounding error of dividing by the layer height.',
    related: ['layer_height'],
  },
  {
    key: 'seam_position',
    owner: 'process',
    group: 'surface',
    label: 'Seam position',
    valueType: 'enum',
    enumValues: ['nearest', 'aligned', 'back', 'random'],
    whatItDoes: 'Strategy for placing the start/end point of each layer, which determines how visible the seam is.',
    raising: 'back hides the seam on the rear; aligned lines it up in a straight line, the least obtrusive.',
    lowering: 'random scatters the seam into specks, which is actually more noticeable on cylinders.',
    related: ['has_scarf_joint_seam', 'wall_loops'],
  },
  {
    key: 'has_scarf_joint_seam',
    owner: 'process',
    group: 'surface',
    label: 'Scarf joint seam',
    valueType: 'boolean',
    whatItDoes: 'Makes the seam a sloped, gradual transition instead of a vertical butt joint, greatly reducing seam marks.',
    raising: 'The seam is almost invisible; slightly more time.',
    lowering: 'The seam is the traditional single vertical line.',
    related: ['seam_position'],
  },

  // ── Speed ─────────────────────────────────────────────────────────────
  {
    key: 'outer_wall_speed',
    owner: 'process',
    group: 'speed',
    label: 'Outer wall speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 30, max: 300 },
    whatItDoes: 'Speed of the visible outer wall; the speed parameter surface quality is most sensitive to.',
    raising: 'Saves time, but ringing, dimensional deviation and corner defects become more visible.',
    lowering: 'Clearly better surfaces with a limited increase in total time (the outer wall is only a small part of the toolpath).',
    related: ['inner_wall_speed', 'outer_wall_acceleration', 'default_acceleration'],
  },
  {
    key: 'reduce_crossing_wall',
    owner: 'process',
    group: 'speed',
    label: 'Avoid crossing wall',
    valueType: 'boolean',
    whatItDoes:
      'Detours when a travel move exceeds a threshold, so it does not cross printed walls and leave blobs on the surface (the purpose the official documentation gives). ' +
      'If the detour would exceed max_travel_detour_distance, it still crosses the wall directly.',
    raising:
      'Fewer surface blobs and scratches, but longer travel paths. It is not a collision-avoidance setting: Bambu\'s stock Auto Lift already lifts when crossing outer walls, ' +
      'and in a measured bowl-shaped part, turning it on actually raised the number of unlifted outer-wall-crossing travel moves from 0 to 10.',
    lowering: 'Shorter paths; when crossing walls, Z hop keeps the nozzle off the surface.',
    related: ['max_travel_detour_distance', 'z_hop_types', 'filament_z_hop'],
  },
  {
    key: 'print_sequence',
    owner: 'process',
    group: 'quality',
    label: 'Print sequence',
    valueType: 'enum',
    enumValues: ['by layer', 'by object'],
    whatItDoes:
      'Prints the whole plate layer by layer (by layer), or finishes one object before starting the next (by object). When printing by object, ' +
      'already-printed parts must not be taller than the clearance between nozzle and gantry rod, and objects must be spaced apart; the slicer enforces this.',
    raising:
      'by object: no travel back and forth between objects on every layer, and one part failing does not ruin parts already finished; but limited by height clearance, with looser arrangement.',
    lowering: 'by layer: no height limit and dense arrangement, but every layer travels between all objects, and one failed part often drags down the whole plate.',
    related: ['extruder_clearance_height_to_rod', 'extruder_clearance_max_radius'],
  },
  {
    key: 'sparse_infill_speed',
    owner: 'process',
    group: 'speed',
    label: 'Sparse infill speed',
    valueType: 'speed-mms',
    unit: 'mm/s',
    typicalRange: { min: 50, max: 500 },
    whatItDoes: 'Speed of the interior infill; usually the main contributor to total time, and it does not affect appearance.',
    raising: 'The biggest time saving, but capped by filament_max_volumetric_speed; beyond it you get under-extrusion.',
    lowering: 'Denser, more solid infill.',
    related: ['filament_max_volumetric_speed', 'sparse_infill_density'],
  },
  {
    key: 'default_acceleration',
    owner: 'process',
    group: 'speed',
    label: 'Default acceleration',
    valueType: 'count',
    unit: 'mm/s²',
    typicalRange: { min: 500, max: 20000 },
    whatItDoes: 'Overall acceleration limit; determines whether small features can actually reach the set speed.',
    raising: 'Shorter actual print time, but more ringing and noise.',
    lowering: 'Cleaner surfaces, longer time.',
    related: ['outer_wall_acceleration', 'initial_layer_acceleration'],
  },
  {
    key: 'filament_max_volumetric_speed',
    owner: 'filament',
    group: 'speed',
    label: 'Max volumetric speed',
    valueType: 'count',
    unit: 'mm³/s',
    typicalRange: { min: 2, max: 32 },
    whatItDoes: 'The most of this filament that can be melted per second; the real ceiling for every speed setting.',
    raising: 'Allows faster printing, but beyond what the hotend can handle you get under-extrusion, thin lines or even filament breaks.',
    lowering: 'Stable extrusion, but every speed setting gets held down.',
    related: ['sparse_infill_speed', 'nozzle_temperature'],
  },

  // ── Surface ───────────────────────────────────────────────────────────
  {
    key: 'ironing_type',
    owner: 'process',
    group: 'surface',
    label: 'Ironing type',
    valueType: 'enum',
    enumValues: ['no ironing', 'top', 'topmost', 'solid'],
    whatItDoes: 'After printing a top surface, passes the nozzle over it once more at low flow to smooth it.',
    raising: 'Near-smooth top surfaces, but every top surface takes considerably longer.',
    lowering: 'Toolpath lines are visible on the top surface.',
    related: ['ironing_flow', 'ironing_spacing', 'top_surface_pattern'],
  },
  {
    key: 'top_surface_pattern',
    owner: 'process',
    group: 'surface',
    label: 'Top surface pattern',
    valueType: 'enum',
    enumValues: ['concentric', 'zig-zag', 'monotonic', 'monotonicline', 'alignedrectilinear', 'hilbertcurve', 'archimedeanchords'],
    whatItDoes: 'How the solid top layers are laid down.',
    raising: 'monotonicline keeps adjacent lines in a consistent direction and order, giving uniform reflections and the cleanest look.',
    lowering: 'zig-zag goes back and forth, producing alternating light and dark bands.',
    related: ['ironing_type', 'top_shell_layers'],
  },
  {
    key: 'fuzzy_skin',
    owner: 'process',
    group: 'surface',
    label: 'Fuzzy skin',
    valueType: 'enum',
    enumValues: ['none', 'external', 'all', 'allwalls'],
    whatItDoes: 'Adds random jitter to the outer wall for a matte texture, which also hides layer lines and seams.',
    raising: 'Pronounced texture and good grip, but lower dimensional accuracy.',
    lowering: 'Smooth surface, but layer lines are visible.',
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
 * Decides which kind of preset file a key belongs in.
 * Keys not in the catalog return undefined — the caller must decide from the actual flattened
 * preset contents and must not guess; otherwise a filament key ends up in a process file and is
 * silently ignored by the CLI.
 */
export function ownerOf(key: string): PresetKind | undefined {
  return BY_KEY.get(key)?.owner;
}

/**
 * Checks whether a value falls within the recommended range. Being outside it is not illegal
 * (the user may really want an extreme test), but it must be reported explicitly, never
 * silently swallowed.
 */
export function rangeWarning(key: string, value: string): string | undefined {
  const spec = BY_KEY.get(key);
  if (spec?.typicalRange === undefined) return undefined;
  const numeric = Number.parseFloat(value.replace('%', ''));
  if (!Number.isFinite(numeric)) return undefined;
  const { min, max } = spec.typicalRange;
  if (numeric < min) {
    return `${key}=${value} is below the recommended minimum ${min}${spec.unit ?? ''}: ${spec.lowering}`;
  }
  if (numeric > max) {
    return `${key}=${value} is above the recommended maximum ${max}${spec.unit ?? ''}: ${spec.raising}`;
  }
  return undefined;
}
