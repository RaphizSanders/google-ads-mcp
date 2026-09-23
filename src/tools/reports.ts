/**
 * Lote reports: relatórios de posicionamento ("onde os anúncios apareceram"), landing pages,
 * divisão por rede (Google Search × parceiros × Display) e visão consolidada do MCC.
 *
 * Todas as tools daqui são de LEITURA: nenhuma grava na conta. Onde o relatório aponta uma
 * ação (excluir posicionamento, desligar rede), ele devolve os dados no formato da tool de
 * escrita que faz isso — a decisão e a gravação ficam com ela.
 *
 * Campos, recursos e compatibilidades conferidos na field reference v25
 * (tests/fixtures/google-ads-v25-fields.json + páginas "selectable with") e nos protos v25.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  ISO_DATE,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  localIsoDate,
  num,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<ReturnType<typeof text>>; isError?: boolean };
type DateRange = { since: string; until: string } | undefined;

// ── Helpers do módulo ────────────────────────────────────────────────

const NUMERIC_ID = /^\d+$/;

const asRow = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });

/** IDs entram direto no GAQL: só dígitos passam. */
function invalidId(ids: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(ids)) {
    if (value !== undefined && !NUMERIC_ID.test(value)) return `${name} deve ser numérico, recebido "${value}".`;
  }
  return null;
}

/** buildDateClause não confere a ordem das datas; since > until viraria erro cru da API. */
function dateClauseFor(dateRange: DateRange, days: number | undefined): string {
  if (dateRange?.since && dateRange?.until && dateRange.since > dateRange.until) {
    throw new Error(`dateRange invertido: since (${dateRange.since}) é depois de until (${dateRange.until}).`);
  }
  return buildDateClause(dateRange, days);
}

function periodLabel(dateRange: DateRange, days: number | undefined): string {
  return dateRange?.since && dateRange?.until ? `${dateRange.since} a ${dateRange.until}` : `últimos ${days ?? 30} dias`;
}

/** Número finito e >= 0; devolve a mensagem de erro ou null. */
function invalidNonNegative(values: Record<string, number | undefined>): string | null {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return `${name} deve ser um número >= 0, recebido ${value}.`;
    }
  }
  return null;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(Math.floor(limit ?? fallback), max));
}

const pct = (part: number, whole: number) => (whole ? round2((part / whole) * 100) : 0);

/** Variação percentual; null quando o período anterior é zero (não há base). */
const changePct = (current: number, previous: number) =>
  previous ? round2(((current - previous) / previous) * 100) : null;

/**
 * Erros da API que estes relatórios provocam com frequência, em PT-BR. A mensagem
 * original vai junto: o client só repassa a mensagem (não o código), então o casamento
 * é pelo código, quando vier, ou pelo texto documentado no proto de erros.
 */
function explainReportError(message: string, customerId: string): string {
  if (/REQUESTED_METRICS_FOR_MANAGER|metrics cannot be requested for a manager account/i.test(message)) {
    return (
      `A conta ${customerId} é um MCC (conta de administrador): a API não devolve métricas de MCC, só das contas ` +
      "cliente, uma a uma. Use get_mcc_performance_summary para a visão consolidada ou informe o customerId da conta cliente." +
      `\n(API: ${message})`
    );
  }
  if (/CUSTOMER_NOT_ENABLED|not yet enabled or has been deactivated/i.test(message)) {
    return `A conta ${customerId} não está ativa (cancelada, suspensa ou com cadastro incompleto): a API não devolve dados dela.\n(API: ${message})`;
  }
  if (/USER_PERMISSION_DENIED|doesn't have permission to access customer/i.test(message)) {
    return (
      `O login configurado não tem acesso à conta ${customerId} (ou ela não está sob o MCC do login-customer-id).` +
      `\n(API: ${message})`
    );
  }
  return message;
}

