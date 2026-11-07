import type { FilamentUsage, SliceStats } from '../contracts.js';

/**
 * Parse objective stats from the G-code header BambuStudio produces.
 *
 * These numbers are computed by the slicer itself, not estimated by us. Any "this change
 * saved this much time" reported to the user must come from here, never be estimated from
 * parameters: estimates drift systematically away from the real result.
 *
 * Field names follow the actual output of a local BambuStudio 02.07.01.62:
 *
 * ```
 * ; model printing time: 8m 45s; total estimated time: 9m 5s
 * ; total layer number: 100
 * ; total filament length [mm] : 1236.35
 * ; total filament weight [g] : 3.75
 * ; max_z_height: 20.00
 * ; layer_height = 0.2
 * ```
 *
 * For multi-colour prints the usage fields hold one value per colour, in the order of the
 * filament slots listed by `; filament:`:
 *
 * ```
 * ; total filament length [mm] : 1563.48,1350.27,1834.46,9897.65
 * ; total filament weight [g] : 4.66,4.03,5.47,29.52
 * ; filament: 2,3,4,5
 * ```
 *
 * Each colour's value already includes colour-change flushing and prime tower usage (same as
 * the Total column of the GUI's slicing result table), so the sum is the whole plate's usage.
 * Taking only the first value would report a four-colour plate's 43.68 g as 4.66 g.
 */

/** Parse a duration fragment such as `1h 2m 3s`. */
export function parseDurationSeconds(text: string): number | undefined {
  const pattern = /(\d+(?:\.\d+)?)\s*([hms])\b/g;
  let total = 0;
  let matched = false;

  for (const match of text.matchAll(pattern)) {
    const amount = Number.parseFloat(match[1] ?? '');
    const unit = match[2];
    if (!Number.isFinite(amount)) continue;
    matched = true;
    if (unit === 'h') total += amount * 3600;
    else if (unit === 'm') total += amount * 60;
    else total += amount;
  }

  return matched ? Math.round(total) : undefined;
}

function firstNumber(text: string): number | undefined {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (match === null) return undefined;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

/** Parse a comma-separated number list such as `4.66,4.03,5.47`; if any item is not a number, reject the whole list. */
function numberList(text: string): readonly number[] | undefined {
  const items = text.split(',').map((item) => item.trim());
  if (items.length === 0 || items.some((item) => !/^-?\d+(?:\.\d+)?$/.test(item))) return undefined;
  return items.map((item) => Number.parseFloat(item));
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

function sum(values: readonly number[]): number {
  return roundHundredths(values.reduce((total, value) => total + value, 0));
}

type HeaderField = { readonly key: string; readonly value: string };

/**
 * Split each line into `; key = value` or `; key : value`.
 *
 * Note that field names themselves contain brackets such as `[mm]` and `[cm^3]`, so splitting
 * at the first non-word character does not work; look explicitly for `=` or `:`.
 */
function parseHeaderLine(line: string): HeaderField | undefined {
  if (!line.startsWith(';')) return undefined;
  const body = line.slice(1).trim();
  const separator = body.search(/[=:]/);
  if (separator < 0) return undefined;
  return {
    key: body.slice(0, separator).trim().toLowerCase(),
    value: body.slice(separator + 1).trim(),
  };
}

export function parseGcodeStats(gcode: string): SliceStats | undefined {
  // Stats fields sit in the file's head and tail; read only those ends to avoid scanning tens of MB of toolpath body.
  const head = gcode.slice(0, 64 * 1024);
  const tail = gcode.length > 128 * 1024 ? gcode.slice(gcode.length - 64 * 1024) : '';
  const lines = [...head.split('\n'), ...tail.split('\n')];

  let layerCount: number | undefined;
  let maxZHeight: number | undefined;
  let layerHeight: number | undefined;
  let modelPrintTimeSeconds: number | undefined;
  let totalEstimatedTimeSeconds: number | undefined;
  let filamentWeights: readonly number[] | undefined;
  let filamentLengths: readonly number[] | undefined;
  let filamentSlots: readonly number[] | undefined;

  for (const line of lines) {
    const field = parseHeaderLine(line);
    if (field === undefined) continue;
    const { key, value } = field;

    switch (key) {
      case 'total layer number':
        layerCount ??= firstNumber(value);
        break;
      case 'max_z_height':
        maxZHeight ??= firstNumber(value);
        break;
      case 'layer_height':
        layerHeight ??= firstNumber(value);
        break;
      case 'total filament weight [g]':
        filamentWeights ??= numberList(value);
        break;
      case 'total filament length [mm]':
        filamentLengths ??= numberList(value);
        break;
      case 'filament': {
        // Accept only a list of positive integers: these are filament slot numbers, not setting values.
        const slots = numberList(value);
        if (slots !== undefined && slots.every((slot) => Number.isInteger(slot) && slot > 0)) {
          filamentSlots ??= slots;
        }
        break;
      }
      case 'model printing time': {
        // This line packs two durations together:
        //   `8m 45s; total estimated time: 9m 5s`
        // Split on the semicolon first, otherwise the two durations get added together.
        const [printing, ...rest] = value.split(';');
        modelPrintTimeSeconds ??= parseDurationSeconds(printing ?? '');
        const trailing = rest.join(';');
        const colon = trailing.indexOf(':');
        if (colon >= 0) {
          totalEstimatedTimeSeconds ??= parseDurationSeconds(trailing.slice(colon + 1));
        }
        break;
      }
      case 'total estimated time':
        totalEstimatedTimeSeconds ??= parseDurationSeconds(value);
        break;
      default:
        break;
    }
  }

  if (layerCount === undefined || maxZHeight === undefined || layerHeight === undefined) {
    return undefined;
  }

  const filamentBreakdown = breakdown(filamentWeights, filamentLengths, filamentSlots);

  return {
    layerCount,
    maxZHeight,
    layerHeight,
    ...(modelPrintTimeSeconds === undefined ? {} : { modelPrintTimeSeconds }),
    ...(totalEstimatedTimeSeconds === undefined ? {} : { totalEstimatedTimeSeconds }),
    ...(filamentWeights === undefined ? {} : { filamentGrams: sum(filamentWeights) }),
    ...(filamentLengths === undefined ? {} : { filamentLengthMm: sum(filamentLengths) }),
    ...(filamentBreakdown === undefined ? {} : { filamentBreakdown }),
  };
}

/**
 * For multi-colour prints, list usage per colour. Not returned for a single colour, since it
 * would only repeat the total. Slot numbers are used only when their count matches the usage
 * fields; if they do not line up, they are not forced to fit.
 */
function breakdown(
  weights: readonly number[] | undefined,
  lengths: readonly number[] | undefined,
  slots: readonly number[] | undefined,
): readonly FilamentUsage[] | undefined {
  const count = Math.max(weights?.length ?? 0, lengths?.length ?? 0);
  if (count < 2) return undefined;
  const slotsMatch = slots?.length === count;

  return Array.from({ length: count }, (_, index) => {
    const slot = slotsMatch ? slots?.[index] : undefined;
    const grams = weights?.length === count ? weights[index] : undefined;
    const lengthMm = lengths?.length === count ? lengths[index] : undefined;
    return {
      ...(slot === undefined ? {} : { filament: slot }),
      ...(grams === undefined ? {} : { grams }),
      ...(lengthMm === undefined ? {} : { lengthMm }),
    };
  });
}

/** Turn seconds into a human-readable string, used in the summary sentence of tool replies. */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.round(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}
