#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { delimiter } from 'node:path';

import { createBambuService } from './composition.js';
import { log } from './logger.js';
import { createMcpServer } from './server/create-server.js';
import { connectStdio } from './transports/stdio.js';

const PACKAGE_URL = new URL('../package.json', import.meta.url);

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(PACKAGE_URL, 'utf8');
    const parsed = JSON.parse(raw) as { readonly version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** `BAMBU_MODEL_DIR` 允許多個目錄，以平台的 PATH 分隔符分隔。 */
function envList(name: string): readonly string[] {
  const raw = env(name);
  return raw === undefined ? [] : raw.split(delimiter).map((part) => part.trim()).filter((part) => part !== '');
}

function envNumber(name: string): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const version = await readVersion();

  const service = createBambuService(version, {
    ...(env('BAMBU_DATA_DIR') === undefined ? {} : { dataDir: env('BAMBU_DATA_DIR') as string }),
    ...(env('BAMBU_STUDIO_PATH') === undefined ? {} : { slicerPath: env('BAMBU_STUDIO_PATH') as string }),
    ...(env('BAMBU_OUTPUT_DIR') === undefined ? {} : { outputDir: env('BAMBU_OUTPUT_DIR') as string }),
    modelRoots: envList('BAMBU_MODEL_DIR'),
    ...(env('THINGIVERSE_TOKEN') === undefined
      ? {}
      : { thingiverseToken: env('THINGIVERSE_TOKEN') as string }),
    ...(envNumber('BAMBU_SLICE_TIMEOUT_MS') === undefined
      ? {}
      : { sliceTimeoutMs: envNumber('BAMBU_SLICE_TIMEOUT_MS') as number }),
  });

  const server = createMcpServer({ service, version });
  await connectStdio(server);

  const status = service.status();
  log('info', 'ready', {
    version,
    transport: 'stdio',
    slicerAvailable: status.slicerAvailable,
    presetCounts: status.presetCounts,
    modelRoots: status.allowedModelRoots.length,
    outputConfigured: status.outputConfigured,
    // 祕密只記名稱不記值。
    thingiverseToken: env('THINGIVERSE_TOKEN') === undefined ? 'unset' : 'set',
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log('info', 'shutting down', { signal });
    await server.close();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      void shutdown('EPIPE');
      return;
    }
    throw error;
  });
}

main().catch((error: unknown) => {
  log('error', 'fatal', {
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