function render(format: string | undefined, tableRows: Row[], header: string, payload: Row): ToolResult {
  if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(tableRows)}`)] };
  if (format === "csv") return { content: [text(formatAsCsv(tableRows))] };
  return { content: [text(`${header}\n\n${formatJson(payload)}`)] };
}

// ── Métricas ─────────────────────────────────────────────────────────

interface Totals {
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  viewThroughConversions: number;
  videoViews: number;
}

const emptyReportTotals = (): Totals => ({
  impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionsValue: 0, viewThroughConversions: 0, videoViews: 0,
});

function addReportMetrics(totals: Totals, metrics: unknown): Totals {
  const m = asRow(metrics);
  totals.impressions += num(m.impressions);
  totals.clicks += num(m.clicks);
  totals.costMicros += num(m.costMicros);
  totals.conversions += num(m.conversions);
  totals.conversionsValue += num(m.conversionsValue);
  totals.viewThroughConversions += num(m.viewThroughConversions);
  totals.videoViews += num(m.videoTrueviewViews);
  return totals;
}

function sumTotals(parts: Totals[]): Totals {
  return parts.reduce((acc, part) => {
    for (const key of Object.keys(acc) as Array<keyof Totals>) acc[key] += part[key];
    return acc;
  }, emptyReportTotals());
}

/** Métricas prontas para leitura (dinheiro em unidades da moeda da conta, % em 0–100). */
function view(t: Totals) {
  const spend = t.costMicros / 1_000_000;
  return {
    impressions: t.impressions,
    clicks: t.clicks,
    ctr_pct: pct(t.clicks, t.impressions),
    spend: round2(spend),
    cpc: t.clicks ? round2(spend / t.clicks) : null,
    conversions: round2(t.conversions),
    conv_rate_pct: pct(t.conversions, t.clicks),
    cpa: t.conversions ? round2(spend / t.conversions) : null,
    conversions_value: round2(t.conversionsValue),
    roas: spend ? round2(t.conversionsValue / spend) : null,
  };
}

// ── Posicionamentos ──────────────────────────────────────────────────

const PLACEMENT_VIEWS = ["GROUP", "DETAIL", "MANAGED", "PMAX"] as const;
type PlacementView = (typeof PLACEMENT_VIEWS)[number];

/** PlacementTypeEnum v25 (sem UNSPECIFIED/UNKNOWN). */
const PLACEMENT_TYPES = [
  "WEBSITE", "MOBILE_APPLICATION", "MOBILE_APP_CATEGORY", "YOUTUBE_VIDEO", "YOUTUBE_CHANNEL", "GOOGLE_PRODUCTS",
] as const;

/** Tipos que o proto de performance_max_placement_view diz existir em PMax. */
const PMAX_PLACEMENT_TYPES = new Set(["WEBSITE", "MOBILE_APPLICATION", "YOUTUBE_VIDEO"]);

/** PlacementType → CriterionType do critério gerenciado (managed_placement_view não tem placement_type). */
const MANAGED_CRITERION_TYPE: Record<string, string> = {
  WEBSITE: "PLACEMENT",
  MOBILE_APPLICATION: "MOBILE_APPLICATION",
  MOBILE_APP_CATEGORY: "MOBILE_APP_CATEGORY",
  YOUTUBE_VIDEO: "YOUTUBE_VIDEO",
  YOUTUBE_CHANNEL: "YOUTUBE_CHANNEL",
};
const CRITERION_TO_PLACEMENT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(MANAGED_CRITERION_TYPE).map(([placementType, criterionType]) => [criterionType, placementType])
);

/** Views automáticas: o recurso do FROM e a chave camelCase da linha na resposta REST. */
const AUTO_VIEWS: Record<Exclude<PlacementView, "MANAGED">, { resource: string; key: string; fields: string[] }> = {
  GROUP: { resource: "group_placement_view", key: "groupPlacementView", fields: ["placement", "display_name", "placement_type", "target_url"] },
  DETAIL: {
    resource: "detail_placement_view",
    key: "detailPlacementView",
    fields: ["placement", "display_name", "placement_type", "target_url", "group_placement_target_url"],
  },
  PMAX: {
    resource: "performance_max_placement_view",
    key: "performanceMaxPlacementView",
    fields: ["placement", "display_name", "placement_type", "target_url"],
  },
};

const PLACEMENT_METRICS = [
  "impressions", "clicks", "cost_micros", "conversions", "conversions_value", "view_through_conversions", "video_trueview_views",
];

/** Teto de linhas por consulta: as views vêm por grupo de anúncios × posicionamento e são agregadas aqui. */
const MAX_PLACEMENT_ROWS = 20000;

/**
 * Heurística de conteúdo infantil pelo NOME do canal/vídeo/app. A API não expõe a marcação
 * "feito para crianças" por posicionamento; o que existe é o rótulo de conteúdo
 * BRAND_SUITABILITY_CONTENT_FOR_FAMILIES para excluir em bloco.
 */
const KIDS_CONTENT = new RegExp(
  "(?<![\\p{L}\\p{N}])(" +
    [
      "kids?", "crian[cç]as?", "infantil", "infantis", "beb[eê]s?", "baby", "babies", "toddlers?", "nursery", "rhymes?",
      "cantigas?", "desenhos? animados?", "cartoons?", "brinquedos?", "toys?", "cocomelon", "peppa", "galinha pintadinha",
      "mundo bita", "patati", "luccas neto", "pinkfong", "baby shark", "bluey", "paw patrol", "patrulha canina",
    ].join("|") +
    ")(?![\\p{L}\\p{N}])",
  "iu"
);

/** Linha "Total: Other" das views automáticas: posicionamentos de baixo tráfego agregados pela API. */
const isOtherRow = (placement: string) => /^(total:\s*)?other$/i.test(placement.trim());

const bareHost = (host: string) => host.replace(/^www\./, "");

/**
 * Site em partes: host em minúsculas; caminho sem protocolo, fragmento e barras nas pontas;
 * query separada. null quando não há um host com ponto (não é site).
 */
function splitSite(value: string): { host: string; path: string; query: string } | null {
  const noScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("#")[0];
  const q = noScheme.indexOf("?");
  const beforeQuery = q === -1 ? noScheme : noScheme.slice(0, q);
  const query = q === -1 ? "" : noScheme.slice(q + 1);
  const slash = beforeQuery.indexOf("/");
  const host = (slash === -1 ? beforeQuery : beforeQuery.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "" : beforeQuery.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  return host.includes(".") ? { host, path, query } : null;
}

/**
 * Limites do critério de posicionamento por URL (docs Google Ads API › Targeting › Criteria:
 * "Limits on URL length (250 chars) and depth (2 levels)"; adsenseformobileapps.com não é aceito).
 */
const MAX_PLACEMENT_URL_LENGTH = 250;
const MAX_PLACEMENT_URL_DEPTH = 2;

interface ExclusionItem {
  type: "WEBSITE" | "MOBILE_APP" | "YOUTUBE_CHANNEL" | "YOUTUBE_VIDEO";
  value: string;
}

interface ExclusionSuggestion {
  /** Item exato para exclude_placements; null = não dá para sugerir com segurança. */
  exclusion: ExclusionItem | null;
  /** view=DETAIL, site: alternativa que bloqueia o DOMÍNIO inteiro — nunca vai para exclusion_items. */
  domain?: ExclusionItem;
  /** Por que não há exclusão, ou o que mudou no valor (ex.: parâmetros removidos). */
  note?: string;
}

/**
 * Converte a linha do relatório no item {type, value} de exclude_placements. Formatos do
 * placement conforme o proto PlacementTypeEnum v25: site 'www.site.com', app
 * 'mobileapp::2-com.pacote', vídeo 'youtube.com/video/ID', canal 'youtube.com::ID'.
 * Sem um ID reconhecível a exclusão é null — melhor não sugerir do que sugerir o errado.
 *
 * Site: em GROUP/PMAX o posicionamento é o domínio; em DETAIL é a página ("website URL" no
 * proto de detail_placement_view), e a exclusão sugerida é a própria página (domínio/caminho) —
 * uma página ruim não pode virar bloqueio do portal inteiro.
 */
function exclusionFor(
  reportView: PlacementView,
  placementType: string,
  placement: string,
  targetUrl: string
): ExclusionSuggestion {
  const both = `${targetUrl} ${placement}`;
  switch (placementType) {
    case "WEBSITE": {
      const site = splitSite(placement || targetUrl);
      if (!site) return { exclusion: null };
      if (bareHost(site.host) === "adsenseformobileapps.com") {
        return { exclusion: null, note: "adsenseformobileapps.com não é aceito como site pela API — exclua o app (MOBILE_APP)" };
      }
      const domain: ExclusionItem = { type: "WEBSITE", value: site.host };
      if (reportView !== "DETAIL" || !site.path) return { exclusion: domain };
      const value = `${site.host}/${site.path}`;
      const depth = site.path.split("/").filter(Boolean).length;
      if (depth > MAX_PLACEMENT_URL_DEPTH || value.length > MAX_PLACEMENT_URL_LENGTH) {
        return {
          exclusion: null,
          domain,
          note:
            `a API só exclui URL com até ${MAX_PLACEMENT_URL_DEPTH} níveis de caminho e ${MAX_PLACEMENT_URL_LENGTH} ` +
            `caracteres (esta tem ${depth} nível(is) e ${value.length} caracteres) — não dá para excluir só esta página`,
        };
      }
      return {
        exclusion: { type: "WEBSITE", value },
        domain,
        ...(site.query ? { note: "a URL tinha parâmetros (?…): a exclusão vale para o caminho sem eles" } : {}),
      };
    }
    case "MOBILE_APPLICATION": {
      const match = /^(?:mobileapp::)?([12]-[A-Za-z0-9._-]+)$/.exec(placement.trim());
      return { exclusion: match ? { type: "MOBILE_APP", value: match[1] } : null };
    }
    case "YOUTUBE_VIDEO": {
      const match =
        /(?:[?&]v=|youtu\.be\/|\/video\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(both) ??
        /^([A-Za-z0-9_-]{11})$/.exec(placement.trim());
      return { exclusion: match ? { type: "YOUTUBE_VIDEO", value: match[1] } : null };
    }
    case "YOUTUBE_CHANNEL": {
      const match = /(?<![A-Za-z0-9_-])(UC[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(both);
      return { exclusion: match ? { type: "YOUTUBE_CHANNEL", value: match[1] } : null };
    }
    default:
      return { exclusion: null }; // MOBILE_APP_CATEGORY, GOOGLE_PRODUCTS e UNKNOWN não viram exclusão de posicionamento
  }
}

interface PlacementLine {
  placement: string;
  display_name: string;
  placement_type: string;
  target_url: string;
  group_target_url?: string;
  network?: string;
  campaign_id?: string;
  campaign?: string;
  channel?: string;
  ad_group_id?: string;
  ad_group?: string;
  criterion_id?: string;
  criterion_status?: string;
  campaignIds: Set<string>;
  totals: Totals;
}

/** Exclusões que a conta já tem (nível conta e campanha), para não sugerir de novo. */
interface ExistingExclusions {
  account: Set<string>;
  byCampaign: Map<string, Set<string>>;
  labels: { account: Set<string>; campaigns: Map<string, string[]> };
}

const EXCLUDABLE_CRITERIA = "'PLACEMENT', 'MOBILE_APPLICATION', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'CONTENT_LABEL'";
/** Rótulos de conteúdo que cobrem, em bloco, os casos que a heurística procura. */
const RELEVANT_LABELS = ["PARKED_DOMAIN", "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES"];

/**
 * Chave de site para comparar exclusões: host sem www + caminho (+ query, se houver), em
 * minúsculas. O caminho FICA na chave: exclusão de uma página não é exclusão do domínio.
 */
function siteKey(value: string): string | null {
  const site = splitSite(value);
  if (!site) return null;
  return `${bareHost(site.host)}${site.path ? `/${site.path}` : ""}${site.query ? `?${site.query}` : ""}`.toLowerCase();
}

function exclusionKey(criterion: Row): string | null {
  const type = str(criterion.type);
  if (type === "PLACEMENT") {
    const key = siteKey(str(asRow(criterion.placement).url));
    return key ? `WEBSITE|${key}` : null;
  }
  if (type === "MOBILE_APPLICATION") return `MOBILE_APP|${str(asRow(criterion.mobileApplication).appId)}`;
  if (type === "YOUTUBE_CHANNEL") return `YOUTUBE_CHANNEL|${str(asRow(criterion.youtubeChannel).channelId)}`;
  if (type === "YOUTUBE_VIDEO") return `YOUTUBE_VIDEO|${str(asRow(criterion.youtubeVideo).videoId)}`;
  return null;
}

async function loadExistingExclusions(
  client: GoogleAdsClient,
  customerId: string,
  campaignIds: string[]
): Promise<ExistingExclusions> {
  const existing: ExistingExclusions = {
    account: new Set(),
    byCampaign: new Map(),
    labels: { account: new Set(), campaigns: new Map() },
  };
  const accountRows = await client.searchStream(customerId,
    `SELECT customer_negative_criterion.type, customer_negative_criterion.placement.url,
            customer_negative_criterion.mobile_application.app_id,
            customer_negative_criterion.youtube_channel.channel_id,
            customer_negative_criterion.youtube_video.video_id,
            customer_negative_criterion.content_label.type
     FROM customer_negative_criterion
     WHERE customer_negative_criterion.type IN (${EXCLUDABLE_CRITERIA})`);
  for (const row of accountRows) {
    const criterion = asRow(row.customerNegativeCriterion);
    if (str(criterion.type) === "CONTENT_LABEL") {
      existing.labels.account.add(str(asRow(criterion.contentLabel).type));
      continue;
    }
    const key = exclusionKey(criterion);
    if (key) existing.account.add(key);
  }
  const ids = campaignIds.filter((id) => NUMERIC_ID.test(id));
  if (ids.length === 0) return existing;
  // campaign é recurso ATRIBUÍDO de campaign_criterion: pode filtrar sem estar no SELECT
  const campaignRows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign_criterion.type, campaign_criterion.placement.url,
            campaign_criterion.mobile_application.app_id,
            campaign_criterion.youtube_channel.channel_id,
            campaign_criterion.youtube_video.video_id,
            campaign_criterion.content_label.type
     FROM campaign_criterion
     WHERE campaign_criterion.negative = TRUE
       AND campaign_criterion.status != 'REMOVED'
       AND campaign_criterion.type IN (${EXCLUDABLE_CRITERIA})
       AND campaign.id IN (${ids.join(", ")})`);
  for (const row of campaignRows) {
    const campaignId = str(asRow(row.campaign).id);
    const criterion = asRow(row.campaignCriterion);
    if (str(criterion.type) === "CONTENT_LABEL") {
      const label = str(asRow(criterion.contentLabel).type);
      existing.labels.campaigns.set(label, [...(existing.labels.campaigns.get(label) ?? []), campaignId]);
      continue;
    }
    const key = exclusionKey(criterion);
    if (!key) continue;
    if (!existing.byCampaign.has(campaignId)) existing.byCampaign.set(campaignId, new Set());
    existing.byCampaign.get(campaignId)!.add(key);
  }
  return existing;
}

/**
 * Já excluído? Exclusão de DOMÍNIO (sem caminho) cobre o domínio, os subdomínios e as páginas
 * deles. Exclusão de PÁGINA/seção (com caminho) só cobre exatamente a mesma URL — ela não
 * bloqueia o resto do domínio. App, canal e vídeo casam pelo ID exato.
 */
