/**
 * Lote asset-library: Biblioteca de assets e locais do Perfil da Empresa.
 *
 * - Biblioteca: get_image_assets e get_video_assets (dimensões, proporção, orientação,
 *   política, origem, declaração de IA, filtros e paginação), get_asset_usage (onde o
 *   asset está em uso), upload_image_asset / upload_video_asset (com a declaração de
 *   conteúdo gerado por IA) e update_asset_synthetic_attestation.
 * - Locais: asset sets LOCATION_SYNC (Perfil da Empresa, redes/chains ou Place IDs do
 *   Maps) vinculados à conta, e grupos de locais (dinâmicos ou estáticos) vinculados a
 *   campanhas ou grupos de anúncios.
 *
 * Tudo conferido no v25 (protos oficiais e tests/fixtures/google-ads-v25-fields.json):
 * Asset.orientation (54) e Asset.synthetic_content_info (55), SyntheticContentAttestation
 * {status, source}, AssetSet/LocationSet/BusinessProfileLocationSet/ChainSet/MapsLocationSet,
 * CustomerAssetSet/CampaignAssetSet/AdGroupAssetSet/AssetSetAsset e as visões
 * campaign_aggregate_asset_view / channel_aggregate_asset_view.
 *
 * As quatro tools antigas (get_image_assets, get_video_assets, upload_image_asset,
 * upload_video_asset) já estão classificadas em src/read-only.ts; por isso não entram no
 * catálogo deste módulo, só as novas.
 */
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
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
  microsToMoney,
  num,
  parseImageAssetRef,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;

// ── Utilidades ───────────────────────────────────────────────────────

const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const fail = (message: string) => ({ content: [text(message)], isError: true });

/** customerId só com dígitos (aceita 123-456-7890); null quando inválido. */
function customerDigits(customerId: string): string | null {
  const cid = str(customerId).replace(/-/g, "").trim();
  return /^\d+$/.test(cid) ? cid : null;
}

/** Lista de IDs numéricos: devolve os IDs sem repetição ou os inválidos. */
function parseNumericIds(values: unknown, label: string): { ids: string[] } | { error: string } {
  const raw = ensureArray<unknown>(values).map((v) => str(v).trim()).filter(Boolean);
  const invalid = raw.filter((v) => !/^\d+$/.test(v));
  if (invalid.length) return { error: `${label} deve conter só IDs numéricos — inválido(s): ${invalid.join(", ")}.` };
  return { ids: [...new Set(raw)] };
}

/** Texto para REGEXP_MATCH sem diferenciar maiúsculas: escapa o RE2 e depois o literal GAQL. */
export function containsRegex(value: string): string {
  const escaped = value.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
  return gaqlLiteral(`(?i).*${escaped}.*`);
}

/** Achata arrays/objetos para table/csv. */
function flatRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (Array.isArray(value)) {
      out[key] = value
        .map((item) =>
          item && typeof item === "object"
            ? Object.values(item as Row).filter((v) => v !== undefined && v !== null && v !== "").join(":")
            : String(item)
        )
        .join("; ");
    } else if (value && typeof value === "object") {
      out[key] = Object.entries(value as Row).map(([k, v]) => `${k}=${str(v)}`).join("; ");
    } else {
      out[key] = value ?? "";
    }
  }
  return out;
}

function renderRows(
  format: "json" | "table" | "csv" | undefined,
  rows: Row[],
  header: string,
  payload: Row,
  footer?: string
) {
  if (format === "table" || format === "csv") {
    const flat = rows.map(flatRow);
    const body = format === "table" ? formatAsTable(flat) : formatAsCsv(flat);
    return { content: [text(body), ...(footer ? [text(footer)] : [])] };
  }
  return { content: [text(`${header}\n\n${formatJson(payload)}${footer ? `\n\n${footer}` : ""}`)] };
}

// ── Proporção, orientação, política e declaração de IA ──────────────

/** Proporções usadas pelos formatos de imagem do Google Ads (Pesquisa, Display, PMax, Demand Gen, logos). */
export const IMAGE_ASPECT_RATIOS = [
  { key: "1:1", ratio: 1, label: "1:1 (quadrada)" },
  { key: "1.91:1", ratio: 1.91, label: "1.91:1 (paisagem)" },
  { key: "4:5", ratio: 4 / 5, label: "4:5 (retrato)" },
  { key: "9:16", ratio: 9 / 16, label: "9:16 (vertical)" },
  { key: "16:9", ratio: 16 / 9, label: "16:9 (widescreen)" },
  { key: "4:1", ratio: 4, label: "4:1 (logo horizontal)" },
] as const;
type AspectKey = (typeof IMAGE_ASPECT_RATIOS)[number]["key"];
const ASPECT_KEYS = IMAGE_ASPECT_RATIOS.map((a) => a.key) as [AspectKey, ...AspectKey[]];

/** Proporção com tolerância de ±1% (a mesma das especificações de imagem do Google). */
export function classifyAspect(width: number, height: number): { key: AspectKey | null; label: string } {
  if (!width || !height) return { key: null, label: "desconhecida" };
  const ratio = width / height;
  for (const aspect of IMAGE_ASPECT_RATIOS) {
    if (Math.abs(ratio / aspect.ratio - 1) <= 0.01) return { key: aspect.key, label: aspect.label };
  }
  return { key: null, label: `${ratio.toFixed(2)}:1 (fora dos formatos padrão)` };
}

function orientationFromSize(width: number, height: number): string | null {
  if (!width || !height) return null;
  if (Math.abs(width / height - 1) <= 0.01) return "SQUARE";
  return width > height ? "LANDSCAPE" : "PORTRAIT";
}

function policyView(asset: Row) {
  const summary = obj(asset.policySummary);
  const topics = list(summary.policyTopicEntries)
    .map((entry) => {
      const e = obj(entry);
      return e.type ? `${str(e.topic)} (${str(e.type)})` : str(e.topic);
    })
    .filter(Boolean);
  const byFieldType = list(asset.fieldTypePolicySummaries).map((entry) => {
    const e = obj(entry);
    const info = obj(e.policySummaryInfo);
    return {
      field_type: e.assetFieldType ?? null,
      source: e.assetSource ?? null,
      approval_status: info.approvalStatus ?? null,
      review_status: info.reviewStatus ?? null,
    };
  });
  return {
    approval_status: summary.approvalStatus ?? null,
    review_status: summary.reviewStatus ?? null,
    policy_topics: topics,
    policy_by_field_type: byFieldType,
  };
}

export const NOT_DECLARED = "NAO_DECLARADO";

function advertiserAttestation(asset: Row): { status: string; source: string | null } {
  const adv = obj(obj(asset.syntheticContentInfo).advertiserAttestation);
  const status = str(adv.status);
  return {
    status: status === "IS_SYNTHETIC" || status === "NOT_SYNTHETIC" ? status : NOT_DECLARED,
    source: adv.source ? str(adv.source) : null,
  };
}

function attestationView(asset: Row) {
  const sys = obj(obj(asset.syntheticContentInfo).systemAttestation);
  const adv = advertiserAttestation(asset);
  return {
    ai_generated: adv.status,
    ai_attestation_source: adv.source,
    google_ai_detection: sys.status ? `${str(sys.status)}${sys.source ? ` (${str(sys.source)})` : ""}` : null,
  };
}

/** Bloco syntheticContentInfo do Asset (REST, v25): declaração do anunciante. */
function syntheticContentPayload(aiGenerated: boolean) {
  return {
    advertiserAttestation: {
      status: aiGenerated ? "IS_SYNTHETIC" : "NOT_SYNTHETIC",
      source: "ADVERTISER_ATTESTED",
    },
  };
}

/** Tipos de asset em que a v25 aceita synthetic_content_info (resources/asset.proto). */
const SYNTHETIC_ELIGIBLE_TYPES = new Set(["IMAGE", "MEDIA_BUNDLE", "YOUTUBE_VIDEO"]);

function explainSyntheticError(message: string): string {
  if (/immutable|cannot be set|IMMUTABLE_FIELD|FIELD_NOT_MUTABLE|unrecognized field|Unknown name "syntheticContentInfo"/i.test(message)) {
    return `${message}\nA API recusou gravar synthetic_content_info. Ele só é gravável a partir da v25 — confira GOOGLE_ADS_API_VERSION ` +
      "(padrão v25) e se o tipo do asset é IMAGE, MEDIA_BUNDLE ou YOUTUBE_VIDEO.";
  }
  return message;
}

// ── Listagem da biblioteca (imagens e vídeos) ───────────────────────

const COMMON_ASSET_FIELDS = [
  "asset.id",
  "asset.name",
  "asset.resource_name",
  "asset.type",
  "asset.source",
  "asset.orientation",
  "asset.policy_summary.approval_status",
  "asset.policy_summary.review_status",
  "asset.policy_summary.policy_topic_entries",
  "asset.field_type_policy_summaries",
  "asset.synthetic_content_info.advertiser_attestation.status",
  "asset.synthetic_content_info.advertiser_attestation.source",
  "asset.synthetic_content_info.system_attestation.status",
  "asset.synthetic_content_info.system_attestation.source",
];
const IMAGE_FIELDS = [
  "asset.image_asset.full_size.url",
  "asset.image_asset.full_size.width_pixels",
  "asset.image_asset.full_size.height_pixels",
  "asset.image_asset.mime_type",
  "asset.image_asset.file_size",
];
const VIDEO_FIELDS = ["asset.youtube_video_asset.youtube_video_id", "asset.youtube_video_asset.youtube_video_title"];

/** Teto de linhas varridas quando há filtro que o GAQL não expressa (proporção, "não declarado"). */
export const LIBRARY_SCAN_CAP = 5000;
const MAX_PAGE = 1000;

const orientationSchema = z.enum(["LANDSCAPE", "PORTRAIT", "SQUARE"]);
const approvalSchema = z.enum(["APPROVED", "APPROVED_LIMITED", "AREA_OF_INTEREST_ONLY", "DISAPPROVED"]);
const assetSourceSchema = z.enum(["ADVERTISER", "AUTOMATICALLY_CREATED"]);
const aiFilterSchema = z.enum(["IS_SYNTHETIC", "NOT_SYNTHETIC", "NAO_DECLARADO"]);

function imageRow(result: Row): Row {
  const asset = obj(result.asset);
  const image = obj(asset.imageAsset);
  const full = obj(image.fullSize);
  const width = num(full.widthPixels);
  const height = num(full.heightPixels);
  const aspect = classifyAspect(width, height);
  return {
    asset_id: str(asset.id),
    name: str(asset.name),
    resource_name: asset.resourceName ?? null,
    url: full.url ?? null,
    width: width || null,
    height: height || null,
    dimensions: width && height ? `${width}x${height}` : null,
    aspect_ratio: aspect.key,
    aspect_label: aspect.label,
    orientation: asset.orientation ?? orientationFromSize(width, height),
    mime_type: image.mimeType ?? null,
    file_size_kb: image.fileSize !== undefined ? round2(num(image.fileSize) / 1024) : null,
    source: asset.source ?? null,
    ...policyView(asset),
    ...attestationView(asset),
  };
}

function videoRow(result: Row): Row {
  const asset = obj(result.asset);
  const video = obj(asset.youtubeVideoAsset);
  const videoId = str(video.youtubeVideoId);
  return {
    asset_id: str(asset.id),
    name: str(asset.name),
    resource_name: asset.resourceName ?? null,
    youtube_video_id: videoId || null,
    youtube_url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    title: video.youtubeVideoTitle ?? null,
    orientation: asset.orientation ?? null,
    source: asset.source ?? null,
    ...policyView(asset),
    ...attestationView(asset),
  };
}

/** Uso por asset nas visões agregadas por canal (sem data: vínculos atuais). */
async function usageByAsset(client: GoogleAdsClient, cid: string, assetIds: string[]) {
  const usage = new Map<string, { linked_entities: number; by_channel: Record<string, number> }>();
  if (assetIds.length === 0) return usage;
  const rows = await client.searchStream(cid,
    `SELECT asset.id, channel_aggregate_asset_view.advertising_channel_type,
            channel_aggregate_asset_view.field_type, metrics.linked_entities_count
     FROM channel_aggregate_asset_view
     WHERE asset.id IN (${assetIds.join(", ")})`);
  for (const row of rows) {
    const id = str(obj(row.asset).id);
    const view = obj(row.channelAggregateAssetView);
    const count = num(obj(row.metrics).linkedEntitiesCount);
    const entry = usage.get(id) ?? { linked_entities: 0, by_channel: {} };
    entry.linked_entities += count;
    const channel = str(view.advertisingChannelType) || "DESCONHECIDO";
    entry.by_channel[channel] = (entry.by_channel[channel] ?? 0) + count;
    usage.set(id, entry);
  }
  return usage;
}

interface LibraryArgs {
  customerId: string;
  assetIds?: unknown;
  youtubeVideoIds?: unknown;
  nameContains?: string;
  titleContains?: string;
  orientation?: string;
  aspectRatio?: AspectKey;
  minWidth?: number;
  minHeight?: number;
  mimeType?: string;
  approvalStatus?: string;
  source?: string;
  aiGenerated?: string;
  includeUsage?: boolean;
  limit?: number;
  afterAssetId?: string;
  format?: "json" | "table" | "csv";
}

