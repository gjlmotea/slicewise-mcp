import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditOverrides } from '../../src/adapters/bambu-studio-cli.js';
import {
  BambuService,
  PathNotAllowedError,
  type BambuServiceDependencies,
} from '../../src/application/bambu-service.js';
import type { PresetIndexEntry, PresetKind, SliceRequest, SliceResult } from '../../src/domain/contracts.js';
import { resolvePreset, type RawPreset } from '../../src/domain/presets/resolver.js';
import type { ModelCatalog, ModelSearchResult } from '../../src/ports/model-catalog.js';
import type { PresetStore, WriteUserPresetRequest, WriteUserPresetResult } from '../../src/ports/preset-store.js';
import type { Slicer } from '../../src/ports/slicer.js';
import { boxTriangles, toBinaryStl } from '../fixtures/geometry.js';

const PRESETS: Record<string, Record<string, unknown>> = {
  base: {
    type: 'process',
    name: 'base',
    instantiation: 'false',
    layer_height: '0.2',
    sparse_infill_density: '15%',
  },
  leaf: {
    type: 'process',
    name: 'leaf',
    inherits: 'base',
    instantiation: 'true',
    outer_wall_speed: '200',
  },
};

class FakePresetStore implements PresetStore {
  readonly dataDir = '/fake/data';
  readonly profileId = 'test-profile';
  readonly written: WriteUserPresetRequest[] = [];
  readonly userPresets = new Map<string, RawPreset>();

  list(kind: PresetKind): readonly PresetIndexEntry[] {
    if (kind !== 'process') return [];
    return [
      { name: 'base', kind, origin: 'system', relativePath: 'base.json', instantiable: false },
      {
        name: 'leaf',
        kind,
        origin: 'system',
        relativePath: 'leaf.json',
        instantiable: true,
        inherits: 'base',
      },
    ];
  }

  readRaw(name: string, kind: PresetKind): RawPreset | undefined {
    const user = this.userPresets.get(`${kind}:${name}`);
    if (user !== undefined) return user;
    const body = PRESETS[name];
    return body === undefined ? undefined : { name, kind, origin: 'system', body };
  }

  resolve(name: string, kind: PresetKind) {
    return resolvePreset(name, kind, (candidate, candidateKind) =>
      this.readRaw(candidate, candidateKind),
    );
  }

  writeUserPreset(request: WriteUserPresetRequest): WriteUserPresetResult {
    this.written.push(request);
    this.userPresets.set(`${request.kind}:${request.name}`, {
      name: request.name,
      kind: request.kind,
      origin: 'user',
      body: {
        type: request.kind,
        name: request.name,
        from: 'User',
        inherits: request.inherits,
        ...request.overrides,
      },
    });
    return { path: `/fake/data/user/${request.name}.json`, created: true, overwritten: false };
  }
}

class FakeSlicer implements Slicer {
  readonly executablePath = '/fake/BambuStudio';
  readonly outputDir = '/fake/out';
  lastRequest: SliceRequest | undefined;

  available(): boolean {
    return true;
  }

  version(): Promise<string | undefined> {
    return Promise.resolve('02.07.01.62');
  }

  slice(request: SliceRequest): Promise<SliceResult> {
    this.lastRequest = request;
    return Promise.resolve({
      ok: true,
      outputPath: '/fake/out/model.gcode.3mf',
      stats: { layerCount: 72, maxZHeight: 20.08, layerHeight: 0.28 },
      appliedSettings: { layer_height: '0.28' },
      overrideAudit: [],
      warnings: [],
    });
  }
}

class FakeCatalog implements ModelCatalog {
  constructor(
    readonly source: string,
    readonly integration: 'official-api' | 'handoff-only',
  ) {}

  ready(): boolean {
    return true;
  }

  search(query: string): Promise<ModelSearchResult> {
    return Promise.resolve({
      source: this.source,
      integration: this.integration,
      hits: [{ id: '1', title: `${query} result`, url: 'https://example.invalid/1' }],
      notes: [],
    });
  }
}

const MODEL_ROOT = '/allowed/models';
const CUBE_STL = toBinaryStl(boxTriangles([20, 20, 20]));

