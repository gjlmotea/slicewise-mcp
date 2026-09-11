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
  // `exactOptionalPropertyTypes` 下「不存在」與「存在但為 undefined」是兩件事，
  // 所以要模擬未設定輸出目錄必須整個欄位不出現，不能傳 undefined。
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

describe('路徑允許清單', () => {
  it('允許清單內的檔案可以讀', () => {
    const { service } = makeService();
    expect(() => service.inspect(join(MODEL_ROOT, 'cube.stl'))).not.toThrow();
  });

  it('清單外的檔案一律拒絕', () => {
    const { service } = makeService();
    expect(() => service.inspect('/etc/passwd')).toThrow(PathNotAllowedError);
  });

  it('擋掉 .. 路徑穿越', () => {
    const { service } = makeService();
    expect(() => service.inspect(join(MODEL_ROOT, '..', '..', 'etc', 'passwd'))).toThrow(
      PathNotAllowedError,
    );
  });

  it('前綴相同但不同層級的目錄不算在允許範圍內', () => {
    // `/allowed/models-evil` 不能因為字串開頭相同就通過 `/allowed/models` 的檢查。
    const { service } = makeService();
    expect(() => service.inspect('/allowed/models-evil/cube.stl')).toThrow(PathNotAllowedError);
  });

  it('未設定任何允許目錄時全部拒絕，並說明原因', () => {
    const { service } = makeService({ allowedModelRoots: [] });
    expect(() => service.inspect('/anything/cube.stl')).toThrow(/BAMBU_MODEL_DIR/);
  });
});

describe('listPresets', () => {
  it('預設排除只供繼承的中間層', () => {
    const { service } = makeService();
    const result = service.listPresets('process');
    expect(result.entries.map((entry) => entry.name)).toEqual(['leaf']);
  });

  it('可以要求包含中間層', () => {
    const { service } = makeService();
    const result = service.listPresets('process', { instantiableOnly: false });
    expect(result.entries).toHaveLength(2);
  });

  it('名稱過濾不分大小寫', () => {
    const { service } = makeService();
    expect(service.listPresets('process', { search: 'LEAF' }).entries).toHaveLength(1);
  });
});

describe('resolvePreset', () => {
  it('回傳展平結果與來源層', () => {
    const { service } = makeService();
    const resolved = service.resolvePreset('leaf', 'process');
    expect(resolved.settings['sparse_infill_density']).toBe('15%');
    expect(resolved.provenance['sparse_infill_density']).toBe('base');
  });

  it('keys 只挑指定參數', () => {
    const { service } = makeService();
    const resolved = service.resolvePreset('leaf', 'process', ['layer_height']);
    expect(Object.keys(resolved.settings)).toEqual(['layer_height']);
    // 繼承鏈仍然完整回報。
    expect(resolved.inheritanceChain).toEqual(['leaf', 'base']);
  });
});

describe('saveUserPreset', () => {
  it('覆寫父層不存在的 key 時提出警告', () => {
    const { service } = makeService();
    const { warnings } = service.saveUserPreset({
      name: 'mine',
      kind: 'process',
      inherits: 'leaf',
      overrides: { 打錯的參數: '1' },
    });
    expect(warnings.some((warning) => warning.includes('打錯的參數'))).toBe(true);
  });

  it('超出建議區間時提出警告但仍然寫入', () => {
    const { service, presets } = makeService();
    const { warnings } = service.saveUserPreset({
      name: 'thick',
      kind: 'process',
      inherits: 'leaf',
      overrides: { layer_height: '0.9' },
    });
    expect(warnings.some((warning) => warning.includes('高於建議上限'))).toBe(true);
    expect(presets.written).toHaveLength(1);
  });
});