async function listLibrary(ctx: ToolContext, kind: "IMAGE" | "YOUTUBE_VIDEO", args: LibraryArgs, defaultLimit: number) {
  const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
  if (blocked) return { content: [blocked], isError: true };
  const cid = customerDigits(args.customerId);
  if (!cid) return fail(`customerId inválido: "${args.customerId}".`);

  const limit = args.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    return fail(`limit deve ser um inteiro entre 1 e ${MAX_PAGE} (recebido ${args.limit}).`);
  }
  if (args.afterAssetId !== undefined && !/^\d+$/.test(str(args.afterAssetId))) {
    return fail(`afterAssetId deve ser o ID numérico devolvido em next_cursor (recebido "${args.afterAssetId}").`);
  }
  for (const [key, value] of [["minWidth", args.minWidth], ["minHeight", args.minHeight]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) return fail(`${key} deve ser um inteiro positivo (recebido ${value}).`);
  }

  const where = [`asset.type = '${kind}'`];
  const filters: Row = {};
  if (args.assetIds !== undefined) {
    const parsed = parseNumericIds(args.assetIds, "assetIds");
    if ("error" in parsed) return fail(parsed.error);
    if (parsed.ids.length > MAX_PAGE) return fail(`No máximo ${MAX_PAGE} assetIds por chamada.`);
    if (parsed.ids.length) {
      where.push(`asset.id IN (${parsed.ids.join(", ")})`);
      filters.asset_ids = parsed.ids;
    }
  }
  if (kind === "YOUTUBE_VIDEO" && args.youtubeVideoIds !== undefined) {
    const raw = ensureArray<unknown>(args.youtubeVideoIds).map((v) => str(v).trim()).filter(Boolean);
    const ids = raw.map((v) => parseYoutubeVideoId(v));
    const invalid = raw.filter((_, i) => !ids[i]);
    if (invalid.length) return fail(`youtubeVideoIds inválido(s): ${invalid.join(", ")} (use o ID de 11 caracteres ou a URL do vídeo).`);
    if (ids.length) {
      where.push(`asset.youtube_video_asset.youtube_video_id IN (${[...new Set(ids)].map((id) => `'${id}'`).join(", ")})`);
      filters.youtube_video_ids = [...new Set(ids)];
    }
  }
  if (args.nameContains?.trim()) {
    where.push(`asset.name REGEXP_MATCH '${containsRegex(args.nameContains.trim())}'`);
    filters.name_contains = args.nameContains.trim();
  }
  if (kind === "YOUTUBE_VIDEO" && args.titleContains?.trim()) {
    where.push(`asset.youtube_video_asset.youtube_video_title REGEXP_MATCH '${containsRegex(args.titleContains.trim())}'`);
    filters.title_contains = args.titleContains.trim();
  }
  if (args.orientation) {
    where.push(`asset.orientation = '${args.orientation}'`);
    filters.orientation = args.orientation;
  }
  if (kind === "IMAGE") {
    if (args.minWidth) {
      where.push(`asset.image_asset.full_size.width_pixels >= ${args.minWidth}`);
      filters.min_width = args.minWidth;
    }
    if (args.minHeight) {
      where.push(`asset.image_asset.full_size.height_pixels >= ${args.minHeight}`);
      filters.min_height = args.minHeight;
    }
    if (args.mimeType) {
      where.push(`asset.image_asset.mime_type = '${args.mimeType}'`);
      filters.mime_type = args.mimeType;
    }
  }
  if (args.approvalStatus) {
    where.push(`asset.policy_summary.approval_status = '${args.approvalStatus}'`);
    filters.approval_status = args.approvalStatus;
  }
  if (args.source) {
    where.push(`asset.source = '${args.source}'`);
    filters.source = args.source;
  }
  if (args.aiGenerated === "IS_SYNTHETIC" || args.aiGenerated === "NOT_SYNTHETIC") {
    where.push(`asset.synthetic_content_info.advertiser_attestation.status = '${args.aiGenerated}'`);
  }
  if (args.aiGenerated) filters.ai_generated = args.aiGenerated;
  if (args.afterAssetId) where.push(`asset.id > ${args.afterAssetId}`);

  // Filtros que o GAQL não expressa rodam aqui, sobre uma varredura limitada
  const aspect = kind === "IMAGE" ? args.aspectRatio : undefined;
  if (aspect) filters.aspect_ratio = aspect;
  const notDeclared = args.aiGenerated === NOT_DECLARED;
  const clientSide = Boolean(aspect) || notDeclared;

  const fields = [...COMMON_ASSET_FIELDS, ...(kind === "IMAGE" ? IMAGE_FIELDS : VIDEO_FIELDS)];
  const client = ctx.getClient();
  const raw = await client.searchStream(cid,
    `SELECT ${fields.join(", ")}
     FROM asset
     WHERE ${where.join(" AND ")}
     ORDER BY asset.id
     LIMIT ${clientSide ? LIBRARY_SCAN_CAP : limit + 1}`);

  const toRow = kind === "IMAGE" ? imageRow : videoRow;
  const allRows = raw.map(toRow);
  const matched = allRows.filter((row) => {
    if (aspect && row.aspect_ratio !== aspect) return false;
    if (notDeclared && row.ai_generated !== NOT_DECLARED) return false;
    return true;
  });
  const page = matched.slice(0, limit);
  let nextCursor: string | null = null;
  let scanCapped = false;
  if (matched.length > limit) {
    nextCursor = str(page[page.length - 1].asset_id);
  } else if (clientSide && raw.length >= LIBRARY_SCAN_CAP) {
    // A varredura parou no teto sem completar a página: continua de onde parou
    nextCursor = str(allRows[allRows.length - 1].asset_id);
    scanCapped = true;
  }

  let usageError: string | null = null;
  if (args.includeUsage && page.length) {
    try {
      const usage = await usageByAsset(client, cid, page.map((row) => str(row.asset_id)));
      for (const row of page) {
        const entry = usage.get(str(row.asset_id));
        row.linked_entities = entry?.linked_entities ?? 0;
        row.linked_by_channel = entry?.by_channel ?? {};
        row.in_use = (entry?.linked_entities ?? 0) > 0;
      }
    } catch (err) {
      usageError = (err as Error).message;
    }
  }

  const noun = kind === "IMAGE" ? "imagem(ns)" : "vídeo(s)";
  const header = `${page.length} ${noun}${nextCursor ? ` — há mais: repita com afterAssetId=${nextCursor}` : ""}.` +
    (scanCapped ? ` Varredura parou em ${LIBRARY_SCAN_CAP} assets sem completar a página; continue com o cursor.` : "");
  const footer = [
    nextCursor ? `next_cursor: ${nextCursor} (passe em afterAssetId)` : "",
    usageError ? `Uso (includeUsage) não carregado: ${usageError}` : "",
  ].filter(Boolean).join("\n");
  return renderRows(args.format, page, header, {
    filters,
    count: page.length,
    next_cursor: nextCursor,
    ...(clientSide ? { scanned: raw.length } : {}),
    ...(usageError ? { usage_error: usageError } : {}),
    [kind === "IMAGE" ? "images" : "videos"]: page,
  }, footer || undefined);
}

// ── get_asset_usage: classificação dos vínculos ─────────────────────

/** Seções de get_asset_usage que dizem se o asset está vinculado (performance fica de fora). */
const USAGE_LINK_SECTIONS = ["customer", "campaign", "ad_group", "asset_group", "ads", "asset_set", "aggregate"];

/**
 * Estado de UM vínculo, classificado uma única vez (ativo, pausado e inativo são disjuntos).
 * - ads (ad_group_ad_asset_view): só conta se o asset está na versão atual do anúncio
 *   (enabled = true); ativo se o anúncio está ENABLED, pausado se PAUSED; o resto é inativo.
 * - demais níveis: status do próprio vínculo (ENABLED = ativo, PAUSED = pausado).
 */
export function classifyUsageLink(level: string, row: Row): "active" | "paused" | "inactive" {
  if (level === "ads") {
    if (row.enabled !== true) return "inactive";
    if (row.ad_status === "ENABLED") return "active";
    if (row.ad_status === "PAUSED") return "paused";
    return "inactive";
  }
  if (row.status === "ENABLED") return "active";
  if (row.status === "PAUSED") return "paused";
  return "inactive";
}

// ── Upload: validação local da imagem e do vídeo ────────────────────