function makeService(
  overrides: Partial<BambuServiceDependencies> = {},
  // Under `exactOptionalPropertyTypes`, "absent" and "present but undefined" are different things,
  // so simulating an unset output directory means omitting the field entirely, not passing undefined.
  options: { readonly withWriter?: boolean } = {},
): {
  service: BambuService;
  presets: FakePresetStore;
  slicer: FakeSlicer;
  written: Map<string, Buffer>;
} {
  const presets = new FakePresetStore();
  const slicer = new FakeSlicer();
  const written = new Map<string, Buffer>();
  const service = new BambuService({
    presets,
    slicer,
    catalogs: [new FakeCatalog('thingiverse', 'official-api')],
    readModelFile: () => CUBE_STL,
    ...(options.withWriter === false
      ? {}
      : {
          writeOutputFile: (fileName: string, data: Buffer): string => {
            written.set(fileName, data);
            return `/fake/out/${fileName}`;
          },
        }),
    allowedModelRoots: [MODEL_ROOT],
    version: '0.1.0',
    currentSelection: { machine: 'P1S', process: 'leaf', filaments: ['PLA'] },
    ...overrides,
  });
  return { service, presets, slicer, written };
}

describe('path allow-list', () => {
  it('reads files inside the allow-list', () => {
    const { service } = makeService();
    expect(() => service.inspect(join(MODEL_ROOT, 'cube.stl'))).not.toThrow();
  });

  it('rejects every file outside the allow-list', () => {
    const { service } = makeService();
    expect(() => service.inspect('/etc/passwd')).toThrow(PathNotAllowedError);
  });

  it('blocks .. path traversal', () => {
    const { service } = makeService();
    expect(() => service.inspect(join(MODEL_ROOT, '..', '..', 'etc', 'passwd'))).toThrow(
      PathNotAllowedError,
    );
  });

  it('does not treat a sibling directory with the same prefix as allowed', () => {
    // `/allowed/models-evil` must not pass the `/allowed/models` check just because the strings share a prefix.
    const { service } = makeService();
    expect(() => service.inspect('/allowed/models-evil/cube.stl')).toThrow(PathNotAllowedError);
  });

  it('rejects everything and explains why when no allowed directory is configured', () => {
    const { service } = makeService({ allowedModelRoots: [] });
    expect(() => service.inspect('/anything/cube.stl')).toThrow(/BAMBU_MODEL_DIR/);
  });
});

describe('listPresets', () => {
  it('excludes inheritance-only intermediate layers by default', () => {
    const { service } = makeService();
    const result = service.listPresets('process');
    expect(result.entries.map((entry) => entry.name)).toEqual(['leaf']);
  });

  it('can include intermediate layers on request', () => {
    const { service } = makeService();
    const result = service.listPresets('process', { instantiableOnly: false });
    expect(result.entries).toHaveLength(2);
  });

  it('filters names case-insensitively', () => {
    const { service } = makeService();
    expect(service.listPresets('process', { search: 'LEAF' }).entries).toHaveLength(1);
  });
});

describe('resolvePreset', () => {
  it('returns the flattened result with source layers', () => {
    const { service } = makeService();
    const resolved = service.resolvePreset('leaf', 'process');
    expect(resolved.settings['sparse_infill_density']).toBe('15%');
    expect(resolved.provenance['sparse_infill_density']).toBe('base');
  });

  it('keys selects only the named parameters', () => {
    const { service } = makeService();
    const resolved = service.resolvePreset('leaf', 'process', ['layer_height']);
    expect(Object.keys(resolved.settings)).toEqual(['layer_height']);
    // The inheritance chain is still reported in full.
    expect(resolved.inheritanceChain).toEqual(['leaf', 'base']);
  });
});

describe('saveUserPreset', () => {
  it('warns when overriding a key the parent does not have', () => {
    const { service } = makeService();
    const { warnings } = service.saveUserPreset({
      name: 'mine',
      kind: 'process',
      inherits: 'leaf',
      overrides: { tpyo_parameter: '1' },
    });
    expect(warnings.some((warning) => warning.includes('tpyo_parameter'))).toBe(true);
  });

  it('warns when outside the recommended range but still writes', () => {
    const { service, presets } = makeService();
    const { warnings } = service.saveUserPreset({
      name: 'thick',
      kind: 'process',
      inherits: 'leaf',
      overrides: { layer_height: '0.9' },
    });
    expect(warnings.some((warning) => warning.includes('above the recommended maximum'))).toBe(true);
    expect(presets.written).toHaveLength(1);
  });
});

