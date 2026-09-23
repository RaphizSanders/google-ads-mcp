/**
 * Lote retail-reporting: Relatórios de varejo, status de produtos, canais do PMax e listas de marcas.
 *
 * Tools:
 * - get_pmax_channel_performance  (leitura) — gasto/conversões do PMax por canal (segments.ad_network_type,
 *   v23+), com divisão opcional por uso de dados de produto e de vídeo (v22+).
 * - get_product_status            (leitura) — status e problemas dos produtos (shopping_product): por que
 *   um produto não aparece, e os elegíveis que não tiveram impressão no período.
 * - get_shopping_products         (leitura) — movida de src/tools.ts e ampliada: filtro por campanha e por
 *   tipo de campanha, agrupamento por marca/categoria/tipo/rótulo/canal, lucro (dados do carrinho) e IS.
 * - get_listing_group_performance (leitura) — métricas por grupo de produtos (PMax e Shopping padrão).
 * - get_cart_data_sales           (leitura) — vendas por produto vendido (cart_data_sales_view, v24+).
 * - suggest_brands / list_brand_lists (leitura) e create_brand_list / update_brand_list /
 *   attach_brand_list / detach_brand_list (escrita) — listas de marcas (shared set BRANDS).
 *
 * Cada campo GAQL daqui foi conferido nos metadados reais da v25 (tests/fixtures) e cada payload no
 * proto oficial da v25; as regras por canal das listas de marcas vêm dos enums de erro da API
 * (CriterionError / CampaignCriterionError) e dos guias de shared sets e de critérios do PMax.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

const DIGITS = /^\d+$/;
/** Teto de linhas quando o GAQL segmenta por campanha e o agrupamento é feito aqui. */
const ROW_CAP = 50_000;

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const arr = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);
const micros = (value: unknown) => num(value) / 1_000_000;

/** "product_item_id" → "productItemId" (chave do JSON da API REST). */
const camel = (field: string) => field.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Lê "segments.product_brand" de uma linha da API ({ segments: { productBrand } }). */
function pick(row: Row, field: string): unknown {
  let current: unknown = row;
  for (const part of field.split(".")) current = obj(current)[camel(part)];
  return current;
}

function normalizeCid(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "").trim();
  return DIGITS.test(cid) ? cid : null;
}

/** Primeiro id não numérico → mensagem de erro; null se todos ok. */
function badIds(ids: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(ids)) {
    if (value !== undefined && !DIGITS.test(value)) return `${name} deve ser numérico, recebido "${value}".`;
  }
  return null;
}

