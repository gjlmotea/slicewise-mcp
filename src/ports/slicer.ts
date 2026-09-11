import type { SliceRequest, SliceResult } from '../domain/contracts.js';

/** 切片引擎：BambuStudio 的命令列模式。 */
export interface Slicer {
  /** 執行檔路徑，用於狀態回報。 */
  readonly executablePath: string;

  /** 執行檔是否存在且可執行。 */
  available(): boolean;

  /** 讀取 CLI 自報的版本字串。 */
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
