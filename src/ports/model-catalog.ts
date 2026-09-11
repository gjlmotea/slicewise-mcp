/**
 * 模型平台目錄。
 *
 * `gjlmotea/vibe/mcp` 的架構原則第 5 條：不把瀏覽器自動化冒充 API。
 * 沒有官方公開介面的平台，狀態就是 `handoff-only`，我們只產生查詢連結交給人，
 * 不用登入 cookie、私有 endpoint 或畫面 selector 假裝自己有 API。
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
  /** `handoff-only` 時給人類點的查詢網址。 */
  readonly handoffUrl?: string;
  /** 為什麼只能交接，或這次查詢的限制。 */
  readonly notes: readonly string[];
};

export interface ModelCatalog {
  readonly source: string;
  readonly integration: CatalogIntegration;
  /** 是否已備妥憑證。`official-api` 缺 token 時為 false。 */
  ready(): boolean;
  search(query: string, limit: number): Promise<ModelSearchResult>;
}
