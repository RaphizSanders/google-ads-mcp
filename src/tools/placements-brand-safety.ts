/**
 * Lote placements-brand-safety: posicionamentos, exclusões e brand safety.
 *
 * - Posicionamentos: exclude_placements, create/update_placement_exclusion_list,
 *   attach_mcc_exclusion_list, list_placement_exclusion_lists. add_placement (src/tools.ts)
 *   usa o mesmo parser daqui (addPlacementTool), carregado por import dinâmico.
 * - Brand safety: set_content_exclusions, set_video_inventory_type, add_ip_exclusions,
 *   list_account_exclusions, remove_account_exclusions.
 * - Segmentação: get_targeting_overview, remove_targeting_criteria.
 * - Display: list_topics, list_mobile_app_categories, set_topic_targeting, set_optimized_targeting.
 *
 * Fontes (v25): common/criteria.proto (PlacementInfo, YouTubeChannelInfo, YouTubeVideoInfo,
 * MobileApplicationInfo, MobileAppCategoryInfo, ContentLabelInfo, IpBlockInfo, PlacementListInfo,
 * TopicInfo), resources/customer_negative_criterion.proto, resources/shared_criterion.proto,
 * resources/customer.proto (video_brand_safety_suitability), errors/criterion_error.proto,
 * developers.google.com/google-ads/api/docs/targeting/{criteria,shared-sets} e os limites da
 * Central de Ajuda (answer/6372658, 2454012, 2456098).
 */
import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  checkCustomerAccess,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  partialFailureByOperation,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const done = (message: string, isError = false): ToolResult =>
  isError ? { content: [text(message)], isError: true } : { content: [text(message)] };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** customerId sem hífens, só dígitos — ou null. */
function normalizeCid(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "").trim();
  return /^\d+$/.test(cid) ? cid : null;
}

const isNumericId = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value.trim());

/** Lista de IDs numéricos (aceita array ou JSON em string); devolve os inválidos à parte. */
function numericIds(raw: unknown): { ids: string[]; invalid: string[] } {
  const values = ensureArray<unknown>(raw).map((value) => String(value).trim()).filter(Boolean);
  const invalid = values.filter((value) => !/^\d+$/.test(value));
  return { ids: [...new Set(values.filter((value) => /^\d+$/.test(value)))], invalid };
}

// ── Limites (Central de Ajuda answer/6372658 e protos v25) ───────────

/** Itens por chamada: a API aceita até 10.000 operações por requisição; ficamos na metade. */
export const MAX_ITEMS_PER_CALL = 5_000;
/** IpBlockInfo: "You can exclude up to 500 IP addresses per campaign" / "per account". */
export const MAX_IP_EXCLUSIONS = 500;
/** 65.000 exclusões de posicionamento no nível da conta (fora das listas). */
export const MAX_ACCOUNT_PLACEMENT_EXCLUSIONS = 65_000;
/** Listas de exclusão de posicionamento: 20 por conta (65.000 itens cada); 3 por MCC (250.000 cada). */
export const MAX_LISTS_PER_ACCOUNT = 20;
export const MAX_LISTS_PER_MANAGER = 3;
export const MAX_ITEMS_PER_LIST = 65_000;
export const MAX_ITEMS_PER_MANAGER_LIST = 250_000;
/** Cada conta cliente recebe no máximo 5 listas de gerente. */
export const MAX_MANAGER_LISTS_PER_CLIENT = 5;

// ── Posicionamentos: tipos, parser e conversões ──────────────────────

export const PLACEMENT_TYPES = ["WEBSITE", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APP", "MOBILE_APP_CATEGORY"] as const;
export type PlacementType = (typeof PLACEMENT_TYPES)[number];
export const placementTypeSchema = z.enum(PLACEMENT_TYPES);
/** Fábrica (uma instância por uso): instância compartilhada vira "$ref" cruzado no JSON Schema da tool. */
export const placementItemSchema = () => z.union([
  z.string(),
  z.object({
    type: z.enum(PLACEMENT_TYPES).optional().describe("Tipo. Sem ele, a tool detecta pelo valor."),
    value: z.string().describe("URL, domínio, ID do canal (UC…), ID do vídeo, app ID (1-… / 2-…) ou ID da categoria."),
  }),
]);

/** CriterionType da API para cada tipo de posicionamento. */
export const PLACEMENT_CRITERION_TYPE: Record<PlacementType, string> = {
  WEBSITE: "PLACEMENT",
  YOUTUBE_CHANNEL: "YOUTUBE_CHANNEL",
  YOUTUBE_VIDEO: "YOUTUBE_VIDEO",
  MOBILE_APP: "MOBILE_APPLICATION",
  MOBILE_APP_CATEGORY: "MOBILE_APP_CATEGORY",
};
const PLACEMENT_CRITERION_TYPES = Object.values(PLACEMENT_CRITERION_TYPE);
const PLACEMENT_TYPES_GAQL = PLACEMENT_CRITERION_TYPES.map((type) => `'${type}'`).join(", ");

export interface Placement {
  type: PlacementType;
  value: string;
  key: string;
  criterion: Row;
  input: string;
  note?: string;
}

const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const IOS_APP_ID = /^1-\d+$/;
const ANDROID_APP_ID = /^2-[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
/** criteria doc: "Limits on URL length (250 chars) and depth (2 levels)". */
const MAX_PLACEMENT_URL_LENGTH = 250;
const MAX_PLACEMENT_URL_DEPTH = 2;

const HANDLE_HELP =
  "a API do Google Ads não converte @handle (nem /c/ ou /user/) em channel ID. No YouTube, abra o canal → " +
  "Sobre → Compartilhar canal → Copiar ID do canal (começa com UC, 24 caracteres) e envie como YOUTUBE_CHANNEL.";
const APP_ID_HELP =
  "app ID no formato 1-<ID numérico da App Store> (iOS, ex.: 1-476943146) ou 2-<pacote Android> " +
  "(ex.: 2-com.exemplo.app); também vale a URL da loja ou mobileapp::1-…";

function asUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

type YouTubeRef = { kind: "channel" | "video"; id: string } | { kind: "handle" | "other"; detail: string };

/** Lê URLs do YouTube: /channel/UC…, watch?v=, youtu.be/, shorts/, embed/, live/, @handle, /c/, /user/. */
export function parseYouTubeUrl(input: string): YouTubeRef | null {
  const url = asUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return segments[0] ? { kind: "video", id: segments[0] } : { kind: "other", detail: input };
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  const first = segments[0] ?? "";
  const second = segments[1];
  if (first === "watch") {
    const id = url.searchParams.get("v");
    return id ? { kind: "video", id } : { kind: "other", detail: input };
  }
  if (["shorts", "embed", "live", "v"].includes(first) && second) return { kind: "video", id: second };
  if (first === "channel" && second) return { kind: "channel", id: second };
  if (first.startsWith("@") || first === "c" || first === "user") return { kind: "handle", detail: input };
  return { kind: "other", detail: input };
}

/** play.google.com/store/apps/details?id=pkg → 2-pkg; apps.apple.com/…/id123 → 1-123. */
export function parseAppStoreUrl(input: string): string | null {
  if (!/(play\.google\.com|apps\.apple\.com|itunes\.apple\.com)/i.test(input)) return null;
  const url = asUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === "play.google.com") {
    const id = url.searchParams.get("id");
    return id ? `2-${id}` : null;
  }
  if (host === "apps.apple.com" || host === "itunes.apple.com") {
    const match = /\/id(\d+)/.exec(url.pathname);
    return match ? `1-${match[1]}` : null;
  }
  return null;
}

/** Payload REST (lowerCamelCase) do critério de cada tipo. */
export function placementCriterion(type: PlacementType, value: string): Row {
  switch (type) {
    case "WEBSITE":
      return { placement: { url: value } };
    case "YOUTUBE_CHANNEL":
      return { youtubeChannel: { channelId: value } };
    case "YOUTUBE_VIDEO":
      return { youtubeVideo: { videoId: value } };
    case "MOBILE_APP":
      return { mobileApplication: { appId: value } };
    case "MOBILE_APP_CATEGORY":
      return { mobileAppCategory: { mobileAppCategoryConstant: `mobileAppCategoryConstants/${value}` } };
  }
}

/** Chave de comparação (site sem protocolo/barra final e em minúsculas; o resto exato). */
export function placementKey(type: PlacementType, value: string): string {
  let normalized = value.trim();
  if (type === "WEBSITE") normalized = normalized.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
  if (type === "MOBILE_APP_CATEGORY") normalized = normalized.replace(/^mobileAppCategoryConstants\//, "");
  return `${type}:${normalized}`;
}

function validateWebsite(input: string): { value: string } | { error: string } {
  if (/\s/.test(input)) return { error: `"${input}": URL com espaço — envie um posicionamento por item.` };
  if (input.includes(",")) return { error: `"${input}": um posicionamento por item (a API recusa vários sites na mesma linha).` };
  if (input.length > MAX_PLACEMENT_URL_LENGTH) {
    return { error: `"${input.slice(0, 40)}…": passa de ${MAX_PLACEMENT_URL_LENGTH} caracteres (limite da API).` };
  }
  const url = asUrl(input);
  if (!url || !url.hostname.includes(".")) {
    return { error: `"${input}": não parece um site (esperado domínio ou domínio/caminho, ex.: exemplo.com.br).` };
  }
  if (url.hostname.toLowerCase().replace(/^www\./, "") === "adsenseformobileapps.com") {
    return { error: `"${input}": adsenseformobileapps.com não é aceito como site — exclua o app com type MOBILE_APP (${APP_ID_HELP}).` };
  }
  const depth = url.pathname.split("/").filter(Boolean).length;
  if (depth > MAX_PLACEMENT_URL_DEPTH) {
    return { error: `"${input}": caminho com ${depth} níveis — a API aceita até ${MAX_PLACEMENT_URL_DEPTH} (ex.: site.com/secao/pagina).` };
  }
  return { value: input.replace(/\/+$/, "") };
}

/**
 * Converte o que o usuário mandou no critério certo. URL do YouTube vira canal/vídeo (a API
 * recusa URL do YouTube como site: CriterionError.YOUTUBE_URL_UNSUPPORTED); @handle é recusado
 * (a API não tem como resolver handle em channel ID); URL de loja vira app ID.
 */
export function parsePlacement(raw: string, declared?: PlacementType): Placement | { error: string } {
  const input = String(raw ?? "").trim();
  if (!input) return { error: "valor vazio" };
  const build = (type: PlacementType, value: string, note?: string): Placement => ({
    type,
    value,
    key: placementKey(type, value),
    criterion: placementCriterion(type, value),
    input,
    ...(note ? { note } : {}),
  });

  if (declared === "MOBILE_APP_CATEGORY") {
    const match = /^(?:mobileAppCategoryConstants\/)?(\d+)$/.exec(input);
    return match
      ? build("MOBILE_APP_CATEGORY", match[1])
      : { error: `"${input}": MOBILE_APP_CATEGORY exige o ID numérico da categoria (veja list_mobile_app_categories).` };
  }

  const youtube = /youtu/i.test(input) ? parseYouTubeUrl(input) : null;
  if (declared === "YOUTUBE_CHANNEL") {
    if (youtube?.kind === "handle" || input.startsWith("@")) return { error: `"${input}": ${HANDLE_HELP}` };
    if (youtube?.kind === "video") return { error: `"${input}" é URL de vídeo — use type YOUTUBE_VIDEO.` };
    const id = youtube?.kind === "channel" ? youtube.id : input;
    return YT_CHANNEL_ID.test(id)
      ? build("YOUTUBE_CHANNEL", id, youtube ? "URL do canal convertida para o channel ID" : undefined)
      : { error: `"${input}": channel ID inválido — precisa começar com UC e ter 24 caracteres (${HANDLE_HELP})` };
  }
  if (declared === "YOUTUBE_VIDEO") {
    if (youtube?.kind === "channel" || youtube?.kind === "handle") return { error: `"${input}" é URL de canal — use type YOUTUBE_CHANNEL.` };
    const id = youtube?.kind === "video" ? youtube.id : input;
    return YT_VIDEO_ID.test(id)
      ? build("YOUTUBE_VIDEO", id, youtube ? "URL do vídeo convertida para o video ID" : undefined)
      : { error: `"${input}": video ID inválido — são os 11 caracteres depois de watch?v= ou youtu.be/.` };
  }

  const appPrefix = /^mobileapp::(.+)$/i.exec(input)?.[1];
  const storeApp = parseAppStoreUrl(input);
  if (declared === "MOBILE_APP") {
    const appId = (appPrefix ?? storeApp ?? input).trim();
    return IOS_APP_ID.test(appId) || ANDROID_APP_ID.test(appId)
      ? build("MOBILE_APP", appId, appId !== input ? "convertido para app ID" : undefined)
      : { error: `"${input}": ${APP_ID_HELP}.` };
  }

  // WEBSITE declarado ou sem tipo: detecta app e YouTube antes de tratar como site
  if (appPrefix !== undefined || storeApp) {
    const appId = (appPrefix ?? storeApp ?? "").trim();
    if (!IOS_APP_ID.test(appId) && !ANDROID_APP_ID.test(appId)) return { error: `"${input}": ${APP_ID_HELP}.` };
    return build("MOBILE_APP", appId, "app detectado — gravado como MOBILE_APP (mobile_application)");
  }
  if (input.startsWith("@")) return { error: `"${input}": ${HANDLE_HELP}` };
  if (youtube) {
    const why = declared === "WEBSITE" ? " (a API recusa URL do YouTube como site: YOUTUBE_URL_UNSUPPORTED)" : "";
    if (youtube.kind === "channel") {
      if (!YT_CHANNEL_ID.test(youtube.id)) return { error: `"${input}": channel ID inválido na URL (${HANDLE_HELP})` };
      return build("YOUTUBE_CHANNEL", youtube.id, `URL do YouTube convertida para YOUTUBE_CHANNEL${why}`);
    }
    if (youtube.kind === "video") {
      if (!YT_VIDEO_ID.test(youtube.id)) return { error: `"${input}": video ID inválido na URL (11 caracteres).` };
      return build("YOUTUBE_VIDEO", youtube.id, `URL do YouTube convertida para YOUTUBE_VIDEO${why}`);
    }
    if (youtube.kind === "handle") return { error: `"${input}": ${HANDLE_HELP}` };
    return {
      error: `"${input}": URL do YouTube que não é canal (/channel/UC…) nem vídeo (watch?v=, youtu.be/, shorts/) — ` +
        "a API não aceita URL do YouTube como site.",
    };
  }
  const website = validateWebsite(input);
  return "error" in website ? website : build("WEBSITE", website.value);
}

/** Itens [{type, value}] ou valores soltos → posicionamentos válidos (sem repetidos) e erros. */
export function parsePlacementItems(raw: unknown): { items: Placement[]; errors: string[]; repeated: string[] } {
  const items: Placement[] = [];
  const errors: string[] = [];
  const repeated: string[] = [];
  const seen = new Set<string>();
  for (const entry of ensureArray<unknown>(raw)) {
    let value: string;
    let type: PlacementType | undefined;
    if (typeof entry === "string") {
      value = entry;
    } else if (entry && typeof entry === "object") {
      const record = entry as Row;
      value = String(record.value ?? "");
      if (record.type !== undefined && record.type !== null) {
        if (!(PLACEMENT_TYPES as readonly string[]).includes(String(record.type))) {
          errors.push(`"${value}": type "${String(record.type)}" inválido (use ${PLACEMENT_TYPES.join(", ")}).`);
          continue;
        }
        type = String(record.type) as PlacementType;
      }
    } else {
      errors.push(`item inválido: ${formatJson(entry)}`);
      continue;
    }
    const parsed = parsePlacement(value, type);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    if (seen.has(parsed.key)) {
      repeated.push(parsed.input);
      continue;
    }
    seen.add(parsed.key);
    items.push(parsed);
  }
  return { items, errors, repeated };
}

/** Critério devolvido pela API (campaignCriterion, adGroupCriterion, sharedCriterion…) → posicionamento. */
function placementOfCriterion(criterion: Row): { type: PlacementType; value: string } | null {
  const pick = (key: string, field: string) => {
    const value = (criterion[key] as Row | undefined)?.[field];
    return typeof value === "string" && value ? value : undefined;
  };
  const url = pick("placement", "url");
  if (url) return { type: "WEBSITE", value: url };
  const channel = pick("youtubeChannel", "channelId");
  if (channel) return { type: "YOUTUBE_CHANNEL", value: channel };
  const video = pick("youtubeVideo", "videoId");
  if (video) return { type: "YOUTUBE_VIDEO", value: video };
  const app = pick("mobileApplication", "appId");
  if (app) return { type: "MOBILE_APP", value: app };
  const category = pick("mobileAppCategory", "mobileAppCategoryConstant");
  if (category) return { type: "MOBILE_APP_CATEGORY", value: category.split("/").pop() ?? category };
  return null;
}

const describePlacement = (item: Placement): Row => ({
  type: item.type,
  value: item.value,
  ...(item.input !== item.value ? { input: item.input } : {}),
  ...(item.note ? { note: item.note } : {}),
});

// ── Erros da API → dica em PT-BR ─────────────────────────────────────

const API_ERROR_HINTS: Array<[RegExp, string]> = [
  [/YOUTUBE_URL_UNSUPPORTED|YouTube urls are not supported/i,
    "URL do YouTube não vale como site: use type YOUTUBE_CHANNEL (ID UC…) ou YOUTUBE_VIDEO (ID de 11 caracteres) — ou mande a URL /channel/UC… ou watch?v=…, que a tool converte."],
  [/INVALID_YOUTUBE_CHANNEL_ID|YouTube Channel Id is invalid/i,
    "O channel ID é o UC… de 24 caracteres; @handle não serve."],
  [/INVALID_YOUTUBE_VIDEO_ID|YouTube Video Id is invalid/i,
    "O video ID são os 11 caracteres depois de watch?v= ou youtu.be/."],
  [/INVALID_MOBILE_APP_CATEGORY|Mobile application category is not valid/i,
    "Use um ID de list_mobile_app_categories."],
  [/INVALID_MOBILE_APP\b|Mobile application is not valid/i, `Confira o ${APP_ID_HELP}.`],
  [/PLACEMENT_URL_IS_TOO_LONG|Placement URL is too long/i, "Limite de 250 caracteres por URL."],
  [/INVALID_PLACEMENT_URL|INVALID_FORMAT_FOR_PLACEMENT_URL|PLACEMENT_URL_HAS_ILLEGAL_CHAR|PLACEMENT_URL_HAS_MULTIPLE_SITES_IN_LINE|Placement URL has wrong format|Invalid placement URL/i,
    "Envie só o domínio ou domínio/caminho (até 2 níveis), um por item, ex.: exemplo.com.br ou exemplo.com.br/noticias."],
  [/PLACEMENT_IS_NOT_AVAILABLE_FOR_TARGETING_OR_EXCLUSION|domain is blocked/i,
    "O Google não aceita esse domínio como posicionamento (nem para excluir)."],
  [/CANNOT_TARGET_PLACEMENTS_FOR_SEARCH_CAMPAIGNS|positive placement criterion types in search/i,
    "Campanha de Pesquisa não aceita posicionamento positivo; para tirar inventário use exclude_placements."],
  [/INVALID_IP_ADDRESS|INVALID_IP_FORMAT|IP address is not valid|IP format is not valid/i,
    "Use IPv4/IPv6 individual ou bloco CIDR (ex.: 203.0.113.7, 203.0.113.0/24, 2001:db8::/48)."],
  [/PLACEMENT_LIST_SHARED_SET_DOES_NOT_EXIST|CANNOT_ADD_REMOVED_PLACEMENT_LIST_SHARED_SET/i,
    "A lista não existe ou foi removida — confira em list_placement_exclusion_lists."],
  [/DUPLICATE_NAME/i, "Já existe uma lista ativa com esse nome — escolha outro."],
  [/CRITERION_TYPE_NOT_ALLOWED_FOR_SHARED_SET_TYPE/i,
    "Esse tipo não entra em lista de exclusão de posicionamentos (sites, apps, canais e vídeos do YouTube entram)."],
  [/CANNOT_TARGET_AND_EXCLUDE/i,
    "O mesmo item está segmentado (positivo) nesse nível — remova a segmentação antes de excluir."],
  [/CANNOT_EXCLUDE_CRITERIA_TYPE|CANNOT_EXCLUDE_CRITERION|CANNOT_ADD_CRITERIA_TYPE/i,
    "Esse tipo de campanha não aceita esse critério nesse nível; em Performance Max use o nível ACCOUNT."],
  [/SHARED_SET_ACCESS_DENIED/i, "A lista pertence a uma conta que esta não enxerga."],
  [/RESOURCE_ALREADY_EXISTS/i, "Já existe na conta — nada a fazer."],
];

export function explainApiError(message: string): string {
  const hints = API_ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\nDica: ${[...new Set(hints)].join(" ")}` : message;
}

// ── Alvo (campanha / grupo / conta) ──────────────────────────────────

type Level = "AD_GROUP" | "CAMPAIGN" | "ACCOUNT";

interface Target {
  level: Level;
  resourceName?: string;
  campaignId?: string;
  campaignName?: string;
  adGroupId?: string;
  adGroupName?: string;
  channel?: string;
  subType?: string;
  label: string;
}

/** Validação síncrona dos IDs exigidos por nível (antes de qualquer chamada). */
function checkLevelIds(level: Level, campaignId?: string, adGroupId?: string): string | null {
  if (level === "AD_GROUP") {
    if (!isNumericId(adGroupId)) return `level AD_GROUP exige adGroupId numérico (recebido "${adGroupId ?? ""}").`;
    if (campaignId !== undefined && !isNumericId(campaignId)) return `campaignId deve ser numérico, recebido "${campaignId}".`;
    return null;
  }
  if (level === "CAMPAIGN") {
    if (!isNumericId(campaignId)) return `level CAMPAIGN exige campaignId numérico (recebido "${campaignId ?? ""}").`;
    if (adGroupId !== undefined) return "level CAMPAIGN não usa adGroupId — para o grupo, use level AD_GROUP.";
    return null;
  }
  if (campaignId !== undefined || adGroupId !== undefined) {
    return "level ACCOUNT vale para a conta inteira e não usa campaignId/adGroupId.";
  }
  return null;
}

async function loadTarget(
  client: GoogleAdsClient,
  customerId: string,
  cid: string,
  level: Level,
  campaignId?: string,
  adGroupId?: string
): Promise<Target | string> {
  if (level === "ACCOUNT") return { level, label: `Conta ${cid}` };
  if (level === "CAMPAIGN") {
    const rows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
              campaign.advertising_channel_sub_type
       FROM campaign
       WHERE campaign.id = ${campaignId}`);
    const campaign = rows[0]?.campaign as Row | undefined;
    if (!campaign) return `Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`;
    if (campaign.status === "REMOVED") return `Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`;
    return {
      level,
      resourceName: `customers/${cid}/campaigns/${campaignId}`,
      campaignId: String(campaignId),
      campaignName: String(campaign.name ?? ""),
      channel: String(campaign.advertisingChannelType ?? ""),
      subType: String(campaign.advertisingChannelSubType ?? ""),
      label: `Campanha ${campaignId} ("${campaign.name ?? ""}")`,
    };
  }
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status,
            campaign.advertising_channel_type, campaign.advertising_channel_sub_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  const adGroup = rows[0]?.adGroup as Row | undefined;
  const campaign = (rows[0]?.campaign ?? {}) as Row;
  if (!adGroup) return `Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.`;
  if (adGroup.status === "REMOVED") return `Grupo de anúncios ${adGroupId} ("${adGroup.name}") está removido. Nada foi gravado.`;
  if (campaignId !== undefined && String(campaign.id) !== campaignId) {
    return `Grupo ${adGroupId} é da campanha ${campaign.id}, não da ${campaignId}. Nada foi gravado.`;
  }
  return {
    level,
    resourceName: `customers/${cid}/adGroups/${adGroupId}`,
    adGroupId: String(adGroupId),
    adGroupName: String(adGroup.name ?? ""),
    campaignId: String(campaign.id ?? ""),
    campaignName: String(campaign.name ?? ""),
    channel: String(campaign.advertisingChannelType ?? ""),
    subType: String(campaign.advertisingChannelSubType ?? ""),
    label: `Grupo ${adGroupId} ("${adGroup.name ?? ""}") da campanha ${campaign.id} ("${campaign.name ?? ""}")`,
  };
}