describe('optimizePrintInPlacePreset', () => {
  it('從目前原廠 preset 建立可直接使用的穩定版', () => {
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

  it('從既有使用者 preset 最佳化時保留葉節點校正並直接繼承原廠', () => {
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
  it('比對到症狀時回傳有序建議', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '邊角翹起來了' });
    expect(result.matched[0]?.id).toBe('warping');
    expect(result.matched[0]?.remedies.length).toBeGreaterThan(0);
  });

  it('比對不到時說明為什麼不猜', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '完全無關的描述' });
    expect(result.matched).toHaveLength(0);
    expect(result.note).toMatch(/不做模糊猜測/);
    // 仍然提供可選清單讓呼叫端接手。
    expect(result.available.length).toBeGreaterThan(0);
  });

  it('材料有對應註記時一併回傳', () => {
    const { service } = makeService();
    const result = service.diagnose({ symptom: '翹邊', material: 'abs' });
    expect(result.matched[0]?.materialNote).toMatch(/收縮率高/);
  });
});

describe('slice', () => {
  it('缺 preset 時用 Studio 目前的選擇補上', async () => {
    const { service, slicer } = makeService();
    await service.slice({ modelPath: join(MODEL_ROOT, 'cube.stl') });
    expect(slicer.lastRequest?.machinePreset).toBe('P1S');
    expect(slicer.lastRequest?.filamentPresets).toEqual(['PLA']);
  });

  it('沒有 preset 也沒有預設值時明確失敗', async () => {
    const { service } = makeService({ currentSelection: {} });
    const result = await service.slice({ modelPath: join(MODEL_ROOT, 'cube.stl') });
    expect(result.ok).toBe(false);
  });

  it('模型路徑不在允許範圍內時拋錯', async () => {
    const { service } = makeService();
    await expect(service.slice({ modelPath: '/etc/passwd' })).rejects.toThrow(PathNotAllowedError);
  });
});

describe('auditOverrides', () => {
  it('值相符時視為已套用', () => {
    const audit = auditOverrides({ layer_height: '0.28' }, { layer_height: '0.28' });
    expect(audit[0]?.honoured).toBe(true);
  });

  it('值不同時標為未生效', () => {
    const audit = auditOverrides({ layer_height: '0.28' }, { layer_height: '0.2' });
    expect(audit[0]?.honoured).toBe(false);
    expect(audit[0]?.applied).toBe('0.2');
  });

  it('產物完全沒有這個 key 時標為未生效', () => {
    const audit = auditOverrides({ 不存在: '1' }, {});
    expect(audit[0]?.honoured).toBe(false);
    expect(audit[0]?.applied).toBeUndefined();
  });

  it('百分號與數值格式差異不算未生效', () => {
    // 使用者給 "15"，產物寫 "15%"；這是同一件事。
    expect(auditOverrides({ sparse_infill_density: '15' }, { sparse_infill_density: '15%' })[0]?.honoured).toBe(true);
    expect(auditOverrides({ layer_height: '0.28' }, { layer_height: '0.280000' })[0]?.honoured).toBe(true);
  });
});

describe('composeModel', () => {
  const cubePath = join(MODEL_ROOT, 'cube.stl');

  it('把本體與挖除體組成一個 3MF', () => {
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

  it('警告與本體沒有交集的零件', () => {
    // 這種零件會產生一個合法但毫無作用的 3MF：切完什麼都沒變，卻不知道為什麼。
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
    expect(result.warnings.some((warning) => warning.includes('沒有交集'))).toBe(true);
  });

  it('拒絕拼錯的零件類型', () => {
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
    ).toThrow(/靜默回退成 normal_part/);
  });

  it('零件設定放在非 modifier 類型時提出警告', () => {
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
    expect(result.warnings.some((warning) => warning.includes('只有 modifier_part'))).toBe(true);
  });

  it('零件設定用了不存在的參數時提出警告', () => {
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

  it('本體路徑不在允許範圍內時拒絕', () => {
    const { service } = makeService();
    expect(() =>
      service.composeModel({ name: 'x', basePath: '/etc/passwd', parts: [] }),
    ).toThrow(PathNotAllowedError);
  });

  it('未設定輸出目錄時拒絕寫檔', () => {
    const { service } = makeService({}, { withWriter: false });
    expect(() => service.composeModel({ name: 'x', basePath: cubePath, parts: [] })).toThrow(
      /BAMBU_OUTPUT_DIR/,
    );
  });
});

describe('status', () => {
  it('回報展平旗標與各平台整合層級', () => {
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
