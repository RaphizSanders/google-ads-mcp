/**
 * Lote planner-recommendations: Planejador de palavras-chave e recomendações.
 *
 * Tools deste módulo (as cinco primeiras vieram de src/tools.ts e continuam
 * classificadas em src/read-only.ts; as novas estão em planner-recommendations.catalog.ts):
 * - generate_keyword_ideas            (leitura) ideias + volume mensal, site seed e paginação
 * - list_recommendations              (leitura) inclui recomendações de orçamento por campanha
 * - apply_recommendation              (escrita) aplica com os valores do Google ou com overrides
 * - dismiss_recommendation            (escrita) dispensa com leitura prévia e relatório por item
 * - get_change_history                (leitura) filtros, diff por campo e paginação além de 10 mil
 * - get_keyword_historical_metrics    (leitura) volume e sazonalidade de uma lista de keywords
 * - forecast_search_campaign          (leitura) previsão de cliques/custo/conversões (schema v24+)
 * - suggest_ad_group_themes           (leitura) sugere o grupo de anúncios de cada keyword
 * - generate_recommendations          (leitura) recomendações para campanha ainda não criada
 * - list_recommendation_subscriptions (leitura) assinaturas de auto-aplicação
 * - set_recommendation_subscription   (escrita) liga/pausa a auto-aplicação por tipo
 *
 * Tudo conferido contra os protos oficiais da v25 (services/keyword_plan_idea_service,
 * services/recommendation_service, services/recommendation_subscription_service,
 * resources/recommendation, resources/change_event e enums correspondentes).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  LOW_BID_MICROS,
  buildChangeEventDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  isPositiveMicros,
  microsToMoney,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<ReturnType<typeof text>>; isError?: boolean };

// ── Enums da v25 (conferidos nos protos) ─────────────────────────────

/** enums/recommendation_type.proto, sem UNSPECIFIED/UNKNOWN. */
export const RECOMMENDATION_TYPES = [
  "CAMPAIGN_BUDGET", "KEYWORD", "TEXT_AD", "TARGET_CPA_OPT_IN", "MAXIMIZE_CONVERSIONS_OPT_IN",
  "ENHANCED_CPC_OPT_IN", "SEARCH_PARTNERS_OPT_IN", "MAXIMIZE_CLICKS_OPT_IN", "OPTIMIZE_AD_ROTATION",
  "KEYWORD_MATCH_TYPE", "MOVE_UNUSED_BUDGET", "FORECASTING_CAMPAIGN_BUDGET", "TARGET_ROAS_OPT_IN",
  "RESPONSIVE_SEARCH_AD", "MARGINAL_ROI_CAMPAIGN_BUDGET", "USE_BROAD_MATCH_KEYWORD",
  "RESPONSIVE_SEARCH_AD_ASSET", "UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX",
  "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH", "DISPLAY_EXPANSION_OPT_IN",
  "UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX", "RAISE_TARGET_CPA_BID_TOO_LOW", "FORECASTING_SET_TARGET_ROAS",
  "CALLOUT_ASSET", "SITELINK_ASSET", "CALL_ASSET", "SHOPPING_ADD_AGE_GROUP", "SHOPPING_ADD_COLOR",
  "SHOPPING_ADD_GENDER", "SHOPPING_ADD_GTIN", "SHOPPING_ADD_MORE_IDENTIFIERS", "SHOPPING_ADD_SIZE",
  "SHOPPING_ADD_PRODUCTS_TO_CAMPAIGN", "SHOPPING_FIX_DISAPPROVED_PRODUCTS", "SHOPPING_TARGET_ALL_OFFERS",
  "SHOPPING_FIX_SUSPENDED_MERCHANT_CENTER_ACCOUNT", "SHOPPING_FIX_MERCHANT_CENTER_ACCOUNT_SUSPENSION_WARNING",
  "SHOPPING_MIGRATE_REGULAR_SHOPPING_CAMPAIGN_OFFERS_TO_PERFORMANCE_MAX", "DYNAMIC_IMAGE_EXTENSION_OPT_IN",
  "RAISE_TARGET_CPA", "LOWER_TARGET_ROAS", "PERFORMANCE_MAX_OPT_IN", "IMPROVE_PERFORMANCE_MAX_AD_STRENGTH",
  "MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX", "FORECASTING_SET_TARGET_CPA", "SET_TARGET_CPA",
  "SET_TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE_OPT_IN", "IMPROVE_GOOGLE_TAG_COVERAGE",
  "PERFORMANCE_MAX_FINAL_URL_OPT_IN", "REFRESH_CUSTOMER_MATCH_LIST", "CUSTOM_AUDIENCE_OPT_IN",
  "LEAD_FORM_ASSET", "IMPROVE_DEMAND_GEN_AD_STRENGTH", "CAMPAIGN_SPECIFIC_APP_GOAL",
] as const;

/** Tipos que aceitam assinatura de auto-aplicação (docs/recommendations, "Subscription-supported"). */
export const SUBSCRIPTION_TYPES = [
  "ENHANCED_CPC_OPT_IN", "KEYWORD", "KEYWORD_MATCH_TYPE", "LOWER_TARGET_ROAS", "MAXIMIZE_CLICKS_OPT_IN",
  "OPTIMIZE_AD_ROTATION", "RAISE_TARGET_CPA", "RESPONSIVE_SEARCH_AD", "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH",
  "SEARCH_PARTNERS_OPT_IN", "SET_TARGET_CPA", "SET_TARGET_ROAS", "TARGET_CPA_OPT_IN", "TARGET_ROAS_OPT_IN",
  "USE_BROAD_MATCH_KEYWORD",
] as const;

/** Tipos aceitos por RecommendationService.GenerateRecommendations (comentário do proto). */
export const GENERATE_TYPES = [
  "CAMPAIGN_BUDGET", "KEYWORD", "MAXIMIZE_CLICKS_OPT_IN", "MAXIMIZE_CONVERSIONS_OPT_IN",
  "MAXIMIZE_CONVERSION_VALUE_OPT_IN", "SET_TARGET_CPA", "SET_TARGET_ROAS", "SITELINK_ASSET",
  "TARGET_CPA_OPT_IN", "TARGET_ROAS_OPT_IN",
] as const;

/** enums/bidding_strategy_type.proto, sem UNSPECIFIED/UNKNOWN. */
const BIDDING_STRATEGY_TYPES = [
  "COMMISSION", "ENHANCED_CPC", "FIXED_CPM", "FIXED_SHARE_OF_VOICE", "INVALID", "MANUAL_CPA", "MANUAL_CPC",
  "MANUAL_CPM", "MANUAL_CPV", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "PAGE_ONE_PROMOTED",
  "PERCENT_CPC", "TARGET_CPA", "TARGET_CPC", "TARGET_CPM", "TARGET_CPV", "TARGET_IMPRESSION_SHARE",
  "TARGET_OUTRANK_SHARE", "TARGET_ROAS", "TARGET_SPEND",
] as const;

/** enums/conversion_tracking_status_enum.proto */
const CONVERSION_TRACKING_STATUSES = [
  "NOT_CONVERSION_TRACKED", "CONVERSION_TRACKING_MANAGED_BY_SELF",
  "CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER", "CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER",
] as const;

/** enums/ad_group_type.proto, sem UNSPECIFIED/UNKNOWN. */
const AD_GROUP_TYPES = [
  "SEARCH_STANDARD", "DISPLAY_STANDARD", "SHOPPING_PRODUCT_ADS", "HOTEL_ADS", "SHOPPING_SMART_ADS",
  "VIDEO_BUMPER", "VIDEO_TRUE_VIEW_IN_STREAM", "VIDEO_TRUE_VIEW_IN_DISPLAY", "VIDEO_NON_SKIPPABLE_IN_STREAM",
  "SEARCH_DYNAMIC_ADS", "SHOPPING_COMPARISON_LISTING_ADS", "PROMOTED_HOTEL_ADS", "VIDEO_RESPONSIVE",
  "VIDEO_EFFICIENT_REACH", "SMART_CAMPAIGN_ADS", "TRAVEL_ADS", "YOUTUBE_AUDIO",
] as const;

/** enums/change_client_type.proto (valores 2–14), sem UNSPECIFIED/UNKNOWN. */
export const CHANGE_CLIENT_TYPES = [
  "GOOGLE_ADS_WEB_CLIENT", "GOOGLE_ADS_AUTOMATED_RULE", "GOOGLE_ADS_SCRIPTS", "GOOGLE_ADS_BULK_UPLOAD",
  "GOOGLE_ADS_API", "GOOGLE_ADS_EDITOR", "GOOGLE_ADS_MOBILE_APP", "GOOGLE_ADS_RECOMMENDATIONS",
  "SEARCH_ADS_360_SYNC", "SEARCH_ADS_360_POST", "INTERNAL_TOOL", "OTHER", "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION",
] as const;

/** enums/change_event_resource_type.proto, sem UNSPECIFIED/UNKNOWN. */
export const CHANGE_RESOURCE_TYPES = [
  "AD", "AD_GROUP", "AD_GROUP_CRITERION", "CAMPAIGN", "CAMPAIGN_BUDGET", "AD_GROUP_BID_MODIFIER",
  "CAMPAIGN_CRITERION", "FEED", "FEED_ITEM", "CAMPAIGN_FEED", "AD_GROUP_FEED", "AD_GROUP_AD", "ASSET",
  "CUSTOMER_ASSET", "CAMPAIGN_ASSET", "AD_GROUP_ASSET", "ASSET_SET", "ASSET_SET_ASSET", "CAMPAIGN_ASSET_SET",
] as const;

/** enums/resource_change_operation.proto */
const CHANGE_OPERATIONS = ["CREATE", "UPDATE", "REMOVE"] as const;

/** Campo de ChangeEvent.ChangedResource (JSON REST) para cada change_resource_type. */
const CHANGED_RESOURCE_KEY: Record<string, string> = {
  AD: "ad",
  AD_GROUP: "adGroup",
  AD_GROUP_CRITERION: "adGroupCriterion",
  CAMPAIGN: "campaign",
  CAMPAIGN_BUDGET: "campaignBudget",
  AD_GROUP_BID_MODIFIER: "adGroupBidModifier",
  CAMPAIGN_CRITERION: "campaignCriterion",
  AD_GROUP_AD: "adGroupAd",
  ASSET: "asset",
  CUSTOMER_ASSET: "customerAsset",
  CAMPAIGN_ASSET: "campaignAsset",
  AD_GROUP_ASSET: "adGroupAsset",
  ASSET_SET: "assetSet",
  ASSET_SET_ASSET: "assetSetAsset",
  CAMPAIGN_ASSET_SET: "campaignAssetSet",
};

/** enums/month_of_year.proto, na ordem do calendário. */
const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
] as const;

const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
const KEYWORD_PLAN_NETWORKS = ["GOOGLE_SEARCH", "GOOGLE_SEARCH_AND_PARTNERS"] as const;
const FORECAST_BIDDING = ["MAXIMIZE_CLICKS", "MANUAL_CPC", "MAXIMIZE_CONVERSIONS"] as const;

/** Limites documentados nos protos da v25. */
const MAX_IDEA_SEED_KEYWORDS = 20; // KeywordSeed / KeywordAndUrlSeed: "no more than 20 keywords"
const MAX_GEO_TARGETS = 10; // GenerateKeywordIdeas/HistoricalMetrics: "Maximum is 10"
const MAX_HISTORICAL_KEYWORDS = 10_000; // GenerateKeywordHistoricalMetricsRequest.keywords
const MAX_KEYWORD_CHARS = 80; // KeywordInfo.text: "at most 80 characters and 10 words"
const MAX_KEYWORD_WORDS = 10;
const MAX_RECOMMENDATION_OPERATIONS = 100; // Apply/Dismiss: "limit of 100 operations per request"
const CHANGE_EVENT_PAGE = 10_000; // change_event: LIMIT de no máximo 10.000 por consulta
const MAX_CHANGE_EVENTS = 50_000;
const MAX_FORECAST_SCENARIOS = 5;
const MAX_SUBSCRIPTION_ACCOUNTS = 100;
/** Guardas de unidade: abaixo disso o valor quase certamente veio em reais, não em micros. */
const MIN_BUDGET_MICROS = 1_000_000;

// ── Helpers ──────────────────────────────────────────────────────────

const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const optMoney = (micros: unknown) => (micros === undefined || micros === null ? null : microsToMoney(micros));
const optNum = (value: unknown) => (value === undefined || value === null ? null : num(value));
const pad2 = (n: number) => String(n).padStart(2, "0");

/** customerId sem hífens; null se não for numérico. */
function normalizeCid(customerId: string | undefined): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "").trim();
  return /^\d+$/.test(cid) ? cid : null;
}

/**
 * URL semente do Planejador (UrlSeed.url, KeywordAndUrlSeed.url, SeedInfo.url_seed).
 * O próprio proto dá o exemplo sem esquema ("www.example.com/cars"), então http(s):// é
 * opcional; exige um host com domínio e não aceita espaços nem outro esquema. A URL vai
 * para a API como veio (igual à versão anterior da tool).
 */
