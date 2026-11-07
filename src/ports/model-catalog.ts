/**
 * Model platform catalog.
 *
 * Principle: never pass browser automation off as an API.
 * A platform without an official public interface is `handoff-only`: we only generate a search
 * link and hand it to a human, instead of using login cookies, private endpoints or page
 * selectors to pretend we have an API.
 */

export type CatalogIntegration = 'official-api' | 'handoff-only';

export type ModelSearchHit = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly creator?: string;
  readonly license?: string;
  readonly thumbnailUrl?: string;
  readonly likes?: number;
  readonly downloads?: number;
};

export type ModelSearchResult = {
  readonly source: string;
  readonly integration: CatalogIntegration;
  readonly hits: readonly ModelSearchHit[];
  /** For `handoff-only`: the search URL for a human to open. */
  readonly handoffUrl?: string;
  /** Why only a handoff is possible, or the limits of this search. */
  readonly notes: readonly string[];
};

export interface ModelCatalog {
  readonly source: string;
  readonly integration: CatalogIntegration;
  /** Whether credentials are in place. False for `official-api` when the token is missing. */
  ready(): boolean;
  search(query: string, limit: number): Promise<ModelSearchResult>;
}
