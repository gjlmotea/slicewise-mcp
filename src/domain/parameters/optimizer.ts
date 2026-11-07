import type { ParameterOverrides, PresetRecord, PresetValue } from '../contracts.js';

/**
 * Print-in-place process adjustments that are safe to apply automatically.
 *
 * Bed temperature, fan and flow are deliberately left alone here: they belong to the filament
 * preset and require knowing the actual material (plain PLA and Silk PLA must not share one
 * uncalibrated setup). By default the global brim is explicitly turned off, because Bambu's
 * built-in default is Auto Brim, which can fuse the moving clearances of a print-in-place part;
 * local Brim Ears must be checked in the first-layer preview.
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
    'Lower the first-layer outline to 20 mm/s to give small contact areas more time to fuse and be pressed down.',
  );
  set(
    'initial_layer_infill_speed',
    valueLike(effective['initial_layer_infill_speed'], '30'),
    'Cap first-layer infill at 30 mm/s too, so fast infill paths do not pull the outline loose again after it has stuck.',
  );
  set(
    'outer_wall_speed',
    capNumericValue(effective['outer_wall_speed'], 60),
    'Outer walls at most 60 mm/s, to reduce small-part wobble, nozzle collisions and visible ringing.',
  );
  set(
    'enable_overhang_speed',
    valueLike(effective['enable_overhang_speed'], '1'),
    'Keep stepped overhang slow-down so edges set before the next layer is printed, reducing curling and collisions.',
  );
  set(
    'reduce_crossing_wall',
    valueLike(effective['reduce_crossing_wall'], '1'),
    'Route travel moves around printed walls, lowering the chance of the nozzle knocking small gears or rollers off the bed.',
  );
  set(
    'top_surface_pattern',
    'monotonicline',
    'Use Bambu Studio\'s Monotonic line, avoiding the regular brain-like texture of patterns such as Hilbert Curve.',
  );
  set('ironing_type', 'no ironing', 'Turn ironing off by default, ruling out the top-surface material build-up and extra toolpaths it causes.');
  set('fuzzy_skin', 'none', 'Turn fuzzy skin off so a deliberately random surface is not mistaken for a print defect.');

  if (options.includeBrimEars === true) {
    set('brim_type', 'brim_ears', 'Use Brim Ears only, so a full brim does not fill the clearances between moving parts.');
    set('brim_width', '5', '5 mm is a conservative starting point balancing grip and removal.');
    set('brim_object_gap', '0.15', 'Leave a 0.15 mm gap so the ears are easier to remove.');
  } else {
    set('brim_type', 'no_brim', 'Explicitly turn off Bambu\'s default Auto Brim so it does not fuse the moving clearances of the print-in-place part.');
  }

  return {
    overrides,
    changes,
    manualActions: [
      options.includeBrimEars === true
        ? 'After slicing, view only the first layer and confirm the Brim Ears do not cross gears or clearances between moving parts; if they do, turn them off and paint ears manually instead.'
        : 'If small local parts are still unstable, paint 3–5 mm Brim Ears manually; after slicing, view only the first layer and confirm they do not cross gears or moving clearances.',
      'Before printing, wash the plate with dish soap and water, do not touch the print area, and confirm Studio has the plate you are actually using selected.',
      'When sending the print, turn on bed levelling and flow dynamics calibration; if the gold filament is Silk PLA, use a Silk filament preset rather than sharing uncalibrated flow with plain PLA.',
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
