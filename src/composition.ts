import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BambuStudioCli, defaultExecutablePath } from './adapters/bambu-studio-cli.js';
import { HandoffCatalog, MAKERWORLD, PRINTABLES } from './adapters/handoff-catalog.js';
import { NodePresetStore, defaultDataDir } from './adapters/node-preset-store.js';
import { ThingiverseCatalog } from './adapters/thingiverse-catalog.js';
import { BambuService } from './application/bambu-service.js';
import type { ModelCatalog } from './ports/model-catalog.js';

export type CompositionOptions = {
  readonly dataDir?: string;
  readonly slicerPath?: string;
  readonly outputDir?: string;
  readonly modelRoots?: readonly string[];
  readonly thingiverseToken?: string;
  readonly sliceTimeoutMs?: number;
};

export function createBambuService(version: string, options: CompositionOptions = {}): BambuService {
  const presets = new NodePresetStore(options.dataDir ?? defaultDataDir());

  const slicer = new BambuStudioCli(presets, {
    executablePath: options.slicerPath ?? defaultExecutablePath(),
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
    ...(options.sliceTimeoutMs === undefined ? {} : { timeoutMs: options.sliceTimeoutMs }),
  });

  const catalogs: readonly ModelCatalog[] = [
    new ThingiverseCatalog(options.thingiverseToken),
    new HandoffCatalog(MAKERWORLD),
    new HandoffCatalog(PRINTABLES),
  ];

  // 輸出目錄本身也允許讀取：切完的 3MF 可以直接再拿去檢查。
  const modelRoots = [
    ...(options.modelRoots ?? []),
    ...(options.outputDir === undefined ? [] : [options.outputDir]),
  ].map((root) => resolve(root));

  const outputDir = options.outputDir;

  return new BambuService({
    presets,
    slicer,
    catalogs,
    readModelFile: (path) => readFileSync(path),
    ...(outputDir === undefined
      ? {}
      : {
          writeOutputFile: (fileName: string, data: Buffer): string => {
            // 檔名不接受路徑分隔符：輸出一律留在設定的目錄內，不讓呼叫端穿越出去。
            if (/[\\/]/.test(fileName)) {
              throw new Error(`輸出檔名不得包含路徑分隔符：${fileName}`);
            }
            mkdirSync(outputDir, { recursive: true });
            const target = join(outputDir, fileName);
            writeFileSync(target, data);
            return target;
          },
        }),
    allowedModelRoots: modelRoots,
    version,
    currentSelection: presets.currentSelection(),
  });
}
