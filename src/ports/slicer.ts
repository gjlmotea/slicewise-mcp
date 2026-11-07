import type { SliceRequest, SliceResult } from '../domain/contracts.js';

/** Slicing engine: BambuStudio's command-line mode. */
export interface Slicer {
  /** Executable path, used in status reports. */
  readonly executablePath: string;

  /** Whether the executable exists and can be run. */
  available(): boolean;

  /** Reads the version string the CLI reports about itself. */
  version(): Promise<string | undefined>;

  slice(request: SliceRequest): Promise<SliceResult>;
}

export class SlicerUnavailableError extends Error {
  constructor(
    message: string,
    readonly executablePath: string,
  ) {
    super(message);
    this.name = 'SlicerUnavailableError';
  }
}
