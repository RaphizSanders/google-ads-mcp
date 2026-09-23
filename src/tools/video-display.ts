/**
 * Lote video-display: Vídeo, YouTube e anúncios de Display.
 *
 * - get_video_performance: métricas de vídeo (TrueView v22+, quartis, tempo assistido,
 *   engajamento no YouTube, alcance/frequência) por campanha, grupo, anúncio, vídeo ou
 *   vídeo aprimorado, com quebra por rede, sub-rede (Shorts/in-feed/in-stream) e formato,
 *   comparadas aos benchmarks publicados em src/resources.ts.
 * - upload_youtube_video / get_youtube_video_uploads / remove_youtube_video_upload:
 *   YouTubeVideoUploadService (upload resumável de arquivo para o YouTube).
 * - create_image_ad: anúncio de imagem (banner de tamanho fixo) em Display.
 * - list_youtube_video_links / request_youtube_video_link / respond_youtube_video_link:
 *   vínculos de vídeos de criadores do YouTube (DataLinkService).
 *
 * Tools de leitura chamam checkCustomerAccess (o teste de allowlist confere no fonte).
 */
import { z } from "zod";
import { lookup as dnsLookup } from "node:dns/promises";
import { open, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, isAbsolute } from "node:path";
import type { GoogleAdsClient } from "../google-ads-client.js";
import type { ToolContext } from "../tool-kit.js";
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
  gaqlLiteral,
  num,
  parseImageAssetRef,
  round2,
  text,
} from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<ReturnType<typeof text>>; isError?: boolean };

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const NUMERIC = /^\d+$/;

function customerIdOf(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "");
  return NUMERIC.test(cid) ? cid : null;
}

function renderRows(rows: Row[], format: string | undefined): ToolResult | null {
  if (format === "table") return { content: [text(formatAsTable(rows))] };
  if (format === "csv") return { content: [text(formatAsCsv(rows))] };
  return null;
}

// ══════════════════════════════════════════════════════════════════
// ══ Relatório de vídeo ═════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════

export const VIDEO_REPORT_LEVELS = ["CAMPAIGN", "AD_GROUP", "AD", "VIDEO", "VIDEO_ENHANCEMENT"] as const;
export const VIDEO_REPORT_BREAKDOWNS = ["NONE", "NETWORK", "SUB_NETWORK", "FORMAT"] as const;
export const VIDEO_REPORT_CHANNELS = ["VIDEO_AND_DEMAND_GEN", "VIDEO", "DEMAND_GEN", "ALL"] as const;
type VideoLevel = (typeof VIDEO_REPORT_LEVELS)[number];
type VideoBreakdown = (typeof VIDEO_REPORT_BREAKDOWNS)[number];
type VideoChannel = (typeof VIDEO_REPORT_CHANNELS)[number];

const CHANNEL_TYPES: Record<VideoChannel, string[]> = {
  VIDEO_AND_DEMAND_GEN: ["VIDEO", "DEMAND_GEN"],
  VIDEO: ["VIDEO"],
  DEMAND_GEN: ["DEMAND_GEN"],
  ALL: [],
};

/* Campos por nível. Em FROM video e FROM video_enhancement, campaign é recurso de
   SEGMENTAÇÃO: o filtro por campaign.* só vale com o campo no SELECT (validado contra os
   metadados da v25 em tests/gaql-validator.ts). */
const LEVEL_SPEC: Record<VideoLevel, { from: string; fields: string[] }> = {
  CAMPAIGN: {
    from: "campaign",
    fields: [
      "campaign.id", "campaign.name", "campaign.status",
      "campaign.advertising_channel_type", "campaign.advertising_channel_sub_type",
    ],
  },
  AD_GROUP: {
    from: "ad_group",
    fields: [
      "campaign.id", "campaign.name", "campaign.advertising_channel_type",
      "ad_group.id", "ad_group.name", "ad_group.type", "ad_group.status",
    ],
  },
  AD: {
    from: "ad_group_ad",
    fields: [
      "campaign.id", "campaign.name", "campaign.advertising_channel_type",
      "ad_group.id", "ad_group.name",
      "ad_group_ad.ad.id", "ad_group_ad.ad.name", "ad_group_ad.ad.type", "ad_group_ad.status",
    ],
  },
  VIDEO: {
    from: "video",
    fields: [
      "campaign.id", "campaign.name", "campaign.advertising_channel_type",
      "video.id", "video.title", "video.channel_id", "video.duration_millis",
    ],
  },
  VIDEO_ENHANCEMENT: {
    from: "video_enhancement",
    fields: [
      "campaign.id", "campaign.name", "campaign.advertising_channel_type",
      "video.id",
      "video_enhancement.resource_name", "video_enhancement.title",
      "video_enhancement.source", "video_enhancement.duration_millis",
    ],
  },
};

/** Nomes da v22+ (video_views → video_trueview_views etc.). */
const VIDEO_METRICS = [
  "metrics.impressions", "metrics.clicks", "metrics.cost_micros",
  "metrics.conversions", "metrics.conversions_value", "metrics.view_through_conversions",
  "metrics.video_trueview_views", "metrics.video_trueview_view_rate",
  "metrics.video_trueview_view_rate_in_feed", "metrics.video_trueview_view_rate_in_stream",
  "metrics.video_trueview_view_rate_shorts",
  "metrics.trueview_average_cpv",
  "metrics.video_quartile_p25_rate", "metrics.video_quartile_p50_rate",
  "metrics.video_quartile_p75_rate", "metrics.video_quartile_p100_rate",
  "metrics.video_watch_time_duration_millis", "metrics.average_video_watch_time_duration_millis",
  "metrics.engagements", "metrics.engagement_rate",
];
/** Não existem em FROM video_enhancement. */
const YOUTUBE_ENGAGEMENT_METRICS = ["metrics.youtube_likes", "metrics.youtube_comments", "metrics.youtube_shares"];
/** Só em FROM campaign, sem agregar, janela de até 92 dias. */
const REACH_METRICS = ["metrics.unique_users", "metrics.average_impression_frequency_per_user"];
export const REACH_MAX_DAYS = 92;

const BREAKDOWN_SEGMENTS: Record<VideoBreakdown, string[]> = {
  NONE: [],
  NETWORK: ["segments.ad_network_type"],
  // ad_sub_network_type só vem junto com ad_network_type (segments.proto, v25)
  SUB_NETWORK: ["segments.ad_network_type", "segments.ad_sub_network_type"],
  // ad_sub_format_type só vem junto com ad_format_type
  FORMAT: ["segments.ad_format_type", "segments.ad_sub_format_type"],
};

/** Benchmarks de "Brand / Awareness" publicados em src/resources.ts (em BRL). */
export const VIDEO_BENCHMARKS = {
  viewRatePct: { good: 30, bad: 15 },
  cpvBrl: { good: 0.1, bad: 0.25 },
  minImpressions: 1000,
};

export function buildVideoPerformanceQuery(opts: {
  level: VideoLevel;
  breakdown: VideoBreakdown;
  channel: VideoChannel;
  dateClause: string;
  campaignId?: string;
  includeReach?: boolean;
  limit: number;
}): string {
  const spec = LEVEL_SPEC[opts.level];
  const metrics = [
    ...VIDEO_METRICS,
    ...(opts.level === "VIDEO_ENHANCEMENT" ? [] : YOUTUBE_ENGAGEMENT_METRICS),
    ...(opts.includeReach ? REACH_METRICS : []),
  ];
  const select = [...spec.fields, ...BREAKDOWN_SEGMENTS[opts.breakdown], ...metrics];
  const where = [opts.dateClause, "metrics.impressions > 0"];
  const channels = CHANNEL_TYPES[opts.channel];
  if (channels.length === 1) where.push(`campaign.advertising_channel_type = '${channels[0]}'`);
  else if (channels.length > 1) where.push(`campaign.advertising_channel_type IN (${channels.map((c) => `'${c}'`).join(", ")})`);
  // ALL não filtra tipo de campanha: sem este filtro, Pesquisa/Shopping/Display sem vídeo
  // ocupariam o LIMIT (ordenado por impressões) e entrariam no relatório de vídeo.
  else where.push("metrics.video_trueview_views > 0");
  if (opts.campaignId) where.push(`campaign.id = ${opts.campaignId}`);
  return `SELECT ${select.join(", ")}
     FROM ${spec.from}
     WHERE ${where.join(" AND ")}
     ORDER BY metrics.impressions DESC
     LIMIT ${opts.limit}`;
}

/** Taxas da API vêm em fração (0.31 = 31%), como ctr. */
const pct = (value: unknown) => round2(num(value) * 100);
/** Valores médios monetários (average_cpc, average_cpm, trueview_average_cpv) vêm em micros. */
const fromMicros = (value: unknown) => num(value) / 1_000_000;

/**
 * Linha sem views TrueView (campanha sem vídeo, Demand Gen só de imagem, bumper/in-stream não
 * pulável, que não geram view) não tem taxa de visualização a julgar: comparar o 0% dela com o
 * benchmark diria "ruim" para algo que nem é vídeo pulável.
 */
export const NO_VIEWS_LABEL = "sem views TrueView";

/**
 * Impressões que servem de base à taxa de visualização da linha: views ÷ video_trueview_view_rate
 * (o denominador que a própria API usou — só as impressões dos anúncios de vídeo, que numa
 * campanha mista de Demand Gen são uma parte das impressões da linha). Sem taxa, as impressões da
 * linha. Linha sem views TrueView = 0 (fica fora do view rate e dos quartis agregados).
 */
function videoImpressionsOf(m: Row): number {
  const views = num(m.videoTrueviewViews);
  if (views <= 0) return 0;
  const impressions = num(m.impressions);
  const rate = num(m.videoTrueviewViewRate);
  if (rate <= 0) return impressions;
  return impressions > 0 ? Math.min(views / rate, impressions) : views / rate;
}