describe('optimizePrintInPlacePreset', () => {
  it('creates a ready-to-use stable variant from the current system preset', () => {
    const { service, presets } = makeService();
    const optimized = service.optimizePrintInPlacePreset({ name: 'gear-safe' });

    expect(optimized.sourcePreset).toBe('leaf');
    expect(optimized.basePreset).toBe('leaf');
    expect(optimized.overrides).toMatchObject({
      initial_layer_speed: '20',
      initial_layer_infill_speed: '30',
      outer_wall_speed: '60',
      reduce_crossing_wall: '1',
      top_surface_pattern: 'monotonicline',
      ironing_type: 'no ironing',
      fuzzy_skin: 'none',
      brim_type: 'no_brim',
    });
    expect(presets.written.at(-1)?.inherits).toBe('leaf');
  });

  it('keeps leaf corrections and inherits the system preset directly when optimising an existing user preset', () => {
    const { service, presets } = makeService();
    service.saveUserPreset({
      name: 'gear-original',
      kind: 'process',
      inherits: 'leaf',
      overrides: {
        xy_hole_compensation: '0.05',
        elefant_foot_compensation: '0.25',
      },
    });

    const optimized = service.optimizePrintInPlacePreset({
      name: 'gear-auto',
      processPreset: 'gear-original',
    });

    expect(optimized.basePreset).toBe('leaf');
    expect(optimized.preservedKeys).toEqual([
      'elefant_foot_compensation',
      'xy_hole_compensation',
    ]);
    expect(optimized.overrides['xy_hole_compensation']).toBe('0.05');
    expect(optimized.overrides['elefant_foot_compensation']).toBe('0.25');
    expect(presets.written.at(-1)?.inherits).toBe('leaf');
  });
});

describe('diagnose', () => {
  it('returns ordered remedies when a symptom matches', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '邊角翹起來了' });
    expect(result.matched[0]?.id).toBe('warping');
    expect(result.matched[0]?.remedies.length).toBeGreaterThan(0);
  });

  it('explains why it does not guess when nothing matches', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '完全無關的描述' });
    expect(result.matched).toHaveLength(0);
    expect(result.note).toMatch(/Fuzzy guessing is deliberately not done/);
    // Still offers the list of choices so the caller can take over.
    expect(result.available.length).toBeGreaterThan(0);
  });

  it('includes the material note when one exists', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '翹邊', material: 'abs' });
    expect(result.matched[0]?.materialNote).toMatch(/High shrinkage/);
  });
});

describe('slice', () => {
  it('fills missing presets from the current Studio selection', async () => {
    const { service, slicer } = makeService();
    await service.slice({ modelPath: join(MODEL_ROOT, 'cube.stl') });
    expect(slicer.lastRequest?.machinePreset).toBe('P1S');
    expect(slicer.lastRequest?.filamentPresets).toEqual(['PLA']);
  });

  it('fails explicitly when there are neither presets nor defaults', async () => {
    const { service } = makeService({ currentSelection: {} });
    const result = await service.slice({ modelPath: join(MODEL_ROOT, 'cube.stl') });
    expect(result.ok).toBe(false);
  });

  it('throws when the model path is outside the allowed directories', async () => {
    const { service } = makeService();
    await expect(service.slice({ modelPath: '/etc/passwd' })).rejects.toThrow(PathNotAllowedError);
  });
});

describe('auditOverrides', () => {
  it('treats matching values as honoured', () => {
    const audit = auditOverrides({ layer_height: '0.28' }, { layer_height: '0.28' });
    expect(audit[0]?.honoured).toBe(true);
  });

  it('marks differing values as not honoured', () => {
    const audit = auditOverrides({ layer_height: '0.28' }, { layer_height: '0.2' });
    expect(audit[0]?.honoured).toBe(false);
    expect(audit[0]?.applied).toBe('0.2');
  });

  it('marks a key absent from the output as not honoured', () => {
    const audit = auditOverrides({ missing_key: '1' }, {});
    expect(audit[0]?.honoured).toBe(false);
    expect(audit[0]?.applied).toBeUndefined();
  });

  it('does not treat percent-sign or number-format differences as not honoured', () => {
    // The user gives "15" and the output writes "15%"; these are the same thing.
    expect(auditOverrides({ sparse_infill_density: '15' }, { sparse_infill_density: '15%' })[0]?.honoured).toBe(true);
    expect(auditOverrides({ layer_height: '0.28' }, { layer_height: '0.280000' })[0]?.honoured).toBe(true);
  });
});

