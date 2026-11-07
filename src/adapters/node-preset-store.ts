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
 * Reads and writes the local BambuStudio data directory.
 *
 * Directory layout (macOS shown):
 * ```
 * ~/Library/Application Support/BambuStudio/
 *   BambuStudio.conf          currently selected machine / process / filament
 *   system/BBL.json           factory preset index (machine 148, of which 89 are G-code templates; process 276, filament 1873)
 *   system/BBL/{machine,process,filament}/*.json
 *   user/<profileId>/{machine,process,filament}/*.json
 * ```
 */

const VENDOR = 'BBL';

/**
 * `<preset name> template <key>`: machine G-code that BambuStudio 02.07+ split out of presets.
 * They are not selectable presets and stay out of the normal index; when flattening they are
 * applied level by level along the inheritance chain (see the resolver's TemplateReader).
 */
const TEMPLATE_ENTRY = /^(.+) template ([a-z][a-z0-9_]*)$/;

type TemplateEntry = {
  readonly name: string;
  /** The single setting key named at the end of the template name. */
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

  /** Keyed by `${kind}:${name}`. A user preset shadows the system preset of the same name. */
  readonly #index: Map<string, IndexedPreset>;
  readonly #cache = new Map<string, RawPreset>();
  /** Keyed by `${kind}:${owner}`, where owner is the name of the preset the template belongs to. */
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

  /** System presets come from the BBL.json index, to avoid scanning 2000+ files. */
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
            // Start with a conservative value; the real instantiation needs a file read, deferred to list().
            instantiable: !name.startsWith('fdm_'),
          },
        });
      }
    }
  }

  /** User presets have no index file, so scan the directory directly. */
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
      // Presets with `instantiation` explicitly "false" are pure inheritance intermediates and cannot be selected in the UI.
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
   * G-code templates named after their owner.
   *
   * The body keeps only the one key the template name specifies: if a template file carries
   * other fields, or lacks that key, it is better not to apply it than to let unexpected
   * values leak into the slicing settings.
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
        `BambuStudio user profile directory not found (${join(this.dataDir, 'user')}). ` +
          'Sign in to Bambu Studio, or at least launch it once, so it creates the profile directory.',
      );
    }

    const safeName = request.name.trim();
    if (safeName === '' || /[\\/:*?"<>|]/.test(safeName)) {
      throw new PresetStoreError(`Invalid preset name: ${request.name}`);
    }

    const parent = this.readRaw(request.inherits, request.kind);
    if (parent === undefined) {
      throw new PresetStoreError(
        `The ${request.kind} preset to inherit from does not exist: ${request.inherits}`,
      );
    }
    if (parent.origin !== 'system') {
      throw new PresetStoreError(
        `Only system presets may be inherited from; ${request.inherits} is a user preset. ` +
          'Multiple levels of user inheritance make it hard to reconcile when Bambu Studio updates its factory profiles.',
      );
    }

    const directory = join(this.dataDir, 'user', this.profileId, request.kind);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${safeName}.json`);

    const exists = existsSync(path);
    if (exists && request.overwrite !== true) {
      throw new PresetStoreError(
        `${path} already exists. Pass overwrite=true explicitly to replace it; an existing preset is never silently overwritten.`,
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

    // Make the newly written preset visible to subsequent resolve() calls immediately.
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

  /** Read the presets currently selected in BambuStudio.conf, used as the tools' defaults. */
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
 * Find the user profile directory name.
 *
 * `app.preset_folder` in BambuStudio.conf is authoritative; if it cannot be read, fall back
 * to the first non-default directory under user/. If none is found the result is undefined,
 * rather than guessing a name and writing files there.
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