function classifyViewRate(viewRatePct: number | null, basisImpressions: number, views: number): string {
  if (views <= 0 || viewRatePct === null) return NO_VIEWS_LABEL;
  if (basisImpressions < VIDEO_BENCHMARKS.minImpressions) return "amostra pequena";
  if (viewRatePct > VIDEO_BENCHMARKS.viewRatePct.good) return "bom";
  if (viewRatePct >= VIDEO_BENCHMARKS.viewRatePct.bad) return "médio";
  return "ruim";
}

function classifyCpv(cpv: number | null, views: number, isBrl: boolean): string | null {
  if (views <= 0) return NO_VIEWS_LABEL;
  if (!isBrl) return "sem benchmark (conta fora de BRL)";
  if (cpv === null) return null;
  if (views < 100) return "amostra pequena";
  if (cpv < VIDEO_BENCHMARKS.cpvBrl.good) return "bom";
  if (cpv <= VIDEO_BENCHMARKS.cpvBrl.bad) return "médio";
  return "ruim";
}

interface VideoTotals {
  impressions: number; views: number; clicks: number; costMicros: number; viewCost: number;
  conversions: number; conversionsValue: number; engagements: number; watchMillis: number;
  /** Base do view rate e dos quartis: só linhas com views TrueView (videoImpressionsOf). */
  videoImpressions: number;
  rowsWithViews: number;
  rowsWithoutViews: number;
  quartiles: [number, number, number, number];
}

function emptyVideoTotals(): VideoTotals {
  return {
    impressions: 0, views: 0, clicks: 0, costMicros: 0, viewCost: 0, conversions: 0,
    conversionsValue: 0, engagements: 0, watchMillis: 0,
    videoImpressions: 0, rowsWithViews: 0, rowsWithoutViews: 0, quartiles: [0, 0, 0, 0],
  };
}

function addVideoTotals(totals: VideoTotals, m: Row): void {
  const impressions = num(m.impressions);
  const views = num(m.videoTrueviewViews);
  totals.impressions += impressions;
  totals.views += views;
  totals.clicks += num(m.clicks);
  totals.costMicros += num(m.costMicros);
  totals.viewCost += fromMicros(m.trueviewAverageCpv) * views;
  totals.conversions += num(m.conversions);
  totals.conversionsValue += num(m.conversionsValue);
  totals.engagements += num(m.engagements);
  totals.watchMillis += num(m.videoWatchTimeDurationMillis);
  if (views <= 0) {
    totals.rowsWithoutViews++;
    return;
  }
  totals.rowsWithViews++;
  const basis = videoImpressionsOf(m);
  totals.videoImpressions += basis;
  const q = [m.videoQuartileP25Rate, m.videoQuartileP50Rate, m.videoQuartileP75Rate, m.videoQuartileP100Rate];
  q.forEach((rate, i) => { totals.quartiles[i] += num(rate) * basis; });
}

function videoTotalsView(t: VideoTotals, isBrl: boolean) {
  const cost = t.costMicros / 1_000_000;
  const viewRate = t.videoImpressions ? round2((t.views / t.videoImpressions) * 100) : null;
  const cpv = t.views ? round2(t.viewCost / t.views) : null;
  const quart = (i: number) => (t.videoImpressions ? round2((t.quartiles[i] / t.videoImpressions) * 100) : null);
  return {
    impressions: t.impressions,
    views: t.views,
    view_rate_pct: viewRate,
    view_rate_basis: {
      video_impressions: Math.round(t.videoImpressions),
      rows_with_views: t.rowsWithViews,
      rows_without_views: t.rowsWithoutViews,
    },
    cpv,
    cpm: t.impressions ? round2((cost / t.impressions) * 1000) : null,
    clicks: t.clicks,
    cost: round2(cost),
    conversions: round2(t.conversions),
    conversions_value: round2(t.conversionsValue),
    engagements: t.engagements,
    watch_time_hours: round2(t.watchMillis / 3_600_000),
    quartiles_pct_aprox: { p25: quart(0), p50: quart(1), p75: quart(2), p100: quart(3) },
    benchmark: {
      view_rate: classifyViewRate(viewRate, t.videoImpressions, t.views),
      cpv: classifyCpv(cpv, t.views, isBrl),
    },
  };
}

function videoRow(r: Row, level: VideoLevel, breakdown: VideoBreakdown, isBrl: boolean, includeReach: boolean): Row {
  const m = obj(r.metrics);
  const c = obj(r.campaign);
  const ag = obj(r.adGroup);
  const aga = obj(r.adGroupAd);
  const ad = obj(aga.ad);
  const v = obj(r.video);
  const ve = obj(r.videoEnhancement);
  const s = obj(r.segments);
  const impressions = num(m.impressions);
  const views = num(m.videoTrueviewViews);
  const cost = num(m.costMicros) / 1_000_000;

  const row: Row = { campaign_id: String(c.id ?? ""), campaign_name: c.name, channel: c.advertisingChannelType };
  if (level === "CAMPAIGN") {
    row.channel_sub_type = c.advertisingChannelSubType;
    row.campaign_status = c.status;
  } else if (level === "AD_GROUP") {
    Object.assign(row, { ad_group_id: String(ag.id ?? ""), ad_group_name: ag.name, ad_group_type: ag.type, ad_group_status: ag.status });
  } else if (level === "AD") {
    Object.assign(row, {
      ad_group_id: String(ag.id ?? ""), ad_group_name: ag.name,
      ad_id: String(ad.id ?? ""), ad_name: ad.name, ad_type: ad.type, ad_status: aga.status,
    });
  } else if (level === "VIDEO") {
    Object.assign(row, {
      video_id: v.id, video_title: v.title, video_channel_id: v.channelId,
      video_duration_s: v.durationMillis !== undefined ? round2(num(v.durationMillis) / 1000) : undefined,
    });
  } else {
    Object.assign(row, {
      video_id: v.id, enhancement_title: ve.title, enhancement_source: ve.source,
      enhancement_duration_s: ve.durationMillis !== undefined ? round2(num(ve.durationMillis) / 1000) : undefined,
      enhancement_resource_name: ve.resourceName,
    });
  }
  if (breakdown === "NETWORK" || breakdown === "SUB_NETWORK") row.network = s.adNetworkType;
  if (breakdown === "SUB_NETWORK") row.sub_network = s.adSubNetworkType;
  if (breakdown === "FORMAT") {
    row.format = s.adFormatType;
    row.sub_format = s.adSubFormatType;
  }

  const viewRate = pct(m.videoTrueviewViewRate);
  const cpv = views ? round2(fromMicros(m.trueviewAverageCpv)) : null;
  Object.assign(row, {
    impressions,
    views,
    view_rate_pct: viewRate,
    view_rate_in_feed_pct: pct(m.videoTrueviewViewRateInFeed),
    view_rate_in_stream_pct: pct(m.videoTrueviewViewRateInStream),
    view_rate_shorts_pct: pct(m.videoTrueviewViewRateShorts),
    cpv,
    cpm: impressions ? round2((cost / impressions) * 1000) : null,
    clicks: num(m.clicks),
    cost: round2(cost),
    conversions: round2(num(m.conversions)),
    conversions_value: round2(num(m.conversionsValue)),
    view_through_conversions: num(m.viewThroughConversions),
    p25_pct: pct(m.videoQuartileP25Rate),
    p50_pct: pct(m.videoQuartileP50Rate),
    p75_pct: pct(m.videoQuartileP75Rate),
    p100_pct: pct(m.videoQuartileP100Rate),
    watch_time_hours: round2(num(m.videoWatchTimeDurationMillis) / 3_600_000),
    avg_watch_time_s: round2(num(m.averageVideoWatchTimeDurationMillis) / 1000),
    engagements: num(m.engagements),
    engagement_rate_pct: pct(m.engagementRate),
  });
  if (level !== "VIDEO_ENHANCEMENT") {
    Object.assign(row, { youtube_likes: num(m.youtubeLikes), youtube_comments: num(m.youtubeComments), youtube_shares: num(m.youtubeShares) });
  }
  if (includeReach) {
    row.unique_users = num(m.uniqueUsers);
    row.avg_frequency_per_user = round2(num(m.averageImpressionFrequencyPerUser));
  }
  row.benchmark_view_rate = classifyViewRate(viewRate, videoImpressionsOf(m), views);
  row.benchmark_cpv = classifyCpv(cpv, views, isBrl);
  return row;
}

/** Janela em dias (inclusiva) do dateRange ou do days. */
function windowDays(dateRange?: { since: string; until: string }, days?: number): number {
  if (dateRange?.since && dateRange?.until) {
    if (!ISO_DATE.test(dateRange.since) || !ISO_DATE.test(dateRange.until)) return NaN;
    return Math.round((Date.parse(dateRange.until) - Date.parse(dateRange.since)) / 86_400_000) + 1;
  }
  return days ?? 30;
}

// ══════════════════════════════════════════════════════════════════
// ══ Upload de vídeo para o YouTube ═════════════════════════════════
// ══════════════════════════════════════════════════════════════════

/** Formatos aceitos pelo YouTube (help center "Supported YouTube file formats"). */
export const VIDEO_FILE_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".mpeg", ".mpg", ".mpeg4", ".avi", ".wmv", ".flv", ".3gp", ".3gpp", ".webm", ".mpegps",
]);
export const MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 ** 3; // 2 GiB por chamada (arquivo ou URL)
export const MAX_VIDEO_BASE64_BYTES = 20 * 1024 ** 2; // base64 é para arquivo pequeno
const TARGET_CHUNK_BYTES = 8 * 1024 ** 2;
const MAX_CHUNK_RETRIES = 3;
const MAX_REDIRECTS = 3;
export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const YOUTUBE_UPLOAD_STATES = ["PENDING", "UPLOADED", "PROCESSED", "FAILED", "REJECTED", "UNAVAILABLE"] as const;

/** Dependências de rede trocáveis nos testes (resolução DNS do host de download). */
export const netDeps = {
  lookup: async (host: string): Promise<Array<{ address: string; family: number }>> =>
    dnsLookup(host, { all: true, verbatim: true }),
};

