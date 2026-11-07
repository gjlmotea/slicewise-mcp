import type { ParameterOverrides, PresetKind, PresetRecord, PresetValue } from '../contracts.js';
import { ownerOf } from '../parameters/catalog.js';
import { isKnownParameterKey } from '../parameters/known-keys.js';

/**
 * Decide where each override parameter lands.
 *
 * This is a pure function because it is where two real bugs happened:
 *
 * 1. Unknown parameters used to be sent as CLI flags. An unrecognised flag makes BambuStudio
 *    **fail the whole slice**, so one mistyped parameter name would ruin an otherwise perfectly
 *    good slice. Now they are dropped with a warning.
 * 2. When ownership was decided by the catalog alone, parameters the catalog does not list were
 *    wrongly sent on the command line. Now we first check which flattened preset actually
 *    contains the key; the catalog is only a fallback.
 */

export type OverrideRouting = {
  /** Overrides grouped by preset kind; written into the flattened temporary JSON. */
  readonly buckets: Readonly<Record<PresetKind, ParameterOverrides>>;
  /** Valid parameters that belong to no loaded preset; sent on the command line instead. */
  readonly commandLine: readonly string[];
  /** Parameters that could not be recognised at all and were dropped. */
  readonly dropped: readonly string[];
  readonly warnings: readonly string[];
};

export function routeOverrides(
  overrides: ParameterOverrides,
  resolved: Readonly<Record<PresetKind, PresetRecord>>,
): OverrideRouting {
  const buckets: Record<PresetKind, Record<string, PresetValue>> = {
    machine: {},
    process: {},
    filament: {},
  };
  const commandLine: string[] = [];
  const dropped: string[] = [];
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(overrides)) {
    // First check which preset it actually appears in: more reliable than the catalog, which is only a curated selection.
    const owner =
      (['process', 'filament', 'machine'] as const).find((kind) => key in resolved[kind]) ??
      ownerOf(key);

    if (owner !== undefined) {
      buckets[owner][key] = value;
      continue;
    }

    if (!isKnownParameterKey(key)) {
      dropped.push(key);
      warnings.push(
        `${key} is not a BambuStudio parameter name; skipped (not sent). Check the spelling. ` +
          'Sending an unknown parameter to the CLI makes the whole slice fail, so it is dropped here rather than tried.',
      );
      continue;
    }

    warnings.push(
      `${key} does not belong to any loaded preset, so it is overridden on the command line; check overrideAudit after slicing to confirm it was honoured.`,
    );
    commandLine.push(`--${key.replaceAll('_', '-')}=${serialise(value)}`);
  }

  return { buckets, commandLine, dropped, warnings };
}

/**
 * Multi-nozzle parameters are arrays with one item per extruder, joined with commas on the
 * command line. `Array.isArray` does not narrow `readonly string[]`, so use an explicit type check.
 */
function serialise(value: PresetValue): string {
  return typeof value === 'string' ? value : value.join(',');
}