const targetView = (target: Target): Row => ({
  level: target.level,
  ...(target.campaignId ? { campaign_id: target.campaignId, campaign_name: target.campaignName, channel: target.channel } : {}),
  ...(target.adGroupId ? { ad_group_id: target.adGroupId, ad_group_name: target.adGroupName } : {}),
});

const PMAX_ACCOUNT_LEVEL =
  "Performance Max não aceita esse critério na campanha (a API lista para PMax só AD_SCHEDULE, AGE_RANGE, BRAND, " +
  "DEVICE, KEYWORD, LANGUAGE, LOCATION, LOCATION_GROUP e WEBPAGE). Use o nível ACCOUNT — a exclusão na conta vale " +
  "para todas as campanhas, inclusive PMax. Nada foi gravado.";

/**
 * Na CAMPANHA, posicionamento e tópico só existem como EXCLUSÃO. Guia de critérios da API, seção
 * "Campaign criteria": PlacementInfo "They can only be configured as negative"; TopicInfo, YouTubeChannelInfo,
 * YouTubeVideoInfo e MobileAppCategoryInfo "Only negative criteria are supported at the campaign level".
 * MobileApplicationInfo não traz nota própria, mas é posicionamento (mobileapp:: na interface) e o Google Ads
 * Scripts (AdsApp.CampaignDisplay) diz "Only excluded placements can be created at the campaign level" — a
 * segmentação positiva de conteúdo é por grupo de anúncios. Recusamos antes de qualquer chamada.
 */
function campaignNegativeOnly(what: string, excludeHint: string): string {
  return (
    `No nível de campanha, ${what} só pode ser EXCLUSÃO — a API aceita apenas negative: true na campanha; ` +
    "a segmentação positiva é por grupo de anúncios. Para segmentar, use level AD_GROUP com adGroupId; " +
    `para excluir na campanha, ${excludeHint}. Nada foi gravado.`
  );
}

const mutateResourceFor = (level: Level) =>
  level === "AD_GROUP" ? "adGroupCriteria" : level === "CAMPAIGN" ? "campaignCriteria" : "customerNegativeCriteria";

/** Corpo do create de um critério no nível do alvo. Na conta não existe campo negative (é sempre exclusão). */
function criterionCreate(target: Target, criterion: Row, negative: boolean): Row {
  if (target.level === "AD_GROUP") return { adGroup: target.resourceName, negative, ...criterion };
  if (target.level === "CAMPAIGN") return { campaign: target.resourceName, negative, ...criterion };
  return { ...criterion };
}

interface ExistingCriterion {
  resourceName: string;
  id: string;
  type: string;
  negative: boolean;
  key: string | null;
  placement: { type: PlacementType; value: string } | null;
}