/** Loopback, redes privadas, link-local, CGNAT, multicast e afins — nunca baixar de lá (SSRF). */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = (value: string): boolean => {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19));
  };
  if (isIP(ip) === 4) return v4(ip);
  if (isIP(ip) !== 6) return true;
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^(?:0*:)*:?ffff:(.+)$/.exec(ip)?.[1] ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return v4(mapped);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return v4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("64:ff9b:") || ip.startsWith("2001:db8:");
}

/** Valida uma URL de download (https, sem credenciais, host público). Devolve o erro ou null. */
export async function checkDownloadUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `URL inválida: "${raw}".`;
  }
  if (url.protocol !== "https:") return "só URL https:// é aceita.";
  if (url.username || url.password) return "URL com usuário/senha embutidos não é aceita.";
  if (url.port && url.port !== "443") return `porta ${url.port} não é aceita (só 443).`;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|intranet|lan|home)$/.test(host)) {
    return `host "${host}" é interno.`;
  }
  if (isIP(host)) return isPrivateAddress(host) ? `o endereço ${host} é interno/privado.` : null;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await netDeps.lookup(host);
  } catch (err) {
    return `não foi possível resolver ${host}: ${(err as Error).message}`;
  }
  if (addresses.length === 0) return `${host} não resolve para nenhum endereço.`;
  const internal = addresses.find((a) => isPrivateAddress(a.address));
  if (internal) return `${host} resolve para endereço interno (${internal.address}).`;
  return null;
}

/** Abre o download seguindo no máximo 3 redirecionamentos, revalidando cada destino. */
async function openDownload(start: URL): Promise<{ body: AsyncIterable<Uint8Array>; size?: number; contentType: string; finalUrl: string }> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`redirecionamento HTTP ${res.status} sem Location.`);
      const next = new URL(location, current);
      const problem = await checkDownloadUrl(next.href);
      if (problem) throw new Error(`redirecionamento recusado (${next.origin}): ${problem}`);
      current = next;
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download falhou: HTTP ${res.status}.`);
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!/^video\//.test(contentType) && !["application/octet-stream", "binary/octet-stream", ""].includes(contentType)) {
      await res.body.cancel().catch(() => undefined);
      throw new Error(`o conteúdo da URL é "${contentType}", não um vídeo.`);
    }
    const lengthHeader = res.headers.get("content-length");
    const size = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
    if (size !== undefined && size > MAX_VIDEO_UPLOAD_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw new Error(`o arquivo tem ${size} bytes; o limite desta tool é ${MAX_VIDEO_UPLOAD_BYTES} bytes (2 GiB).`);
    }
    if (size === 0) {
      await res.body.cancel().catch(() => undefined);
      throw new Error("a URL devolveu um arquivo vazio.");
    }
    return { body: res.body as unknown as AsyncIterable<Uint8Array>, size, contentType, finalUrl: current.href };
  }
  throw new Error(`mais de ${MAX_REDIRECTS} redirecionamentos.`);
}

async function* fileBlocks(path: string, blockSize: number): AsyncGenerator<Uint8Array> {
  const handle = await open(path, "r");
  try {
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(blockSize);
      const { bytesRead } = await handle.read(buffer, 0, blockSize, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

async function* bufferBlocks(buffer: Buffer): AsyncGenerator<Uint8Array> {
  yield buffer;
}

/**
 * Reparte o fluxo em pedaços de `size` bytes (o último pode ser menor), olhando um
 * pedaço à frente para saber qual é o último — ele vai com "upload, finalize".
 */
export async function* fixedChunks(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<{ data: Buffer; last: boolean }> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let ready: Buffer | null = null;
  for await (const part of source) {
    if (part.byteLength === 0) continue;
    pending.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
    pendingBytes += part.byteLength;
    while (pendingBytes >= size) {
      const all = Buffer.concat(pending, pendingBytes);
      const chunk = Buffer.from(all.subarray(0, size));
      const rest = all.subarray(size);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
      if (ready) yield { data: ready, last: false };
      ready = chunk;
    }
  }
  const tail = pendingBytes ? Buffer.concat(pending, pendingBytes) : null;
  if (tail) {
    if (ready) yield { data: ready, last: false };
    yield { data: tail, last: true };
  } else if (ready) {
    yield { data: ready, last: true };
  }
}

/**
 * Protocolo resumável: abre a sessão, envia pedaços múltiplos da granularidade e fecha
 * com "upload, finalize". Falha transitória num pedaço → consulta quantos bytes o
 * servidor recebeu e retoma dali (até 3 vezes). Falha definitiva → cancela a sessão.
 */
export async function runResumableUpload(
  client: GoogleAdsClient,
  cid: string,
  metadata: Row,
  source: AsyncIterable<Uint8Array>,
  declaredSize: number | undefined,
  maxBytes: number
): Promise<{ resourceName?: string; bytes: number; chunks: number; retries: number }> {
  // O exemplo REST oficial (assets/upload-videos) manda customer_id também no corpo JSON.
  const session = await client.startResumableUpload(cid, "youTubeVideoUploads:create", { customerId: cid, youTubeVideoUpload: metadata }, declaredSize);
  const granularity = session.chunkGranularity;
  const chunkSize = Math.max(1, Math.floor(TARGET_CHUNK_BYTES / granularity)) * granularity;
  let offset = 0;
  let chunks = 0;
  let retries = 0;
  let finalBody: Row | null = null;
  try {
    for await (const { data, last } of fixedChunks(source, chunkSize)) {
      if (offset + data.byteLength > maxBytes) {
        throw new Error(`o vídeo passa do limite de ${maxBytes} bytes desta tool.`);
      }
      let sent = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await client.sendResumableChunk(session.uploadUrl, offset + sent, data.subarray(sent), last);
          if (last) finalBody = result.body;
          else if (result.status && result.status !== "active") {
            throw new Error(`a sessão de upload foi encerrada pelo servidor (status ${result.status}).`);
          }
          break;
        } catch (err) {
          const message = (err as Error).message;
          // 4xx é definitivo (menos 408 timeout e 429 limite de taxa, que são transitórios)
          const permanent = /HTTP 4(?!08|29)\d\d|encerrada pelo servidor|fora de googleads|GOOGLE_ADS_DRY_RUN|read-only mode/.test(message);
          if (permanent || attempt >= MAX_CHUNK_RETRIES) throw err;
          retries++;
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
          const status = await client.queryResumableUpload(session.uploadUrl);
          if (status.status !== "active" || !Number.isFinite(status.sizeReceived) ||
              status.sizeReceived < offset || status.sizeReceived > offset + data.byteLength) {
            throw err;
          }
          sent = status.sizeReceived - offset;
          if (sent === data.byteLength && !last) break;
        }
      }
      offset += data.byteLength;
      chunks++;
    }
    if (chunks === 0) throw new Error("o vídeo está vazio (0 bytes).");
  } catch (err) {
    try {
      await client.cancelResumableUpload(session.uploadUrl);
    } catch {
      // melhor esforço: a sessão expira sozinha
    }
    throw err;
  }
  return { resourceName: finalBody?.resourceName as string | undefined, bytes: offset, chunks, retries };
}

const UPLOAD_FIELDS = `you_tube_video_upload.resource_name, you_tube_video_upload.video_upload_id,
                you_tube_video_upload.video_id, you_tube_video_upload.state,
                you_tube_video_upload.channel_id, you_tube_video_upload.video_privacy`;

function uploadRow(r: Row): Row {
  const u = obj(r.youTubeVideoUpload);
  return {
    video_upload_id: String(u.videoUploadId ?? ""),
    resource_name: u.resourceName,
    state: u.state,
    video_id: u.videoId || undefined,
    channel_id: u.channelId || undefined,
    channel: u.channelId ? "marca (brand channel)" : "gerenciado pelo Google",
    privacy: u.videoPrivacy,
  };
}

function uploadNextStep(state: unknown, hasAsset: boolean): string {
  switch (state) {
    case "PENDING": return "enviando — consulte de novo em alguns minutos";
    case "UPLOADED": return "processando no YouTube — consulte de novo em alguns minutos";
    case "PROCESSED": return hasAsset ? "pronto e já é asset da conta" : "pronto — registre como asset com upload_video_asset (youtubeVideoId = video_id)";
    case "FAILED": return "o upload/processamento falhou — suba de novo";
    case "REJECTED": return "recusado por validação ou política do YouTube";
    case "UNAVAILABLE": return "indisponível (pode ter sido removido do YouTube)";
    default: return "";
  }
}

// ══════════════════════════════════════════════════════════════════
// ══ Anúncio de imagem (banner) ═════════════════════════════════════
// ══════════════════════════════════════════════════════════════════

/** Tamanhos de anúncio de imagem enviado (help center "Uploaded display ads specifications"). */
export const IMAGE_AD_SIZES: Array<{ width: number; height: number; name: string }> = [
  { width: 200, height: 200, name: "Small square" },
  { width: 240, height: 400, name: "Vertical rectangle" },
  { width: 250, height: 250, name: "Square" },
  { width: 250, height: 360, name: "Triple widescreen" },
  { width: 300, height: 250, name: "Inline rectangle" },
  { width: 336, height: 280, name: "Large rectangle" },
  { width: 580, height: 400, name: "Netboard" },
  { width: 120, height: 600, name: "Skyscraper" },
  { width: 160, height: 600, name: "Wide skyscraper" },
  { width: 300, height: 600, name: "Half-page ad" },
  { width: 300, height: 1050, name: "Portrait" },
  { width: 468, height: 60, name: "Banner" },
  { width: 728, height: 90, name: "Leaderboard" },
  { width: 930, height: 180, name: "Top banner" },
  { width: 970, height: 90, name: "Large leaderboard" },
  { width: 970, height: 250, name: "Billboard" },
  { width: 980, height: 120, name: "Panorama" },
  { width: 300, height: 50, name: "Mobile banner" },
  { width: 320, height: 50, name: "Mobile banner" },
  { width: 320, height: 100, name: "Large mobile banner" },
];
export const IMAGE_AD_MAX_BYTES = 150 * 1024;
const IMAGE_AD_MIME_TYPES = new Set(["IMAGE_JPEG", "IMAGE_PNG", "IMAGE_GIF"]);

function validFinalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
// ══ Vínculos de vídeo do YouTube (DataLinkService) ═════════════════
// ══════════════════════════════════════════════════════════════════

export const DATA_LINK_STATUSES = ["REQUESTED", "PENDING_APPROVAL", "ENABLED", "DISABLED", "REVOKED", "REJECTED"] as const;
export const DATA_LINK_ACTIONS = ["ACCEPT", "REJECT", "REVOKE", "REMOVE"] as const;
type DataLinkAction = (typeof DATA_LINK_ACTIONS)[number];

/** Transições documentadas em docs/account-management/linking-youtube (v25). */
const DATA_LINK_TRANSITIONS: Record<DataLinkAction, { from: string; to: string | null; label: string; confirm: boolean }> = {
  ACCEPT: { from: "PENDING_APPROVAL", to: "ENABLED", label: "aceitar o pedido do criador", confirm: false },
  REJECT: { from: "PENDING_APPROVAL", to: "REJECTED", label: "recusar o pedido do criador", confirm: true },
  REVOKE: { from: "REQUESTED", to: "REVOKED", label: "revogar o pedido enviado ao criador", confirm: true },
  REMOVE: { from: "ENABLED", to: null, label: "remover o vínculo ativo", confirm: true },
};

const DATA_LINK_FIELDS = `data_link.resource_name, data_link.product_link_id, data_link.data_link_id,
                data_link.type, data_link.status,
                data_link.youtube_video.video_id, data_link.youtube_video.channel_id`;

function dataLinkRow(r: Row): Row {
  const d = obj(r.dataLink);
  const video = obj(d.youtubeVideo);
  return {
    resource_name: d.resourceName,
    product_link_id: String(d.productLinkId ?? ""),
    data_link_id: String(d.dataLinkId ?? ""),
    status: d.status,
    video_id: video.videoId,
    channel_id: video.channelId,
    video_url: video.videoId ? `https://www.youtube.com/watch?v=${video.videoId}` : undefined,
  };
}

