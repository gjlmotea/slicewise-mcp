import type { ModelCatalog, ModelSearchResult } from '../ports/model-catalog.js';

/**
 * For platforms without an official API, the only thing done is a manual hand-off:
 * generate a search link.
 *
 * This is a deliberate capability downgrade, not unfinished work:
 *
 * - **MakerWorld**: Bambu Lab's own platform, which still has no public API despite
 *   repeated community requests. Its search endpoint returns empty results to
 *   non-browser clients, and getting around that would mean forging session state.
 * - **Printables**: has a GraphQL endpoint but no official developer programme, so it
 *   may change or be blocked at any time.
 *
 * This project's rule is "never pass off browser automation as an API": when there is
 * no officially supported integration, the status is unsupported, and it is not worked
 * around with login cookies, private endpoints or page selectors. So this only returns links.
 */

export type HandoffCatalogDefinition = {
  readonly source: string;
  readonly buildUrl: (query: string) => string;
  readonly notes: readonly string[];
};

export const MAKERWORLD: HandoffCatalogDefinition = {
  source: 'makerworld',
  buildUrl: (query) => `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(query)}`,
  notes: [
    'MakerWorld has no public API; its search endpoint returns empty results to non-browser clients.',
    'For Bambu printers it is usually the best source, because models come with factory print profiles.',
    'After downloading, pass the .3mf / .stl to bambu_inspect_model and bambu_slice.',
  ],
};

export const PRINTABLES: HandoffCatalogDefinition = {
  source: 'printables',
  buildUrl: (query) => `https://www.printables.com/search/models?q=${encodeURIComponent(query)}`,
  notes: [
    'Printables\' GraphQL endpoint has no official developer programme, so it is not queried automatically.',
    'Documentation and make records are thorough, which suits cases where you need evidence that others have actually printed it successfully.',
  ],
};

export class HandoffCatalog implements ModelCatalog {
  readonly source: string;
  readonly integration = 'handoff-only' as const;
  readonly #definition: HandoffCatalogDefinition;

  constructor(definition: HandoffCatalogDefinition) {
    this.#definition = definition;
    this.source = definition.source;
  }

  ready(): boolean {
    // A hand-off needs no credentials, so it is always available.
    return true;
  }

  search(query: string, _limit: number): Promise<ModelSearchResult> {
    return Promise.resolve({
      source: this.source,
      integration: this.integration,
      hits: [],
      handoffUrl: this.#definition.buildUrl(query),
      notes: this.#definition.notes,
    });
  }
}
