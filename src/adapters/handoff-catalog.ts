import type { ModelCatalog, ModelSearchResult } from '../ports/model-catalog.js';

/**
 * 沒有官方 API 的平台，只做「產生查詢連結」的人工交接。
 *
 * 這是刻意的能力降級，不是還沒做完：
 *
 * - **MakerWorld**：Bambu Lab 自家平台，至今沒有公開 API。社群多次要求皆未獲提供。
 *   它的搜尋端點對非瀏覽器來源回傳空結果，繞過去需要偽造 session state。
 * - **Printables**：有 GraphQL 端點但沒有官方開發者方案，隨時可能改動或封鎖。
 *
 * 本專案的原則是「不把瀏覽器自動化冒充 API」：
 * 官方沒有支援的整合介面時，狀態就是 unsupported，不用登入 cookie、
 * 私有 endpoint 或畫面 selector 繞過。所以這裡只回傳連結。
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
    'MakerWorld 沒有公開 API；搜尋端點對非瀏覽器來源回傳空結果。',
    '對 Bambu 機型而言它通常是最佳來源，因為模型附帶原廠列印 profile。',
    '下載後可以把 .3mf／.stl 交給 bambu_inspect_model 與 bambu_slice 接手。',
  ],
};

export const PRINTABLES: HandoffCatalogDefinition = {
  source: 'printables',
  buildUrl: (query) => `https://www.printables.com/search/models?q=${encodeURIComponent(query)}`,
  notes: [
    'Printables 的 GraphQL 端點沒有官方開發者方案，不納入自動查詢。',
    '文件與 make 紀錄完整，適合需要驗證別人真的印成功過的情況。',
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
    // 交接不需要憑證，永遠可用。
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