function dataLinkNextStep(status: unknown): string {
  switch (status) {
    case "PENDING_APPROVAL": return "pedido do criador — aceite (ACCEPT) ou recuse (REJECT) com respond_youtube_video_link";
    case "REQUESTED": return "aguardando o criador aceitar — pode revogar (REVOKE)";
    case "ENABLED": return "vinculado — o vídeo pode ser usado em anúncios; remover com REMOVE";
    case "REJECTED": return "recusado";
    case "REVOKED": return "pedido revogado";
    case "DISABLED": return "vínculo desativado";
    default: return "";
  }
}

/** Extrai o ID de 11 caracteres de um ID puro ou de URL do YouTube (watch, youtu.be, shorts, embed). */
export function parseYouTubeVideoId(value: string): string | null {
  const raw = String(value ?? "").trim();
  if (YOUTUBE_VIDEO_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  let candidate: string | null = null;
  if (host === "youtu.be") candidate = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com") {
    candidate = url.searchParams.get("v") ?? (/^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null);
  }
  return candidate && YOUTUBE_VIDEO_ID.test(candidate) ? candidate : null;
}

/** "customers/{cid}/dataLinks/{p}~{d}" ou "{p}~{d}" → ids numéricos; conta divergente é recusada. */
export function parseDataLinkRef(value: string, cid: string): { productLinkId: string; dataLinkId: string; resourceName: string } | { error: string } {
  const raw = String(value ?? "").trim();
  const full = /^customers\/([\d-]+)\/dataLinks\/(\d+)~(\d+)$/.exec(raw);
  const short = /^(\d+)~(\d+)$/.exec(raw);
  if (full) {
    const owner = full[1].replace(/-/g, "");
    if (owner !== cid) return { error: `${raw} pertence à conta ${owner}, não à conta ${cid}.` };
    return { productLinkId: full[2], dataLinkId: full[3], resourceName: `customers/${cid}/dataLinks/${full[2]}~${full[3]}` };
  }
  if (short) return { productLinkId: short[1], dataLinkId: short[2], resourceName: `customers/${cid}/dataLinks/${short[1]}~${short[2]}` };
  return { error: `"${raw}" não é um vínculo válido (esperado customers/{customerId}/dataLinks/{productLinkId}~{dataLinkId} ou {productLinkId}~{dataLinkId}; veja list_youtube_video_links).` };
}

function explainDataLinkError(message: string): string {
  const hints: Array<[RegExp, string]> = [
    [/PERMISSION_DENIED|permission/i, "a conta não tem permissão para esta ação no vínculo (DataLinkError.PERMISSION_DENIED)."],
    [/YOUTUBE_VIDEO_ID_INVALID|video id is invalid/i, "o ID do vídeo do YouTube é inválido (DataLinkError.YOUTUBE_VIDEO_ID_INVALID)."],
    [/YOUTUBE_CHANNEL_ID_INVALID|channel id is invalid/i, "o ID do canal do YouTube é inválido (DataLinkError.YOUTUBE_CHANNEL_ID_INVALID)."],
    [/YOUTUBE_VIDEO_FROM_DIFFERENT_CHANNEL|different channel/i, "o vídeo não pertence ao canal informado (DataLinkError.YOUTUBE_VIDEO_FROM_DIFFERENT_CHANNEL)."],
    [/INVALID_UPDATE_STATUS|INVALID_STATUS|status is invalid/i, "o status atual do vínculo não permite esta ação (DataLinkError.INVALID_STATUS) — confira com list_youtube_video_links."],
  ];
  const hint = hints.find(([re]) => re.test(message))?.[1];
  return hint ? `${message}\nEm resumo: ${hint}` : message;
}

// ══════════════════════════════════════════════════════════════════
// ══ Registro das tools ═════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════

