import type {
  ModelCatalog,
  ModelSearchHit,
  ModelSearchResult,
} from '../ports/model-catalog.js';

/**
 * Thingiverse official REST API.
 *
 * Of the three major model platforms, this is the only one with a formal developer
 * interface and App Token flow, so it is the only one that may be marked `official-api`.
 *
 * Apply for a token at https://www.thingiverse.com/developers and provide it through
 * the `THINGIVERSE_TOKEN` environment variable; it is never committed to version
 * control or written into any output.
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
          'THINGIVERSE_TOKEN is not set, so the official API cannot be called.',
          'Apply for a token: https://www.thingiverse.com/developers',
          'Until then, only a search link can be provided for a person to open.',
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
            `Thingiverse API responded ${response.status}.` +
              (response.status === 401 ? ' The token is invalid or has been revoked.' : ''),
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
          `Thingiverse API call failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseHits(payload: unknown, limit: number): readonly ModelSearchHit[] {
  // The API sometimes returns an array and sometimes { hits: [...] }. Accept both.
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