function alreadyExcluded(item: ExclusionItem, campaignIds: string[], existing: ExistingExclusions): string | null {
  const candidate = item.type === "WEBSITE" ? siteKey(item.value) : null;
  const candidateHost = candidate?.split(/[/?]/)[0] ?? "";
  const covers = (keys: Set<string> | undefined) => {
    if (!keys) return false;
    if (item.type !== "WEBSITE") return keys.has(`${item.type}|${item.value}`);
    if (!candidate) return false;
    for (const key of keys) {
      if (!key.startsWith("WEBSITE|")) continue;
      const excluded = key.slice("WEBSITE|".length);
      const domainOnly = !/[/?]/.test(excluded);
      if (domainOnly) {
        if (candidateHost === excluded || candidateHost.endsWith(`.${excluded}`)) return true;
      } else if (candidate === excluded) {
        return true;
      }
    }
    return false;
  };
  if (covers(existing.account)) return "conta";
  const inCampaigns = campaignIds.filter((id) => covers(existing.byCampaign.get(id)));
  if (inCampaigns.length && inCampaigns.length === campaignIds.length) return "campanha";
  if (inCampaigns.length) return `campanha (${inCampaigns.length} de ${campaignIds.length})`;
  return null;
}

// ── Landing pages ────────────────────────────────────────────────────

const DEVICES = ["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV", "OTHER"] as const;

/** Normaliza URL para cruzar landing page × anúncio: sem protocolo, www, query, fragmento e barra final. */
function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split("#")[0]
    .split("?")[0]
    .replace(/\/+$/, "");
}

/** mobile_friendly/AMP vêm como fração (0–1); valores > 1 são tratados como já em %. */
const fractionToPct = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round2(n > 1 ? n : n * 100);
};

interface DestinationIssue {
  campaign_id: string;
  campaign: string;
  ad_group_id: string;
  ad_id: string;
  approval_status: string;
  final_urls: string[];
  evidence: Array<Record<string, unknown>>;
  urls: Set<string>;
}