/** Formato e dimensões lidos do cabeçalho do arquivo (PNG, GIF, JPEG); sem decodificar a imagem. */
export function sniffImage(bytes: Buffer): { format: string | null; width?: number; height?: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "PNG", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const head = bytes.subarray(0, 6).toString("latin1");
  if ((head === "GIF87a" || head === "GIF89a") && bytes.length >= 10) {
    return { format: "GIF", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { format: "JPEG", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      offset += 2 + length;
    }
    return { format: "JPEG" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { format: "WEBP" };
  }
  return { format: null };
}

/** Base64 da imagem: aceita data URL, quebras de linha e o alfabeto URL-safe. */
export function normalizeImageBase64(input: string): { base64: string; bytes: Buffer } | { error: string } {
  let value = str(input).trim();
  const dataUrl = /^data:[^,]*,/i.exec(value);
  if (dataUrl) {
    if (!/;base64,$/i.test(dataUrl[0])) return { error: "imageBase64 é uma data URL sem ;base64 — envie o conteúdo em base64." };
    value = value.slice(dataUrl[0].length);
  }
  value = value.replace(/\s+/g, "");
  if (!value) return { error: "imageBase64 está vazio." };
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return { error: "imageBase64 não é base64 válido (caracteres fora do alfabeto base64)." };
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) return { error: "imageBase64 não decodificou em nenhum byte." };
  return { base64: value, bytes };
}

/** ID de vídeo do YouTube (11 caracteres) a partir do ID ou de uma URL watch/shorts/embed/youtu.be. */
export function parseYoutubeVideoId(input: string): string | null {
  const value = str(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Limite de arquivo das imagens do Google Ads (5120 KB); acima disso a API deve recusar. */
const IMAGE_MAX_BYTES = 5120 * 1024;

// ── Asset sets de locais ─────────────────────────────────────────────

const LOCATION_GROUP_TYPES = [
  "BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP",
  "CHAIN_DYNAMIC_LOCATION_GROUP",
  "STATIC_LOCATION_GROUP",
] as const;
const LOCATION_SET_TYPES = ["LOCATION_SYNC", ...LOCATION_GROUP_TYPES] as const;
const LOCATION_SET_TYPE_LIST = LOCATION_SET_TYPES.map((t) => `'${t}'`).join(", ");

const ASSET_SET_FIELDS = [
  "asset_set.id",
  "asset_set.name",
  "asset_set.type",
  "asset_set.status",
  "asset_set.resource_name",
  "asset_set.location_group_parent_asset_set_id",
  "asset_set.location_set.location_ownership_type",
  "asset_set.location_set.business_profile_location_set.business_name_filter",
  "asset_set.location_set.business_profile_location_set.label_filters",
  "asset_set.location_set.business_profile_location_set.listing_id_filters",
  "asset_set.location_set.chain_location_set.relationship_type",
  "asset_set.business_profile_location_group.dynamic_business_profile_location_group_filter.label_filters",
  "asset_set.business_profile_location_group.dynamic_business_profile_location_group_filter.listing_id_filters",
  "asset_set.business_profile_location_group.dynamic_business_profile_location_group_filter.business_name_filter.business_name",
  "asset_set.business_profile_location_group.dynamic_business_profile_location_group_filter.business_name_filter.filter_type",
].join(", ");

/** Origem da sincronização de um LOCATION_SYNC (o oneof LocationSet.source). */
function syncSource(set: Row): "BUSINESS_PROFILE" | "CHAIN" | null {
  const locationSet = obj(set.locationSet);
  if ("businessProfileLocationSet" in locationSet) return "BUSINESS_PROFILE";
  if ("chainLocationSet" in locationSet) return "CHAIN";
  return null;
}

function assetSetView(set: Row): Row {
  const locationSet = obj(set.locationSet);
  const bp = obj(locationSet.businessProfileLocationSet);
  const chain = obj(locationSet.chainLocationSet);
  const group = obj(obj(set.businessProfileLocationGroup).dynamicBusinessProfileLocationGroupFilter);
  const nameFilter = obj(group.businessNameFilter);
  const filters: Row = {};
  if (bp.businessNameFilter) filters.business_name = bp.businessNameFilter;
  if (list(bp.labelFilters).length) filters.labels = bp.labelFilters;
  if (list(bp.listingIdFilters).length) filters.listing_ids = bp.listingIdFilters;
  if (chain.relationshipType) filters.chain_relationship = chain.relationshipType;
  if (list(group.labelFilters).length) filters.labels = group.labelFilters;
  if (list(group.listingIdFilters).length) filters.listing_ids = group.listingIdFilters;
  if (nameFilter.businessName) filters.business_name = `${str(nameFilter.businessName)}${nameFilter.filterType ? ` (${str(nameFilter.filterType)})` : ""}`;
  const source = syncSource(set);
  return {
    asset_set_id: str(set.id),
    name: set.name ?? null,
    type: set.type ?? null,
    status: set.status ?? null,
    resource_name: set.resourceName ?? null,
    ...(set.type === "LOCATION_SYNC"
      ? {
          ownership: locationSet.locationOwnershipType ?? null,
          sync_source: source ?? "NAO_IDENTIFICADA (Place IDs do Maps, ou Perfil da Empresa sem filtros)",
        }
      : { parent_asset_set_id: set.locationGroupParentAssetSetId ? str(set.locationGroupParentAssetSetId) : null }),
    filters,
  };
}

async function fetchAssetSet(client: GoogleAdsClient, cid: string, assetSetId: string): Promise<Row | null> {
  const rows = await client.searchStream(cid, `SELECT ${ASSET_SET_FIELDS} FROM asset_set WHERE asset_set.id = ${assetSetId}`);
  const set = obj(rows[0]?.assetSet);
  return set.id !== undefined ? set : null;
}

async function enabledSyncSets(client: GoogleAdsClient, cid: string): Promise<Row[]> {
  const rows = await client.searchStream(cid,
    `SELECT ${ASSET_SET_FIELDS} FROM asset_set
     WHERE asset_set.type = 'LOCATION_SYNC' AND asset_set.status = 'ENABLED'`);
  return rows.map((row) => obj(row.assetSet));
}

async function enabledSetsNamed(client: GoogleAdsClient, cid: string, name: string): Promise<Row[]> {
  const rows = await client.searchStream(cid,
    `SELECT asset_set.id, asset_set.name, asset_set.type FROM asset_set
     WHERE asset_set.name = '${gaqlLiteral(name)}' AND asset_set.status = 'ENABLED'`);
  return rows.map((row) => obj(row.assetSet));
}

/** Vínculos ATIVOS de um asset set (conta, campanhas, grupos de anúncios). */
async function fetchSetLinks(client: GoogleAdsClient, cid: string, setResource: string) {
  const rn = gaqlLiteral(setResource);
  const [customerRows, campaignRows, adGroupRows] = await Promise.all([
    client.searchStream(cid,
      `SELECT customer_asset_set.asset_set, customer_asset_set.status, customer_asset_set.resource_name
       FROM customer_asset_set
       WHERE customer_asset_set.asset_set = '${rn}' AND customer_asset_set.status = 'ENABLED'`),
    client.searchStream(cid,
      `SELECT campaign_asset_set.campaign, campaign_asset_set.status, campaign_asset_set.resource_name,
              campaign.id, campaign.name
       FROM campaign_asset_set
       WHERE campaign_asset_set.asset_set = '${rn}' AND campaign_asset_set.status = 'ENABLED'`),
    client.searchStream(cid,
      `SELECT ad_group_asset_set.ad_group, ad_group_asset_set.status, ad_group_asset_set.resource_name,
              ad_group.id, ad_group.name, campaign.id
       FROM ad_group_asset_set
       WHERE ad_group_asset_set.asset_set = '${rn}' AND ad_group_asset_set.status = 'ENABLED'`),
  ]);
  return {
    customer: customerRows.map((row) => ({ resource_name: str(obj(row.customerAssetSet).resourceName) })),
    campaigns: campaignRows.map((row) => ({
      campaign_id: str(obj(row.campaign).id),
      campaign_name: obj(row.campaign).name ?? null,
      resource_name: str(obj(row.campaignAssetSet).resourceName),
    })),
    adGroups: adGroupRows.map((row) => ({
      ad_group_id: str(obj(row.adGroup).id),
      ad_group_name: obj(row.adGroup).name ?? null,
      campaign_id: str(obj(row.campaign).id),
      resource_name: str(obj(row.adGroupAssetSet).resourceName),
    })),
  };
}

/** Grupos de locais ativos cujo pai é este LOCATION_SYNC. */
async function enabledChildGroups(client: GoogleAdsClient, cid: string, assetSetId: string): Promise<Row[]> {
  const rows = await client.searchStream(cid,
    `SELECT asset_set.id, asset_set.name, asset_set.type, asset_set.status FROM asset_set
     WHERE asset_set.location_group_parent_asset_set_id = ${assetSetId} AND asset_set.status = 'ENABLED'`);
  return rows.map((row) => {
    const set = obj(row.assetSet);
    return { asset_set_id: str(set.id), name: set.name ?? null, type: set.type ?? null };
  });
}

async function fetchCampaigns(client: GoogleAdsClient, cid: string, ids: string[]) {
  const rows = await client.searchStream(cid,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
     FROM campaign WHERE campaign.id IN (${ids.join(", ")})`);
  const found = new Map<string, Row>();
  for (const row of rows) found.set(str(obj(row.campaign).id), obj(row.campaign));
  return found;
}

async function fetchAdGroups(client: GoogleAdsClient, cid: string, ids: string[]) {
  const rows = await client.searchStream(cid,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name
     FROM ad_group WHERE ad_group.id IN (${ids.join(", ")})`);
  const found = new Map<string, Row>();
  for (const row of rows) found.set(str(obj(row.adGroup).id), { ...obj(row.adGroup), campaign: obj(row.campaign) });
  return found;
}

/** Converte o ID de ficha do Perfil da Empresa (uint64) para o int64 que a API espera. */
export function toSignedInt64(value: string): string | null {
  const v = str(value).trim();
  if (/^-\d+$/.test(v)) {
    const n = BigInt(v);
    return n >= -(2n ** 63n) ? n.toString() : null;
  }
  if (!/^\d+$/.test(v)) return null;
  const n = BigInt(v);
  if (n >= 2n ** 64n) return null;
  return (n >= 2n ** 63n ? n - 2n ** 64n : n).toString();
}

const chainSchema = z.object({
  chainId: z.union([z.string(), z.number()]).describe("ID da rede (chain) do Google."),
  locationAttributes: z.array(z.string()).optional().describe("Atributos de local da rede (opcional; todos precisam bater)."),
});

function parseChains(values: unknown): { chains: Array<{ chainId: string; locationAttributes?: string[] }> } | { error: string } {
  const chains: Array<{ chainId: string; locationAttributes?: string[] }> = [];
  for (const item of ensureArray<unknown>(values)) {
    const entry = obj(item);
    const chainId = str(entry.chainId ?? (typeof item === "string" || typeof item === "number" ? item : "")).trim();
    if (!/^\d+$/.test(chainId)) return { error: `chainId inválido: "${chainId}" (esperado ID numérico da rede).` };
    const attributes = ensureArray<unknown>(entry.locationAttributes).map((a) => str(a).trim()).filter(Boolean);
    chains.push({ chainId, ...(attributes.length ? { locationAttributes: attributes } : {}) });
  }
  return { chains };
}

function parseListingIds(values: unknown): { ids: string[] } | { error: string } {
  const raw = ensureArray<unknown>(values).map((v) => str(v).trim()).filter(Boolean);
  const ids: string[] = [];
  for (const value of raw) {
    const converted = toSignedInt64(value);
    if (converted === null) return { error: `listingId inválido: "${value}" (esperado o ID numérico da ficha no Perfil da Empresa).` };
    ids.push(converted);
  }
  return { ids: [...new Set(ids)] };
}

/** Explica em PT-BR as recusas documentadas de asset sets de locais (errors/*.proto da v25). */
export function explainLocationError(message: string): string {
  const hints: Array<[RegExp, string]> = [
    [/OAUTH_INFO_INVALID|OAuth info is invalid/i,
      "O Google recusou o token do Perfil da Empresa. Gere um access token OAuth 2.0 com o escopo " +
      "https://www.googleapis.com/auth/business.manage para a MESMA conta Google do e-mail informado (o token expira em ~1 hora)."],
    [/OAUTH_INFO_MISSING|OAuth info is missing/i, "Faltou o token OAuth do Perfil da Empresa (businessProfileAccessToken)."],
    [/NOT_UNIQUE_ENABLED_LOCATION_SYNC|more than one enabled LocationSync/i,
      "Só pode haver um LOCATION_SYNC ativo por conta: remova o atual (unlink_location_asset_set + remove_location_asset_set) antes."],
    [/INVALID_CHAIN_IDS|chain id\(s\)/i, "Algum chainId não é uma rede válida do Google."],
    [/LOCATION_SYNC_ASSET_SET_DOES_NOT_SUPPORT_RELATIONSHIP_TYPE|does not support relationship|relationship type in ChainSet/i,
      "O tipo de relação (chainRelationshipType) não é aceito para essas redes."],
    [/INVALID_PLACE_IDS|place id\(s\)/i, "Algum Place ID do Maps é inválido."],
    [/DUPLICATE_ASSET_SET_NAME|matches that of another enabled asset set/i, "Já existe um asset set ativo com esse nome; use outro nome."],
    [/INVALID_PARENT_ASSET_SET_TYPE|ASSET_SET_SOURCE_INCOMPATIBLE_WITH_PARENT|does not match the type of AssetSet\.location_set|doesn't match its parent/i,
      "O tipo do grupo não combina com a origem do LOCATION_SYNC pai: grupo dinâmico do Perfil da Empresa exige pai do Perfil da Empresa; " +
      "grupo dinâmico de rede exige pai de redes; pai com Place IDs do Maps só aceita grupo estático."],
    [/CANNOT_DELETE_AS_ENABLED_LINKAGES_EXIST|enabled linkages/i,
      "O asset set ainda tem vínculos ativos ou grupos filhos ativos: desvincule com unlink_location_asset_set e remova os grupos antes."],
    [/PARENT_LINKAGE_DOES_NOT_EXIST|linkage between the parent LocationSync/i,
      "Algum location asset não pertence ao LOCATION_SYNC pai (confira com list_location_assets assetSetId=<pai>)."],
    [/INCOMPATIBLE_ADVERTISING_CHANNEL_TYPE|channel-based restrictions|INCOMPATIBLE_ASSET_SET_TYPE_WITH_CAMPAIGN_TYPE|asset set type and campaign type are incompatible/i,
      "O tipo de campanha não aceita este asset set de locais."],
    [/DUPLICATE_ASSET_SET_LINK|duplicate asset sets to the same campaign/i, "Esse asset set já está vinculado a essa campanha."],
    [/ASSET_SET_LINK_CANNOT_BE_REMOVED|linked with only one asset set/i,
      "A API não deixa desvincular o único asset set da campanha; vincule outro grupo antes ou pause/remova a campanha."],
    [/ASSET_SET_TYPE_CANNOT_BE_LINKED_TO_CUSTOMER|cannot be linked to CustomerAssetSet/i,
      "Só o LOCATION_SYNC vincula na conta; grupos de locais vinculam em campanha ou grupo de anúncios."],
    [/NOT_ALLOWLISTED|allowlist/i, "Recurso restrito a contas liberadas (allowlist) pelo Google."],
  ];
  const extra = hints.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return extra.length ? `${message}\n${extra.join("\n")}` : message;
}

/** Tira um segredo de qualquer texto que volte ao usuário. */
function redact(message: string, secret?: string): string {
  return secret && secret.length >= 4 ? message.split(secret).join("[token omitido]") : message;
}

const levelSchema = z.enum(["CUSTOMER", "CAMPAIGN", "AD_GROUP"]);
const MAX_LINK_TARGETS = 50;
const MAX_STATIC_ASSETS = 1000;

/** Alvos (campanhas ou grupos de anúncios) conforme o nível; valida antes de qualquer chamada. */
function parseTargets(
  level: string,
  campaignIds: unknown,
  adGroupIds: unknown
): { ids: string[] } | { error: string } {
  if (level === "CUSTOMER") {
    if (ensureArray(campaignIds).length || ensureArray(adGroupIds).length) {
      return { error: "level=CUSTOMER não usa campaignIds nem adGroupIds." };
    }
    return { ids: [] };
  }
  const values = level === "CAMPAIGN" ? campaignIds : adGroupIds;
  const other = level === "CAMPAIGN" ? adGroupIds : campaignIds;
  const label = level === "CAMPAIGN" ? "campaignIds" : "adGroupIds";
  if (ensureArray(other).length) return { error: `level=${level} usa só ${label}.` };
  const parsed = parseNumericIds(values, label);
  if ("error" in parsed) return parsed;
  if (parsed.ids.length === 0) return { error: `level=${level} exige ${label} (ao menos um).` };
  if (parsed.ids.length > MAX_LINK_TARGETS) return { error: `No máximo ${MAX_LINK_TARGETS} ${label} por chamada.` };
  return parsed;
}

// ── Registro ─────────────────────────────────────────────────────────

export function registerAssetLibraryTools(ctx: ToolContext): void {
  const { mcp } = ctx;

  // ── get_image_assets ────────────────────────────────────────────────

  mcp.registerTool(
    "get_image_assets",
    {
      description: [
        "Lista as imagens da biblioteca de assets da conta, com URL, dimensões, proporção (1:1, 1.91:1, 4:5, 9:16,",
        "16:9, 4:1), orientação, MIME, tamanho, origem, status de política (geral e por tipo de campo) e a",
        "declaração de conteúdo gerado por IA (ai_generated: IS_SYNTHETIC, NOT_SYNTHETIC ou NAO_DECLARADO).",
        "READ OPERATION.",
        "",
        "Filtros: assetIds, nameContains (sem diferenciar maiúsculas), orientation, aspectRatio, minWidth/minHeight,",
        "mimeType, approvalStatus (ex.: DISAPPROVED), source, aiGenerated. Paginação por cursor: a resposta traz",
        "next_cursor; repita com afterAssetId=<next_cursor>. includeUsage=true soma os vínculos de cada imagem",
        "(linked_entities, por canal) — detalhe completo em get_asset_usage.",
        "aspectRatio e aiGenerated=NAO_DECLARADO filtram depois da consulta, varrendo até 5000 assets por chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetIds: flexArray(z.string()).optional().describe("Só estes IDs de asset."),
        nameContains: z.string().optional().describe("Trecho do nome do asset (sem diferenciar maiúsculas)."),
        orientation: orientationSchema.optional().describe("Orientação calculada pelo Google."),
        aspectRatio: z.enum(ASPECT_KEYS).optional().describe("Proporção com tolerância de ±1%."),
        minWidth: z.number().optional().describe("Largura mínima em pixels."),
        minHeight: z.number().optional().describe("Altura mínima em pixels."),
        mimeType: z.enum(["IMAGE_JPEG", "IMAGE_PNG", "IMAGE_GIF"]).optional().describe("Formato do arquivo."),
        approvalStatus: approvalSchema.optional().describe("Status geral de política."),
        source: assetSourceSchema.optional().describe("ADVERTISER (enviado) ou AUTOMATICALLY_CREATED (gerado pelo Google)."),
        aiGenerated: aiFilterSchema.optional().describe("Declaração do anunciante sobre conteúdo gerado por IA."),
        includeUsage: z.boolean().optional().describe("true = inclui quantos vínculos cada imagem tem (por canal)."),
        limit: z.number().optional().describe("Tamanho da página (1–1000). Default: 50."),
        afterAssetId: z.string().optional().describe("Cursor: o next_cursor da página anterior."),
        format: formatSchema,
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      return listLibrary(ctx, "IMAGE", args as LibraryArgs, 50);
    }
  );

  // ── get_video_assets ────────────────────────────────────────────────

  mcp.registerTool(
    "get_video_assets",
    {
      description: [
        "Lista os vídeos do YouTube cadastrados como assets na conta: ID e URL do vídeo, título, orientação,",
        "origem, status de política (geral e por tipo de campo) e a declaração de conteúdo gerado por IA.",
        "READ OPERATION.",
        "",
        "Filtros: assetIds, youtubeVideoIds (ID ou URL), nameContains, titleContains, orientation, approvalStatus,",
        "source, aiGenerated. Paginação: next_cursor → afterAssetId. includeUsage=true soma os vínculos de cada",
        "vídeo (detalhe em get_asset_usage).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetIds: flexArray(z.string()).optional().describe("Só estes IDs de asset."),
        youtubeVideoIds: flexArray(z.string()).optional().describe("IDs (11 caracteres) ou URLs de vídeos do YouTube."),
        nameContains: z.string().optional().describe("Trecho do nome do asset (sem diferenciar maiúsculas)."),
        titleContains: z.string().optional().describe("Trecho do título do vídeo (sem diferenciar maiúsculas)."),
        orientation: orientationSchema.optional().describe("Orientação do vídeo."),
        approvalStatus: approvalSchema.optional().describe("Status geral de política."),
        source: assetSourceSchema.optional().describe("ADVERTISER ou AUTOMATICALLY_CREATED."),
        aiGenerated: aiFilterSchema.optional().describe("Declaração do anunciante sobre conteúdo gerado por IA."),
        includeUsage: z.boolean().optional().describe("true = inclui quantos vínculos cada vídeo tem (por canal)."),
        limit: z.number().optional().describe("Tamanho da página (1–1000). Default: 20."),
        afterAssetId: z.string().optional().describe("Cursor: o next_cursor da página anterior."),
        format: formatSchema,
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      return listLibrary(ctx, "YOUTUBE_VIDEO", args as LibraryArgs, 20);
    }
  );

  // ── get_asset_usage ─────────────────────────────────────────────────

  mcp.registerTool(
    "get_asset_usage",
    {
      description: [
        "Onde um asset (imagem, vídeo, texto, sitelink, local...) está em uso: vínculos na conta, em campanhas,",
        "grupos de anúncios, asset groups de PMax, anúncios (RSA, Demand Gen, App) e asset sets — com status,",
        "tipo de campo e origem de cada vínculo — e se está sem uso. READ OPERATION.",
        "",
        "Também traz a visão agregada por campanha (linked_entities_count, cobre anúncios responsivos de Display)",
        "e, com includePerformance (default true), impressões/cliques/custo/conversões por campanha no período.",
        "Vínculos REMOVED ficam de fora, salvo includeRemoved=true.",
        "",
        "Veredito (summary.in_use): true = há vínculo ativo; false = só vínculos pausados ou nenhum vínculo;",
        "null = indeterminado — alguma seção de vínculo falhou e nas outras não havia vínculo ativo (a resposta",
        "vem como erro, com section_errors; não trate o asset como sem uso). Em anúncios, ativo = asset na versão",
        "atual do anúncio e anúncio ENABLED; anúncio PAUSED conta como vínculo pausado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetId: z.string().describe("ID numérico do asset ou resource name (customers/{id}/assets/{assetId})."),
        includeRemoved: z.boolean().optional().describe("true = mostra também vínculos removidos."),
        includePerformance: z.boolean().optional().describe("false = pula as métricas do período. Default: true."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, assetId, includeRemoved, includePerformance, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const parsed = parseImageAssetRef(str(assetId), cid);
      if ("error" in parsed) return fail(parsed.error);
      let dateClause: string | null = null;
      if (includePerformance !== false) {
        try {
          dateClause = buildDateClause(dateRange, days);
        } catch (err) {
          return fail((err as Error).message);
        }
      }

      const client = ctx.getClient();
      const assetRows = await client.searchStream(cid,
        `SELECT asset.id, asset.name, asset.type, asset.resource_name, asset.source,
                asset.policy_summary.approval_status, asset.policy_summary.review_status,
                asset.policy_summary.policy_topic_entries, asset.field_type_policy_summaries
         FROM asset WHERE asset.id = ${parsed.assetId}`);
      const asset = obj(assetRows[0]?.asset);
      if (asset.id === undefined) return fail(`Asset ${parsed.assetId} não existe na conta ${cid}.`);

      const rn = gaqlLiteral(parsed.resourceName);
      const notRemoved = (field: string) => (includeRemoved ? "" : ` AND ${field} != 'REMOVED'`);
      const queries: Record<string, string> = {
        customer: `SELECT customer_asset.resource_name, customer_asset.field_type, customer_asset.status,
                          customer_asset.source, customer_asset.primary_status
                   FROM customer_asset
                   WHERE customer_asset.asset = '${rn}'${notRemoved("customer_asset.status")}`,
        campaign: `SELECT campaign_asset.resource_name, campaign_asset.field_type, campaign_asset.status,
                          campaign_asset.source, campaign_asset.primary_status,
                          campaign.id, campaign.name, campaign.status
                   FROM campaign_asset
                   WHERE campaign_asset.asset = '${rn}'${notRemoved("campaign_asset.status")}`,
        ad_group: `SELECT ad_group_asset.resource_name, ad_group_asset.field_type, ad_group_asset.status,
                          ad_group_asset.source, ad_group_asset.primary_status,
                          ad_group.id, ad_group.name, campaign.id, campaign.name
                   FROM ad_group_asset
                   WHERE ad_group_asset.asset = '${rn}'${notRemoved("ad_group_asset.status")}`,
        asset_group: `SELECT asset_group_asset.resource_name, asset_group_asset.field_type, asset_group_asset.status,
                             asset_group_asset.source, asset_group_asset.primary_status,
                             asset_group_asset.policy_summary.approval_status,
                             asset_group.id, asset_group.name, campaign.id, campaign.name
                      FROM asset_group_asset
                      WHERE asset_group_asset.asset = '${rn}'${notRemoved("asset_group_asset.status")}`,
        ads: `SELECT ad_group_ad_asset_view.ad_group_ad, ad_group_ad_asset_view.field_type,
                     ad_group_ad_asset_view.enabled, ad_group_ad_asset_view.pinned_field,
                     ad_group_ad_asset_view.source, ad_group_ad_asset_view.performance_label,
                     ad_group_ad.status, ad_group.id, ad_group.name, campaign.id, campaign.name
              FROM ad_group_ad_asset_view
              WHERE ad_group_ad_asset_view.asset = '${rn}'${notRemoved("ad_group_ad.status")}`,
        asset_set: `SELECT asset_set_asset.asset_set, asset_set_asset.status,
                           asset_set.id, asset_set.name, asset_set.type
                    FROM asset_set_asset
                    WHERE asset_set_asset.asset = '${rn}'${notRemoved("asset_set_asset.status")}`,
        aggregate: `SELECT campaign_aggregate_asset_view.field_type, campaign_aggregate_asset_view.asset_source,
                           metrics.linked_entities_count, metrics.linked_sample_entities,
                           campaign.id, campaign.name
                    FROM campaign_aggregate_asset_view
                    WHERE campaign_aggregate_asset_view.asset = '${rn}'`,
      };
      if (dateClause) {
        queries.performance = `SELECT campaign_aggregate_asset_view.field_type, campaign.id, campaign.name,
                                      metrics.impressions, metrics.clicks, metrics.cost_micros,
                                      metrics.conversions, metrics.conversions_value
                               FROM campaign_aggregate_asset_view
                               WHERE campaign_aggregate_asset_view.asset = '${rn}' AND ${dateClause}`;
      }
      const keys = Object.keys(queries);
      const settled = await Promise.allSettled(keys.map((key) => client.searchStream(cid, queries[key])));
      const rowsOf: Record<string, Row[]> = {};
      const sectionErrors: Row = {};
      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") rowsOf[keys[index]] = outcome.value;
        else {
          rowsOf[keys[index]] = [];
          sectionErrors[keys[index]] = (outcome.reason as Error)?.message ?? String(outcome.reason);
        }
      });

      const campaignOf = (row: Row) => ({ campaign_id: str(obj(row.campaign).id) || null, campaign_name: obj(row.campaign).name ?? null });
      const links = {
        customer: rowsOf.customer.map((row) => {
          const l = obj(row.customerAsset);
          return { field_type: l.fieldType, status: l.status, source: l.source, primary_status: l.primaryStatus ?? null, resource_name: l.resourceName };
        }),
        campaign: rowsOf.campaign.map((row) => {
          const l = obj(row.campaignAsset);
          return { ...campaignOf(row), campaign_status: obj(row.campaign).status ?? null, field_type: l.fieldType, status: l.status, source: l.source, primary_status: l.primaryStatus ?? null, resource_name: l.resourceName };
        }),
        ad_group: rowsOf.ad_group.map((row) => {
          const l = obj(row.adGroupAsset);
          return { ad_group_id: str(obj(row.adGroup).id), ad_group_name: obj(row.adGroup).name ?? null, ...campaignOf(row), field_type: l.fieldType, status: l.status, source: l.source, primary_status: l.primaryStatus ?? null, resource_name: l.resourceName };
        }),
        asset_group: rowsOf.asset_group.map((row) => {
          const l = obj(row.assetGroupAsset);
          return { asset_group_id: str(obj(row.assetGroup).id), asset_group_name: obj(row.assetGroup).name ?? null, ...campaignOf(row), field_type: l.fieldType, status: l.status, source: l.source ?? null, primary_status: l.primaryStatus ?? null, approval_status: obj(l.policySummary).approvalStatus ?? null, resource_name: l.resourceName };
        }),
        ads: rowsOf.ads.map((row) => {
          const v = obj(row.adGroupAdAssetView);
          return { ad_group_ad: v.adGroupAd, ad_status: obj(row.adGroupAd).status ?? null, ad_group_id: str(obj(row.adGroup).id), ad_group_name: obj(row.adGroup).name ?? null, ...campaignOf(row), field_type: v.fieldType, enabled: v.enabled ?? null, pinned_field: v.pinnedField ?? null, source: v.source ?? null, performance_label: v.performanceLabel ?? null };
        }),
        asset_set: rowsOf.asset_set.map((row) => {
          const l = obj(row.assetSetAsset);
          const set = obj(row.assetSet);
          return { asset_set_id: str(set.id), asset_set_name: set.name ?? null, asset_set_type: set.type ?? null, status: l.status };
        }),
      };

      // Cada vínculo é classificado UMA vez (ativo, pausado ou inativo), para que as contagens
      // sejam disjuntas. Em anúncios, o vínculo só vale se estiver na versão atual do anúncio
      // (enabled = true); o estado vem do próprio anúncio (ENABLED = ativo, PAUSED = pausado).
      const activeByLevel: Record<string, number> = {};
      const pausedByLevel: Record<string, number> = {};
      let active = 0;
      let paused = 0;
      for (const [level, rows] of Object.entries(links)) {
        let levelActive = 0;
        let levelPaused = 0;
        for (const row of rows as Row[]) {
          const state = classifyUsageLink(level, row);
          if (state === "active") levelActive++;
          else if (state === "paused") levelPaused++;
        }
        activeByLevel[level] = levelActive;
        pausedByLevel[level] = levelPaused;
        active += levelActive;
        paused += levelPaused;
      }
      const aggregate = rowsOf.aggregate.map((row) => {
        const v = obj(row.campaignAggregateAssetView);
        const m = obj(row.metrics);
        return { ...campaignOf(row), field_type: v.fieldType, asset_source: v.assetSource ?? null, linked_entities: num(m.linkedEntitiesCount), sample_entities: list(m.linkedSampleEntities) };
      });
      const aggregateLinked = aggregate.reduce((sum, row) => sum + num(row.linked_entities), 0);
      // Seções de vínculo que falharam: sem vínculo ativo nas que responderam, não dá para dizer
      // "sem uso" — o vínculo pode estar justamente na seção que falhou.
      const failedLinkSections = USAGE_LINK_SECTIONS.filter((key) => key in sectionErrors);
      const foundActive = active > 0 || aggregateLinked > 0;
      const inUse: boolean | null = foundActive ? true : failedLinkSections.length ? null : false;
      const verdict = foundActive
        ? `em uso: ${active} vínculo(s) ativo(s)${aggregateLinked ? `; ${aggregateLinked} entidade(s) na visão agregada por campanha` : ""}`
        : failedLinkSections.length
          ? `indeterminado: seções com erro (${failedLinkSections.join(", ")}); nas que responderam, nenhum vínculo ativo` +
            (paused > 0 ? ` (${paused} pausado(s))` : "") +
            " — repita a consulta antes de remover ou substituir o asset"
          : paused > 0
            ? `sem vínculo ativo — só vínculos pausados (${paused})`
            : "sem uso: nenhum vínculo ativo encontrado";

      const performance = dateClause
        ? rowsOf.performance.map((row) => {
            const m = obj(row.metrics);
            const cost = microsToMoney(m.costMicros);
            return { ...campaignOf(row), field_type: obj(row.campaignAggregateAssetView).fieldType, impressions: num(m.impressions), clicks: num(m.clicks), cost: round2(cost), conversions: round2(num(m.conversions)), conversions_value: round2(num(m.conversionsValue)) };
          })
        : undefined;

      const notes: string[] = [];
      if (asset.type === "IMAGE" || asset.type === "YOUTUBE_VIDEO") {
        notes.push("links.ads cobre RSA, Demand Gen e App (ad_group_ad_asset_view); anúncios responsivos de Display e de vídeo aparecem só em aggregate_by_campaign.");
      }
      if (Object.keys(sectionErrors).length) {
        notes.push(
          inUse === null
            ? "Seções de vínculo falharam (section_errors): o uso ficou indeterminado (in_use = null). Não remova nem substitua o asset com base nesta resposta."
            : "Algumas seções falharam (section_errors); as contagens consideram só as que responderam."
        );
      }

      const payload = {
        asset: {
          asset_id: str(asset.id),
          name: asset.name ?? null,
          type: asset.type ?? null,
          resource_name: asset.resourceName ?? parsed.resourceName,
          source: asset.source ?? null,
          ...policyView(asset),
        },
        summary: {
          in_use: inUse,
          verdict,
          active_links: active,
          paused_links: paused,
          active_by_level: activeByLevel,
          paused_by_level: pausedByLevel,
          aggregate_linked_entities: aggregateLinked,
          ...(failedLinkSections.length ? { failed_sections: failedLinkSections } : {}),
        },
        links,
        aggregate_by_campaign: aggregate,
        ...(performance ? { performance: { period: dateClause, by_campaign: performance } } : {}),
        ...(Object.keys(sectionErrors).length ? { section_errors: sectionErrors } : {}),
        ...(notes.length ? { notes } : {}),
      };
      const body = `Asset ${str(asset.id)} (${str(asset.type)}${asset.name ? `, "${str(asset.name)}"` : ""}): ${verdict}.\n\n${formatJson(payload)}`;
      // Uso indeterminado: a pergunta da ferramenta ficou sem resposta — sinaliza erro para o agente
      // não tratar o asset como sem uso (o payload parcial vai junto).
      return inUse === null ? { content: [text(body)], isError: true } : { content: [text(body)] };
    }
  );

  // ── upload_image_asset ──────────────────────────────────────────────

  mcp.registerTool(
    "upload_image_asset",
    {
      description: [
        "Envia uma imagem (base64) para a biblioteca de assets da conta. WRITE OPERATION — cria um asset IMAGE reutilizável.",
        "Retorna o resource name para usar em asset groups, anúncios ou link_campaign_image_assets (Pesquisa).",
        "",
        "Antes de enviar: aceita data URL (data:image/png;base64,...), valida o base64 e lê formato e dimensões do",
        "cabeçalho (PNG, JPEG, GIF) para informar proporção e orientação. Formatos aceitos pelo Google: JPG, PNG, GIF;",
        "até 5120 KB. Tamanhos comuns: 1200x628 (1.91:1), 1200x1200 (1:1), 960x1200 (4:5), 1200x300 (logo 4:1).",
        "",
        "aiGenerated: declaração do anunciante sobre conteúdo gerado/alterado por IA (synthetic_content_info, v25).",
        "true = IS_SYNTHETIC, false = NOT_SYNTHETIC; omitido = não declara. Depois de declarada, mude com",
        "update_asset_synthetic_attestation. Com GOOGLE_ADS_DRY_RUN a API só valida e nada é gravado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do asset (descritivo, ex.: 'Banner Março 2026 4x5')."),
        imageBase64: z.string().describe("Conteúdo da imagem em base64 (aceita data URL)."),
        aiGenerated: z.boolean().optional().describe("Declaração de IA: true = gerada/alterada por IA, false = não é. Omitido = não declara."),
      },
    },
    async ({ customerId, name, imageBase64, aiGenerated }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const assetName = str(name).trim();
      if (!assetName) return fail("Informe o nome do asset (name). Nada foi enviado.");
      const decoded = normalizeImageBase64(imageBase64);
      if ("error" in decoded) return fail(`${decoded.error} Nada foi enviado.`);

      const sniff = sniffImage(decoded.bytes);
      const warnings: string[] = [];
      if (!sniff.format) warnings.push("Formato não reconhecido pelo cabeçalho (esperado PNG, JPEG ou GIF); a API deve validar.");
      else if (sniff.format === "WEBP") warnings.push("WEBP não está entre os formatos aceitos pelo Google Ads (JPG, PNG, GIF); a API deve recusar.");
      if (decoded.bytes.length > IMAGE_MAX_BYTES) {
        warnings.push(`Arquivo com ${round2(decoded.bytes.length / 1024)} KB, acima do limite de 5120 KB das imagens do Google Ads.`);
      }
      const width = sniff.width ?? 0;
      const height = sniff.height ?? 0;
      const aspect = classifyAspect(width, height);
      const detected = {
        format: sniff.format,
        size_kb: round2(decoded.bytes.length / 1024),
        dimensions: width && height ? `${width}x${height}` : null,
        aspect_ratio: aspect.key,
        aspect_label: aspect.label,
        orientation: orientationFromSize(width, height),
      };

      const create: Row = { name: assetName, type: "IMAGE", imageAsset: { data: decoded.base64 } };
      if (aiGenerated !== undefined) create.syntheticContentInfo = syntheticContentPayload(aiGenerated);

      const client = ctx.getClient();
      const dryRun = client.isDryRun;
      let result: Row;
      try {
        result = await client.mutateAssets(cid, [{ create }]);
      } catch (err) {
        return fail(`A API recusou o upload da imagem "${assetName}".\nErro: ${explainSyntheticError((err as Error).message)}\n\n${formatJson({ detected, warnings })}`);
      }
      const resourceName = str(obj(list(result.results)[0]).resourceName) || null;
      const attestation = aiGenerated === undefined ? NOT_DECLARED : aiGenerated ? "IS_SYNTHETIC" : "NOT_SYNTHETIC";
      const header = dryRun
        ? `DRY-RUN (validateOnly): a API validou o upload de "${assetName}" — nada foi gravado.`
        : resourceName
          ? `Imagem criada: ${assetName}\nResource: ${resourceName}`
          : `A API não devolveu o resource name de "${assetName}" — confira com get_image_assets antes de repetir.`;
      return {
        content: [text(
          `${header}\n\n` +
          formatJson({ resource_name: resourceName, dry_run: dryRun, detected, ai_generated: attestation, warnings }) +
          (dryRun ? "" : "\n\nPróximo passo: vincule onde for usar (ex.: link_campaign_image_assets em Pesquisa) e confira com get_asset_usage.")
        )],
        ...(dryRun || resourceName ? {} : { isError: true }),
      };
    }
  );

  // ── upload_video_asset ──────────────────────────────────────────────

  mcp.registerTool(
    "upload_video_asset",
    {
      description: [
        "Cadastra um vídeo do YouTube como asset da conta. WRITE OPERATION — cria um asset YOUTUBE_VIDEO reutilizável.",
        "O vídeo já precisa estar no YouTube. Aceita o ID (11 caracteres) ou a URL (watch, youtu.be, shorts, embed).",
        "",
        "Antes de criar, procura um asset desse vídeo na conta: se já existir, devolve o existente e não grava nada.",
        "aiGenerated: declaração de conteúdo gerado/alterado por IA (true = IS_SYNTHETIC, false = NOT_SYNTHETIC;",
        "omitido = não declara). Com GOOGLE_ADS_DRY_RUN a API só valida e nada é gravado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        youtubeVideoId: z.string().describe("ID do vídeo (ex.: 'dQw4w9WgXcQ') ou URL do YouTube."),
        name: z.string().optional().describe("Nome do asset (opcional)."),
        aiGenerated: z.boolean().optional().describe("Declaração de IA: true = gerado/alterado por IA, false = não é. Omitido = não declara."),
      },
    },
    async ({ customerId, youtubeVideoId, name, aiGenerated }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const videoId = parseYoutubeVideoId(youtubeVideoId);
      if (!videoId) {
        return fail(`"${youtubeVideoId}" não é um ID de vídeo do YouTube (11 caracteres) nem uma URL de vídeo. Nada foi enviado.`);
      }

      const client = ctx.getClient();
      const existing = await client.searchStream(cid,
        `SELECT asset.id, asset.name, asset.resource_name, asset.youtube_video_asset.youtube_video_title,
                asset.synthetic_content_info.advertiser_attestation.status
         FROM asset
         WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '${videoId}'`);
      if (existing.length > 0) {
        const asset = obj(existing[0].asset);
        const current = advertiserAttestation(asset).status;
        const wanted = aiGenerated === undefined ? undefined : aiGenerated ? "IS_SYNTHETIC" : "NOT_SYNTHETIC";
        const note = wanted && wanted !== current
          ? `A declaração de IA atual é ${current}; para mudar para ${wanted}, use update_asset_synthetic_attestation (assetIds=["${str(asset.id)}"]).`
          : undefined;
        return {
          content: [text(
            `O vídeo ${videoId} já está cadastrado nesta conta — nenhuma escrita foi enviada.\nResource: ${str(asset.resourceName)}\n\n` +
            formatJson({
              asset_id: str(asset.id),
              resource_name: asset.resourceName,
              name: asset.name ?? null,
              title: obj(asset.youtubeVideoAsset).youtubeVideoTitle ?? null,
              ai_generated: current,
              ...(note ? { note } : {}),
            })
          )],
        };
      }

      const create: Row = { type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: videoId } };
      if (name?.trim()) create.name = name.trim();
      if (aiGenerated !== undefined) create.syntheticContentInfo = syntheticContentPayload(aiGenerated);
      const dryRun = client.isDryRun;
      let result: Row;
      try {
        result = await client.mutateAssets(cid, [{ create }]);
      } catch (err) {
        return fail(`A API recusou cadastrar o vídeo ${videoId}.\nErro: ${explainSyntheticError((err as Error).message)}`);
      }
      const resourceName = str(obj(list(result.results)[0]).resourceName) || null;
      const attestation = aiGenerated === undefined ? NOT_DECLARED : aiGenerated ? "IS_SYNTHETIC" : "NOT_SYNTHETIC";
      const header = dryRun
        ? `DRY-RUN (validateOnly): a API validou o vídeo ${videoId} — nada foi gravado.`
        : resourceName
          ? `Vídeo cadastrado: ${videoId}\nResource: ${resourceName}`
          : `A API não devolveu o resource name do vídeo ${videoId} — confira com get_video_assets antes de repetir.`;
      return {
        content: [text(`${header}\n\n${formatJson({ resource_name: resourceName, dry_run: dryRun, youtube_video_id: videoId, ai_generated: attestation })}`)],
        ...(dryRun || resourceName ? {} : { isError: true }),
      };
    }
  );

  // ── update_asset_synthetic_attestation ──────────────────────────────

  mcp.registerTool(
    "update_asset_synthetic_attestation",
    {
      description: [
        "Declara se assets da biblioteca foram gerados/alterados por IA (synthetic_content_info.advertiser_attestation, v25).",
        "WRITE OPERATION — muda só a declaração; não mexe em campanha, anúncio, lance nem vínculo.",
        "",
        "Vale para IMAGE, MEDIA_BUNDLE e YOUTUBE_VIDEO. aiGenerated=true grava IS_SYNTHETIC (o Google aplica o rótulo",
        "de IA onde a regra local exige); false grava NOT_SYNTHETIC. Lê cada asset antes: não existe, tipo não aceito",
        "→ nada é gravado; já com o valor pedido → pulado. Exige confirm: true (sem ele, mostra o plano antes/depois):",
        "a declaração é do anunciante e depois de feita não volta a 'não declarada' — só alterna entre os dois valores.",
        "Até 100 assets por chamada, com resultado por item.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetIds: flexArray(z.string()).describe("IDs numéricos ou resource names (customers/{id}/assets/{assetId}). Máx. 100."),
        aiGenerated: z.boolean().describe("true = IS_SYNTHETIC (gerado/alterado por IA); false = NOT_SYNTHETIC."),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar."),
      },
    },
    async ({ customerId, assetIds, aiGenerated, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (typeof aiGenerated !== "boolean") return fail("aiGenerated precisa ser true ou false. Nada foi gravado.");
      const refs = ensureArray<unknown>(assetIds).map((v) => str(v).trim()).filter(Boolean);
      if (refs.length === 0) return fail("Informe ao menos um asset em assetIds. Nada foi gravado.");
      const invalid: string[] = [];
      const wanted = new Map<string, string>();
      for (const ref of refs) {
        const parsed = parseImageAssetRef(ref, cid);
        if ("error" in parsed) invalid.push(parsed.error);
        else wanted.set(parsed.assetId, parsed.resourceName);
      }
      if (invalid.length) return fail(`Nada foi gravado — referência(s) inválida(s):\n- ${invalid.join("\n- ")}`);
      if (wanted.size > 100) return fail(`No máximo 100 assets por chamada (recebidos ${wanted.size}). Nada foi gravado.`);

      const client = ctx.getClient();
      const ids = [...wanted.keys()];
      const rows = await client.searchStream(cid,
        `SELECT asset.id, asset.name, asset.type,
                asset.synthetic_content_info.advertiser_attestation.status,
                asset.synthetic_content_info.advertiser_attestation.source
         FROM asset WHERE asset.id IN (${ids.join(", ")})`);
      const assets = new Map<string, Row>();
      for (const row of rows) assets.set(str(obj(row.asset).id), obj(row.asset));
      const rejected: string[] = [];
      for (const id of ids) {
        const asset = assets.get(id);
        if (!asset) rejected.push(`asset ${id} não existe na conta ${cid}`);
        else if (!SYNTHETIC_ELIGIBLE_TYPES.has(str(asset.type))) {
          rejected.push(`asset ${id} ("${str(asset.name)}") é ${str(asset.type)} — a declaração de IA só vale para IMAGE, MEDIA_BUNDLE e YOUTUBE_VIDEO`);
        }
      }
      if (rejected.length) return fail(`Nada foi gravado:\n- ${rejected.join("\n- ")}`);

      const target = aiGenerated ? "IS_SYNTHETIC" : "NOT_SYNTHETIC";
      const plan: Array<{ id: string; before: string; beforeSource: string | null; mask: string[] }> = [];
      const unchanged: Row[] = [];
      for (const id of ids) {
        const asset = assets.get(id)!;
        const current = advertiserAttestation(asset);
        const mask: string[] = [];
        if (current.status !== target) mask.push("synthetic_content_info.advertiser_attestation.status");
        if (current.source !== "ADVERTISER_ATTESTED") mask.push("synthetic_content_info.advertiser_attestation.source");
        if (mask.length === 0) unchanged.push({ asset_id: id, name: asset.name ?? null, ai_generated: current.status });
        else plan.push({ id, before: current.status, beforeSource: current.source, mask });
      }
      const describe = (item: (typeof plan)[number]) => ({
        asset_id: item.id,
        name: assets.get(item.id)?.name ?? null,
        type: assets.get(item.id)?.type ?? null,
        before: item.before,
        after: target,
      });
      if (plan.length === 0) {
        return {
          content: [text(`Nada a mudar — ${unchanged.length} asset(s) já declarados como ${target}. Nenhuma escrita foi enviada.\n\n${formatJson({ unchanged })}`)],
        };
      }
      if (confirm !== true) {
        return {
          content: [text(
            `Plano (nada foi gravado): declarar ${plan.length} asset(s) como ${target}. ` +
            "A declaração é do anunciante e, depois de feita, só alterna entre IS_SYNTHETIC e NOT_SYNTHETIC. " +
            "Para aplicar, repita com confirm: true.\n\n" +
            formatJson({ to_change: plan.map(describe), unchanged })
          )],
          isError: true,
        };
      }

      const operations: MutateOperation[] = plan.map((item) => {
        const attestation: Row = {};
        if (item.mask.includes("synthetic_content_info.advertiser_attestation.status")) attestation.status = target;
        if (item.mask.includes("synthetic_content_info.advertiser_attestation.source")) attestation.source = "ADVERTISER_ATTESTED";
        return {
          update: { resourceName: wanted.get(item.id)!, syntheticContentInfo: { advertiserAttestation: attestation } },
          updateMask: item.mask.join(","),
        };
      });
      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(cid, "assets", operations, { partialFailure: true });
      } catch (err) {
        return fail(
          `A API recusou a alteração (nada confirmado).\nErro: ${explainSyntheticError((err as Error).message)}\n\n` +
          formatJson({ attempted: plan.map(describe) })
        );
      }
      const results = list(response.results).map(obj);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, plan.length);
      const changed: Row[] = [];
      const errors: Row[] = [];
      plan.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...describe(item), error: explainSyntheticError(opErrors.join("; ")) });
        else if (!dryRun && !results[index]?.resourceName) errors.push({ ...describe(item), error: "a API não confirmou a alteração" });
        else if (dryRun && unattributed.length) errors.push({ ...describe(item), error: "validação não confirmada (erro sem operação indicada)" });
        else changed.push(describe(item));
      });
      for (const message of unattributed) errors.push({ error: message });
      const header = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. Validadas: ${changed.length} | Sem mudança: ${unchanged.length} | Com erro: ${errors.length}`
        : `Declaração de IA → ${target}. Alterados: ${changed.length} | Sem mudança: ${unchanged.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ dry_run: dryRun, [dryRun ? "validated" : "changed"]: changed, unchanged, errors })}`)],
        isError: errors.length > 0,
      };
    }
  );

  // ── list_location_asset_sets ────────────────────────────────────────

  mcp.registerTool(
    "list_location_asset_sets",
    {
      description: [
        "Lista os asset sets de locais da conta: o LOCATION_SYNC (sincronização com o Perfil da Empresa, redes/chains",
        "ou Place IDs do Maps) e os grupos de locais (dinâmicos por Perfil da Empresa ou rede, ou estáticos), com",
        "filtros, quantidade de locais ativos e onde estão vinculados (conta, campanhas, grupos de anúncios).",
        "READ OPERATION. Aponta o que falta: sem LOCATION_SYNC ativo, LOCATION_SYNC sem vínculo com a conta, grupo sem vínculo.",
        "",
        "Fluxo: create_location_sync_asset_set → list_location_assets (locais gerados) → create_location_group_asset_set",
        "(opcional, subconjunto por campanha/grupo) → link_location_asset_set.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeRemoved: z.boolean().optional().describe("true = inclui asset sets removidos."),
        format: formatSchema,
      },
    },
    async ({ customerId, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const client = ctx.getClient();

      const statusFilter = includeRemoved ? "" : " AND asset_set.status != 'REMOVED'";
      const [setRows, customerRows, campaignRows, adGroupRows, memberRows] = await Promise.all([
        client.searchStream(cid,
          `SELECT ${ASSET_SET_FIELDS} FROM asset_set
           WHERE asset_set.type IN (${LOCATION_SET_TYPE_LIST})${statusFilter}
           ORDER BY asset_set.id`),
        client.searchStream(cid,
          `SELECT customer_asset_set.asset_set, customer_asset_set.status, asset_set.id
           FROM customer_asset_set
           WHERE asset_set.type IN (${LOCATION_SET_TYPE_LIST}) AND customer_asset_set.status = 'ENABLED'`),
        client.searchStream(cid,
          `SELECT campaign_asset_set.asset_set, campaign_asset_set.status, campaign.id, campaign.name, asset_set.id
           FROM campaign_asset_set
           WHERE asset_set.type IN (${LOCATION_SET_TYPE_LIST}) AND campaign_asset_set.status = 'ENABLED'`),
        client.searchStream(cid,
          `SELECT ad_group_asset_set.asset_set, ad_group_asset_set.status, ad_group.id, ad_group.name, campaign.id, asset_set.id
           FROM ad_group_asset_set
           WHERE asset_set.type IN (${LOCATION_SET_TYPE_LIST}) AND ad_group_asset_set.status = 'ENABLED'`),
        client.searchStream(cid,
          `SELECT asset_set_asset.asset_set, asset_set.id
           FROM asset_set_asset
           WHERE asset_set.type IN (${LOCATION_SET_TYPE_LIST}) AND asset_set_asset.status = 'ENABLED'`),
      ]);

      const setIdOf = (row: Row) => str(obj(row.assetSet).id);
      const counts = new Map<string, number>();
      for (const row of memberRows) counts.set(setIdOf(row), (counts.get(setIdOf(row)) ?? 0) + 1);
      const onCustomer = new Set(customerRows.map(setIdOf));
      const campaignsBySet = new Map<string, Row[]>();
      for (const row of campaignRows) {
        const id = setIdOf(row);
        campaignsBySet.set(id, [...(campaignsBySet.get(id) ?? []), { campaign_id: str(obj(row.campaign).id), campaign_name: obj(row.campaign).name ?? null }]);
      }
      const adGroupsBySet = new Map<string, Row[]>();
      for (const row of adGroupRows) {
        const id = setIdOf(row);
        adGroupsBySet.set(id, [...(adGroupsBySet.get(id) ?? []), { ad_group_id: str(obj(row.adGroup).id), ad_group_name: obj(row.adGroup).name ?? null, campaign_id: str(obj(row.campaign).id) }]);
      }

      const sets: Row[] = setRows.map((row) => {
        const view = assetSetView(obj(row.assetSet));
        const id = str(view.asset_set_id);
        return {
          ...view,
          enabled_locations: counts.get(id) ?? 0,
          linked_to_customer: onCustomer.has(id),
          linked_campaigns: campaignsBySet.get(id) ?? [],
          linked_ad_groups: adGroupsBySet.get(id) ?? [],
        };
      });

      const warnings: string[] = [];
      const activeSync = sets.filter((s) => s.type === "LOCATION_SYNC" && s.status === "ENABLED");
      if (activeSync.length === 0) warnings.push("Nenhum LOCATION_SYNC ativo: a conta não tem locais. Crie com create_location_sync_asset_set.");
      for (const sync of activeSync) {
        if (!sync.linked_to_customer) warnings.push(`LOCATION_SYNC ${str(sync.asset_set_id)} não está vinculado à conta: rode link_location_asset_set (level=CUSTOMER).`);
        if (sync.enabled_locations === 0) warnings.push(`LOCATION_SYNC ${str(sync.asset_set_id)} ainda sem locais (a sincronização é assíncrona; se persistir, confira filtros e acesso ao Perfil da Empresa).`);
      }
      for (const group of sets.filter((s) => s.type !== "LOCATION_SYNC" && s.status === "ENABLED")) {
        if (list(group.linked_campaigns).length === 0 && list(group.linked_ad_groups).length === 0) {
          warnings.push(`Grupo ${str(group.asset_set_id)} ("${str(group.name)}") não está vinculado a nenhuma campanha ou grupo de anúncios.`);
        }
      }
      return renderRows(format, sets, `${sets.length} asset set(s) de locais.`, { asset_sets: sets, warnings },
        format && format !== "json" && warnings.length ? `Avisos:\n- ${warnings.join("\n- ")}` : undefined);
    }
  );

  // ── list_location_assets ────────────────────────────────────────────

  mcp.registerTool(
    "list_location_assets",
    {
      description: [
        "Lista os location assets (locais) da conta — gerados pelo Google a partir do LOCATION_SYNC —, com Place ID,",
        "tipo de propriedade (BUSINESS_OWNER = extensão de local; AFFILIATE = local afiliado) e, quando vêm do Perfil",
        "da Empresa, store code, listing ID e rótulos. READ OPERATION.",
        "",
        "assetSetId filtra os locais ativos de um asset set (LOCATION_SYNC ou grupo). label filtra por rótulo do",
        "Perfil da Empresa. Paginação: next_cursor → afterAssetId. Use os asset IDs em create_location_group_asset_set (STATIC).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetSetId: z.string().optional().describe("ID do asset set de locais (opcional)."),
        label: z.string().optional().describe("Rótulo do Perfil da Empresa (igualdade, sem diferenciar maiúsculas)."),
        limit: z.number().optional().describe("Tamanho da página (1–1000). Default: 100."),
        afterAssetId: z.string().optional().describe("Cursor: o next_cursor da página anterior."),
        format: formatSchema,
      },
    },
    async ({ customerId, assetSetId, label, limit, afterAssetId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const pageSize = limit ?? 100;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) return fail(`limit deve ser um inteiro entre 1 e ${MAX_PAGE}.`);
      if (assetSetId !== undefined && !/^\d+$/.test(assetSetId)) return fail(`assetSetId deve ser numérico (recebido "${assetSetId}").`);
      if (afterAssetId !== undefined && !/^\d+$/.test(afterAssetId)) return fail(`afterAssetId deve ser numérico (recebido "${afterAssetId}").`);
      const wantedLabel = label?.trim().toLowerCase();

      const fields = [
        "asset.id",
        "asset.resource_name",
        "asset.location_asset.place_id",
        "asset.location_asset.location_ownership_type",
        "asset.location_asset.business_profile_locations",
        "asset.policy_summary.approval_status",
      ];
      const cursor = afterAssetId ? ` AND asset.id > ${afterAssetId}` : "";
      const scan = wantedLabel ? LIBRARY_SCAN_CAP : pageSize + 1;
      const client = ctx.getClient();
      const raw = assetSetId
        ? await client.searchStream(cid,
            `SELECT ${fields.join(", ")}, asset_set_asset.status
             FROM asset_set_asset
             WHERE asset_set_asset.asset_set = 'customers/${cid}/assetSets/${assetSetId}'
               AND asset_set_asset.status = 'ENABLED' AND asset.type = 'LOCATION'${cursor}
             ORDER BY asset.id
             LIMIT ${scan}`)
        : await client.searchStream(cid,
            `SELECT ${fields.join(", ")}
             FROM asset
             WHERE asset.type = 'LOCATION'${cursor}
             ORDER BY asset.id
             LIMIT ${scan}`);

      const rows = raw.map((row) => {
        const asset = obj(row.asset);
        const location = obj(asset.locationAsset);
        const profiles = list(location.businessProfileLocations).map(obj);
        return {
          asset_id: str(asset.id),
          resource_name: asset.resourceName ?? null,
          place_id: location.placeId ?? null,
          ownership: location.locationOwnershipType ?? null,
          store_codes: profiles.map((p) => str(p.storeCode)).filter(Boolean),
          listing_ids: profiles.map((p) => str(p.listingId)).filter(Boolean),
          labels: [...new Set(profiles.flatMap((p) => list(p.labels).map(str)))],
          approval_status: obj(asset.policySummary).approvalStatus ?? null,
        };
      });
      const matched = wantedLabel ? rows.filter((row) => row.labels.some((l) => l.toLowerCase() === wantedLabel)) : rows;
      const page = matched.slice(0, pageSize);
      let nextCursor: string | null = null;
      if (matched.length > pageSize) nextCursor = page[page.length - 1].asset_id;
      else if (wantedLabel && raw.length >= LIBRARY_SCAN_CAP) nextCursor = rows[rows.length - 1].asset_id;
      const header = `${page.length} local(is)${assetSetId ? ` no asset set ${assetSetId}` : ""}` +
        `${nextCursor ? ` — há mais: repita com afterAssetId=${nextCursor}` : ""}.`;
      return renderRows(format, page, header, { asset_set_id: assetSetId ?? null, label: label ?? null, count: page.length, next_cursor: nextCursor, locations: page },
        nextCursor ? `next_cursor: ${nextCursor} (passe em afterAssetId)` : undefined);
    }
  );

  // ── create_location_sync_asset_set ──────────────────────────────────

  mcp.registerTool(
    "create_location_sync_asset_set",
    {
      description: [
        "Cria a sincronização de locais da conta (asset set LOCATION_SYNC) e a vincula à conta (CustomerAssetSet).",
        "WRITE OPERATION em dois passos encadeados (o vínculo usa o ID do asset set criado): validateOnly não é aceito;",
        "com GOOGLE_ADS_DRY_RUN só o primeiro passo é validado. Não mexe em campanhas, lances nem orçamento.",
        "",
        "Pré-requisito para extensões de local, ações locais/Maps e segmentação por grupos de locais. O Google gera os",
        "location assets de forma assíncrona depois — confira com list_location_assets.",
        "Só pode haver UM LOCATION_SYNC ativo por conta: se já existir, a tool recusa e mostra o atual.",
        "",
        "source=BUSINESS_PROFILE (Perfil da Empresa): businessProfileEmail (conta Google dona ou gestora do Perfil) e",
        "businessProfileAccessToken — access token OAuth 2.0 com o escopo https://www.googleapis.com/auth/business.manage",
        "gerado para esse MESMO e-mail (expira em ~1 hora; este servidor não tem esse escopo, o token precisa vir de fora).",
        "O token é repassado só ao Google Ads e nunca aparece na resposta. Filtros opcionais: businessAccountId,",
        "businessNameFilter, labelFilters, listingIds (IDs acima de 2^63 são convertidos para int64 como manda o Google).",
        "source=CHAIN (redes/revendedores): chainRelationshipType (AUTO_DEALERS | GENERAL_RETAILERS) e chains [{chainId}].",
        "source=MAPS: placeIds (Place IDs do Google Maps).",
        "ownershipType: BUSINESS_OWNER (locais próprios → extensão de local) ou AFFILIATE (lojas que vendem seu produto).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do asset set (1–128 caracteres, único entre os ativos)."),
        source: z.enum(["BUSINESS_PROFILE", "CHAIN", "MAPS"]).describe("Origem dos locais."),
        ownershipType: z.enum(["BUSINESS_OWNER", "AFFILIATE"]).describe("BUSINESS_OWNER (próprios) ou AFFILIATE (afiliados)."),
        businessProfileEmail: z.string().optional().describe("BUSINESS_PROFILE: e-mail da conta Google do Perfil da Empresa."),
        businessProfileAccessToken: z.string().optional().describe("BUSINESS_PROFILE: access token OAuth (escopo business.manage) desse e-mail. Não é exibido."),
        businessAccountId: z.string().optional().describe("BUSINESS_PROFILE: ID da conta de empresa gerenciada (opcional)."),
        businessNameFilter: z.string().optional().describe("BUSINESS_PROFILE: só fichas com este nome de empresa."),
        labelFilters: flexArray(z.string()).optional().describe("BUSINESS_PROFILE: só fichas com algum destes rótulos."),
        listingIds: flexArray(z.string()).optional().describe("BUSINESS_PROFILE: só estas fichas (listing IDs)."),
        chainRelationshipType: z.enum(["AUTO_DEALERS", "GENERAL_RETAILERS"]).optional().describe("CHAIN: relação com as redes."),
        chains: flexArray(chainSchema).optional().describe("CHAIN: redes a sincronizar."),
        placeIds: flexArray(z.string()).optional().describe("MAPS: Place IDs do Google Maps."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const secret = args.businessProfileAccessToken?.trim();
      const safe = (message: string) => redact(message, secret);
      const cid = customerDigits(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi gravado.`);
      const name = str(args.name).trim();
      if (!name || name.length > 128) return fail("name precisa ter de 1 a 128 caracteres. Nada foi gravado.");

      const bpFields = ["businessProfileEmail", "businessProfileAccessToken", "businessAccountId", "businessNameFilter", "labelFilters", "listingIds"] as const;
      const chainFields = ["chainRelationshipType", "chains"] as const;
      const mapsFields = ["placeIds"] as const;
      const present = (keys: readonly string[]) =>
        keys.filter((key) => {
          const value = (args as Record<string, unknown>)[key];
          return value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
        });
      const foreign = args.source === "BUSINESS_PROFILE"
        ? present([...chainFields, ...mapsFields])
        : args.source === "CHAIN"
          ? present([...bpFields, ...mapsFields])
          : present([...bpFields, ...chainFields]);
      if (foreign.length) return fail(`source=${args.source} não usa: ${foreign.join(", ")}. Nada foi gravado.`);

      let locationSource: Row;
      let summary: Row;
      if (args.source === "BUSINESS_PROFILE") {
        const email = str(args.businessProfileEmail).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("businessProfileEmail inválido ou ausente. Nada foi gravado.");
        if (!secret || /\s/.test(secret)) {
          return fail("businessProfileAccessToken ausente ou inválido: gere um access token OAuth 2.0 com o escopo " +
            "https://www.googleapis.com/auth/business.manage para esse e-mail. Nada foi gravado.");
        }
        const listing = parseListingIds(args.listingIds);
        if ("error" in listing) return fail(`${listing.error} Nada foi gravado.`);
        const labels = ensureArray<unknown>(args.labelFilters).map((v) => str(v).trim()).filter(Boolean);
        const accountId = str(args.businessAccountId).trim();
        if (accountId && !/^\d+$/.test(accountId)) return fail(`businessAccountId deve ser numérico (recebido "${accountId}"). Nada foi gravado.`);
        const bp: Row = { httpAuthorizationToken: secret, emailAddress: email };
        if (accountId) bp.businessAccountId = accountId;
        if (args.businessNameFilter?.trim()) bp.businessNameFilter = args.businessNameFilter.trim();
        if (labels.length) bp.labelFilters = labels;
        if (listing.ids.length) bp.listingIdFilters = listing.ids;
        locationSource = { businessProfileLocationSet: bp };
        summary = { email, business_account_id: accountId || null, business_name_filter: bp.businessNameFilter ?? null, label_filters: labels, listing_id_filters: listing.ids, token: "[token omitido]" };
      } else if (args.source === "CHAIN") {
        if (!args.chainRelationshipType) return fail("source=CHAIN exige chainRelationshipType (AUTO_DEALERS ou GENERAL_RETAILERS). Nada foi gravado.");
        const parsed = parseChains(args.chains);
        if ("error" in parsed) return fail(`${parsed.error} Nada foi gravado.`);
        if (parsed.chains.length === 0) return fail("source=CHAIN exige ao menos uma rede em chains. Nada foi gravado.");
        locationSource = { chainLocationSet: { relationshipType: args.chainRelationshipType, chains: parsed.chains } };
        summary = { relationship_type: args.chainRelationshipType, chains: parsed.chains };
      } else {
        const placeIds = [...new Set(ensureArray<unknown>(args.placeIds).map((v) => str(v).trim()).filter(Boolean))];
        if (placeIds.length === 0) return fail("source=MAPS exige ao menos um Place ID em placeIds. Nada foi gravado.");
        const badPlace = placeIds.filter((id) => !/^[A-Za-z0-9_-]+$/.test(id));
        if (badPlace.length) return fail(`Place ID(s) inválido(s): ${badPlace.join(", ")}. Nada foi gravado.`);
        if (placeIds.length > MAX_STATIC_ASSETS) return fail(`No máximo ${MAX_STATIC_ASSETS} Place IDs por chamada. Nada foi gravado.`);
        locationSource = { mapsLocationSet: { mapsLocations: placeIds.map((placeId) => ({ placeId })) } };
        summary = { place_ids: placeIds };
      }

      const client = ctx.getClient();
      const existing = await enabledSyncSets(client, cid);
      if (existing.length) {
        return fail(
          "Já existe um LOCATION_SYNC ativo nesta conta (o Google aceita só um). Nada foi gravado.\n" +
          "Para trocar de origem: unlink_location_asset_set (level=CUSTOMER) e remove_location_asset_set no atual, depois crie de novo.\n\n" +
          formatJson({ existing: existing.map(assetSetView) })
        );
      }
      const sameName = await enabledSetsNamed(client, cid, name);
      if (sameName.length) {
        return fail(`Já existe um asset set ativo chamado "${name}" (ID ${str(sameName[0].id)}, ${str(sameName[0].type)}). Use outro nome. Nada foi gravado.`);
      }

      const dryRun = client.isDryRun;
      const request = { name, type: "LOCATION_SYNC", source: args.source, ownership: args.ownershipType, ...summary };
      let setResource: string;
      try {
        const response = await client.mutate(cid, "assetSets", [{
          create: { name, type: "LOCATION_SYNC", locationSet: { locationOwnershipType: args.ownershipType, ...locationSource } },
        }]);
        setResource = str(obj(list(response.results)[0]).resourceName);
      } catch (err) {
        return fail(safe(`A API recusou criar o LOCATION_SYNC. Nada foi gravado.\nErro: ${explainLocationError((err as Error).message)}\n\n${formatJson({ request })}`));
      }
      if (dryRun) {
        return {
          content: [text(safe(
            "DRY-RUN (validateOnly): a API validou o asset set LOCATION_SYNC — nada foi gravado.\n" +
            "O passo 2 (vincular à conta) não foi validado: ele depende do ID criado no passo 1.\n\n" +
            formatJson({ dry_run: true, request })
          ))],
        };
      }
      if (!setResource) {
        return fail(safe(`A API não devolveu o resource name do asset set — confira com list_location_asset_sets antes de repetir.\n\n${formatJson({ request })}`));
      }
      const setId = setResource.split("/").pop() ?? "";
      let linkResource: string;
      try {
        const link = await client.mutate(cid, "customerAssetSets", [{ create: { assetSet: setResource, customer: `customers/${cid}` } }]);
        linkResource = str(obj(list(link.results)[0]).resourceName);
      } catch (err) {
        return fail(safe(
          `Asset set criado (${setResource}), mas o vínculo com a conta FALHOU — sem o vínculo os locais não veiculam.\n` +
          `Erro: ${explainLocationError((err as Error).message)}\n` +
          `Repita só o vínculo: link_location_asset_set (assetSetId=${setId}, level=CUSTOMER).\n\n` +
          formatJson({ asset_set: setResource, request })
        ));
      }
      return {
        content: [text(safe(
          `LOCATION_SYNC criado e vinculado à conta.\nAsset set: ${setResource}\nVínculo: ${linkResource || "(sem resource name na resposta)"}\n\n` +
          formatJson({ asset_set_id: setId, asset_set: setResource, customer_asset_set: linkResource || null, request }) +
          "\n\nO Google gera os locais de forma assíncrona: confira em alguns minutos com list_location_assets " +
          `(assetSetId=${setId}). Para limitar locais por campanha, use create_location_group_asset_set.`
        ))],
      };
    }
  );

  // ── link_location_asset_set ─────────────────────────────────────────

  mcp.registerTool(
    "link_location_asset_set",
    {
      description: [
        "Vincula um asset set de locais JÁ EXISTENTE: o LOCATION_SYNC à conta (level=CUSTOMER), ou um grupo de locais",
        "a campanhas (level=CAMPAIGN) ou grupos de anúncios (level=AD_GROUP). WRITE OPERATION — só cria vínculos.",
        "",
        "Confere antes: asset set existe, é de locais, não está removido e o tipo combina com o nível; campanhas e",
        "grupos existem e não estão removidos. Vínculo já ativo é pulado. Até 50 alvos por chamada, resultado por item.",
        "Use também para refazer o vínculo com a conta quando create_location_sync_asset_set falhar no passo 2.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetSetId: z.string().describe("ID do asset set de locais."),
        level: levelSchema.describe("CUSTOMER (só LOCATION_SYNC), CAMPAIGN ou AD_GROUP (grupos de locais)."),
        campaignIds: flexArray(z.string()).optional().describe("level=CAMPAIGN: IDs das campanhas."),
        adGroupIds: flexArray(z.string()).optional().describe("level=AD_GROUP: IDs dos grupos de anúncios."),
      },
    },
    async ({ customerId, assetSetId, level, campaignIds, adGroupIds }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!/^\d+$/.test(str(assetSetId))) return fail(`assetSetId deve ser numérico (recebido "${assetSetId}"). Nada foi gravado.`);
      const targets = parseTargets(level, campaignIds, adGroupIds);
      if ("error" in targets) return fail(`${targets.error} Nada foi gravado.`);

      const client = ctx.getClient();
      const set = await fetchAssetSet(client, cid, assetSetId);
      if (!set) return fail(`Asset set ${assetSetId} não existe na conta ${cid}. Nada foi gravado.`);
      const type = str(set.type);
      if (!(LOCATION_SET_TYPES as readonly string[]).includes(type)) return fail(`Asset set ${assetSetId} é ${type}, não de locais. Nada foi gravado.`);
      if (set.status === "REMOVED") return fail(`Asset set ${assetSetId} ("${str(set.name)}") está removido. Nada foi gravado.`);
      if (type === "LOCATION_SYNC" && level !== "CUSTOMER") return fail("O LOCATION_SYNC só vincula na conta (level=CUSTOMER). Para campanhas/grupos, crie um grupo de locais (create_location_group_asset_set). Nada foi gravado.");
      if (type !== "LOCATION_SYNC" && level === "CUSTOMER") return fail("Grupos de locais vinculam em campanha (CAMPAIGN) ou grupo de anúncios (AD_GROUP), não na conta. Nada foi gravado.");

      const setResource = `customers/${cid}/assetSets/${assetSetId}`;
      const setInfo = { asset_set_id: assetSetId, name: set.name ?? null, type };
      const existing = await fetchSetLinks(client, cid, setResource);
      const dryRun = client.isDryRun;

      interface Item { id: string | null; label: string; create: Row; resource: string }
      let items: Item[] = [];
      const skipped: Row[] = [];
      const rejected: string[] = [];
      if (level === "CUSTOMER") {
        if (existing.customer.length) skipped.push({ level, note: "já vinculado à conta", resource_name: existing.customer[0].resource_name });
        else items = [{ id: null, label: `conta ${cid}`, create: { assetSet: setResource, customer: `customers/${cid}` }, resource: "customerAssetSets" }];
      } else if (level === "CAMPAIGN") {
        const found = await fetchCampaigns(client, cid, targets.ids);
        const linked = new Set(existing.campaigns.map((c) => c.campaign_id));
        for (const id of targets.ids) {
          const campaign = found.get(id);
          if (!campaign) rejected.push(`campanha ${id} não existe na conta ${cid}`);
          else if (campaign.status === "REMOVED") rejected.push(`campanha ${id} ("${str(campaign.name)}") está removida`);
          else if (linked.has(id)) skipped.push({ campaign_id: id, campaign_name: campaign.name ?? null, note: "já vinculado" });
          else items.push({ id, label: `campanha ${id} ("${str(campaign.name)}", ${str(campaign.advertisingChannelType)})`, create: { campaign: `customers/${cid}/campaigns/${id}`, assetSet: setResource }, resource: "campaignAssetSets" });
        }
      } else {
        const found = await fetchAdGroups(client, cid, targets.ids);
        const linked = new Set(existing.adGroups.map((g) => g.ad_group_id));
        for (const id of targets.ids) {
          const adGroup = found.get(id);
          if (!adGroup) rejected.push(`grupo de anúncios ${id} não existe na conta ${cid}`);
          else if (adGroup.status === "REMOVED") rejected.push(`grupo de anúncios ${id} ("${str(adGroup.name)}") está removido`);
          else if (linked.has(id)) skipped.push({ ad_group_id: id, ad_group_name: adGroup.name ?? null, note: "já vinculado" });
          else items.push({ id, label: `grupo ${id} ("${str(adGroup.name)}")`, create: { adGroup: `customers/${cid}/adGroups/${id}`, assetSet: setResource }, resource: "adGroupAssetSets" });
        }
      }
      if (rejected.length) return fail(`Nada foi gravado:\n- ${rejected.join("\n- ")}`);
      if (items.length === 0) {
        return { content: [text(`Nada a fazer — os vínculos pedidos já existem. Nenhuma escrita foi enviada.\n\n${formatJson({ asset_set: setInfo, skipped })}`)] };
      }

      let response: Row;
      try {
        response = await client.mutate(cid, items[0].resource, items.map((item) => ({ create: item.create })), { partialFailure: true });
      } catch (err) {
        return fail(`A API recusou os vínculos (nada confirmado).\nErro: ${explainLocationError((err as Error).message)}\n\n${formatJson({ asset_set: setInfo, attempted: items.map((i) => i.label) })}`);
      }
      const results = list(response.results).map(obj);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, items.length);
      const linkedNow: Row[] = [];
      const errors: Row[] = [];
      items.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ target: item.label, error: explainLocationError(opErrors.join("; ")) });
        else if (!dryRun && !results[index]?.resourceName) errors.push({ target: item.label, error: "a API não confirmou o vínculo" });
        else if (dryRun && unattributed.length) errors.push({ target: item.label, error: "validação não confirmada (erro sem operação indicada)" });
        else linkedNow.push({ target: item.label, ...(results[index]?.resourceName ? { resource_name: results[index].resourceName } : {}) });
      });
      for (const message of unattributed) errors.push({ error: explainLocationError(message) });
      const header = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. Validados: ${linkedNow.length} | Já existentes: ${skipped.length} | Com erro: ${errors.length}`
        : `Asset set ${assetSetId} ("${str(set.name)}"). Vinculados: ${linkedNow.length} | Já existentes: ${skipped.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ asset_set: setInfo, dry_run: dryRun, [dryRun ? "validated" : "linked"]: linkedNow, skipped, errors })}`)],
        isError: errors.length > 0,
      };
    }
  );

  // ── create_location_group_asset_set ─────────────────────────────────

  mcp.registerTool(
    "create_location_group_asset_set",
    {
      description: [
        "Cria um grupo de locais (subconjunto do LOCATION_SYNC) e, opcionalmente, já o vincula a campanhas — tudo numa",
        "única mutação atômica (googleAds:mutate com IDs temporários): ou grava tudo ou nada. WRITE OPERATION.",
        "",
        "groupType=BUSINESS_PROFILE_DYNAMIC: filtra fichas do Perfil da Empresa por labelFilters, listingIds e/ou",
        "businessName (igualdade exata) — exige LOCATION_SYNC pai do Perfil da Empresa.",
        "groupType=CHAIN_DYNAMIC: filtra por chains [{chainId, locationAttributes}] — exige pai de redes.",
        "groupType=STATIC: lista fixa de location assets (locationAssetIds, de list_location_assets) que precisam estar",
        "ativos no pai — único tipo aceito quando o pai usa Place IDs do Maps.",
        "parentAssetSetId: o LOCATION_SYNC pai (default: o LOCATION_SYNC ativo da conta).",
        "Para vincular a grupos de anúncios, use depois link_location_asset_set (level=AD_GROUP).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do grupo (1–128 caracteres, único entre os asset sets ativos)."),
        groupType: z.enum(["BUSINESS_PROFILE_DYNAMIC", "CHAIN_DYNAMIC", "STATIC"]).describe("Tipo do grupo."),
        parentAssetSetId: z.string().optional().describe("ID do LOCATION_SYNC pai (default: o ativo da conta)."),
        labelFilters: flexArray(z.string()).optional().describe("BUSINESS_PROFILE_DYNAMIC: fichas com algum destes rótulos."),
        listingIds: flexArray(z.string()).optional().describe("BUSINESS_PROFILE_DYNAMIC: fichas com estes listing IDs."),
        businessName: z.string().optional().describe("BUSINESS_PROFILE_DYNAMIC: nome exato da empresa."),
        chains: flexArray(chainSchema).optional().describe("CHAIN_DYNAMIC: redes e atributos."),
        locationAssetIds: flexArray(z.string()).optional().describe("STATIC: IDs dos location assets (máx. 1000)."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas a vincular na mesma operação (máx. 50)."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi gravado.`);
      const name = str(args.name).trim();
      if (!name || name.length > 128) return fail("name precisa ter de 1 a 128 caracteres. Nada foi gravado.");
      if (args.parentAssetSetId !== undefined && !/^\d+$/.test(args.parentAssetSetId)) {
        return fail(`parentAssetSetId deve ser numérico (recebido "${args.parentAssetSetId}"). Nada foi gravado.`);
      }
      const labels = ensureArray<unknown>(args.labelFilters).map((v) => str(v).trim()).filter(Boolean);
      const listing = parseListingIds(args.listingIds);
      if ("error" in listing) return fail(`${listing.error} Nada foi gravado.`);
      const businessName = str(args.businessName).trim();
      const chains = parseChains(args.chains);
      if ("error" in chains) return fail(`${chains.error} Nada foi gravado.`);
      const staticIds = parseNumericIds(args.locationAssetIds, "locationAssetIds");
      if ("error" in staticIds) return fail(`${staticIds.error} Nada foi gravado.`);
      const campaigns = parseNumericIds(args.campaignIds, "campaignIds");
      if ("error" in campaigns) return fail(`${campaigns.error} Nada foi gravado.`);
      if (campaigns.ids.length > MAX_LINK_TARGETS) return fail(`No máximo ${MAX_LINK_TARGETS} campanhas por chamada. Nada foi gravado.`);

      const hasBp = labels.length > 0 || listing.ids.length > 0 || Boolean(businessName);
      const hasChains = chains.chains.length > 0;
      const hasStatic = staticIds.ids.length > 0;
      let type: string;
      let source: Row = {};
      if (args.groupType === "BUSINESS_PROFILE_DYNAMIC") {
        if (hasChains || hasStatic) return fail("BUSINESS_PROFILE_DYNAMIC usa só labelFilters, listingIds e businessName. Nada foi gravado.");
        if (!hasBp) return fail("BUSINESS_PROFILE_DYNAMIC exige ao menos um filtro (labelFilters, listingIds ou businessName). Nada foi gravado.");
        type = "BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP";
        const filter: Row = {};
        if (labels.length) filter.labelFilters = labels;
        if (listing.ids.length) filter.listingIdFilters = listing.ids;
        if (businessName) filter.businessNameFilter = { businessName, filterType: "EXACT" };
        source = { businessProfileLocationGroup: { dynamicBusinessProfileLocationGroupFilter: filter } };
      } else if (args.groupType === "CHAIN_DYNAMIC") {
        if (hasBp || hasStatic) return fail("CHAIN_DYNAMIC usa só chains. Nada foi gravado.");
        if (!hasChains) return fail("CHAIN_DYNAMIC exige ao menos uma rede em chains. Nada foi gravado.");
        type = "CHAIN_DYNAMIC_LOCATION_GROUP";
        source = { chainLocationGroup: { dynamicChainLocationGroupFilters: chains.chains } };
      } else {
        if (hasBp || hasChains) return fail("STATIC usa só locationAssetIds. Nada foi gravado.");
        if (!hasStatic) return fail("STATIC exige ao menos um location asset em locationAssetIds. Nada foi gravado.");
        if (staticIds.ids.length > MAX_STATIC_ASSETS) return fail(`No máximo ${MAX_STATIC_ASSETS} locais por chamada. Nada foi gravado.`);
        type = "STATIC_LOCATION_GROUP";
      }

      const client = ctx.getClient();
      let parent: Row | null;
      if (args.parentAssetSetId) {
        parent = await fetchAssetSet(client, cid, args.parentAssetSetId);
        if (!parent) return fail(`Asset set pai ${args.parentAssetSetId} não existe na conta ${cid}. Nada foi gravado.`);
        if (parent.type !== "LOCATION_SYNC") return fail(`Asset set ${args.parentAssetSetId} é ${str(parent.type)}; o pai precisa ser LOCATION_SYNC. Nada foi gravado.`);
        if (parent.status !== "ENABLED") return fail(`LOCATION_SYNC ${args.parentAssetSetId} não está ativo (${str(parent.status)}). Nada foi gravado.`);
      } else {
        const syncs = await enabledSyncSets(client, cid);
        if (syncs.length === 0) return fail("A conta não tem LOCATION_SYNC ativo: crie com create_location_sync_asset_set antes. Nada foi gravado.");
        parent = syncs[0];
      }
      const parentId = str(parent.id);
      const parentSource = syncSource(parent);
      if (type === "BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP" && parentSource === "CHAIN") {
        return fail(`O LOCATION_SYNC ${parentId} sincroniza redes (chains): use groupType=CHAIN_DYNAMIC ou STATIC. Nada foi gravado.`);
      }
      if (type === "CHAIN_DYNAMIC_LOCATION_GROUP" && parentSource === "BUSINESS_PROFILE") {
        return fail(`O LOCATION_SYNC ${parentId} sincroniza o Perfil da Empresa: use groupType=BUSINESS_PROFILE_DYNAMIC ou STATIC. Nada foi gravado.`);
      }
      const sameName = await enabledSetsNamed(client, cid, name);
      if (sameName.length) return fail(`Já existe um asset set ativo chamado "${name}" (ID ${str(sameName[0].id)}). Use outro nome. Nada foi gravado.`);

      const parentResource = `customers/${cid}/assetSets/${parentId}`;
      if (hasStatic) {
        const memberRows = await client.searchStream(cid,
          `SELECT asset_set_asset.asset, asset_set_asset.status, asset.id, asset.type
           FROM asset_set_asset
           WHERE asset_set_asset.asset_set = '${parentResource}' AND asset.id IN (${staticIds.ids.join(", ")})`);
        const active = new Set(memberRows.filter((row) => obj(row.assetSetAsset).status === "ENABLED").map((row) => str(obj(row.asset).id)));
        const missing = staticIds.ids.filter((id) => !active.has(id));
        if (missing.length) {
          return fail(`Nada foi gravado — location asset(s) fora do LOCATION_SYNC ${parentId} (ou removidos dele): ${missing.join(", ")}. ` +
            `Confira com list_location_assets (assetSetId=${parentId}).`);
        }
      }
      const campaignInfo: Row[] = [];
      if (campaigns.ids.length) {
        const found = await fetchCampaigns(client, cid, campaigns.ids);
        const rejected: string[] = [];
        for (const id of campaigns.ids) {
          const campaign = found.get(id);
          if (!campaign) rejected.push(`campanha ${id} não existe na conta ${cid}`);
          else if (campaign.status === "REMOVED") rejected.push(`campanha ${id} ("${str(campaign.name)}") está removida`);
          else campaignInfo.push({ campaign_id: id, campaign_name: campaign.name ?? null, channel: campaign.advertisingChannelType ?? null });
        }
        if (rejected.length) return fail(`Nada foi gravado:\n- ${rejected.join("\n- ")}`);
      }

      const tempSet = `customers/${cid}/assetSets/-1`;
      const operations: Array<Record<string, unknown>> = [
        { assetSetOperation: { create: { resourceName: tempSet, name, type, locationGroupParentAssetSetId: parentId, ...source } } },
        ...staticIds.ids.map((id) => ({ assetSetAssetOperation: { create: { assetSet: tempSet, asset: `customers/${cid}/assets/${id}` } } })),
        ...campaigns.ids.map((id) => ({ campaignAssetSetOperation: { create: { campaign: `customers/${cid}/campaigns/${id}`, assetSet: tempSet } } })),
      ];
      const request = {
        name,
        type,
        parent_asset_set_id: parentId,
        ...(hasBp ? { label_filters: labels, listing_ids: listing.ids, business_name: businessName || null } : {}),
        ...(hasChains ? { chains: chains.chains } : {}),
        ...(hasStatic ? { location_asset_ids: staticIds.ids } : {}),
        campaigns: campaignInfo,
      };
      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.batchMutate(cid, operations);
      } catch (err) {
        return fail(`A API recusou a operação atômica — nada foi gravado.\nErro: ${explainLocationError((err as Error).message)}\n\n${formatJson({ request })}`);
      }
      if (dryRun) {
        return { content: [text(`DRY-RUN (validateOnly): a API validou o grupo e ${campaignInfo.length} vínculo(s) — nada foi gravado.\n\n${formatJson({ dry_run: true, request })}`)] };
      }
      const responses = list(response.mutateOperationResponses).map(obj);
      const setResource = str(obj(responses[0]?.assetSetResult).resourceName);
      if (!setResource) {
        return fail(`A API não confirmou a criação do grupo — confira com list_location_asset_sets antes de repetir.\n\n${formatJson({ request, response })}`);
      }
      const setId = setResource.split("/").pop() ?? "";
      const linkResources = responses.map((r) => str(obj(r.campaignAssetSetResult).resourceName)).filter(Boolean);
      return {
        content: [text(
          `Grupo de locais criado: ${setResource} (${type}, pai ${parentId}).` +
          `${hasStatic ? ` Locais: ${staticIds.ids.length}.` : ""} Campanhas vinculadas: ${linkResources.length}.\n\n` +
          formatJson({ asset_set_id: setId, asset_set: setResource, campaign_asset_sets: linkResources, request }) +
          "\n\nConfira com list_location_asset_sets; para grupos de anúncios use link_location_asset_set (level=AD_GROUP)."
        )],
      };
    }
  );

  // ── unlink_location_asset_set ───────────────────────────────────────

  mcp.registerTool(
    "unlink_location_asset_set",
    {
      description: [
        "Desvincula um asset set de locais da conta (level=CUSTOMER), de campanhas (CAMPAIGN) ou de grupos de anúncios",
        "(AD_GROUP). WRITE OPERATION — remove só o vínculo; o asset set e os locais continuam na conta.",
        "",
        "Exige confirm: true: desvincular o LOCATION_SYNC da conta tira os locais de TODA a conta. Sem confirm, mostra",
        "o que seria removido. Alvo sem vínculo ativo é pulado. Resultado por item.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetSetId: z.string().describe("ID do asset set de locais."),
        level: levelSchema.describe("CUSTOMER, CAMPAIGN ou AD_GROUP."),
        campaignIds: flexArray(z.string()).optional().describe("level=CAMPAIGN: IDs das campanhas."),
        adGroupIds: flexArray(z.string()).optional().describe("level=AD_GROUP: IDs dos grupos de anúncios."),
        confirm: z.boolean().optional().describe("Precisa ser true para remover os vínculos."),
      },
    },
    async ({ customerId, assetSetId, level, campaignIds, adGroupIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!/^\d+$/.test(str(assetSetId))) return fail(`assetSetId deve ser numérico (recebido "${assetSetId}"). Nada foi gravado.`);
      const targets = parseTargets(level, campaignIds, adGroupIds);
      if ("error" in targets) return fail(`${targets.error} Nada foi gravado.`);

      const client = ctx.getClient();
      const set = await fetchAssetSet(client, cid, assetSetId);
      if (!set) return fail(`Asset set ${assetSetId} não existe na conta ${cid}. Nada foi gravado.`);
      if (!(LOCATION_SET_TYPES as readonly string[]).includes(str(set.type))) return fail(`Asset set ${assetSetId} é ${str(set.type)}, não de locais. Nada foi gravado.`);
      const setInfo = { asset_set_id: assetSetId, name: set.name ?? null, type: set.type };
      const links = await fetchSetLinks(client, cid, `customers/${cid}/assetSets/${assetSetId}`);

      let resource: string;
      const toRemove: Array<{ label: string; resourceName: string }> = [];
      const skipped: Row[] = [];
      if (level === "CUSTOMER") {
        resource = "customerAssetSets";
        if (links.customer.length) toRemove.push({ label: `conta ${cid}`, resourceName: links.customer[0].resource_name });
        else skipped.push({ level, note: "sem vínculo ativo com a conta" });
      } else if (level === "CAMPAIGN") {
        resource = "campaignAssetSets";
        const byId = new Map(links.campaigns.map((c) => [c.campaign_id, c]));
        for (const id of targets.ids) {
          const link = byId.get(id);
          if (link) toRemove.push({ label: `campanha ${id} ("${str(link.campaign_name)}")`, resourceName: link.resource_name });
          else skipped.push({ campaign_id: id, note: "sem vínculo ativo com este asset set" });
        }
      } else {
        resource = "adGroupAssetSets";
        const byId = new Map(links.adGroups.map((g) => [g.ad_group_id, g]));
        for (const id of targets.ids) {
          const link = byId.get(id);
          if (link) toRemove.push({ label: `grupo ${id} ("${str(link.ad_group_name)}")`, resourceName: link.resource_name });
          else skipped.push({ ad_group_id: id, note: "sem vínculo ativo com este asset set" });
        }
      }
      if (toRemove.length === 0) {
        return { content: [text(`Nada a desvincular — nenhum vínculo ativo nos alvos pedidos. Nenhuma escrita foi enviada.\n\n${formatJson({ asset_set: setInfo, skipped })}`)] };
      }
      if (confirm !== true) {
        const impact = level === "CUSTOMER" && set.type === "LOCATION_SYNC" ? " Isso tira os locais de TODA a conta." : "";
        return fail(`Plano (nada foi gravado): remover ${toRemove.length} vínculo(s) do asset set ${assetSetId}.${impact} ` +
          `Para aplicar, repita com confirm: true.\n\n${formatJson({ asset_set: setInfo, to_unlink: toRemove.map((t) => t.label), skipped })}`);
      }

      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(cid, resource, toRemove.map((t) => ({ remove: t.resourceName })), { partialFailure: true });
      } catch (err) {
        return fail(`A API recusou desvincular (nada confirmado).\nErro: ${explainLocationError((err as Error).message)}\n\n${formatJson({ asset_set: setInfo, attempted: toRemove.map((t) => t.label) })}`);
      }
      const results = list(response.results).map(obj);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, toRemove.length);
      const removed: Row[] = [];
      const errors: Row[] = [];
      toRemove.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ target: item.label, error: explainLocationError(opErrors.join("; ")) });
        else if (!dryRun && !results[index]?.resourceName) errors.push({ target: item.label, error: "a API não confirmou a remoção" });
        else if (dryRun && unattributed.length) errors.push({ target: item.label, error: "validação não confirmada (erro sem operação indicada)" });
        else removed.push({ target: item.label, resource_name: item.resourceName });
      });
      for (const message of unattributed) errors.push({ error: explainLocationError(message) });
      const header = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. Validados: ${removed.length} | Pulados: ${skipped.length} | Com erro: ${errors.length}`
        : `Asset set ${assetSetId}: vínculos removidos: ${removed.length} | Pulados: ${skipped.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ asset_set: setInfo, dry_run: dryRun, [dryRun ? "validated" : "unlinked"]: removed, skipped, errors })}`)],
        isError: errors.length > 0,
      };
    }
  );

  // ── remove_location_asset_set ───────────────────────────────────────

  mcp.registerTool(
    "remove_location_asset_set",
    {
      description: [
        "Remove um asset set de locais (LOCATION_SYNC ou grupo de locais). WRITE OPERATION irreversível — exige confirm: true.",
        "",
        "Confere antes: o Google não remove asset set com vínculos ativos (conta, campanhas, grupos de anúncios) nem",
        "LOCATION_SYNC com grupos filhos ativos; nesses casos a tool recusa e lista o que desfazer primeiro",
        "(unlink_location_asset_set / remove_location_asset_set nos grupos). Já removido → nada a fazer.",
        "Use para trocar a origem da sincronização (só pode haver um LOCATION_SYNC ativo).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetSetId: z.string().describe("ID do asset set de locais."),
        confirm: z.boolean().optional().describe("Precisa ser true para remover."),
      },
    },
    async ({ customerId, assetSetId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerDigits(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!/^\d+$/.test(str(assetSetId))) return fail(`assetSetId deve ser numérico (recebido "${assetSetId}"). Nada foi gravado.`);

      const client = ctx.getClient();
      const set = await fetchAssetSet(client, cid, assetSetId);
      if (!set) return fail(`Asset set ${assetSetId} não existe na conta ${cid}. Nada foi gravado.`);
      if (!(LOCATION_SET_TYPES as readonly string[]).includes(str(set.type))) return fail(`Asset set ${assetSetId} é ${str(set.type)}, não de locais. Nada foi gravado.`);
      const view = assetSetView(set);
      if (set.status === "REMOVED") return { content: [text(`Asset set ${assetSetId} já está removido. Nenhuma escrita foi enviada.\n\n${formatJson({ asset_set: view })}`)] };

      const setResource = `customers/${cid}/assetSets/${assetSetId}`;
      const [links, children] = await Promise.all([
        fetchSetLinks(client, cid, setResource),
        set.type === "LOCATION_SYNC" ? enabledChildGroups(client, cid, assetSetId) : Promise.resolve([] as Row[]),
      ]);
      const blockers: Row = {};
      if (links.customer.length) blockers.customer = true;
      if (links.campaigns.length) blockers.campaigns = links.campaigns.map((c) => ({ campaign_id: c.campaign_id, campaign_name: c.campaign_name }));
      if (links.adGroups.length) blockers.ad_groups = links.adGroups.map((g) => ({ ad_group_id: g.ad_group_id, ad_group_name: g.ad_group_name }));
      if (children.length) blockers.child_groups = children;
      if (Object.keys(blockers).length) {
        return fail(
          `Nada foi gravado — o asset set ${assetSetId} ainda está em uso e o Google recusa removê-lo ` +
          "(CANNOT_DELETE_AS_ENABLED_LINKAGES_EXIST). Desfaça antes: vínculos com unlink_location_asset_set; " +
          "grupos filhos com remove_location_asset_set.\n\n" + formatJson({ asset_set: view, blockers })
        );
      }
      if (confirm !== true) {
        return fail(`Plano (nada foi gravado): remover o asset set ${assetSetId} ("${str(set.name)}", ${str(set.type)}). ` +
          `A remoção não tem volta. Para aplicar, repita com confirm: true.\n\n${formatJson({ asset_set: view })}`);
      }

      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(cid, "assetSets", [{ remove: setResource }]);
      } catch (err) {
        return fail(`A API recusou remover o asset set ${assetSetId}.\nErro: ${explainLocationError((err as Error).message)}`);
      }
      if (dryRun) return { content: [text(`DRY-RUN (validateOnly): a API validou a remoção do asset set ${assetSetId} — nada foi gravado.\n\n${formatJson({ asset_set: view })}`)] };
      const removed = str(obj(list(response.results)[0]).resourceName);
      if (!removed) return fail(`A API não confirmou a remoção de ${setResource} — confira com list_location_asset_sets (includeRemoved=true).`);
      return { content: [text(`Asset set removido: ${removed} ("${str(set.name)}", ${str(set.type)}).\n\n${formatJson({ asset_set: view })}`)] };
    }
  );
}
