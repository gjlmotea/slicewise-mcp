import type {
  ModelCatalog,
  ModelSearchHit,
  ModelSearchResult,
} from '../ports/model-catalog.js';

/**
 * Thingiverse 官方 REST API。
 *
 * 這是三大模型平台裡唯一有正式開發者介面與 App Token 流程的一家，
 * 所以只有它能標記為 `official-api`。
 *
 * Token 從 https://www.thingiverse.com/developers 申請，
 * 以 `THINGIVERSE_TOKEN` 環境變數提供；不進版控、不寫進任何輸出。
 */

const ENDPOINT = 'https://api.thingiverse.com';
const TIMEOUT_MS = 15_000;

export class ThingiverseCatalog implements ModelCatalog {
  readonly source = 'thingiverse';
  readonly integration = 'official-api' as const;
  readonly #token: string | undefined;

  constructor(token: string | undefined) {
    this.#token = token === undefined || token.trim() === '' ? undefined : token.trim();
  }

  ready(): boolean {
    return this.#token !== undefined;
  }

  async search(query: string, limit: number): Promise<ModelSearchResult> {
    if (this.#token === undefined) {
      return {
        source: this.source,
        integration: this.integration,
        hits: [],
        handoffUrl: `https://www.thingiverse.com/search?q=${encodeURIComponent(query)}&type=things`,
        notes: [
          '未設定 THINGIVERSE_TOKEN，無法呼叫官方 API。',
          'Token 申請：https://www.thingiverse.com/developers',
          '在此之前只能提供查詢連結由人自行開啟。',
        ],
      };
    }

    const url = new URL(`${ENDPOINT}/search/${encodeURIComponent(query)}`);
    url.searchParams.set('type', 'things');
    url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 30)));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          source: this.source,
          integration: this.integration,
          hits: [],
          notes: [
            `Thingiverse API 回應 ${response.status}。` +
              (response.status === 401 ? ' Token 無效或已撤銷。' : ''),
          ],
        };
      }

      const payload: unknown = await response.json();
      return {
        source: this.source,
        integration: this.integration,
        hits: parseHits(payload, limit),
        notes: [],
      };
    } catch (error) {
      return {
        source: this.source,
        integration: this.integration,
        hits: [],
        notes: [
          `呼叫 Thingiverse API 失敗：${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseHits(payload: unknown, limit: number): readonly ModelSearchHit[] {
  // API 有時回傳陣列，有時回傳 { hits: [...] }。兩種都接。
  const items = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { hits?: unknown }).hits)
      ? ((payload as { hits: unknown[] }).hits)
      : [];

  const hits: ModelSearchHit[] = [];
  for (const item of items.slice(0, limit)) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record['id'];
    const name = record['name'];
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof name !== 'string') continue;

    const creator = record['creator'];
    const creatorName =
      typeof creator === 'object' && creator !== null
        ? (creator as Record<string, unknown>)['name']
        : undefined;

    hits.push({
      id: String(id),
      title: name,
      url: typeof record['public_url'] === 'string'
        ? record['public_url']
        : `https://www.thingiverse.com/thing:${String(id)}`,
      ...(typeof creatorName === 'string' ? { creator: creatorName } : {}),
      ...(typeof record['license'] === 'string' ? { license: record['license'] } : {}),
      ...(typeof record['thumbnail'] === 'string' ? { thumbnailUrl: record['thumbnail'] } : {}),
      ...(typeof record['like_count'] === 'number' ? { likes: record['like_count'] } : {}),
      ...(typeof record['download_count'] === 'number'
        ? { downloads: record['download_count'] }
        : {}),
    });
  }
  return hits;
}
