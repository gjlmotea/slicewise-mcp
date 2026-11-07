import type { ParameterOverrides } from '../contracts.js';

/**
 * Decide whether to pass the project's filament colours to the CLI.
 *
 * When BambuStudio CLI (02.07.01.62, `disable_wipe_tower_after_mapping` in
 * `src/BambuStudio.cpp`) slices a Bambu project 3MF and the filament presets loaded via
 * `--load-filaments` **all have the same name**, it concludes that "every filament maps to
 * the same spool" and forces the prime tower off, swallowing any `enable_prime_tower`
 * override too. The only condition that flips it back is a separate `filament_colour` on the
 * command line with more than one colour.
 *
 * The GUI does not have this problem because it knows each slot's colour. The most common case
 * is five slots all set to Generic PLA, differing only in colour: passing the project's own
 * colours to the CLI unchanged is what makes the slice get a prime tower, as in the GUI.
 *
 * Colours are passed only in that case. Once colours are on the command line, the CLI also
 * recomputes colour-change flushing volumes from them; every other case is left to the
 * project's own settings, doing nothing the GUI would not do. If the user has overridden
 * `filament_colour` themselves, do not intervene.
 */
export function filamentColourArgs(options: {
  readonly filamentPresets: readonly string[];
  readonly projectColours: readonly string[] | undefined;
  readonly overrides: ParameterOverrides;
}): readonly string[] {
  if ('filament_colour' in options.overrides) return [];
  if (new Set(options.filamentPresets).size !== 1) return [];

  const colours = options.projectColours ?? [];
  const distinct = new Set(
    colours.map((colour) => colour.trim().toUpperCase()).filter((colour) => colour !== ''),
  );
  if (distinct.size < 2) return [];

  return [`--filament-colour=${colours.join(';')}`];
}
