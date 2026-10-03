import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import type {
  PresetIndexEntry,
  PresetKind,
  PresetOrigin,
  ResolvedPreset,
} from '../domain/contracts.js';
import { PRESET_KINDS } from '../domain/contracts.js';
import { resolvePreset, type RawPreset } from '../domain/presets/resolver.js';
import {
  PresetStoreError,
  type PresetStore,
  type WriteUserPresetRequest,
  type WriteUserPresetResult,
} from '../ports/preset-store.js';

/**
 * 讀寫 BambuStudio 本機資料目錄。
 *
 * 目錄結構（macOS 為例）：
 * ```
 * ~/Library/Application Support/BambuStudio/
 *   BambuStudio.conf          目前選用的 machine／process／filament
 *   system/BBL.json           原廠 preset 索引（machine 148，其中 89 個是 G-code 模板；process 276、filament 1873）
 *   system/BBL/{machine,process,filament}/*.json
 *   user/<profileId>/{machine,process,filament}/*.json
 * ```
 */

const VENDOR = 'BBL';

/**
 * `<preset 名稱> template <key>`：BambuStudio 02.07 起從 preset 拆出去的機型 G-code。
 * 它們不是可選用的 preset，不進一般索引；展平時依繼承鏈逐層套用（見 resolver 的 TemplateReader）。
 */
const TEMPLATE_ENTRY = /^(.+) template ([a-z][a-z0-9_]*)$/;

type TemplateEntry = {
  readonly name: string;
  /** 模板名稱尾端指定的那一個設定 key。 */
  readonly key: string;
  readonly absolutePath: string;
};

export function defaultDataDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'BambuStudio');
    case 'win32': {
      const appData = process.env['APPDATA'];
      return appData === undefined || appData === ''
        ? join(home, 'AppData', 'Roaming', 'BambuStudio')
        : join(appData, 'BambuStudio');
    }
    default:
      return join(home, '.config', 'BambuStudio');
  }
}

type IndexedPreset = {
  readonly entry: PresetIndexEntry;
  readonly absolutePath: string;
};

export class NodePresetStore implements PresetStore {
  readonly dataDir: string;
  readonly profileId: string | undefined;
  readonly vendorVersion: string | undefined;

  /** key 為 `${kind}:${name}`。使用者 preset 覆蓋同名原廠 preset。 */
  readonly #index: Map<string, IndexedPreset>;
  readonly #cache = new Map<string, RawPreset>();
  /** key 為 `${kind}:${owner}`，owner 是模板所屬的 preset 名稱。 */
  readonly #templates = new Map<string, TemplateEntry[]>();
  readonly #templateCache = new Map<string, readonly RawPreset[]>();

  constructor(dataDir: string = defaultDataDir()) {
    this.dataDir = dataDir;
    this.profileId = detectProfileId(dataDir);

    const vendorIndexPath = join(dataDir, 'system', `${VENDOR}.json`);
    const vendorIndex = readJson(vendorIndexPath);
    this.vendorVersion = typeof vendorIndex?.['version'] === 'string' ? vendorIndex['version'] : undefined;

    this.#index = new Map();
    this.#indexSystem(vendorIndex, dataDir);
    this.#indexUser(dataDir);
  }

  /** 原廠 preset 走 BBL.json 索引，避免掃描 2000 多個檔案。 */
  #indexSystem(vendorIndex: Record<string, unknown> | undefined, dataDir: string): void {
    if (vendorIndex === undefined) return;
    const systemRoot = join(dataDir, 'system');

