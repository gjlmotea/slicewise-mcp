import type { PresetIndexEntry, PresetKind, PresetValue, ResolvedPreset } from '../domain/contracts.js';
import type { RawPreset } from '../domain/presets/resolver.js';

/**
 * Preset store: BambuStudio's data directory.
 *
 * Reads cover both the system vendor profiles and the user's own profiles;
 * writes go only into the user profile directory and never touch the system directories.
 */
export interface PresetStore {
  /** Data root directory, used in status reports and error messages. */
  readonly dataDir: string;

  /** Name of the currently bound user profile directory (BambuStudio names it after the account id). */
  readonly profileId: string | undefined;

  /** Lists the index; does not read preset contents. */
  list(kind: PresetKind): readonly PresetIndexEntry[];

  /** Reads the raw JSON of a single preset. */
  readRaw(name: string, kind: PresetKind): RawPreset | undefined;

  /** Flattens the inheritance chain. */
  resolve(name: string, kind: PresetKind): ResolvedPreset;

  /**
   * Writes a user preset so it shows up in Bambu Studio's dropdowns.
   *
   * This is the only legitimate way to get parameters adjusted by an AI into the GUI:
   * BambuStudio has no plugin API (see bambulab/BambuStudio#9614),
   * but it scans the user profile directory on startup.
   */
  writeUserPreset(request: WriteUserPresetRequest): WriteUserPresetResult;
}

export type WriteUserPresetRequest = {
  readonly name: string;
  readonly kind: PresetKind;
  /** The system preset to inherit from; a user preset always hangs directly under a system preset. */
  readonly inherits: string;
  /** Override values relative to the parent. */
  readonly overrides: Readonly<Record<string, PresetValue>>;
  /** Whether to overwrite an existing preset with the same name. Defaults to false. */
  readonly overwrite?: boolean;
};

export type WriteUserPresetResult = {
  readonly path: string;
  readonly created: boolean;
  readonly overwritten: boolean;
};

export class PresetStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetStoreError';
  }
}