describe('composeModel', () => {
  const cubePath = join(MODEL_ROOT, 'cube.stl');

  it('composes a body and a negative volume into one 3MF', () => {
    const { service, written } = makeService();
    const result = service.composeModel({
      name: 'holed',
      basePath: cubePath,
      parts: [
        {
          name: 'hole',
          subtype: 'negative_part',
          shape: { kind: 'cylinder', diameter: 6, height: 30 },
          position: { x: 10, y: 10, z: 10 },
        },
      ],
    });

    expect(result.outputPath).toBe('/fake/out/holed.3mf');
    expect(written.has('holed.3mf')).toBe(true);
    expect(result.parts.map((part) => part.subtype)).toEqual(['normal_part', 'negative_part']);
  });

  it('warns about parts that do not intersect the body', () => {
    // Such a part produces a valid but ineffective 3MF: nothing changes after slicing, and nobody knows why.
    const { service } = makeService();
    const result = service.composeModel({
      name: 'miss',
      basePath: cubePath,
      parts: [
        {
          name: 'far-away',
          subtype: 'negative_part',
          shape: { kind: 'box', size: { x: 5, y: 5, z: 5 } },
          position: { x: 500, y: 500, z: 500 },
        },
      ],
    });

    expect(result.parts[1]?.intersectsBody).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('does not intersect the body'))).toBe(true);
  });

  it('rejects a misspelled part subtype', () => {
    const { service } = makeService();
    expect(() =>
      service.composeModel({
        name: 'bad',
        basePath: cubePath,
        parts: [
          {
            name: 'hole',
            subtype: 'negative-part' as never,
            shape: { kind: 'box', size: { x: 5, y: 5, z: 5 } },
          },
        ],
      }),
    ).toThrow(/silently falls back to normal_part/);
  });

  it('warns when part settings are on a non-modifier subtype', () => {
    const { service } = makeService();
    const result = service.composeModel({
      name: 'x',
      basePath: cubePath,
      parts: [
        {
          name: 'hole',
          subtype: 'negative_part',
          shape: { kind: 'box', size: { x: 5, y: 5, z: 5 } },
          settings: { wall_loops: '5' },
        },
      ],
    });
    expect(result.warnings.some((warning) => warning.includes('only on modifier_part'))).toBe(true);
  });

  it('warns when part settings use a nonexistent parameter', () => {
    const { service } = makeService();
    const result = service.composeModel({
      name: 'x',
      basePath: cubePath,
      parts: [
        {
          name: 'dense',
          subtype: 'modifier_part',
          shape: { kind: 'box', size: { x: 5, y: 5, z: 5 } },
          settings: { wall_lops: '5' },
        },
      ],
    });
    expect(result.warnings.some((warning) => warning.includes('wall_lops'))).toBe(true);
  });

  it('rejects a body path outside the allowed directories', () => {
    const { service } = makeService();
    expect(() =>
      service.composeModel({ name: 'x', basePath: '/etc/passwd', parts: [] }),
    ).toThrow(PathNotAllowedError);
  });

  it('refuses to write when no output directory is configured', () => {
    const { service } = makeService({}, { withWriter: false });
    expect(() => service.composeModel({ name: 'x', basePath: cubePath, parts: [] })).toThrow(
      /BAMBU_OUTPUT_DIR/,
    );
  });
});

describe('status', () => {
  it('reports the flattening flag and each platform integration level', () => {
    const { service } = makeService();
    const status = service.status();
    expect(status.inheritanceFlattening).toBe(true);
    expect(status.catalogs[0]).toEqual({
      source: 'thingiverse',
      integration: 'official-api',
      ready: true,
    });
  });
});