    for (const kind of PRESET_KINDS) {
      const list = vendorIndex[`${kind}_list`];
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        const name = record['name'];
        const subPath = record['sub_path'];
        if (typeof name !== 'string' || typeof subPath !== 'string') continue;

        const absolutePath = join(systemRoot, VENDOR, subPath);

        const template = TEMPLATE_ENTRY.exec(name);
        const owner = template?.[1];
        const key = template?.[2];
        if (owner !== undefined && key !== undefined) {
          const bucket = `${kind}:${owner}`;
          const entries = this.#templates.get(bucket) ?? [];
          entries.push({ name, key, absolutePath });
          this.#templates.set(bucket, entries);
          continue;
        }

        this.#index.set(`${kind}:${name}`, {
          absolutePath,
          entry: {
            name,
            kind,
            origin: 'system',
            relativePath: relative(dataDir, absolutePath),
            // 先填保守值；真正的 instantiation 需要讀檔，延後到 list() 時解析。
            instantiable: !name.startsWith('fdm_'),
          },
        });
      }
    }
  }

  /** 使用者 preset 沒有索引檔，直接掃目錄。 */
  #indexUser(dataDir: string): void {
    if (this.profileId === undefined) return;
    const userRoot = join(dataDir, 'user', this.profileId);

    for (const kind of PRESET_KINDS) {
      const directory = join(userRoot, kind);
      if (!existsSync(directory)) continue;

      for (const file of readdirSync(directory)) {
        if (!file.endsWith('.json')) continue;
        const absolutePath = join(directory, file);
        const body = readJson(absolutePath);
        const name = typeof body?.['name'] === 'string' ? body['name'] : file.replace(/\.json$/, '');
        const inherits = typeof body?.['inherits'] === 'string' ? body['inherits'] : undefined;

        this.#index.set(`${kind}:${name}`, {
          absolutePath,
          entry: {
            name,
            kind,
            origin: 'user',
            relativePath: relative(dataDir, absolutePath),
            instantiable: true,
            ...(inherits === undefined ? {} : { inherits }),
          },
        });
      }
    }
  }

  list(kind: PresetKind): readonly PresetIndexEntry[] {
    const entries: PresetIndexEntry[] = [];
    for (const [key, indexed] of this.#index) {
      if (!key.startsWith(`${kind}:`)) continue;
      const raw = this.readRaw(indexed.entry.name, kind);
      const body = raw?.body ?? {};
      const inherits = typeof body['inherits'] === 'string' ? body['inherits'] : undefined;
      // `instantiation` 明確寫 "false" 的是純繼承中間層，不能在 UI 選用。
      const instantiable = body['instantiation'] !== 'false';

      entries.push({
        ...indexed.entry,
        instantiable,
        ...(inherits === undefined ? {} : { inherits }),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  readRaw(name: string, kind: PresetKind): RawPreset | undefined {
    const cacheKey = `${kind}:${name}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const indexed = this.#index.get(cacheKey);
    if (indexed === undefined) return undefined;

    const body = readJson(indexed.absolutePath);
    if (body === undefined) return undefined;

    const raw: RawPreset = {
      name,
      kind,
      origin: indexed.entry.origin,
      body,
    };
    this.#cache.set(cacheKey, raw);
    return raw;
  }

  /**
   * 以 owner 命名的 G-code 模板。
   *
   * body 只保留模板名稱指定的那一個 key：模板檔若夾帶其他欄位，或檔案缺了那個 key，
   * 寧可不套也不要把非預期的值混進切片設定。
   */
  readTemplates(owner: string, kind: PresetKind): readonly RawPreset[] {
    const bucket = `${kind}:${owner}`;
    const cached = this.#templateCache.get(bucket);
    if (cached !== undefined) return cached;

    const templates: RawPreset[] = [];
    const entries = [...(this.#templates.get(bucket) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const value = readJson(entry.absolutePath)?.[entry.key];
      if (value === undefined) continue;
      templates.push({ name: entry.name, kind, origin: 'system', body: { [entry.key]: value } });
    }
    this.#templateCache.set(bucket, templates);
    return templates;
  }

  resolve(name: string, kind: PresetKind): ResolvedPreset {
    return resolvePreset(
      name,
      kind,
      (candidate, candidateKind) => this.readRaw(candidate, candidateKind),
      (owner, ownerKind) => this.readTemplates(owner, ownerKind),
    );
  }

  writeUserPreset(request: WriteUserPresetRequest): WriteUserPresetResult {
    if (this.profileId === undefined) {
      throw new PresetStoreError(
        `找不到 BambuStudio 使用者 profile 目錄（${join(this.dataDir, 'user')}）。` +
          '請先在 Bambu Studio 登入或至少啟動過一次，讓它建立 profile 目錄。',
      );
    }

    const safeName = request.name.trim();
    if (safeName === '' || /[\\/:*?"<>|]/.test(safeName)) {
      throw new PresetStoreError(`preset 名稱不合法：${request.name}`);
    }

    const parent = this.readRaw(request.inherits, request.kind);
    if (parent === undefined) {
      throw new PresetStoreError(
        `要繼承的 ${request.kind} preset 不存在：${request.inherits}`,
      );
    }
    if (parent.origin !== 'system') {
      throw new PresetStoreError(
        `只允許繼承原廠 preset，${request.inherits} 是使用者 preset；` +
          '多層使用者繼承會讓 Bambu Studio 更新原廠 profile 時難以對帳。',
      );
    }

    const directory = join(this.dataDir, 'user', this.profileId, request.kind);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${safeName}.json`);

    const exists = existsSync(path);
    if (exists && request.overwrite !== true) {
      throw new PresetStoreError(
        `${path} 已存在。要取代請明確帶 overwrite=true；不會靜默覆蓋既有 preset。`,
      );
    }

    const body: Record<string, unknown> = {
      type: request.kind,
      name: safeName,
      from: 'User',
      inherits: request.inherits,
      is_custom_defined: '0',
      ...(this.vendorVersion === undefined ? {} : { version: this.vendorVersion }),
    };
    for (const [key, value] of Object.entries(request.overrides)) {
      body[key] = value;
    }

    writeFileSync(path, `${JSON.stringify(body, null, 4)}\n`, 'utf8');

    // 讓後續 resolve() 立刻看得到新寫入的 preset。
    this.#cache.delete(`${request.kind}:${safeName}`);
    this.#index.set(`${request.kind}:${safeName}`, {
      absolutePath: path,
      entry: {
        name: safeName,
        kind: request.kind,
        origin: 'user',
        relativePath: relative(this.dataDir, path),
        instantiable: true,
        inherits: request.inherits,
      },
    });

    return { path, created: !exists, overwritten: exists };
  }

  /** 讀 BambuStudio.conf 目前選用的 preset，作為工具的預設值。 */
  currentSelection(): { machine?: string; process?: string; filaments?: readonly string[] } {
    const conf = readJson(join(this.dataDir, 'BambuStudio.conf'));
    const presets = conf?.['presets'];
    if (typeof presets !== 'object' || presets === null) return {};
    const record = presets as Record<string, unknown>;

    const machine = typeof record['machine'] === 'string' ? record['machine'] : undefined;
    const process_ = typeof record['process'] === 'string' ? record['process'] : undefined;
    const filaments = Array.isArray(record['filaments'])
      ? record['filaments'].filter((item): item is string => typeof item === 'string')
      : undefined;

    return {
      ...(machine === undefined ? {} : { machine }),
      ...(process_ === undefined ? {} : { process: process_ }),
      ...(filaments === undefined ? {} : { filaments }),
    };
  }
}

/**
 * 找出使用者 profile 目錄名。
 *
 * BambuStudio.conf 的 `app.preset_folder` 是權威來源；讀不到時退回掃 user/ 下
 * 第一個非 default 的目錄。找不到就是 undefined，不亂猜一個名字去寫檔。
 */
function detectProfileId(dataDir: string): string | undefined {
  const conf = readJson(join(dataDir, 'BambuStudio.conf'));
  const app = conf?.['app'];
  if (typeof app === 'object' && app !== null) {
    const folder = (app as Record<string, unknown>)['preset_folder'];
    if (typeof folder === 'string' && folder.trim() !== '') return folder.trim();
  }

  const userRoot = join(dataDir, 'user');
  if (!existsSync(userRoot)) return undefined;
  const candidates = readdirSync(userRoot).filter((name) => name !== 'default');
  return candidates[0];
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function presetOriginOf(entry: PresetIndexEntry): PresetOrigin {
  return entry.origin;
}