const SEED_URL_PATTERN =
  /^(?:https?:\/\/)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]*[\p{L}\p{N}](?::\d{1,5})?(?:[/?#]\S*)?$/iu;

function isSeedUrl(url: string): boolean {
  return SEED_URL_PATTERN.test(url);
}

function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Dicas para erros comuns da API (as mensagens do Google vêm em inglês). */
function apiHint(message: string): string {
  const hints: Array<[RegExp, string]> = [
    [/no longer (valid|available)|invalidated|obsolete|RECOMMENDATION_INVALIDATED/i,
      "A recomendação ficou obsoleta — o Google recalcula as recomendações várias vezes ao dia. Rode list_recommendations de novo e use o resourceName atual."],
    [/already (been )?applied/i, "A recomendação já tinha sido aplicada."],
    [/already (been )?dismissed/i, "A recomendação já estava dispensada."],
    [/budget amount (is )?too small|BUDGET_AMOUNT_TOO_SMALL/i, "O orçamento ficou abaixo do mínimo da moeda da conta."],
    [/budget amount (is )?too large|BUDGET_AMOUNT_TOO_LARGE/i, "O orçamento ficou acima do máximo aceito."],
    [/multiplier/i, "Multiplicador inválido para esse tipo de recomendação."],
    [/crawl/i, "O Google não conseguiu ler a URL/site informado — confira se a página é pública e responde."],
    [/RESOURCE_EXHAUSTED|quota|rate limit|too many requests/i,
      "Limite de requisições do Planejador atingido: espere alguns segundos e repita com menos cenários/keywords."],
    [/collection size|too many (elements|keywords|operations)/i, "Lista grande demais para a API: divida em lotes menores."],
    [/start date|forecast[_ ]period|date range/i, "Período inválido: o início precisa ser futuro e o fim até 1 ano à frente."],
  ];
  const found = hints.find(([pattern]) => pattern.test(message));
  return found ? `\nDica: ${found[1]}` : "";
}

function apiFailure(context: string, err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return fail(`Erro da API ao ${context}: ${message}${apiHint(message)}`);
}

/** Resolve o idioma pelo código ISO (pt, en, es, zh_CN...) ou aceita o ID numérico direto. */
async function resolveLanguage(
  client: GoogleAdsClient,
  cid: string,
  code: string | undefined
): Promise<{ id: string; resource: string; code: string } | { error: string }> {
  const value = (code ?? "pt").trim();
  if (/^\d+$/.test(value)) return { id: value, resource: `languageConstants/${value}`, code: value };
  // só letras, _ e -: o valor entra no GAQL (além de escapado); código inexistente cai no "não encontrado" abaixo
  if (!/^[A-Za-z][A-Za-z_-]{1,9}$/.test(value)) {
    return { error: `languageCode inválido: "${value}". Use o código ISO (pt, en, es, zh_CN) ou o ID numérico do idioma.` };
  }
  const rows = await client.searchStream(cid,
    `SELECT language_constant.id, language_constant.code, language_constant.name
     FROM language_constant
     WHERE language_constant.code = '${gaqlLiteral(value)}'
     LIMIT 1`);
  const id = String(obj(rows[0]?.languageConstant).id ?? "");
  if (!id) return { error: `Idioma '${value}' não encontrado. Use códigos ISO como pt, en, es.` };
  return { id, resource: `languageConstants/${id}`, code: value };
}

/** Geo target IDs → geoTargetConstants/{id}. Default Brasil (2076). */
function parseGeoTargets(ids: unknown, max?: number): { resources: string[] } | { error: string } {
  const raw = ensureArray<string>(ids).map((id) => String(id).trim().replace(/^geoTargetConstants\//, "")).filter(Boolean);
  const unique = [...new Set(raw.length ? raw : ["2076"])];
  const bad = unique.filter((id) => !/^\d+$/.test(id));
  if (bad.length) return { error: `geoTargetIds inválidos: ${bad.join(", ")}. Use IDs numéricos (list_geo_targets).` };
  if (max && unique.length > max) return { error: `A API aceita no máximo ${max} localizações por chamada (recebido ${unique.length}).` };
  return { resources: unique.map((id) => `geoTargetConstants/${id}`) };
}

/** Faixa de meses YYYY-MM → YearMonthRange da API. */
function parseMonthRange(range: { start?: string; end?: string } | undefined):
  { value?: Row; error?: string } {
  if (!range) return {};
  const parse = (label: string, value: string | undefined) => {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
    const month = match ? Number(match[2]) : 0;
    if (!match || month < 1 || month > 12) return { error: `monthRange.${label} inválido: "${value}". Use YYYY-MM.` };
    return { year: Number(match[1]), month, apiValue: { year: match[1], month: MONTHS[month - 1] } };
  };
  const start = parse("start", range.start);
  if ("error" in start) return { error: start.error };
  const end = parse("end", range.end);
  if ("error" in end) return { error: end.error };
  if (start.year * 12 + start.month > end.year * 12 + end.month) {
    return { error: `monthRange: start (${range.start}) depois de end (${range.end}).` };
  }
  return { value: { start: start.apiValue, end: end.apiValue } };
}

function monthlyVolumes(metrics: Row): Array<{ month: string; searches: number | null }> {
  return list(metrics.monthlySearchVolumes).map((entry) => {
    const volume = obj(entry);
    const index = MONTHS.indexOf(String(volume.month) as (typeof MONTHS)[number]);
    return {
      month: `${String(volume.year ?? "????")}-${index >= 0 ? pad2(index + 1) : String(volume.month)}`,
      searches: optNum(volume.monthlySearches),
    };
  });
}

/** Para table/csv: uma coluna por mês (YYYY-MM). */
function withMonthColumns(rows: Row[]): Row[] {
  return rows.map((row) => {
    const { monthly_searches: monthly, close_variants: variants, ...rest } = row;
    const flat: Row = { ...rest };
    if (Array.isArray(variants)) flat.close_variants = variants.join("; ");
    for (const entry of (monthly as Array<{ month: string; searches: number | null }> | undefined) ?? []) {
      flat[entry.month] = entry.searches ?? "";
    }
    return flat;
  });
}

function render(rows: Row[], format: string | undefined, header: string, jsonBody: unknown = rows): ToolResult {
  if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(rows)}`)] };
  if (format === "csv") return { content: [text(formatAsCsv(rows))] };
  return { content: [text(`${header}\n\n${formatJson(jsonBody)}`)] };
}

/** Keyword para KeywordInfo: texto + match type, com os limites do proto. */
function parseKeywordInfo(value: unknown, defaultMatch: string): { text: string; matchType: string } | { error: string } {
  const entry = typeof value === "string" ? { text: value } : obj(value);
  const kwText = String(entry.text ?? "").trim();
  const matchType = String(entry.matchType ?? defaultMatch).toUpperCase();
  if (!kwText) return { error: "keyword vazia" };
  if (kwText.length > MAX_KEYWORD_CHARS) return { error: `"${kwText}" passa de ${MAX_KEYWORD_CHARS} caracteres` };
  if (kwText.split(/\s+/).length > MAX_KEYWORD_WORDS) return { error: `"${kwText}" passa de ${MAX_KEYWORD_WORDS} palavras` };
  if (!(MATCH_TYPES as readonly string[]).includes(matchType)) return { error: `matchType inválido em "${kwText}": ${matchType} (use EXACT, PHRASE ou BROAD)` };
  return { text: kwText, matchType };
}

// ── Recomendações: leitura dos detalhes por tipo ─────────────────────

function impactView(impact: unknown): Row {
  const base = obj(obj(impact).baseMetrics);
  const potential = obj(obj(impact).potentialMetrics);
  return {
    base_clicks: num(base.clicks),
    potential_clicks: num(potential.clicks),
    base_conversions: num(base.conversions),
    potential_conversions: num(potential.conversions),
    base_cost: microsToMoney(base.costMicros),
    potential_cost: microsToMoney(potential.costMicros),
    base_conversions_value: num(base.conversionsValue),
    potential_conversions_value: num(potential.conversionsValue),
  };
}

function budgetRecommendationView(payload: unknown): Row {
  const b = obj(payload);
  return {
    current_budget: optMoney(b.currentBudgetAmountMicros),
    recommended_budget: optMoney(b.recommendedBudgetAmountMicros),
    options: list(b.budgetOptions).map((option) => {
      const o = obj(option);
      const impact = impactView(o.impact);
      return {
        budget: optMoney(o.budgetAmountMicros),
        potential_clicks: impact.potential_clicks,
        potential_conversions: impact.potential_conversions,
        potential_cost: impact.potential_cost,
      };
    }),
  };
}

function sharedBudgetView(payload: unknown): Row | undefined {
  const b = obj(payload);
  if (!Object.keys(b).length) return undefined;
  return {
    current_budget: optMoney(b.currentAmountMicros),
    recommended_budget: optMoney(b.recommendedNewAmountMicros),
    new_start_date: b.newStartDate ?? null,
  };
}

function keywordInfoView(value: unknown): string {
  const k = obj(value);
  return `${String(k.text ?? "")} [${String(k.matchType ?? "")}]`;
}

/**
 * Detalhes da recomendação por tipo (o que o Google propõe aplicar). É o que o
 * agente precisa ver antes de aplicar — e a base dos overrides de apply_recommendation.
 */
export function recommendationDetails(rec: Row): Row {
  const type = String(rec.type ?? "");
  switch (type) {
    case "CAMPAIGN_BUDGET":
      return budgetRecommendationView(rec.campaignBudgetRecommendation);
    case "FORECASTING_CAMPAIGN_BUDGET":
      return budgetRecommendationView(rec.forecastingCampaignBudgetRecommendation);
    case "MARGINAL_ROI_CAMPAIGN_BUDGET":
      return budgetRecommendationView(rec.marginalRoiCampaignBudgetRecommendation);
    case "MOVE_UNUSED_BUDGET": {
      const payload = obj(rec.moveUnusedBudgetRecommendation);
      return { excess_campaign_budget: payload.excessCampaignBudget ?? null, ...budgetRecommendationView(payload.budgetRecommendation) };
    }
    case "KEYWORD": {
      const payload = obj(rec.keywordRecommendation);
      return {
        keyword: keywordInfoView(payload.keyword),
        recommended_cpc_bid: optMoney(payload.recommendedCpcBidMicros),
        search_terms: list(payload.searchTerms).map((t) => ({ text: obj(t).text, weekly_searches: num(obj(t).estimatedWeeklySearchCount) })),
      };
    }
    case "KEYWORD_MATCH_TYPE": {
      const payload = obj(rec.keywordMatchTypeRecommendation);
      return { keyword: keywordInfoView(payload.keyword), recommended_match_type: payload.recommendedMatchType ?? null };
    }
    case "TARGET_CPA_OPT_IN": {
      const payload = obj(rec.targetCpaOptInRecommendation);
      return {
        recommended_target_cpa: optMoney(payload.recommendedTargetCpaMicros),
        options: list(payload.options).map((option) => {
          const o = obj(option);
          return { goal: o.goal ?? null, target_cpa: optMoney(o.targetCpaMicros), required_budget: optMoney(o.requiredCampaignBudgetAmountMicros) };
        }),
      };
    }
    case "TARGET_ROAS_OPT_IN": {
      const payload = obj(rec.targetRoasOptInRecommendation);
      return { recommended_target_roas: optNum(payload.recommendedTargetRoas), required_budget: optMoney(payload.requiredCampaignBudgetAmountMicros) };
    }
    case "MAXIMIZE_CONVERSIONS_OPT_IN":
      return { recommended_budget: optMoney(obj(rec.maximizeConversionsOptInRecommendation).recommendedBudgetAmountMicros) };
    case "MAXIMIZE_CLICKS_OPT_IN":
      return { recommended_budget: optMoney(obj(rec.maximizeClicksOptInRecommendation).recommendedBudgetAmountMicros) };
    case "SET_TARGET_CPA":
    case "FORECASTING_SET_TARGET_CPA": {
      const payload = obj(type === "SET_TARGET_CPA" ? rec.setTargetCpaRecommendation : rec.forecastingSetTargetCpaRecommendation);
      return { recommended_target_cpa: optMoney(payload.recommendedTargetCpaMicros), campaign_budget: sharedBudgetView(payload.campaignBudget) ?? null };
    }
    case "SET_TARGET_ROAS":
    case "FORECASTING_SET_TARGET_ROAS": {
      const payload = obj(type === "SET_TARGET_ROAS" ? rec.setTargetRoasRecommendation : rec.forecastingSetTargetRoasRecommendation);
      return { recommended_target_roas: optNum(payload.recommendedTargetRoas), campaign_budget: sharedBudgetView(payload.campaignBudget) ?? null };
    }
    case "USE_BROAD_MATCH_KEYWORD": {
      const payload = obj(rec.useBroadMatchKeywordRecommendation);
      return {
        suggested_keywords_count: num(payload.suggestedKeywordsCount),
        campaign_keywords_count: num(payload.campaignKeywordsCount),
        campaign_uses_shared_budget: Boolean(payload.campaignUsesSharedBudget),
        required_budget: optMoney(payload.requiredCampaignBudgetAmountMicros),
        sample_keywords: list(payload.keyword).slice(0, 10).map(keywordInfoView),
      };
    }
    case "RAISE_TARGET_CPA":
    case "LOWER_TARGET_ROAS": {
      const payload = obj(type === "RAISE_TARGET_CPA" ? rec.raiseTargetCpaRecommendation : rec.lowerTargetRoasRecommendation);
      const adjustment = obj(payload.targetAdjustment);
      return {
        recommended_target_multiplier: optNum(adjustment.recommendedTargetMultiplier),
        current_average_target: type === "RAISE_TARGET_CPA" ? optMoney(adjustment.currentAverageTargetMicros) : optNum(adjustment.currentAverageTargetMicros),
        portfolio_bidding_strategy: adjustment.sharedSet ?? null,
      };
    }
    case "RAISE_TARGET_CPA_BID_TOO_LOW": {
      const payload = obj(rec.raiseTargetCpaBidTooLowRecommendation);
      return { recommended_target_multiplier: optNum(payload.recommendedTargetMultiplier), average_target_cpa: optMoney(payload.averageTargetCpaMicros) };
    }
    case "SITELINK_ASSET": {
      const payload = obj(rec.sitelinkAssetRecommendation);
      return {
        recommended_campaign_sitelinks: list(payload.recommendedCampaignSitelinkAssets).length,
        recommended_customer_sitelinks: list(payload.recommendedCustomerSitelinkAssets).length,
      };
    }
    case "CALLOUT_ASSET": {
      const payload = obj(rec.calloutAssetRecommendation);
      return {
        recommended_campaign_callouts: list(payload.recommendedCampaignCalloutAssets).length,
        recommended_customer_callouts: list(payload.recommendedCustomerCalloutAssets).length,
      };
    }
    default:
      return {};
  }
}

/** Resumo de uma linha dos detalhes (para table/csv). */
function detailsText(details: Row): string {
  return Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("; ");
}

/** Campos lidos em list_recommendations e nas leituras antes de aplicar/dispensar. */
const RECOMMENDATION_SELECT = [
  "recommendation.resource_name",
  "recommendation.type",
  "recommendation.campaign",
  "recommendation.campaigns",
  "recommendation.campaign_budget",
  "recommendation.ad_group",
  "recommendation.dismissed",
  "recommendation.impact",
  "recommendation.campaign_budget_recommendation",
  "recommendation.forecasting_campaign_budget_recommendation",
  "recommendation.marginal_roi_campaign_budget_recommendation",
  "recommendation.move_unused_budget_recommendation",
  "recommendation.keyword_recommendation",
  "recommendation.keyword_match_type_recommendation",
  "recommendation.target_cpa_opt_in_recommendation",
  "recommendation.target_roas_opt_in_recommendation",
  "recommendation.maximize_conversions_opt_in_recommendation",
  "recommendation.maximize_clicks_opt_in_recommendation",
  "recommendation.set_target_cpa_recommendation",
  "recommendation.set_target_roas_recommendation",
  "recommendation.forecasting_set_target_cpa_recommendation",
  "recommendation.forecasting_set_target_roas_recommendation",
  "recommendation.use_broad_match_keyword_recommendation",
  "recommendation.raise_target_cpa_recommendation",
  "recommendation.lower_target_roas_recommendation",
  "recommendation.raise_target_cpa_bid_too_low_recommendation",
  "recommendation.sitelink_asset_recommendation",
  "recommendation.callout_asset_recommendation",
  "campaign.name",
  "campaign_budget.name",
  "ad_group.name",
].join(", ");

const RECOMMENDATION_NAME = /^customers\/(\d+)\/recommendations\/([^\s'"\\/]+)$/;

/** Resource names de recomendações: formato e conta conferidos antes de qualquer chamada. */
function parseRecommendationNames(values: unknown[], cid: string): { names: string[] } | { error: string } {
  const names: string[] = [];
  const errors: string[] = [];
  for (const value of values) {
    const name = String(value ?? "").trim();
    const match = RECOMMENDATION_NAME.exec(name);
    if (!match) errors.push(`"${name}" não é um resourceName de recomendação (customers/{id}/recommendations/{id})`);
    else if (match[1] !== cid) errors.push(`${name} é da conta ${match[1]}, não da ${cid}`);
    else if (names.includes(name)) errors.push(`${name} repetido`);
    else names.push(name);
  }
  if (errors.length) return { error: `Nada foi enviado:\n- ${errors.join("\n- ")}` };
  if (names.length === 0) return { error: "Informe ao menos um resourceName (de list_recommendations)." };
  if (names.length > MAX_RECOMMENDATION_OPERATIONS) {
    return { error: `A API aceita no máximo ${MAX_RECOMMENDATION_OPERATIONS} recomendações por chamada (recebido ${names.length}).` };
  }
  return { names };
}

/**
 * Lê as recomendações pelo resource name. Se alguma não voltar, repete só para as
 * faltantes com recommendation.dismissed = TRUE: dispensadas também podem ser
 * aplicadas, e assim a leitura não depende de a API incluí-las por padrão.
 */
async function fetchRecommendations(client: GoogleAdsClient, cid: string, names: string[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  const query = (targets: string[], extra: string) =>
    client.searchStream(cid,
      `SELECT ${RECOMMENDATION_SELECT}
       FROM recommendation
       WHERE recommendation.resource_name IN (${targets.map((n) => `'${gaqlLiteral(n)}'`).join(", ")})${extra}`);
  for (const row of await query(names, "")) {
    const name = String(obj(row.recommendation).resourceName ?? "");
    if (name) found.set(name, row);
  }
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) {
    for (const row of await query(missing, " AND recommendation.dismissed = TRUE")) {
      const name = String(obj(row.recommendation).resourceName ?? "");
      if (name) found.set(name, row);
    }
  }
  return found;
}

function recommendationLabel(row: Row, campaignNames: Map<string, string> = new Map()): string {
  const rec = obj(row.recommendation);
  const campaignName = obj(row.campaign).name;
  if (campaignName) return String(campaignName);
  const campaigns = list(rec.campaigns).map((rn) => campaignNames.get(String(rn)) ?? String(rn).split("/").pop());
  const budgetName = obj(row.campaignBudget).name;
  if (budgetName || campaigns.length) {
    return `orçamento ${budgetName ?? String(rec.campaignBudget ?? "").split("/").pop() ?? ""}` +
      (campaigns.length ? ` — campanhas: ${campaigns.join(", ")}` : "");
  }
  return "(conta)";
}

// ── Overrides de apply_recommendation (ApplyRecommendationOperation.apply_parameters) ──

interface OverrideSpec {
  /** Tipos de recomendação a que o parâmetro se aplica (proto recommendation_service.proto). */
  types: string[];
  validate: (o: Row) => string | null;
  build: (o: Row, cid: string) => Row;
}

const microsString = (value: unknown) => String(Math.round(Number(value)));

function checkMicros(o: Row, key: string, min: number, required: boolean): string | null {
  const value = o[key];
  if (value === undefined || value === null) return required ? `${key} é obrigatório` : null;
  if (!isPositiveMicros(value)) return `${key} precisa ser um inteiro positivo em micros (1.000.000 = 1 unidade da moeda)`;
  if ((value as number) < min) return `${key}=${String(value)} parece estar em reais, não em micros (mínimo ${min} micros = ${min / 1_000_000})`;
  return null;
}

function checkRoas(o: Row, key: string, required: boolean): string | null {
  const value = o[key];
  if (value === undefined || value === null) return required ? `${key} é obrigatório` : null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.01 || value > 1000) {
    return `${key} precisa estar entre 0.01 e 1000 (ROAS em proporção: 4 = 400%)`;
  }
  return null;
}

function checkMultiplier(o: Row, key: string, greaterThanOne: boolean): string | null {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return `${key} é obrigatório e precisa ser um número positivo`;
  if (greaterThanOne && value <= 1) return `${key} precisa ser maior que 1.0 (fator de aumento)`;
  return null;
}

const firstError = (...errors: Array<string | null>) => errors.find((e) => e) ?? null;
const atLeastOne = (o: Row, keys: string[]) =>
  keys.some((k) => o[k] !== undefined && o[k] !== null) ? null : `informe ao menos um de: ${keys.join(", ")}`;
const pick = (o: Row, keys: Array<[string, (v: unknown) => unknown]>): Row =>
  Object.fromEntries(keys.filter(([k]) => o[k] !== undefined && o[k] !== null).map(([k, f]) => [k, f(o[k])]));
const same = (v: unknown) => v;

export const OVERRIDE_SPECS: Record<string, OverrideSpec> = {
  campaignBudget: {
    types: ["CAMPAIGN_BUDGET"],
    validate: (o) => checkMicros(o, "newBudgetAmountMicros", MIN_BUDGET_MICROS, true),
    build: (o) => ({ newBudgetAmountMicros: microsString(o.newBudgetAmountMicros) }),
  },
  keyword: {
    types: ["KEYWORD"],
    validate: (o) => {
      if (!/^\d+$/.test(String(o.adGroupId ?? ""))) return "adGroupId (numérico) é obrigatório";
      if (!(MATCH_TYPES as readonly string[]).includes(String(o.matchType ?? ""))) return "matchType é obrigatório (EXACT, PHRASE ou BROAD)";
      return checkMicros(o, "cpcBidMicros", LOW_BID_MICROS, false);
    },
    build: (o, cid) => ({
      adGroup: `customers/${cid}/adGroups/${String(o.adGroupId)}`,
      matchType: o.matchType,
      ...pick(o, [["cpcBidMicros", microsString]]),
    }),
  },
  targetCpaOptIn: {
    types: ["TARGET_CPA_OPT_IN"],
    validate: (o) => firstError(checkMicros(o, "targetCpaMicros", LOW_BID_MICROS, true), checkMicros(o, "newCampaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetCpaMicros", microsString], ["newCampaignBudgetAmountMicros", microsString]]),
  },
  targetRoasOptIn: {
    types: ["TARGET_ROAS_OPT_IN"],
    validate: (o) => firstError(
      atLeastOne(o, ["targetRoas", "newCampaignBudgetAmountMicros"]),
      checkRoas(o, "targetRoas", false),
      checkMicros(o, "newCampaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetRoas", same], ["newCampaignBudgetAmountMicros", microsString]]),
  },
  moveUnusedBudget: {
    types: ["MOVE_UNUSED_BUDGET"],
    validate: (o) => checkMicros(o, "budgetMicrosToMove", MIN_BUDGET_MICROS, true),
    build: (o) => ({ budgetMicrosToMove: microsString(o.budgetMicrosToMove) }),
  },
  useBroadMatchKeyword: {
    types: ["USE_BROAD_MATCH_KEYWORD"],
    validate: (o) => checkMicros(o, "newBudgetAmountMicros", MIN_BUDGET_MICROS, true),
    build: (o) => ({ newBudgetAmountMicros: microsString(o.newBudgetAmountMicros) }),
  },
  raiseTargetCpaBidTooLow: {
    types: ["RAISE_TARGET_CPA_BID_TOO_LOW"],
    validate: (o) => checkMultiplier(o, "targetMultiplier", true),
    build: (o) => ({ targetMultiplier: o.targetMultiplier }),
  },
  raiseTargetCpa: {
    types: ["RAISE_TARGET_CPA"],
    validate: (o) => checkMultiplier(o, "targetCpaMultiplier", false),
    build: (o) => ({ targetCpaMultiplier: o.targetCpaMultiplier }),
  },
  lowerTargetRoas: {
    types: ["LOWER_TARGET_ROAS"],
    validate: (o) => checkMultiplier(o, "targetRoasMultiplier", false),
    build: (o) => ({ targetRoasMultiplier: o.targetRoasMultiplier }),
  },
  setTargetCpa: {
    types: ["SET_TARGET_CPA"],
    validate: (o) => firstError(
      atLeastOne(o, ["targetCpaMicros", "campaignBudgetAmountMicros"]),
      checkMicros(o, "targetCpaMicros", LOW_BID_MICROS, false),
      checkMicros(o, "campaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetCpaMicros", microsString], ["campaignBudgetAmountMicros", microsString]]),
  },
  forecastingSetTargetCpa: {
    types: ["FORECASTING_SET_TARGET_CPA"],
    validate: (o) => firstError(
      atLeastOne(o, ["targetCpaMicros", "campaignBudgetAmountMicros"]),
      checkMicros(o, "targetCpaMicros", LOW_BID_MICROS, false),
      checkMicros(o, "campaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetCpaMicros", microsString], ["campaignBudgetAmountMicros", microsString]]),
  },
  setTargetRoas: {
    types: ["SET_TARGET_ROAS"],
    validate: (o) => firstError(
      atLeastOne(o, ["targetRoas", "campaignBudgetAmountMicros"]),
      checkRoas(o, "targetRoas", false),
      checkMicros(o, "campaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetRoas", same], ["campaignBudgetAmountMicros", microsString]]),
  },
  forecastingSetTargetRoas: {
    types: ["FORECASTING_SET_TARGET_ROAS"],
    validate: (o) => firstError(
      atLeastOne(o, ["targetRoas", "campaignBudgetAmountMicros"]),
      checkRoas(o, "targetRoas", false),
      checkMicros(o, "campaignBudgetAmountMicros", MIN_BUDGET_MICROS, false)),
    build: (o) => pick(o, [["targetRoas", same], ["campaignBudgetAmountMicros", microsString]]),
  },
};

/**
 * z.object que RECUSA chave desconhecida, com mensagem em PT-BR. O z.object padrão
 * descarta a chave em silêncio (campaign_budget em snake_case, "override" no singular,
 * textAd...): o override chegava vazio e a recomendação era aplicada com os valores do
 * Google, e não com os do usuário.
 */
function strictObject<T extends z.ZodRawShape>(shape: T, label: string) {
  const accepted = Object.keys(shape).join(", ");
  return z.object(shape, {
    errorMap: (issue, ctx) => issue.code === z.ZodIssueCode.unrecognized_keys
      ? { message: `${label}: campo(s) não reconhecido(s): ${issue.keys.join(", ")}. Aceitos: ${accepted}. Nada foi aplicado.` }
      : { message: ctx.defaultError },
  }).strict();
}

// uma instância por campo: instância compartilhada vira "$ref" cruzado no JSON Schema da tool
const microsField = () => z.number().optional();
/** Campos aceitos em cada override (JSON REST de ApplyRecommendationOperation.*Parameters). */
export const OVERRIDE_INPUTS: Record<string, { shape: z.ZodRawShape; description: string }> = {
  campaignBudget: { shape: { newBudgetAmountMicros: z.number() },
    description: "CAMPAIGN_BUDGET: novo orçamento diário em micros." },
  keyword: { shape: { adGroupId: z.string(), matchType: z.enum(MATCH_TYPES), cpcBidMicros: microsField() },
    description: "KEYWORD: grupo de anúncios e match type (obrigatórios) e lance opcional em micros." },
  targetCpaOptIn: { shape: { targetCpaMicros: z.number(), newCampaignBudgetAmountMicros: microsField() },
    description: "TARGET_CPA_OPT_IN: CPA desejado (obrigatório) e orçamento opcional, em micros." },
  targetRoasOptIn: { shape: { targetRoas: z.number().optional(), newCampaignBudgetAmountMicros: microsField() },
    description: "TARGET_ROAS_OPT_IN: ROAS 0.01–1000 (4 = 400%) e/ou orçamento em micros." },
  moveUnusedBudget: { shape: { budgetMicrosToMove: z.number() },
    description: "MOVE_UNUSED_BUDGET: quanto mover do orçamento ocioso, em micros." },
  useBroadMatchKeyword: { shape: { newBudgetAmountMicros: z.number() },
    description: "USE_BROAD_MATCH_KEYWORD: novo orçamento em micros." },
  raiseTargetCpaBidTooLow: { shape: { targetMultiplier: z.number() },
    description: "RAISE_TARGET_CPA_BID_TOO_LOW: fator > 1.0 de aumento do CPA desejado." },
  raiseTargetCpa: { shape: { targetCpaMultiplier: z.number() },
    description: "RAISE_TARGET_CPA: multiplicador do CPA desejado." },
  lowerTargetRoas: { shape: { targetRoasMultiplier: z.number() },
    description: "LOWER_TARGET_ROAS: multiplicador do ROAS desejado." },
  setTargetCpa: { shape: { targetCpaMicros: microsField(), campaignBudgetAmountMicros: microsField() },
    description: "SET_TARGET_CPA: CPA desejado e/ou orçamento, em micros." },
  forecastingSetTargetCpa: { shape: { targetCpaMicros: microsField(), campaignBudgetAmountMicros: microsField() },
    description: "FORECASTING_SET_TARGET_CPA: CPA desejado e/ou orçamento, em micros." },
  setTargetRoas: { shape: { targetRoas: z.number().optional(), campaignBudgetAmountMicros: microsField() },
    description: "SET_TARGET_ROAS: ROAS 0.01–1000 e/ou orçamento em micros." },
  forecastingSetTargetRoas: { shape: { targetRoas: z.number().optional(), campaignBudgetAmountMicros: microsField() },
    description: "FORECASTING_SET_TARGET_ROAS: ROAS 0.01–1000 e/ou orçamento em micros." },
};

const overridesSchema = strictObject(
  Object.fromEntries(Object.entries(OVERRIDE_INPUTS).map(([key, { shape, description }]) =>
    [key, strictObject(shape, `overrides.${key}`).optional().describe(description)])) as z.ZodRawShape,
  "overrides"
);

/** Chaves de cada item de applications. */
const APPLICATION_KEYS = ["resourceName", "overrides"];

const isPlainObject = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Valida o override de um item: exatamente um parâmetro conhecido, só campos conhecidos,
 * obrigatórios e faixas. Também roda quando applications chega como texto JSON (flexArray
 * não passa os itens pelo schema), então nada aqui pode depender do zod ter filtrado antes.
 */
export function parseOverride(raw: unknown): { key?: string; params?: Row; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) return { error: "overrides precisa ser um objeto { <parâmetro>: {...} }" };
  const entries = Object.entries(raw).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) {
    return { error: "overrides vazio. Para aplicar com os valores do Google, omita overrides; para usar os seus, informe um parâmetro (ex: { campaignBudget: { newBudgetAmountMicros: 50000000 } })" };
  }
  if (entries.length > 1) return { error: `overrides aceita um parâmetro por recomendação (recebido: ${entries.map(([k]) => k).join(", ")})` };
  const [key, params] = entries[0];
  const spec = OVERRIDE_SPECS[key];
  if (!spec || !OVERRIDE_INPUTS[key]) return { error: `override "${key}" não suportado. Use: ${Object.keys(OVERRIDE_SPECS).join(", ")}` };
  if (!isPlainObject(params)) return { error: `${key}: precisa ser um objeto com ${Object.keys(OVERRIDE_INPUTS[key].shape).join(", ")}` };
  const accepted = Object.keys(OVERRIDE_INPUTS[key].shape);
  const unknown = Object.keys(params).filter((field) => !accepted.includes(field));
  if (unknown.length) return { error: `${key}: campo(s) não reconhecido(s): ${unknown.join(", ")}. Aceitos: ${accepted.join(", ")}` };
  const error = spec.validate(params);
  return error ? { error: `${key}: ${error}` } : { key, params };
}

/** Confere a forma de cada item de applications (objeto, só resourceName e overrides). */
function applicationShapeErrors(applications: unknown[]): string[] {
  return applications.flatMap((item, index) => {
    if (!isPlainObject(item)) return [`applications[${index}]: precisa ser um objeto { resourceName, overrides }`];
    const unknown = Object.keys(item).filter((key) => !APPLICATION_KEYS.includes(key));
    return unknown.length
      ? [`applications[${index}] (${String(item.resourceName ?? "sem resourceName")}): campo(s) não reconhecido(s): ${unknown.join(", ")}. Aceitos: ${APPLICATION_KEYS.join(", ")}`]
      : [];
  });
}

// ── Change history ───────────────────────────────────────────────────

const camel = (segment: string) => segment.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    const container = obj(current);
    current = segment in container ? container[segment] : container[camel(segment)];
    if (current === undefined) return undefined;
  }
  return current;
}

function displayValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let shown = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (shown.length > 300) shown = `${shown.slice(0, 297)}...`;
  if (/micros$/i.test(field) && /^-?\d+$/.test(shown)) shown = `${shown} (= ${round2(Number(shown) / 1_000_000)})`;
  return shown;
}

/** changed_fields (FieldMask no JSON REST = "a.b,c") → pares antigo → novo. */
export function changeEventDiff(event: Row): Array<{ field: string; old: string | null; new: string | null }> {
  const mask = event.changedFields;
  const paths = typeof mask === "string"
    ? mask.split(",")
    : list(obj(mask).paths).map(String);
  const key = CHANGED_RESOURCE_KEY[String(event.changeResourceType ?? "")];
  const oldResource = key ? obj(event.oldResource)[key] : undefined;
  const newResource = key ? obj(event.newResource)[key] : undefined;
  return paths.map((p) => p.trim()).filter(Boolean).map((field) => ({
    field,
    old: displayValue(field, getPath(oldResource, field)),
    new: displayValue(field, getPath(newResource, field)),
  }));
}

/** "2026-09-20 14:33:12.123456" → "2026-09-20 14:33:13" (segundo seguinte, para paginar com <). */
function nextSecond(dateTime: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d, h, mi, s) + 1000);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())} ` +
    `${pad2(next.getUTCHours())}:${pad2(next.getUTCMinutes())}:${pad2(next.getUTCSeconds())}`;
}

function countBy(rows: Row[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "(vazio)");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

// ══════════════════════════════════════════════════════════════════════

export function registerPlannerRecommendationsTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── Planejador: ideias ─────────────────────────────────────────────

  mcp.registerTool(
    "generate_keyword_ideas",
    {
      description: [
        "Gera ideias de palavras-chave com volume de busca, concorrência e faixa de CPC (Keyword Planner).",
        "READ OPERATION — não altera nada na conta.",
        "",
        "Sementes: keywords (até 20), pageUrl, keywords + pageUrl juntos, OU siteSeed (domínio inteiro, sozinho).",
        "Idioma pelo código ISO (pt, en, es...) resolvido na API. Localização por geo target IDs (até 10;",
        "use list_geo_targets). Default: 2076 (Brasil).",
        "",
        "includeMonthly=true traz o volume mês a mês (sazonalidade); monthRange escolhe os meses (até 4 anos atrás).",
        "Paginação: a resposta traz nextPageToken; repita a chamada com pageToken e os MESMOS demais parâmetros.",
        "Métricas: avg_monthly_searches, competition, competition_index (0-100), low/high_top_of_page_bid e",
        "average_cpc (na moeda da conta).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(z.string()).optional().describe("Palavras-chave semente (até 20)."),
        pageUrl: z.string().optional().describe("URL semente (página de produto ou concorrente), com ou sem http(s)://."),
        siteSeed: z.string().optional().describe("Domínio inteiro (ex: www.exemplo.com.br). Não combina com keywords/pageUrl."),
        languageCode: z.string().optional().describe("Código do idioma ISO (ou ID numérico). Default: 'pt'."),
        geoTargetIds: flexArray(z.string()).optional().describe("Geo target IDs (até 10). Default: ['2076'] (Brasil)."),
        network: z.enum(KEYWORD_PLAN_NETWORKS).optional().describe("Rede. Default: GOOGLE_SEARCH."),
        includeAdultKeywords: z.boolean().optional().describe("Incluir termos adultos. Default: false."),
        includeMonthly: z.boolean().optional().describe("Inclui o volume de cada mês (sazonalidade). Default: false."),
        monthRange: z.object({
          start: z.string().describe("Mês inicial YYYY-MM."),
          end: z.string().describe("Mês final YYYY-MM."),
        }).optional().describe("Meses do histórico (default da API: últimos 12 meses; até 4 anos atrás)."),
        limit: z.number().optional().describe("Ideias por página (1–1000). Default: 50."),
        pageToken: z.string().optional().describe("nextPageToken da chamada anterior (mantenha os demais parâmetros iguais)."),
        format: formatSchema,
      },
    },
    async ({ customerId, keywords, pageUrl, siteSeed, languageCode, geoTargetIds, network, includeAdultKeywords, includeMonthly, monthRange, limit, pageToken, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      const seedKeywords = [...new Set(ensureArray<string>(keywords).map((k) => String(k).trim()).filter(Boolean))];
      const url = pageUrl?.trim();
      const site = siteSeed?.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      if (site !== undefined && site !== "") {
        if (seedKeywords.length || url) return fail("siteSeed não combina com keywords/pageUrl: a API aceita um tipo de semente por chamada.");
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) return fail(`siteSeed inválido: "${siteSeed}". Use só o domínio (ex: www.exemplo.com.br).`);
      } else if (seedKeywords.length === 0 && !url) {
        return fail("Informe keywords, pageUrl, ambos, ou siteSeed.");
      }
      if (seedKeywords.length > MAX_IDEA_SEED_KEYWORDS) {
        return fail(`A API aceita no máximo ${MAX_IDEA_SEED_KEYWORDS} keywords semente (recebido ${seedKeywords.length}).`);
      }
      if (url && !isSeedUrl(url)) {
        return fail(`pageUrl inválida: "${pageUrl}". Use o endereço de uma página, com ou sem http(s):// (ex: www.loja.com.br/produto).`);
      }
      const geo = parseGeoTargets(geoTargetIds, MAX_GEO_TARGETS);
      if ("error" in geo) return fail(geo.error);
      const months = parseMonthRange(monthRange);
      if (months.error) return fail(months.error);
      const requestedSize = limit ?? 50;
      if (!Number.isInteger(requestedSize) || requestedSize < 1) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 1000.`);
      // como antes: acima de 1000 vira 1000 (o resto vem pela paginação)
      const pageSize = Math.min(requestedSize, 1000);

      const client = getClient();
      const language = await resolveLanguage(client, cid, languageCode);
      if ("error" in language) return fail(language.error);

      const body: Row = {
        language: language.resource,
        geoTargetConstants: geo.resources,
        keywordPlanNetwork: network ?? "GOOGLE_SEARCH",
        includeAdultKeywords: includeAdultKeywords ?? false,
        // sem includeAverageCpc a API nao devolve average_cpc_micros e a coluna sai zerada
        historicalMetricsOptions: { includeAverageCpc: true, ...(months.value ? { yearMonthRange: months.value } : {}) },
        pageSize,
        ...(pageToken ? { pageToken } : {}),
      };
      if (site) body.siteSeed = { site };
      else if (seedKeywords.length > 0 && url) body.keywordAndUrlSeed = { url, keywords: seedKeywords };
      else if (url) body.urlSeed = { url };
      else body.keywordSeed = { keywords: seedKeywords };

      let response: { results?: Row[]; nextPageToken?: string; totalSize?: string | number };
      try {
        response = await client.customerAction(cid, ":generateKeywordIdeas", body);
      } catch (err) {
        return apiFailure("gerar ideias de palavras-chave", err);
      }

      const ideas: Row[] = (response.results ?? []).slice(0, pageSize).map((r) => {
        const m = obj(r.keywordIdeaMetrics);
        return {
          keyword: r.text,
          avg_monthly_searches: num(m.avgMonthlySearches),
          competition: m.competition ?? "UNSPECIFIED",
          competition_index: num(m.competitionIndex),
          low_top_of_page_bid: microsToMoney(m.lowTopOfPageBidMicros),
          high_top_of_page_bid: microsToMoney(m.highTopOfPageBidMicros),
          average_cpc: microsToMoney(m.averageCpcMicros),
          ...(list(r.closeVariants).length ? { close_variants: list(r.closeVariants) } : {}),
          ...(includeMonthly ? { monthly_searches: monthlyVolumes(m) } : {}),
        };
      });

      const header =
        `${ideas.length} ideia(s) — idioma ${language.code} (${language.resource}).` +
        (response.totalSize !== undefined ? ` Total disponível: ${String(response.totalSize)}.` : "") +
        (response.nextPageToken ? `\nnextPageToken: ${response.nextPageToken}` : "\nÚltima página.");
      return render(format === "json" || !format ? ideas : withMonthColumns(ideas), format, header);
    }
  );

  // ── Planejador: métricas históricas de uma lista ───────────────────

  mcp.registerTool(
    "get_keyword_historical_metrics",
    {
      description: [
        "Volume de busca, sazonalidade (mês a mês), concorrência e faixa de lance para UMA LISTA de palavras-chave",
        "sua (Keyword Planner → métricas históricas). READ OPERATION — não altera a conta.",
        "",
        "Até 10.000 keywords por chamada. A API junta variantes próximas (ex: 'carro' e 'carros'):",
        "cada linha traz close_variants e a resposta lista as keywords que não voltaram com linha própria.",
        "Default: idioma pt, Brasil (2076), rede GOOGLE_SEARCH, últimos 12 meses (monthRange para até 4 anos).",
        "format=table/csv põe um mês por coluna.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(z.string()).describe("Keywords a consultar (1 a 10.000)."),
        languageCode: z.string().optional().describe("Código do idioma ISO (ou ID numérico). Default: 'pt'."),
        geoTargetIds: flexArray(z.string()).optional().describe("Geo target IDs (até 10). Default: ['2076'] (Brasil)."),
        network: z.enum(KEYWORD_PLAN_NETWORKS).optional().describe("Rede. Default: GOOGLE_SEARCH."),
        includeAdultKeywords: z.boolean().optional().describe("Incluir termos adultos. Default: false."),
        monthRange: z.object({
          start: z.string().describe("Mês inicial YYYY-MM."),
          end: z.string().describe("Mês final YYYY-MM."),
        }).optional().describe("Meses do histórico (default: últimos 12; até 4 anos atrás)."),
        includeMonthly: z.boolean().optional().describe("Volume mês a mês. Default: true."),
        includeDeviceBreakdown: z.boolean().optional().describe("Soma das buscas por dispositivo (MOBILE/TABLET/DESKTOP). Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, keywords, languageCode, geoTargetIds, network, includeAdultKeywords, monthRange, includeMonthly, includeDeviceBreakdown, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      const requested = [...new Set(ensureArray<string>(keywords).map((k) => String(k).trim()).filter(Boolean))];
      if (requested.length === 0) return fail("Informe ao menos uma keyword.");
      if (requested.length > MAX_HISTORICAL_KEYWORDS) {
        return fail(`A API aceita no máximo ${MAX_HISTORICAL_KEYWORDS} keywords por chamada (recebido ${requested.length}). Divida em lotes.`);
      }
      const geo = parseGeoTargets(geoTargetIds, MAX_GEO_TARGETS);
      if ("error" in geo) return fail(geo.error);
      const months = parseMonthRange(monthRange);
      if (months.error) return fail(months.error);

      const client = getClient();
      const language = await resolveLanguage(client, cid, languageCode);
      if ("error" in language) return fail(language.error);

      const body: Row = {
        keywords: requested,
        language: language.resource,
        geoTargetConstants: geo.resources,
        keywordPlanNetwork: network ?? "GOOGLE_SEARCH",
        includeAdultKeywords: includeAdultKeywords ?? false,
        historicalMetricsOptions: { includeAverageCpc: true, ...(months.value ? { yearMonthRange: months.value } : {}) },
        ...(includeDeviceBreakdown ? { aggregateMetrics: { aggregateMetricTypes: ["DEVICE"] } } : {}),
      };

      let response: { results?: Row[]; aggregateMetricResults?: Row };
      try {
        response = await client.customerAction(cid, ":generateKeywordHistoricalMetrics", body);
      } catch (err) {
        return apiFailure("consultar métricas históricas", err);
      }

      const monthly = includeMonthly ?? true;
      const covered = new Set<string>();
      const rows: Row[] = (response.results ?? []).map((r) => {
        const m = obj(r.keywordMetrics);
        const variants = list(r.closeVariants).map(String);
        [String(r.text ?? ""), ...variants].forEach((k) => covered.add(k.toLowerCase()));
        return {
          keyword: r.text,
          close_variants: variants,
          avg_monthly_searches: optNum(m.avgMonthlySearches),
          competition: m.competition ?? "UNSPECIFIED",
          competition_index: optNum(m.competitionIndex),
          low_top_of_page_bid: optMoney(m.lowTopOfPageBidMicros),
          high_top_of_page_bid: optMoney(m.highTopOfPageBidMicros),
          average_cpc: optMoney(m.averageCpcMicros),
          ...(monthly ? { monthly_searches: monthlyVolumes(m) } : {}),
        };
      });
      const notReturned = requested.filter((k) => !covered.has(k.toLowerCase()));
      const devices = list(obj(response.aggregateMetricResults).deviceSearches).map((d) => ({
        device: obj(d).device, searches: optNum(obj(d).searchCount),
      }));

      const header =
        `${rows.length} linha(s) para ${requested.length} keyword(s) — idioma ${language.code}, ${geo.resources.length} localização(ões).` +
        (notReturned.length ? `\nSem linha própria (agrupadas como variante ou sem dados): ${notReturned.join(", ")}` : "") +
        (devices.length ? `\nBuscas por dispositivo: ${devices.map((d) => `${String(d.device)}=${d.searches ?? "?"}`).join(", ")}` : "");
      return render(format === "json" || !format ? rows : withMonthColumns(rows), format, header,
        { keywords: rows, not_returned: notReturned, ...(devices.length ? { device_searches: devices } : {}) });
    }
  );

  // ── Planejador: previsão ───────────────────────────────────────────

  const keywordEntry = z.union([
    z.string(),
    z.object({ text: z.string(), matchType: z.enum(MATCH_TYPES).optional() }),
  ]);

  mcp.registerTool(
    "forecast_search_campaign",
    {
      description: [
        "Previsão de uma campanha de Pesquisa proposta (Keyword Planner → previsão): quantos cliques/conversões",
        "um orçamento diário compra. READ OPERATION — nada é criado na conta.",
        "",
        "Schema da v24+ (KeywordPlanIdeaService.GenerateKeywordForecastMetrics). Por estratégia, a API devolve:",
        "- MAXIMIZE_CLICKS (default) e MANUAL_CPC: cliques, CPC médio e custo;",
        "- MAXIMIZE_CONVERSIONS: conversões, CPA médio e custo.",
        "Impressões, CTR e valor de conversão não existem mais na previsão; negativas, rede e lance por grupo foram",
        "removidos da API na v24.",
        "",
        "Lances e orçamento em MICROS (1.000.000 = R$ 1,00). MANUAL_CPC exige maxCpcBidMicros; MAXIMIZE_CLICKS e",
        "MAXIMIZE_CONVERSIONS exigem dailyBudgetMicros. period: início futuro e fim em até 1 ano (default da API:",
        "próximo domingo ao sábado seguinte). scenarios compara até 5 variações (uma chamada cada).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (use uma conta do mesmo negócio: a previsão usa o histórico dela)."),
        adGroups: flexArray(z.object({
          keywords: flexArray(keywordEntry).describe("Keywords do grupo: texto ou {text, matchType}."),
        })).optional().describe("Grupos de anúncios da campanha proposta."),
        keywords: flexArray(keywordEntry).optional().describe("Atalho: um único grupo com estas keywords."),
        defaultMatchType: z.enum(MATCH_TYPES).optional().describe("Match type das keywords sem matchType. Default: BROAD."),
        languageCode: z.string().optional().describe("Idioma ISO (ou ID numérico). Default: 'pt'."),
        geoTargetIds: flexArray(z.string()).optional().describe("Geo target IDs. Default: ['2076'] (Brasil)."),
        bidding: z.enum(FORECAST_BIDDING).optional().describe("Estratégia. Default: MAXIMIZE_CLICKS."),
        dailyBudgetMicros: z.number().optional().describe("Orçamento diário em micros."),
        maxCpcBidMicros: z.number().optional().describe("MANUAL_CPC: lance máximo; MAXIMIZE_CLICKS: teto de CPC. Em micros."),
        period: z.object({
          since: z.string().describe("Início YYYY-MM-DD (futuro)."),
          until: z.string().describe("Fim YYYY-MM-DD (até 1 ano à frente)."),
        }).optional().describe("Período da previsão."),
        scenarios: flexArray(z.object({
          label: z.string().optional(),
          bidding: z.enum(FORECAST_BIDDING).optional(),
          dailyBudgetMicros: z.number().optional(),
          maxCpcBidMicros: z.number().optional(),
        })).optional().describe("Até 5 cenários; cada campo omitido herda o valor base."),
        format: formatSchema,
      },
    },
    async ({ customerId, adGroups, keywords, defaultMatchType, languageCode, geoTargetIds, bidding, dailyBudgetMicros, maxCpcBidMicros, period, scenarios, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      // Grupos e keywords
      const groupsInput = ensureArray<Row>(adGroups);
      const shortcut = ensureArray<unknown>(keywords);
      if (groupsInput.length && shortcut.length) return fail("Use adGroups OU keywords (atalho de um grupo), não os dois.");
      const rawGroups = groupsInput.length ? groupsInput.map((g) => ensureArray<unknown>(obj(g).keywords)) : shortcut.length ? [shortcut] : [];
      if (rawGroups.length === 0) return fail("Informe as keywords (keywords ou adGroups[].keywords).");
      const errors: string[] = [];
      const forecastGroups = rawGroups.map((group, index) => {
        if (group.length === 0) errors.push(`grupo ${index + 1}: precisa de ao menos uma keyword`);
        const parsed = group.map((k) => parseKeywordInfo(k, defaultMatchType ?? "BROAD"));
        parsed.forEach((p) => { if ("error" in p) errors.push(`grupo ${index + 1}: ${p.error}`); });
        return { keywords: parsed.filter((p): p is { text: string; matchType: string } => !("error" in p)) };
      });
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const geo = parseGeoTargets(geoTargetIds);
      if ("error" in geo) return fail(geo.error);

      // Período: início futuro, fim em até 1 ano
      let periodDays = 7;
      let forecastPeriod: Row | undefined;
      if (period) {
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        if (!iso.test(period.since ?? "") || !iso.test(period.until ?? "")) return fail("period precisa de since e until em YYYY-MM-DD.");
        const today = localIso(new Date());
        const limitDate = new Date(); limitDate.setFullYear(limitDate.getFullYear() + 1);
        if (period.since <= today) return fail(`period.since (${period.since}) precisa ser uma data futura (hoje é ${today}).`);
        if (period.until < period.since) return fail("period.until é anterior a period.since.");
        if (period.until > localIso(limitDate)) return fail(`period.until (${period.until}) passa de 1 ano à frente (${localIso(limitDate)}).`);
        periodDays = Math.round((Date.parse(period.until) - Date.parse(period.since)) / 86_400_000) + 1;
        forecastPeriod = { startDate: period.since, endDate: period.until };
      }

      // Cenários
      const base = { label: "base", bidding: bidding ?? "MAXIMIZE_CLICKS", dailyBudgetMicros, maxCpcBidMicros };
      const extra = ensureArray<Row>(scenarios);
      if (extra.length > MAX_FORECAST_SCENARIOS) return fail(`No máximo ${MAX_FORECAST_SCENARIOS} cenários por chamada (recebido ${extra.length}).`);
      const runs = (extra.length ? extra : [{}]).map((s, index) => ({
        label: String(s.label ?? (extra.length ? `cenário ${index + 1}` : base.label)),
        bidding: String(s.bidding ?? base.bidding),
        dailyBudgetMicros: (s.dailyBudgetMicros ?? base.dailyBudgetMicros) as number | undefined,
        maxCpcBidMicros: (s.maxCpcBidMicros ?? base.maxCpcBidMicros) as number | undefined,
      }));
      const strategies: Row[] = [];
      for (const run of runs) {
        const prefix = `${run.label}: `;
        const budgetError = checkMicros(run as unknown as Row, "dailyBudgetMicros", MIN_BUDGET_MICROS, run.bidding !== "MANUAL_CPC");
        const cpcError = checkMicros(run as unknown as Row, "maxCpcBidMicros", LOW_BID_MICROS, run.bidding === "MANUAL_CPC");
        if (!(FORECAST_BIDDING as readonly string[]).includes(run.bidding)) errors.push(`${prefix}bidding inválido: ${run.bidding}`);
        else if (budgetError) errors.push(prefix + budgetError);
        else if (cpcError) errors.push(prefix + cpcError);
        else if (run.bidding === "MAXIMIZE_CONVERSIONS" && run.maxCpcBidMicros !== undefined) {
          errors.push(`${prefix}MAXIMIZE_CONVERSIONS não aceita maxCpcBidMicros na previsão`);
        }
        if (run.bidding === "MANUAL_CPC") {
          strategies.push({ manualCpcBiddingStrategy: {
            maxCpcBidMicros: microsString(run.maxCpcBidMicros),
            ...(run.dailyBudgetMicros !== undefined ? { dailyBudgetMicros: microsString(run.dailyBudgetMicros) } : {}),
          } });
        } else if (run.bidding === "MAXIMIZE_CONVERSIONS") {
          strategies.push({ maximizeConversionsBiddingStrategy: { dailyTargetSpendMicros: microsString(run.dailyBudgetMicros) } });
        } else {
          strategies.push({ maximizeClicksBiddingStrategy: {
            dailyTargetSpendMicros: microsString(run.dailyBudgetMicros),
            ...(run.maxCpcBidMicros !== undefined ? { maxCpcBidCeilingMicros: microsString(run.maxCpcBidMicros) } : {}),
          } });
        }
      }
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const language = await resolveLanguage(client, cid, languageCode);
      if ("error" in language) return fail(language.error);

      const results: Row[] = [];
      for (const [index, run] of runs.entries()) {
        const body: Row = {
          ...(forecastPeriod ? { forecastPeriod } : {}),
          campaign: {
            languageConstants: [language.resource],
            geoTargetConstants: geo.resources,
            biddingStrategy: strategies[index],
            adGroups: forecastGroups,
          },
        };
        const row: Row = {
          scenario: run.label,
          bidding: run.bidding,
          daily_budget: optMoney(run.dailyBudgetMicros),
          max_cpc: optMoney(run.maxCpcBidMicros),
        };
        try {
          const response = await client.customerAction<{ campaignForecastMetrics?: Row }>(cid, ":generateKeywordForecastMetrics", body);
          const m = obj(response.campaignForecastMetrics);
          const cost = optMoney(m.costMicros);
          Object.assign(row, {
            clicks: m.clicks === undefined ? null : round2(num(m.clicks)),
            conversions: m.conversions === undefined ? null : round2(num(m.conversions)),
            cost: cost === null ? null : round2(cost),
            average_cpc: optMoney(m.averageCpcMicros),
            average_cpa: optMoney(m.averageCpaMicros),
            period_days: periodDays,
            cost_per_day: cost === null ? null : round2(cost / periodDays),
            clicks_per_day: m.clicks === undefined ? null : round2(num(m.clicks) / periodDays),
            conversions_per_day: m.conversions === undefined ? null : round2(num(m.conversions) / periodDays),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          row.error = `${message}${apiHint(message).replace(/\n/g, " ")}`;
        }
        results.push(row);
      }

      const failed = results.filter((r) => r.error).length;
      const totalKeywords = forecastGroups.reduce((n, g) => n + g.keywords.length, 0);
      const header =
        `Previsão (moeda da conta) — ${forecastGroups.length} grupo(s), ${totalKeywords} keyword(s), idioma ${language.code}, ` +
        `${geo.resources.length} localização(ões), ${forecastPeriod ? `${period!.since} a ${period!.until}` : "período default da API (7 dias)"}.` +
        (failed ? `\n${failed} cenário(s) com erro.` : "");
      const out = render(results, format, header);
      return failed === results.length ? { ...out, isError: true } : out;
    }
  );

  // ── Planejador: temas de grupos de anúncios ────────────────────────

  mcp.registerTool(
    "suggest_ad_group_themes",
    {
      description: [
        "Sugere, para cada keyword, em qual grupo de anúncios EXISTENTE ela se encaixa e com qual match type",
        "(KeywordPlanIdeaService.GenerateAdGroupThemes). READ OPERATION — não adiciona nada.",
        "",
        "Os grupos são conferidos na conta antes da chamada. Para adicionar as keywords depois, use create_keyword.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        keywords: flexArray(z.string()).describe("Keywords a organizar."),
        adGroupIds: flexArray(z.string()).describe("IDs dos grupos de anúncios candidatos (da mesma conta)."),
        format: formatSchema,
      },
    },
    async ({ customerId, keywords, adGroupIds, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      const kws = [...new Set(ensureArray<string>(keywords).map((k) => String(k).trim()).filter(Boolean))];
      const ids = [...new Set(ensureArray<string>(adGroupIds).map((id) => String(id).trim()).filter(Boolean))];
      if (kws.length === 0) return fail("Informe ao menos uma keyword.");
      if (ids.length === 0) return fail("Informe ao menos um adGroupId.");
      const badIds = ids.filter((id) => !/^\d+$/.test(id));
      if (badIds.length) return fail(`adGroupIds inválidos: ${badIds.join(", ")} (use IDs numéricos).`);

      const client = getClient();
      const groupRows = await client.searchStream(cid,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.resource_name, campaign.id, campaign.name
         FROM ad_group
         WHERE ad_group.id IN (${ids.join(", ")})
           AND ad_group.status != 'REMOVED'`);
      const groups = new Map<string, { name: string; campaign: string; campaignName: string; resourceName: string }>();
      const campaignNames = new Map<string, string>();
      for (const row of groupRows) {
        const ag = obj(row.adGroup);
        const campaign = obj(row.campaign);
        groups.set(String(ag.id), {
          name: String(ag.name ?? ""),
          campaign: String(campaign.id ?? ""),
          campaignName: String(campaign.name ?? ""),
          resourceName: String(ag.resourceName ?? `customers/${cid}/adGroups/${String(ag.id)}`),
        });
        campaignNames.set(`customers/${cid}/campaigns/${String(campaign.id)}`, String(campaign.name ?? ""));
      }
      const missing = ids.filter((id) => !groups.has(id));
      if (missing.length) return fail(`Grupos não encontrados nesta conta (ou removidos): ${missing.join(", ")}. Nada foi enviado.`);

      let response: { adGroupKeywordSuggestions?: Row[]; unusableAdGroups?: Row[] };
      try {
        response = await client.customerAction(cid, ":generateAdGroupThemes", {
          keywords: kws,
          adGroups: ids.map((id) => groups.get(id)!.resourceName),
        });
      } catch (err) {
        return apiFailure("gerar temas de grupos de anúncios", err);
      }

      const byResource = new Map([...groups.entries()].map(([id, g]) => [g.resourceName, { id, ...g }]));
      const rows: Row[] = (response.adGroupKeywordSuggestions ?? []).map((s) => {
        const group = byResource.get(String(s.suggestedAdGroup ?? ""));
        return {
          keyword: s.keywordText,
          suggested_keyword: s.suggestedKeywordText ?? s.keywordText,
          match_type: s.suggestedMatchType ?? null,
          ad_group_id: group?.id ?? (s.suggestedAdGroup ? String(s.suggestedAdGroup).split("/").pop() : null),
          ad_group: group?.name ?? (s.suggestedAdGroup ? String(s.suggestedAdGroup) : "(nenhum grupo sugerido)"),
          campaign: group?.campaignName ?? campaignNames.get(String(s.suggestedCampaign ?? "")) ?? s.suggestedCampaign ?? null,
        };
      });
      const unusable = (response.unusableAdGroups ?? []).map((u) => {
        const id = String(u.adGroup ?? "").split("/").pop() ?? "";
        return { ad_group_id: id, ad_group: groups.get(id)?.name ?? u.adGroup, campaign: groups.get(id)?.campaignName ?? u.campaign };
      });
      const header = `${rows.length} sugestão(ões) para ${kws.length} keyword(s) em ${ids.length} grupo(s).` +
        (unusable.length ? `\nGrupos que a API não pôde usar: ${unusable.map((u) => `${String(u.ad_group)} (${u.ad_group_id})`).join(", ")}` : "");
      return render(rows, format, header, { suggestions: rows, unusable_ad_groups: unusable });
    }
  );

  // ── Recomendações: listar ──────────────────────────────────────────

  mcp.registerTool(
    "list_recommendations",
    {
      description: [
        "Lista recomendações do Google Ads para a conta (orçamento, keywords, lances, RSA, PMax...).",
        "READ OPERATION.",
        "",
        "Cada linha traz o tipo, a campanha (ou o orçamento e as campanhas que ele atende), o impacto estimado",
        "(base vs. potencial) e em details o VALOR que o Google propõe — orçamento atual vs. recomendado e as opções,",
        "CPA/ROAS sugerido, keyword e lance etc. Use o resource_name em apply_recommendation (com ou sem overrides)",
        "ou dismiss_recommendation.",
        "",
        "Filtro por campanha inclui as recomendações de orçamento (CAMPAIGN_BUDGET, FORECASTING_CAMPAIGN_BUDGET,",
        "MARGINAL_ROI_CAMPAIGN_BUDGET, MOVE_UNUSED_BUDGET), que a API liga a recommendation.campaigns, não a",
        "recommendation.campaign.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        types: flexArray(z.enum(RECOMMENDATION_TYPES)).optional().describe("Filtra por tipos de recomendação."),
        campaignId: z.string().optional().describe("Filtra por campanha (inclui orçamento compartilhado com ela)."),
        limit: z.number().optional().describe("Máximo de resultados. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, types, campaignId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      const typeList = [...new Set(ensureArray<string>(types).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
      const badTypes = typeList.filter((t) => !(RECOMMENDATION_TYPES as readonly string[]).includes(t));
      if (badTypes.length) return fail(`Tipos de recomendação inválidos: ${badTypes.join(", ")}.`);
      if (campaignId !== undefined && !/^\d+$/.test(campaignId.trim())) return fail(`campaignId inválido: ${campaignId}`);
      const max = limit ?? 50;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 10000.`);

      const typeFilter = typeList.length ? `recommendation.type IN (${typeList.map((t) => `'${t}'`).join(", ")})` : "";
      const query = (campaignFilter: string) => {
        const where = [campaignFilter, typeFilter].filter(Boolean);
        return `SELECT ${RECOMMENDATION_SELECT}
         FROM recommendation
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY recommendation.type
         LIMIT ${max}`;
      };

      const client = getClient();
      let rows: Row[];
      if (campaignId) {
        const campaignResource = `customers/${cid}/campaigns/${campaignId.trim()}`;
        // Recomendações de orçamento preenchem recommendation.campaigns (repetido), não recommendation.campaign
        const direct = await client.searchStream(cid, query(`recommendation.campaign = '${campaignResource}'`));
        const viaBudget = await client.searchStream(cid, query(`recommendation.campaigns CONTAINS ANY ('${campaignResource}')`));
        const merged = new Map<string, Row>();
        for (const row of [...direct, ...viaBudget]) {
          const name = String(obj(row.recommendation).resourceName ?? "");
          if (!merged.has(name)) merged.set(name, row);
        }
        rows = [...merged.values()].slice(0, max);
      } else {
        rows = await client.searchStream(cid, query(""));
      }

      // Nomes das campanhas atendidas pelos orçamentos (recommendation.campaigns só traz resource names)
      const campaignResources = [...new Set(rows.flatMap((row) => list(obj(row.recommendation).campaigns).map(String)))]
        .filter((rn) => /^customers\/\d+\/campaigns\/\d+$/.test(rn));
      const campaignNames = new Map<string, string>();
      if (campaignResources.length) {
        const nameRows = await client.searchStream(cid,
          `SELECT campaign.resource_name, campaign.name
           FROM campaign
           WHERE campaign.resource_name IN (${campaignResources.map((rn) => `'${rn}'`).join(", ")})`);
        for (const row of nameRows) {
          const campaign = obj(row.campaign);
          campaignNames.set(String(campaign.resourceName ?? ""), String(campaign.name ?? ""));
        }
      }

      const out: Row[] = rows.map((row) => {
        const rec = obj(row.recommendation);
        const details = recommendationDetails(rec);
        return {
          type: rec.type,
          campaign: recommendationLabel(row, campaignNames),
          ...(list(rec.campaigns).length ? { campaigns: list(rec.campaigns).map((rn) => campaignNames.get(String(rn)) ?? rn) } : {}),
          ...(rec.campaignBudget ? { campaign_budget: rec.campaignBudget } : {}),
          ...(obj(row.adGroup).name ? { ad_group: obj(row.adGroup).name } : {}),
          resource_name: rec.resourceName,
          dismissed: Boolean(rec.dismissed),
          ...impactView(rec.impact),
          details,
        };
      });

      if (format === "table" || format === "csv") {
        const flat = out.map(({ details, campaigns, ...rest }) => ({
          ...rest,
          ...(Array.isArray(campaigns) ? { campaigns: campaigns.join("; ") } : {}),
          details: detailsText(details as Row),
        }));
        return render(flat as Row[], format, `${out.length} recomendação(ões).`);
      }
      return { content: [text(`${out.length} recomendação(ões).\n\n${formatJson(out)}`)] };
    }
  );

  // ── Recomendações: aplicar ─────────────────────────────────────────

  mcp.registerTool(
    "apply_recommendation",
    {
      description: [
        "Aplica recomendações do Google Ads — com os valores do Google ou com os SEUS (overrides).",
        "WRITE OPERATION — altera a conta imediatamente (não cria nada pausado). Exige confirm: true.",
        "",
        "Pegue os resource_names e os valores propostos em list_recommendations. Para aplicar com outro valor,",
        "use applications: [{ resourceName, overrides: { <parâmetro>: {...} } }] — um parâmetro por recomendação,",
        "e ele precisa corresponder ao tipo dela:",
        "campaignBudget (CAMPAIGN_BUDGET), keyword (KEYWORD), targetCpaOptIn, targetRoasOptIn, moveUnusedBudget,",
        "useBroadMatchKeyword, raiseTargetCpaBidTooLow, raiseTargetCpa, lowerTargetRoas, setTargetCpa, setTargetRoas,",
        "forecastingSetTargetCpa, forecastingSetTargetRoas. Valores monetários em MICROS; ROAS em proporção (4 = 400%).",
        "",
        "Antes de gravar, cada recomendação é lida na conta (existe? tipo compatível com o override?). Até 100 por",
        "chamada; o resultado vem por item. O endpoint não tem validate_only: validateOnly/dry-run recusa a chamada.",
        "Campo desconhecido em applications/overrides (ex: snake_case, parâmetro de outro tipo) recusa a chamada",
        "inteira — nunca cai para os valores do Google em silêncio.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceNames: flexArray(z.string()).optional().describe("resource_names aplicados com os valores do Google."),
        applications: flexArray(strictObject({
          resourceName: z.string(),
          overrides: overridesSchema.optional(),
        }, "applications[]")).optional().describe("Recomendações com overrides (seus valores no lugar dos do Google)."),
        overrides: z.unknown().optional().describe(
          "NÃO use neste nível: overrides vai dentro de cada item de applications ([{ resourceName, overrides }]). " +
          "Enviado aqui, a chamada é recusada sem aplicar nada."
        ),
        confirm: z.boolean().describe("Precisa ser true — a mudança é imediata e não fica pausada."),
      },
    },
    async ({ customerId, resourceNames, applications, overrides: misplacedOverrides, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!confirm) {
        return fail("Cancelado: aplicar recomendação altera a conta na hora. Envie confirm: true.");
      }
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);
      // fora de applications o override seria ignorado e a recomendação sairia com os valores do Google
      if (misplacedOverrides !== undefined) {
        return fail(
          "Nada foi aplicado: overrides vai dentro de cada item de applications, não no nível de cima. " +
          "Use applications: [{ resourceName, overrides: { <parâmetro>: {...} } }]."
        );
      }

      const applicationList = ensureArray<unknown>(applications);
      const shapeErrors = applicationShapeErrors(applicationList);
      if (shapeErrors.length) return fail(`Nada foi aplicado:\n- ${shapeErrors.join("\n- ")}`);
      const items = [
        ...ensureArray<string>(resourceNames).map((resourceName) => ({ resourceName, overrides: undefined as unknown })),
        ...applicationList.map((a) => ({ resourceName: String(obj(a).resourceName ?? ""), overrides: obj(a).overrides })),
      ];
      const parsed = parseRecommendationNames(items.map((i) => i.resourceName), cid);
      if ("error" in parsed) return fail(parsed.error);
      const overrideErrors: string[] = [];
      const overrides = items.map((item) => {
        const result = parseOverride(item.overrides);
        if (result.error) overrideErrors.push(`${item.resourceName}: ${result.error}`);
        return result;
      });
      if (overrideErrors.length) return fail(`Nada foi aplicado:\n- ${overrideErrors.join("\n- ")}`);

      const client = getClient();
      const operations = parsed.names.map((resourceName, index) => {
        const override = overrides[index];
        return override.key
          ? { resourceName, [override.key]: OVERRIDE_SPECS[override.key].build(override.params!, cid) }
          : { resourceName };
      });
      // recommendations:apply não tem validate_only: em dry-run nada sai, nem as leituras
      if (client.isDryRun) {
        return fail(
          "GOOGLE_ADS_DRY_RUN: recommendations:apply não aceita validateOnly — mutação bloqueada em dry-run. " +
          `Nada foi enviado à API.\nOperações que seriam enviadas:\n${formatJson(operations)}`
        );
      }

      // Leitura antes de gravar: existe nesta conta? o override bate com o tipo?
      const found = await fetchRecommendations(client, cid, parsed.names);
      const problems: string[] = [];
      parsed.names.forEach((name, index) => {
        const row = found.get(name);
        if (!row) {
          problems.push(`${name}: não encontrada nesta conta (obsoleta, já aplicada ou expirada — rode list_recommendations de novo)`);
          return;
        }
        const type = String(obj(row.recommendation).type ?? "");
        const key = overrides[index].key;
        if (key && !OVERRIDE_SPECS[key].types.includes(type)) {
          problems.push(`${name}: o override "${key}" vale para ${OVERRIDE_SPECS[key].types.join("/")}, mas esta recomendação é ${type}`);
        }
      });
      const keywordGroups = [...new Set(overrides.filter((o) => o.key === "keyword").map((o) => String(o.params!.adGroupId)))];
      if (keywordGroups.length && !problems.length) {
        const groupRows = await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.status
           FROM ad_group
           WHERE ad_group.id IN (${keywordGroups.join(", ")})
             AND ad_group.status != 'REMOVED'`);
        const existing = new Set(groupRows.map((r) => String(obj(r.adGroup).id)));
        for (const id of keywordGroups.filter((g) => !existing.has(g))) {
          problems.push(`override keyword: grupo de anúncios ${id} não encontrado nesta conta (ou removido)`);
        }
      }
      if (problems.length) return fail(`Nada foi aplicado:\n- ${problems.join("\n- ")}`);

      let result: { results?: Row[]; partialFailureError?: unknown };
      try {
        result = await client.customerWriteAction(cid, "recommendations:apply", { operations, partialFailure: true });
      } catch (err) {
        return apiFailure("aplicar recomendações", err);
      }

      const { byIndex, unattributed } = partialFailureByOperation(result.partialFailureError, operations.length);
      const report = parsed.names.map((name, index) => {
        const row = found.get(name)!;
        const rec = obj(row.recommendation);
        const errs = byIndex.get(index);
        const confirmed = Boolean(obj((result.results ?? [])[index]).resourceName);
        const override = overrides[index];
        return {
          resource_name: name,
          type: rec.type,
          campaign: recommendationLabel(row),
          google_recommended: recommendationDetails(rec),
          applied_with: override.key ? { [override.key]: override.params } : "valores do Google",
          status: errs ? "falhou" : confirmed ? "aplicada" : "sem confirmação da API",
          ...(errs ? { errors: errs } : {}),
        };
      });
      const applied = report.filter((r) => r.status === "aplicada").length;
      return {
        content: [text(
          `${applied}/${parsed.names.length} recomendação(ões) aplicada(s).` +
          (unattributed.length ? `\nFalhas sem índice: ${unattributed.join("; ")}` : "") +
          `\n\n${formatJson(report)}`
        )],
        isError: applied < parsed.names.length,
      };
    }
  );

  // ── Recomendações: dispensar ───────────────────────────────────────

  mcp.registerTool(
    "dismiss_recommendation",
    {
      description: [
        "Dispensa (esconde) recomendações do Google Ads sem aplicá-las.",
        "WRITE OPERATION — reversível: recomendações dispensadas ainda podem ser aplicadas.",
        "",
        "Cada recomendação é lida antes: as que não existem na conta são recusadas e as já dispensadas são puladas.",
        "Até 100 por chamada; resultado por item. O endpoint não tem validate_only: validateOnly/dry-run recusa a chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceNames: flexArray(z.string()).describe("resource_names das recomendações (de list_recommendations)."),
      },
    },
    async ({ customerId, resourceNames }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);
      const parsed = parseRecommendationNames(ensureArray<string>(resourceNames), cid);
      if ("error" in parsed) return fail(parsed.error);

      const client = getClient();
      if (client.isDryRun) {
        return fail(
          "GOOGLE_ADS_DRY_RUN: recommendations:dismiss não aceita validateOnly — mutação bloqueada em dry-run. " +
          `Nada foi enviado à API. Seriam dispensadas: ${parsed.names.join(", ")}`
        );
      }

      const found = await fetchRecommendations(client, cid, parsed.names);
      const notFound = parsed.names.filter((name) => !found.has(name));
      const alreadyDismissed = parsed.names.filter((name) => found.has(name) && Boolean(obj(found.get(name)!.recommendation).dismissed));
      const toDismiss = parsed.names.filter((name) => found.has(name) && !alreadyDismissed.includes(name));
      const lines = [
        ...(alreadyDismissed.length ? [`Já dispensadas (nada a fazer): ${alreadyDismissed.join(", ")}`] : []),
        ...(notFound.length ? [`Não encontradas nesta conta (obsoletas ou já aplicadas): ${notFound.join(", ")}`] : []),
      ];
      if (toDismiss.length === 0) {
        return { content: [text(`Nenhuma recomendação dispensada.\n${lines.join("\n")}`)], isError: notFound.length > 0 };
      }

      let result: { results?: Row[]; partialFailureError?: unknown };
      try {
        result = await client.customerWriteAction(cid, "recommendations:dismiss", {
          operations: toDismiss.map((resourceName) => ({ resourceName })),
          partialFailure: true,
        });
      } catch (err) {
        return apiFailure("dispensar recomendações", err);
      }
      const { byIndex, unattributed } = partialFailureByOperation(result.partialFailureError, toDismiss.length);
      const report = toDismiss.map((name, index) => {
        const row = found.get(name)!;
        const errs = byIndex.get(index);
        const confirmed = Boolean(obj((result.results ?? [])[index]).resourceName);
        return {
          resource_name: name,
          type: obj(row.recommendation).type,
          campaign: recommendationLabel(row),
          status: errs ? "falhou" : confirmed ? "dispensada" : "sem confirmação da API",
          ...(errs ? { errors: errs } : {}),
        };
      });
      const dismissed = report.filter((r) => r.status === "dispensada").length;
      return {
        content: [text(
          `${dismissed}/${toDismiss.length} recomendação(ões) dispensada(s).` +
          (lines.length ? `\n${lines.join("\n")}` : "") +
          (unattributed.length ? `\nFalhas sem índice: ${unattributed.join("; ")}` : "") +
          `\n\n${formatJson(report)}`
        )],
        isError: dismissed < toDismiss.length || notFound.length > 0,
      };
    }
  );

  // ── Recomendações para campanha ainda não criada ───────────────────

  mcp.registerTool(
    "generate_recommendations",
    {
      description: [
        "Recomendações para uma campanha de Pesquisa ou Performance Max que AINDA NÃO EXISTE (construção de campanha):",
        "orçamento recomendado, keywords, estratégia de lance, CPA/ROAS desejado e sitelinks.",
        "READ OPERATION — RecommendationService.GenerateRecommendations não cria nem altera nada.",
        "",
        "Use antes de create_campaign / create_pmax_campaign. Dados exigidos por tipo (o Google não avisa quando",
        "faltam — só não devolve a recomendação, por isso a tool confere antes):",
        "- CAMPAIGN_BUDGET: biddingStrategyType e finalUrl; em SEARCH também countryCodes, languageCodes,",
        "  positiveLocationIds ou negativeLocationIds, adGroupKeywords e, com TARGET_IMPRESSION_SHARE, targetImpressionShare.",
        "- KEYWORD: keywordSeeds e/ou seedUrl.",
        "- MAXIMIZE_*_OPT_IN, TARGET_*_OPT_IN, SET_TARGET_CPA/ROAS: biddingStrategyType (+ status de conversão,",
        "  lido da conta quando não informado).",
        "- SITELINK_ASSET: sitelinkCount (quantos sitelinks a campanha terá).",
        "Valores monetários em MICROS.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        advertisingChannelType: z.enum(["SEARCH", "PERFORMANCE_MAX"]).describe("Tipo da campanha em construção."),
        types: flexArray(z.enum(GENERATE_TYPES)).describe("Tipos de recomendação a gerar."),
        biddingStrategyType: z.enum(BIDDING_STRATEGY_TYPES).optional().describe("Estratégia de lance planejada."),
        targetCpaMicros: z.number().optional().describe("CPA desejado em micros (TARGET_CPA ou MAXIMIZE_CONVERSIONS)."),
        targetRoas: z.number().optional().describe("ROAS desejado (TARGET_ROAS ou MAXIMIZE_CONVERSION_VALUE)."),
        targetImpressionShare: z.object({
          location: z.enum(["ANYWHERE_ON_PAGE", "TOP_OF_PAGE", "ABSOLUTE_TOP_OF_PAGE"]),
          targetImpressionShareMicros: z.number().describe("1% = 10.000; 100% = 1.000.000."),
          maxCpcBidCeilingMicros: z.number().optional(),
        }).optional().describe("Obrigatório com TARGET_IMPRESSION_SHARE."),
        conversionTrackingStatus: z.enum(CONVERSION_TRACKING_STATUSES).optional()
          .describe("Default: lido da conta (customer.conversion_tracking_setting)."),
        finalUrl: z.string().optional().describe("URL final da campanha / do grupo de recursos."),
        headlines: flexArray(z.string()).optional().describe("Títulos (opcional, CAMPAIGN_BUDGET)."),
        descriptions: flexArray(z.string()).optional().describe("Descrições (opcional, CAMPAIGN_BUDGET)."),
        adGroupKeywords: flexArray(keywordEntry).optional().describe("Keywords do grupo planejado (texto ou {text, matchType})."),
        adGroupType: z.enum(AD_GROUP_TYPES).optional().describe("Tipo do grupo planejado (ex: SEARCH_STANDARD)."),
        keywordSeeds: flexArray(z.string()).optional().describe("Sementes para KEYWORD."),
        seedUrl: z.string().optional().describe("URL semente para KEYWORD, com ou sem http(s)://."),
        currentBudgetMicros: z.number().optional().describe("Orçamento diário planejado em micros (opcional)."),
        countryCodes: flexArray(z.string()).optional().describe("Países (ex: ['BR'])."),
        languageCodes: flexArray(z.string()).optional().describe("Idiomas (ex: ['pt'])."),
        positiveLocationIds: flexArray(z.string()).optional().describe("Geo target IDs segmentados."),
        negativeLocationIds: flexArray(z.string()).optional().describe("Geo target IDs excluídos."),
        sitelinkCount: z.number().optional().describe("Quantidade de sitelinks planejada (SITELINK_ASSET)."),
        imageAssetCount: z.number().optional().describe("Quantidade de imagens (opcional)."),
        callAssetCount: z.number().optional().describe("Quantidade de call assets (opcional)."),
        targetPartnerSearchNetwork: z.boolean().optional(),
        targetContentNetwork: z.boolean().optional(),
        merchantCenterAccountId: z.string().optional().describe("Só PERFORMANCE_MAX: gera para PMax de varejo."),
        isNewCustomer: z.boolean().optional().describe("true só para conta sem nenhuma campanha."),
        format: formatSchema,
      },
    },
    async (args) => {
      const { customerId, advertisingChannelType, types, format } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      const typeList = [...new Set(ensureArray<string>(types).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
      const errors: string[] = [];
      if (typeList.length === 0) errors.push("types: informe ao menos um tipo");
      const badTypes = typeList.filter((t) => !(GENERATE_TYPES as readonly string[]).includes(t));
      if (badTypes.length) errors.push(`types não suportados na geração: ${badTypes.join(", ")} (use ${GENERATE_TYPES.join(", ")})`);
      if (!["SEARCH", "PERFORMANCE_MAX"].includes(String(advertisingChannelType))) errors.push("advertisingChannelType precisa ser SEARCH ou PERFORMANCE_MAX");

      const strategy = args.biddingStrategyType;
      const search = advertisingChannelType === "SEARCH";
      const keywordsParsed = ensureArray<unknown>(args.adGroupKeywords).map((k) => parseKeywordInfo(k, "BROAD"));
      keywordsParsed.forEach((k) => { if ("error" in k) errors.push(`adGroupKeywords: ${k.error}`); });
      const adGroupKeywords = keywordsParsed.filter((k): k is { text: string; matchType: string } => !("error" in k));
      const seeds = ensureArray<string>(args.keywordSeeds).map((s) => String(s).trim()).filter(Boolean);
      const countries = ensureArray<string>(args.countryCodes).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
      const languages = ensureArray<string>(args.languageCodes).map((l) => String(l).trim()).filter(Boolean);
      const positive = ensureArray<string>(args.positiveLocationIds).map((l) => String(l).trim()).filter(Boolean);
      const negative = ensureArray<string>(args.negativeLocationIds).map((l) => String(l).trim()).filter(Boolean);
      const headlines = ensureArray<string>(args.headlines).map((h) => String(h).trim()).filter(Boolean);
      const descriptions = ensureArray<string>(args.descriptions).map((d) => String(d).trim()).filter(Boolean);
      const finalUrl = args.finalUrl?.trim();
      const seedUrl = args.seedUrl?.trim();

      if (countries.some((c) => !/^[A-Z]{2}$/.test(c))) errors.push(`countryCodes inválidos: ${countries.join(", ")} (use ISO de 2 letras, ex: BR)`);
      if (languages.some((l) => !/^[A-Za-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(l))) errors.push(`languageCodes inválidos: ${languages.join(", ")} (ex: pt, en)`);
      const badLocations = [...positive, ...negative].filter((l) => !/^\d+$/.test(l));
      if (badLocations.length) errors.push(`IDs de localização inválidos: ${badLocations.join(", ")}`);
      // final_url é a URL final do grupo de recursos (com esquema); url_seed é semente do Planejador
      // e aceita o formato sem esquema do exemplo do proto (www.example.com/cars)
      if (finalUrl && !/^https?:\/\/\S+$/i.test(finalUrl)) errors.push(`finalUrl inválida: "${finalUrl}" (use http(s)://...)`);
      if (seedUrl && !isSeedUrl(seedUrl)) errors.push(`seedUrl inválida: "${seedUrl}" (ex: www.loja.com.br/produto, com ou sem http(s)://)`);
      if (args.merchantCenterAccountId !== undefined) {
        if (!/^\d+$/.test(args.merchantCenterAccountId)) errors.push("merchantCenterAccountId precisa ser numérico");
        if (search) errors.push("merchantCenterAccountId só vale para PERFORMANCE_MAX");
      }
      for (const [label, value] of [["sitelinkCount", args.sitelinkCount], ["imageAssetCount", args.imageAssetCount], ["callAssetCount", args.callAssetCount]] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 0)) errors.push(`${label} precisa ser inteiro >= 0`);
      }
      const budgetError = checkMicros(args as Row, "currentBudgetMicros", MIN_BUDGET_MICROS, false);
      if (budgetError) errors.push(budgetError);

      // bidding_strategy_target_info é oneof
      const targets = [args.targetCpaMicros, args.targetRoas, args.targetImpressionShare].filter((v) => v !== undefined);
      if (targets.length > 1) errors.push("use só um de targetCpaMicros, targetRoas ou targetImpressionShare");
      if (args.targetCpaMicros !== undefined) {
        const e = checkMicros(args as Row, "targetCpaMicros", LOW_BID_MICROS, true);
        if (e) errors.push(e);
        if (!["TARGET_CPA", "MAXIMIZE_CONVERSIONS"].includes(String(strategy))) errors.push("targetCpaMicros só vale com biddingStrategyType TARGET_CPA ou MAXIMIZE_CONVERSIONS");
      }
      if (args.targetRoas !== undefined) {
        const e = checkRoas(args as Row, "targetRoas", true);
        if (e) errors.push(e);
        if (!["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"].includes(String(strategy))) errors.push("targetRoas só vale com biddingStrategyType TARGET_ROAS ou MAXIMIZE_CONVERSION_VALUE");
      }
      const tis = args.targetImpressionShare;
      if (tis) {
        if (!Number.isInteger(tis.targetImpressionShareMicros) || tis.targetImpressionShareMicros < 1 || tis.targetImpressionShareMicros > 1_000_000) {
          errors.push("targetImpressionShare.targetImpressionShareMicros precisa estar entre 1 e 1.000.000 (1% = 10.000)");
        }
        if (strategy !== "TARGET_IMPRESSION_SHARE") errors.push("targetImpressionShare só vale com biddingStrategyType TARGET_IMPRESSION_SHARE");
      }

      // Dados exigidos por tipo (docs "Recommendations in campaign construction")
      const needsBidding = typeList.filter((t) => t !== "KEYWORD" && t !== "SITELINK_ASSET");
      if (needsBidding.length && !strategy) errors.push(`${needsBidding.join(", ")}: biddingStrategyType é obrigatório`);
      if (typeList.includes("CAMPAIGN_BUDGET")) {
        if (!finalUrl) errors.push("CAMPAIGN_BUDGET: finalUrl é obrigatório (asset_group_info.final_url)");
        if (search) {
          if (!countries.length) errors.push("CAMPAIGN_BUDGET em SEARCH: countryCodes é obrigatório");
          if (!languages.length) errors.push("CAMPAIGN_BUDGET em SEARCH: languageCodes é obrigatório");
          if (!positive.length && !negative.length) errors.push("CAMPAIGN_BUDGET em SEARCH: positiveLocationIds ou negativeLocationIds é obrigatório");
          if (!adGroupKeywords.length) errors.push("CAMPAIGN_BUDGET em SEARCH: adGroupKeywords é obrigatório");
          if (strategy === "TARGET_IMPRESSION_SHARE" && !tis) errors.push("CAMPAIGN_BUDGET com TARGET_IMPRESSION_SHARE: targetImpressionShare é obrigatório");
        }
      }
      if (typeList.includes("KEYWORD") && !seeds.length && !seedUrl) errors.push("KEYWORD: informe keywordSeeds e/ou seedUrl");
      if (typeList.includes("SITELINK_ASSET") && args.sitelinkCount === undefined) errors.push("SITELINK_ASSET: sitelinkCount é obrigatório");
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      let conversionStatus: string | undefined = args.conversionTrackingStatus;
      const needsConversionStatus = typeList.some((t) => t !== "KEYWORD" && t !== "SITELINK_ASSET" && t !== "CAMPAIGN_BUDGET");
      if (needsConversionStatus && !conversionStatus) {
        const rows = await client.searchStream(cid,
          `SELECT customer.conversion_tracking_setting.conversion_tracking_status
           FROM customer
           LIMIT 1`);
        const status = obj(obj(obj(rows[0]).customer).conversionTrackingSetting).conversionTrackingStatus;
        conversionStatus = status ? String(status) : undefined;
      }

      const biddingInfo: Row | undefined = strategy
        ? {
            biddingStrategyType: strategy,
            ...(args.targetCpaMicros !== undefined ? { targetCpaMicros: microsString(args.targetCpaMicros) } : {}),
            ...(args.targetRoas !== undefined ? { targetRoas: args.targetRoas } : {}),
            ...(tis ? { targetImpressionShareInfo: {
              location: tis.location,
              targetImpressionShareMicros: String(tis.targetImpressionShareMicros),
              ...(tis.maxCpcBidCeilingMicros !== undefined ? { maxCpcBidCeiling: microsString(tis.maxCpcBidCeilingMicros) } : {}),
            } } : {}),
          }
        : undefined;
      const body: Row = {
        recommendationTypes: typeList,
        advertisingChannelType,
        ...(args.sitelinkCount !== undefined ? { campaignSitelinkCount: args.sitelinkCount } : {}),
        ...(conversionStatus ? { conversionTrackingStatus: conversionStatus } : {}),
        ...(biddingInfo ? { biddingInfo } : {}),
        ...(adGroupKeywords.length || args.adGroupType
          ? { adGroupInfo: [{ ...(args.adGroupType ? { adGroupType: args.adGroupType } : {}), keywords: adGroupKeywords }] }
          : {}),
        ...(seeds.length || seedUrl ? { seedInfo: { ...(seedUrl ? { urlSeed: seedUrl } : {}), keywordSeeds: seeds } } : {}),
        ...(args.currentBudgetMicros !== undefined ? { budgetInfo: { currentBudget: microsString(args.currentBudgetMicros) } } : {}),
        ...(args.imageAssetCount !== undefined ? { campaignImageAssetCount: args.imageAssetCount } : {}),
        ...(args.callAssetCount !== undefined ? { campaignCallAssetCount: args.callAssetCount } : {}),
        ...(countries.length ? { countryCodes: countries } : {}),
        ...(languages.length ? { languageCodes: languages } : {}),
        ...(positive.length ? { positiveLocationsIds: positive } : {}),
        ...(negative.length ? { negativeLocationsIds: negative } : {}),
        ...(finalUrl ? { assetGroupInfo: [{ finalUrl, headline: headlines, description: descriptions }] } : {}),
        ...(args.targetPartnerSearchNetwork !== undefined ? { targetPartnerSearchNetwork: args.targetPartnerSearchNetwork } : {}),
        ...(args.targetContentNetwork !== undefined ? { targetContentNetwork: args.targetContentNetwork } : {}),
        ...(args.merchantCenterAccountId ? { merchantCenterAccountId: args.merchantCenterAccountId } : {}),
        ...(args.isNewCustomer !== undefined ? { isNewCustomer: args.isNewCustomer } : {}),
      };

      let response: { recommendations?: Row[] };
      try {
        response = await client.customerAction(cid, "recommendations:generate", body);
      } catch (err) {
        return apiFailure("gerar recomendações de construção", err);
      }
      const recs = response.recommendations ?? [];
      const rows: Row[] = recs.map((rec) => ({ type: rec.type, ...impactView(rec.impact), details: recommendationDetails(rec) }));
      const returned = new Set(recs.map((r) => String(r.type)));
      const empty = typeList.filter((t) => !returned.has(t));
      const header =
        `${rows.length} recomendação(ões) para campanha ${advertisingChannelType} em construção.` +
        (conversionStatus && !args.conversionTrackingStatus ? `\nStatus de conversão lido da conta: ${conversionStatus}.` : "") +
        (needsConversionStatus && !conversionStatus
          ? "\nAtenção: o status de conversão da conta não pôde ser lido; os tipos de lance podem voltar vazios (informe conversionTrackingStatus)."
          : "") +
        (empty.length ? `\nSem recomendação para: ${empty.join(", ")} (dados insuficientes ou já no estado recomendado).` : "");
      if (format === "table" || format === "csv") {
        return render(rows.map(({ details, ...rest }) => ({ ...rest, details: detailsText(details as Row) })), format, header);
      }
      return { content: [text(`${header}\n\n${formatJson(rows)}`)] };
    }
  );

  // ── Auto-aplicação: assinaturas ────────────────────────────────────

  mcp.registerTool(
    "list_recommendation_subscriptions",
    {
      description: [
        "Lista as assinaturas de auto-aplicação de recomendações (RecommendationSubscription): quais tipos o Google",
        "aplica sozinho na conta. READ OPERATION.",
        "",
        "customerId para uma conta, ou allAccounts: true para todas as contas do MCC que este servidor pode acessar.",
        `Tipos que aceitam auto-aplicação: ${SUBSCRIPTION_TYPES.join(", ")}.`,
        "Para ver o que foi auto-aplicado: get_change_history com autoAppliedOnly: true.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Customer ID (ou use allAccounts)."),
        allAccounts: z.boolean().optional().describe("true = todas as contas acessíveis (até 100)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Filtra por status."),
        format: formatSchema,
      },
    },
    async ({ customerId, allAccounts, status, format }) => {
      let accounts: Array<{ id: string; name: string }> = [];
      if (allAccounts) {
        if (customerId) return fail("Use customerId OU allAccounts, não os dois.");
        const children = await getClient().listChildAccounts();
        accounts = children
          .map((row) => obj(row.customerClient))
          .map((c) => ({ id: String(c.id ?? ""), name: String(c.descriptiveName ?? "") }))
          .filter((a) => /^\d+$/.test(a.id) && checkCustomerAccess(a.id, allowedCustomerIds, hosted) === null);
        if (accounts.length === 0) return fail("Nenhuma conta acessível dentro da allowlist.");
      } else {
        if (!customerId) return fail("Informe customerId ou allAccounts: true.");
        const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
        if (blocked) return { content: [blocked], isError: true };
        const cid = normalizeCid(customerId);
        if (!cid) return fail(`customerId inválido: ${customerId}`);
        accounts = [{ id: cid, name: "" }];
      }
      const truncated = accounts.length > MAX_SUBSCRIPTION_ACCOUNTS;
      accounts = accounts.slice(0, MAX_SUBSCRIPTION_ACCOUNTS);

      const client = getClient();
      const rows: Row[] = [];
      const failures: string[] = [];
      for (const account of accounts) {
        try {
          const result = await client.searchStream(account.id,
            `SELECT recommendation_subscription.resource_name, recommendation_subscription.type,
                    recommendation_subscription.status, recommendation_subscription.create_date_time,
                    recommendation_subscription.modify_date_time, customer.descriptive_name
             FROM recommendation_subscription
             ${status ? `WHERE recommendation_subscription.status = '${status}'` : ""}
             ORDER BY recommendation_subscription.type`);
          for (const row of result) {
            const sub = obj(row.recommendationSubscription);
            rows.push({
              customer_id: account.id,
              account: account.name || obj(row.customer).descriptiveName || "",
              type: sub.type,
              status: sub.status,
              created: sub.createDateTime ?? null,
              modified: sub.modifyDateTime ?? null,
              resource_name: sub.resourceName,
            });
          }
        } catch (err) {
          failures.push(`${account.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const enabled = rows.filter((r) => r.status === "ENABLED").length;
      const header =
        `${rows.length} assinatura(s) em ${accounts.length} conta(s) — ${enabled} com auto-aplicação ATIVA.` +
        (truncated ? `\nLimitado às primeiras ${MAX_SUBSCRIPTION_ACCOUNTS} contas.` : "") +
        (failures.length ? `\nFalhas: ${failures.join("; ")}` : "") +
        (rows.length === 0 ? "\nSem assinaturas: nenhuma recomendação é auto-aplicada via assinatura." : "");
      const out = render(rows, format, header);
      return failures.length === accounts.length ? { ...out, isError: true } : out;
    }
  );

  mcp.registerTool(
    "set_recommendation_subscription",
    {
      description: [
        "Liga (ENABLED) ou pausa (PAUSED) a auto-aplicação de tipos de recomendação na conta",
        "(RecommendationSubscriptionService). WRITE OPERATION.",
        "",
        "Ligar deixa o Google alterar a conta sozinho (ex: USE_BROAD_MATCH_KEYWORD troca keywords para ampla):",
        "exige confirm: true. Pausar não exige. Lê as assinaturas atuais antes: tipo já no status pedido é pulado,",
        "assinatura existente é atualizada, e só se cria assinatura nova para ligar.",
        `Tipos aceitos: ${SUBSCRIPTION_TYPES.join(", ")}.`,
        "validateOnly: a API valida sem gravar (o endpoint tem validate_only).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        types: flexArray(z.enum(SUBSCRIPTION_TYPES)).describe("Tipos de recomendação."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("ENABLED liga a auto-aplicação; PAUSED desliga."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para ENABLED."),
      },
    },
    async ({ customerId, types, status, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);
      const typeList = [...new Set(ensureArray<string>(types).map((t) => String(t).trim().toUpperCase()).filter(Boolean))];
      if (typeList.length === 0) return fail("Informe ao menos um tipo em types.");
      const bad = typeList.filter((t) => !(SUBSCRIPTION_TYPES as readonly string[]).includes(t));
      if (bad.length) return fail(`Tipos sem suporte a auto-aplicação: ${bad.join(", ")}. Aceitos: ${SUBSCRIPTION_TYPES.join(", ")}.`);
      if (status !== "ENABLED" && status !== "PAUSED") return fail(`status inválido: ${String(status)} (use ENABLED ou PAUSED).`);
      if (status === "ENABLED" && confirm !== true) {
        return fail(
          `Cancelado: ligar a auto-aplicação de ${typeList.join(", ")} deixa o Google alterar a conta sozinho, sem revisão. ` +
          "Envie confirm: true para ligar."
        );
      }

      const client = getClient();
      const existingRows = await client.searchStream(cid,
        `SELECT recommendation_subscription.resource_name, recommendation_subscription.type,
                recommendation_subscription.status
         FROM recommendation_subscription
         WHERE recommendation_subscription.type IN (${typeList.map((t) => `'${t}'`).join(", ")})`);
      const existing = new Map<string, { resourceName: string; status: string }>();
      for (const row of existingRows) {
        const sub = obj(row.recommendationSubscription);
        existing.set(String(sub.type), { resourceName: String(sub.resourceName ?? ""), status: String(sub.status ?? "") });
      }

      const skipped: string[] = [];
      const planned: Array<{ type: string; before: string; operation: Row }> = [];
      for (const type of typeList) {
        const current = existing.get(type);
        if (current && current.status === status) skipped.push(`${type} (já ${status})`);
        else if (current) {
          planned.push({ type, before: current.status, operation: { update: { resourceName: current.resourceName, status }, updateMask: "status" } });
        } else if (status === "ENABLED") {
          planned.push({ type, before: "sem assinatura", operation: { create: { type, status } } });
        } else {
          skipped.push(`${type} (sem assinatura: já não é auto-aplicado)`);
        }
      }
      if (planned.length === 0) {
        return { content: [text(`Nada a alterar.\n- ${skipped.join("\n- ")}`)] };
      }

      const action = "recommendationSubscriptions:mutateRecommendationSubscription";
      const body = { operations: planned.map((p) => p.operation), partialFailure: true };
      const dryRun = client.isDryRun;
      let response: { results?: Row[]; partialFailureError?: unknown };
      try {
        /* O endpoint aceita validate_only, mas customerWriteAction recusa qualquer
           ação fora dos uploads de conversão em dry-run. Em dry-run a chamada vai
           com validateOnly: true explícito — a API valida e não grava. */
        response = dryRun
          ? await client.customerAction(cid, action, { ...body, validateOnly: true })
          : await client.customerWriteAction(cid, action, body);
      } catch (err) {
        return apiFailure("alterar assinaturas de recomendação", err);
      }
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, planned.length);
      const report = planned.map((p, index) => {
        const errs = byIndex.get(index);
        const confirmed = Boolean(obj((response.results ?? [])[index]).resourceName);
        return {
          type: p.type,
          before: p.before,
          after: status,
          status: errs ? "falhou" : dryRun ? "validado (nada gravado)" : confirmed ? "gravado" : "sem confirmação da API",
          ...(errs ? { errors: errs } : {}),
        };
      });
      const ok = report.filter((r) => !r.errors).length;
      return {
        content: [text(
          (dryRun
            ? `DRY-RUN (validateOnly): ${ok}/${planned.length} validada(s) pela API — nada foi gravado.`
            : `${ok}/${planned.length} assinatura(s) alterada(s) para ${status}.`) +
          (skipped.length ? `\nPuladas: ${skipped.join("; ")}` : "") +
          (unattributed.length ? `\nFalhas sem índice: ${unattributed.join("; ")}` : "") +
          `\n\n${formatJson(report)}`
        )],
        isError: ok < planned.length,
      };
    }
  );

  // ── Histórico de alterações ────────────────────────────────────────

  mcp.registerTool(
    "get_change_history",
    {
      description: [
        "Histórico de alterações da conta (change_event): quem mudou o quê, quando, por qual canal, com o valor",
        "antigo → novo de cada campo. READ OPERATION.",
        "",
        "Filtros: clientTypes (origem: GOOGLE_ADS_WEB_CLIENT, GOOGLE_ADS_API, GOOGLE_ADS_RECOMMENDATIONS,",
        "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION = auto-aplicado, GOOGLE_ADS_AUTOMATED_RULE, GOOGLE_ADS_SCRIPTS,",
        "SEARCH_ADS_360_SYNC / SEARCH_ADS_360_POST = vindo do Search Ads 360...),",
        "autoAppliedOnly (só o que o Google aplicou sozinho por assinatura), resourceTypes, operations",
        "(CREATE/UPDATE/REMOVE), userEmail, campaignId, adGroupId.",
        "",
        "Janela: últimos 29 dias (limite da API). limit acima de 10.000 pagina automaticamente (até 50.000).",
        "summaryOnly traz só as contagens. format=table/csv: uma linha por campo alterado.",
        "Mudanças do Google Ads Editor não aparecem em change_event (limitação da API).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe("Date range YYYY-MM-DD (use this OR days). A API só devolve os últimos 29 dias."),
        days: z.number().optional().describe("Days to look back (use this OR dateRange). Default e máximo: 29 — a API rejeita janela de 30 dias."),
        limit: z.number().optional().describe("Máximo de alterações. Default: 25; até 50.000 (pagina de 10 mil em 10 mil)."),
        clientTypes: flexArray(z.enum(CHANGE_CLIENT_TYPES)).optional().describe("Origem da alteração."),
        autoAppliedOnly: z.boolean().optional().describe("Só alterações auto-aplicadas por assinatura de recomendação."),
        resourceTypes: flexArray(z.enum(CHANGE_RESOURCE_TYPES)).optional().describe("Tipos de recurso alterado."),
        operations: flexArray(z.enum(CHANGE_OPERATIONS)).optional().describe("CREATE, UPDATE e/ou REMOVE."),
        userEmail: z.string().optional().describe("E-mail exato de quem alterou."),
        campaignId: z.string().optional().describe("Só alterações desta campanha."),
        adGroupId: z.string().optional().describe("Só alterações deste grupo de anúncios."),
        summaryOnly: z.boolean().optional().describe("Só contagens por origem, recurso, operação e usuário."),
        includeRawResources: z.boolean().optional().describe("Inclui old_resource/new_resource completos. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, limit, clientTypes, autoAppliedOnly, resourceTypes, operations, userEmail, campaignId, adGroupId, summaryOnly, includeRawResources, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: ${customerId}`);

      let dateClause: string;
      try {
        dateClause = buildChangeEventDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const max = limit ?? 25;
      if (!Number.isInteger(max) || max < 1 || max > MAX_CHANGE_EVENTS) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a ${MAX_CHANGE_EVENTS}.`);

      const clients = [...new Set(ensureArray<string>(clientTypes).map((c) => String(c).toUpperCase()))];
      if (autoAppliedOnly && clients.length) return fail("Use clientTypes OU autoAppliedOnly, não os dois.");
      if (autoAppliedOnly) clients.push("GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION");
      const resources = [...new Set(ensureArray<string>(resourceTypes).map((r) => String(r).toUpperCase()))];
      const ops = [...new Set(ensureArray<string>(operations).map((o) => String(o).toUpperCase()))];
      const invalid = [
        ...clients.filter((c) => !(CHANGE_CLIENT_TYPES as readonly string[]).includes(c)).map((c) => `clientTypes: ${c}`),
        ...resources.filter((r) => !(CHANGE_RESOURCE_TYPES as readonly string[]).includes(r)).map((r) => `resourceTypes: ${r}`),
        ...ops.filter((o) => !(CHANGE_OPERATIONS as readonly string[]).includes(o)).map((o) => `operations: ${o}`),
      ];
      if (campaignId !== undefined && !/^\d+$/.test(campaignId.trim())) invalid.push(`campaignId: ${campaignId}`);
      if (adGroupId !== undefined && !/^\d+$/.test(adGroupId.trim())) invalid.push(`adGroupId: ${adGroupId}`);
      const email = userEmail?.trim();
      if (email !== undefined && (!email || /[\s\u0000-\u001f]/.test(email))) invalid.push(`userEmail: "${userEmail}"`);
      if (invalid.length) return fail(`Filtros inválidos:\n- ${invalid.join("\n- ")}`);

      const filters = [dateClause];
      if (clients.length) filters.push(`change_event.client_type IN (${clients.map((c) => `'${c}'`).join(", ")})`);
      if (resources.length) filters.push(`change_event.change_resource_type IN (${resources.map((r) => `'${r}'`).join(", ")})`);
      if (ops.length) filters.push(`change_event.resource_change_operation IN (${ops.map((o) => `'${o}'`).join(", ")})`);
      if (email) filters.push(`change_event.user_email = '${gaqlLiteral(email)}'`);
      if (campaignId) filters.push(`change_event.campaign = 'customers/${cid}/campaigns/${campaignId.trim()}'`);
      if (adGroupId) filters.push(`change_event.ad_group = 'customers/${cid}/adGroups/${adGroupId.trim()}'`);

      const fields = [
        "change_event.resource_name", "change_event.change_date_time", "change_event.change_resource_type",
        "change_event.change_resource_name", "change_event.resource_change_operation", "change_event.client_type",
        "change_event.user_email", "change_event.campaign", "change_event.ad_group", "campaign.name", "ad_group.name",
        ...(summaryOnly ? [] : ["change_event.changed_fields", "change_event.old_resource", "change_event.new_resource"]),
      ];

      /* A API limita cada consulta a 10.000 linhas. Para passar disso, a doc manda
         reconsultar a partir do horário da última linha. Com ORDER BY DESC, a próxima
         consulta pega < (segundo seguinte ao da última linha): ela devolve de novo, no
         topo, as alterações daquele segundo que já vieram (saem pelo resource_name). Por
         isso o LIMIT da página seguinte soma essas repetidas ao que ainda falta — sem
         isso, uma edição em massa no segundo da fronteira consumia a página inteira com
         repetidas e a paginação parava antes do limite pedido. */
      const client = getClient();
      const events: Row[] = [];
      const seen = new Set<string>();
      const secondOf = (row: Row) => String(obj(row.changeEvent).changeDateTime ?? "").slice(0, 19);
      let cursor: string | null = null;
      /** Por que a paginação parou antes do limit (null = não parou antes). */
      let stopReason: string | null = null;
      const maxPages = Math.ceil(MAX_CHANGE_EVENTS / CHANGE_EVENT_PAGE) * 2;
      for (let page = 0; events.length < max; page++) {
        if (page >= maxPages) {
          stopReason = `limite de ${maxPages} consultas atingido — use filtros ou uma janela menor (dateRange) para ver o restante`;
          break;
        }
        // repetidas esperadas: as já lidas no segundo da fronteira (o do cursor)
        const boundary = cursor ? events.filter((row) => nextSecond(secondOf(row)) === cursor).length : 0;
        const pageLimit = Math.min(max - events.length + boundary, CHANGE_EVENT_PAGE);
        const where = cursor ? [...filters, `change_event.change_date_time < '${cursor}'`] : filters;
        const batch = await client.searchStream(cid,
          `SELECT ${fields.join(", ")}
           FROM change_event
           WHERE ${where.join(" AND ")}
           ORDER BY change_event.change_date_time DESC
           LIMIT ${pageLimit}`);
        let added = 0;
        for (const row of batch) {
          const name = String(obj(row.changeEvent).resourceName ?? "");
          if (name && seen.has(name)) continue;
          if (name) seen.add(name);
          events.push(row);
          added++;
          if (events.length >= max) break;
        }
        if (batch.length < pageLimit || events.length >= max) break;
        // página cheia só de repetidas: 10.000+ alterações no mesmo segundo, não há como avançar
        if (added === 0) {
          stopReason = "10.000 ou mais alterações no mesmo segundo — use filtros (resourceTypes, campaignId, clientTypes...) para ver o restante";
          break;
        }
        const next = nextSecond(secondOf(batch[batch.length - 1]));
        if (!next) {
          stopReason = `horário da última alteração em formato inesperado ("${secondOf(batch[batch.length - 1])}")`;
          break;
        }
        // next === cursor: a página inteira caiu no segundo da fronteira; repete com LIMIT maior
        cursor = next;
      }

      const rows: Row[] = events.map((row) => {
        const ev = obj(row.changeEvent);
        return {
          date_time: ev.changeDateTime,
          user: ev.userEmail ?? null,
          client_type: ev.clientType,
          resource_type: ev.changeResourceType,
          operation: ev.resourceChangeOperation,
          resource_name: ev.changeResourceName,
          campaign: obj(row.campaign).name ?? ev.campaign ?? null,
          ad_group: obj(row.adGroup).name ?? ev.adGroup ?? null,
          ...(summaryOnly ? {} : { changes: changeEventDiff(ev) }),
          ...(includeRawResources && !summaryOnly ? { old_resource: ev.oldResource ?? null, new_resource: ev.newResource ?? null } : {}),
        };
      });

      const summary = {
        total: rows.length,
        by_client_type: countBy(rows, "client_type"),
        by_resource_type: countBy(rows, "resource_type"),
        by_operation: countBy(rows, "operation"),
        by_user: countBy(rows, "user"),
      };
      const header =
        `${rows.length} alteração(ões).` +
        (clients.includes("GOOGLE_ADS_EDITOR") ? "\nAtenção: a API não devolve alterações do Google Ads Editor em change_event (use change_status)." : "") +
        (stopReason ? `\nPaginação interrompida: ${stopReason}.` : "") +
        (rows.length >= max && max > 0 ? `\nPode haver mais: limite de ${max} atingido.` : "");
      if (summaryOnly) return { content: [text(`${header}\n\n${formatJson(summary)}`)] };

      if (format === "table" || format === "csv") {
        const flat: Row[] = rows.flatMap((row) => {
          const { changes, old_resource: _o, new_resource: _n, ...rest } = row;
          const diffs = (changes as Array<{ field: string; old: string | null; new: string | null }>) ?? [];
          return diffs.length
            ? diffs.map((d) => ({ ...rest, field: d.field, old: d.old ?? "", new: d.new ?? "" }))
            : [{ ...rest, field: "", old: "", new: "" }];
        });
        return render(flat, format, header);
      }
      return { content: [text(`${header}\n\n${formatJson({ summary, changes: rows })}`)] };
    }
  );
}