async function loadDestinationNotWorking(
  client: GoogleAdsClient,
  customerId: string,
  campaignId: string | undefined
): Promise<DestinationIssue[]> {
  // policy_topic_entries é repetido (não filtrável): filtra pelo status e procura o tópico no código
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls,
            ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.policy_topic_entries
     FROM ad_group_ad
     WHERE ad_group_ad.status != 'REMOVED'
       AND campaign.status != 'REMOVED'
       AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')
       ${campaignId ? `AND campaign.id = ${campaignId}` : ""}`);
  const issues: DestinationIssue[] = [];
  for (const row of rows) {
    const adGroupAd = asRow(row.adGroupAd);
    const ad = asRow(adGroupAd.ad);
    const policy = asRow(adGroupAd.policySummary);
    const entries = ensureArray<unknown>(policy.policyTopicEntries).map(asRow);
    const notWorking = entries.filter((entry) => str(entry.topic) === "DESTINATION_NOT_WORKING");
    if (notWorking.length === 0) continue;
    const finalUrls = ensureArray<unknown>(ad.finalUrls).map(str).filter(Boolean);
    const evidence = notWorking.flatMap((entry) =>
      ensureArray<unknown>(entry.evidences)
        .map((ev) => asRow(asRow(ev).destinationNotWorking))
        .filter((d) => Object.keys(d).length > 0)
        .map((d) => ({
          url: d.expandedUrl,
          device: d.device,
          last_checked: d.lastCheckedDateTime,
          ...(d.dnsErrorType !== undefined ? { dns_error: d.dnsErrorType } : {}),
          ...(d.httpErrorCode !== undefined ? { http_error_code: d.httpErrorCode } : {}),
        }))
    );
    const urls = new Set([...finalUrls, ...evidence.map((e) => str(e.url)).filter(Boolean)].map(normalizeUrl));
    issues.push({
      campaign_id: str(asRow(row.campaign).id),
      campaign: str(asRow(row.campaign).name),
      ad_group_id: str(asRow(row.adGroup).id),
      ad_id: str(ad.id),
      approval_status: str(policy.approvalStatus),
      final_urls: finalUrls,
      evidence,
      urls,
    });
  }
  return issues;
}

// ── Redes ────────────────────────────────────────────────────────────

/** AdNetworkTypeEnum v25. */
const NETWORK_LABELS: Record<string, string> = {
  SEARCH: "Google Search",
  SEARCH_PARTNERS: "Parceiros de pesquisa",
  CONTENT: "Rede de Display",
  YOUTUBE: "YouTube",
  GOOGLE_TV: "Google TV",
  MIXED: "Várias redes (cross-network)",
  GOOGLE_OWNED_CHANNELS: "Canais do Google (histórico)",
  GMAIL: "Gmail",
  DISCOVER: "Discover",
  MAPS: "Maps",
  UNKNOWN: "Desconhecida",
};

/** AdvertisingChannelTypeEnum v25 (os tipos que servem anúncio e têm métrica por rede). */
const CHANNEL_TYPES = [
  "SEARCH", "DISPLAY", "SHOPPING", "VIDEO", "PERFORMANCE_MAX", "DEMAND_GEN", "MULTI_CHANNEL", "HOTEL", "LOCAL", "SMART", "TRAVEL",
] as const;

/** Rede pior que o Google Search quando o CPA passa disto (1,5 = 50% acima). */
const WORSE_CPA_FACTOR = 1.5;
/** ... ou quando o ROAS fica abaixo desta fração do ROAS do Google Search. */
const WORSE_ROAS_FACTOR = 2 / 3;

// ── MCC ──────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const parseIsoUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoFromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Período concreto (datas) com a mesma semântica de buildDateClause: days = N dias
 * terminando ontem (como DURING LAST_N_DAYS). Usa a data local do servidor.
 */
function resolvePeriod(dateRange: DateRange, days: number | undefined): { since: string; until: string; days: number } {
  if (dateRange && (dateRange.since || dateRange.until)) {
    const { since, until } = dateRange;
    if (!since || !until || !ISO_DATE.test(since) || !ISO_DATE.test(until)) {
      throw new Error(`dateRange inválido — use since e until em YYYY-MM-DD (recebido ${since} → ${until}).`);
    }
    const a = parseIsoUtc(since);
    const b = parseIsoUtc(until);
    if (isoFromUtc(a) !== since || isoFromUtc(b) !== until) throw new Error(`dateRange com data inexistente: ${since} → ${until}.`);
    if (a > b) throw new Error(`dateRange invertido: since (${since}) é depois de until (${until}).`);
    return { since, until, days: Math.round((b - a) / DAY_MS) + 1 };
  }
  const n = days ?? 30;
  if (!Number.isInteger(n) || n < 1) throw new Error(`days inválido: ${days}. Use um inteiro positivo.`);
  const today = parseIsoUtc(localIsoDate(new Date()));
  return { since: isoFromUtc(today - n * DAY_MS), until: isoFromUtc(today - DAY_MS), days: n };
}

function previousPeriod(period: { since: string; days: number }): { since: string; until: string } {
  const until = parseIsoUtc(period.since) - DAY_MS;
  return { since: isoFromUtc(until - (period.days - 1) * DAY_MS), until: isoFromUtc(until) };
}

/** Roda fn sobre os itens com no máximo `limit` chamadas simultâneas (cota da API). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const MCC_CONCURRENCY = 5;
/** Limites dos alertas da visão do MCC. */
const MCC_CPA_UP_PCT = 30;
const MCC_ROAS_DOWN_PCT = -30;
const MCC_SPEND_SWING_PCT = 50;

// ── Registro ─────────────────────────────────────────────────────────

export function registerReportsTools(ctx: ToolContext): void {
  // ── Posicionamentos ("onde os anúncios apareceram") ────────────────

  ctx.mcp.registerTool(
    "get_placement_report",
    {
      description: [
        "Relatório de posicionamentos: onde os anúncios de Display, Vídeo, Demand Gen e PMax apareceram. READ OPERATION.",
        "",
        "view:",
        "- GROUP (default): 'Onde os anúncios foram exibidos' por domínio, app ou canal do YouTube (group_placement_view).",
        "- DETAIL: por URL específica ou vídeo do YouTube (detail_placement_view).",
        "- MANAGED: posicionamentos que VOCÊ segmentou (critérios de posicionamento), com desempenho (managed_placement_view).",
        "- PMAX: onde a Performance Max apareceu (performance_max_placement_view) — a API só dá IMPRESSÕES",
        "  por posicionamento de PMax (sem custo, cliques ou conversões).",
        "",
        "Linha 'Other' (Total: Other): a API agrega os posicionamentos de baixo tráfego numa linha 'Other'. Ela sai",
        "separada em other_row, não pode ser excluída e faz a soma das linhas não bater com o total da campanha.",
        "",
        "Candidatos a exclusão (heurísticos — confira antes): app/site/canal com gasto >= candidateMinSpend e zero",
        "conversão; CTR anômalo (>= 3x a média do relatório) sem conversão; nome com cara de conteúdo infantil",
        "(YouTube/app — a API não marca 'feito para crianças'). Cada candidato traz exclusion {type, value} no formato",
        "de exclude_placements; exclusion_items é a lista pronta (sem os já excluídos na conta). Em view=DETAIL o site",
        "sai como a própria página (domínio/caminho, até 2 níveis — limite da API); o domínio inteiro vem à parte, em",
        "domain_exclusion, com aviso. Exclusão de página já existente não conta como domínio excluído. Também informa se a",
        "conta já exclui os rótulos PARKED_DOMAIN e BRAND_SUITABILITY_CONTENT_FOR_FAMILIES (set_content_exclusions).",
        "",
        "groupBy: PLACEMENT (default, soma entre campanhas/grupos), CAMPAIGN ou AD_GROUP. minImpressions/minSpend",
        "filtram depois de agregar. Valores em moeda da conta (não micros).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta cliente, não MCC)."),
        view: z.enum(PLACEMENT_VIEWS).optional().describe("GROUP (default), DETAIL, MANAGED ou PMAX."),
        campaignId: z.string().optional().describe("Filtra por campanha (ID numérico)."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (não vale para PMAX)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        placementType: z
          .enum(PLACEMENT_TYPES)
          .optional()
          .describe("Filtra pelo tipo. PMAX só tem WEBSITE, MOBILE_APPLICATION e YOUTUBE_VIDEO; MANAGED não tem GOOGLE_PRODUCTS."),
        groupBy: z.enum(["PLACEMENT", "CAMPAIGN", "AD_GROUP"]).optional().describe("Default: PLACEMENT."),
        byNetwork: z.boolean().optional().describe("true = separa por rede (segments.ad_network_type: CONTENT, YOUTUBE...)."),
        minImpressions: z.number().optional().describe("Só posicionamentos com pelo menos N impressões (após agregar)."),
        minSpend: z.number().optional().describe("Só posicionamentos com gasto >= X na moeda da conta (não existe em PMAX)."),
        candidateMinSpend: z
          .number()
          .optional()
          .describe("Gasto mínimo (moeda da conta) para 'gasto sem conversão' virar candidato a exclusão. Default: 10."),
        sortBy: z
          .enum(["cost", "impressions", "clicks", "conversions", "ctr"])
          .optional()
          .describe("Ordenação. Default: cost (PMAX: impressions — é a única métrica)."),
        limit: z.number().optional().describe("Máx. de linhas listadas (candidatos consideram todas). Default: 100, máx. 1000."),
        format: formatSchema,
      },
    },
    async ({
      customerId, view: viewArg, campaignId, adGroupId, dateRange, days, placementType, groupBy, byNetwork,
      minImpressions, minSpend, candidateMinSpend, sortBy, limit, format,
    }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const reportView: PlacementView = viewArg ?? "GROUP";
      const grouping = groupBy ?? "PLACEMENT";
      const badId = invalidId({ campaignId, adGroupId });
      if (badId) return fail(badId);
      const badNumber = invalidNonNegative({ minImpressions, minSpend, candidateMinSpend });
      if (badNumber) return fail(badNumber);
      if (reportView === "PMAX") {
        const problems = [
          adGroupId !== undefined && "adGroupId (PMax não tem grupos de anúncios)",
          minSpend !== undefined && "minSpend (PMax só reporta impressões por posicionamento)",
          sortBy !== undefined && sortBy !== "impressions" && `sortBy=${sortBy} (PMax só reporta impressões)`,
          grouping === "AD_GROUP" && "groupBy=AD_GROUP (PMax não tem grupos de anúncios)",
          placementType !== undefined && !PMAX_PLACEMENT_TYPES.has(placementType) &&
            `placementType=${placementType} (em PMax só existem ${[...PMAX_PLACEMENT_TYPES].join(", ")})`,
        ].filter(Boolean);
        if (problems.length) return fail(`view=PMAX não aceita: ${problems.join("; ")}. Nada foi consultado.`);
      }
      if (reportView === "MANAGED" && placementType !== undefined && !MANAGED_CRITERION_TYPE[placementType]) {
        return fail(`view=MANAGED não tem ${placementType}: não existe critério gerenciado desse tipo. Nada foi consultado.`);
      }
      let dateClause: string;
      try {
        dateClause = dateClauseFor(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const maxRows = clampLimit(limit, 100, 1000);
      const minCandidateMicros = (candidateMinSpend ?? 10) * 1_000_000;

      // ── Consulta ──
      const select: string[] = [];
      const where = [dateClause, "metrics.impressions > 0"];
      let resource: string;
      if (reportView === "MANAGED") {
        resource = "managed_placement_view";
        select.push(
          "ad_group_criterion.criterion_id", "ad_group_criterion.type", "ad_group_criterion.status",
          "ad_group_criterion.display_name", "ad_group_criterion.placement.url",
          "ad_group_criterion.mobile_application.app_id", "ad_group_criterion.mobile_application.name",
          "ad_group_criterion.youtube_channel.channel_id", "ad_group_criterion.youtube_video.video_id",
          "ad_group_criterion.mobile_app_category.mobile_app_category_constant"
        );
        if (placementType) where.push(`ad_group_criterion.type = '${MANAGED_CRITERION_TYPE[placementType]}'`);
      } else {
        const spec = AUTO_VIEWS[reportView];
        resource = spec.resource;
        select.push(...spec.fields.map((field) => `${spec.resource}.${field}`));
        if (placementType) where.push(`${spec.resource}.placement_type = '${placementType}'`);
      }
      // PMax: campaign é recurso de SEGMENTAÇÃO — campaign.id no WHERE exige estar no SELECT (está sempre)
      if (reportView === "PMAX") select.push("campaign.id", "campaign.name");
      else select.push("campaign.id", "campaign.name", "campaign.advertising_channel_type", "ad_group.id", "ad_group.name");
      if (byNetwork) select.push("segments.ad_network_type");
      select.push(...(reportView === "PMAX" ? ["metrics.impressions"] : PLACEMENT_METRICS.map((m) => `metrics.${m}`)));
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      if (adGroupId) where.push(`ad_group.id = ${adGroupId}`);
      const orderBy = reportView === "PMAX" ? "metrics.impressions DESC" : "metrics.cost_micros DESC";
      const query = `SELECT ${select.join(", ")} FROM ${resource} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ${MAX_PLACEMENT_ROWS}`;

      const client = ctx.getClient();
      let results: Row[];
      try {
        results = await client.searchStream(customerId, query);
      } catch (err) {
        return fail(`Erro: ${explainReportError((err as Error).message, customerId)}`);
      }

      // ── Agregação ──
      const lines = new Map<string, PlacementLine>();
      const other = emptyReportTotals();
      let otherRows = 0;
      for (const row of results) {
        const campaign = asRow(row.campaign);
        const adGroup = asRow(row.adGroup);
        const network = byNetwork ? str(asRow(row.segments).adNetworkType) || "UNKNOWN" : undefined;
        let base: Omit<PlacementLine, "campaignIds" | "totals">;
        if (reportView === "MANAGED") {
          const criterion = asRow(row.adGroupCriterion);
          const criterionType = str(criterion.type);
          const value =
            criterionType === "PLACEMENT" ? str(asRow(criterion.placement).url)
            : criterionType === "MOBILE_APPLICATION" ? str(asRow(criterion.mobileApplication).appId)
            : criterionType === "YOUTUBE_CHANNEL" ? str(asRow(criterion.youtubeChannel).channelId)
            : criterionType === "YOUTUBE_VIDEO" ? str(asRow(criterion.youtubeVideo).videoId)
            : criterionType === "MOBILE_APP_CATEGORY" ? str(asRow(criterion.mobileAppCategory).mobileAppCategoryConstant)
            : "";
          base = {
            placement: value || str(criterion.displayName),
            display_name: str(criterion.displayName) || str(asRow(criterion.mobileApplication).name),
            placement_type: CRITERION_TO_PLACEMENT_TYPE[criterionType] ?? criterionType,
            target_url: "",
            criterion_id: str(criterion.criterionId),
            criterion_status: str(criterion.status),
          };
        } else {
          const placementView = asRow(row[AUTO_VIEWS[reportView].key]);
          base = {
            placement: str(placementView.placement),
            display_name: str(placementView.displayName),
            placement_type: str(placementView.placementType),
            target_url: str(placementView.targetUrl),
            ...(reportView === "DETAIL" ? { group_target_url: str(placementView.groupPlacementTargetUrl) } : {}),
          };
          if (isOtherRow(base.placement)) {
            addReportMetrics(other, row.metrics);
            otherRows++;
            continue;
          }
        }
        const campaignKey = str(campaign.id);
        const keyParts = [base.placement_type, base.placement, network ?? ""];
        if (grouping === "CAMPAIGN") keyParts.push(`c${campaignKey}`);
        if (grouping === "AD_GROUP") keyParts.push(`g${str(adGroup.id)}`);
        const key = keyParts.join("|");
        let line = lines.get(key);
        if (!line) {
          line = {
            ...base,
            ...(network ? { network } : {}),
            ...(grouping !== "PLACEMENT"
              ? { campaign_id: campaignKey, campaign: str(campaign.name), channel: str(campaign.advertisingChannelType) || undefined }
              : {}),
            ...(grouping === "AD_GROUP" ? { ad_group_id: str(adGroup.id), ad_group: str(adGroup.name) } : {}),
            campaignIds: new Set(),
            totals: emptyReportTotals(),
          };
          lines.set(key, line);
        }
        if (campaignKey) line.campaignIds.add(campaignKey);
        addReportMetrics(line.totals, row.metrics);
      }

      const allLines = [...lines.values()];
      const reportTotals = sumTotals(allLines.map((line) => line.totals));
      const avgCtr = reportTotals.impressions ? reportTotals.clicks / reportTotals.impressions : 0;
      const kept = allLines.filter(
        (line) =>
          line.totals.impressions >= (minImpressions ?? 0) &&
          (minSpend === undefined || line.totals.costMicros >= minSpend * 1_000_000)
      );

      // ── Candidatos ──
      const isPmax = reportView === "PMAX";
      const candidates: Array<{ line: PlacementLine; suggestion: ExclusionSuggestion; reasons: string[] }> = [];
      for (const line of kept) {
        const t = line.totals;
        const reasons: string[] = [];
        const kidsCheck =
          ["YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APPLICATION"].includes(line.placement_type) &&
          KIDS_CONTENT.test(`${line.display_name} ${line.placement}`);
        if (kidsCheck) {
          reasons.push("possível conteúdo infantil pelo nome (heurística — a API não marca 'feito para crianças')");
        }
        if (!isPmax && t.costMicros >= minCandidateMicros && t.conversions === 0) {
          const spend = round2(t.costMicros / 1_000_000);
          const what =
            reportView === "MANAGED" ? "posicionamento que você segmentou"
            : line.placement_type === "MOBILE_APPLICATION" ? "app"
            : line.placement_type === "WEBSITE"
              ? reportView === "DETAIL"
                ? "página"
                : "site (confira se é domínio estacionado ou feito só para anúncios)"
            : line.placement_type.startsWith("YOUTUBE") ? "YouTube"
            : "posicionamento";
          reasons.push(
            `${what}: gastou ${spend} (moeda da conta) sem conversão` +
              (t.viewThroughConversions ? ` (teve ${t.viewThroughConversions} conversão(ões) view-through)` : "")
          );
        }
        if (!isPmax && t.clicks >= 10 && t.conversions === 0 && avgCtr > 0 && t.clicks / t.impressions >= avgCtr * 3) {
          reasons.push(
            `CTR ${pct(t.clicks, t.impressions)}% (>= 3x a média de ${round2(avgCtr * 100)}%) sem conversão — ` +
              "padrão de clique acidental ou tráfego inválido"
          );
        }
        if (reasons.length === 0) continue;
        const suggestion: ExclusionSuggestion =
          reportView === "MANAGED" ? { exclusion: null } : exclusionFor(reportView, line.placement_type, line.placement, line.target_url);
        candidates.push({ line, suggestion, reasons });
      }

      // Já excluídos? Só consulta quando há o que sugerir; falha aqui vira aviso, não erro do relatório.
      const warnings: string[] = [];
      let existing: ExistingExclusions | null = null;
      if (reportView !== "MANAGED" && candidates.some((c) => c.suggestion.exclusion || c.suggestion.domain)) {
        const candidateCampaigns = [...new Set(candidates.flatMap((c) => [...c.line.campaignIds]))];
        try {
          existing = await loadExistingExclusions(client, customerId, candidateCampaigns);
        } catch (err) {
          warnings.push(`Não deu para conferir as exclusões atuais: ${(err as Error).message}`);
        }
      }

      const candidateRows = candidates
        .map(({ line, suggestion, reasons }) => {
          const { exclusion, domain, note } = suggestion;
          // Página sem exclusão possível (URL funda demais) ainda pode estar coberta pelo domínio já excluído
          const checked = exclusion ?? domain;
          const excludedAt = checked && existing ? alreadyExcluded(checked, [...line.campaignIds], existing) : null;
          const fullyExcluded = excludedAt !== null && !excludedAt.startsWith("campanha (");
          return {
            placement: line.placement,
            display_name: line.display_name,
            placement_type: line.placement_type,
            ...(line.campaign ? { campaign_id: line.campaign_id, campaign: line.campaign } : {}),
            ...(line.ad_group ? { ad_group_id: line.ad_group_id, ad_group: line.ad_group } : {}),
            campaign_ids: [...line.campaignIds],
            spend: round2(line.totals.costMicros / 1_000_000),
            impressions: line.totals.impressions,
            clicks: line.totals.clicks,
            conversions: round2(line.totals.conversions),
            reasons,
            suggested_action:
              reportView === "MANAGED" ? "revisar o critério (remover ou baixar o lance) — ele é segmentação sua, não exclusão"
              : excludedAt ? `já excluído (${excludedAt})`
              : exclusion ? "excluir (exclude_placements)"
              : note ? `revisar manualmente — ${note}`
              : "revisar manualmente — sem ID reconhecível para exclusão",
            exclusion,
            ...(note ? { exclusion_note: note } : {}),
            already_excluded: excludedAt,
            // Alternativa mais ampla, separada e com aviso: nunca entra em exclusion_items
            ...(domain && !fullyExcluded
              ? {
                  domain_exclusion: domain,
                  domain_exclusion_warning:
                    `bloqueia o domínio INTEIRO (${domain.value}), não só esta página — use só se o site todo for o ` +
                    "problema; não está em exclusion_items",
                }
              : {}),
            costMicros: line.totals.costMicros,
          };
        })
        .sort((a, b) => b.costMicros - a.costMicros || b.impressions - a.impressions)
        .map(({ costMicros: _cost, ...row }) => row);

      const exclusionItems: ExclusionItem[] = [];
      const seenItems = new Set<string>();
      for (const candidate of candidateRows) {
        if (!candidate.exclusion || (candidate.already_excluded && !candidate.already_excluded.startsWith("campanha ("))) continue;
        const id = `${candidate.exclusion.type}|${candidate.exclusion.value}`;
        if (seenItems.has(id)) continue;
        seenItems.add(id);
        exclusionItems.push(candidate.exclusion);
      }

      // ── Linhas listadas ──
      const sortKey = sortBy ?? (isPmax ? "impressions" : "cost");
      const metricOf = (line: PlacementLine) => {
        const t = line.totals;
        if (sortKey === "impressions") return t.impressions;
        if (sortKey === "clicks") return t.clicks;
        if (sortKey === "conversions") return t.conversions;
        if (sortKey === "ctr") return t.impressions ? t.clicks / t.impressions : 0;
        return t.costMicros;
      };
      const candidateKeys = new Set(candidates.map((c) => c.line));
      const pmaxImpressions = reportTotals.impressions + other.impressions;
      const rows = kept
        .sort((a, b) => metricOf(b) - metricOf(a) || b.totals.impressions - a.totals.impressions)
        .slice(0, maxRows)
        .map((line) => {
          const identity = {
            placement: line.placement,
            display_name: line.display_name,
            placement_type: line.placement_type,
            ...(line.target_url ? { target_url: line.target_url } : {}),
            ...(line.group_target_url ? { group_target_url: line.group_target_url } : {}),
            ...(line.network ? { network: line.network } : {}),
            ...(line.campaign !== undefined ? { campaign_id: line.campaign_id, campaign: line.campaign, channel: line.channel } : {}),
            ...(line.ad_group !== undefined ? { ad_group_id: line.ad_group_id, ad_group: line.ad_group } : {}),
            ...(line.criterion_id ? { criterion_id: line.criterion_id, criterion_status: line.criterion_status } : {}),
            ...(grouping === "PLACEMENT" ? { campaigns: line.campaignIds.size } : {}),
          };
          if (isPmax) {
            return {
              ...identity,
              impressions: line.totals.impressions,
              impressions_share_pct: pct(line.totals.impressions, pmaxImpressions),
              candidate: candidateKeys.has(line),
            };
          }
          return {
            ...identity,
            ...view(line.totals),
            view_through_conversions: line.totals.viewThroughConversions,
            video_views: line.totals.videoViews,
            candidate: candidateKeys.has(line),
          };
        });

      // ── Rótulos de conteúdo ──
      let contentExclusions: Row | undefined;
      if (existing) {
        contentExclusions = Object.fromEntries(
          RELEVANT_LABELS.map((label) => [
            label,
            {
              account: existing!.labels.account.has(label),
              campaigns: existing!.labels.campaigns.get(label) ?? [],
            },
          ])
        );
      }

      const notes: string[] = [];
      if (otherRows > 0) {
        notes.push(
          "other_row: a API agrega posicionamentos de baixo tráfego numa linha 'Other' (Total: Other). Ela não é um " +
            "posicionamento real, não pode ser excluída e explica por que a soma das linhas fica abaixo do total da campanha."
        );
      }
      if (isPmax) {
        notes.push("PMax: a API só dá impressões por posicionamento — não há custo, cliques nem conversões para julgar desempenho.");
      }
      if (reportView === "MANAGED") {
        notes.push("MANAGED lista a sua segmentação: para cortar um posicionamento gerenciado, remova o critério em vez de excluí-lo.");
      }
      if (exclusionItems.length) {
        notes.push(
          "Para excluir: exclude_placements com items = exclusion_items (level ACCOUNT, CAMPAIGN ou AD_GROUP). Os " +
            "candidatos são heurísticos — confira antes, principalmente sites e canais com conversão view-through."
        );
      }
      if (candidateRows.some((c) => "domain_exclusion" in c)) {
        notes.push(
          "DETAIL: sites saem como PÁGINA (domínio/caminho) — exclusion_items bloqueia só aquela página. " +
            "domain_exclusion é a alternativa que bloqueia o domínio inteiro; fica fora de exclusion_items e só vale " +
            "quando o site todo é o problema (confira em view=GROUP)."
        );
      }
      if (contentExclusions) {
        const missing = RELEVANT_LABELS.filter((label) => !existing!.labels.account.has(label));
        if (missing.length) {
          notes.push(
            `Rótulos de conteúdo não excluídos na conta: ${missing.join(", ")}. PARKED_DOMAIN corta domínios ` +
              "estacionados e BRAND_SUITABILITY_CONTENT_FOR_FAMILIES corta conteúdo para famílias, incluindo vídeos " +
              "'feitos para crianças' do YouTube — os dois em bloco, via set_content_exclusions."
          );
        }
      }
      if (results.length >= MAX_PLACEMENT_ROWS) {
        notes.push(`A consulta atingiu o teto de ${MAX_PLACEMENT_ROWS} linhas: filtre por campanha, tipo ou período.`);
      }

      const header =
        `${allLines.length} posicionamento(s) — view ${reportView}, ${periodLabel(dateRange, days)}` +
        `${kept.length !== allLines.length ? `, ${kept.length} após os filtros` : ""}; ${rows.length} listado(s). ` +
        `${candidateRows.length} candidato(s) a exclusão/revisão.` +
        (warnings.length ? `\nAviso: ${warnings.join(" ")}` : "") +
        (notes.length ? `\n- ${notes.join("\n- ")}` : "");
      const tableRows = rows.map((row) => ({
        ...row,
        candidate: row.candidate ? "sim" : "",
      }));
      return render(format, tableRows, header, {
        view: reportView,
        period: periodLabel(dateRange, days),
        group_by: grouping,
        totals: isPmax ? { impressions: reportTotals.impressions } : { ...view(reportTotals), view_through_conversions: reportTotals.viewThroughConversions },
        ...(otherRows > 0
          ? { other_row: isPmax ? { impressions: other.impressions } : { ...view(other), view_through_conversions: other.viewThroughConversions } }
          : {}),
        rows,
        candidates: candidateRows,
        exclusion_items: exclusionItems,
        ...(contentExclusions ? { content_exclusions: contentExclusions } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    }
  );

  // ── Landing pages ──────────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_landing_page_performance",
    {
      description: [
        "Desempenho por landing page (URL final definida pelo anunciante, landing_page_view). READ OPERATION.",
        "Traz cliques, gasto, conversões, taxa de conversão, CPA, ROAS, speed_score (1–10, velocidade da página após",
        "clique em anúncio mobile; 10 = mais rápida) e % de cliques mobile em página mobile-friendly / AMP válida.",
        "",
        "Sinaliza: speed_score abaixo de minSpeedScore; taxa de conversão abaixo da metade da média do relatório;",
        "cliques sem conversão; poucos cliques mobile-friendly; e cruza com anúncios reprovados/limitados por",
        "DESTINATION_NOT_WORKING (URL fora do ar) — que saem também em destination_not_working, porque anúncio",
        "reprovado não gera clique e a URL pode nem aparecer nas linhas. Detalhe de políticas: list_policy_issues.",
        "",
        "Não inclui a URL expandida do AI Max (expanded_landing_page_view): para isso, get_ai_max_report view=landing_pages.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta cliente)."),
        campaignId: z.string().optional().describe("Filtra por campanha (ID numérico)."),
        byCampaign: z.boolean().optional().describe("true = uma linha por URL × campanha. Default: por URL."),
        device: z.enum(DEVICES).optional().describe("Filtra por dispositivo."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        minClicks: z.number().optional().describe("Cliques mínimos para julgar conversão/mobile-friendly. Default: 30."),
        minSpeedScore: z.number().optional().describe("speed_score abaixo disto é sinalizado (1–10). Default: 5."),
        checkPolicy: z.boolean().optional().describe("Cruza com DESTINATION_NOT_WORKING dos anúncios. Default: true."),
        sortBy: z.enum(["cost", "clicks", "conversions", "conv_rate", "speed_score"]).optional().describe("Default: cost."),
        limit: z.number().optional().describe("Máx. de URLs listadas. Default: 50, máx. 1000."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, byCampaign, device, dateRange, days, minClicks, minSpeedScore, checkPolicy, sortBy, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badId = invalidId({ campaignId });
      if (badId) return fail(badId);
      const badNumber = invalidNonNegative({ minClicks, minSpeedScore });
      if (badNumber) return fail(badNumber);
      if (minSpeedScore !== undefined && minSpeedScore > 10) return fail(`minSpeedScore vai de 1 a 10, recebido ${minSpeedScore}.`);
      let dateClause: string;
      try {
        dateClause = dateClauseFor(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const clicksFloor = minClicks ?? 30;
      const speedFloor = minSpeedScore ?? 5;
      const maxRows = clampLimit(limit, 50, 1000);
      const withCampaign = Boolean(campaignId) || byCampaign === true;

      // campaign e segments.device segmentam landing_page_view: no WHERE, só se estiverem no SELECT
      const select = ["landing_page_view.unexpanded_final_url"];
      if (withCampaign) select.push("campaign.id", "campaign.name");
      if (device) select.push("segments.device");
      select.push(
        "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value",
        "metrics.speed_score", "metrics.mobile_friendly_clicks_percentage",
        "metrics.valid_accelerated_mobile_pages_clicks_percentage"
      );
      const where = [dateClause, "metrics.clicks > 0"];
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      if (device) where.push(`segments.device = '${device}'`);
      const query = `SELECT ${select.join(", ")} FROM landing_page_view WHERE ${where.join(" AND ")} ORDER BY metrics.cost_micros DESC LIMIT 10000`;

      const client = ctx.getClient();
      let results: Row[];
      let issues: DestinationIssue[] = [];
      const warnings: string[] = [];
      try {
        results = await client.searchStream(customerId, query);
      } catch (err) {
        return fail(`Erro: ${explainReportError((err as Error).message, customerId)}`);
      }
      if (checkPolicy !== false) {
        try {
          issues = await loadDestinationNotWorking(client, customerId, campaignId);
        } catch (err) {
          warnings.push(`Não deu para cruzar com as políticas dos anúncios: ${(err as Error).message}`);
        }
      }

      const pages = results.map((row) => {
        const metrics = asRow(row.metrics);
        const totals = addReportMetrics(emptyReportTotals(), metrics);
        const speed = num(metrics.speedScore);
        const campaign = asRow(row.campaign);
        return {
          url: str(asRow(row.landingPageView).unexpandedFinalUrl),
          campaign_id: withCampaign ? str(campaign.id) : undefined,
          campaign: withCampaign ? str(campaign.name) : undefined,
          totals,
          speed_score: speed > 0 ? speed : null,
          mobile_friendly_clicks_pct: fractionToPct(metrics.mobileFriendlyClicksPercentage),
          valid_amp_clicks_pct: fractionToPct(metrics.validAcceleratedMobilePagesClicksPercentage),
        };
      });
      const total = sumTotals(pages.map((page) => page.totals));
      const avgConvRate = total.clicks ? total.conversions / total.clicks : 0;
      const matchedIssues = new Set<DestinationIssue>();

      const flagged = pages.map((page) => {
        const t = page.totals;
        const flags: string[] = [];
        if (page.speed_score !== null && page.speed_score < speedFloor) {
          flags.push(`speed_score ${page.speed_score}/10 — página lenta no mobile`);
        }
        if (t.clicks >= clicksFloor && total.conversions > 0) {
          if (t.conversions === 0) flags.push(`${t.clicks} cliques e nenhuma conversão`);
          else if (t.conversions / t.clicks < avgConvRate * 0.5) {
            flags.push(`taxa de conversão ${pct(t.conversions, t.clicks)}% — menos da metade da média (${round2(avgConvRate * 100)}%)`);
          }
        }
        if (page.mobile_friendly_clicks_pct !== null && page.mobile_friendly_clicks_pct < 80 && t.clicks >= clicksFloor) {
          flags.push(`só ${page.mobile_friendly_clicks_pct}% dos cliques mobile caem em página mobile-friendly`);
        }
        const normalized = normalizeUrl(page.url);
        const pageIssues = issues.filter(
          (issue) => issue.urls.has(normalized) && (!page.campaign_id || issue.campaign_id === page.campaign_id)
        );
        pageIssues.forEach((issue) => matchedIssues.add(issue));
        if (pageIssues.length) {
          flags.push(`DESTINATION_NOT_WORKING em ${pageIssues.length} anúncio(s) — URL fora do ar para o Google`);
        }
        return { page, flags };
      });

      const sortKey = sortBy ?? "cost";
      const sortValue = ({ page }: { page: (typeof pages)[number] }) => {
        const t = page.totals;
        if (sortKey === "clicks") return t.clicks;
        if (sortKey === "conversions") return t.conversions;
        if (sortKey === "conv_rate") return t.clicks ? t.conversions / t.clicks : 0;
        if (sortKey === "speed_score") return -(page.speed_score ?? 11); // mais lenta primeiro
        return t.costMicros;
      };
      const rows = flagged
        .sort((a, b) => sortValue(b) - sortValue(a))
        .slice(0, maxRows)
        .map(({ page, flags }) => ({
          url: page.url,
          ...(withCampaign ? { campaign_id: page.campaign_id, campaign: page.campaign } : {}),
          ...(device ? { device } : {}),
          ...view(page.totals),
          speed_score: page.speed_score,
          mobile_friendly_clicks_pct: page.mobile_friendly_clicks_pct,
          valid_amp_clicks_pct: page.valid_amp_clicks_pct,
          flags,
        }));

      // in_report=false: a URL não teve clique no período (anúncio reprovado não gera clique)
      const destinationIssues = issues.map((issue) => {
        const { urls: _urls, ...rest } = issue;
        return { ...rest, in_report: matchedIssues.has(issue) };
      });
      const flaggedCount = flagged.filter((f) => f.flags.length > 0).length;
      const header =
        `${pages.length} landing page(s) com clique — ${periodLabel(dateRange, days)}${device ? `, ${device}` : ""}; ` +
        `${rows.length} listada(s), ${flaggedCount} com alerta. Taxa de conversão média: ${round2(avgConvRate * 100)}%.` +
        (checkPolicy !== false ? ` ${issues.length} anúncio(s) com DESTINATION_NOT_WORKING.` : "") +
        (warnings.length ? `\nAviso: ${warnings.join(" ")}` : "") +
        "\nspeed_score e mobile-friendly medem a experiência mobile; nulo = sem dado suficiente." +
        (results.length >= 10000 ? "\nA consulta atingiu o teto de 10000 URLs: filtre por campanha ou período." : "");
      const tableRows = rows.map((row) => ({ ...row, flags: row.flags.join(" | ") }));
      return render(format, tableRows, header, {
        period: periodLabel(dateRange, days),
        totals: view(total),
        avg_conv_rate_pct: round2(avgConvRate * 100),
        rows,
        ...(checkPolicy !== false ? { destination_not_working: destinationIssues } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    }
  );

  // ── Divisão por rede ───────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_network_breakdown",
    {
      description: [
        "Desempenho por rede (segments.ad_network_type): Google Search × parceiros de pesquisa (SEARCH_PARTNERS) ×",
        "Rede de Display (CONTENT) × YouTube etc., por campanha e no total da conta. READ OPERATION.",
        "",
        "Para cada campanha de Pesquisa, compara parceiros e expansão para Display com o Google Search da própria",
        "campanha e sinaliza quando gastam >= flagMinSpend e convertem pior (sem conversão, CPA 50% acima ou ROAS",
        "abaixo de 2/3). Mostra também como estão os toggles (network_settings) — para desligar, use update_campaign",
        "com networkSettings.targetSearchNetwork=false (parceiros) ou targetContentNetwork=false (Display).",
        "PMax aparece dividida por rede (SEARCH, CONTENT, YOUTUBE...) só como informação: não há toggle de rede em PMax.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta cliente)."),
        campaignId: z.string().optional().describe("Filtra por campanha (ID numérico)."),
        channelType: z.enum(CHANNEL_TYPES).optional().describe("Filtra pelo tipo de campanha (ex.: SEARCH)."),
        level: z.enum(["CAMPAIGN", "ACCOUNT"]).optional().describe("CAMPAIGN (default) = por campanha + total; ACCOUNT = só o total por rede."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        flagMinSpend: z.number().optional().describe("Gasto mínimo (moeda da conta) de uma rede para gerar alerta. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, channelType, level, dateRange, days, flagMinSpend, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badId = invalidId({ campaignId });
      if (badId) return fail(badId);
      const badNumber = invalidNonNegative({ flagMinSpend });
      if (badNumber) return fail(badNumber);
      let dateClause: string;
      try {
        dateClause = dateClauseFor(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const minFlagMicros = (flagMinSpend ?? 50) * 1_000_000;

      // Sempre FROM campaign: o total da conta sai da soma das campanhas (filtrar campaign.id em FROM customer é inválido)
      const where = [dateClause, "metrics.impressions > 0"];
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      if (channelType) where.push(`campaign.advertising_channel_type = '${channelType}'`);
      const query =
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.network_settings.target_google_search, campaign.network_settings.target_search_network,
                campaign.network_settings.target_content_network, campaign.network_settings.target_youtube,
                segments.ad_network_type,
                metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${where.join(" AND ")}
         ORDER BY metrics.cost_micros DESC`;

      const client = ctx.getClient();
      let results: Row[];
      try {
        results = await client.searchStream(customerId, query);
      } catch (err) {
        return fail(`Erro: ${explainReportError((err as Error).message, customerId)}`);
      }

      interface CampaignNetworks {
        id: string;
        name: string;
        status: string;
        type: string;
        settings: Row;
        networks: Map<string, Totals>;
      }
      const campaigns = new Map<string, CampaignNetworks>();
      const account = new Map<string, Totals>();
      for (const row of results) {
        const campaign = asRow(row.campaign);
        const id = str(campaign.id);
        const network = str(asRow(row.segments).adNetworkType) || "UNKNOWN";
        let entry = campaigns.get(id);
        if (!entry) {
          const settings = asRow(campaign.networkSettings);
          entry = {
            id,
            name: str(campaign.name),
            status: str(campaign.status),
            type: str(campaign.advertisingChannelType),
            settings: {
              google_search: settings.targetGoogleSearch ?? null,
              search_partners: settings.targetSearchNetwork ?? null,
              display_expansion: settings.targetContentNetwork ?? null,
              youtube: settings.targetYoutube ?? null,
            },
            networks: new Map(),
          };
          campaigns.set(id, entry);
        }
        entry.networks.set(network, addReportMetrics(entry.networks.get(network) ?? emptyReportTotals(), row.metrics));
        account.set(network, addReportMetrics(account.get(network) ?? emptyReportTotals(), row.metrics));
      }

      const networkBlock = (networks: Map<string, Totals>) => {
        const spendTotal = sumTotals([...networks.values()]).costMicros;
        return Object.fromEntries(
          [...networks.entries()]
            .sort((a, b) => b[1].costMicros - a[1].costMicros)
            .map(([network, totals]) => [
              network,
              { label: NETWORK_LABELS[network] ?? network, share_of_spend_pct: pct(totals.costMicros, spendTotal), ...view(totals) },
            ])
        );
      };

      const alerts: Array<Row> = [];
      const flagsByCampaignNetwork = new Map<string, string>();
      const campaignRows = [...campaigns.values()].map((entry) => {
        const flags: string[] = [];
        const search = entry.networks.get("SEARCH");
        if (entry.type === "SEARCH" && search) {
          const base = view(search);
          const checks: Array<[string, string, string]> = [
            ["SEARCH_PARTNERS", "parceiros de pesquisa", "networkSettings.targetSearchNetwork=false"],
            ["CONTENT", "expansão para Display", "networkSettings.targetContentNetwork=false"],
          ];
          for (const [network, label, fix] of checks) {
            const totals = entry.networks.get(network);
            if (!totals || totals.costMicros < minFlagMicros) continue;
            const other = view(totals);
            const reasons: string[] = [];
            if (other.conversions === 0 && base.conversions > 0) {
              reasons.push(`${other.spend} de gasto sem conversão (Google Search converteu ${base.conversions})`);
            } else if (other.cpa !== null && base.cpa !== null && other.cpa > base.cpa * WORSE_CPA_FACTOR) {
              reasons.push(`CPA ${other.cpa} vs ${base.cpa} no Google Search (+${round2((other.cpa / base.cpa - 1) * 100)}%)`);
            }
            if (base.roas && base.conversions_value > 0 && (other.roas ?? 0) < base.roas * WORSE_ROAS_FACTOR) {
              reasons.push(`ROAS ${other.roas ?? 0} vs ${base.roas} no Google Search`);
            }
            if (reasons.length === 0) continue;
            const settingKey = network === "SEARCH_PARTNERS" ? "search_partners" : "display_expansion";
            const stillOn = entry.settings[settingKey] !== false;
            const flag =
              `${label}: ${reasons.join("; ")}` +
              (stillOn ? ` — para desligar: update_campaign ${fix}` : " — o toggle já está desligado (o gasto é de antes da mudança)");
            flags.push(flag);
            flagsByCampaignNetwork.set(`${entry.id}|${network}`, flag);
            alerts.push({ campaign_id: entry.id, campaign: entry.name, network, alert: flag });
          }
        }
        return {
          campaign_id: entry.id,
          campaign: entry.name,
          type: entry.type,
          status: entry.status,
          network_settings: entry.settings,
          total: view(sumTotals([...entry.networks.values()])),
          networks: networkBlock(entry.networks),
          flags,
        };
      });

      const accountBlock = networkBlock(account);
      const header =
        `Divisão por rede — ${periodLabel(dateRange, days)}: ${campaigns.size} campanha(s) com impressão, ` +
        `${alerts.length} alerta(s).` +
        "\nshare_of_spend_pct = parte do gasto daquela rede no total (da campanha ou da conta).";
      const tableRows =
        level === "ACCOUNT"
          ? Object.entries(accountBlock).map(([network, data]) => ({ network, ...data }))
          : campaignRows.flatMap((campaign) =>
              Object.entries(campaign.networks).map(([network, data]) => ({
                campaign_id: campaign.campaign_id,
                campaign: campaign.campaign,
                type: campaign.type,
                network,
                ...data,
                alert: flagsByCampaignNetwork.get(`${campaign.campaign_id}|${network}`) ?? "",
              }))
            );
      return render(format, tableRows, header, {
        period: periodLabel(dateRange, days),
        account_by_network: accountBlock,
        ...(level === "ACCOUNT" ? {} : { campaigns: campaignRows }),
        alerts,
      });
    }
  );

  // ── Visão consolidada do MCC ───────────────────────────────────────

  ctx.mcp.registerTool(
    "get_mcc_performance_summary",
    {
      description: [
        "Visão consolidada do MCC: gasto, conversões, valor, ROAS e CPA de cada conta cliente no período, com",
        "variação contra o período anterior de mesmo tamanho. READ OPERATION.",
        "",
        "A API não devolve métricas de MCC (REQUESTED_METRICS_FOR_MANAGER): a tool lista as contas cliente ativas",
        "(customer_client, todos os níveis) e consulta cada uma — 1 chamada por conta, 5 em paralelo. Só entram as",
        "contas liberadas na allowlist (ALLOWED_CUSTOMER_IDS); customerIds fora dela é negado (Access denied) antes de",
        "qualquer consulta. Totais separados POR MOEDA — nunca somados entre moedas.",
        "Datas no fuso de cada conta. Alertas: parou de gastar, gasto sem conversão, CPA +30%, ROAS -30%, gasto ±50%.",
        "",
        "managerCustomerId omitido = MCC do login (GOOGLE_ADS_LOGIN_CUSTOMER_ID).",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().optional().describe("MCC a consolidar (precisa estar liberado). Default: MCC do login."),
        customerIds: flexArray(z.string()).optional().describe("Só estas contas cliente (IDs, com ou sem hífen). Conta fora da allowlist = Access denied, nada é consultado."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        compareToPrevious: z.boolean().optional().describe("Compara com o período anterior de mesmo tamanho. Default: true."),
        includeZeroSpend: z.boolean().optional().describe("Lista contas sem gasto nos dois períodos. Default: false."),
        maxAccounts: z.number().optional().describe("Máx. de contas consultadas (1 chamada cada). Default: 50, máx. 200."),
        sortBy: z
          .enum(["spend", "conversions", "conversions_value", "roas", "cpa", "spend_change"])
          .optional()
          .describe("Default: spend."),
        format: formatSchema,
      },
    },
    async ({ managerCustomerId, customerIds, dateRange, days, compareToPrevious, includeZeroSpend, maxAccounts, sortBy, format }) => {
      const managerId = managerCustomerId?.replace(/-/g, "");
      if (managerCustomerId !== undefined) {
        const blocked = checkCustomerAccess(managerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        if (!NUMERIC_ID.test(managerId!)) return fail(`managerCustomerId deve ser numérico, recebido "${managerCustomerId}".`);
      }
      const requested = customerIds === undefined ? undefined : ensureArray<unknown>(customerIds).map((id) => str(id).trim());
      // Allowlist ANTES de qualquer chamada e com a mesma resposta das tools por conta ("Access denied"), exista a
      // conta ou não: negar só depois de comparar com a lista do MCC revelaria quais contas são clientes dele.
      const deniedRequested = (requested ?? [])
        .map((id) => checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted))
        .filter((denial): denial is ReturnType<typeof text> => denial !== null);
      if (deniedRequested.length) {
        return { content: [text(deniedRequested.map((denial) => denial.text).join("\n"))], isError: true };
      }
      const wanted = requested?.map((id) => id.replace(/-/g, ""));
      const badWanted = wanted?.filter((id) => !NUMERIC_ID.test(id)) ?? [];
      if (badWanted.length) return fail(`customerIds inválido(s): ${badWanted.join(", ")} — use IDs numéricos.`);
      if (maxAccounts !== undefined && (!Number.isFinite(maxAccounts) || maxAccounts < 1)) {
        return fail(`maxAccounts deve ser >= 1, recebido ${maxAccounts}.`);
      }
      let period: { since: string; until: string; days: number };
      try {
        period = resolvePeriod(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const compare = compareToPrevious !== false;
      const previous = compare ? previousPeriod(period) : null;
      const cap = clampLimit(maxAccounts, 50, 200);

      const client = ctx.getClient();
      let children: Row[];
      try {
        children = await client.listChildAccounts(managerId);
      } catch (err) {
        return fail(`Erro ao listar as contas do MCC: ${explainReportError((err as Error).message, managerId ?? "do login")}`);
      }

      const accounts = new Map<string, { id: string; name: string; currency: string; timeZone: string }>();
      let denied = 0;
      for (const child of children) {
        const info = asRow(child.customerClient);
        const id = str(info.id).replace(/-/g, "");
        if (!id || info.manager === true || accounts.has(id)) continue;
        if (wanted && !wanted.includes(id)) continue;
        // Mesma regra das tools por conta: fora da allowlist não entra nem aparece
        if (checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted)) {
          denied++;
          continue;
        }
        accounts.set(id, { id, name: str(info.descriptiveName), currency: str(info.currencyCode) || "?", timeZone: str(info.timeZone) });
      }
      // Hospedado (allowlist por cliente), nem a CONTAGEM das contas de fora sai: ela diria quantos clientes o MCC
      // tem além dos liberados — como list_accounts, que filtra em silêncio. Local (stdio) ela ajuda a diagnosticar.
      const deniedNote = denied > 0 && !ctx.hosted ? denied : 0;
      const notFound = wanted?.filter((id) => !accounts.has(id) && !children.some((c) => str(asRow(c.customerClient).id) === id)) ?? [];
      const selected = [...accounts.values()];
      const queried = selected.slice(0, cap);
      if (queried.length === 0) {
        return {
          content: [text(
            "Nenhuma conta cliente ativa e liberada para consultar" +
              (deniedNote ? ` (${deniedNote} fora da allowlist)` : "") +
              (notFound.length ? `. Não encontradas sob o MCC: ${notFound.join(", ")}` : "") +
              "."
          )],
        };
      }

      const from = previous ? previous.since : period.since;
      const outcomes = await mapWithConcurrency(queried, MCC_CONCURRENCY, async (account) => {
        try {
          const rows = await client.searchStream(account.id,
            `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros,
                    metrics.conversions, metrics.conversions_value
             FROM customer
             WHERE segments.date BETWEEN '${from}' AND '${period.until}'`);
          const current = emptyReportTotals();
          const before = emptyReportTotals();
          for (const row of rows) {
            const date = str(asRow(row.segments).date);
            addReportMetrics(date >= period.since ? current : before, row.metrics);
          }
          return { account, current, before, error: null as string | null };
        } catch (err) {
          return { account, current: emptyReportTotals(), before: emptyReportTotals(), error: explainReportError((err as Error).message, account.id) };
        }
      });

      const summarize = (t: Totals) => {
        const v = view(t);
        return { spend: v.spend, impressions: v.impressions, clicks: v.clicks, conversions: v.conversions, conversions_value: v.conversions_value, roas: v.roas, cpa: v.cpa };
      };
      const errors = outcomes.filter((o) => o.error).map((o) => ({ customer_id: o.account.id, name: o.account.name, error: o.error }));
      const ok = outcomes.filter((o) => !o.error);
      // Totais por moeda com TODAS as contas consultadas (inclusive as sem gasto, que podem ter conversão importada)
      const byCurrency = new Map<string, { current: Totals[]; before: Totals[]; accounts: number }>();
      for (const o of ok) {
        const bucket = byCurrency.get(o.account.currency) ?? { current: [], before: [], accounts: 0 };
        bucket.current.push(o.current);
        bucket.before.push(o.before);
        bucket.accounts++;
        byCurrency.set(o.account.currency, bucket);
      }
      const accountRows = ok
        .filter((o) => includeZeroSpend === true || o.current.costMicros > 0 || (compare && o.before.costMicros > 0))
        .map((o) => {
          const cur = summarize(o.current);
          const prev = compare ? summarize(o.before) : null;
          const flags: string[] = [];
          if (prev && prev.spend > 0 && cur.spend === 0) flags.push("parou de gastar (gastou no período anterior)");
          if (cur.spend > 0 && cur.conversions === 0) flags.push("gasto sem conversão no período");
          const change = prev
            ? {
                spend_pct: changePct(cur.spend, prev.spend),
                conversions_pct: changePct(cur.conversions, prev.conversions),
                conversions_value_pct: changePct(cur.conversions_value, prev.conversions_value),
                roas_pct: cur.roas !== null && prev.roas ? changePct(cur.roas, prev.roas) : null,
                cpa_pct: cur.cpa !== null && prev.cpa ? changePct(cur.cpa, prev.cpa) : null,
              }
            : null;
          if (change) {
            if (change.cpa_pct !== null && change.cpa_pct >= MCC_CPA_UP_PCT) flags.push(`CPA subiu ${change.cpa_pct}%`);
            if (change.roas_pct !== null && change.roas_pct <= MCC_ROAS_DOWN_PCT) flags.push(`ROAS caiu ${Math.abs(change.roas_pct)}%`);
            if (change.spend_pct !== null && cur.spend > 0 && Math.abs(change.spend_pct) >= MCC_SPEND_SWING_PCT) {
              flags.push(`gasto ${change.spend_pct > 0 ? "subiu" : "caiu"} ${Math.abs(change.spend_pct)}%`);
            }
          }
          return {
            customer_id: o.account.id,
            name: o.account.name,
            currency: o.account.currency,
            current: cur,
            ...(prev ? { previous: prev, change } : {}),
            flags,
          };
        });

      const sortKey = sortBy ?? "spend";
      const sortValue = (row: (typeof accountRows)[number]) => {
        if (sortKey === "conversions") return row.current.conversions;
        if (sortKey === "conversions_value") return row.current.conversions_value;
        if (sortKey === "roas") return row.current.roas ?? -1;
        if (sortKey === "cpa") return row.current.cpa ?? -1;
        if (sortKey === "spend_change") return Math.abs(row.change?.spend_pct ?? 0);
        return row.current.spend;
      };
      accountRows.sort((a, b) => sortValue(b) - sortValue(a));

      const totalsByCurrency = Object.fromEntries(
        [...byCurrency.entries()].map(([currency, bucket]) => {
          const cur = summarize(sumTotals(bucket.current));
          const prev = compare ? summarize(sumTotals(bucket.before)) : null;
          return [
            currency,
            {
              accounts: bucket.accounts,
              current: cur,
              ...(prev
                ? {
                    previous: prev,
                    change: {
                      spend_pct: changePct(cur.spend, prev.spend),
                      conversions_pct: changePct(cur.conversions, prev.conversions),
                      conversions_value_pct: changePct(cur.conversions_value, prev.conversions_value),
                    },
                  }
                : {}),
            },
          ];
        })
      );

      const skipped = selected.length - queried.length;
      const header =
        `MCC ${managerId ?? "do login"} — ${period.since} a ${period.until}` +
        (previous ? ` (anterior: ${previous.since} a ${previous.until})` : "") +
        `: ${queried.length} conta(s) consultada(s), ${accountRows.length} listada(s)` +
        (errors.length ? `, ${errors.length} com erro` : "") +
        (skipped ? `; ${skipped} fora do limite maxAccounts=${cap} (aumente ou use customerIds)` : "") +
        (deniedNote ? `; ${deniedNote} fora da allowlist (omitidas)` : "") +
        (notFound.length ? `; não encontradas sob o MCC: ${notFound.join(", ")}` : "") +
        "." +
        `\nMoeda: ${[...byCurrency.keys()].join(", ") || "-"} — totais separados por moeda. Datas no fuso de cada conta.`;
      const tableRows = accountRows.map((row) => ({
        customer_id: row.customer_id,
        name: row.name,
        currency: row.currency,
        spend: row.current.spend,
        conversions: row.current.conversions,
        conversions_value: row.current.conversions_value,
        roas: row.current.roas,
        cpa: row.current.cpa,
        ...(row.previous
          ? {
              prev_spend: row.previous.spend,
              prev_conversions: row.previous.conversions,
              prev_roas: row.previous.roas,
              prev_cpa: row.previous.cpa,
              spend_change_pct: row.change?.spend_pct ?? null,
              cpa_change_pct: row.change?.cpa_pct ?? null,
              roas_change_pct: row.change?.roas_pct ?? null,
            }
          : {}),
        flags: row.flags.join(" | "),
      }));
      return render(format, tableRows, header, {
        manager: managerId ?? "login",
        period: { since: period.since, until: period.until },
        ...(previous ? { previous_period: previous } : {}),
        totals_by_currency: totalsByCurrency,
        accounts: accountRows,
        ...(errors.length ? { errors } : {}),
        ...(skipped ? { skipped_by_limit: selected.slice(cap).map((a) => ({ customer_id: a.id, name: a.name })) } : {}),
      });
    }
  );
}