/** Posicionamentos (positivos e negativos) que já existem no alvo, em qualquer status menos REMOVED. */
async function loadPlacementCriteria(client: GoogleAdsClient, customerId: string, target: Target): Promise<ExistingCriterion[]> {
  let rows: Row[];
  let key: string;
  if (target.level === "AD_GROUP") {
    key = "adGroupCriterion";
    rows = await client.searchStream(customerId,
      `SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.type,
              ad_group_criterion.negative, ad_group_criterion.placement.url, ad_group_criterion.youtube_channel.channel_id,
              ad_group_criterion.youtube_video.video_id, ad_group_criterion.mobile_application.app_id,
              ad_group_criterion.mobile_app_category.mobile_app_category_constant
       FROM ad_group_criterion
       WHERE ad_group.id = ${target.adGroupId}
         AND ad_group_criterion.status != 'REMOVED'
         AND ad_group_criterion.type IN (${PLACEMENT_TYPES_GAQL})`);
  } else if (target.level === "CAMPAIGN") {
    key = "campaignCriterion";
    rows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.criterion_id, campaign_criterion.type,
              campaign_criterion.negative, campaign_criterion.placement.url, campaign_criterion.youtube_channel.channel_id,
              campaign_criterion.youtube_video.video_id, campaign_criterion.mobile_application.app_id,
              campaign_criterion.mobile_app_category.mobile_app_category_constant
       FROM campaign_criterion
       WHERE campaign.id = ${target.campaignId}
         AND campaign_criterion.status != 'REMOVED'
         AND campaign_criterion.type IN (${PLACEMENT_TYPES_GAQL})`);
  } else {
    key = "customerNegativeCriterion";
    rows = await client.searchStream(customerId,
      `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.id, customer_negative_criterion.type,
              customer_negative_criterion.placement.url, customer_negative_criterion.youtube_channel.channel_id,
              customer_negative_criterion.youtube_video.video_id, customer_negative_criterion.mobile_application.app_id,
              customer_negative_criterion.mobile_app_category.mobile_app_category_constant
       FROM customer_negative_criterion
       WHERE customer_negative_criterion.type IN (${PLACEMENT_TYPES_GAQL})`);
  }
  return rows.map((row) => {
    const criterion = (row[key] ?? {}) as Row;
    const placement = placementOfCriterion(criterion);
    return {
      resourceName: String(criterion.resourceName ?? ""),
      id: String(criterion.criterionId ?? criterion.id ?? ""),
      type: String(criterion.type ?? ""),
      negative: target.level === "ACCOUNT" ? true : criterion.negative === true,
      key: placement ? placementKey(placement.type, placement.value) : null,
      placement,
    };
  });
}

// ── Gravação com partialFailure e relatório por item ─────────────────

interface PlannedOperation {
  describe: Row;
  op: MutateOperation;
}

async function applyPartial(
  client: GoogleAdsClient,
  customerId: string,
  resource: string,
  planned: PlannedOperation[]
): Promise<{ applied: Row[]; errors: Row[]; dryRun: boolean }> {
  const dryRun = client.isDryRun;
  const applied: Row[] = [];
  const errors: Row[] = [];
  if (planned.length === 0) return { applied, errors, dryRun };
  const response = await client.mutate(customerId, resource, planned.map((item) => item.op), { partialFailure: true });
  const results = (response.results as Row[] | undefined) ?? [];
  const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, planned.length);
  planned.forEach((item, index) => {
    const opErrors = byIndex.get(index);
    const resourceName = (results[index] as Row | undefined)?.resourceName;
    if (opErrors) errors.push({ ...item.describe, error: explainApiError(opErrors.join("; ")) });
    else if (!dryRun && !resourceName) errors.push({ ...item.describe, error: "a API não confirmou a operação" });
    else applied.push({ ...item.describe, ...(resourceName ? { resource_name: resourceName } : {}) });
  });
  for (const message of unattributed) errors.push({ error: explainApiError(message) });
  return { applied, errors, dryRun };
}

const DRY_RUN_NOTE = "DRY-RUN (validateOnly): validado, nada foi gravado.";

// ── IPs ──────────────────────────────────────────────────────────────

/** IPv4/IPv6 individual ou CIDR (IpBlockInfo). "a.b.c.*" (formato da interface) vira a.b.c.0/24. */
export function parseIpBlock(raw: string): { value: string; note?: string } | { error: string } {
  const input = String(raw ?? "").trim();
  if (!input) return { error: "IP vazio" };
  const wildcard = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\*$/.exec(input);
  if (wildcard) {
    const base = `${wildcard[1]}.${wildcard[2]}.${wildcard[3]}.0`;
    if (!isIPv4(base)) return { error: `"${input}": IPv4 inválido.` };
    return { value: `${base}/24`, note: `curinga convertido para CIDR ${base}/24` };
  }
  const parts = input.split("/");
  if (parts.length > 2) return { error: `"${input}": formato inválido (esperado IP ou IP/prefixo).` };
  const [address, prefix] = parts;
  const max = isIPv4(address) ? 32 : isIPv6(address) ? 128 : 0;
  if (max === 0) return { error: `"${input}": não é IPv4 nem IPv6 válido.` };
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max)) {
    return { error: `"${input}": prefixo CIDR inválido (0 a ${max}).` };
  }
  return { value: max === 128 ? input.toLowerCase() : input };
}

/** IpBlockInfo não vale em campanha de Vídeo, Hotel, App, PMax e Display inteligente (answer/2456098). */
const NO_CAMPAIGN_IP_EXCLUSION = new Set(["VIDEO", "HOTEL", "MULTI_CHANNEL", "PERFORMANCE_MAX"]);

// ── Brand safety: rótulos de conteúdo e inventário de vídeo ──────────

/** ContentLabelTypeEnum (v25), sem UNSPECIFIED/UNKNOWN. */
export const CONTENT_LABELS = [
  "SEXUALLY_SUGGESTIVE", "BELOW_THE_FOLD", "PARKED_DOMAIN", "JUVENILE", "PROFANITY", "TRAGEDY", "VIDEO",
  "VIDEO_RATING_DV_G", "VIDEO_RATING_DV_PG", "VIDEO_RATING_DV_T", "VIDEO_RATING_DV_MA", "VIDEO_NOT_YET_RATED",
  "EMBEDDED_VIDEO", "LIVE_STREAMING_VIDEO", "SOCIAL_ISSUES", "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES",
  "BRAND_SUITABILITY_GAMES_FIGHTING", "BRAND_SUITABILITY_GAMES_MATURE", "BRAND_SUITABILITY_HEALTH_SENSITIVE",
  "BRAND_SUITABILITY_HEALTH_SOURCE_UNDETERMINED", "BRAND_SUITABILITY_NEWS_RECENT", "BRAND_SUITABILITY_NEWS_SENSITIVE",
  "BRAND_SUITABILITY_NEWS_SOURCE_NOT_FEATURED", "BRAND_SUITABILITY_POLITICS", "BRAND_SUITABILITY_RELIGION",
] as const;

/** BrandSafetySuitabilityEnum (v25); os apelidos curtos viram o valor da API. */
export const VIDEO_SUITABILITY_ALIASES: Record<string, string> = {
  EXPANDED: "EXPANDED_INVENTORY",
  STANDARD: "STANDARD_INVENTORY",
  LIMITED: "LIMITED_INVENTORY",
};
const VIDEO_SUITABILITY_VALUES = [
  "EXPANDED_INVENTORY", "STANDARD_INVENTORY", "LIMITED_INVENTORY", "EXPANDED", "STANDARD", "LIMITED",
] as const;

/** Tipos que a conta aceita em customer_negative_criterion (oneof do proto v25). */
export const ACCOUNT_EXCLUSION_TYPES = [
  "PLACEMENT", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APPLICATION", "MOBILE_APP_CATEGORY",
  "CONTENT_LABEL", "IP_BLOCK", "PLACEMENT_LIST", "NEGATIVE_KEYWORD_LIST",
] as const;

const CUSTOMER_NEGATIVE_FIELDS = `customer_negative_criterion.resource_name, customer_negative_criterion.id,
       customer_negative_criterion.type, customer_negative_criterion.placement.url,
       customer_negative_criterion.youtube_channel.channel_id, customer_negative_criterion.youtube_video.video_id,
       customer_negative_criterion.mobile_application.app_id, customer_negative_criterion.mobile_application.name,
       customer_negative_criterion.mobile_app_category.mobile_app_category_constant,
       customer_negative_criterion.content_label.type, customer_negative_criterion.ip_block.ip_address,
       customer_negative_criterion.placement_list.shared_set, customer_negative_criterion.negative_keyword_list.shared_set`;

/** Linha de customer_negative_criterion → {id, type, value} legível. */
function accountExclusionView(row: Row): Row {
  const criterion = (row.customerNegativeCriterion ?? {}) as Row;
  const get = (key: string, field: string) => (criterion[key] as Row | undefined)?.[field];
  const placement = placementOfCriterion(criterion);
  const value =
    placement?.value ??
    get("contentLabel", "type") ??
    get("ipBlock", "ipAddress") ??
    get("placementList", "sharedSet") ??
    get("negativeKeywordList", "sharedSet") ??
    "";
  const name = get("mobileApplication", "name");
  return {
    criterion_id: String(criterion.id ?? ""),
    type: String(criterion.type ?? ""),
    value: String(value),
    ...(name ? { name } : {}),
    resource_name: String(criterion.resourceName ?? ""),
  };
}

// ── Segmentação: campos para a visão geral ───────────────────────────

const CAMPAIGN_CRITERION_OVERVIEW_FIELDS = [
  "resource_name", "criterion_id", "type", "negative", "status", "bid_modifier", "display_name",
  "location.geo_target_constant", "proximity.radius", "proximity.radius_units",
  "proximity.geo_point.latitude_in_micro_degrees", "proximity.geo_point.longitude_in_micro_degrees",
  "proximity.address.city_name", "language.language_constant", "device.type",
  "ad_schedule.day_of_week", "ad_schedule.start_hour", "ad_schedule.start_minute", "ad_schedule.end_hour",
  "ad_schedule.end_minute", "age_range.type", "gender.type", "income_range.type", "parental_status.type",
  "user_list.user_list", "user_interest.user_interest_category", "custom_audience.custom_audience",
  "custom_affinity.custom_affinity", "combined_audience.combined_audience", "placement.url",
  "youtube_channel.channel_id", "youtube_video.video_id", "mobile_application.app_id",
  "mobile_app_category.mobile_app_category_constant", "topic.topic_constant", "topic.path", "content_label.type",
  "ip_block.ip_address", "webpage.criterion_name", "keyword_theme.free_form_keyword_theme", "brand_list.shared_set",
  "life_event.life_event_id", "extended_demographic.extended_demographic_id",
  "operating_system_version.operating_system_version_constant", "mobile_device.mobile_device_constant",
  "carrier.carrier_constant", "video_lineup.video_lineup_id", "local_service_id.service_id",
].map((field) => `campaign_criterion.${field}`);

const AD_GROUP_CRITERION_OVERVIEW_FIELDS = [
  "resource_name", "criterion_id", "type", "negative", "status", "bid_modifier", "display_name",
  "age_range.type", "gender.type", "income_range.type", "parental_status.type", "user_list.user_list",
  "user_interest.user_interest_category", "audience.audience", "custom_audience.custom_audience",
  "custom_affinity.custom_affinity", "custom_intent.custom_intent", "combined_audience.combined_audience",
  "placement.url", "youtube_channel.channel_id", "youtube_video.video_id", "mobile_application.app_id",
  "mobile_app_category.mobile_app_category_constant", "topic.topic_constant", "topic.path", "webpage.criterion_name",
  "location.geo_target_constant", "language.language_constant", "life_event.life_event_id",
  "extended_demographic.extended_demographic_id", "brand_list.shared_set", "video_lineup.video_lineup_id",
].map((field) => `ad_group_criterion.${field}`);

const CRITERION_BASE_KEYS = new Set(["resourceName", "criterionId", "type", "negative", "status", "bidModifier", "displayName"]);

/** Critério (campaignCriterion/adGroupCriterion) → linha da visão geral. */
function criterionView(criterion: Row): Row {
  const detail = Object.fromEntries(Object.entries(criterion).filter(([key]) => !CRITERION_BASE_KEYS.has(key)));
  return {
    type: String(criterion.type ?? ""),
    negative: criterion.negative === true,
    display_name: criterion.displayName ?? null,
    bid_modifier: criterion.bidModifier ?? null,
    status: criterion.status ?? null,
    criterion_id: String(criterion.criterionId ?? ""),
    resource_name: String(criterion.resourceName ?? ""),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

function groupByType(rows: Row[]): Record<string, Row[]> {
  const grouped: Record<string, Row[]> = {};
  for (const row of rows) (grouped[String(row.type)] ??= []).push(row);
  return grouped;
}

/** Filtro de texto sem acento e sem caixa. */
const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ══════════════════════════════════════════════════════════════════════

export function registerPlacementsBrandSafetyTools(ctx: ToolContext): void {
  const { mcp } = ctx;

  // ── exclude_placements ─────────────────────────────────────────────

  mcp.registerTool(
    "exclude_placements",
    {
      description: [
        "Exclui posicionamentos — sites, canais e vídeos do YouTube, apps e categorias de app — no grupo de anúncios,",
        "na campanha ou na conta inteira.",
        "WRITE OPERATION — só cria critérios NEGATIVOS; não mexe em lances, orçamento nem outra segmentação.",
        "",
        "level: AD_GROUP (adGroupId), CAMPAIGN (campaignId) ou ACCOUNT (todas as campanhas da conta, inclusive",
        "Performance Max, Pesquisa/Shopping na rede de parceiros — é o único caminho para tirar inventário da PMax;",
        "limite de 65.000 exclusões na conta).",
        "items: [{type, value}] ou só o valor. type: WEBSITE, YOUTUBE_CHANNEL, YOUTUBE_VIDEO, MOBILE_APP, MOBILE_APP_CATEGORY.",
        "Sem type a tool detecta: youtube.com/channel/UC… → canal; watch?v= / youtu.be / shorts → vídeo;",
        "play.google.com, apps.apple.com ou mobileapp::1-… → app; o resto é site (até 2 níveis de caminho).",
        "@handle do YouTube é recusado: a API não resolve handle — informe o channel ID (UC…).",
        "App: 1-<ID da App Store> ou 2-<pacote Android>. Categoria de app: ID de list_mobile_app_categories.",
        "",
        "Antes de gravar confere que a campanha/grupo existe nesta conta, pula o que já está excluído e recusa item",
        "que está como segmentação positiva no mesmo nível. Cada item é gravado de forma independente",
        "(partialFailure): o relatório traz excluídos, já existentes e erros. Até 5.000 itens por chamada.",
        "Desfazer: remove_targeting_criteria (grupo/campanha) ou remove_account_exclusions (conta).",
        "Para uma lista reutilizável: create_placement_exclusion_list.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["AD_GROUP", "CAMPAIGN", "ACCOUNT"]).describe("Nível da exclusão."),
        campaignId: z.string().optional().describe("Obrigatório com level CAMPAIGN."),
        adGroupId: z.string().optional().describe("Obrigatório com level AD_GROUP."),
        items: flexArray(placementItemSchema()).describe("Posicionamentos a excluir: [{type, value}] ou valores (URL, domínio, ID)."),
      },
    },
    async ({ customerId, level, campaignId, adGroupId, items }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      const levelError = checkLevelIds(level, campaignId, adGroupId);
      if (levelError) return fail(`${levelError} Nada foi gravado.`);
      const parsed = parsePlacementItems(items);
      if (parsed.errors.length > 0) {
        return fail(`Nada foi gravado — item(ns) inválido(s):\n- ${parsed.errors.join("\n- ")}`);
      }
      if (parsed.items.length === 0) return fail("Informe ao menos um posicionamento em items. Nada foi gravado.");
      if (parsed.items.length > MAX_ITEMS_PER_CALL) {
        return fail(`No máximo ${MAX_ITEMS_PER_CALL} itens por chamada (recebidos ${parsed.items.length}). Divida em lotes. Nada foi gravado.`);
      }

      const client = ctx.getClient();
      const target = await loadTarget(client, customerId, cid, level, campaignId, adGroupId);
      if (typeof target === "string") return fail(target);
      if (target.channel === "PERFORMANCE_MAX") return fail(PMAX_ACCOUNT_LEVEL);

      const existing = await loadPlacementCriteria(client, customerId, target);
      const byKey = new Map(existing.filter((entry) => entry.key).map((entry) => [entry.key as string, entry]));
      const alreadyExcluded: Row[] = [];
      const conflicts: Row[] = [];
      const toCreate: Placement[] = [];
      for (const item of parsed.items) {
        const found = byKey.get(item.key);
        if (found?.negative) alreadyExcluded.push({ ...describePlacement(item), criterion_id: found.id });
        else if (found) {
          conflicts.push({
            ...describePlacement(item),
            error: "está como segmentação POSITIVA neste nível — remova-a (remove_targeting_criteria) antes de excluir",
          });
        } else toCreate.push(item);
      }
      if (level === "ACCOUNT" && existing.length + toCreate.length > MAX_ACCOUNT_PLACEMENT_EXCLUSIONS) {
        return fail(
          `A conta já tem ${existing.length} exclusões de posicionamento; com ${toCreate.length} novas passaria do limite de ` +
          `${MAX_ACCOUNT_PLACEMENT_EXCLUSIONS}. Use uma lista (create_placement_exclusion_list). Nada foi gravado.`
        );
      }
      const payloadBase = { target: targetView(target), already_excluded: alreadyExcluded, conflicts, repeated_in_request: parsed.repeated };
      if (toCreate.length === 0) {
        return done(
          `${target.label}: nada a gravar — ${alreadyExcluded.length} já excluído(s), ${conflicts.length} conflito(s).\n\n` +
          formatJson(payloadBase),
          conflicts.length > 0
        );
      }

      let outcome: Awaited<ReturnType<typeof applyPartial>>;
      try {
        outcome = await applyPartial(client, customerId, mutateResourceFor(level),
          toCreate.map((item) => ({ describe: describePlacement(item), op: { create: criterionCreate(target, item.criterion, true) } })));
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const { applied, errors, dryRun } = outcome;
      const header = dryRun
        ? `${target.label} — ${DRY_RUN_NOTE} Validadas: ${applied.length}`
        : `${target.label}: ${applied.length} exclusão(ões) criada(s)`;
      return done(
        `${header} | Já excluídos: ${alreadyExcluded.length} | Conflitos: ${conflicts.length} | Erros: ${errors.length}\n\n` +
        formatJson({ ...payloadBase, [dryRun ? "validated" : "excluded"]: applied, errors }),
        errors.length > 0 || (applied.length === 0 && conflicts.length > 0)
      );
    }
  );

  // ── Listas de exclusão de posicionamentos ──────────────────────────

  mcp.registerTool(
    "list_placement_exclusion_lists",
    {
      description: [
        "Lista as listas de exclusão de posicionamentos (shared sets NEGATIVE_PLACEMENTS) da conta: tamanho, onde estão",
        "aplicadas (campanhas e/ou conta inteira) e, com includeItems ou sharedSetId, os itens de cada lista.",
        "Numa conta gerente (MCC) mostra as listas que podem ser aplicadas às contas clientes (attach_mcc_exclusion_list).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta ou MCC dona das listas)."),
        sharedSetId: z.string().optional().describe("Só esta lista (inclui os itens)."),
        includeItems: z.boolean().optional().describe("Incluir os itens de todas as listas. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, sharedSetId, includeItems, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (sharedSetId !== undefined && !isNumericId(sharedSetId)) return fail(`sharedSetId deve ser numérico, recebido "${sharedSetId}".`);

      const client = ctx.getClient();
      const setFilter = sharedSetId ? ` AND shared_set.id = ${sharedSetId}` : "";
      const setRows = await client.searchStream(customerId,
        `SELECT shared_set.id, shared_set.name, shared_set.status, shared_set.member_count, shared_set.reference_count,
                shared_set.resource_name
         FROM shared_set
         WHERE shared_set.type = 'NEGATIVE_PLACEMENTS'
           AND shared_set.status = 'ENABLED'${setFilter}`);
      if (sharedSetId && setRows.length === 0) {
        return fail(`Lista ${sharedSetId} não encontrada entre as listas de exclusão de posicionamentos ativas da conta ${cid}.`);
      }
      const linkRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign_shared_set.shared_set, campaign_shared_set.status
         FROM campaign_shared_set
         WHERE shared_set.type = 'NEGATIVE_PLACEMENTS'
           AND campaign_shared_set.status = 'ENABLED'`);
      const accountRows = await client.searchStream(customerId,
        `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.id,
                customer_negative_criterion.placement_list.shared_set
         FROM customer_negative_criterion
         WHERE customer_negative_criterion.type = 'PLACEMENT_LIST'`);
      const accountLinked = new Map<string, string>();
      for (const row of accountRows) {
        const criterion = (row.customerNegativeCriterion ?? {}) as Row;
        const set = String(((criterion.placementList ?? {}) as Row).sharedSet ?? "");
        accountLinked.set(set, String(criterion.id ?? ""));
      }
      const campaignsBySet = new Map<string, Row[]>();
      for (const row of linkRows) {
        const link = (row.campaignSharedSet ?? {}) as Row;
        const campaign = (row.campaign ?? {}) as Row;
        const set = String(link.sharedSet ?? "");
        campaignsBySet.set(set, [...(campaignsBySet.get(set) ?? []), { campaign_id: String(campaign.id ?? ""), campaign_name: campaign.name }]);
      }

      const lists: Row[] = [];
      for (const row of setRows) {
        const set = (row.sharedSet ?? {}) as Row;
        const resourceName = String(set.resourceName ?? `customers/${cid}/sharedSets/${set.id}`);
        const entry: Row = {
          shared_set_id: String(set.id ?? ""),
          name: set.name,
          items: Number(set.memberCount ?? 0),
          campaigns_using: Number(set.referenceCount ?? 0),
          resource_name: resourceName,
          attached_to_account: accountLinked.has(resourceName),
          ...(accountLinked.has(resourceName) ? { account_criterion_id: accountLinked.get(resourceName) } : {}),
          campaigns: campaignsBySet.get(resourceName) ?? [],
        };
        if (includeItems || sharedSetId) {
          const itemRows = await client.searchStream(customerId,
            `SELECT shared_criterion.criterion_id, shared_criterion.type, shared_criterion.placement.url,
                    shared_criterion.youtube_channel.channel_id, shared_criterion.youtube_video.video_id,
                    shared_criterion.mobile_application.app_id, shared_criterion.mobile_application.name,
                    shared_criterion.mobile_app_category.mobile_app_category_constant
             FROM shared_criterion
             WHERE shared_criterion.shared_set = '${resourceName}'`);
          entry.placements = itemRows.map((itemRow) => {
            const criterion = (itemRow.sharedCriterion ?? {}) as Row;
            const placement = placementOfCriterion(criterion);
            return { criterion_id: String(criterion.criterionId ?? ""), type: placement?.type ?? criterion.type, value: placement?.value ?? "" };
          });
        }
        lists.push(entry);
      }
      const managerLists = [...accountLinked.keys()].filter((set) => !set.startsWith(`customers/${cid}/`));

      if (format === "table" || format === "csv") {
        const flat = lists.map(({ placements, campaigns, ...rest }) => ({
          ...rest,
          campaigns: ((campaigns as Row[]) ?? []).map((c) => c.campaign_id).join(" "),
          ...(placements ? { placements: (placements as Row[]).length } : {}),
        }));
        return done(format === "table" ? formatAsTable(flat) : formatAsCsv(flat));
      }
      return done(
        `${lists.length} lista(s) de exclusão de posicionamentos na conta ${cid}.` +
        (managerLists.length ? ` A conta também recebe ${managerLists.length} lista(s) de MCC.` : "") +
        `\n\n${formatJson({ lists, manager_lists_applied_to_account: managerLists })}`
      );
    }
  );

  mcp.registerTool(
    "create_placement_exclusion_list",
    {
      description: [
        "Cria uma lista de exclusão de posicionamentos (shared set NEGATIVE_PLACEMENTS) com os itens e, opcionalmente,",
        "já a aplica em campanhas (attachCampaignIds) e/ou na conta inteira (attachToAccount — vale para PMax).",
        "WRITE OPERATION — tudo numa requisição ATÔMICA (googleAds:mutate com ID temporário): ou cria tudo, ou nada.",
        "",
        "items: como em exclude_placements ([{type, value}] ou valores; YouTube por channel ID UC… ou URL /channel/,",
        "vídeo por ID ou URL, app 1-…/2-…). Até 5.000 itens por chamada; depois use update_placement_exclusion_list",
        "(que também aplica uma lista já existente em campanhas ou na conta inteira).",
        "Limites do Google: 20 listas por conta (65.000 itens cada); numa conta gerente (MCC), 3 listas de até 250.000",
        "itens, aplicadas às contas clientes com attach_mcc_exclusion_list (MCC não aplica em campanha nem em si mesma).",
        "O nome precisa ser único entre as listas ativas. validateOnly funciona (valida a requisição inteira).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta ou MCC que será dona da lista)."),
        name: z.string().describe("Nome da lista (1 a 255 bytes, único entre as listas ativas)."),
        items: flexArray(placementItemSchema()).describe("Posicionamentos da lista."),
        attachCampaignIds: flexArray(z.string()).optional().describe("Campanhas em que a lista passa a valer."),
        attachToAccount: z.boolean().optional().describe("true = aplicar a lista na conta inteira (inclusive PMax)."),
      },
    },
    async ({ customerId, name, items, attachCampaignIds, attachToAccount }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi criado.`);
      const listName = String(name ?? "").trim();
      const nameBytes = Buffer.byteLength(listName, "utf8");
      if (nameBytes < 1 || nameBytes > 255) return fail("name precisa ter de 1 a 255 bytes. Nada foi criado.");
      const campaigns = numericIds(attachCampaignIds);
      if (campaigns.invalid.length) return fail(`attachCampaignIds devem ser numéricos: ${campaigns.invalid.join(", ")}. Nada foi criado.`);
      const parsed = parsePlacementItems(items);
      if (parsed.errors.length > 0) return fail(`Nada foi criado — item(ns) inválido(s):\n- ${parsed.errors.join("\n- ")}`);
      if (parsed.items.length === 0) return fail("Informe ao menos um posicionamento em items. Nada foi criado.");
      if (parsed.items.length > MAX_ITEMS_PER_CALL) {
        return fail(`No máximo ${MAX_ITEMS_PER_CALL} itens por chamada (recebidos ${parsed.items.length}); crie com parte e complete com update_placement_exclusion_list. Nada foi criado.`);
      }

      const client = ctx.getClient();
      const customerRows = await client.searchStream(customerId, "SELECT customer.id, customer.manager FROM customer LIMIT 1");
      const isManager = ((customerRows[0]?.customer ?? {}) as Row).manager === true;
      if (isManager && (campaigns.ids.length > 0 || attachToAccount)) {
        return fail(
          "Conta gerente (MCC): a lista do MCC só pode ser aplicada no nível de conta das contas clientes — crie sem " +
          "attachCampaignIds/attachToAccount e use attach_mcc_exclusion_list. Nada foi criado."
        );
      }
      const setRows = await client.searchStream(customerId,
        `SELECT shared_set.id, shared_set.name, shared_set.status
         FROM shared_set
         WHERE shared_set.type = 'NEGATIVE_PLACEMENTS'
           AND shared_set.status = 'ENABLED'`);
      const existingSets = setRows.map((row) => (row.sharedSet ?? {}) as Row);
      const sameName = existingSets.find((set) => String(set.name ?? "").trim() === listName);
      if (sameName) {
        return fail(
          `Já existe a lista "${listName}" (ID ${sameName.id}) — use update_placement_exclusion_list com sharedSetId ` +
          `${sameName.id} para mudar os itens (addItems/removeItems), aplicar em campanhas (attachCampaignIds) ou na ` +
          "conta inteira (attachToAccount). Nada foi criado."
        );
      }
      const maxLists = isManager ? MAX_LISTS_PER_MANAGER : MAX_LISTS_PER_ACCOUNT;
      if (existingSets.length >= maxLists) {
        return fail(`A conta já tem ${existingSets.length} listas de exclusão de posicionamentos (limite ${maxLists}${isManager ? " numa MCC" : ""}). Nada foi criado.`);
      }
      const campaignInfo: Row[] = [];
      if (campaigns.ids.length > 0) {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
           FROM campaign
           WHERE campaign.id IN (${campaigns.ids.join(", ")})`);
        const found = new Map(rows.map((row) => [String(((row.campaign ?? {}) as Row).id), (row.campaign ?? {}) as Row]));
        const problems: string[] = [];
        for (const id of campaigns.ids) {
          const campaign = found.get(id);
          if (!campaign) problems.push(`campanha ${id} não existe na conta ${cid}`);
          else if (campaign.status === "REMOVED") problems.push(`campanha ${id} ("${campaign.name}") está removida`);
          else campaignInfo.push({ campaign_id: id, campaign_name: campaign.name, channel: campaign.advertisingChannelType });
        }
        if (problems.length) return fail(`Nada foi criado:\n- ${problems.join("\n- ")}`);
      }

      const tempSet = `customers/${cid}/sharedSets/-1`;
      const operations: Array<Record<string, unknown>> = [
        { sharedSetOperation: { create: { resourceName: tempSet, name: listName, type: "NEGATIVE_PLACEMENTS" } } },
        ...parsed.items.map((item) => ({ sharedCriterionOperation: { create: { sharedSet: tempSet, ...item.criterion } } })),
        ...campaigns.ids.map((id) => ({
          campaignSharedSetOperation: { create: { campaign: `customers/${cid}/campaigns/${id}`, sharedSet: tempSet } },
        })),
        ...(attachToAccount ? [{ customerNegativeCriterionOperation: { create: { placementList: { sharedSet: tempSet } } } }] : []),
      ];
      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi criado (requisição atômica).`);
      }
      const dryRun = client.isDryRun;
      const setResult = (((response.mutateOperationResponses as Row[] | undefined) ?? [])[0]?.sharedSetResult ?? {}) as Row;
      const resourceName = setResult.resourceName as string | undefined;
      if (!dryRun && !resourceName) {
        return fail(`A API não confirmou a criação da lista — confira em list_placement_exclusion_lists antes de repetir.\n\n${formatJson(response)}`);
      }
      const payload = {
        name: listName,
        shared_set: resourceName ?? null,
        shared_set_id: resourceName?.split("/").pop() ?? null,
        items: parsed.items.map(describePlacement),
        repeated_in_request: parsed.repeated,
        attached_campaigns: campaignInfo,
        attached_to_account: attachToAccount === true,
      };
      return done(
        (dryRun
          ? `Lista "${listName}" — ${DRY_RUN_NOTE} nada foi criado.`
          : `Lista "${listName}" criada com ${parsed.items.length} item(ns).`) +
        (campaignInfo.length ? ` Aplicada em ${campaignInfo.length} campanha(s).` : "") +
        (attachToAccount ? " Aplicada na conta inteira." : "") +
        (isManager ? " Para aplicar nas contas clientes: attach_mcc_exclusion_list." : "") +
        `\n\n${formatJson(payload)}`
      );
    }
  );

  mcp.registerTool(
    "update_placement_exclusion_list",
    {
      description: [
        "Mantém uma lista de exclusão de posicionamentos existente: adiciona e remove itens, aplica e desaplica",
        "campanhas e aplica/desaplica a lista na CONTA INTEIRA (attachToAccount / detachFromAccount — o caminho que",
        "alcança Performance Max; vale também para lista criada antes sem attachToAccount ou criada na interface).",
        "WRITE OPERATION. Remover itens, desaplicar campanhas ou detachFromAccount exige confirm: true",
        "(validateOnly dispensa).",
        "",
        "Lê a lista antes: precisa ser NEGATIVE_PLACEMENTS e ativa nesta conta. Item já presente não é recriado; item",
        "a remover que não está na lista é relatado como não encontrado; campanha já aplicada não é duplicada; lista",
        "já aplicada na conta (critério PLACEMENT_LIST) não é duplicada e detach de lista que não está na conta é no-op.",
        "Itens e vínculos vão com partialFailure (relatório por item). Limite: 65.000 itens por lista (250.000 em MCC).",
        "Lista de MCC não vai na própria MCC: use attach_mcc_exclusion_list para as contas clientes.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (dona da lista)."),
        sharedSetId: z.string().describe("ID da lista (list_placement_exclusion_lists)."),
        addItems: flexArray(placementItemSchema()).optional().describe("Posicionamentos a incluir na lista."),
        removeItems: flexArray(placementItemSchema()).optional().describe("Posicionamentos a tirar da lista."),
        attachCampaignIds: flexArray(z.string()).optional().describe("Campanhas em que a lista passa a valer."),
        detachCampaignIds: flexArray(z.string()).optional().describe("Campanhas de onde a lista sai."),
        attachToAccount: z.boolean().optional().describe("true = aplicar a lista na conta inteira (todas as campanhas, inclusive PMax)."),
        detachFromAccount: z.boolean().optional().describe("true = tirar a lista do nível da conta (exige confirm)."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para remover itens, desaplicar campanhas ou detachFromAccount."),
      },
    },
    async ({ customerId, sharedSetId, addItems, removeItems, attachCampaignIds, detachCampaignIds, attachToAccount, detachFromAccount, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!isNumericId(sharedSetId)) return fail(`sharedSetId deve ser numérico, recebido "${sharedSetId}". Nada foi gravado.`);
      const adds = parsePlacementItems(addItems ?? []);
      const removes = parsePlacementItems(removeItems ?? []);
      const attach = numericIds(attachCampaignIds);
      const detach = numericIds(detachCampaignIds);
      const invalid = [
        ...adds.errors.map((e) => `addItems: ${e}`),
        ...removes.errors.map((e) => `removeItems: ${e}`),
        ...attach.invalid.map((id) => `attachCampaignIds: "${id}" não é numérico`),
        ...detach.invalid.map((id) => `detachCampaignIds: "${id}" não é numérico`),
      ];
      if (invalid.length) return fail(`Nada foi gravado:\n- ${invalid.join("\n- ")}`);
      const both = attach.ids.filter((id) => detach.ids.includes(id));
      if (both.length) return fail(`Campanha(s) em attach e detach ao mesmo tempo: ${both.join(", ")}. Nada foi gravado.`);
      const clash = adds.items.filter((item) => removes.items.some((other) => other.key === item.key));
      if (clash.length) return fail(`Item(ns) em addItems e removeItems ao mesmo tempo: ${clash.map((i) => i.input).join(", ")}. Nada foi gravado.`);
      const wantsAccountAttach = attachToAccount === true;
      const wantsAccountDetach = detachFromAccount === true;
      if (wantsAccountAttach && wantsAccountDetach) {
        return fail("attachToAccount e detachFromAccount ao mesmo tempo — escolha um. Nada foi gravado.");
      }
      const accountAction = wantsAccountAttach || wantsAccountDetach;
      if (adds.items.length + removes.items.length + attach.ids.length + detach.ids.length === 0 && !accountAction) {
        return fail(
          "Nada para fazer: informe addItems, removeItems, attachCampaignIds, detachCampaignIds, attachToAccount " +
          "ou detachFromAccount."
        );
      }
      if (adds.items.length + removes.items.length > MAX_ITEMS_PER_CALL) {
        return fail(`No máximo ${MAX_ITEMS_PER_CALL} itens por chamada. Nada foi gravado.`);
      }

      const client = ctx.getClient();
      const setResource = `customers/${cid}/sharedSets/${sharedSetId}`;
      const setRows = await client.searchStream(customerId,
        `SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, customer.manager
         FROM shared_set
         WHERE shared_set.id = ${sharedSetId}`);
      const set = setRows[0]?.sharedSet as Row | undefined;
      if (!set) return fail(`Lista ${sharedSetId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (set.type !== "NEGATIVE_PLACEMENTS") {
        return fail(`A lista ${sharedSetId} ("${set.name}") é ${set.type}, não uma lista de exclusão de posicionamentos. Nada foi gravado.`);
      }
      if (set.status !== "ENABLED") return fail(`A lista ${sharedSetId} ("${set.name}") está ${set.status}. Nada foi gravado.`);
      const isManager = ((setRows[0]?.customer ?? {}) as Row).manager === true;

      const itemRows = await client.searchStream(customerId,
        `SELECT shared_criterion.resource_name, shared_criterion.criterion_id, shared_criterion.type,
                shared_criterion.placement.url, shared_criterion.youtube_channel.channel_id,
                shared_criterion.youtube_video.video_id, shared_criterion.mobile_application.app_id,
                shared_criterion.mobile_app_category.mobile_app_category_constant
         FROM shared_criterion
         WHERE shared_criterion.shared_set = '${setResource}'`);
      const current = new Map<string, Row>();
      for (const row of itemRows) {
        const criterion = (row.sharedCriterion ?? {}) as Row;
        const placement = placementOfCriterion(criterion);
        if (placement) current.set(placementKey(placement.type, placement.value), criterion);
      }
      const alreadyInList = adds.items.filter((item) => current.has(item.key)).map(describePlacement);
      const toAdd = adds.items.filter((item) => !current.has(item.key));
      const notInList = removes.items.filter((item) => !current.has(item.key)).map(describePlacement);
      const toRemove = removes.items.filter((item) => current.has(item.key));
      const limit = isManager ? MAX_ITEMS_PER_MANAGER_LIST : MAX_ITEMS_PER_LIST;
      const finalSize = current.size + toAdd.length - toRemove.length;
      if (finalSize > limit) {
        return fail(`A lista ficaria com ${finalSize} itens — limite de ${limit} por lista. Nada foi gravado.`);
      }

      const linkAttach: string[] = [];
      const linkDetach: Array<{ id: string; resourceName: string }> = [];
      const alreadyAttached: string[] = [];
      const notAttached: string[] = [];
      if (attach.ids.length + detach.ids.length > 0) {
        if (isManager) return fail("Conta gerente não tem campanhas: aplique a lista nas contas clientes com attach_mcc_exclusion_list. Nada foi gravado.");
        const ids = [...attach.ids, ...detach.ids];
        const campaignRows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status
           FROM campaign
           WHERE campaign.id IN (${ids.join(", ")})`);
        const found = new Map(campaignRows.map((row) => [String(((row.campaign ?? {}) as Row).id), (row.campaign ?? {}) as Row]));
        const missing = attach.ids.filter((id) => !found.has(id) || found.get(id)?.status === "REMOVED");
        if (missing.length) return fail(`Campanha(s) inexistente(s) ou removida(s) na conta ${cid}: ${missing.join(", ")}. Nada foi gravado.`);
        const links = await client.searchStream(customerId,
          `SELECT campaign_shared_set.resource_name, campaign_shared_set.campaign, campaign_shared_set.status
           FROM campaign_shared_set
           WHERE campaign_shared_set.shared_set = '${setResource}'
             AND campaign_shared_set.status = 'ENABLED'`);
        const linked = new Map(links.map((row) => {
          const link = (row.campaignSharedSet ?? {}) as Row;
          return [String(link.campaign ?? "").split("/").pop() ?? "", String(link.resourceName ?? "")];
        }));
        for (const id of attach.ids) (linked.has(id) ? alreadyAttached : linkAttach).push(id);
        for (const id of detach.ids) {
          const resourceName = linked.get(id);
          if (resourceName) linkDetach.push({ id, resourceName });
          else notAttached.push(id);
        }
      }

      // Nível da conta: CustomerNegativeCriterion.placement_list com a lista desta conta.
      let accountCriterion: { id: string; resourceName: string } | null = null;
      let accountAttach = false;
      let accountDetach: string | null = null;
      if (accountAction) {
        if (isManager) {
          return fail(
            "Conta gerente (MCC): a lista do MCC não vale no nível de conta da própria MCC — aplique nas contas clientes " +
            "com attach_mcc_exclusion_list (para tirar de um cliente: list_account_exclusions → remove_account_exclusions " +
            "no cliente). Nada foi gravado."
          );
        }
        const accountRows = await client.searchStream(customerId,
          `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.id,
                  customer_negative_criterion.placement_list.shared_set
           FROM customer_negative_criterion
           WHERE customer_negative_criterion.type = 'PLACEMENT_LIST'`);
        for (const row of accountRows) {
          const criterion = (row.customerNegativeCriterion ?? {}) as Row;
          if (String(((criterion.placementList ?? {}) as Row).sharedSet ?? "") === setResource) {
            accountCriterion = { id: String(criterion.id ?? ""), resourceName: String(criterion.resourceName ?? "") };
            break;
          }
        }
        if (wantsAccountAttach && !accountCriterion) accountAttach = true;
        if (wantsAccountDetach && accountCriterion) {
          accountDetach = accountCriterion.resourceName || `customers/${cid}/customerNegativeCriteria/${accountCriterion.id}`;
        }
      }

      const base = {
        list: { shared_set_id: sharedSetId, name: set.name, items_before: current.size },
        already_in_list: alreadyInList,
        not_in_list: notInList,
        already_attached: alreadyAttached,
        not_attached: notAttached,
        ...(accountAction
          ? {
            account: {
              attached_before: accountCriterion !== null,
              ...(accountCriterion ? { criterion_id: accountCriterion.id } : {}),
              attached_after: accountAttach || (accountCriterion !== null && accountDetach === null),
            },
          }
          : {}),
      };
      if (toAdd.length + toRemove.length + linkAttach.length + linkDetach.length === 0 && !accountAttach && !accountDetach) {
        return done(`Lista ${sharedSetId} ("${set.name}"): nada a mudar.\n\n${formatJson(base)}`);
      }
      const destructive = toRemove.length + linkDetach.length > 0 || accountDetach !== null;
      if (destructive && confirm !== true && !client.isDryRun) {
        return fail(
          `Confirmação necessária: remover ${toRemove.length} item(ns), desaplicar ${linkDetach.length} campanha(s)` +
          (accountDetach ? " e tirar a lista da conta inteira (o inventário volta para todas as campanhas, inclusive PMax)" : "") +
          ` — lista ${sharedSetId} ("${set.name}"). Reenvie com confirm: true. Nada foi gravado.\n\n` +
          formatJson({
            ...base,
            would_remove: toRemove.map(describePlacement),
            would_detach: linkDetach.map((l) => l.id),
            ...(accountDetach ? { would_detach_from_account: accountDetach } : {}),
          })
        );
      }

      const dryRun = client.isDryRun;
      let itemsOutcome: Awaited<ReturnType<typeof applyPartial>> = { applied: [], errors: [], dryRun };
      try {
        itemsOutcome = await applyPartial(client, customerId, "sharedCriteria", [
          ...toAdd.map((item) => ({
            describe: { action: "add", ...describePlacement(item) },
            op: { create: { sharedSet: setResource, ...item.criterion } },
          })),
          ...toRemove.map((item) => ({
            describe: { action: "remove", ...describePlacement(item) },
            op: { remove: String(current.get(item.key)?.resourceName ?? "") },
          })),
        ]);
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      let linksOutcome: Awaited<ReturnType<typeof applyPartial>> = { applied: [], errors: [], dryRun };
      try {
        linksOutcome = await applyPartial(client, customerId, "campaignSharedSets", [
          ...linkAttach.map((id) => ({
            describe: { action: "attach", campaign_id: id },
            op: { create: { campaign: `customers/${cid}/campaigns/${id}`, sharedSet: setResource } },
          })),
          ...linkDetach.map((link) => ({ describe: { action: "detach", campaign_id: link.id }, op: { remove: link.resourceName } })),
        ]);
      } catch (err) {
        linksOutcome = { applied: [], errors: [{ error: `vínculos com campanhas não gravados: ${explainApiError(errorMessage(err))}` }], dryRun };
      }
      let accountOutcome: Awaited<ReturnType<typeof applyPartial>> = { applied: [], errors: [], dryRun };
      try {
        accountOutcome = await applyPartial(client, customerId, "customerNegativeCriteria", [
          ...(accountAttach
            ? [{ describe: { action: "attach_to_account" }, op: { create: { placementList: { sharedSet: setResource } } } }]
            : []),
          ...(accountDetach ? [{ describe: { action: "detach_from_account" }, op: { remove: accountDetach } }] : []),
        ]);
      } catch (err) {
        accountOutcome = { applied: [], errors: [{ error: `nível da conta não gravado: ${explainApiError(errorMessage(err))}` }], dryRun };
      }
      const errors = [...itemsOutcome.errors, ...linksOutcome.errors, ...accountOutcome.errors];
      const applied = [...itemsOutcome.applied, ...linksOutcome.applied, ...accountOutcome.applied];
      return done(
        (dryRun ? `Lista ${sharedSetId} — ${DRY_RUN_NOTE} Validadas: ${applied.length}` : `Lista ${sharedSetId} ("${set.name}"): ${applied.length} mudança(s) aplicada(s)`) +
        ` | Erros: ${errors.length}\n\n` +
        formatJson({ ...base, [dryRun ? "validated" : "applied"]: applied, errors }),
        errors.length > 0
      );
    }
  );

  mcp.registerTool(
    "attach_mcc_exclusion_list",
    {
      description: [
        "Aplica uma lista de exclusão de posicionamentos de uma conta gerente (MCC) no nível de conta de contas clientes",
        "(CustomerNegativeCriterion.placement_list em cada cliente) — a lista de brand safety única da agência.",
        "WRITE OPERATION em várias contas — exige confirm: true (validateOnly dispensa).",
        "",
        "Antes de gravar: a conta gerente precisa ser MCC, a lista precisa ser NEGATIVE_PLACEMENTS ativa nela e cada",
        "cliente precisa estar sob essa MCC (customer_client). Cliente que já recebe a lista é pulado. O Google aceita",
        "até 5 listas de MCC por conta cliente. Cada cliente é gravado separadamente (relatório por conta).",
        "Crie a lista na MCC com create_placement_exclusion_list (customerId = MCC). Para tirar de um cliente:",
        "list_account_exclusions no cliente → remove_account_exclusions (critério PLACEMENT_LIST).",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID da conta gerente (MCC) dona da lista."),
        sharedSetId: z.string().describe("ID da lista na MCC (list_placement_exclusion_lists na MCC)."),
        clientCustomerIds: flexArray(z.string()).describe("Contas clientes que passam a excluir a lista."),
        confirm: z.boolean().optional().describe("Obrigatório (true): grava em várias contas."),
      },
    },
    async ({ managerCustomerId, sharedSetId, clientCustomerIds, confirm }) => {
      const blocked = checkCustomerAccess(managerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const managerCid = normalizeCid(managerCustomerId);
      if (!managerCid) return fail(`managerCustomerId inválido: "${managerCustomerId}". Nada foi gravado.`);
      if (!isNumericId(sharedSetId)) return fail(`sharedSetId deve ser numérico, recebido "${sharedSetId}". Nada foi gravado.`);
      const clients = numericIds(ensureArray<string>(clientCustomerIds).map((id) => String(id).replace(/-/g, "")));
      if (clients.invalid.length) return fail(`clientCustomerIds inválidos: ${clients.invalid.join(", ")}. Nada foi gravado.`);
      if (clients.ids.length === 0) return fail("Informe ao menos uma conta cliente em clientCustomerIds. Nada foi gravado.");
      if (clients.ids.includes(managerCid)) return fail("A própria MCC não recebe a lista — informe contas clientes. Nada foi gravado.");
      for (const id of clients.ids) {
        const denied = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (denied) return { content: [denied], isError: true };
      }

      const client = ctx.getClient();
      const managerRows = await client.searchStream(managerCid,
        "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1");
      const manager = (managerRows[0]?.customer ?? {}) as Row;
      if (manager.manager !== true) return fail(`A conta ${managerCid} não é gerente (MCC). Nada foi gravado.`);
      const setResource = `customers/${managerCid}/sharedSets/${sharedSetId}`;
      const setRows = await client.searchStream(managerCid,
        `SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count
         FROM shared_set
         WHERE shared_set.id = ${sharedSetId}`);
      const set = setRows[0]?.sharedSet as Row | undefined;
      if (!set) return fail(`Lista ${sharedSetId} não encontrada na MCC ${managerCid}. Nada foi gravado.`);
      if (set.type !== "NEGATIVE_PLACEMENTS" || set.status !== "ENABLED") {
        return fail(`A lista ${sharedSetId} ("${set.name}") é ${set.type}/${set.status} — precisa ser NEGATIVE_PLACEMENTS ativa. Nada foi gravado.`);
      }
      const hierarchy = await client.searchStream(managerCid,
        `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status
         FROM customer_client
         WHERE customer_client.id IN (${clients.ids.join(", ")})`);
      const underManager = new Map(hierarchy.map((row) => {
        const info = (row.customerClient ?? {}) as Row;
        return [String(info.id), info];
      }));
      const outside = clients.ids.filter((id) => !underManager.has(id));
      if (outside.length) return fail(`Conta(s) fora da hierarquia da MCC ${managerCid}: ${outside.join(", ")}. Nada foi gravado.`);

      const dryRun = client.isDryRun;
      const listView = { manager_customer_id: managerCid, shared_set_id: sharedSetId, name: set.name, items: Number(set.memberCount ?? 0) };
      if (confirm !== true && !dryRun) {
        return fail(
          `Confirmação necessária: aplicar a lista "${set.name}" (${listView.items} itens) no nível de conta de ` +
          `${clients.ids.length} cliente(s). Reenvie com confirm: true. Nada foi gravado.\n\n` +
          formatJson({ list: listView, clients: clients.ids.map((id) => ({ customer_id: id, name: underManager.get(id)?.descriptiveName })) })
        );
      }

      const results: Row[] = [];
      for (const id of clients.ids) {
        const info = underManager.get(id) ?? {};
        const view: Row = { customer_id: id, name: info.descriptiveName };
        if (info.status && info.status !== "ENABLED") {
          results.push({ ...view, status: "error", error: `conta ${info.status}` });
          continue;
        }
        try {
          const existing = await client.searchStream(id,
            `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.placement_list.shared_set
             FROM customer_negative_criterion
             WHERE customer_negative_criterion.type = 'PLACEMENT_LIST'`);
          const sets = existing.map((row) => String((((row.customerNegativeCriterion ?? {}) as Row).placementList as Row | undefined)?.sharedSet ?? ""));
          if (sets.includes(setResource)) {
            results.push({ ...view, status: "already_attached" });
            continue;
          }
          const managerLists = sets.filter((s) => !s.startsWith(`customers/${id}/`)).length;
          if (managerLists >= MAX_MANAGER_LISTS_PER_CLIENT) {
            results.push({ ...view, status: "error", error: `a conta já recebe ${managerLists} listas de MCC (limite ${MAX_MANAGER_LISTS_PER_CLIENT})` });
            continue;
          }
          const response = await client.mutate(id, "customerNegativeCriteria", [{ create: { placementList: { sharedSet: setResource } } }]);
          const resourceName = ((response.results as Row[] | undefined) ?? [])[0]?.resourceName;
          if (!dryRun && !resourceName) results.push({ ...view, status: "error", error: "a API não confirmou a gravação" });
          else results.push({ ...view, status: dryRun ? "validated" : "attached", ...(resourceName ? { resource_name: resourceName } : {}) });
        } catch (err) {
          results.push({ ...view, status: "error", error: explainApiError(errorMessage(err)) });
        }
      }
      const count = (status: string) => results.filter((r) => r.status === status).length;
      const errors = count("error");
      return done(
        (dryRun
          ? `Lista "${set.name}" — ${DRY_RUN_NOTE} Validadas: ${count("validated")}`
          : `Lista "${set.name}" aplicada em ${count("attached")} conta(s)`) +
        ` | Já recebiam: ${count("already_attached")} | Erros: ${errors}\n\n${formatJson({ list: listView, clients: results })}`,
        errors > 0
      );
    }
  );

  // ── Brand safety na conta ──────────────────────────────────────────

  mcp.registerTool(
    "list_account_exclusions",
    {
      description: [
        "Lista as exclusões no nível da conta (customer_negative_criterion): sites, canais/vídeos do YouTube, apps,",
        "categorias de app, rótulos de conteúdo, IPs, listas de posicionamento (inclusive de MCC) e a lista de",
        "palavras negativas da conta — mais o tipo de inventário de vídeo (video_brand_safety_suitability).",
        "Essas exclusões valem para todas as campanhas, inclusive Performance Max.",
        "Os criterion_id servem para remove_account_exclusions.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        type: z.enum(ACCOUNT_EXCLUSION_TYPES).optional().describe("Filtrar por tipo."),
        format: formatSchema,
      },
    },
    async ({ customerId, type, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${CUSTOMER_NEGATIVE_FIELDS}
         FROM customer_negative_criterion${type ? `\n         WHERE customer_negative_criterion.type = '${type}'` : ""}`);
      const exclusions = rows.map(accountExclusionView);
      const customerRows = await client.searchStream(customerId,
        "SELECT customer.id, customer.descriptive_name, customer.video_brand_safety_suitability FROM customer LIMIT 1");
      const customer = (customerRows[0]?.customer ?? {}) as Row;

      // nomes das listas da própria conta (as de MCC só a MCC enxerga)
      const ownSets = [...new Set(exclusions
        .filter((e) => (e.type === "PLACEMENT_LIST" || e.type === "NEGATIVE_KEYWORD_LIST") && String(e.value).startsWith(`customers/${cid}/`))
        .map((e) => String(e.value)))];
      if (ownSets.length > 0) {
        const setRows = await client.searchStream(customerId,
          `SELECT shared_set.resource_name, shared_set.name, shared_set.member_count
           FROM shared_set
           WHERE shared_set.resource_name IN (${ownSets.map((s) => `'${s}'`).join(", ")})`);
        const names = new Map(setRows.map((row) => {
          const set = (row.sharedSet ?? {}) as Row;
          return [String(set.resourceName), `${set.name} (${set.memberCount ?? 0} itens)`];
        }));
        for (const exclusion of exclusions) {
          const name = names.get(String(exclusion.value));
          if (name) exclusion.name = name;
        }
      }
      for (const exclusion of exclusions) {
        if ((exclusion.type === "PLACEMENT_LIST") && !String(exclusion.value).startsWith(`customers/${cid}/`)) {
          exclusion.name = `lista da MCC ${String(exclusion.value).split("/")[1]}`;
        }
      }

      if (format === "table") return done(formatAsTable(exclusions));
      if (format === "csv") return done(formatAsCsv(exclusions));
      const counts: Record<string, number> = {};
      for (const exclusion of exclusions) counts[String(exclusion.type)] = (counts[String(exclusion.type)] ?? 0) + 1;
      return done(
        `${exclusions.length} exclusão(ões) na conta ${cid}.` +
        ` Inventário de vídeo: ${customer.videoBrandSafetySuitability ?? "não informado"}.\n\n` +
        formatJson({
          video_brand_safety_suitability: customer.videoBrandSafetySuitability ?? null,
          counts,
          by_type: groupByType(exclusions),
        })
      );
    }
  );

  mcp.registerTool(
    "remove_account_exclusions",
    {
      description: [
        "Remove exclusões do nível da conta (customer_negative_criterion) — sites, YouTube, apps, rótulos de conteúdo,",
        "IPs, listas de posicionamento (inclusive de MCC) ou a lista de negativas da conta.",
        "WRITE OPERATION — o inventário volta a ficar disponível em TODAS as campanhas. Exige confirm: true",
        "(validateOnly dispensa); sem ele a tool só mostra o que seria removido.",
        "Identifique por criterionIds ou resourceNames (list_account_exclusions). Relatório por item (partialFailure).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        criterionIds: flexArray(z.string()).optional().describe("IDs (customer_negative_criterion.id)."),
        resourceNames: flexArray(z.string()).optional().describe("customers/{customerId}/customerNegativeCriteria/{id}."),
        confirm: z.boolean().optional().describe("true para remover de fato."),
      },
    },
    async ({ customerId, criterionIds, resourceNames, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      const byId = numericIds(criterionIds);
      const invalid = [...byId.invalid.map((id) => `criterionId "${id}" não é numérico`)];
      const ids = new Set(byId.ids);
      for (const name of ensureArray<string>(resourceNames).map((n) => String(n).trim()).filter(Boolean)) {
        const match = /^customers\/(\d+)\/customerNegativeCriteria\/(\d+)$/.exec(name);
        if (!match) invalid.push(`"${name}" não é um resource name de customerNegativeCriteria`);
        else if (match[1] !== cid) invalid.push(`${name} é da conta ${match[1]}, não da ${cid}`);
        else ids.add(match[2]);
      }
      if (invalid.length) return fail(`Nada foi removido:\n- ${invalid.join("\n- ")}`);
      if (ids.size === 0) return fail("Informe criterionIds ou resourceNames. Nada foi removido.");
      if (ids.size > MAX_ITEMS_PER_CALL) return fail(`No máximo ${MAX_ITEMS_PER_CALL} por chamada. Nada foi removido.`);

      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${CUSTOMER_NEGATIVE_FIELDS}
         FROM customer_negative_criterion
         WHERE customer_negative_criterion.id IN (${[...ids].join(", ")})`);
      const found = rows.map(accountExclusionView);
      const notFound = [...ids].filter((id) => !found.some((f) => f.criterion_id === id));
      if (found.length === 0) return fail(`Nenhuma das exclusões pedidas existe na conta ${cid}. Nada foi removido.\nNão encontradas: ${notFound.join(", ")}`);
      const dryRun = client.isDryRun;
      if (confirm !== true && !dryRun) {
        return fail(
          `Confirmação necessária: remover ${found.length} exclusão(ões) da conta ${cid} (voltam a valer para todas as ` +
          `campanhas). Reenvie com confirm: true. Nada foi removido.\n\n${formatJson({ would_remove: found, not_found: notFound })}`
        );
      }
      let outcome: Awaited<ReturnType<typeof applyPartial>>;
      try {
        outcome = await applyPartial(client, customerId, "customerNegativeCriteria",
          found.map((item) => ({
            describe: { criterion_id: item.criterion_id, type: item.type, value: item.value },
            op: { remove: String(item.resource_name) },
          })));
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi removido.`);
      }
      const { applied, errors } = outcome;
      return done(
        (dryRun ? `Conta ${cid} — ${DRY_RUN_NOTE} Validadas: ${applied.length}` : `Conta ${cid}: ${applied.length} exclusão(ões) removida(s)`) +
        ` | Não encontradas: ${notFound.length} | Erros: ${errors.length}\n\n` +
        formatJson({ [dryRun ? "validated" : "removed"]: applied, not_found: notFound, errors }),
        errors.length > 0
      );
    }
  );

  mcp.registerTool(
    "set_content_exclusions",
    {
      description: [
        "Exclui tipos de conteúdo (rótulos de conteúdo / content labels) na campanha ou na conta inteira — brand safety.",
        "WRITE OPERATION. mode ADD (padrão) só acrescenta; mode REPLACE deixa exatamente os labels informados e remove",
        "os outros (remover exige confirm: true; validateOnly dispensa). Sem mudança, nada é gravado.",
        "",
        "Labels (ContentLabelType v25): SEXUALLY_SUGGESTIVE, BELOW_THE_FOLD, PARKED_DOMAIN, JUVENILE, PROFANITY,",
        "TRAGEDY, VIDEO, VIDEO_RATING_DV_G/PG/T/MA, VIDEO_NOT_YET_RATED, EMBEDDED_VIDEO, LIVE_STREAMING_VIDEO,",
        "SOCIAL_ISSUES e os BRAND_SUITABILITY_* (conteúdo para famílias/Made for Kids, jogos de luta, jogos adultos,",
        "saúde sensível, notícias recentes/sensíveis, política, religião…).",
        "level CAMPAIGN: Display, Vídeo, Demand Gen etc. Performance Max só aceita no nível ACCOUNT (vale para a conta toda).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["CAMPAIGN", "ACCOUNT"]).describe("Campanha ou conta inteira."),
        campaignId: z.string().optional().describe("Obrigatório com level CAMPAIGN."),
        labels: flexArray(z.enum(CONTENT_LABELS)).describe("Rótulos de conteúdo a excluir."),
        mode: z.enum(["ADD", "REPLACE"]).optional().describe("ADD (padrão) ou REPLACE."),
        confirm: z.boolean().optional().describe("true para permitir remoções no modo REPLACE."),
      },
    },
    async ({ customerId, level, campaignId, labels, mode, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      const levelError = checkLevelIds(level, campaignId, undefined);
      if (levelError) return fail(`${levelError} Nada foi gravado.`);
      const wanted = [...new Set(ensureArray<string>(labels).map((l) => String(l).trim().toUpperCase()).filter(Boolean))];
      const unknown = wanted.filter((label) => !(CONTENT_LABELS as readonly string[]).includes(label));
      if (unknown.length) return fail(`Rótulo(s) inválido(s): ${unknown.join(", ")}. Válidos: ${CONTENT_LABELS.join(", ")}. Nada foi gravado.`);
      const replace = (mode ?? "ADD") === "REPLACE";
      if (wanted.length === 0 && !replace) return fail("Informe ao menos um rótulo em labels (ou mode REPLACE com lista vazia para limpar). Nada foi gravado.");

      const client = ctx.getClient();
      const target = await loadTarget(client, customerId, cid, level, campaignId);
      if (typeof target === "string") return fail(target);
      if (target.channel === "PERFORMANCE_MAX") return fail(PMAX_ACCOUNT_LEVEL);
      const rows = level === "CAMPAIGN"
        ? await client.searchStream(customerId,
          `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.criterion_id,
                  campaign_criterion.content_label.type
           FROM campaign_criterion
           WHERE campaign.id = ${campaignId}
             AND campaign_criterion.type = 'CONTENT_LABEL'
             AND campaign_criterion.status != 'REMOVED'`)
        : await client.searchStream(customerId,
          `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.id,
                  customer_negative_criterion.content_label.type
           FROM customer_negative_criterion
           WHERE customer_negative_criterion.type = 'CONTENT_LABEL'`);
      const current = new Map<string, string>();
      for (const row of rows) {
        const criterion = (row.campaignCriterion ?? row.customerNegativeCriterion ?? {}) as Row;
        const label = String(((criterion.contentLabel ?? {}) as Row).type ?? "");
        if (label) current.set(label, String(criterion.resourceName ?? ""));
      }
      const toAdd = wanted.filter((label) => !current.has(label));
      const toRemove = replace ? [...current.keys()].filter((label) => !wanted.includes(label)) : [];
      const before = [...current.keys()].sort();
      const after = [...new Set([...before.filter((l) => !toRemove.includes(l)), ...toAdd])].sort();
      const base = { target: targetView(target), mode: replace ? "REPLACE" : "ADD", before, after };
      if (toAdd.length + toRemove.length === 0) {
        return done(`${target.label}: nada a mudar — os rótulos já estão como pedido.\n\n${formatJson(base)}`);
      }
      if (toRemove.length > 0 && confirm !== true && !client.isDryRun) {
        return fail(
          `Confirmação necessária: o modo REPLACE remove ${toRemove.length} exclusão(ões) de conteúdo (${toRemove.join(", ")}) ` +
          `de ${target.label}. Reenvie com confirm: true. Nada foi gravado.\n\n${formatJson(base)}`
        );
      }
      let outcome: Awaited<ReturnType<typeof applyPartial>>;
      try {
        outcome = await applyPartial(client, customerId, mutateResourceFor(level), [
          ...toAdd.map((label) => ({
            describe: { action: "add", label },
            op: { create: criterionCreate(target, { contentLabel: { type: label } }, true) },
          })),
          ...toRemove.map((label) => ({ describe: { action: "remove", label }, op: { remove: current.get(label) ?? "" } })),
        ]);
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const { applied, errors, dryRun } = outcome;
      return done(
        (dryRun ? `${target.label} — ${DRY_RUN_NOTE} Validadas: ${applied.length}` : `${target.label}: ${applied.length} mudança(s) em exclusões de conteúdo`) +
        ` | Erros: ${errors.length}\n\n` + formatJson({ ...base, [dryRun ? "validated" : "applied"]: applied, errors }),
        errors.length > 0
      );
    }
  );

  mcp.registerTool(
    "set_video_inventory_type",
    {
      description: [
        "Define o tipo de inventário de vídeo da conta (brand safety do YouTube e parceiros de vídeo):",
        "EXPANDED_INVENTORY (inventário ampliado), STANDARD_INVENTORY (padrão) ou LIMITED_INVENTORY (limitado).",
        "WRITE OPERATION — vale para a conta inteira (desde a v24 o ajuste é só no nível da conta:",
        "Customer.video_brand_safety_suitability). Exige confirm: true (validateOnly dispensa); sem ele mostra antes/depois.",
        "Se o valor já é o pedido, nada é gravado. O valor atual também aparece em list_account_exclusions.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        suitability: z.enum(VIDEO_SUITABILITY_VALUES).describe("EXPANDED(_INVENTORY), STANDARD(_INVENTORY) ou LIMITED(_INVENTORY)."),
        confirm: z.boolean().optional().describe("true para gravar."),
      },
    },
    async ({ customerId, suitability, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      const wanted = VIDEO_SUITABILITY_ALIASES[suitability] ?? suitability;
      if (!["EXPANDED_INVENTORY", "STANDARD_INVENTORY", "LIMITED_INVENTORY"].includes(wanted)) {
        return fail(`suitability inválido: "${suitability}". Nada foi gravado.`);
      }
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        "SELECT customer.id, customer.descriptive_name, customer.manager, customer.video_brand_safety_suitability FROM customer LIMIT 1");
      const customer = rows[0]?.customer as Row | undefined;
      if (!customer) return fail(`Conta ${cid} não encontrada. Nada foi gravado.`);
      const before = customer.videoBrandSafetySuitability ?? null;
      const view = { customer_id: cid, name: customer.descriptiveName, before, after: wanted };
      if (before === wanted) return done(`Conta ${cid}: o inventário de vídeo já é ${wanted}. Nada foi gravado.\n\n${formatJson(view)}`);
      const dryRun = client.isDryRun;
      if (confirm !== true && !dryRun) {
        return fail(
          `Confirmação necessária: mudar o inventário de vídeo da conta ${cid} de ${before ?? "(não informado)"} para ${wanted} ` +
          `(vale para todas as campanhas de vídeo). Reenvie com confirm: true. Nada foi gravado.\n\n${formatJson(view)}`
        );
      }
      let response: Row;
      try {
        response = await client.batchMutate(customerId, [{
          customerOperation: {
            update: { resourceName: `customers/${cid}`, videoBrandSafetySuitability: wanted },
            updateMask: "video_brand_safety_suitability",
          },
        }]);
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const confirmed = (((response.mutateOperationResponses as Row[] | undefined) ?? [])[0]?.customerResult as Row | undefined)?.resourceName;
      if (!dryRun && !confirmed) return fail(`A API não confirmou a mudança — confira com list_account_exclusions.\n\n${formatJson(response)}`);
      return done(
        (dryRun ? `Conta ${cid} — ${DRY_RUN_NOTE}` : `Conta ${cid}: inventário de vídeo ${before ?? "(não informado)"} → ${wanted}.`) +
        `\n\n${formatJson(view)}`
      );
    }
  );

  mcp.registerTool(
    "add_ip_exclusions",
    {
      description: [
        "Exclui endereços IP (IPv4/IPv6 individuais ou blocos CIDR) na campanha ou na conta inteira — ex.: IPs da",
        "própria empresa, de concorrentes ou de fraude de cliques em lead-gen.",
        "WRITE OPERATION — cria critérios IpBlock negativos; não mexe em mais nada.",
        "",
        "Formatos: 203.0.113.7, 203.0.113.0/24, 2001:db8::1, 2001:db8::/48; '203.0.113.*' vira 203.0.113.0/24.",
        "Limite do Google: 500 IPs por campanha e 500 na conta (a tool soma com os existentes antes de gravar).",
        "IP já excluído é pulado. Na campanha não vale para Vídeo, Hotel, App, Performance Max e Display inteligente",
        "— para esses use level ACCOUNT (vale para todas as campanhas, inclusive PMax).",
        "Desfazer: remove_targeting_criteria (campanha) ou remove_account_exclusions (conta).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["CAMPAIGN", "ACCOUNT"]).describe("Campanha ou conta inteira."),
        campaignId: z.string().optional().describe("Obrigatório com level CAMPAIGN."),
        ips: flexArray(z.string()).describe("IPs ou blocos CIDR a excluir."),
      },
    },
    async ({ customerId, level, campaignId, ips }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      const levelError = checkLevelIds(level, campaignId, undefined);
      if (levelError) return fail(`${levelError} Nada foi gravado.`);
      const errors: string[] = [];
      const wanted = new Map<string, Row>();
      for (const raw of ensureArray<string>(ips).map((ip) => String(ip))) {
        const parsed = parseIpBlock(raw);
        if ("error" in parsed) errors.push(parsed.error);
        else if (!wanted.has(parsed.value)) wanted.set(parsed.value, { ip: parsed.value, ...(parsed.value !== raw.trim() ? { input: raw.trim() } : {}), ...(parsed.note ? { note: parsed.note } : {}) });
      }
      if (errors.length) return fail(`Nada foi gravado — IP(s) inválido(s):\n- ${errors.join("\n- ")}`);
      if (wanted.size === 0) return fail("Informe ao menos um IP em ips. Nada foi gravado.");
      if (wanted.size > MAX_IP_EXCLUSIONS) return fail(`No máximo ${MAX_IP_EXCLUSIONS} IPs (limite do Google). Nada foi gravado.`);

      const client = ctx.getClient();
      const target = await loadTarget(client, customerId, cid, level, campaignId);
      if (typeof target === "string") return fail(target);
      if (target.channel && (NO_CAMPAIGN_IP_EXCLUSION.has(target.channel) || target.subType === "DISPLAY_SMART_CAMPAIGN")) {
        return fail(
          `${target.label} é ${target.channel}${target.subType && target.subType !== "UNSPECIFIED" ? `/${target.subType}` : ""}: ` +
          "o Google não aceita exclusão de IP na campanha para Vídeo, Hotel, App, Performance Max e Display inteligente. " +
          "Use level ACCOUNT (vale para todas as campanhas da conta). Nada foi gravado."
        );
      }
      const rows = level === "CAMPAIGN"
        ? await client.searchStream(customerId,
          `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.criterion_id,
                  campaign_criterion.ip_block.ip_address
           FROM campaign_criterion
           WHERE campaign.id = ${campaignId}
             AND campaign_criterion.type = 'IP_BLOCK'
             AND campaign_criterion.status != 'REMOVED'`)
        : await client.searchStream(customerId,
          `SELECT customer_negative_criterion.resource_name, customer_negative_criterion.id,
                  customer_negative_criterion.ip_block.ip_address
           FROM customer_negative_criterion
           WHERE customer_negative_criterion.type = 'IP_BLOCK'`);
      const existing = new Set(rows.map((row) => {
        const criterion = (row.campaignCriterion ?? row.customerNegativeCriterion ?? {}) as Row;
        return String(((criterion.ipBlock ?? {}) as Row).ipAddress ?? "").toLowerCase();
      }));
      const already = [...wanted.values()].filter((item) => existing.has(String(item.ip).toLowerCase()));
      const toCreate = [...wanted.values()].filter((item) => !existing.has(String(item.ip).toLowerCase()));
      const base = { target: targetView(target), existing_count: existing.size, already_excluded: already };
      if (toCreate.length === 0) return done(`${target.label}: todos os IPs já estão excluídos. Nada foi gravado.\n\n${formatJson(base)}`);
      if (existing.size + toCreate.length > MAX_IP_EXCLUSIONS) {
        return fail(
          `${target.label} já tem ${existing.size} IP(s) excluído(s); com ${toCreate.length} novo(s) passaria do limite de ` +
          `${MAX_IP_EXCLUSIONS}. Nada foi gravado.`
        );
      }
      let outcome: Awaited<ReturnType<typeof applyPartial>>;
      try {
        outcome = await applyPartial(client, customerId, mutateResourceFor(level),
          toCreate.map((item) => ({ describe: item, op: { create: criterionCreate(target, { ipBlock: { ipAddress: item.ip } }, true) } })));
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const { applied, errors: opErrors, dryRun } = outcome;
      return done(
        (dryRun ? `${target.label} — ${DRY_RUN_NOTE} Validados: ${applied.length}` : `${target.label}: ${applied.length} IP(s) excluído(s)`) +
        ` | Já excluídos: ${already.length} | Erros: ${opErrors.length}\n\n` +
        formatJson({ ...base, [dryRun ? "validated" : "excluded"]: applied, errors: opErrors }),
        opErrors.length > 0
      );
    }
  );

  // ── Visão da segmentação e desfazer ────────────────────────────────

  mcp.registerTool(
    "get_targeting_overview",
    {
      description: [
        "Mostra TODA a segmentação de uma campanha num lugar só: locais (e raio), idiomas, dispositivos, programação,",
        "demografia, públicos, tópicos, posicionamentos, exclusões de conteúdo e IP, com negativo/positivo, ajustes de",
        "lance (bid_modifier) e nomes resolvidos (display_name); mais as configurações da campanha (presença/interesse,",
        "redes, Observação×Segmentação, audience grouped), listas compartilhadas aplicadas e, com includeAdGroups,",
        "a segmentação e a segmentação otimizada de cada grupo.",
        "Palavras-chave e listing groups ficam de fora (list_negative_keywords / get_keyword_performance).",
        "Cada critério traz o resource_name — é a entrada de remove_targeting_criteria (desfazer).",
        "Também conta as exclusões no nível da conta, que valem para a campanha (detalhe em list_account_exclusions).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        includeAdGroups: z.boolean().optional().describe("Incluir grupos de anúncios. Default: true."),
        adGroupId: z.string().optional().describe("Só este grupo de anúncios."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, includeAdGroups, adGroupId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!isNumericId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (adGroupId !== undefined && !isNumericId(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      const client = ctx.getClient();
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.advertising_channel_sub_type, campaign.geo_target_type_setting.positive_geo_target_type,
                campaign.geo_target_type_setting.negative_geo_target_type, campaign.targeting_setting.target_restrictions,
                campaign.audience_setting.use_audience_grouped, campaign.network_settings.target_google_search,
                campaign.network_settings.target_search_network, campaign.network_settings.target_content_network,
                campaign.network_settings.target_partner_search_network, campaign.network_settings.target_youtube,
                campaign.network_settings.target_google_tv_network
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = campaignRows[0]?.campaign as Row | undefined;
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}.`);

      const criteriaRows = await client.searchStream(customerId,
        `SELECT campaign.id, ${CAMPAIGN_CRITERION_OVERVIEW_FIELDS.join(", ")}
         FROM campaign_criterion
         WHERE campaign.id = ${campaignId}
           AND campaign_criterion.status != 'REMOVED'
           AND campaign_criterion.type != 'KEYWORD'`);
      const campaignCriteria = criteriaRows.map((row) => criterionView((row.campaignCriterion ?? {}) as Row));
      const sharedRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign_shared_set.shared_set, campaign_shared_set.status, shared_set.id, shared_set.name,
                shared_set.type, shared_set.member_count
         FROM campaign_shared_set
         WHERE campaign.id = ${campaignId}
           AND campaign_shared_set.status = 'ENABLED'`);
      const sharedSets = sharedRows.map((row) => {
        const set = (row.sharedSet ?? {}) as Row;
        return { shared_set_id: String(set.id ?? ""), name: set.name, type: set.type, items: Number(set.memberCount ?? 0) };
      });
      const accountRows = await client.searchStream(customerId,
        `SELECT customer_negative_criterion.id, customer_negative_criterion.type
         FROM customer_negative_criterion`);
      const accountCounts: Record<string, number> = {};
      for (const row of accountRows) {
        const type = String(((row.customerNegativeCriterion ?? {}) as Row).type ?? "");
        accountCounts[type] = (accountCounts[type] ?? 0) + 1;
      }

      const adGroups: Row[] = [];
      const adGroupCriteriaFlat: Row[] = [];
      if (includeAdGroups !== false || adGroupId) {
        const agFilter = adGroupId ? ` AND ad_group.id = ${adGroupId}` : "";
        const agRows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.targeting_setting.target_restrictions,
                  ad_group.optimized_targeting_enabled, ad_group.exclude_demographic_expansion
           FROM ad_group
           WHERE campaign.id = ${campaignId}
             AND ad_group.status != 'REMOVED'${agFilter}`);
        const agcRows = await client.searchStream(customerId,
          `SELECT ad_group.id, ${AD_GROUP_CRITERION_OVERVIEW_FIELDS.join(", ")}
           FROM ad_group_criterion
           WHERE campaign.id = ${campaignId}
             AND ad_group_criterion.status != 'REMOVED'
             AND ad_group_criterion.type NOT IN ('KEYWORD', 'LISTING_GROUP')${agFilter}`);
        const byGroup = new Map<string, Row[]>();
        for (const row of agcRows) {
          const id = String(((row.adGroup ?? {}) as Row).id ?? "");
          const view = criterionView((row.adGroupCriterion ?? {}) as Row);
          byGroup.set(id, [...(byGroup.get(id) ?? []), view]);
          adGroupCriteriaFlat.push({ level: "AD_GROUP", ad_group_id: id, ...view });
        }
        for (const row of agRows) {
          const group = (row.adGroup ?? {}) as Row;
          const id = String(group.id ?? "");
          adGroups.push({
            ad_group_id: id,
            name: group.name,
            status: group.status,
            type: group.type,
            optimized_targeting_enabled: group.optimizedTargetingEnabled ?? false,
            exclude_demographic_expansion: group.excludeDemographicExpansion ?? false,
            target_restrictions: (group.targetingSetting as Row | undefined)?.targetRestrictions ?? [],
            criteria: groupByType(byGroup.get(id) ?? []),
          });
        }
      }

      if (format === "table" || format === "csv") {
        const flat = [
          ...campaignCriteria.map((view) => ({ level: "CAMPAIGN", ad_group_id: "", ...view, detail: JSON.stringify(view.detail ?? {}) })),
          ...adGroupCriteriaFlat.map((view) => ({ ...view, detail: JSON.stringify(view.detail ?? {}) })),
        ];
        return done(format === "table" ? formatAsTable(flat) : formatAsCsv(flat));
      }
      const all = [...campaignCriteria, ...adGroupCriteriaFlat];
      const bidModifiers = all
        .filter((view) => typeof view.bid_modifier === "number" && view.bid_modifier !== 1)
        .map((view) => ({ type: view.type, display_name: view.display_name, bid_modifier: view.bid_modifier, resource_name: view.resource_name }));
      const network = (campaign.networkSettings ?? {}) as Row;
      const notes: string[] = [];
      if (campaign.advertisingChannelType === "SEARCH" && campaignCriteria.some((view) => view.type === "LANGUAGE")) {
        notes.push(
          "Pesquisa não usa mais o critério de idioma (desde set/2026 vale o idioma do anúncio); a API ainda o devolve. " +
          "Remover é opcional (limpeza): remove_targeting_criteria com os resource_name de LANGUAGE."
        );
      }
      return done(
        `Segmentação da campanha ${campaignId} ("${campaign.name}"): ${campaignCriteria.length} critério(s) na campanha, ` +
        `${adGroupCriteriaFlat.length} nos grupos.\n\n` +
        formatJson({
          campaign: {
            campaign_id: String(campaign.id ?? campaignId),
            name: campaign.name,
            status: campaign.status,
            channel: campaign.advertisingChannelType,
            sub_type: campaign.advertisingChannelSubType,
          },
          settings: {
            geo_target_type: campaign.geoTargetTypeSetting ?? null,
            target_restrictions: (campaign.targetingSetting as Row | undefined)?.targetRestrictions ?? [],
            use_audience_grouped: (campaign.audienceSetting as Row | undefined)?.useAudienceGrouped ?? null,
            networks: network,
          },
          campaign_criteria: groupByType(campaignCriteria),
          shared_sets: sharedSets,
          bid_modifiers: bidModifiers,
          account_level_exclusions: accountCounts,
          notes,
          ...(includeAdGroups !== false || adGroupId ? { ad_groups: adGroups } : {}),
        })
      );
    }
  );

  mcp.registerTool(
    "remove_targeting_criteria",
    {
      description: [
        "Desfaz segmentação: remove critérios de campanha ou de grupo de anúncios pelo resource name",
        "(customers/{id}/campaignCriteria/{campanha}~{critério} ou …/adGroupCriteria/{grupo}~{critério}) —",
        "locais, raio, idiomas, dispositivos, programação, demografia, públicos, tópicos, posicionamentos,",
        "exclusões de conteúdo e IP, e ajustes de lance.",
        "WRITE OPERATION ATÔMICA (tudo ou nada). Exige confirm: true (validateOnly dispensa); sem ele mostra o que sairia.",
        "",
        "Recusa palavras-chave (use remove_keyword / remove_negative_keyword) e listing groups de Shopping (set_shopping_product_groups / exclude_products),",
        "resource name de outra conta e critério inexistente. Avisa quando a campanha fica sem nenhum local ou idioma",
        "positivo (passa a valer para todos). Idioma em campanha de Pesquisa não é mais usado pelo Google (set/2026):",
        "removê-lo é só limpeza. Pegue os resource names em get_targeting_overview.",
        "Exclusões da conta: remove_account_exclusions.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceNames: flexArray(z.string()).describe("Resource names dos critérios (get_targeting_overview)."),
        confirm: z.boolean().optional().describe("true para remover de fato."),
      },
    },
    async ({ customerId, resourceNames, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      const names = [...new Set(ensureArray<string>(resourceNames).map((n) => String(n).trim()).filter(Boolean))];
      if (names.length === 0) return fail("Informe ao menos um resource name. Nada foi removido.");
      if (names.length > MAX_ITEMS_PER_CALL) return fail(`No máximo ${MAX_ITEMS_PER_CALL} por chamada. Nada foi removido.`);
      const invalid: string[] = [];
      const campaignNames: string[] = [];
      const adGroupNames: string[] = [];
      for (const name of names) {
        const match = /^customers\/(\d+)\/(campaignCriteria|adGroupCriteria)\/(\d+)~(\d+)$/.exec(name);
        if (!match) {
          invalid.push(/customerNegativeCriteria/.test(name)
            ? `${name}: exclusão da conta — use remove_account_exclusions`
            : `"${name}" não é resource name de campaignCriteria/adGroupCriteria`);
        } else if (match[1] !== cid) invalid.push(`${name} é da conta ${match[1]}, não da ${cid}`);
        else (match[2] === "campaignCriteria" ? campaignNames : adGroupNames).push(name);
      }
      if (invalid.length) return fail(`Nada foi removido:\n- ${invalid.join("\n- ")}`);

      const client = ctx.getClient();
      const quoted = (list: string[]) => list.map((n) => `'${n}'`).join(", ");
      const found = new Map<string, Row>();
      if (campaignNames.length) {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign_criterion.resource_name,
                  campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status,
                  campaign_criterion.display_name
           FROM campaign_criterion
           WHERE campaign_criterion.resource_name IN (${quoted(campaignNames)})`);
        for (const row of rows) {
          const criterion = (row.campaignCriterion ?? {}) as Row;
          const campaign = (row.campaign ?? {}) as Row;
          found.set(String(criterion.resourceName), {
            level: "CAMPAIGN", campaign_id: String(campaign.id ?? ""), campaign_name: campaign.name,
            channel: campaign.advertisingChannelType, type: criterion.type, negative: criterion.negative === true,
            status: criterion.status, display_name: criterion.displayName ?? null, resource_name: criterion.resourceName,
          });
        }
      }
      if (adGroupNames.length) {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, campaign.id, ad_group_criterion.resource_name, ad_group_criterion.type,
                  ad_group_criterion.negative, ad_group_criterion.status, ad_group_criterion.display_name
           FROM ad_group_criterion
           WHERE ad_group_criterion.resource_name IN (${quoted(adGroupNames)})`);
        for (const row of rows) {
          const criterion = (row.adGroupCriterion ?? {}) as Row;
          const adGroup = (row.adGroup ?? {}) as Row;
          found.set(String(criterion.resourceName), {
            level: "AD_GROUP", campaign_id: String(((row.campaign ?? {}) as Row).id ?? ""), ad_group_id: String(adGroup.id ?? ""),
            ad_group_name: adGroup.name, type: criterion.type, negative: criterion.negative === true, status: criterion.status,
            display_name: criterion.displayName ?? null, resource_name: criterion.resourceName,
          });
        }
      }
      const problems: string[] = [];
      for (const name of names) {
        const item = found.get(name);
        if (!item || item.status === "REMOVED") problems.push(`${name}: não existe (ou já foi removido) na conta ${cid}`);
        else if (item.type === "KEYWORD") problems.push(`${name}: palavra-chave — use remove_keyword / remove_negative_keyword`);
        else if (item.type === "LISTING_GROUP") problems.push(`${name}: grupo de produtos de Shopping — use set_shopping_product_groups (refazer a árvore) ou exclude_products (excluir itens)`);
      }
      if (problems.length) return fail(`Nada foi removido:\n- ${problems.join("\n- ")}`);
      const items = names.map((name) => found.get(name) as Row);

      // campanha que perde o último local ou idioma positivo passa a valer para todos.
      // Pesquisa não usa mais o critério de idioma (Ads Developer Blog, ago/2026): lá é só limpeza.
      const warnings: string[] = [];
      const notes: string[] = [];
      const searchLanguages = items.filter((item) => item.type === "LANGUAGE" && item.channel === "SEARCH");
      if (searchLanguages.length) {
        notes.push("idioma em campanha de Pesquisa não é mais usado para segmentar (desde set/2026 vale o idioma do anúncio) — remover é só limpeza");
      }
      const broadening = items.filter((item) => item.level === "CAMPAIGN" && !item.negative &&
        ["LOCATION", "PROXIMITY", "LOCATION_GROUP", "LANGUAGE"].includes(String(item.type)) &&
        !(item.type === "LANGUAGE" && item.channel === "SEARCH"));
      if (broadening.length) {
        const campaignIds = [...new Set(broadening.map((item) => String(item.campaign_id)))];
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.type
           FROM campaign_criterion
           WHERE campaign.id IN (${campaignIds.join(", ")})
             AND campaign_criterion.negative = false
             AND campaign_criterion.status != 'REMOVED'
             AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LOCATION_GROUP', 'LANGUAGE')`);
        const removing = new Set(names);
        for (const id of campaignIds) {
          const remaining = rows.filter((row) => String(((row.campaign ?? {}) as Row).id) === id &&
            !removing.has(String(((row.campaignCriterion ?? {}) as Row).resourceName)));
          const types = remaining.map((row) => String(((row.campaignCriterion ?? {}) as Row).type));
          const removesGeo = broadening.some((item) => item.campaign_id === id && item.type !== "LANGUAGE");
          const removesLanguage = broadening.some((item) => item.campaign_id === id && item.type === "LANGUAGE");
          if (removesGeo && !types.some((type) => type !== "LANGUAGE")) {
            warnings.push(`campanha ${id} fica sem local positivo — passa a segmentar TODOS os países e territórios`);
          }
          if (removesLanguage && !types.includes("LANGUAGE")) warnings.push(`campanha ${id} fica sem idioma — passa a valer para todos os idiomas`);
        }
      }

      const dryRun = client.isDryRun;
      if (confirm !== true && !dryRun) {
        return fail(
          `Confirmação necessária: remover ${items.length} critério(s) de segmentação. Reenvie com confirm: true. Nada foi removido.\n\n` +
          formatJson({ would_remove: items, warnings, notes })
        );
      }
      let response: Row;
      try {
        response = await client.batchMutate(customerId, items.map((item) =>
          item.level === "CAMPAIGN"
            ? { campaignCriterionOperation: { remove: item.resource_name } }
            : { adGroupCriterionOperation: { remove: item.resource_name } }));
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi removido (requisição atômica).`);
      }
      const responses = (response.mutateOperationResponses as Row[] | undefined) ?? [];
      if (!dryRun && responses.length !== items.length) {
        return fail(`A API confirmou ${responses.length} de ${items.length} remoções — confira com get_targeting_overview.\n\n${formatJson(response)}`);
      }
      return done(
        (dryRun ? `${DRY_RUN_NOTE} Validadas: ${items.length} remoção(ões).` : `${items.length} critério(s) removido(s).`) +
        `\n\n${formatJson({ [dryRun ? "validated" : "removed"]: items, warnings, notes })}`
      );
    }
  );

  // ── Display: tópicos, categorias de app e segmentação otimizada ─────

  mcp.registerTool(
    "list_topics",
    {
      description: [
        "Busca tópicos (topic_constant) para segmentar ou excluir em Display/Vídeo/Demand Gen com set_topic_targeting.",
        "query filtra pelo caminho da categoria (em inglês, ex.: 'Pets', 'Autos & Vehicles/Motor Vehicles'),",
        "sem diferenciar maiúsculas e acentos. parentId lista os filhos de um tópico. Devolve topic_id e caminho.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (para a consulta)."),
        query: z.string().optional().describe("Trecho do caminho do tópico."),
        parentId: z.string().optional().describe("Só os filhos diretos deste topic_id."),
        limit: z.number().optional().describe("Máximo de resultados. Default: 100 (máx. 1000)."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, parentId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!normalizeCid(customerId)) return fail(`customerId inválido: "${customerId}".`);
      if (parentId !== undefined && !isNumericId(parentId)) return fail(`parentId deve ser numérico, recebido "${parentId}".`);
      const max = Math.min(Math.max(Math.trunc(limit ?? 100), 1), 1000);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        "SELECT topic_constant.id, topic_constant.path, topic_constant.topic_constant_parent FROM topic_constant");
      const needle = query ? fold(query.trim()) : "";
      const topics = rows
        .map((row) => {
          const topic = (row.topicConstant ?? {}) as Row;
          const path = ((topic.path as string[] | undefined) ?? []).join("/");
          return {
            topic_id: String(topic.id ?? ""),
            path,
            parent_id: String(topic.topicConstantParent ?? "").split("/").pop() || null,
          };
        })
        .filter((topic) => topic.path && (!needle || fold(topic.path).includes(needle)))
        .filter((topic) => !parentId || topic.parent_id === parentId)
        .sort((a, b) => a.path.localeCompare(b.path));
      const shown = topics.slice(0, max);
      if (format === "table") return done(formatAsTable(shown));
      if (format === "csv") return done(formatAsCsv(shown));
      return done(`${topics.length} tópico(s)${topics.length > shown.length ? ` (mostrando ${shown.length})` : ""}.\n\n${formatJson(shown)}`);
    }
  );

  mcp.registerTool(
    "list_mobile_app_categories",
    {
      description: [
        "Busca categorias de app (mobile_app_category_constant) para excluir ou segmentar como MOBILE_APP_CATEGORY",
        "(exclude_placements, add_placement). query filtra pelo nome (em inglês, ex.: 'Games', 'Kids'), sem caixa/acento.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (para a consulta)."),
        query: z.string().optional().describe("Trecho do nome da categoria."),
        limit: z.number().optional().describe("Máximo de resultados. Default: 200."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!normalizeCid(customerId)) return fail(`customerId inválido: "${customerId}".`);
      const max = Math.min(Math.max(Math.trunc(limit ?? 200), 1), 2000);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        "SELECT mobile_app_category_constant.id, mobile_app_category_constant.name FROM mobile_app_category_constant");
      const needle = query ? fold(query.trim()) : "";
      const categories = rows
        .map((row) => {
          const category = (row.mobileAppCategoryConstant ?? {}) as Row;
          return { category_id: String(category.id ?? ""), name: String(category.name ?? "") };
        })
        .filter((category) => category.category_id && (!needle || fold(category.name).includes(needle)))
        .sort((a, b) => a.name.localeCompare(b.name));
      const shown = categories.slice(0, max);
      if (format === "table") return done(formatAsTable(shown));
      if (format === "csv") return done(formatAsCsv(shown));
      return done(`${categories.length} categoria(s) de app${categories.length > shown.length ? ` (mostrando ${shown.length})` : ""}.\n\n${formatJson(shown)}`);
    }
  );

  mcp.registerTool(
    "set_topic_targeting",
    {
      description: [
        "Segmenta tópicos no grupo de anúncios (negative false, padrão) ou exclui tópicos no grupo ou na campanha",
        "(negative true) — Display, Vídeo, Demand Gen. topicIds vêm de list_topics.",
        "Na CAMPANHA só existe exclusão: level CAMPAIGN exige negative: true (a API não aceita tópico positivo na",
        "campanha; para segmentar use level AD_GROUP).",
        "WRITE OPERATION — só acrescenta critérios de tópico; não mexe em lances nem em outra segmentação.",
        "Tópico já presente com a mesma polaridade é pulado; com a polaridade oposta é recusado (remova antes com",
        "remove_targeting_criteria). Performance Max não aceita tópicos. Relatório por item (partialFailure).",
        "Tópico positivo restringe o alcance ao tópico quando o grupo está em modo Segmentação.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["AD_GROUP", "CAMPAIGN"]).describe("AD_GROUP (segmentar ou excluir) ou CAMPAIGN (só excluir: negative true)."),
        adGroupId: z.string().optional().describe("Obrigatório com level AD_GROUP."),
        campaignId: z.string().optional().describe("Obrigatório com level CAMPAIGN."),
        topicIds: flexArray(z.string()).describe("IDs de tópico (list_topics)."),
        negative: z.boolean().optional().describe("true = excluir os tópicos (obrigatório com level CAMPAIGN). Default: false (segmentar, só no grupo)."),
      },
    },
    async ({ customerId, level, adGroupId, campaignId, topicIds, negative }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      const levelError = checkLevelIds(level, campaignId, adGroupId);
      if (levelError) return fail(`${levelError} Nada foi gravado.`);
      const isNegative = negative === true;
      if (level === "CAMPAIGN" && !isNegative) return fail(campaignNegativeOnly("tópico", "envie negative: true"));
      const topics = numericIds(topicIds);
      if (topics.invalid.length) return fail(`topicIds devem ser numéricos: ${topics.invalid.join(", ")}. Nada foi gravado.`);
      if (topics.ids.length === 0) return fail("Informe ao menos um topicId. Nada foi gravado.");
      if (topics.ids.length > MAX_ITEMS_PER_CALL) return fail(`No máximo ${MAX_ITEMS_PER_CALL} tópicos por chamada. Nada foi gravado.`);

      const client = ctx.getClient();
      const target = await loadTarget(client, customerId, cid, level, campaignId, adGroupId);
      if (typeof target === "string") return fail(target);
      if (target.channel === "PERFORMANCE_MAX") return fail("Performance Max não aceita segmentação por tópico. Nada foi gravado.");
      const topicRows = await client.searchStream(customerId,
        `SELECT topic_constant.id, topic_constant.path
         FROM topic_constant
         WHERE topic_constant.id IN (${topics.ids.join(", ")})`);
      const paths = new Map(topicRows.map((row) => {
        const topic = (row.topicConstant ?? {}) as Row;
        return [String(topic.id), ((topic.path as string[] | undefined) ?? []).join("/")];
      }));
      const unknown = topics.ids.filter((id) => !paths.has(id));
      if (unknown.length) return fail(`Tópico(s) inexistente(s): ${unknown.join(", ")} — veja list_topics. Nada foi gravado.`);

      const existingRows = level === "AD_GROUP"
        ? await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.negative, ad_group_criterion.topic.topic_constant
           FROM ad_group_criterion
           WHERE ad_group.id = ${adGroupId}
             AND ad_group_criterion.type = 'TOPIC'
             AND ad_group_criterion.status != 'REMOVED'`)
        : await client.searchStream(customerId,
          `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.topic.topic_constant
           FROM campaign_criterion
           WHERE campaign.id = ${campaignId}
             AND campaign_criterion.type = 'TOPIC'
             AND campaign_criterion.status != 'REMOVED'`);
      const existing = new Map<string, boolean>();
      for (const row of existingRows) {
        const criterion = (row.adGroupCriterion ?? row.campaignCriterion ?? {}) as Row;
        const id = String(((criterion.topic ?? {}) as Row).topicConstant ?? "").split("/").pop() ?? "";
        existing.set(id, criterion.negative === true);
      }
      const already: Row[] = [];
      const conflicts: Row[] = [];
      const toCreate: string[] = [];
      for (const id of topics.ids) {
        const view = { topic_id: id, path: paths.get(id) };
        if (!existing.has(id)) toCreate.push(id);
        else if (existing.get(id) === isNegative) already.push(view);
        else conflicts.push({ ...view, error: `já está como ${isNegative ? "segmentação" : "exclusão"} — remova antes (remove_targeting_criteria)` });
      }
      const base = { target: targetView(target), negative: isNegative, already_present: already, conflicts };
      if (toCreate.length === 0) {
        return done(`${target.label}: nada a gravar.\n\n${formatJson(base)}`, conflicts.length > 0);
      }
      let outcome: Awaited<ReturnType<typeof applyPartial>>;
      try {
        outcome = await applyPartial(client, customerId, mutateResourceFor(level),
          toCreate.map((id) => ({
            describe: { topic_id: id, path: paths.get(id) },
            op: { create: criterionCreate(target, { topic: { topicConstant: `topicConstants/${id}` } }, isNegative) },
          })));
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const { applied, errors, dryRun } = outcome;
      return done(
        (dryRun ? `${target.label} — ${DRY_RUN_NOTE} Validados: ${applied.length}` :
          `${target.label}: ${applied.length} tópico(s) ${isNegative ? "excluído(s)" : "segmentado(s)"}`) +
        ` | Já presentes: ${already.length} | Conflitos: ${conflicts.length} | Erros: ${errors.length}\n\n` +
        formatJson({ ...base, [dryRun ? "validated" : "created"]: applied, errors }),
        errors.length > 0 || (applied.length === 0 && conflicts.length > 0)
      );
    }
  );

  mcp.registerTool(
    "set_optimized_targeting",
    {
      description: [
        "Liga/desliga a segmentação otimizada (optimized_targeting_enabled) de um grupo de anúncios e, com ela ligada,",
        "se a expansão pode incluir demografia (exclude_demographic_expansion) — Display, Demand Gen e Vídeo.",
        "WRITE OPERATION — updateMask só com os campos que mudam; valor igual ao atual não é gravado. Mostra antes/depois.",
        "Com a otimização desligada, excludeDemographicExpansion é ignorado pelo Google.",
        "Ampliar o alcance (ligar a otimização, ou liberar a expansão demográfica com ela ligada) exige confirm: true",
        "(validateOnly dispensa): sem ele, mostra antes/depois e não grava. Desligar grava direto.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        enabled: z.boolean().optional().describe("true = ligar a segmentação otimizada; false = desligar."),
        excludeDemographicExpansion: z.boolean().optional().describe("true = não expandir por demografia."),
        confirm: z.boolean().optional().describe("true para gravar quando a mudança amplia o alcance."),
      },
    },
    async ({ customerId, adGroupId, enabled, excludeDemographicExpansion, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!isNumericId(adGroupId)) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi gravado.`);
      if (enabled === undefined && excludeDemographicExpansion === undefined) {
        return fail("Informe enabled e/ou excludeDemographicExpansion. Nada foi gravado.");
      }
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.optimized_targeting_enabled,
                ad_group.exclude_demographic_expansion, campaign.id, campaign.name, campaign.advertising_channel_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const adGroup = rows[0]?.adGroup as Row | undefined;
      const campaign = (rows[0]?.campaign ?? {}) as Row;
      if (!adGroup) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.`);
      if (adGroup.status === "REMOVED") return fail(`Grupo ${adGroupId} está removido. Nada foi gravado.`);
      const channel = String(campaign.advertisingChannelType ?? "");
      if (!["DISPLAY", "DEMAND_GEN", "VIDEO"].includes(channel)) {
        return fail(`Segmentação otimizada é de Display, Demand Gen e Vídeo; a campanha ${campaign.id} é ${channel}. Nada foi gravado.`);
      }
      const before = {
        optimized_targeting_enabled: adGroup.optimizedTargetingEnabled === true,
        exclude_demographic_expansion: adGroup.excludeDemographicExpansion === true,
      };
      const after = {
        optimized_targeting_enabled: enabled ?? before.optimized_targeting_enabled,
        exclude_demographic_expansion: excludeDemographicExpansion ?? before.exclude_demographic_expansion,
      };
      const update: Row = { resourceName: `customers/${cid}/adGroups/${adGroupId}` };
      const mask: string[] = [];
      if (after.optimized_targeting_enabled !== before.optimized_targeting_enabled) {
        update.optimizedTargetingEnabled = after.optimized_targeting_enabled;
        mask.push("optimized_targeting_enabled");
      }
      if (after.exclude_demographic_expansion !== before.exclude_demographic_expansion) {
        update.excludeDemographicExpansion = after.exclude_demographic_expansion;
        mask.push("exclude_demographic_expansion");
      }
      const warnings = after.exclude_demographic_expansion && !after.optimized_targeting_enabled
        ? ["excludeDemographicExpansion só tem efeito com a segmentação otimizada ligada"]
        : [];
      const label = `Grupo ${adGroupId} ("${adGroup.name}")`;
      if (mask.length === 0) return done(`${label}: nada a mudar.\n\n${formatJson({ before, after, warnings })}`);
      // Otimização ligada leva o grupo a gente fora dos públicos escolhidos; liberar a demografia com
      // ela ligada amplia mais. Gasto novo em público novo: mesmo portão do inventário de vídeo.
      const widens =
        (after.optimized_targeting_enabled && !before.optimized_targeting_enabled) ||
        (after.optimized_targeting_enabled && before.exclude_demographic_expansion && !after.exclude_demographic_expansion);
      if (widens && confirm !== true && !client.isDryRun) {
        return fail(
          `Confirmação necessária: ${label} passaria a alcançar pessoas fora dos públicos escolhidos ` +
            `(segmentação otimizada${after.exclude_demographic_expansion ? "" : " com expansão demográfica"}). ` +
            `Reenvie com confirm: true. Nada foi gravado.\n\n${formatJson({ before, after, update_mask: mask, warnings })}`
        );
      }
      let result: Row;
      try {
        result = await client.mutateAdGroups(customerId, [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
      }
      const dryRun = client.isDryRun;
      return done(
        (dryRun ? `${label} — ${DRY_RUN_NOTE}` : `${label}: segmentação otimizada atualizada.`) +
        `\n\n${formatJson({ before, after, update_mask: mask, warnings, result })}`
      );
    }
  );
}

// ── add_placement (registrada em src/tools.ts; a lógica fica aqui) ────

export interface AddPlacementArgs {
  customerId: string;
  adGroupId?: string;
  campaignId?: string;
  level?: "AD_GROUP" | "CAMPAIGN";
  type?: PlacementType;
  value?: string;
  url?: string;
  negative?: boolean;
}

/** Canais que aceitam posicionamento POSITIVO. */
const POSITIVE_PLACEMENT_CHANNELS = new Set(["DISPLAY", "VIDEO", "DEMAND_GEN"]);

/**
 * add_placement: um posicionamento (site, canal/vídeo do YouTube, app ou categoria de app) no grupo
 * (positivo ou negativo) ou na campanha (só negativo — campaignNegativeOnly). O access check fica na
 * tool (src/tools.ts).
 */
export async function addPlacementTool(getClient: () => GoogleAdsClient, args: AddPlacementArgs): Promise<ToolResult> {
  const cid = normalizeCid(args.customerId);
  if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi gravado.`);
  if (args.value !== undefined && args.url !== undefined && args.value.trim() !== args.url.trim()) {
    return fail("Informe o posicionamento em value (url é o nome antigo do mesmo campo) — não os dois com valores diferentes. Nada foi gravado.");
  }
  const raw = args.value ?? args.url;
  if (!raw || !raw.trim()) return fail("Informe value (URL, domínio, channel ID, video ID, app ID ou ID de categoria). Nada foi gravado.");
  const negative = args.negative === true;
  // Sem level: com adGroupId é o grupo; só com campaignId é a campanha — que só aceita exclusão (recusado abaixo
  // se negative não for true, antes de qualquer chamada).
  const level = args.level ?? (args.campaignId !== undefined && args.adGroupId === undefined ? "CAMPAIGN" : "AD_GROUP");
  const levelError = checkLevelIds(level, args.campaignId, args.adGroupId);
  if (levelError) return fail(`${levelError} Nada foi gravado.`);
  const placement = parsePlacement(raw, args.type);
  if ("error" in placement) return fail(`Nada foi gravado — ${placement.error}`);
  if (level === "CAMPAIGN" && !negative) {
    return fail(campaignNegativeOnly(
      `posicionamento (${placement.type} ${placement.value})`,
      "envie negative: true (ou use exclude_placements com level CAMPAIGN)"
    ));
  }

  const client = getClient();
  const target = await loadTarget(client, args.customerId, cid, level, args.campaignId, args.adGroupId);
  if (typeof target === "string") return fail(target);
  if (target.channel === "PERFORMANCE_MAX") {
    return fail(
      "Performance Max não aceita posicionamento na campanha. Para tirar inventário da PMax use exclude_placements " +
      "com level ACCOUNT (vale para todas as campanhas). Nada foi gravado."
    );
  }
  if (!negative && !POSITIVE_PLACEMENT_CHANNELS.has(String(target.channel))) {
    return fail(
      `${target.label} é ${target.channel}: posicionamento POSITIVO é para Display, Vídeo e Demand Gen` +
      (target.channel === "SEARCH" ? " (Pesquisa recusa com CANNOT_TARGET_PLACEMENTS_FOR_SEARCH_CAMPAIGNS)" : "") +
      ". Para excluir, use negative: true ou exclude_placements. Nada foi gravado."
    );
  }
  const existing = await loadPlacementCriteria(client, args.customerId, target);
  const found = existing.find((entry) => entry.key === placement.key);
  const view = { target: targetView(target), placement: describePlacement(placement), negative };
  if (found && found.negative === negative) {
    return done(`${target.label}: ${placement.type} ${placement.value} já está ${negative ? "excluído" : "segmentado"} (critério ${found.id}). Nada foi gravado.\n\n${formatJson(view)}`);
  }
  if (found) {
    return fail(
      `${target.label}: ${placement.type} ${placement.value} já existe como ${found.negative ? "exclusão" : "segmentação positiva"} ` +
      `(critério ${found.id}). Remova com remove_targeting_criteria (${found.resourceName}) antes. Nada foi gravado.`
    );
  }
  let response: Row;
  try {
    response = await client.mutate(args.customerId, mutateResourceFor(level), [{ create: criterionCreate(target, placement.criterion, negative) }]);
  } catch (err) {
    return fail(`${explainApiError(errorMessage(err))}\nNada foi gravado.`);
  }
  const dryRun = client.isDryRun;
  const resourceName = ((response.results as Row[] | undefined) ?? [])[0]?.resourceName;
  if (!dryRun && !resourceName) return fail(`A API não confirmou a gravação — confira com get_targeting_overview.\n\n${formatJson(response)}`);
  return done(
    (dryRun
      ? `${target.label} — ${DRY_RUN_NOTE}`
      : `${target.label}: ${placement.type} ${placement.value} ${negative ? "excluído" : "adicionado"}.`) +
    (placement.note ? ` (${placement.note})` : "") +
    `\n\n${formatJson({ ...view, resource_name: resourceName ?? null })}`
  );
}