export function registerVideoDisplayTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── get_video_performance ──────────────────────────────────────────

  mcp.registerTool(
    "get_video_performance",
    {
      description: [
        "Relatório de vídeo (YouTube) para campanhas de Vídeo e Demand Gen. READ OPERATION.",
        "",
        "Por linha: impressões, visualizações TrueView e taxa de visualização (total, in-feed, in-stream e",
        "Shorts), CPV, CPM, quartis (25/50/75/100%), tempo assistido, engajamentos, curtidas/comentários/",
        "compartilhamentos no YouTube, cliques, custo e conversões (inclui view-through).",
        "Compara taxa de visualização e CPV com os benchmarks de Brand/Awareness do MCP (bom/médio/ruim).",
        "Linha sem views TrueView (sem vídeo, Demand Gen só de imagem, bumper/não pulável) sai como",
        "'sem views TrueView' e fica fora do view rate e dos quartis do resumo.",
        "",
        "level: CAMPAIGN | AD_GROUP | AD | VIDEO (por vídeo do YouTube) | VIDEO_ENHANCEMENT (versões geradas pelo Google).",
        "breakdown: NONE | NETWORK (YouTube, Discover, Gmail...) | SUB_NETWORK (Demand Gen: in-stream, in-feed,",
        "Shorts) | FORMAT (in-stream pulável, bumper, Shorts...). Com breakdown, o resumo traz a divisão (split).",
        "includeReach: usuários únicos e frequência média — só level CAMPAIGN sem breakdown e janela de até 92 dias.",
        "",
        "Campanhas de Vídeo só aceitam leitura pela API; Demand Gen é o caminho para criar vídeo por API.",
        "Em Demand Gen, cliques aparecem com click_type CROSS_NETWORK quando segmentados por click_type.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(VIDEO_REPORT_LEVELS).optional().describe("Nível do relatório. Default: CAMPAIGN."),
        breakdown: z.enum(VIDEO_REPORT_BREAKDOWNS).optional().describe("Quebra por rede/sub-rede/formato. Default: NONE."),
        channel: z.enum(VIDEO_REPORT_CHANNELS).optional()
          .describe(
            "Tipos de campanha: VIDEO_AND_DEMAND_GEN (default), VIDEO, DEMAND_GEN ou ALL (qualquer tipo — PMax, Display... —, " +
            "mas só linhas com views TrueView > 0; bumper/não pulável sem views ficam de fora: use VIDEO)."
          ),
        campaignId: z.string().optional().describe("Filtra por uma campanha (ID numérico)."),
        includeReach: z.boolean().optional().describe("Inclui unique_users e frequência média (só CAMPAIGN, sem breakdown, até 92 dias)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máximo de linhas (ordenadas por impressões). Default: 200, máx. 5000."),
        format: formatSchema,
      },
    },
    async ({ customerId, level, breakdown, channel, campaignId, includeReach, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (campaignId !== undefined && !NUMERIC.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const lvl: VideoLevel = level ?? "CAMPAIGN";
      const brk: VideoBreakdown = breakdown ?? "NONE";
      const chn: VideoChannel = channel ?? "VIDEO_AND_DEMAND_GEN";
      const max = limit ?? 200;
      if (!Number.isInteger(max) || max < 1 || max > 5000) return fail(`limit deve ser um inteiro entre 1 e 5000, recebido ${limit}.`);

      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      if (includeReach) {
        if (lvl !== "CAMPAIGN" || brk !== "NONE") {
          return fail("includeReach só vale com level CAMPAIGN e breakdown NONE: usuários únicos não podem ser somados nem segmentados.");
        }
        const span = windowDays(dateRange, days);
        if (!(span >= 1 && span <= REACH_MAX_DAYS)) {
          return fail(`includeReach exige janela de até ${REACH_MAX_DAYS} dias (a API não calcula usuários únicos além disso); a janela pedida tem ${span} dias.`);
        }
      }

      const client = getClient();
      const query = buildVideoPerformanceQuery({
        level: lvl, breakdown: brk, channel: chn, dateClause, campaignId, includeReach: Boolean(includeReach), limit: max,
      });
      const results = await client.searchStream(customerId, query);

      let currency = "BRL";
      if (results.length > 0) {
        const customerRows = await client.searchStream(customerId, "SELECT customer.currency_code FROM customer LIMIT 1");
        currency = String(obj(customerRows[0]?.customer).currencyCode ?? "BRL");
      }
      const isBrl = currency === "BRL";

      const rows = results.map((r) => videoRow(r, lvl, brk, isBrl, Boolean(includeReach)));
      const rendered = renderRows(rows, format);
      if (rendered) return rendered;

      const period = dateClause.replace(/^segments\.date /, "");
      if (rows.length === 0) {
        return {
          content: [text(
            `Nenhuma linha com impressões${chn === "ALL" ? " e views TrueView" : ""} (${lvl}, ${chn}, ${period}` +
            `${campaignId ? `, campanha ${campaignId}` : ""}). ` +
            "Confira o período e se a conta tem campanhas de Vídeo/Demand Gen com entrega."
          )],
        };
      }

      const totals = emptyVideoTotals();
      for (const r of results) addVideoTotals(totals, obj(r.metrics));
      const summary = videoTotalsView(totals, isBrl);

      let split: Row[] | undefined;
      if (brk !== "NONE") {
        const groups = new Map<string, VideoTotals>();
        for (const r of results) {
          const s = obj(r.segments);
          const key = brk === "NETWORK" ? String(s.adNetworkType ?? "?")
            : brk === "SUB_NETWORK" ? `${s.adNetworkType ?? "?"} / ${s.adSubNetworkType ?? "?"}`
            : `${s.adFormatType ?? "?"} / ${s.adSubFormatType ?? "?"}`;
          const group = groups.get(key) ?? emptyVideoTotals();
          addVideoTotals(group, obj(r.metrics));
          groups.set(key, group);
        }
        split = [...groups.entries()]
          .map(([key, t]) => {
            const view = videoTotalsView(t, isBrl);
            return {
              segment: key,
              impressions: view.impressions,
              share_impressions_pct: totals.impressions ? round2((t.impressions / totals.impressions) * 100) : 0,
              views: view.views,
              view_rate_pct: view.view_rate_pct,
              cost: view.cost,
              share_cost_pct: totals.costMicros ? round2((t.costMicros / totals.costMicros) * 100) : 0,
              cpv: view.cpv,
              conversions: view.conversions,
            };
          })
          .sort((a, b) => b.impressions - a.impressions);
      }

      const notes = [
        "Taxas em % (a API devolve fração). cpv/cpm na moeda da conta.",
        "View rate e quartis do resumo usam só as linhas com views TrueView, ponderadas pelas impressões de vídeo " +
          "de cada uma (views ÷ view rate da própria API); cpv do resumo é ponderado pelas views. São aproximações.",
        ...(summary.view_rate_basis.rows_without_views
          ? [`${summary.view_rate_basis.rows_without_views} linha(s) sem views TrueView (sem vídeo, só imagem ou bumper/não pulável): ` +
             `benchmark "${NO_VIEWS_LABEL}" e fora do view rate/quartis do resumo (impressões e custo delas seguem nos totais).`]
          : []),
        `Benchmarks (src/resources.ts, Brand/Awareness): view rate > ${VIDEO_BENCHMARKS.viewRatePct.good}% bom, ` +
          `${VIDEO_BENCHMARKS.viewRatePct.bad}-${VIDEO_BENCHMARKS.viewRatePct.good}% médio; CPV < R$ ${VIDEO_BENCHMARKS.cpvBrl.good.toFixed(2)} bom, ` +
          `até R$ ${VIDEO_BENCHMARKS.cpvBrl.bad.toFixed(2)} médio. Menos de ${VIDEO_BENCHMARKS.minImpressions} impressões de vídeo = amostra pequena. ` +
          "Em Demand Gen com meta de conversão, view rate/CPV pesam menos que CPA.",
        ...(rows.length >= max ? [`Resultado cortado em ${max} linhas (limit).`] : []),
      ];
      const header = `${rows.length} linha(s) de vídeo — ${lvl}${brk !== "NONE" ? ` por ${brk}` : ""}, ${chn}, ${period}` +
        `${campaignId ? `, campanha ${campaignId}` : ""}. Moeda: ${currency}.\n` +
        `Resumo: ${summary.impressions} impressões, ${summary.views} views (` +
        (summary.view_rate_pct === null ? NO_VIEWS_LABEL : `${summary.view_rate_pct}% — ${summary.benchmark.view_rate}`) + "), " +
        `CPV ${summary.cpv ?? "-"} (${summary.benchmark.cpv ?? "-"}), custo ${summary.cost}.` +
        (summary.view_rate_basis.rows_without_views && summary.view_rate_pct !== null
          ? ` View rate sobre ${summary.view_rate_basis.rows_with_views} linha(s) com views ` +
            `(${summary.view_rate_basis.video_impressions} impressões de vídeo); ` +
            `${summary.view_rate_basis.rows_without_views} sem views TrueView ficaram fora.`
          : "");
      return {
        content: [text(`${header}\n\n${formatJson({ level: lvl, breakdown: brk, channel: chn, period, currency, totals: summary, ...(split ? { split } : {}), rows, notes })}`)],
      };
    }
  );

  // ── upload_youtube_video ───────────────────────────────────────────

  mcp.registerTool(
    "upload_youtube_video",
    {
      description: [
        "Sobe um arquivo de vídeo para o YouTube pela API do Google Ads (YouTubeVideoUploadService, upload resumável).",
        "WRITE OPERATION — publica o vídeo no YouTube (não listado por padrão).",
        "",
        "Fonte (exatamente uma): filePath (arquivo local do servidor — só no modo local/stdio), httpsUrl",
        "(o servidor baixa de uma URL https pública; host interno é recusado) ou videoBase64 (arquivo pequeno, até 20 MB).",
        "Limite desta tool: 2 GiB. Formatos: mp4, mov, m4v, mpeg/mpg, avi, wmv, flv, 3gp, webm.",
        "",
        "Sem channelId o vídeo vai para o canal do YouTube gerenciado pelo Google e associado à conta, e só",
        "UNLISTED é permitido. Com channelId (canal da marca, 'UC...') vale PUBLIC ou UNLISTED — exige login",
        "OAuth de usuário com acesso ao canal (não funciona com service account).",
        "",
        "Depois: acompanhe com get_youtube_video_uploads até PROCESSED e registre o video_id com upload_video_asset.",
        "Em dry-run/validateOnly só valida os dados localmente: o endpoint de upload não tem validate_only.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        title: z.string().describe("Título do vídeo no YouTube (até 100 caracteres, sem < ou >). Imutável depois."),
        description: z.string().optional().describe("Descrição do vídeo (até 5000 bytes, sem < ou >). Imutável depois."),
        filePath: z.string().optional().describe("Caminho ABSOLUTO do arquivo no servidor (só no modo local/stdio)."),
        httpsUrl: z.string().optional().describe("URL https pública do arquivo (download direto, sem login)."),
        videoBase64: z.string().optional().describe("Conteúdo do arquivo em base64 (até 20 MB)."),
        privacy: z.enum(["UNLISTED", "PUBLIC"]).optional().describe("Default: UNLISTED. PUBLIC só com channelId (canal da marca)."),
        channelId: z.string().optional().describe("Canal da marca (ID 'UC' + 22 caracteres). Omitido = canal gerenciado pelo Google."),
      },
    },
    async ({ customerId, title, description, filePath, httpsUrl, videoBase64, privacy, channelId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);

      const problems: string[] = [];
      const videoTitle = String(title ?? "").trim();
      if (!videoTitle) problems.push("title é obrigatório.");
      else if (videoTitle.length > 100) problems.push(`title tem ${videoTitle.length} caracteres; o YouTube aceita até 100.`);
      if (/[<>]/.test(videoTitle)) problems.push("title não pode conter < ou >.");
      const videoDescription = description === undefined ? undefined : String(description);
      const descriptionBytes = videoDescription === undefined ? 0 : Buffer.byteLength(videoDescription, "utf8");
      if (descriptionBytes > 5000) problems.push(`description tem ${descriptionBytes} bytes; o YouTube aceita até 5000 bytes.`);
      if (videoDescription !== undefined && /[<>]/.test(videoDescription)) problems.push("description não pode conter < ou >.");
      if (channelId !== undefined && !YOUTUBE_CHANNEL_ID.test(channelId)) problems.push(`channelId "${channelId}" inválido (esperado "UC" + 22 caracteres).`);
      const videoPrivacy = privacy ?? "UNLISTED";
      if (videoPrivacy === "PUBLIC" && !channelId) {
        problems.push("PUBLIC só é permitido em canal da marca (channelId); no canal gerenciado pelo Google só UNLISTED.");
      }
      const sources = [filePath, httpsUrl, videoBase64].filter((s) => s !== undefined && String(s).trim() !== "");
      if (sources.length !== 1) problems.push(`informe exatamente uma fonte (filePath, httpsUrl ou videoBase64); recebidas ${sources.length}.`);
      if (problems.length) return fail(`Nada foi enviado:\n- ${problems.join("\n- ")}`);

      // Fonte: valida sem ler o conteúdo inteiro
      let sourceLabel: string;
      let declaredSize: number | undefined;
      let makeSource: () => Promise<{ stream: AsyncIterable<Uint8Array>; size?: number; detail?: string }>;
      if (videoBase64 !== undefined && videoBase64.trim()) {
        const clean = videoBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return fail("videoBase64 não é base64 válido. Nada foi enviado.");
        const bytes = Buffer.from(clean, "base64");
        if (bytes.length === 0) return fail("videoBase64 está vazio. Nada foi enviado.");
        if (bytes.length > MAX_VIDEO_BASE64_BYTES) {
          return fail(`videoBase64 tem ${bytes.length} bytes; o limite em base64 é ${MAX_VIDEO_BASE64_BYTES} (20 MB). Use filePath ou httpsUrl. Nada foi enviado.`);
        }
        sourceLabel = `base64 (${bytes.length} bytes)`;
        declaredSize = bytes.length;
        makeSource = async () => ({ stream: bufferBlocks(bytes), size: bytes.length });
      } else if (filePath !== undefined && filePath.trim()) {
        if (hosted) {
          return fail("filePath não é aceito no servidor hospedado (o arquivo teria que estar no disco do servidor). Use httpsUrl ou videoBase64. Nada foi enviado.");
        }
        if (!isAbsolute(filePath)) return fail(`filePath precisa ser absoluto, recebido "${filePath}". Nada foi enviado.`);
        const ext = extname(filePath).toLowerCase();
        if (!VIDEO_FILE_EXTENSIONS.has(ext)) {
          return fail(`Extensão "${ext || "(nenhuma)"}" não é de vídeo aceito pelo YouTube (${[...VIDEO_FILE_EXTENSIONS].join(", ")}). Nada foi enviado.`);
        }
        let info;
        try {
          info = await stat(filePath);
        } catch (err) {
          return fail(`Não foi possível ler ${filePath}: ${(err as Error).message}. Nada foi enviado.`);
        }
        if (!info.isFile()) return fail(`${filePath} não é um arquivo. Nada foi enviado.`);
        if (info.size === 0) return fail(`${filePath} está vazio. Nada foi enviado.`);
        if (info.size > MAX_VIDEO_UPLOAD_BYTES) return fail(`${filePath} tem ${info.size} bytes; o limite desta tool é 2 GiB. Nada foi enviado.`);
        sourceLabel = `arquivo ${filePath} (${info.size} bytes)`;
        declaredSize = info.size;
        makeSource = async () => ({ stream: fileBlocks(filePath, TARGET_CHUNK_BYTES), size: info.size });
      } else {
        const problem = await checkDownloadUrl(String(httpsUrl));
        if (problem) return fail(`httpsUrl recusada: ${problem} Nada foi enviado.`);
        sourceLabel = `URL ${new URL(String(httpsUrl)).origin}`;
        makeSource = async () => {
          const download = await openDownload(new URL(String(httpsUrl)));
          return { stream: download.body, size: download.size, detail: download.contentType };
        };
      }

      const metadata: Row = {
        videoTitle,
        ...(videoDescription !== undefined ? { videoDescription } : {}),
        videoPrivacy,
        ...(channelId ? { channelId } : {}),
      };
      const client = getClient();
      const plan = {
        customer_id: cid,
        title: videoTitle,
        privacy: videoPrivacy,
        channel: channelId ?? "gerenciado pelo Google",
        source: sourceLabel,
      };
      if (client.isDryRun) {
        return {
          content: [text(
            "DRY-RUN (validateOnly): dados validados localmente — nada foi enviado ao YouTube. " +
            "O YouTubeVideoUploadService não tem validate_only, então a API não conferiu o upload" +
            `${httpsUrl ? " (a URL não foi baixada)" : ""}.\n\n${formatJson(plan)}`
          )],
        };
      }

      let prepared: { stream: AsyncIterable<Uint8Array>; size?: number };
      try {
        prepared = await makeSource();
      } catch (err) {
        return fail(`Não foi possível abrir a fonte do vídeo: ${(err as Error).message} Nada foi enviado ao YouTube.`);
      }
      declaredSize = prepared.size ?? declaredSize;

      let uploaded: Awaited<ReturnType<typeof runResumableUpload>>;
      try {
        uploaded = await runResumableUpload(client, cid, metadata, prepared.stream, declaredSize, MAX_VIDEO_UPLOAD_BYTES);
      } catch (err) {
        return fail(
          `O upload não terminou: ${(err as Error).message}\n` +
          "Se a sessão chegou a abrir, foi cancelada (melhor esforço). Confira com get_youtube_video_uploads antes de repetir."
        );
      }
      if (!uploaded.resourceName) {
        return fail(
          `A API recebeu ${uploaded.bytes} bytes mas não devolveu o resourceName do upload. ` +
          "Confira com get_youtube_video_uploads antes de repetir."
        );
      }

      let state: Row | null = null;
      try {
        const rows = await client.searchStream(customerId,
          `SELECT ${UPLOAD_FIELDS} FROM you_tube_video_upload WHERE you_tube_video_upload.resource_name = '${gaqlLiteral(uploaded.resourceName)}'`);
        state = rows[0] ? uploadRow(rows[0]) : null;
      } catch {
        state = null;
      }
      return {
        content: [text(
          `Vídeo enviado ao YouTube: ${uploaded.resourceName}\n` +
          `${uploaded.bytes} bytes em ${uploaded.chunks} pedaço(s)${uploaded.retries ? `, ${uploaded.retries} retomada(s)` : ""}. ` +
          `Estado: ${state?.state ?? "desconhecido (consulta falhou)"}.\n` +
          "Próximo passo: get_youtube_video_uploads até PROCESSED; depois upload_video_asset com o video_id.\n\n" +
          formatJson({ ...plan, resource_name: uploaded.resourceName, bytes: uploaded.bytes, upload: state })
        )],
      };
    }
  );

  // ── get_youtube_video_uploads ──────────────────────────────────────

  mcp.registerTool(
    "get_youtube_video_uploads",
    {
      description: [
        "Lista os vídeos enviados ao YouTube pela API (you_tube_video_upload). READ OPERATION.",
        "Por upload: estado (PENDING, UPLOADED, PROCESSED, FAILED, REJECTED, UNAVAILABLE), video_id do YouTube,",
        "canal (gerenciado pelo Google ou da marca), privacidade e se o vídeo já é asset YOUTUBE_VIDEO da conta.",
        "Use para acompanhar upload_youtube_video: o video_id só serve em anúncios depois de PROCESSED.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        state: z.enum(YOUTUBE_UPLOAD_STATES).optional().describe("Filtra por estado."),
        videoUploadId: z.string().optional().describe("Filtra por um upload (video_upload_id numérico)."),
        limit: z.number().optional().describe("Máximo de uploads (mais recentes primeiro). Default: 100."),
        format: formatSchema,
      },
    },
    async ({ customerId, state, videoUploadId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (videoUploadId !== undefined && !NUMERIC.test(videoUploadId)) {
        return fail(`videoUploadId deve ser numérico, recebido "${videoUploadId}".`);
      }
      const max = limit ?? 100;
      if (!Number.isInteger(max) || max < 1 || max > 10000) return fail(`limit deve ser um inteiro entre 1 e 10000, recebido ${limit}.`);
      const client = getClient();
      const where: string[] = [];
      if (state) where.push(`you_tube_video_upload.state = '${state}'`);
      if (videoUploadId) where.push(`you_tube_video_upload.video_upload_id = ${videoUploadId}`);
      const results = await client.searchStream(customerId,
        `SELECT ${UPLOAD_FIELDS}
         FROM you_tube_video_upload
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY you_tube_video_upload.video_upload_id DESC
         LIMIT ${max}`);
      const rows = results.map(uploadRow);

      const videoIds = [...new Set(rows.map((r) => r.video_id).filter((id): id is string => typeof id === "string" && YOUTUBE_VIDEO_ID.test(id)))];
      const assets = new Map<string, string>();
      if (videoIds.length > 0) {
        const assetRows = await client.searchStream(customerId,
          `SELECT asset.id, asset.resource_name, asset.youtube_video_asset.youtube_video_id
           FROM asset
           WHERE asset.type = 'YOUTUBE_VIDEO'
             AND asset.youtube_video_asset.youtube_video_id IN (${videoIds.map((id) => `'${gaqlLiteral(id)}'`).join(", ")})`);
        for (const r of assetRows) {
          const asset = obj(r.asset);
          const id = String(obj(asset.youtubeVideoAsset).youtubeVideoId ?? "");
          if (id) assets.set(id, String(asset.resourceName ?? ""));
        }
      }
      const enriched = rows.map((r): Row => {
        const asset = typeof r.video_id === "string" ? assets.get(r.video_id) : undefined;
        return { ...r, asset_resource_name: asset, next_step: uploadNextStep(r.state, Boolean(asset)) };
      });
      const rendered = renderRows(enriched, format);
      if (rendered) return rendered;
      if (enriched.length === 0) {
        return { content: [text(`Nenhum upload de vídeo${state ? ` em ${state}` : ""}${videoUploadId ? ` com id ${videoUploadId}` : ""} nesta conta.`)] };
      }
      const counts = new Map<string, number>();
      for (const r of enriched) counts.set(String(r.state), (counts.get(String(r.state)) ?? 0) + 1);
      return {
        content: [text(
          `${enriched.length} upload(s): ${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}.\n\n${formatJson(enriched)}`
        )],
      };
    }
  );

  // ── remove_youtube_video_upload ────────────────────────────────────

  mcp.registerTool(
    "remove_youtube_video_upload",
    {
      description: [
        "Remove vídeos enviados pela API (YouTubeVideoUploadService.RemoveYouTubeVideoUpload).",
        "WRITE OPERATION — DESTRUTIVA: apaga o vídeo do YouTube E da biblioteca de assets; anúncios que o usam",
        "deixam de veicular. Não há como desfazer. Só vale para vídeos enviados por upload_youtube_video.",
        "",
        "Exige confirm: true. Sem confirm mostra o que seria removido e não grava nada.",
        "Em dry-run/validateOnly só mostra a prévia: o endpoint não tem validate_only.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        videoUploadIds: flexArray(z.string()).describe(
          "Uploads a remover: video_upload_id numérico ou resource name customers/{cid}/youTubeVideoUploads/{id} (de get_youtube_video_uploads). Máx. 50."
        ),
        confirm: z.boolean().optional().describe("Precisa ser true para remover. Sem ele, só a prévia."),
      },
    },
    async ({ customerId, videoUploadIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      const refs = ensureArray<string>(videoUploadIds).map((r) => String(r).trim()).filter(Boolean);
      if (refs.length === 0) return fail("Informe ao menos um upload em videoUploadIds. Nada foi removido.");
      const ids = new Set<string>();
      const invalid: string[] = [];
      for (const ref of refs) {
        if (NUMERIC.test(ref)) { ids.add(ref); continue; }
        const match = /^customers\/([\d-]+)\/youTubeVideoUploads\/(\d+)$/.exec(ref);
        if (!match) invalid.push(`"${ref}" não é um video_upload_id nem resource name de upload.`);
        else if (match[1].replace(/-/g, "") !== cid) invalid.push(`${ref} pertence à conta ${match[1].replace(/-/g, "")}, não à ${cid}.`);
        else ids.add(match[2]);
      }
      if (invalid.length) return fail(`Nada foi removido:\n- ${invalid.join("\n- ")}`);
      if (ids.size > 50) return fail(`No máximo 50 uploads por chamada; recebidos ${ids.size}. Nada foi removido.`);

      const client = getClient();
      const found = (await client.searchStream(customerId,
        `SELECT ${UPLOAD_FIELDS}
         FROM you_tube_video_upload
         WHERE you_tube_video_upload.video_upload_id IN (${[...ids].join(", ")})`)).map(uploadRow);
      const foundIds = new Set(found.map((r) => String(r.video_upload_id)));
      const missing = [...ids].filter((id) => !foundIds.has(id));
      if (missing.length) {
        return fail(`Nada foi removido — upload(s) não encontrado(s) na conta ${cid}: ${missing.join(", ")}. Confira com get_youtube_video_uploads.`);
      }
      const preview = found.map((r) => ({
        video_upload_id: r.video_upload_id,
        video_id: r.video_id,
        state: r.state,
        channel: r.channel,
        privacy: r.privacy,
        video_url: r.video_id ? `https://www.youtube.com/watch?v=${r.video_id}` : undefined,
      }));
      if (!confirm) {
        return fail(
          `Prévia — ${preview.length} vídeo(s) seriam APAGADOS do YouTube e da biblioteca de assets (sem volta). ` +
          `Nada foi removido. Para remover, chame de novo com confirm: true.\n\n${formatJson(preview)}`
        );
      }
      if (client.isDryRun) {
        return {
          content: [text(
            "DRY-RUN (validateOnly): nada foi removido. RemoveYouTubeVideoUpload não tem validate_only; " +
            `os uploads existem nesta conta e seriam removidos:\n\n${formatJson(preview)}`
          )],
        };
      }
      const resourceNames = found.map((r) => String(r.resource_name));
      let response: { resourceNames?: string[] };
      try {
        response = await client.customerWriteAction<{ resourceNames?: string[] }>(cid, "youTubeVideoUploads:remove", { resourceNames });
      } catch (err) {
        return fail(
          `A API recusou a remoção: ${(err as Error).message}\n` +
          "Nenhuma confirmação de remoção foi recebida — confira com get_youtube_video_uploads antes de repetir."
        );
      }
      const removed = new Set(response.resourceNames ?? []);
      const notConfirmed = resourceNames.filter((rn) => !removed.has(rn));
      return {
        content: [text(
          `${removed.size}/${resourceNames.length} upload(s) removido(s) do YouTube e da biblioteca.` +
          (notConfirmed.length ? `\nSem confirmação da API: ${notConfirmed.join(", ")}` : "") +
          `\n\n${formatJson({ removed: preview.filter((p) => removed.has(`customers/${cid}/youTubeVideoUploads/${p.video_upload_id}`)), not_confirmed: notConfirmed })}`
        )],
        isError: notConfirmed.length > 0,
      };
    }
  );

  // ── create_image_ad ────────────────────────────────────────────────

  mcp.registerTool(
    "create_image_ad",
    {
      description: [
        "Cria um anúncio de imagem (banner de tamanho fixo, IMAGE_AD) num grupo de anúncios de Display.",
        "WRITE OPERATION — criado PAUSADO.",
        "",
        "A imagem precisa já estar na biblioteca (upload_image_asset). Antes de gravar, confere: grupo existe",
        "nesta conta em campanha DISPLAY; imagem é IMAGE, GIF/JPG/PNG, até 150 KB e num tamanho padrão:",
        "200x200, 240x400, 250x250, 250x360, 300x250, 336x280, 580x400, 120x600, 160x600, 300x600, 300x1050,",
        "468x60, 728x90, 930x180, 970x90, 970x250, 980x120, 300x50, 320x50, 320x100.",
        "Se já existe anúncio de imagem com o mesmo banner e a mesma URL no grupo, nada é criado.",
        "HTML5/AMPHTML (media bundle) não é coberto: exige conta habilitada (allowlist) pelo Google.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios (campanha DISPLAY)."),
        imageAsset: z.string().describe("Imagem: ID numérico do asset ou customers/{cid}/assets/{id}."),
        finalUrl: z.string().describe("URL final (http/https)."),
        name: z.string().describe("Nome do anúncio (identificação interna)."),
      },
    },
    async ({ customerId, adGroupId, imageAsset, finalUrl, name }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!NUMERIC.test(String(adGroupId))) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi gravado.`);
      if (!validFinalUrl(finalUrl)) return fail(`finalUrl inválida: "${finalUrl}" (use http:// ou https://). Nada foi gravado.`);
      const adName = String(name ?? "").trim();
      if (!adName) return fail("name é obrigatório. Nada foi gravado.");
      if (adName.length > 255) return fail(`name tem ${adName.length} caracteres (máx. 255). Nada foi gravado.`);
      const assetRef = parseImageAssetRef(String(imageAsset ?? ""), cid);
      if ("error" in assetRef) return fail(`${assetRef.error} Nada foi gravado.`);

      const client = getClient();
      const groupRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
                campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const group = obj(groupRows[0]?.adGroup);
      const campaign = obj(groupRows[0]?.campaign);
      if (!groupRows[0]) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.`);
      if (group.status === "REMOVED") return fail(`Grupo ${adGroupId} ("${group.name}") está removido. Nada foi gravado.`);
      if (campaign.advertisingChannelType !== "DISPLAY") {
        return fail(
          `O grupo ${adGroupId} é de campanha ${campaign.advertisingChannelType} ("${campaign.name}"). ` +
          "Anúncio de imagem enviado é de campanha DISPLAY. Nada foi gravado."
        );
      }
      if (group.type && group.type !== "DISPLAY_STANDARD") {
        return fail(`O grupo ${adGroupId} é do tipo ${group.type}; anúncio de imagem vai em grupo DISPLAY_STANDARD. Nada foi gravado.`);
      }

      const assetRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.type, asset.image_asset.full_size.width_pixels,
                asset.image_asset.full_size.height_pixels, asset.image_asset.file_size, asset.image_asset.mime_type
         FROM asset
         WHERE asset.id = ${assetRef.assetId}`);
      const asset = obj(assetRows[0]?.asset);
      if (!assetRows[0]) return fail(`Asset ${assetRef.assetId} não existe na conta ${cid}. Nada foi gravado.`);
      if (asset.type !== "IMAGE") return fail(`Asset ${assetRef.assetId} ("${asset.name ?? ""}") é ${asset.type}, não IMAGE. Nada foi gravado.`);
      const image = obj(asset.imageAsset);
      const full = obj(image.fullSize);
      const width = num(full.widthPixels);
      const height = num(full.heightPixels);
      const fileSize = image.fileSize !== undefined ? num(image.fileSize) : undefined;
      const size = IMAGE_AD_SIZES.find((s) => s.width === width && s.height === height);
      const imageProblems: string[] = [];
      if (!width || !height) imageProblems.push("a API não informou as dimensões da imagem");
      else if (!size) imageProblems.push(`${width}x${height} não é tamanho padrão de anúncio de imagem (${IMAGE_AD_SIZES.map((s) => `${s.width}x${s.height}`).join(", ")})`);
      if (fileSize !== undefined && fileSize > IMAGE_AD_MAX_BYTES) imageProblems.push(`o arquivo tem ${Math.ceil(fileSize / 1024)} KB; o limite é 150 KB`);
      if (image.mimeType && !IMAGE_AD_MIME_TYPES.has(String(image.mimeType))) imageProblems.push(`formato ${image.mimeType} não aceito (GIF, JPG ou PNG)`);
      if (imageProblems.length) return fail(`Imagem ${assetRef.assetId} recusada para anúncio de imagem:\n- ${imageProblems.join("\n- ")}\nNada foi gravado.`);

      const adGroupResource = `customers/${cid}/adGroups/${adGroupId}`;
      const existing = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad.final_urls,
                ad_group_ad.ad.image_ad.image_asset.asset
         FROM ad_group_ad
         WHERE ad_group_ad.ad_group = '${adGroupResource}'
           AND ad_group_ad.ad.type = 'IMAGE_AD'
           AND ad_group_ad.status != 'REMOVED'
           AND ad_group_ad.ad.image_ad.image_asset.asset = '${assetRef.resourceName}'`);
      const duplicate = existing.find((r) => ((obj(obj(r.adGroupAd).ad).finalUrls as string[]) ?? []).includes(finalUrl));
      const info = {
        ad_group: { id: String(adGroupId), name: group.name, campaign: campaign.name },
        image: { asset_id: assetRef.assetId, name: asset.name, size: `${width}x${height}`, format_name: size?.name, file_kb: fileSize !== undefined ? round2(fileSize / 1024) : undefined },
        final_url: finalUrl,
        name: adName,
      };
      if (duplicate) {
        const dupAd = obj(obj(duplicate.adGroupAd).ad);
        return {
          content: [text(
            `Nada a fazer: o grupo ${adGroupId} já tem o anúncio de imagem ${dupAd.id} com este banner e esta URL ` +
            `(status ${obj(duplicate.adGroupAd).status}). Nenhuma escrita foi enviada.\n\n${formatJson(info)}`
          )],
        };
      }

      let result: Row;
      try {
        result = await client.mutateAdGroupAds(customerId, [{
          create: {
            adGroup: adGroupResource,
            status: "PAUSED",
            ad: { name: adName, finalUrls: [finalUrl], imageAd: { imageAsset: { asset: assetRef.resourceName } } },
          },
        }]);
      } catch (err) {
        return fail(`A API recusou o anúncio de imagem: ${(err as Error).message}\nNada foi criado.`);
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): anúncio de imagem validado pela API — nada foi gravado.\n\n${formatJson(info)}`)] };
      }
      const resource = (result.results as Row[] | undefined)?.[0]?.resourceName;
      if (!resource) return fail(`A API não confirmou a criação do anúncio (resposta sem resourceName).\n\n${formatJson(result)}`);
      return {
        content: [text(`Anúncio de imagem criado (PAUSADO): ${resource}\nAtive com update_ad_status quando revisar.\n\n${formatJson(info)}`)],
      };
    }
  );

  // ── list_youtube_video_links ───────────────────────────────────────

  mcp.registerTool(
    "list_youtube_video_links",
    {
      description: [
        "Lista os vínculos de vídeos do YouTube com a conta (data_link, tipo VIDEO). READ OPERATION.",
        "Vínculo = autorização para usar vídeo de um criador (ex.: parceria em Demand Gen).",
        "Status: REQUESTED (você pediu, aguardando o criador), PENDING_APPROVAL (o criador pediu, aguardando",
        "você), ENABLED (ativo), REJECTED, REVOKED, DISABLED. Aja com respond_youtube_video_link.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        status: z.enum(DATA_LINK_STATUSES).optional().describe("Filtra por status (ex.: PENDING_APPROVAL para pedidos a responder)."),
        format: formatSchema,
      },
    },
    async ({ customerId, status, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId,
        `SELECT ${DATA_LINK_FIELDS}
         FROM data_link
         WHERE data_link.type = 'VIDEO'${status ? ` AND data_link.status = '${status}'` : ""}`);
      const rows = results.map((r): Row => {
        const row = dataLinkRow(r);
        return { ...row, next_step: dataLinkNextStep(row.status) };
      });
      const rendered = renderRows(rows, format);
      if (rendered) return rendered;
      if (rows.length === 0) return { content: [text(`Nenhum vínculo de vídeo do YouTube${status ? ` com status ${status}` : ""} nesta conta.`)] };
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(String(r.status), (counts.get(String(r.status)) ?? 0) + 1);
      return {
        content: [text(`${rows.length} vínculo(s): ${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}.\n\n${formatJson(rows)}`)],
      };
    }
  );

  // ── request_youtube_video_link ─────────────────────────────────────

  mcp.registerTool(
    "request_youtube_video_link",
    {
      description: [
        "Pede a um criador do YouTube o vínculo de um vídeo dele com esta conta (DataLinkService.CreateDataLink).",
        "WRITE OPERATION — o nome e o ID da conta Google Ads são COMPARTILHADOS com o criador. Exige confirm: true;",
        "sem confirm mostra a prévia. O vínculo nasce REQUESTED e só vale depois que o criador aceitar.",
        "Se já existe vínculo ativo ou pendente para o vídeo, nada é enviado.",
        "Em dry-run/validateOnly só valida localmente: o endpoint não tem validate_only.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        video: z.string().describe("ID do vídeo (11 caracteres) ou URL do YouTube (watch?v=, youtu.be, shorts)."),
        channelId: z.string().optional().describe("Canal do vídeo ('UC' + 22 caracteres) — opcional, identifica o canal explicitamente."),
        brandChannelId: z.string().optional().describe("Canal da marca vinculado à conta ('UC...'), mostrado ao criador para identificar o anunciante."),
        confirm: z.boolean().optional().describe("Precisa ser true para enviar o pedido."),
      },
    },
    async ({ customerId, video, channelId, brandChannelId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const videoId = parseYouTubeVideoId(video);
      const problems: string[] = [];
      if (!videoId) problems.push(`"${video}" não é ID (11 caracteres) nem URL de vídeo do YouTube.`);
      if (channelId !== undefined && !YOUTUBE_CHANNEL_ID.test(channelId)) problems.push(`channelId "${channelId}" inválido ("UC" + 22 caracteres).`);
      if (brandChannelId !== undefined && !YOUTUBE_CHANNEL_ID.test(brandChannelId)) problems.push(`brandChannelId "${brandChannelId}" inválido ("UC" + 22 caracteres).`);
      if (problems.length) return fail(`Nada foi enviado:\n- ${problems.join("\n- ")}`);

      const client = getClient();
      const existing = (await client.searchStream(customerId,
        `SELECT ${DATA_LINK_FIELDS}
         FROM data_link
         WHERE data_link.type = 'VIDEO' AND data_link.youtube_video.video_id = '${gaqlLiteral(videoId!)}'`)).map(dataLinkRow);
      const active = existing.find((r) => ["REQUESTED", "PENDING_APPROVAL", "ENABLED"].includes(String(r.status)));
      if (active) {
        return {
          content: [text(
            `Nada a fazer: o vídeo ${videoId} já tem vínculo ${active.status} (${active.resource_name}) — ${dataLinkNextStep(active.status)}. ` +
            `Nenhuma escrita foi enviada.\n\n${formatJson(existing)}`
          )],
        };
      }
      const dataLink: Row = {
        youtubeVideo: { videoId, ...(channelId ? { channelId } : {}) },
        ...(brandChannelId ? { youtubeLinkMetadata: { brandChannelId } } : {}),
      };
      const plan = { video_id: videoId, video_url: `https://www.youtube.com/watch?v=${videoId}`, channel_id: channelId, brand_channel_id: brandChannelId, previous_links: existing };
      if (!confirm) {
        return fail(
          "Prévia — o pedido compartilha o nome e o ID desta conta Google Ads com o criador do vídeo. " +
          `Nada foi enviado. Para enviar, chame de novo com confirm: true.\n\n${formatJson(plan)}`
        );
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): nada foi enviado. CreateDataLink não tem validate_only; dados validados localmente.\n\n${formatJson(plan)}`)] };
      }
      let response: { resourceName?: string };
      try {
        response = await client.customerWriteAction<{ resourceName?: string }>(cid, "dataLinks:create", { dataLink });
      } catch (err) {
        return fail(`A API recusou o pedido de vínculo: ${explainDataLinkError((err as Error).message)}\nNada foi criado.`);
      }
      if (!response.resourceName) return fail(`A API não confirmou o pedido (resposta sem resourceName).\n\n${formatJson(response)}`);
      return {
        content: [text(
          `Pedido de vínculo enviado ao criador: ${response.resourceName} (status REQUESTED até o criador aceitar).\n` +
          `Acompanhe com list_youtube_video_links.\n\n${formatJson(plan)}`
        )],
      };
    }
  );

  // ── respond_youtube_video_link ─────────────────────────────────────

  mcp.registerTool(
    "respond_youtube_video_link",
    {
      description: [
        "Responde ou encerra um vínculo de vídeo do YouTube (DataLinkService.UpdateDataLink / RemoveDataLink).",
        "WRITE OPERATION.",
        "",
        "action: ACCEPT (pedido do criador PENDING_APPROVAL → ENABLED), REJECT (PENDING_APPROVAL → REJECTED),",
        "REVOKE (seu pedido REQUESTED → REVOKED) ou REMOVE (vínculo ENABLED → removido).",
        "REJECT, REVOKE e REMOVE exigem confirm: true (não dá para desfazer; um novo vínculo exige novo pedido).",
        "Confere o status atual antes: ação incompatível é recusada; vínculo já no status pedido não gera escrita.",
        "Em dry-run/validateOnly só mostra a prévia: o endpoint não tem validate_only.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        link: z.string().describe("Vínculo: resource name customers/{cid}/dataLinks/{productLinkId}~{dataLinkId} ou {productLinkId}~{dataLinkId}."),
        action: z.enum(DATA_LINK_ACTIONS).describe("ACCEPT, REJECT, REVOKE ou REMOVE."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para REJECT, REVOKE e REMOVE."),
      },
    },
    async ({ customerId, link, action, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const ref = parseDataLinkRef(link, cid);
      if ("error" in ref) return fail(`${ref.error} Nada foi alterado.`);
      const transition = DATA_LINK_TRANSITIONS[action as DataLinkAction];
      if (!transition) return fail(`action inválida: "${action}". Use ${DATA_LINK_ACTIONS.join(", ")}.`);

      const client = getClient();
      const rows = (await client.searchStream(customerId,
        `SELECT ${DATA_LINK_FIELDS}
         FROM data_link
         WHERE data_link.product_link_id = ${ref.productLinkId} AND data_link.data_link_id = ${ref.dataLinkId}`)).map(dataLinkRow);
      const current = rows[0];
      if (!current) return fail(`Vínculo ${ref.resourceName} não encontrado na conta ${cid}. Nada foi alterado. Veja list_youtube_video_links.`);
      const before = { ...current };
      if (transition.to && current.status === transition.to) {
        return { content: [text(`Nada a fazer: o vínculo já está ${current.status}. Nenhuma escrita foi enviada.\n\n${formatJson(before)}`)] };
      }
      if (current.status !== transition.from) {
        return fail(
          `Não dá para ${transition.label}: o vínculo está ${current.status}, e ${action} só vale a partir de ${transition.from}. ` +
          `${dataLinkNextStep(current.status)}. Nada foi alterado.\n\n${formatJson(before)}`
        );
      }
      const after = transition.to ? `status ${transition.from} → ${transition.to}` : "vínculo removido";
      if (transition.confirm && !confirm) {
        return fail(`Prévia — ${transition.label} (${after}) não tem volta. Nada foi alterado. Para aplicar, chame de novo com confirm: true.\n\n${formatJson(before)}`);
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): nada foi alterado. O DataLinkService não tem validate_only; seria aplicado: ${after}.\n\n${formatJson(before)}`)] };
      }
      let response: { resourceName?: string };
      try {
        response = transition.to
          ? await client.customerWriteAction<{ resourceName?: string }>(cid, "dataLinks:update", { resourceName: ref.resourceName, dataLinkStatus: transition.to })
          : await client.customerWriteAction<{ resourceName?: string }>(cid, "dataLinks:remove", { resourceName: ref.resourceName });
      } catch (err) {
        return fail(`A API recusou (${action}): ${explainDataLinkError((err as Error).message)}\nNada foi alterado.`);
      }
      if (!response.resourceName) return fail(`A API não confirmou (${action}) — resposta sem resourceName. Confira com list_youtube_video_links.\n\n${formatJson(response)}`);
      return {
        content: [text(`${action} aplicado em ${response.resourceName}: ${after}.\n\n${formatJson({ before, after: transition.to ? { ...before, status: transition.to } : null })}`)],
      };
    }
  );
}