function dateClauseOf(dateRange: { since: string; until: string } | undefined, days: number | undefined): string | { error: string } {
  try {
    return buildDateClause(dateRange, days);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function render(format: string | undefined, rows: Row[], header: string, body: unknown): ToolResult {
  if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(rows)}`)] };
  if (format === "csv") return { content: [text(formatAsCsv(rows))] };
  return { content: [text(`${header}\n\n${formatJson(body)}`)] };
}

// ── Métricas ─────────────────────────────────────────────────────────

interface Totals {
  rows: number;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  revenueMicros: number;
  grossProfitMicros: number;
  cogsMicros: number;
  unitsSold: number;
  orders: number;
  /** métricas de parcela (IS): soma ponderada por impressões e o peso, por métrica */
  shares: Record<string, { sum: number; weight: number; last: number }>;
}

const emptyTotals = (): Totals => ({
  rows: 0, impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionsValue: 0,
  revenueMicros: 0, grossProfitMicros: 0, cogsMicros: 0, unitsSold: 0, orders: 0, shares: {},
});

/** Parcelas de impressão da rede de Pesquisa (shopping_performance_view, v23+). */
const SHARE_METRICS = [
  { field: "search_impression_share", key: "searchImpressionShare", out: "impression_share_pct" },
  { field: "search_budget_lost_impression_share", key: "searchBudgetLostImpressionShare", out: "lost_is_budget_pct" },
  { field: "search_rank_lost_impression_share", key: "searchRankLostImpressionShare", out: "lost_is_rank_pct" },
  { field: "search_click_share", key: "searchClickShare", out: "click_share_pct" },
] as const;

const BASE_METRICS = ["metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value"];
/** Métricas de conversões com dados do carrinho (lucro). */
const PROFIT_METRICS = [
  "metrics.revenue_micros", "metrics.gross_profit_micros", "metrics.cost_of_goods_sold_micros",
  "metrics.units_sold", "metrics.orders",
];

function accumulate(totals: Totals, metricsValue: unknown): Totals {
  const m = obj(metricsValue);
  totals.rows += 1;
  totals.impressions += num(m.impressions);
  totals.clicks += num(m.clicks);
  totals.costMicros += num(m.costMicros);
  totals.conversions += num(m.conversions);
  totals.conversionsValue += num(m.conversionsValue);
  totals.revenueMicros += num(m.revenueMicros);
  totals.grossProfitMicros += num(m.grossProfitMicros);
  totals.cogsMicros += num(m.costOfGoodsSoldMicros);
  totals.unitsSold += num(m.unitsSold);
  totals.orders += num(m.orders);
  for (const share of SHARE_METRICS) {
    const raw = m[share.key];
    if (raw === undefined || raw === null) continue;
    const weight = Math.max(num(m.impressions), 1);
    const entry = (totals.shares[share.out] ??= { sum: 0, weight: 0, last: 0 });
    entry.sum += num(raw) * weight;
    entry.weight += weight;
    entry.last = num(raw);
  }
  return totals;
}

function performance(t: Totals) {
  const spend = t.costMicros / 1_000_000;
  return {
    impressions: t.impressions,
    clicks: t.clicks,
    ctr_pct: pct(t.clicks, t.impressions),
    spend: round2(spend),
    conversions: round2(t.conversions),
    conversions_value: round2(t.conversionsValue),
    roas: spend > 0 ? round2(t.conversionsValue / spend) : null,
    cpa: t.conversions > 0 ? round2(spend / t.conversions) : null,
  };
}

function profitView(t: Totals) {
  const spend = t.costMicros / 1_000_000;
  const revenue = t.revenueMicros / 1_000_000;
  const gross = t.grossProfitMicros / 1_000_000;
  return {
    cart_revenue: round2(revenue),
    gross_profit: round2(gross),
    cogs: round2(t.cogsMicros / 1_000_000),
    units_sold: round2(t.unitsSold),
    orders: round2(t.orders),
    margin_pct: revenue > 0 ? round2((gross / revenue) * 100) : null,
    poas: spend > 0 ? round2(gross / spend) : null,
    profit_after_ads: round2(gross - spend),
  };
}

function shareView(t: Totals) {
  const out: Row = {};
  for (const share of SHARE_METRICS) {
    const entry = t.shares[share.out];
    out[share.out] = entry && entry.weight > 0 ? round2((entry.sum / entry.weight) * 100) : null;
  }
  if (t.rows > 1 && Object.keys(t.shares).length > 0) out.impression_share_note = "média ponderada por impressões (aproximação)";
  return out;
}

const hasCartData = (t: Totals) => t.revenueMicros !== 0 || t.grossProfitMicros !== 0 || t.unitsSold !== 0 || t.cogsMicros !== 0;

const NO_CART_DATA_HINT =
  "Sem dados de carrinho no período: a conta não envia conversões com dados do carrinho (itens, preço e " +
  "custo dos produtos vendidos na tag de compra, com COGS no Merchant Center) ou não houve vendas atribuídas.";

// ── Categorias de produto (nome legível) ─────────────────────────────

function pickLocalization(localizations: Row[]): string | undefined {
  const find = (lang: string, region?: string) =>
    localizations.find((l) => str(l.languageCode).toLowerCase() === lang && (!region || str(l.regionCode).toUpperCase() === region));
  const best = find("pt", "BR") ?? find("pt") ?? find("en", "US") ?? find("en") ?? localizations[0];
  return best ? str(best.value) || undefined : undefined;
}

/**
 * Traduz categorias do Google (product_category_constant) para o nome em pt-BR (ou inglês).
 * Os segmentos product_category_levelN devolvem o resource name da constante; os listing groups
 * guardam só o category_id. Melhor esforço: se a consulta falhar, fica o valor cru.
 */
async function resolveCategoryNames(
  client: GoogleAdsClient,
  cid: string,
  refs: { resourceNames?: string[]; categoryIds?: string[] }
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const resourceNames = [...new Set((refs.resourceNames ?? []).filter((r) => /^productCategoryConstants\//.test(r)))].slice(0, 500);
  const categoryIds = [...new Set((refs.categoryIds ?? []).filter((id) => DIGITS.test(id)))].slice(0, 500);
  if (resourceNames.length === 0 && categoryIds.length === 0) return names;
  const filter = resourceNames.length
    ? `product_category_constant.resource_name IN (${resourceNames.map((r) => `'${gaqlLiteral(r)}'`).join(", ")})`
    : `product_category_constant.category_id IN (${categoryIds.join(", ")})`;
  try {
    const rows = await client.searchStream(cid,
      `SELECT product_category_constant.resource_name, product_category_constant.category_id,
              product_category_constant.localizations
       FROM product_category_constant
       WHERE ${filter}`);
    for (const row of rows) {
      const constant = obj(row.productCategoryConstant);
      const name = pickLocalization(arr(constant.localizations));
      if (!name) continue;
      names.set(str(constant.resourceName), name);
      names.set(str(constant.categoryId), name);
    }
  } catch {
    // nome é só conveniência: sem ele, o relatório segue com o valor cru
  }
  return names;
}

// ── Dimensões de produto (shopping_performance_view / cart_data_sales_view) ──

const PRODUCT_GROUP_BY = [
  "item", "brand",
  "category_l1", "category_l2", "category_l3", "category_l4", "category_l5",
  "type_l1", "type_l2", "type_l3", "type_l4", "type_l5",
  "custom_label0", "custom_label1", "custom_label2", "custom_label3", "custom_label4",
  "channel", "feed_label",
] as const;
type ProductGroupBy = (typeof PRODUCT_GROUP_BY)[number];

/** Campos GAQL de cada agrupamento: o produto clicado (product_*) e o vendido (product_sold_*). */
function productFields(groupBy: ProductGroupBy, perspective: "clicked" | "sold"): string[] | null {
  const prefix = perspective === "sold" ? "segments.product_sold_" : "segments.product_";
  if (groupBy === "item") return [`${prefix}item_id`, `${prefix}title`];
  if (groupBy === "brand") return [`${prefix}brand`];
  let match = /^category_l([1-5])$/.exec(groupBy);
  if (match) return [`${prefix}category_level${match[1]}`];
  match = /^type_l([1-5])$/.exec(groupBy);
  if (match) return [`${prefix}type_l${match[1]}`];
  match = /^custom_label([0-4])$/.exec(groupBy);
  if (match) return [`${prefix}custom_attribute${match[1]}`];
  // canal e feed label só existem do lado do produto clicado
  if (perspective === "sold") return null;
  if (groupBy === "channel") return ["segments.product_channel"];
  return ["segments.product_feed_label"];
}

const GROUP_BY_LABELS: Record<string, string> = {
  item: "item", brand: "marca", channel: "canal (online/local)", feed_label: "feed label",
  category_l1: "categoria nível 1", category_l2: "categoria nível 2", category_l3: "categoria nível 3",
  category_l4: "categoria nível 4", category_l5: "categoria nível 5",
  type_l1: "tipo de produto nível 1", type_l2: "tipo de produto nível 2", type_l3: "tipo de produto nível 3",
  type_l4: "tipo de produto nível 4", type_l5: "tipo de produto nível 5",
  custom_label0: "rótulo personalizado 0", custom_label1: "rótulo personalizado 1", custom_label2: "rótulo personalizado 2",
  custom_label3: "rótulo personalizado 3", custom_label4: "rótulo personalizado 4",
};

// ── PMax por canal ───────────────────────────────────────────────────

const NETWORK_LABELS: Record<string, string> = {
  SEARCH: "Pesquisa Google",
  SEARCH_PARTNERS: "Parceiros de pesquisa",
  CONTENT: "Display",
  YOUTUBE: "YouTube",
  GMAIL: "Gmail",
  DISCOVER: "Discover",
  MAPS: "Maps",
  GOOGLE_TV: "Google TV",
  MIXED: "Cross-network (sem canal atribuído)",
  GOOGLE_OWNED_CHANNELS: "Canais do Google (histórico, antes da divisão por canal)",
  UNKNOWN: "Desconhecido",
  UNSPECIFIED: "Não especificado",
};

// ── Status de produto ────────────────────────────────────────────────

const PRODUCT_STATUS_LABELS: Record<string, string> = {
  ELIGIBLE: "elegível",
  ELIGIBLE_LIMITED: "elegível com limitações",
  NOT_ELIGIBLE: "não elegível",
};
/** Tipos de campanha que aceitam escopo de campanha em shopping_product (doc do recurso, v25). */
const PRODUCT_SCOPE_CAMPAIGN_TYPES = new Set(["SHOPPING", "PERFORMANCE_MAX", "DEMAND_GEN", "VIDEO", "MULTI_CHANNEL"]);
/** Nesses tipos o escopo de campanha/grupo só aceita impressions, clicks e ctr. */
const LIMITED_METRIC_TYPES = new Set(["DEMAND_GEN", "VIDEO", "MULTI_CHANNEL"]);
/** Escopo de grupo de anúncios: Shopping, Demand Gen, Vídeo e App (PMax não tem grupo de anúncios). */
const PRODUCT_SCOPE_AD_GROUP_TYPES = new Set(["SHOPPING", "DEMAND_GEN", "VIDEO", "MULTI_CHANNEL"]);

// ── Listas de marcas ─────────────────────────────────────────────────

/** Recusas da API traduzidas (códigos de CriterionError, CampaignCriterionError, SharedSetError). */
const BRAND_ERROR_HINTS: Array<[RegExp, string]> = [
  [/CANNOT_RECOGNIZE_BRAND|not recognized as a valid brand/i, "Marca não reconhecida: use o id devolvido por suggest_brands (não o nome da marca)."],
  [/BRAND_SHARED_SET_DOES_NOT_EXIST|shared set that does not exist/i, "A lista de marcas não existe nesta conta (confira com list_brand_lists)."],
  [/CANNOT_ADD_REMOVED_BRAND_SHARED_SET|deleted shared set/i, "A lista de marcas foi removida; crie outra com create_brand_list."],
  [/ONLY_EXCLUSION_BRAND_LIST_ALLOWED_FOR_CAMPAIGN_TYPE|only be negatively targeted/i, "Este tipo de campanha só aceita a lista como exclusão (mode EXCLUDE)."],
  [/ONLY_INCLUSION_BRAND_LIST_ALLOWED_FOR_AD_GROUPS|only support inclusionary/i, "No grupo de anúncios a lista só pode ser de inclusão (mode INCLUDE)."],
  [/CANNOT_ATTACH_BRAND_LIST_TO_NON_QUALIFIED_SEARCH_CAMPAIGN|non.?qualified search/i, "Inclusão de marcas em Pesquisa exige AI Max ligado (ou correspondência ampla no nível da campanha, legado). Ligue com set_ai_max_settings antes."],
  [/DUPLICATE_NAME|name already exists/i, "Já existe uma lista compartilhada ativa com esse nome; escolha outro."],
  [/CRITERION_TYPE_NOT_ALLOWED_FOR_SHARED_SET_TYPE/i, "O conjunto compartilhado não é do tipo BRANDS."],
  [/SHARED_SET_REMOVED/i, "A lista foi removida e não aceita alterações."],
];

function explainBrandError(message: string): string {
  const hints = BRAND_ERROR_HINTS.filter(([re]) => re.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\n→ ${hints.join("\n→ ")}` : message;
}

/** Aceita o ID numérico ou customers/{cid}/sharedSets/{id}; resource de outra conta é recusado. */
function parseSharedSetRef(ref: string, cid: string): { id: string } | { error: string } {
  const value = String(ref ?? "").trim();
  if (DIGITS.test(value)) return { id: value };
  const match = /^customers\/([\d-]+)\/sharedSets\/(\d+)$/.exec(value);
  if (!match) return { error: `sharedSetId inválido: "${ref}" (esperado o ID numérico ou customers/{customerId}/sharedSets/{id}).` };
  if (match[1].replace(/-/g, "") !== cid) return { error: `${value} pertence a outra conta, não à ${cid}.` };
  return { id: match[2] };
}

/** Id de marca do suggest_brands (MID do Knowledge Graph, ex.: /m/0abc12). Vai no corpo JSON, não em GAQL. */
function cleanBrandIds(values: unknown): { ids: string[]; bad: string[] } {
  const list = Array.isArray(values) ? values : [];
  const ids: string[] = [];
  const bad: string[] = [];
  for (const value of list) {
    const id = String(value ?? "").trim();
    if (!id || /\s/.test(id) || id.length > 200) bad.push(String(value));
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, bad };
}

interface BrandSet {
  id: string;
  resourceName: string;
  name: string;
  status: string;
  type: string;
  memberCount: number;
  referenceCount: number;
}

async function fetchBrandSet(client: GoogleAdsClient, cid: string, setId: string): Promise<BrandSet | null> {
  const rows = await client.searchStream(cid,
    `SELECT shared_set.id, shared_set.resource_name, shared_set.name, shared_set.type,
            shared_set.status, shared_set.member_count, shared_set.reference_count
     FROM shared_set
     WHERE shared_set.id = ${setId}`);
  const set = obj(rows[0]?.sharedSet);
  if (!rows.length) return null;
  return {
    id: str(set.id) || setId,
    resourceName: str(set.resourceName) || `customers/${cid}/sharedSets/${setId}`,
    name: str(set.name),
    status: str(set.status),
    type: str(set.type),
    memberCount: num(set.memberCount),
    referenceCount: num(set.referenceCount),
  };
}

interface BrandMember {
  entity_id: string;
  name: string;
  url: string;
  status: string;
  rejection_reason?: string;
  criterion_id: string;
  resource_name: string;
  shared_set: string;
}

async function fetchBrandMembers(client: GoogleAdsClient, cid: string, setResource?: string): Promise<BrandMember[]> {
  const rows = await client.searchStream(cid,
    `SELECT shared_criterion.shared_set, shared_criterion.criterion_id, shared_criterion.resource_name,
            shared_criterion.brand.entity_id, shared_criterion.brand.display_name,
            shared_criterion.brand.primary_url, shared_criterion.brand.status,
            shared_criterion.brand.rejection_reason
     FROM shared_criterion
     WHERE shared_criterion.type = 'BRAND'
       AND shared_set.type = 'BRANDS'${setResource ? `\n       AND shared_criterion.shared_set = '${gaqlLiteral(setResource)}'` : ""}`);
  return rows.map((row) => {
    const criterion = obj(row.sharedCriterion);
    const brand = obj(criterion.brand);
    const member: BrandMember = {
      entity_id: str(brand.entityId),
      name: str(brand.displayName),
      url: str(brand.primaryUrl),
      status: str(brand.status),
      criterion_id: str(criterion.criterionId),
      resource_name: str(criterion.resourceName),
      shared_set: str(criterion.sharedSet),
    };
    if (brand.rejectionReason) member.rejection_reason = str(brand.rejectionReason);
    return member;
  });
}

/** Marcas que não valem mais para segmentação (BrandState). */
const DEAD_BRAND_STATES = new Set(["DEPRECATED", "CANCELLED", "REJECTED"]);

interface TargetInfo {
  kind: "campaign" | "ad_group";
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  channelType: string;
  aiMaxEnabled: boolean;
  bundlingRequired: string;
  keywordMatchType: string;
  pmaxIgnoreShopping?: boolean;
  shoppingIgnoreBrandExclusion?: boolean;
  adGroupId?: string;
  adGroupName?: string;
  adGroupStatus?: string;
  resourceName: string;
}

async function fetchTarget(
  client: GoogleAdsClient,
  cid: string,
  target: { campaignId?: string; adGroupId?: string }
): Promise<TargetInfo | null> {
  if (target.adGroupId) {
    const rows = await client.searchStream(cid,
      `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status,
              campaign.advertising_channel_type, campaign.ai_max_setting.enable_ai_max,
              campaign.ai_max_setting.bundling_required, campaign.keyword_match_type
       FROM ad_group
       WHERE ad_group.id = ${target.adGroupId}`);
    if (!rows.length) return null;
    const adGroup = obj(rows[0].adGroup);
    const campaign = obj(rows[0].campaign);
    return {
      kind: "ad_group",
      campaignId: str(campaign.id),
      campaignName: str(campaign.name),
      campaignStatus: str(campaign.status),
      channelType: str(campaign.advertisingChannelType),
      aiMaxEnabled: obj(campaign.aiMaxSetting).enableAiMax === true,
      bundlingRequired: str(obj(campaign.aiMaxSetting).bundlingRequired),
      keywordMatchType: str(campaign.keywordMatchType),
      adGroupId: str(adGroup.id) || target.adGroupId,
      adGroupName: str(adGroup.name),
      adGroupStatus: str(adGroup.status),
      resourceName: `customers/${cid}/adGroups/${target.adGroupId}`,
    };
  }
  const rows = await client.searchStream(cid,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.ai_max_setting.enable_ai_max, campaign.ai_max_setting.bundling_required,
            campaign.keyword_match_type,
            campaign.pmax_campaign_settings.brand_targeting_overrides.ignore_exclusions_for_shopping_ads,
            campaign.shopping_setting.ignore_brand_exclusion_in_shopping_ads
     FROM campaign
     WHERE campaign.id = ${target.campaignId}`);
  if (!rows.length) return null;
  const campaign = obj(rows[0].campaign);
  const overrides = obj(obj(campaign.pmaxCampaignSettings).brandTargetingOverrides);
  const shopping = obj(campaign.shoppingSetting);
  return {
    kind: "campaign",
    campaignId: str(campaign.id) || String(target.campaignId),
    campaignName: str(campaign.name),
    campaignStatus: str(campaign.status),
    channelType: str(campaign.advertisingChannelType),
    aiMaxEnabled: obj(campaign.aiMaxSetting).enableAiMax === true,
    bundlingRequired: str(obj(campaign.aiMaxSetting).bundlingRequired),
    keywordMatchType: str(campaign.keywordMatchType),
    pmaxIgnoreShopping: overrides.ignoreExclusionsForShoppingAds === true,
    shoppingIgnoreBrandExclusion: shopping.ignoreBrandExclusionInShoppingAds === true,
    resourceName: `customers/${cid}/campaigns/${target.campaignId}`,
  };
}

interface BrandListLink {
  criterionId: string;
  resourceName: string;
  negative: boolean;
  status: string;
  sharedSet: string;
}

async function fetchBrandListLinks(client: GoogleAdsClient, cid: string, target: TargetInfo): Promise<BrandListLink[]> {
  if (target.kind === "ad_group") {
    const rows = await client.searchStream(cid,
      `SELECT ad_group_criterion.criterion_id, ad_group_criterion.resource_name, ad_group_criterion.negative,
              ad_group_criterion.status, ad_group_criterion.brand_list.shared_set
       FROM ad_group_criterion
       WHERE ad_group.id = ${target.adGroupId}
         AND ad_group_criterion.type = 'BRAND_LIST'
         AND ad_group_criterion.status != 'REMOVED'`);
    return rows.map((row) => {
      const criterion = obj(row.adGroupCriterion);
      return {
        criterionId: str(criterion.criterionId),
        resourceName: str(criterion.resourceName),
        negative: criterion.negative === true,
        status: str(criterion.status),
        sharedSet: str(obj(criterion.brandList).sharedSet),
      };
    });
  }
  const rows = await client.searchStream(cid,
    `SELECT campaign_criterion.criterion_id, campaign_criterion.resource_name, campaign_criterion.negative,
            campaign_criterion.status, campaign_criterion.brand_list.shared_set
     FROM campaign_criterion
     WHERE campaign.id = ${target.campaignId}
       AND campaign_criterion.type = 'BRAND_LIST'
       AND campaign_criterion.status != 'REMOVED'`);
  return rows.map((row) => {
    const criterion = obj(row.campaignCriterion);
    return {
      criterionId: str(criterion.criterionId),
      resourceName: str(criterion.resourceName),
      negative: criterion.negative === true,
      status: str(criterion.status),
      sharedSet: str(obj(criterion.brandList).sharedSet),
    };
  });
}

const describeTarget = (t: TargetInfo) =>
  t.kind === "ad_group"
    ? `grupo de anúncios ${t.adGroupId} "${t.adGroupName}" (campanha ${t.campaignId} "${t.campaignName}", ${t.channelType})`
    : `campanha ${t.campaignId} "${t.campaignName}" (${t.channelType})`;

/**
 * Regras por canal documentadas na v25:
 * - grupo de anúncios: só inclusão (CriterionError.ONLY_INCLUSION_BRAND_LIST_ALLOWED_FOR_AD_GROUPS);
 *   brand list em grupo é controle do AI Max em Pesquisa;
 * - Performance Max: só exclusão (guia de critérios do PMax; ONLY_EXCLUSION_BRAND_LIST_ALLOWED_FOR_CAMPAIGN_TYPE);
 * - Shopping: exclusão (ShoppingSetting.ignore_brand_exclusion_in_shopping_ads existe para ela);
 * - Pesquisa: exclusão sempre; inclusão só com AI Max ou correspondência ampla de campanha
 *   (CampaignCriterionError.CANNOT_ATTACH_BRAND_LIST_TO_NON_QUALIFIED_SEARCH_CAMPAIGN); com
 *   ai_max_setting.bundling_required = REQUIRED, qualquer lista exige o AI Max ligado.
 */
function brandListRuleError(target: TargetInfo, mode: "INCLUDE" | "EXCLUDE"): string | null {
  const where = describeTarget(target);
  if (target.campaignStatus === "REMOVED") return `A ${where} foi removida.`;
  if (target.kind === "ad_group") {
    if (target.adGroupStatus === "REMOVED") return `O ${where} foi removido.`;
    if (target.channelType !== "SEARCH") {
      return `Lista de marcas em grupo de anúncios só existe em campanhas de Pesquisa (AI Max); o ${where} não é SEARCH.`;
    }
    if (mode !== "INCLUDE") {
      return "No grupo de anúncios a API só aceita a lista como inclusão (mode INCLUDE). Para excluir marcas, anexe a lista na campanha.";
    }
  }
  switch (target.channelType) {
    case "PERFORMANCE_MAX":
      if (mode !== "EXCLUDE") return "Performance Max só aceita listas de marcas como exclusão (mode EXCLUDE).";
      return null;
    case "SHOPPING":
      if (mode !== "EXCLUDE") return "Em Shopping a lista de marcas só é suportada como exclusão (mode EXCLUDE).";
      return null;
    case "SEARCH":
      if (target.bundlingRequired === "REQUIRED" && !target.aiMaxEnabled) {
        return `A campanha ${target.campaignId} exige o AI Max ligado para usar listas de marcas (ai_max_setting.bundling_required = REQUIRED). Ligue com set_ai_max_settings e tente de novo.`;
      }
      if (mode === "INCLUDE" && !target.aiMaxEnabled && target.keywordMatchType !== "BROAD") {
        return `Inclusão de marcas em Pesquisa exige AI Max ligado (ou correspondência ampla no nível da campanha, legado); a campanha ${target.campaignId} não tem nenhum dos dois. Ligue o AI Max com set_ai_max_settings ou use mode EXCLUDE.`;
      }
      return null;
    default:
      return `Listas de marcas se aplicam a campanhas de Pesquisa, Performance Max e Shopping; a ${where} é ${target.channelType || "de tipo desconhecido"}.`;
  }
}

function shoppingOverride(target: TargetInfo): { field: "pmax" | "shopping"; current: boolean } | null {
  if (target.kind !== "campaign") return null;
  if (target.channelType === "PERFORMANCE_MAX") return { field: "pmax", current: target.pmaxIgnoreShopping === true };
  if (target.channelType === "SHOPPING") return { field: "shopping", current: target.shoppingIgnoreBrandExclusion === true };
  return null;
}

// ── Listing groups ───────────────────────────────────────────────────

const levelDigit = (value: unknown) => str(value).replace(/\D/g, "") || "?";

/** Rótulo de uma dimensão de listing group (ListingGroupFilterDimension ou ListingDimensionInfo). */
function dimensionLabel(dimension: Row, categoryNames: Map<string, string>): string {
  const [key, raw] = Object.entries(dimension)[0] ?? ["", {}];
  const d = obj(raw);
  const other = "(outros)";
  switch (key) {
    case "productBrand":
      return `Marca: ${d.value !== undefined ? str(d.value) || "(sem marca)" : other}`;
    case "productItemId":
      return `ID do item: ${d.value !== undefined ? str(d.value) : other}`;
    case "productCategory": {
      const id = str(d.categoryId);
      const name = id ? categoryNames.get(id) : undefined;
      return `Categoria L${levelDigit(d.level)}: ${id ? (name ? `${name} (${id})` : id) : other}`;
    }
    case "productType":
      return `Tipo L${levelDigit(d.level)}: ${d.value !== undefined ? str(d.value) : other}`;
    case "productCustomAttribute":
      return `Rótulo ${levelDigit(d.index)}: ${d.value !== undefined ? str(d.value) : other}`;
    case "productChannel":
      return `Canal: ${d.channel !== undefined ? str(d.channel) : other}`;
    case "productCondition":
      return `Condição: ${d.condition !== undefined ? str(d.condition) : other}`;
    case "productChannelExclusivity":
      return `Exclusividade de canal: ${d.channelExclusivity !== undefined ? str(d.channelExclusivity) : other}`;
    case "webpage":
      return `Página: ${arr(d.conditions).map((c) => str(c.customLabel ?? c.urlContains)).join(" + ") || "(todas)"}`;
    case "retailFilterBundle":
      return `Filtro de varejo: ${str(d.sharedSet)}`;
    case "":
      return "(raiz: todos os produtos)";
    default:
      return `${key}: ${formatJson(d).replace(/\s+/g, " ")}`;
  }
}

function collectCategoryIds(dimensions: Row[]): string[] {
  return dimensions
    .map((dim) => str(obj(dim.productCategory).categoryId))
    .filter((id) => DIGITS.test(id));
}

// ═════════════════════════════════════════════════════════════════════

export function registerRetailReportingTools(ctx: ToolContext): void {
  const { mcp, getClient } = ctx;

  // ── Item 32: PMax por canal ────────────────────────────────────────

  mcp.registerTool(
    "get_pmax_channel_performance",
    {
      description: [
        "Performance Max por canal: onde o PMax gasta e converte (Pesquisa, YouTube, Display, Discover,",
        "Gmail, Maps, Parceiros, Google TV). READ OPERATION.",
        "",
        "Usa segments.ad_network_type (API v23+). level=campaign (default), asset_group ou asset.",
        "Por item e no total: gasto, impressões, cliques, conversões, valor, ROAS, CPA e % do gasto do item.",
        "splitByProductData / splitByVideo (só level=campaign) separam anúncios que usaram dados do feed",
        "do Merchant Center e/ou vídeo (segments.ad_using_product_data / ad_using_video).",
        "MIXED = gasto que a API não atribuiu a um canal (cross-network).",
        "level=asset: métricas por asset contam uma vez por asset exibido no anúncio e não somam; o total",
        "e o resumo por canal vêm do grupo de recursos (mesmos filtros), e cada asset traz só os seus números.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra uma campanha PMax. Sem ele: todas as PMax da conta."),
        assetGroupId: z.string().optional().describe("Filtra um grupo de recursos (level asset_group ou asset)."),
        level: z.enum(["campaign", "asset_group", "asset"]).optional().describe("Nível do relatório. Default: campaign."),
        splitByProductData: z.boolean().optional().describe("Separa anúncios com/sem dados de produto (só level campaign)."),
        splitByVideo: z.boolean().optional().describe("Separa anúncios com/sem vídeo (só level campaign)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, assetGroupId, level, splitByProductData, splitByVideo, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const idError = badIds({ campaignId, assetGroupId });
      if (idError) return fail(idError);
      const lvl = level ?? "campaign";
      if ((splitByProductData || splitByVideo) && lvl !== "campaign") {
        return fail("splitByProductData e splitByVideo só existem em level campaign: a API só expõe segments.ad_using_product_data e ad_using_video em FROM campaign.");
      }
      if (assetGroupId && lvl === "campaign") return fail("assetGroupId só vale com level asset_group ou asset.");
      if (lvl === "asset" && !campaignId && !assetGroupId) {
        return fail("level asset exige campaignId ou assetGroupId (por asset na conta inteira o relatório fica grande demais).");
      }
      const dateClause = dateClauseOf(dateRange, days);
      if (typeof dateClause !== "string") return fail(dateClause.error);

      const select: string[] = ["campaign.id", "campaign.name"];
      let from = "campaign";
      if (lvl === "asset_group") {
        from = "asset_group";
        select.push("asset_group.id", "asset_group.name", "asset_group.status");
      } else if (lvl === "asset") {
        from = "asset_group_asset";
        select.push(
          "asset_group.id", "asset_group.name", "asset_group_asset.field_type",
          "asset.id", "asset.type", "asset.name", "asset.text_asset.text", "asset.youtube_video_asset.youtube_video_title"
        );
      }
      select.push("segments.ad_network_type");
      if (splitByProductData) select.push("segments.ad_using_product_data");
      if (splitByVideo) select.push("segments.ad_using_video");
      select.push(...BASE_METRICS);
      const where = ["campaign.advertising_channel_type = 'PERFORMANCE_MAX'", dateClause];
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      if (assetGroupId) where.push(`asset_group.id = ${assetGroupId}`);

      const client = getClient();
      const whereClause = where.join("\n           AND ");
      // level=asset: a API conta as métricas de asset uma vez para cada asset exibido no anúncio
      // (1 impressão com título + descrição = 1 impressão e o custo em cada um), então as linhas de
      // asset não somam. O total e o resumo por canal vêm do grupo de recursos, com os mesmos filtros.
      const [rows, totalRows] = await Promise.all([
        client.searchStream(cid,
          `SELECT ${select.join(", ")}
           FROM ${from}
           WHERE ${whereClause}`),
        lvl === "asset"
          ? client.searchStream(cid,
              `SELECT campaign.id, asset_group.id, segments.ad_network_type, ${BASE_METRICS.join(", ")}
               FROM asset_group
               WHERE ${whereClause}`)
          : Promise.resolve(null),
      ]);

      /** Chave e rótulo do canal de uma linha (rede + divisões opcionais). */
      const channelOf = (segments: Row): { key: string; info: Row } => {
        const network = str(segments.adNetworkType) || "UNSPECIFIED";
        const info: Row = { canal: NETWORK_LABELS[network] ?? network, rede: network };
        let key = network;
        if (splitByProductData) {
          const flag = segments.adUsingProductData === undefined ? null : segments.adUsingProductData === true;
          info.usa_dados_de_produto = flag;
          key += `|p:${flag}`;
        }
        if (splitByVideo) {
          const flag = segments.adUsingVideo === undefined ? null : segments.adUsingVideo === true;
          info.usa_video = flag;
          key += `|v:${flag}`;
        }
        return { key, info };
      };

      interface Item { info: Row; total: Totals; channels: Map<string, { info: Row; totals: Totals }> }
      const items = new Map<string, Item>();
      const byChannel = new Map<string, { info: Row; totals: Totals }>();
      const grand = emptyTotals();
      const addToSummary = (channel: { key: string; info: Row }, metricsValue: unknown) => {
        const overall = byChannel.get(channel.key) ?? { info: channel.info, totals: emptyTotals() };
        byChannel.set(channel.key, overall);
        accumulate(overall.totals, metricsValue);
        accumulate(grand, metricsValue);
      };
      for (const row of rows) {
        const campaign = obj(row.campaign);
        const assetGroup = obj(row.assetGroup);
        const asset = obj(row.asset);
        const link = obj(row.assetGroupAsset);
        const segments = obj(row.segments);
        let key = str(campaign.id);
        const info: Row = { campaign_id: str(campaign.id), campaign_name: str(campaign.name) };
        if (lvl !== "campaign") {
          key += `|${str(assetGroup.id)}`;
          info.asset_group_id = str(assetGroup.id);
          info.asset_group_name = str(assetGroup.name);
          if (lvl === "asset_group") info.asset_group_status = str(assetGroup.status);
        }
        if (lvl === "asset") {
          key += `|${str(asset.id)}|${str(link.fieldType)}`;
          info.asset_id = str(asset.id);
          info.asset_type = str(asset.type);
          info.field_type = str(link.fieldType);
          info.asset = str(obj(asset.textAsset).text) || str(obj(asset.youtubeVideoAsset).youtubeVideoTitle) || str(asset.name) || `asset ${str(asset.id)}`;
        }
        const channelRef = channelOf(segments);
        const item = items.get(key) ?? { info, total: emptyTotals(), channels: new Map() };
        items.set(key, item);
        // dentro de um mesmo asset as linhas por canal não se sobrepõem: o total do item é a soma delas
        accumulate(item.total, row.metrics);
        const channel = item.channels.get(channelRef.key) ?? { info: channelRef.info, totals: emptyTotals() };
        item.channels.set(channelRef.key, channel);
        accumulate(channel.totals, row.metrics);
        if (!totalRows) addToSummary(channelRef, row.metrics);
      }
      // level=asset: total e resumo por canal só do grupo de recursos (as linhas de asset não somam)
      for (const row of totalRows ?? []) addToSummary(channelOf(obj(row.segments)), row.metrics);

      const channelRow = (entry: { info: Row; totals: Totals }, parentCost: number) => ({
        ...entry.info,
        share_of_spend_pct: pct(entry.totals.costMicros, parentCost),
        ...performance(entry.totals),
      });
      const sortChannels = (entries: Iterable<{ info: Row; totals: Totals }>) =>
        [...entries].sort((a, b) => b.totals.costMicros - a.totals.costMicros || b.totals.impressions - a.totals.impressions);
      const summary = sortChannels(byChannel.values()).map((entry) => channelRow(entry, grand.costMicros));
      const list = [...items.values()]
        .sort((a, b) => b.total.costMicros - a.total.costMicros)
        .map((item) => ({
          ...item.info,
          total: performance(item.total),
          canais: sortChannels(item.channels.values()).map((entry) => channelRow(entry, item.total.costMicros)),
        }));

      const notes: string[] = [];
      if (rows.length === 0) {
        notes.push("Nenhum dado: confira se há campanhas Performance Max com tráfego no período (e se o campaignId é de uma PMax).");
      }
      const mixed = [...byChannel.values()].filter((e) => e.info.rede === "MIXED").reduce((s, e) => s + e.totals.costMicros, 0);
      if (mixed > 0 && grand.costMicros > 0) {
        notes.push(`${pct(mixed, grand.costMicros)}% do gasto veio como MIXED (cross-network): a API não atribuiu esse gasto a um canal específico.`);
      }
      if ([...byChannel.values()].some((e) => e.info.rede === "GOOGLE_OWNED_CHANNELS")) {
        notes.push("GOOGLE_OWNED_CHANNELS é o agrupamento histórico (Discover/Gmail/YouTube) de dados anteriores à divisão por canal.");
      }
      if (splitByProductData) notes.push("usa_dados_de_produto: o anúncio usou dados do feed do Merchant Center (só PMax).");
      if (totalRows) {
        notes.push(
          "Métricas por asset contam uma vez para cada asset exibido no anúncio (uma impressão com título + " +
          "descrição registra a impressão e o custo nos dois): não some as linhas dos assets. O total e o " +
          "resumo por canal vêm do nível de grupo de recursos (FROM asset_group), com os mesmos filtros."
        );
      }

      const levelName = lvl === "campaign" ? "campanha(s)" : lvl === "asset_group" ? "grupo(s) de recursos" : "asset(s)";
      const top = summary[0];
      const header =
        `${list.length} ${levelName} PMax — gasto total ${round2(grand.costMicros / 1_000_000)}` +
        (totalRows ? " (dos grupos de recursos no filtro, não a soma dos assets)" : "") +
        `, conversões ${round2(grand.conversions)}, valor ${round2(grand.conversionsValue)}.` +
        (top ? ` Canal com mais gasto: ${str((top as Row).canal)} (${top.share_of_spend_pct}%).` : "") +
        (notes.length ? `\n${notes.join("\n")}` : "");
      const flat = list.flatMap((item) => {
        const { total: _total, canais, ...info } = item;
        return canais.map((channel) => ({ ...info, ...channel }));
      });
      return render(format, flat, header, {
        nivel: lvl,
        periodo: dateClause,
        ...(totalRows ? { origem_do_total: "asset_group (métricas por asset não somam)" } : {}),
        total: performance(grand),
        por_canal: summary,
        itens: list,
        notas: notes,
      });
    }
  );

  // ── Item 33: status e problemas de produtos ────────────────────────

  mcp.registerTool(
    "get_product_status",
    {
      description: [
        "Status dos produtos do Merchant Center nos anúncios (shopping_product): por que um produto não",
        "aparece. READ OPERATION.",
        "",
        "Devolve contagem por status (ELIGIBLE, ELIGIBLE_LIMITED, NOT_ELIGIBLE), os principais problemas",
        "agrupados por error_code (severidade, atributo, link de ajuda, nº de produtos afetados, regiões),",
        "uma amostra de produtos com problema e os elegíveis que tiveram 0 impressões no período.",
        "Escopo: conta (default; agrega Shopping + PMax), campanha (campaignId: Shopping, PMax, Demand Gen,",
        "Vídeo, App) ou grupo de anúncios (campaignId + adGroupId: Shopping, Demand Gen, Vídeo, App).",
        "Status e problemas podem levar até 24h para atualizar; em campanhas App não existem.",
        "Dica: na conta inteira a consulta é pesada — prefira campaignId e/ou status.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Escopo de campanha."),
        adGroupId: z.string().optional().describe("Escopo de grupo de anúncios (exige campaignId)."),
        status: z.enum(["ELIGIBLE", "ELIGIBLE_LIMITED", "NOT_ELIGIBLE"]).optional().describe("Filtra por status."),
        severity: z.enum(["ERROR", "WARNING"]).optional().describe("Só problemas desta severidade (ERROR impede veicular; WARNING limita)."),
        itemIds: flexArray(z.string()).optional().describe("Só estes item_id (até 500)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(`${DAYS_DESC} Janela das impressões usadas em "elegíveis sem impressões".`),
        limit: z.number().optional().describe("Tamanho das amostras de produtos. Default: 20 (máx. 200)."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, status, severity, itemIds, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const idError = badIds({ campaignId, adGroupId });
      if (idError) return fail(idError);
      if (adGroupId && !campaignId) return fail("adGroupId exige campaignId (a API pede os dois filtros no escopo de grupo).");
      const items = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((id) => String(id).trim()).filter(Boolean))];
      if (items.length > 500) return fail(`itemIds aceita até 500 ids (recebidos ${items.length}).`);
      const sample = limit ?? 20;
      if (!Number.isInteger(sample) || sample < 1 || sample > 200) return fail(`limit deve ser inteiro entre 1 e 200 (recebido ${limit}).`);
      const dateClause = dateClauseOf(dateRange, days);
      if (typeof dateClause !== "string") return fail(dateClause.error);

      const client = getClient();
      let scope = "conta";
      let channel = "";
      const notes: string[] = [];
      if (campaignId) {
        const scopeRows = adGroupId
          ? await client.searchStream(cid,
              `SELECT ad_group.id, ad_group.name, campaign.id, campaign.name, campaign.advertising_channel_type
               FROM ad_group
               WHERE ad_group.id = ${adGroupId}
                 AND campaign.id = ${campaignId}`)
          : await client.searchStream(cid,
              `SELECT campaign.id, campaign.name, campaign.advertising_channel_type
               FROM campaign
               WHERE campaign.id = ${campaignId}`);
        if (!scopeRows.length) {
          return fail(adGroupId
            ? `Grupo de anúncios ${adGroupId} não encontrado na campanha ${campaignId} da conta ${cid}.`
            : `Campanha ${campaignId} não encontrada na conta ${cid}.`);
        }
        const campaign = obj(scopeRows[0].campaign);
        channel = str(campaign.advertisingChannelType);
        const allowed = adGroupId ? PRODUCT_SCOPE_AD_GROUP_TYPES : PRODUCT_SCOPE_CAMPAIGN_TYPES;
        if (!allowed.has(channel)) {
          return fail(adGroupId
            ? `A campanha ${campaignId} é ${channel}: o escopo de grupo em shopping_product só existe em Shopping, Demand Gen, Vídeo e App (PMax não tem grupos de anúncios — use só campaignId).`
            : `A campanha ${campaignId} é ${channel}: shopping_product só aceita escopo de campanhas Shopping, Performance Max, Demand Gen, Vídeo e App.`);
        }
        if (channel === "MULTI_CHANNEL" && (status || severity)) {
          return fail("Campanha App: shopping_product não tem status nem problemas de produto nesse escopo — tire status/severity.");
        }
        if (channel === "MULTI_CHANNEL") notes.push("Campanha App: a API não devolve status nem problemas de produto neste escopo, só impressões e cliques.");
        else if (LIMITED_METRIC_TYPES.has(channel)) notes.push(`Campanha ${channel}: neste escopo a API só aceita impressões e cliques (sem custo/conversões).`);
        scope = adGroupId
          ? `grupo de anúncios ${adGroupId} "${str(obj(scopeRows[0].adGroup).name)}" (campanha ${campaignId} "${str(campaign.name)}")`
          : `campanha ${campaignId} "${str(campaign.name)}" (${channel})`;
      }

      const select = [
        "shopping_product.item_id", "shopping_product.title", "shopping_product.brand",
        "shopping_product.merchant_center_id", "shopping_product.channel", "shopping_product.language_code",
        "shopping_product.feed_label", "shopping_product.availability", "shopping_product.price_micros",
        "shopping_product.currency_code",
        // App: status e issues não existem nesse escopo (notas da v24)
        ...(channel === "MULTI_CHANNEL" ? [] : ["shopping_product.status", "shopping_product.issues"]),
      ];
      const where = [dateClause];
      if (campaignId) {
        // campaign só é selecionável no escopo de campanha; effective_max_cpc só existe com campanha/grupo
        select.push("shopping_product.campaign", "shopping_product.effective_max_cpc_micros");
        where.push(`shopping_product.campaign = 'customers/${cid}/campaigns/${campaignId}'`);
      }
      if (adGroupId) {
        select.push("shopping_product.ad_group");
        where.push(`shopping_product.ad_group = 'customers/${cid}/adGroups/${adGroupId}'`);
      }
      if (status) where.push(`shopping_product.status = '${status}'`);
      if (items.length) where.push(`shopping_product.item_id IN (${items.map((id) => `'${gaqlLiteral(id)}'`).join(", ")})`);
      // Demand Gen, Vídeo e App: só impressions, clicks e ctr são aceitas no escopo de campanha/grupo
      select.push("metrics.impressions", "metrics.clicks", ...(LIMITED_METRIC_TYPES.has(channel) ? [] : ["metrics.cost_micros", "metrics.conversions"]));

      // segments.date só no WHERE: a API recusa segmentar shopping_product por data (UNSUPPORTED_DATE_SEGMENTATION)
      const rows = await client.searchStream(cid,
        `SELECT ${select.join(", ")}
         FROM shopping_product
         WHERE ${where.join("\n           AND ")}`);

      interface Product { row: Row; issues: Row[]; impressions: number; clicks: number; spend: number; status: string }
      const products: Product[] = rows.map((row) => {
        const p = obj(row.shoppingProduct);
        const m = obj(row.metrics);
        return {
          row: p,
          issues: arr(p.issues),
          impressions: num(m.impressions),
          clicks: num(m.clicks),
          spend: round2(micros(m.costMicros)),
          status: str(p.status) || (channel === "MULTI_CHANNEL" ? "N/D (App)" : "UNSPECIFIED"),
        };
      });
      const describe = (product: Product) => {
        const p = product.row;
        const issues = product.issues
          .filter((issue) => !severity || str(issue.adsSeverity) === severity)
          .map((issue) => ({ code: str(issue.errorCode), severity: str(issue.adsSeverity), attribute: str(issue.attributeName) || undefined, description: str(issue.description) }));
        return {
          item_id: str(p.itemId),
          title: str(p.title),
          brand: str(p.brand) || undefined,
          status: product.status,
          availability: str(p.availability) || undefined,
          price: p.priceMicros !== undefined ? round2(micros(p.priceMicros)) : undefined,
          currency: str(p.currencyCode) || undefined,
          channel: str(p.channel),
          feed_label: str(p.feedLabel),
          merchant_center_id: str(p.merchantCenterId),
          ...(p.effectiveMaxCpcMicros !== undefined ? { effective_max_cpc: round2(micros(p.effectiveMaxCpcMicros)) } : {}),
          impressions: product.impressions,
          clicks: product.clicks,
          spend: product.spend,
          issues,
        };
      };

      const byStatus: Record<string, number> = {};
      for (const product of products) byStatus[product.status] = (byStatus[product.status] ?? 0) + 1;
      const outOfStock = products.filter((p) => str(p.row.availability) === "OUT_OF_STOCK").length;

      interface IssueGroup { error_code: string; severidade: string; descricao: string; atributo?: string; documentacao?: string; produtos_afetados: number; regioes: Set<string>; todas_as_regioes: boolean; exemplos: string[] }
      const issueGroups = new Map<string, IssueGroup>();
      for (const product of products) {
        const seen = new Set<string>();
        for (const issue of product.issues) {
          const level = str(issue.adsSeverity);
          if (severity && level !== severity) continue;
          const key = `${str(issue.errorCode)}|${level}`;
          const group = issueGroups.get(key) ?? {
            error_code: str(issue.errorCode), severidade: level, descricao: str(issue.description),
            atributo: str(issue.attributeName) || undefined, documentacao: str(issue.documentation) || undefined,
            produtos_afetados: 0, regioes: new Set<string>(), todas_as_regioes: false, exemplos: [],
          };
          issueGroups.set(key, group);
          const regions = (Array.isArray(issue.affectedRegions) ? issue.affectedRegions : []).map(String);
          if (regions.length === 0) group.todas_as_regioes = true;
          regions.forEach((r) => group.regioes.add(r));
          if (seen.has(key)) continue;
          seen.add(key);
          group.produtos_afetados += 1;
          if (group.exemplos.length < 5) group.exemplos.push(str(product.row.itemId));
        }
      }
      const topIssues = [...issueGroups.values()]
        .sort((a, b) => (a.severidade === b.severidade ? 0 : a.severidade === "ERROR" ? -1 : 1) || b.produtos_afetados - a.produtos_afetados)
        .slice(0, 25)
        .map(({ regioes, todas_as_regioes, exemplos, ...group }) => ({
          ...group,
          regioes_afetadas: todas_as_regioes ? "todas" : [...regioes].sort(),
          exemplos_item_id: exemplos,
        }));

      const rank: Record<string, number> = { NOT_ELIGIBLE: 0, ELIGIBLE_LIMITED: 1, ELIGIBLE: 2 };
      const withProblems = products
        .filter((p) => p.issues.some((issue) => !severity || str(issue.adsSeverity) === severity))
        .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || b.spend - a.spend);
      const eligibleIdle = products
        .filter((p) => (p.status === "ELIGIBLE" || p.status === "ELIGIBLE_LIMITED") && p.impressions === 0)
        .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));

      if (rows.length === 0) {
        notes.push("Nenhum produto retornado: sem conta do Merchant Center vinculada, filtros sem correspondência, ou a campanha não inclui produtos.");
      }
      const countsText = Object.entries(byStatus)
        .map(([s, n]) => `${PRODUCT_STATUS_LABELS[s] ?? s}: ${n}`)
        .join(" | ");
      const header =
        `Produtos — escopo: ${scope}. ${products.length} produto(s)${countsText ? ` (${countsText})` : ""}.` +
        ` ${withProblems.length} com problema${severity ? ` de severidade ${severity}` : ""};` +
        ` ${eligibleIdle.length} elegível(is) sem impressão no período.` +
        (outOfStock ? ` ${outOfStock} fora de estoque.` : "") +
        (notes.length ? `\n${notes.join("\n")}` : "");
      const sampleProblems = withProblems.slice(0, sample).map(describe);
      const sampleIdle = eligibleIdle.slice(0, sample).map(describe);
      const flat = [
        ...sampleProblems.map((p) => ({ lista: "com_problema", ...p, issues: p.issues.map((i) => `${i.severity}:${i.code}`).join("; ") })),
        ...sampleIdle.map((p) => ({ lista: "elegivel_sem_impressao", ...p, issues: p.issues.map((i) => `${i.severity}:${i.code}`).join("; ") })),
      ];
      return render(format, flat, header, {
        escopo: scope,
        periodo_metricas: dateClause,
        total_produtos: products.length,
        por_status: byStatus,
        fora_de_estoque: outOfStock,
        principais_problemas: topIssues,
        produtos_com_problema: { total: withProblems.length, amostra: sampleProblems },
        elegiveis_sem_impressoes: { total: eligibleIdle.length, amostra: sampleIdle },
        notas: notes,
      });
    }
  );

  // ── Item 71: produtos (shopping_performance_view) — movida de src/tools.ts ──

  mcp.registerTool(
    "get_shopping_products",
    {
      description: [
        "Performance de produtos em Shopping/PMax (shopping_performance_view). READ OPERATION.",
        "Default (compatível com a versão anterior): por item — title, item_id, clicks, impressions, spend,",
        "conversions, revenue (= valor de conversão) e roas; valores já convertidos de micros.",
        "",
        "Opções:",
        "- campaignId / channelType: filtra uma campanha ou um tipo (SHOPPING, PERFORMANCE_MAX, ...).",
        "- groupBy: item | brand | category_l1..l5 | type_l1..l5 | custom_label0..4 | channel | feed_label.",
        "- includeProfit: dados do carrinho (receita, lucro bruto, COGS, unidades, pedidos) + POAS",
        "  (lucro bruto / gasto) e lucro após anúncios. orderBy=profit ordena por lucro bruto.",
        "- includeImpressionShare: parcela de impressões na rede de Pesquisa (IS, perda por orçamento/rank).",
        "Métricas por produto seguem a atribuição do relatório de produto: impressões contam para cada",
        "produto exibido no anúncio, então a soma passa do total da campanha.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        orderBy: z
          .enum(["spend", "revenue", "clicks", "conversions", "profit"])
          .optional()
          .describe("Ordenação. Default: revenue (valor de conversão). profit = lucro bruto (liga includeProfit)."),
        limit: z.number().optional().describe("Máx. de linhas. Default: 20."),
        campaignId: z.string().optional().describe("Filtra uma campanha."),
        channelType: z
          .enum(["SHOPPING", "PERFORMANCE_MAX", "DEMAND_GEN", "VIDEO", "DISPLAY", "MULTI_CHANNEL"])
          .optional()
          .describe("Filtra pelo tipo de campanha."),
        groupBy: z.enum(PRODUCT_GROUP_BY).optional().describe("Dimensão de agrupamento. Default: item."),
        includeProfit: z.boolean().optional().describe("Inclui métricas de conversões com dados do carrinho (lucro, POAS)."),
        includeImpressionShare: z.boolean().optional().describe("Inclui parcela de impressões (rede de Pesquisa)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, orderBy, limit, campaignId, channelType, groupBy, includeProfit, includeImpressionShare, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const idError = badIds({ campaignId });
      if (idError) return fail(idError);
      const max = limit ?? 20;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit}).`);
      const dateClause = dateClauseOf(dateRange, days);
      if (typeof dateClause !== "string") return fail(dateClause.error);
      const group: ProductGroupBy = groupBy ?? "item";
      const order = orderBy ?? "revenue";
      const withProfit = includeProfit === true || order === "profit";
      const withShare = includeImpressionShare === true;
      const fields = productFields(group, "clicked")!;

      const select = [...fields];
      const where = [dateClause];
      // campaign é recurso de segmentação desta view: o campo filtrado precisa estar no SELECT
      if (campaignId) {
        select.push("campaign.id");
        where.push(`campaign.id = ${campaignId}`);
      }
      if (channelType) {
        select.push("campaign.advertising_channel_type");
        where.push(`campaign.advertising_channel_type = '${channelType}'`);
      }
      select.push(...BASE_METRICS);
      if (withProfit) select.push(...PROFIT_METRICS);
      if (withShare) select.push(...SHARE_METRICS.map((s) => `metrics.${s.field}`));
      const orderField: Record<string, string> = {
        spend: "metrics.cost_micros",
        revenue: "metrics.conversions_value",
        clicks: "metrics.clicks",
        conversions: "metrics.conversions",
        profit: "metrics.gross_profit_micros",
      };
      // Com channelType sem campaignId cada linha vem por campanha e o agrupamento é feito aqui: sem
      // LIMIT curto, senão os totais do grupo sairiam incompletos. Por item, o título pode variar no
      // período (duas linhas para o mesmo item) — busca-se uma folga.
      const perCampaignRows = Boolean(channelType) && !campaignId;
      const fetchLimit = perCampaignRows ? ROW_CAP : group === "item" ? Math.min(max * 2 + 20, ROW_CAP) : max;

      const client = getClient();
      const rows = await client.searchStream(cid,
        `SELECT ${select.join(", ")}
         FROM shopping_performance_view
         WHERE ${where.join("\n           AND ")}
         ORDER BY ${orderField[order]} DESC
         LIMIT ${fetchLimit}`);

      const groups = new Map<string, { value: string; title?: string; totals: Totals }>();
      for (const row of rows) {
        const value = str(pick(row, fields[0]));
        const entry = groups.get(value) ?? { value, totals: emptyTotals() };
        if (group === "item" && !entry.title) entry.title = str(pick(row, fields[1]));
        groups.set(value, entry);
        accumulate(entry.totals, row.metrics);
      }
      const sortKey = (t: Totals) =>
        order === "spend" ? t.costMicros
          : order === "clicks" ? t.clicks
            : order === "conversions" ? t.conversions
              : order === "profit" ? t.grossProfitMicros
                : t.conversionsValue;
      const ranked = [...groups.values()].sort((a, b) => sortKey(b.totals) - sortKey(a.totals)).slice(0, max);

      const categoryNames = /^category_l/.test(group)
        ? await resolveCategoryNames(client, cid, { resourceNames: ranked.map((g) => g.value) })
        : new Map<string, string>();
      const notes: string[] = [];
      if (perCampaignRows && rows.length >= ROW_CAP) {
        notes.push(`Atenção: a consulta bateu o teto de ${ROW_CAP} linhas; os totais podem estar incompletos — filtre por campaignId.`);
      }
      const all = emptyTotals();
      ranked.forEach((g) => { all.costMicros += g.totals.costMicros; all.revenueMicros += g.totals.revenueMicros; all.grossProfitMicros += g.totals.grossProfitMicros; all.unitsSold += g.totals.unitsSold; all.cogsMicros += g.totals.cogsMicros; });
      if (withProfit && ranked.length > 0 && !hasCartData(all)) notes.push(NO_CART_DATA_HINT);

      const out = ranked.map((g) => {
        const t = g.totals;
        const spend = t.costMicros / 1_000_000;
        const base: Row = group === "item"
          ? { title: g.title, item_id: g.value }
          : { [group]: categoryNames.get(g.value) ?? (g.value || "(vazio)"), ...(categoryNames.has(g.value) ? { category_resource: g.value } : {}) };
        return {
          ...base,
          clicks: t.clicks,
          impressions: t.impressions,
          spend: round2(spend),
          conversions: round2(t.conversions),
          revenue: round2(t.conversionsValue),
          roas: spend > 0 ? round2(t.conversionsValue / spend) : 0,
          ...(withProfit ? profitView(t) : {}),
          ...(withShare ? shareView(t) : {}),
        };
      });

      const filters = [campaignId ? `campanha ${campaignId}` : "", channelType ? `tipo ${channelType}` : ""].filter(Boolean).join(", ");
      const header = (group === "item" ? `${out.length} produto(s).` : `${out.length} grupo(s) por ${GROUP_BY_LABELS[group]}.`) +
        (filters ? ` Filtro: ${filters}.` : "") +
        (notes.length ? `\n${notes.join("\n")}` : "");
      if (format === "table" || format === "csv") return render(format, out, header, out);
      return { content: [text(`${header}\n\n${formatJson(out)}`)] };
    }
  );

  // ── Item 71: grupos de produtos (listing groups) ───────────────────

  mcp.registerTool(
    "get_listing_group_performance",
    {
      description: [
        "Métricas por grupo de produtos (listing group). READ OPERATION.",
        "Performance Max: asset_group_product_group_view (por grupo de recursos). Shopping padrão:",
        "product_group_view (por grupo de anúncios). Cada nó sai com o caminho legível (ex.:",
        "\"Marca: Nike > Tipo L1: Tênis\"), o tipo (SUBDIVISION, UNIT_INCLUDED/UNIT_EXCLUDED ou UNIT),",
        "gasto, cliques, conversões, valor, ROAS e, com includeProfit, lucro dos dados do carrinho.",
        "Informe campaignId (o tipo da campanha decide a view), assetGroupId (PMax) ou adGroupId (Shopping).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha PMax ou Shopping."),
        assetGroupId: z.string().optional().describe("Grupo de recursos (PMax)."),
        adGroupId: z.string().optional().describe("Grupo de anúncios (Shopping padrão)."),
        onlyUnits: z.boolean().optional().describe("Só nós finais (sem SUBDIVISION). Default: false."),
        includeProfit: z.boolean().optional().describe("Inclui métricas de conversões com dados do carrinho."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máx. de nós listados (por gasto). Default: 200."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, assetGroupId, adGroupId, onlyUnits, includeProfit, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const idError = badIds({ campaignId, assetGroupId, adGroupId });
      if (idError) return fail(idError);
      if (!campaignId && !assetGroupId && !adGroupId) return fail("Informe campaignId, assetGroupId (PMax) ou adGroupId (Shopping).");
      if (assetGroupId && adGroupId) return fail("Use assetGroupId (PMax) OU adGroupId (Shopping), não os dois.");
      const max = limit ?? 200;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit}).`);
      const dateClause = dateClauseOf(dateRange, days);
      if (typeof dateClause !== "string") return fail(dateClause.error);

      const client = getClient();
      let view: "pmax" | "shopping";
      let scope: string;
      if (assetGroupId) {
        const found = await client.searchStream(cid,
          `SELECT asset_group.id, asset_group.name, campaign.id, campaign.name
           FROM asset_group
           WHERE asset_group.id = ${assetGroupId}${campaignId ? `\n             AND campaign.id = ${campaignId}` : ""}`);
        if (!found.length) return fail(`Grupo de recursos ${assetGroupId} não encontrado${campaignId ? ` na campanha ${campaignId}` : ""}.`);
        view = "pmax";
        scope = `grupo de recursos ${assetGroupId} "${str(obj(found[0].assetGroup).name)}" (campanha ${str(obj(found[0].campaign).id)})`;
      } else if (adGroupId) {
        const found = await client.searchStream(cid,
          `SELECT ad_group.id, ad_group.name, campaign.id, campaign.advertising_channel_type
           FROM ad_group
           WHERE ad_group.id = ${adGroupId}${campaignId ? `\n             AND campaign.id = ${campaignId}` : ""}`);
        if (!found.length) return fail(`Grupo de anúncios ${adGroupId} não encontrado${campaignId ? ` na campanha ${campaignId}` : ""}.`);
        const channel = str(obj(found[0].campaign).advertisingChannelType);
        if (channel !== "SHOPPING") return fail(`O grupo de anúncios ${adGroupId} é de campanha ${channel}; grupos de produtos por grupo de anúncios só existem em Shopping.`);
        view = "shopping";
        scope = `grupo de anúncios ${adGroupId} "${str(obj(found[0].adGroup).name)}"`;
      } else {
        const found = await client.searchStream(cid,
          `SELECT campaign.id, campaign.name, campaign.advertising_channel_type
           FROM campaign
           WHERE campaign.id = ${campaignId}`);
        if (!found.length) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}.`);
        const channel = str(obj(found[0].campaign).advertisingChannelType);
        if (channel === "PERFORMANCE_MAX") view = "pmax";
        else if (channel === "SHOPPING") view = "shopping";
        else return fail(`A campanha ${campaignId} é ${channel}; grupos de produtos só existem em Performance Max e Shopping.`);
        scope = `campanha ${campaignId} "${str(obj(found[0].campaign).name)}" (${channel})`;
      }

      const metrics = [...BASE_METRICS, ...(includeProfit ? PROFIT_METRICS : [])];
      const where = [dateClause];
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      let query: string;
      if (view === "pmax") {
        if (assetGroupId) where.push(`asset_group.id = ${assetGroupId}`);
        const f = "asset_group_listing_group_filter";
        query = `SELECT campaign.id, asset_group.id, asset_group.name,
                        ${f}.id, ${f}.type, ${f}.listing_source, ${f}.parent_listing_group_filter, ${f}.path,
                        ${f}.case_value.product_brand.value, ${f}.case_value.product_item_id.value,
                        ${f}.case_value.product_category.category_id, ${f}.case_value.product_category.level,
                        ${f}.case_value.product_type.value, ${f}.case_value.product_type.level,
                        ${f}.case_value.product_custom_attribute.value, ${f}.case_value.product_custom_attribute.index,
                        ${f}.case_value.product_channel.channel, ${f}.case_value.product_condition.condition,
                        ${metrics.join(", ")}
                 FROM asset_group_product_group_view
                 WHERE ${where.join("\n                   AND ")}`;
      } else {
        if (adGroupId) where.push(`ad_group.id = ${adGroupId}`);
        const f = "ad_group_criterion";
        query = `SELECT campaign.id, ad_group.id, ad_group.name,
                        ${f}.criterion_id, ${f}.negative, ${f}.listing_group.type, ${f}.listing_group.path,
                        ${f}.listing_group.parent_ad_group_criterion, ${f}.cpc_bid_micros,
                        ${f}.listing_group.case_value.product_brand.value, ${f}.listing_group.case_value.product_item_id.value,
                        ${f}.listing_group.case_value.product_category.category_id, ${f}.listing_group.case_value.product_category.level,
                        ${f}.listing_group.case_value.product_type.value, ${f}.listing_group.case_value.product_type.level,
                        ${f}.listing_group.case_value.product_custom_attribute.value, ${f}.listing_group.case_value.product_custom_attribute.index,
                        ${f}.listing_group.case_value.product_channel.channel, ${f}.listing_group.case_value.product_condition.condition,
                        ${metrics.join(", ")}
                 FROM product_group_view
                 WHERE ${where.join("\n                   AND ")}`;
      }
      const rows = await client.searchStream(cid, query);

      const nodes = rows.map((row) => {
        if (view === "pmax") {
          const node = obj(row.assetGroupListingGroupFilter);
          const caseValue = obj(node.caseValue);
          const dims = arr(obj(node.path).dimensions);
          return {
            group: `${str(obj(row.assetGroup).id)} ${str(obj(row.assetGroup).name)}`.trim(),
            nodeId: str(node.id),
            type: str(node.type),
            parent: str(node.parentListingGroupFilter),
            dims: dims.length ? dims : Object.keys(caseValue).length ? [caseValue] : [],
            bid: undefined as number | undefined,
            metrics: row.metrics,
          };
        }
        const criterion = obj(row.adGroupCriterion);
        const listing = obj(criterion.listingGroup);
        const caseValue = obj(listing.caseValue);
        const dims = arr(obj(listing.path).dimensions);
        const type = str(listing.type);
        return {
          group: `${str(obj(row.adGroup).id)} ${str(obj(row.adGroup).name)}`.trim(),
          nodeId: str(criterion.criterionId),
          type: type === "UNIT" && criterion.negative === true ? "UNIT (excluído)" : type,
          parent: str(listing.parentAdGroupCriterion),
          dims: dims.length ? dims : Object.keys(caseValue).length ? [caseValue] : [],
          bid: criterion.cpcBidMicros !== undefined ? round2(micros(criterion.cpcBidMicros)) : undefined,
          metrics: row.metrics,
        };
      });
      const categoryNames = await resolveCategoryNames(client, cid, { categoryIds: nodes.flatMap((n) => collectCategoryIds(n.dims)) });
      const out = nodes
        .filter((n) => !onlyUnits || !/SUBDIVISION/.test(n.type))
        .map((n) => {
          const t = accumulate(emptyTotals(), n.metrics);
          return {
            [view === "pmax" ? "asset_group" : "ad_group"]: n.group,
            node_id: n.nodeId,
            path: n.dims.length ? n.dims.map((d) => dimensionLabel(d, categoryNames)).join(" > ") : dimensionLabel({}, categoryNames),
            type: n.type,
            ...(n.bid !== undefined ? { cpc_bid: n.bid } : {}),
            ...performance(t),
            ...(includeProfit ? profitView(t) : {}),
            _cost: t.costMicros,
          };
        })
        .sort((a, b) => b._cost - a._cost || b.impressions - a.impressions)
        .slice(0, max)
        .map(({ _cost, ...rest }) => rest);

      const notes: string[] = [];
      if (rows.length === 0) notes.push("Nenhum grupo de produtos com dados no período.");
      notes.push("Nós SUBDIVISION agregam os filhos: não some SUBDIVISION com os nós finais.");
      const header = `${out.length} grupo(s) de produtos — ${scope} (${view === "pmax" ? "asset_group_product_group_view" : "product_group_view"}).\n${notes.join("\n")}`;
      return render(format, out, header, { escopo: scope, periodo: dateClause, grupos: out });
    }
  );

  // ── Item 71: vendas com dados do carrinho ──────────────────────────

  mcp.registerTool(
    "get_cart_data_sales",
    {
      description: [
        "Vendas por produto a partir de conversões com dados do carrinho (cart_data_sales_view, v24+).",
        "READ OPERATION.",
        "",
        "perspective=sold (default): agrupa pelo produto VENDIDO (product_sold_*); clicked: pelo produto",
        "do anúncio clicado. Métricas: receita, lucro bruto, COGS, unidades; lead_* = o mesmo produto do",
        "anúncio, cross_sell_* = outro produto vendido na mesma compra. A view não tem gasto nem cliques:",
        "para ROAS/POAS use get_shopping_products com includeProfit.",
        "Sem conversões com dados do carrinho a view volta vazia — a tool avisa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra uma campanha."),
        groupBy: z.enum(PRODUCT_GROUP_BY).optional().describe("Default: item. channel e feed_label só com perspective=clicked."),
        perspective: z.enum(["sold", "clicked"]).optional().describe("Produto vendido (default) ou clicado."),
        orderBy: z.enum(["revenue", "profit", "units"]).optional().describe("Default: revenue."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máx. de linhas. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, groupBy, perspective, orderBy, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const idError = badIds({ campaignId });
      if (idError) return fail(idError);
      const max = limit ?? 50;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit}).`);
      const side = perspective ?? "sold";
      const group: ProductGroupBy = groupBy ?? "item";
      const fields = productFields(group, side);
      if (!fields) return fail(`groupBy ${group} só existe com perspective=clicked (a API não tem product_sold_${group === "channel" ? "channel" : "feed_label"}).`);
      const dateClause = dateClauseOf(dateRange, days);
      if (typeof dateClause !== "string") return fail(dateClause.error);

      const cartMetrics = [
        "metrics.revenue_micros", "metrics.gross_profit_micros", "metrics.cost_of_goods_sold_micros", "metrics.units_sold",
        "metrics.lead_revenue_micros", "metrics.lead_units_sold", "metrics.cross_sell_revenue_micros", "metrics.cross_sell_units_sold",
      ];
      const select = [...fields];
      const where = [dateClause];
      if (campaignId) {
        select.push("campaign.id");
        where.push(`campaign.id = ${campaignId}`);
      }
      select.push(...cartMetrics);
      const orderField = { revenue: "metrics.revenue_micros", profit: "metrics.gross_profit_micros", units: "metrics.units_sold" }[orderBy ?? "revenue"];
      const client = getClient();
      const rows = await client.searchStream(cid,
        `SELECT ${select.join(", ")}
         FROM cart_data_sales_view
         WHERE ${where.join("\n           AND ")}
         ORDER BY ${orderField} DESC
         LIMIT ${group === "item" ? Math.min(max * 2 + 20, ROW_CAP) : max}`);

      interface Sale { value: string; title?: string; revenue: number; profit: number; cogs: number; units: number; leadRevenue: number; leadUnits: number; crossRevenue: number; crossUnits: number }
      const groups = new Map<string, Sale>();
      for (const row of rows) {
        const m = obj(row.metrics);
        const value = str(pick(row, fields[0]));
        const entry = groups.get(value) ?? { value, revenue: 0, profit: 0, cogs: 0, units: 0, leadRevenue: 0, leadUnits: 0, crossRevenue: 0, crossUnits: 0 };
        if (group === "item" && !entry.title) entry.title = str(pick(row, fields[1]));
        entry.revenue += micros(m.revenueMicros);
        entry.profit += micros(m.grossProfitMicros);
        entry.cogs += micros(m.costOfGoodsSoldMicros);
        entry.units += num(m.unitsSold);
        entry.leadRevenue += micros(m.leadRevenueMicros);
        entry.leadUnits += num(m.leadUnitsSold);
        entry.crossRevenue += micros(m.crossSellRevenueMicros);
        entry.crossUnits += num(m.crossSellUnitsSold);
        groups.set(value, entry);
      }
      const key = (s: Sale) => (orderBy === "profit" ? s.profit : orderBy === "units" ? s.units : s.revenue);
      const ranked = [...groups.values()].sort((a, b) => key(b) - key(a)).slice(0, max);
      const categoryNames = /^category_l/.test(group)
        ? await resolveCategoryNames(client, cid, { resourceNames: ranked.map((s) => s.value) })
        : new Map<string, string>();
      const out = ranked.map((s) => ({
        ...(group === "item" ? { item_id: s.value, title: s.title } : { [group]: categoryNames.get(s.value) ?? (s.value || "(vazio)") }),
        revenue: round2(s.revenue),
        gross_profit: round2(s.profit),
        cogs: round2(s.cogs),
        margin_pct: s.revenue > 0 ? round2((s.profit / s.revenue) * 100) : null,
        units_sold: round2(s.units),
        lead_revenue: round2(s.leadRevenue),
        lead_units: round2(s.leadUnits),
        cross_sell_revenue: round2(s.crossRevenue),
        cross_sell_units: round2(s.crossUnits),
      }));
      const notes: string[] = [];
      if (rows.length === 0) notes.push(NO_CART_DATA_HINT);
      const header =
        `${out.length} ${group === "item" ? "produto(s)" : `grupo(s) por ${GROUP_BY_LABELS[group]}`} — perspectiva: produto ${side === "sold" ? "vendido" : "clicado"}` +
        (campaignId ? `, campanha ${campaignId}` : "") + "." +
        (notes.length ? `\n${notes.join("\n")}` : "");
      return render(format, out, header, out);
    }
  );

  // ── Item 51: listas de marcas ──────────────────────────────────────

  mcp.registerTool(
    "suggest_brands",
    {
      description: [
        "Sugere marcas pelo começo do nome (BrandSuggestionService.SuggestBrands). READ OPERATION.",
        "Devolve id (use em create_brand_list / update_brand_list), nome, URLs e estado (ENABLED =",
        "verificada; UNVERIFIED = pedido da própria conta, pode ser usada por ela).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        prefix: z.string().describe("Começo do nome da marca (ex.: \"nik\")."),
        excludeBrandIds: flexArray(z.string()).optional().describe("Ids de marcas já escolhidas (saem da resposta)."),
        format: formatSchema,
      },
    },
    async ({ customerId, prefix, excludeBrandIds, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const brandPrefix = String(prefix ?? "").trim();
      if (!brandPrefix) return fail("prefix não pode ser vazio.");
      if (brandPrefix.length > 100) return fail("prefix longo demais (máx. 100 caracteres).");
      const { ids: selected, bad } = cleanBrandIds(excludeBrandIds);
      if (bad.length) return fail(`excludeBrandIds inválidos: ${bad.join(", ")}.`);

      const client = getClient();
      const response = await client.customerAction<Row>(cid, ":suggestBrands", {
        brandPrefix,
        ...(selected.length ? { selectedBrands: selected } : {}),
      });
      const brands = arr(response.brands).map((b) => ({
        id: str(b.id),
        name: str(b.name),
        state: str(b.state),
        urls: Array.isArray(b.urls) ? (b.urls as unknown[]).map(String) : [],
      }));
      const header = `${brands.length} marca(s) para "${brandPrefix}".` +
        (brands.length ? " Use o id em create_brand_list/update_brand_list." : " Tente outro prefixo (a busca é pelo começo do nome).");
      return render(format, brands.map((b) => ({ ...b, urls: b.urls.join(" ") })), header, brands);
    }
  );

  mcp.registerTool(
    "list_brand_lists",
    {
      description: [
        "Lista as listas de marcas (shared sets BRANDS) da conta. READ OPERATION.",
        "Por lista: marcas com estado e motivo de rejeição, e onde está anexada (campanhas e grupos,",
        "como inclusão ou exclusão), com o override de Shopping do PMax/Shopping.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        sharedSetId: z.string().optional().describe("Só esta lista (ID ou resource name)."),
        includeRemoved: z.boolean().optional().describe("Inclui listas removidas. Default: false."),
      },
    },
    async ({ customerId, sharedSetId, includeRemoved }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      let setId: string | undefined;
      if (sharedSetId !== undefined) {
        const parsed = parseSharedSetRef(sharedSetId, cid);
        if ("error" in parsed) return fail(parsed.error);
        setId = parsed.id;
      }
      const client = getClient();
      const where = ["shared_set.type = 'BRANDS'"];
      if (!includeRemoved) where.push("shared_set.status = 'ENABLED'");
      if (setId) where.push(`shared_set.id = ${setId}`);
      const sets = await client.searchStream(cid,
        `SELECT shared_set.id, shared_set.resource_name, shared_set.name, shared_set.status,
                shared_set.member_count, shared_set.reference_count
         FROM shared_set
         WHERE ${where.join(" AND ")}
         ORDER BY shared_set.name`);
      if (!sets.length) {
        return { content: [text(setId ? `Lista de marcas ${setId} não encontrada (ou não é do tipo BRANDS).` : "Nenhuma lista de marcas na conta. Crie com create_brand_list.")] };
      }
      const setResource = setId ? `customers/${cid}/sharedSets/${setId}` : undefined;
      const members = await fetchBrandMembers(client, cid, setResource);
      const listFilter = setResource ? `\n           AND campaign_criterion.brand_list.shared_set = '${setResource}'` : "";
      const campaignLinks = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.pmax_campaign_settings.brand_targeting_overrides.ignore_exclusions_for_shopping_ads,
                campaign.shopping_setting.ignore_brand_exclusion_in_shopping_ads,
                campaign_criterion.criterion_id, campaign_criterion.negative, campaign_criterion.status,
                campaign_criterion.brand_list.shared_set
         FROM campaign_criterion
         WHERE campaign_criterion.type = 'BRAND_LIST'
           AND campaign_criterion.status != 'REMOVED'
           AND campaign.status != 'REMOVED'${listFilter}`);
      const groupFilter = setResource ? `\n           AND ad_group_criterion.brand_list.shared_set = '${setResource}'` : "";
      const adGroupLinks = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status,
                ad_group_criterion.criterion_id, ad_group_criterion.negative, ad_group_criterion.status,
                ad_group_criterion.brand_list.shared_set
         FROM ad_group_criterion
         WHERE ad_group_criterion.type = 'BRAND_LIST'
           AND ad_group_criterion.status != 'REMOVED'
           AND ad_group.status != 'REMOVED'${groupFilter}`);

      const warnings: string[] = [];
      const lists = sets.map((row) => {
        const set = obj(row.sharedSet);
        const resource = str(set.resourceName);
        const brands = members.filter((m) => m.shared_set === resource).map(({ shared_set: _s, resource_name: _r, ...m }) => m);
        const dead = brands.filter((b) => DEAD_BRAND_STATES.has(b.status));
        if (dead.length) {
          warnings.push(`Lista "${str(set.name)}": ${dead.length} marca(s) sem efeito (${dead.map((b) => `${b.name || b.entity_id}=${b.status}${b.rejection_reason ? `/${b.rejection_reason}` : ""}`).join(", ")}).`);
        }
        const campaigns = campaignLinks
          .filter((l) => str(obj(obj(l.campaignCriterion).brandList).sharedSet) === resource)
          .map((l) => {
            const campaign = obj(l.campaign);
            const criterion = obj(l.campaignCriterion);
            const channel = str(campaign.advertisingChannelType);
            const link: Row = {
              campaign_id: str(campaign.id),
              campaign_name: str(campaign.name),
              channel_type: channel,
              mode: criterion.negative === true ? "EXCLUDE" : "INCLUDE",
              criterion_id: str(criterion.criterionId),
              status: str(criterion.status),
            };
            if (channel === "PERFORMANCE_MAX") {
              link.ignore_exclusions_for_shopping_ads = obj(obj(campaign.pmaxCampaignSettings).brandTargetingOverrides).ignoreExclusionsForShoppingAds === true;
            }
            if (channel === "SHOPPING") {
              link.ignore_brand_exclusion_in_shopping_ads = obj(campaign.shoppingSetting).ignoreBrandExclusionInShoppingAds === true;
            }
            return link;
          });
        const adGroups = adGroupLinks
          .filter((l) => str(obj(obj(l.adGroupCriterion).brandList).sharedSet) === resource)
          .map((l) => ({
            campaign_id: str(obj(l.campaign).id),
            campaign_name: str(obj(l.campaign).name),
            ad_group_id: str(obj(l.adGroup).id),
            ad_group_name: str(obj(l.adGroup).name),
            mode: obj(l.adGroupCriterion).negative === true ? "EXCLUDE" : "INCLUDE",
            criterion_id: str(obj(l.adGroupCriterion).criterionId),
            status: str(obj(l.adGroupCriterion).status),
          }));
        return {
          shared_set_id: str(set.id),
          name: str(set.name),
          status: str(set.status),
          member_count: num(set.memberCount),
          reference_count: num(set.referenceCount),
          brands,
          attached_campaigns: campaigns,
          attached_ad_groups: adGroups,
        };
      });
      const header = `${lists.length} lista(s) de marcas.` + (warnings.length ? `\n${warnings.join("\n")}` : "");
      return { content: [text(`${header}\n\n${formatJson(lists)}`)] };
    }
  );

  mcp.registerTool(
    "create_brand_list",
    {
      description: [
        "Cria uma lista de marcas (shared set BRANDS) com as marcas informadas. WRITE OPERATION.",
        "Uma chamada atômica (googleAds:mutate): ou cria a lista com todas as marcas, ou nada.",
        "brandIds = ids de suggest_brands (não o nome). Para usar a lista: attach_brand_list.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da lista (único entre as listas ativas)."),
        brandIds: flexArray(z.string()).describe("Ids das marcas (suggest_brands)."),
      },
    },
    async ({ customerId, name, brandIds }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi criado.`);
      const listName = String(name ?? "").trim();
      if (!listName) return fail("name não pode ser vazio. Nada foi criado.");
      if (Buffer.byteLength(listName, "utf8") > 255) return fail("name passa de 255 bytes (limite do SharedSet). Nada foi criado.");
      const { ids, bad } = cleanBrandIds(brandIds);
      if (bad.length) return fail(`brandIds inválidos: ${bad.join(", ")}. Nada foi criado.`);
      if (!ids.length) return fail("Informe ao menos uma marca em brandIds (ids de suggest_brands). Nada foi criado.");

      const client = getClient();
      const existing = await client.searchStream(cid,
        `SELECT shared_set.id, shared_set.name
         FROM shared_set
         WHERE shared_set.type = 'BRANDS'
           AND shared_set.status = 'ENABLED'
           AND shared_set.name = '${gaqlLiteral(listName)}'`);
      if (existing.length) {
        return fail(`Já existe a lista de marcas "${listName}" (ID ${str(obj(existing[0].sharedSet).id)}). Use update_brand_list para mudar as marcas. Nada foi criado.`);
      }
      const temp = `customers/${cid}/sharedSets/-1`;
      const operations: Row[] = [
        { sharedSetOperation: { create: { resourceName: temp, name: listName, type: "BRANDS" } } },
        ...ids.map((entityId) => ({ sharedCriterionOperation: { create: { sharedSet: temp, brand: { entityId } } } })),
      ];
      let response: Row;
      try {
        response = await client.batchMutate(cid, operations);
      } catch (err) {
        return fail(`A API recusou a criação da lista: ${explainBrandError((err as Error).message)}\nNada foi criado (operação atômica).`);
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): validado, nada foi gravado. Lista "${listName}" com ${ids.length} marca(s) passaria na API.`)] };
      }
      const responses = arr(response.mutateOperationResponses);
      const created = str(obj(responses[0]?.sharedSetResult).resourceName);
      const setIdCreated = created.split("/").pop() ?? "";
      return {
        content: [text(
          `Lista de marcas "${listName}" criada (ID ${setIdCreated}) com ${ids.length} marca(s).\n` +
          "Próximo passo: attach_brand_list (Pesquisa: inclusão/exclusão; PMax e Shopping: só exclusão).\n\n" +
          formatJson({ shared_set: created, brands: ids })
        )],
      };
    }
  );

  mcp.registerTool(
    "update_brand_list",
    {
      description: [
        "Altera uma lista de marcas: adiciona (add), remove (remove) e/ou renomeia (name). WRITE OPERATION.",
        "Lê a lista antes: marcas já presentes não são readicionadas e ausentes não são removidas; sem",
        "mudança, nada é gravado. Remover marcas exige confirm: true (sem ele, só mostra o que sairia).",
        "Cada marca é uma operação: falha de uma não derruba as outras (relatório por item).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        sharedSetId: z.string().describe("ID (ou resource name) da lista de marcas."),
        add: flexArray(z.string()).optional().describe("Ids de marcas a incluir (suggest_brands)."),
        remove: flexArray(z.string()).optional().describe("Ids de marcas (ou criterion_id) a retirar."),
        name: z.string().optional().describe("Novo nome da lista."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para remover marcas."),
      },
    },
    async ({ customerId, sharedSetId, add, remove, name, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const parsed = parseSharedSetRef(sharedSetId, cid);
      if ("error" in parsed) return fail(`${parsed.error} Nada foi alterado.`);
      const toAddIn = cleanBrandIds(add);
      const toRemoveIn = cleanBrandIds(remove);
      if (toAddIn.bad.length || toRemoveIn.bad.length) return fail(`Ids de marca inválidos: ${[...toAddIn.bad, ...toRemoveIn.bad].join(", ")}. Nada foi alterado.`);
      const newName = name === undefined ? undefined : String(name).trim();
      if (newName !== undefined && !newName) return fail("name não pode ser vazio. Nada foi alterado.");
      if (newName !== undefined && Buffer.byteLength(newName, "utf8") > 255) return fail("name passa de 255 bytes. Nada foi alterado.");
      if (!toAddIn.ids.length && !toRemoveIn.ids.length && newName === undefined) return fail("Informe add, remove e/ou name. Nada foi alterado.");
      const both = toAddIn.ids.filter((id) => toRemoveIn.ids.includes(id));
      if (both.length) return fail(`Marca em add e remove ao mesmo tempo: ${both.join(", ")}. Nada foi alterado.`);

      const client = getClient();
      const set = await fetchBrandSet(client, cid, parsed.id);
      if (!set) return fail(`Lista ${parsed.id} não encontrada na conta ${cid}. Nada foi alterado.`);
      if (set.type !== "BRANDS") return fail(`O shared set ${parsed.id} é do tipo ${set.type}, não BRANDS. Nada foi alterado.`);
      if (set.status !== "ENABLED") return fail(`A lista ${parsed.id} está ${set.status}; listas removidas não aceitam alterações. Nada foi alterado.`);
      const members = await fetchBrandMembers(client, cid, set.resourceName);
      const plan = {
        add: toAddIn.ids.filter((id) => !members.some((m) => m.entity_id === id)),
        already_present: toAddIn.ids.filter((id) => members.some((m) => m.entity_id === id)),
        remove: members.filter((m) => toRemoveIn.ids.includes(m.entity_id) || toRemoveIn.ids.includes(m.criterion_id)),
        not_in_list: toRemoveIn.ids.filter((id) => !members.some((m) => m.entity_id === id || m.criterion_id === id)),
        rename: newName !== undefined && newName !== set.name ? { from: set.name, to: newName } : null,
      };
      const before = { name: set.name, brands: members.map((m) => ({ entity_id: m.entity_id, name: m.name, status: m.status })) };
      const planView = {
        adicionar: plan.add,
        ja_presentes: plan.already_present,
        remover: plan.remove.map((m) => ({ entity_id: m.entity_id, name: m.name, criterion_id: m.criterion_id })),
        nao_estao_na_lista: plan.not_in_list,
        renomear: plan.rename,
      };
      if (!plan.add.length && !plan.remove.length && !plan.rename) {
        return { content: [text(`Nada a fazer na lista "${set.name}" (${set.id}): as mudanças pedidas já estão aplicadas. Nada foi gravado.\n\n${formatJson(planView)}`)] };
      }
      if (plan.remove.length && confirm !== true) {
        return {
          content: [text(
            `Remover ${plan.remove.length} marca(s) da lista "${set.name}" exige confirm: true. Nada foi alterado.\n` +
            `Campanhas/grupos que usam a lista: ${set.referenceCount}.\n\n${formatJson({ antes: before, plano: planView })}`
          )],
          isError: true,
        };
      }
      if (plan.rename) {
        const clash = await client.searchStream(cid,
          `SELECT shared_set.id FROM shared_set
           WHERE shared_set.type = 'BRANDS' AND shared_set.status = 'ENABLED'
             AND shared_set.name = '${gaqlLiteral(plan.rename.to)}'`);
        if (clash.some((r) => str(obj(r.sharedSet).id) !== set.id)) {
          return fail(`Já existe outra lista de marcas chamada "${plan.rename.to}". Nada foi alterado.`);
        }
      }

      const dryRun = client.isDryRun;
      const report: Row = {};
      const errors: Row[] = [];
      if (plan.rename) {
        try {
          await client.mutate(cid, "sharedSets", [{ update: { resourceName: set.resourceName, name: plan.rename.to }, updateMask: "name" }]);
          report[dryRun ? "renomearia" : "renomeada"] = plan.rename;
        } catch (err) {
          errors.push({ operacao: "renomear", error: explainBrandError((err as Error).message) });
        }
      }
      const operations = [
        ...plan.add.map((entityId) => ({ create: { sharedSet: set.resourceName, brand: { entityId } } })),
        ...plan.remove.map((m) => ({ remove: m.resource_name || `customers/${cid}/sharedCriteria/${set.id}~${m.criterion_id}` })),
      ];
      const added: string[] = [];
      const removed: string[] = [];
      if (operations.length) {
        try {
          const response = await client.mutate(cid, "sharedCriteria", operations, { partialFailure: true });
          const results = arr(response.results);
          const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, operations.length);
          operations.forEach((_op, index) => {
            const isAdd = index < plan.add.length;
            const label = isAdd ? plan.add[index] : plan.remove[index - plan.add.length].entity_id;
            const opErrors = byIndex.get(index);
            if (opErrors) errors.push({ operacao: isAdd ? "adicionar" : "remover", marca: label, error: explainBrandError(opErrors.join("; ")) });
            else if (!dryRun && !str(results[index]?.resourceName)) errors.push({ operacao: isAdd ? "adicionar" : "remover", marca: label, error: "a API não confirmou a operação" });
            else (isAdd ? added : removed).push(label);
          });
          unattributed.forEach((message) => errors.push({ error: explainBrandError(message) }));
        } catch (err) {
          errors.push({ operacao: "marcas", error: explainBrandError((err as Error).message) });
        }
      }
      report[dryRun ? "adicionariam" : "adicionadas"] = added;
      report[dryRun ? "removeriam" : "removidas"] = removed;
      const headline = dryRun
        ? `Lista "${set.name}" (${set.id}) — DRY-RUN (validateOnly): validado, nada foi gravado.`
        : `Lista "${plan.rename?.to ?? set.name}" (${set.id}) atualizada: +${added.length} / -${removed.length} marca(s)${report.renomeada ? ", renomeada" : ""}.`;
      return {
        content: [text(`${headline}${errors.length ? ` Com erro: ${errors.length}.` : ""}\n\n${formatJson({ antes: before, plano: planView, resultado: report, erros: errors })}`)],
        isError: errors.length > 0,
      };
    }
  );

  mcp.registerTool(
    "attach_brand_list",
    {
      description: [
        "Anexa uma lista de marcas a uma campanha ou grupo de anúncios. WRITE OPERATION.",
        "mode INCLUDE (anunciar só associado a essas marcas) ou EXCLUDE (não aparecer junto delas).",
        "Regras da API, conferidas antes de gravar:",
        "- Pesquisa: EXCLUDE sempre; INCLUDE só com AI Max ligado (ou broad match de campanha, legado);",
        "  com ai_max_setting.bundling_required = REQUIRED, qualquer lista exige o AI Max ligado.",
        "- Grupo de anúncios (Pesquisa): só INCLUDE.",
        "- Performance Max e Shopping: só EXCLUDE.",
        "ignoreExclusionsForShoppingAds (PMax/Shopping) liga/desliga o override que ignora as exclusões",
        "de marca nos anúncios de Shopping. Tudo numa chamada atômica; o que já está igual é pulado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        sharedSetId: z.string().describe("ID (ou resource name) da lista de marcas."),
        campaignId: z.string().optional().describe("Campanha (use campaignId OU adGroupId)."),
        adGroupId: z.string().optional().describe("Grupo de anúncios de Pesquisa."),
        mode: z.enum(["INCLUDE", "EXCLUDE"]).describe("Inclusão ou exclusão."),
        ignoreExclusionsForShoppingAds: z.boolean().optional().describe("PMax/Shopping: ignorar exclusões de marca nos anúncios de Shopping."),
      },
    },
    async ({ customerId, sharedSetId, campaignId, adGroupId, mode, ignoreExclusionsForShoppingAds }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const parsed = parseSharedSetRef(sharedSetId, cid);
      if ("error" in parsed) return fail(`${parsed.error} Nada foi alterado.`);
      const idError = badIds({ campaignId, adGroupId });
      if (idError) return fail(`${idError} Nada foi alterado.`);
      if (!!campaignId === !!adGroupId) return fail("Informe campaignId OU adGroupId (um dos dois). Nada foi alterado.");
      if (mode !== "INCLUDE" && mode !== "EXCLUDE") return fail(`mode deve ser INCLUDE ou EXCLUDE (recebido ${mode}). Nada foi alterado.`);
      if (ignoreExclusionsForShoppingAds !== undefined && adGroupId) {
        return fail("ignoreExclusionsForShoppingAds é configuração de campanha (PMax/Shopping), não de grupo. Nada foi alterado.");
      }

      const client = getClient();
      const set = await fetchBrandSet(client, cid, parsed.id);
      if (!set) return fail(`Lista ${parsed.id} não encontrada na conta ${cid}. Nada foi alterado.`);
      if (set.type !== "BRANDS") return fail(`O shared set ${parsed.id} é do tipo ${set.type}, não BRANDS. Nada foi alterado.`);
      if (set.status !== "ENABLED") return fail(`A lista ${parsed.id} está ${set.status}. Nada foi alterado.`);
      const target = await fetchTarget(client, cid, { campaignId, adGroupId });
      if (!target) return fail(`${adGroupId ? `Grupo de anúncios ${adGroupId}` : `Campanha ${campaignId}`} não encontrado na conta ${cid}. Nada foi alterado.`);
      const ruleError = brandListRuleError(target, mode);
      if (ruleError) return fail(`${ruleError} Nada foi alterado.`);
      const override = shoppingOverride(target);
      if (ignoreExclusionsForShoppingAds !== undefined && !override) {
        return fail(`ignoreExclusionsForShoppingAds só existe em Performance Max e Shopping; a ${describeTarget(target)} não é. Nada foi alterado.`);
      }

      const links = await fetchBrandListLinks(client, cid, target);
      const sameList = links.filter((l) => l.sharedSet === set.resourceName);
      const negative = mode === "EXCLUDE";
      if (sameList.some((l) => l.negative !== negative)) {
        return fail(
          `A lista "${set.name}" já está anexada à ${describeTarget(target)} como ${negative ? "INCLUDE" : "EXCLUDE"}; ` +
          "o modo de um critério não muda (campo imutável). Use detach_brand_list e anexe de novo. Nada foi alterado."
        );
      }
      const attachNeeded = !sameList.length;
      const toggleNeeded = override !== null && ignoreExclusionsForShoppingAds !== undefined && override.current !== ignoreExclusionsForShoppingAds;
      const before = {
        listas_anexadas: links.map((l) => ({ shared_set: l.sharedSet, mode: l.negative ? "EXCLUDE" : "INCLUDE", status: l.status })),
        ...(override ? { ignore_exclusions_for_shopping_ads: override.current } : {}),
      };
      if (!attachNeeded && !toggleNeeded) {
        return { content: [text(`Nada a fazer: a lista "${set.name}" já está anexada à ${describeTarget(target)} como ${mode}${override && ignoreExclusionsForShoppingAds !== undefined ? " e o override de Shopping já está como pedido" : ""}. Nada foi gravado.\n\n${formatJson(before)}`)] };
      }

      const operations: Row[] = [];
      if (attachNeeded) {
        operations.push(target.kind === "ad_group"
          ? { adGroupCriterionOperation: { create: { adGroup: target.resourceName, negative: false, brandList: { sharedSet: set.resourceName } } } }
          : { campaignCriterionOperation: { create: { campaign: target.resourceName, negative, brandList: { sharedSet: set.resourceName } } } });
      }
      if (toggleNeeded && override) {
        operations.push(override.field === "pmax"
          ? {
              campaignOperation: {
                update: { resourceName: target.resourceName, pmaxCampaignSettings: { brandTargetingOverrides: { ignoreExclusionsForShoppingAds: ignoreExclusionsForShoppingAds } } },
                updateMask: "pmax_campaign_settings.brand_targeting_overrides.ignore_exclusions_for_shopping_ads",
              },
            }
          : {
              campaignOperation: {
                update: { resourceName: target.resourceName, shoppingSetting: { ignoreBrandExclusionInShoppingAds: ignoreExclusionsForShoppingAds } },
                updateMask: "shopping_setting.ignore_brand_exclusion_in_shopping_ads",
              },
            });
      }
      try {
        await client.batchMutate(cid, operations);
      } catch (err) {
        return fail(`A API recusou: ${explainBrandError((err as Error).message)}\nNada foi alterado (operação atômica).`);
      }
      const after = {
        lista: { shared_set: set.resourceName, name: set.name, mode, anexada: attachNeeded ? "agora" : "já estava" },
        ...(override && ignoreExclusionsForShoppingAds !== undefined ? { ignore_exclusions_for_shopping_ads: ignoreExclusionsForShoppingAds } : {}),
      };
      const notes: string[] = [];
      if (set.memberCount === 0) notes.push("Atenção: a lista está vazia — adicione marcas com update_brand_list.");
      if (mode === "INCLUDE") notes.push("INCLUDE restringe o tráfego às buscas associadas a essas marcas.");
      const headline = client.isDryRun
        ? `DRY-RUN (validateOnly): validado, nada foi gravado. Lista "${set.name}" → ${describeTarget(target)} (${mode}).`
        : `Lista "${set.name}" ${attachNeeded ? `anexada à ${describeTarget(target)} como ${mode}` : `já estava na ${describeTarget(target)}`}` +
          `${toggleNeeded ? `; override de Shopping ${ignoreExclusionsForShoppingAds ? "ligado" : "desligado"}` : ""}.`;
      return { content: [text(`${headline}${notes.length ? `\n${notes.join("\n")}` : ""}\n\n${formatJson({ antes: before, depois: after })}`)] };
    }
  );

  mcp.registerTool(
    "detach_brand_list",
    {
      description: [
        "Desanexa uma lista de marcas de uma campanha ou grupo de anúncios (remove o critério BRAND_LIST).",
        "WRITE OPERATION — exige confirm: true (sem ele, só mostra o que seria removido). A lista em si",
        "continua existindo e pode ser anexada de novo com attach_brand_list.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        sharedSetId: z.string().describe("ID (ou resource name) da lista de marcas."),
        campaignId: z.string().optional().describe("Campanha (use campaignId OU adGroupId)."),
        adGroupId: z.string().optional().describe("Grupo de anúncios."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para remover."),
      },
    },
    async ({ customerId, sharedSetId, campaignId, adGroupId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const parsed = parseSharedSetRef(sharedSetId, cid);
      if ("error" in parsed) return fail(`${parsed.error} Nada foi alterado.`);
      const idError = badIds({ campaignId, adGroupId });
      if (idError) return fail(`${idError} Nada foi alterado.`);
      if (!!campaignId === !!adGroupId) return fail("Informe campaignId OU adGroupId (um dos dois). Nada foi alterado.");

      const client = getClient();
      const target = await fetchTarget(client, cid, { campaignId, adGroupId });
      if (!target) return fail(`${adGroupId ? `Grupo de anúncios ${adGroupId}` : `Campanha ${campaignId}`} não encontrado na conta ${cid}. Nada foi alterado.`);
      const setResource = `customers/${cid}/sharedSets/${parsed.id}`;
      const links = (await fetchBrandListLinks(client, cid, target)).filter((l) => l.sharedSet === setResource);
      if (!links.length) {
        return { content: [text(`A lista ${parsed.id} não está anexada à ${describeTarget(target)}. Nada a remover; nada foi gravado.`)] };
      }
      const preview = links.map((l) => ({ criterion_id: l.criterionId, mode: l.negative ? "EXCLUDE" : "INCLUDE", status: l.status }));
      if (confirm !== true) {
        return {
          content: [text(`Desanexar a lista ${parsed.id} da ${describeTarget(target)} exige confirm: true. Nada foi alterado.\n\n${formatJson(preview)}`)],
          isError: true,
        };
      }
      const resource = target.kind === "ad_group" ? "adGroupCriteria" : "campaignCriteria";
      const prefix = target.kind === "ad_group" ? `customers/${cid}/adGroupCriteria/${target.adGroupId}` : `customers/${cid}/campaignCriteria/${target.campaignId}`;
      try {
        await client.mutate(cid, resource, links.map((l) => ({ remove: l.resourceName || `${prefix}~${l.criterionId}` })));
      } catch (err) {
        return fail(`A API recusou: ${explainBrandError((err as Error).message)}\nNada foi alterado.`);
      }
      const headline = client.isDryRun
        ? `DRY-RUN (validateOnly): validado, nada foi gravado. A lista ${parsed.id} sairia da ${describeTarget(target)}.`
        : `Lista ${parsed.id} desanexada da ${describeTarget(target)}.`;
      return { content: [text(`${headline}\n\n${formatJson({ [client.isDryRun ? "seriam_removidos" : "removidos"]: preview })}`)] };
    }
  );
}
