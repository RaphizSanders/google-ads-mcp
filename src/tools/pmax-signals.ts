/**
 * Lote pmax-signals: Performance Max — sinais, automação, marca, prévias e combinações.
 *
 * Tudo aqui foi conferido contra os protos oficiais da v25 (common/audiences.proto,
 * resources/audience.proto, resources/asset_group_signal.proto, resources/campaign.proto,
 * services/campaign_service.proto, services/automatically_created_asset_removal_service.proto,
 * services/shareable_preview_service.proto, actions/generate_shareable_previews.proto,
 * resources/final_url_expansion_asset_view.proto, resources/asset_group_top_combination_view.proto)
 * e toda query contra tests/fixtures/google-ads-v25-fields.json.
 *
 * Regras que atravessam o módulo:
 * - checkCustomerAccess antes de tudo; IDs validados antes de entrar no GAQL;
 * - lê antes de gravar: o objeto precisa existir na conta, sem escrita quando nada muda;
 * - remoção (sinal, exclusão de URL, asset gerado, logo, nome da empresa) e mudança irreversível
 *   (promover público ASSET_GROUP para CUSTOMER, migrar para diretrizes de marca) exigem confirm: true;
 * - endpoints sem validate_only (EnablePMaxBrandGuidelines, RemoveCampaignAutomaticallyCreatedAsset)
 *   são recusados em dry-run/validateOnly com a prévia do que seria enviado;
 * - várias operações independentes vão com partialFailure e relatório por item; as que dependem
 *   umas das outras (público novo + sinal, nome da empresa novo + vínculo) vão num googleAds:mutate
 *   atômico com IDs temporários.
 */
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  DATE_RANGE_DESC,
  DAYS_DESC,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  microsToMoney,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Constantes da API (v25) ──────────────────────────────────────────

const PMAX = "PERFORMANCE_MAX";

/** AgeSegment (common/audiences.proto): mínimos e máximos aceitos. */
const AGE_MIN = [18, 25, 35, 45, 55, 65];
const AGE_MAX = [24, 34, 44, 54, 64];
/** GenderTypeEnum, IncomeRangeTypeEnum e ParentalStatusTypeEnum sem UNDETERMINED (vai em include_undetermined). */
const GENDERS = ["MALE", "FEMALE"];
const INCOME_RANGES = [
  "INCOME_RANGE_0_50",
  "INCOME_RANGE_50_60",
  "INCOME_RANGE_60_70",
  "INCOME_RANGE_70_80",
  "INCOME_RANGE_80_90",
  "INCOME_RANGE_90_UP",
];
const PARENTAL_STATUSES = ["PARENT", "NOT_A_PARENT"];

/** AssetGroupSignalError.TOO_MANY_WORDS: "You can add up to 10 words in a keyword". */
const MAX_SEARCH_THEME_WORDS = 10;
/** EnableOperation: "A maximum of 10 enable operations can be executed in a request". */
const MAX_ENABLE_BRAND_OPS = 10;
/** BRAND_GUIDELINES_LOGO_LIMIT_EXCEEDED: "Maximum of 5 square and landscape logos". */
const MAX_BRAND_LOGOS = 5;
/** Tabela de requisitos de assets do PMax: BUSINESS_NAME até 25 caracteres. */
const MAX_BUSINESS_NAME_CHARS = 25;
/** ShareablePreviewError.TOO_MANY_RESOURCES_IN_REQUEST: máximo de 10 asset groups + ad group ads. */
const MAX_PREVIEW_RESOURCES = 10;
/** Campaign.BrandGuidelines.predefined_font_family (case sensitive). */
const BRAND_FONTS = ["Open Sans", "Roboto", "Roboto Slab", "Montserrat", "Poppins", "Lato", "Oswald", "Playfair Display"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** AssetFieldTypeEnum (v25), para validar o field_type antes de enviar. */
const ASSET_FIELD_TYPES = new Set([
  "HEADLINE", "DESCRIPTION", "MANDATORY_AD_TEXT", "MARKETING_IMAGE", "MEDIA_BUNDLE", "YOUTUBE_VIDEO",
  "BOOK_ON_GOOGLE", "LEAD_FORM", "PROMOTION", "CALLOUT", "STRUCTURED_SNIPPET", "SITELINK", "MOBILE_APP",
  "HOTEL_CALLOUT", "CALL", "PRICE", "LONG_HEADLINE", "BUSINESS_NAME", "SQUARE_MARKETING_IMAGE",
  "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO", "VIDEO", "CALL_TO_ACTION_SELECTION", "AD_IMAGE",
  "BUSINESS_LOGO", "HOTEL_PROPERTY", "DEMAND_GEN_CAROUSEL_CARD", "BUSINESS_MESSAGE",
  "TALL_PORTRAIT_MARKETING_IMAGE", "RELATED_YOUTUBE_VIDEOS", "LANDING_PAGE_PREVIEW", "LONG_DESCRIPTION",
  "CALL_TO_ACTION", "CLASSIC_DISPLAY_IMAGE", "TEXT_DISCLAIMER",
]);

/**
 * Automação de assets do PMax (Campaign.asset_automation_settings). Padrões do guia
 * "Asset automation settings": no PMax tudo vem ligado, e a extração de imagens segue o
 * controle da conta.
 */
const PMAX_AUTOMATION = [
  { key: "finalUrlExpansion", type: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", label: "Expansão de URL final", pmaxDefault: "OPTED_IN" },
  { key: "textCustomization", type: "TEXT_ASSET_AUTOMATION", label: "Personalização de texto", pmaxDefault: "OPTED_IN" },
  { key: "imageEnhancement", type: "GENERATE_IMAGE_ENHANCEMENT", label: "Melhoria de imagens", pmaxDefault: "OPTED_IN" },
  { key: "enhancedVideos", type: "GENERATE_ENHANCED_YOUTUBE_VIDEOS", label: "Vídeos aprimorados", pmaxDefault: "OPTED_IN" },
  { key: "imageExtraction", type: "GENERATE_IMAGE_EXTRACTION", label: "Extração de imagens da página", pmaxDefault: "segue o controle da conta" },
] as const;
type AutomationKey = (typeof PMAX_AUTOMATION)[number]["key"];

// ── Utilitários ──────────────────────────────────────────────────────

const ok = (body: string): ToolResult => ({ content: [text(body)] });
const fail = (body: string): ToolResult => ({ content: [text(body)], isError: true });
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const asObj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const lastSegment = (resourceName: unknown): string => str(resourceName).split("/").pop() ?? "";
const isId = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value.trim());

function normCid(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "").trim();
  return /^\d+$/.test(cid) ? cid : null;
}

/** Normaliza ID numérico ou resource name da MESMA conta para customers/{cid}/{collection}/{id}. */
function parseRef(raw: unknown, cid: string, collection: string): { id: string; resourceName: string } | { error: string } {
  if (typeof raw !== "string" && typeof raw !== "number") return { error: `referência inválida ${JSON.stringify(raw)}` };
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) return { id: value, resourceName: `customers/${cid}/${collection}/${value}` };
  const match = new RegExp(`^customers/([\\d-]+)/${collection}/(\\d+)$`).exec(value);
  if (!match) return { error: `"${value}" não é um ID numérico nem customers/${cid}/${collection}/{id}` };
  const owner = match[1].replace(/-/g, "");
  if (owner !== cid) return { error: `${value} pertence à conta ${owner}, não à conta ${cid}` };
  return { id: match[2], resourceName: `customers/${cid}/${collection}/${match[2]}` };
}

/** Lista de referências → resource names sem repetição; problemas vão para `problems`. */
function collectRefs(values: unknown, cid: string, collection: string, label: string, problems: string[]): string[] {
  const out: string[] = [];
  for (const entry of ensureArray<unknown>(values)) {
    const parsed = parseRef(entry, cid, collection);
    if ("error" in parsed) {
      problems.push(`${label}: ${parsed.error}`);
      continue;
    }
    if (!out.includes(parsed.resourceName)) out.push(parsed.resourceName);
  }
  return out;
}

/** Texto de erro da API com uma dica em PT-BR quando o código é conhecido. */
const ERROR_HINTS: Array<[RegExp, string]> = [
  [/ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP|only one audience/i,
    "O grupo de recursos aceita um único público como sinal. Para mudar o sinal, edite o público (update_audience) ou troque-o com manage_asset_group_signals (setAudience + confirm)."],
  [/TOO_MANY_WORDS/i, `Tema de pesquisa com mais de ${MAX_SEARCH_THEME_WORDS} palavras.`],
  [/SEARCH_THEME_POLICY_VIOLATION/i, "Tema de pesquisa recusado pela política de anúncios — reescreva o tema."],
  [/AUDIENCE_WITH_WRONG_ASSET_GROUP_ID/i, "O público tem escopo de outro grupo de recursos (scope ASSET_GROUP)."],
  [/NAME_ALREADY_IN_USE/i, "Já existe um público com esse nome na conta — use outro nome ou update_audience."],
  [/AUDIENCE_SEGMENT_NOT_FOUND/i, "Um dos segmentos não existe ou não está acessível nesta conta."],
  [/AUDIENCE_SEGMENT_TYPE_NOT_SUPPORTED/i, "Tipo de segmento não aceito neste público."],
  [/DUPLICATE_AUDIENCE_SEGMENT/i, "O mesmo segmento aparece duas vezes no público."],
  [/TOO_MANY_SEGMENTS/i, "O público passou do limite de segmentos da API."],
  [/TOO_MANY_DIMENSIONS_OF_SAME_TYPE|DIMENSION_INVALID/i, "Dimensão inválida ou repetida no público."],
  [/CANNOT_CHANGE_FROM_CUSTOMER_TO_ASSET_GROUP_SCOPE/i, "Um público de escopo CUSTOMER não pode voltar para ASSET_GROUP."],
  [/MISSING_ASSET_GROUP_ID/i, "Público de escopo ASSET_GROUP precisa do assetGroupId."],
  [/REQUIRED_BUSINESS_NAME_ASSET_NOT_LINKED/i, "A campanha precisa de exatamente um nome da empresa (BUSINESS_NAME) vinculado no nível da campanha."],
  [/REQUIRED_LOGO_ASSET_NOT_LINKED/i, "A campanha precisa de pelo menos um logotipo quadrado (LOGO) vinculado no nível da campanha."],
  [/BRAND_GUIDELINES_LOGO_LIMIT_EXCEEDED/i, `Máximo de ${MAX_BRAND_LOGOS} logotipos (LOGO + LANDSCAPE_LOGO) nas diretrizes de marca.`],
  [/BRAND_GUIDELINES_ALREADY_ENABLED/i, "As diretrizes de marca já estavam ativas nesta campanha."],
  [/CANNOT_ENABLE_BRAND_GUIDELINES_FOR_REMOVED_CAMPAIGN/i, "Campanha removida não pode receber diretrizes de marca."],
  [/BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL/i, "Com diretrizes de marca ativas, nome da empresa e logos vão no nível da campanha (CampaignAsset)."],
  [/BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL/i, "Sem diretrizes de marca, nome da empresa e logos vão no grupo de recursos — migre com enable_pmax_brand_guidelines."],
  [/OPERATION_NOT_PERMITTED_FOR_CONTEXT/i,
    "Ordem exigida pela API: para desligar a personalização de texto, remova antes o feed de páginas (CampaignAssetSet PAGE_FEED); para ligar o feed, ligue antes a personalização de texto."],
  [/NOT_AN_AUTOMATICALLY_CREATED_ASSET|ASSET_FIELD_TYPE_DOES_NOT_MATCH|ASSET_DOES_NOT_EXIST/i,
    "O asset não é um asset gerado automaticamente desta campanha com esse field type — confira com list_url_expansion_assets."],
  [/UNSUPPORTED_AD_TYPE/i, "Tipo de anúncio sem prévia compartilhável (RSA e anúncio display responsivo não têm)."],
  [/TOO_MANY_RESOURCES_IN_REQUEST/i, `Máximo de ${MAX_PREVIEW_RESOURCES} recursos por pedido de prévia.`],
];

function explainApiError(message: string): string {
  const hints = ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\nDica: ${[...new Set(hints)].join(" ")}` : message;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resposta com o prefixo certo para gravação real ou dry-run. */
function dryRunHeader(dryRun: boolean, done: string): string {
  return dryRun ? "DRY-RUN (validateOnly): a API validou — nada foi gravado." : done;
}

/**
 * Partial failure: devolve, por operação, "ok" ou a lista de erros. Em validate_only a API não
 * devolve results, então sucesso = sem erro atribuído àquela operação.
 */
function perOperation(response: Row, count: number, dryRun: boolean): Array<{ ok: boolean; error?: string; resourceName?: string }> {
  const results = asRows(response.results);
  const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, count);
  return Array.from({ length: count }, (_, index) => {
    const errors = byIndex.get(index);
    if (errors) return { ok: false, error: explainApiError(errors.join("; ")) };
    const resourceName = str(results[index]?.resourceName) || undefined;
    // Gravação real confirmada pelo resourceName vale mesmo com erro não atribuído em outra operação
    if (!dryRun && resourceName) return { ok: true, resourceName };
    if (unattributed.length > 0) return { ok: false, error: explainApiError(`resultado incerto: ${unattributed.join("; ")}`) };
    if (!dryRun) return { ok: false, error: "a API não confirmou esta operação" };
    return { ok: true };
  });
}

// ── Leituras compartilhadas ─────────────────────────────────────────

interface AssetGroupInfo {
  id: string;
  name: string;
  status: string;
  resourceName: string;
  finalUrls: string[];
  campaignId: string;
  campaignName: string;
  channel: string;
  campaignStatus: string;
}

async function loadAssetGroups(client: GoogleAdsClient, cid: string, ids: string[]): Promise<Map<string, AssetGroupInfo>> {
  const found = new Map<string, AssetGroupInfo>();
  if (ids.length === 0) return found;
  const rows = await client.searchStream(cid,
    `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.resource_name, asset_group.final_urls,
            campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status
     FROM asset_group
     WHERE asset_group.id IN (${ids.join(", ")})`);
  for (const row of rows) {
    const group = asObj(row.assetGroup);
    const campaign = asObj(row.campaign);
    const id = str(group.id);
    found.set(id, {
      id,
      name: str(group.name),
      status: str(group.status),
      resourceName: str(group.resourceName) || `customers/${cid}/assetGroups/${id}`,
      finalUrls: ((group.finalUrls as unknown[]) ?? []).map(String),
      campaignId: str(campaign.id),
      campaignName: str(campaign.name),
      channel: str(campaign.advertisingChannelType),
      campaignStatus: str(campaign.status),
    });
  }
  return found;
}

/** Recusa grupo inexistente, removido ou fora de campanha PMax (sinais só existem no PMax). */
function assetGroupProblem(group: AssetGroupInfo | undefined, assetGroupId: string, cid: string): string | null {
  if (!group) return `Grupo de recursos ${assetGroupId} não encontrado na conta ${cid}.`;
  if (group.status === "REMOVED") return `Grupo de recursos ${assetGroupId} ("${group.name}") está removido.`;
  if (group.channel !== PMAX) {
    return `Grupo de recursos ${assetGroupId} ("${group.name}") é de uma campanha ${group.channel || "desconhecida"} — sinais de grupo de recursos só existem em Performance Max.`;
  }
  return null;
}

interface SignalInfo {
  resourceName: string;
  signalId: string;
  assetGroupId: string;
  assetGroupName: string;
  campaignId: string;
  campaignName: string;
  kind: "audience" | "search_theme" | "other";
  audience?: string;
  searchTheme?: string;
  approvalStatus?: string;
  disapprovalReasons: string[];
}

async function loadSignals(client: GoogleAdsClient, cid: string, where: string): Promise<SignalInfo[]> {
  const rows = await client.searchStream(cid,
    `SELECT asset_group_signal.resource_name, asset_group_signal.approval_status,
            asset_group_signal.disapproval_reasons, asset_group_signal.audience.audience,
            asset_group_signal.search_theme.text, asset_group.id, asset_group.name, asset_group.status,
            campaign.id, campaign.name
     FROM asset_group_signal
     WHERE ${where}
       AND asset_group.status != 'REMOVED'`);
  return rows.map((row) => {
    const signal = asObj(row.assetGroupSignal);
    const group = asObj(row.assetGroup);
    const campaign = asObj(row.campaign);
    const resourceName = str(signal.resourceName);
    const audience = str(asObj(signal.audience).audience) || undefined;
    const searchTheme = asObj(signal.searchTheme).text !== undefined ? str(asObj(signal.searchTheme).text) : undefined;
    return {
      resourceName,
      signalId: resourceName.split("~").pop() ?? "",
      assetGroupId: str(group.id),
      assetGroupName: str(group.name),
      campaignId: str(campaign.id),
      campaignName: str(campaign.name),
      kind: audience ? "audience" : searchTheme !== undefined ? "search_theme" : "other",
      audience,
      searchTheme,
      approvalStatus: str(signal.approvalStatus) || undefined,
      disapprovalReasons: ((signal.disapprovalReasons as unknown[]) ?? []).map(String),
    };
  });
}

interface AudienceInfo {
  resourceName: string;
  id: string;
  name: string;
  status: string;
  scope: string;
  assetGroup: string;
  description: string;
  raw: Row;
}

async function loadAudiences(client: GoogleAdsClient, cid: string, resourceNames: string[]): Promise<Map<string, AudienceInfo>> {
  const found = new Map<string, AudienceInfo>();
  const unique = [...new Set(resourceNames)].filter((rn) => /^customers\/\d+\/audiences\/\d+$/.test(rn));
  if (unique.length === 0) return found;
  const rows = await client.searchStream(cid,
    `SELECT audience.resource_name, audience.id, audience.name, audience.status, audience.scope,
            audience.asset_group, audience.description, audience.dimensions, audience.exclusion_dimension
     FROM audience
     WHERE audience.resource_name IN (${unique.map((rn) => `'${gaqlLiteral(rn)}'`).join(", ")})`);
  for (const row of rows) {
    const audience = asObj(row.audience);
    const resourceName = str(audience.resourceName);
    found.set(resourceName, {
      resourceName,
      id: str(audience.id),
      name: str(audience.name),
      status: str(audience.status),
      scope: str(audience.scope) || "CUSTOMER",
      assetGroup: str(audience.assetGroup),
      description: str(audience.description),
      raw: audience,
    });
  }
  return found;
}

async function loadCampaign(client: GoogleAdsClient, cid: string, campaignId: string, extraFields: string[] = []): Promise<Row | null> {
  const fields = ["campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", ...extraFields];
  const rows = await client.searchStream(cid, `SELECT ${fields.join(", ")} FROM campaign WHERE campaign.id = ${campaignId}`);
  const campaign = rows[0]?.campaign;
  return campaign ? asObj(campaign) : null;
}

function pmaxCampaignProblem(campaign: Row | null, campaignId: string, cid: string): string | null {
  if (!campaign) return `Campanha ${campaignId} não encontrada na conta ${cid}.`;
  if (campaign.status === "REMOVED") return `Campanha ${campaignId} ("${str(campaign.name)}") está removida.`;
  if (campaign.advertisingChannelType !== PMAX) {
    return `Campanha ${campaignId} ("${str(campaign.name)}") é ${str(campaign.advertisingChannelType) || "de tipo desconhecido"}, não Performance Max.`;
  }
  return null;
}

/** Canais que final_url_expansion_asset_view aceita no filtro (os demais: "Invalid advertising channel type X in filter"). */
const URL_EXPANSION_CHANNELS = new Set([PMAX, "SEARCH"]);

/**
 * WHERE de final_url_expansion_asset_view para uma campanha. A API exige o canal junto do campaign.id
 * ("requires advertising channel type filter along with campaign id filter"), e com "=": IN é recusado
 * ("filtering by a single advertising channel type"). Os metadados da v25 não descrevem essas regras.
 */
async function urlExpansionCampaignFilter(
  client: GoogleAdsClient, cid: string, campaignId: string
): Promise<{ campaign: Row; channel: string; where: string } | { error: string }> {
  const campaign = await loadCampaign(client, cid, campaignId);
  if (!campaign) return { error: `Campanha ${campaignId} não encontrada na conta ${cid}.` };
  const channel = str(campaign.advertisingChannelType);
  if (!URL_EXPANSION_CHANNELS.has(channel)) {
    return { error: `Campanha ${campaignId} ("${str(campaign.name)}") é ${channel || "de tipo desconhecido"}: a expansão de URL final só existe em Performance Max e Pesquisa.` };
  }
  return { campaign, channel, where: `campaign.id = ${campaignId} AND campaign.advertising_channel_type = '${channel}'` };
}

interface AssetInfo {
  id: string;
  resourceName: string;
  type: string;
  name: string;
  text?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  youtubeVideoId?: string;
  youtubeTitle?: string;
}

function toAssetInfo(assetRow: Row): AssetInfo {
  const image = asObj(asObj(assetRow.imageAsset).fullSize);
  const video = asObj(assetRow.youtubeVideoAsset);
  const textAsset = asObj(assetRow.textAsset);
  return {
    id: str(assetRow.id),
    resourceName: str(assetRow.resourceName),
    type: str(assetRow.type),
    name: str(assetRow.name),
    text: textAsset.text !== undefined ? str(textAsset.text) : undefined,
    imageUrl: image.url !== undefined ? str(image.url) : undefined,
    width: image.widthPixels !== undefined ? num(image.widthPixels) : undefined,
    height: image.heightPixels !== undefined ? num(image.heightPixels) : undefined,
    youtubeVideoId: video.youtubeVideoId !== undefined ? str(video.youtubeVideoId) : undefined,
    youtubeTitle: video.youtubeVideoTitle !== undefined ? str(video.youtubeVideoTitle) : undefined,
  };
}

const ASSET_FIELDS = `asset.id, asset.resource_name, asset.type, asset.name, asset.text_asset.text,
            asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels,
            asset.image_asset.full_size.height_pixels, asset.youtube_video_asset.youtube_video_id,
            asset.youtube_video_asset.youtube_video_title`;

async function loadAssetsById(client: GoogleAdsClient, cid: string, ids: string[]): Promise<Map<string, AssetInfo>> {
  const found = new Map<string, AssetInfo>();
  const unique = [...new Set(ids)].filter((id) => /^\d+$/.test(id));
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await client.searchStream(cid, `SELECT ${ASSET_FIELDS} FROM asset WHERE asset.id IN (${chunk.join(", ")})`);
    for (const row of rows) {
      const info = toAssetInfo(asObj(row.asset));
      found.set(info.id, info);
    }
  }
  return found;
}

/** Conteúdo legível do asset: texto, URL da imagem ou ID do YouTube. */
function assetContent(asset: AssetInfo | undefined): string {
  if (!asset) return "";
  if (asset.text !== undefined) return asset.text;
  if (asset.imageUrl !== undefined) return asset.imageUrl;
  if (asset.youtubeVideoId !== undefined) return `https://www.youtube.com/watch?v=${asset.youtubeVideoId}`;
  return asset.name;
}

// ── Composição de públicos (AudienceService) ────────────────────────

const SEGMENT_TYPES = [
  {
    key: "userLists", collection: "userLists", label: "userLists", apiKey: "userList", apiField: "userList",
    from: "user_list", idField: "user_list.id", rowKey: "userList", rowId: "id",
    fields: "user_list.id, user_list.name, user_list.resource_name, user_list.type, user_list.membership_status, user_list.size_for_display, user_list.size_for_search",
  },
  {
    key: "userInterests", collection: "userInterests", label: "userInterests", apiKey: "userInterest", apiField: "userInterestCategory",
    from: "user_interest", idField: "user_interest.user_interest_id", rowKey: "userInterest", rowId: "userInterestId",
    fields: "user_interest.user_interest_id, user_interest.name, user_interest.resource_name, user_interest.taxonomy_type",
  },
  {
    key: "customAudiences", collection: "customAudiences", label: "customAudiences", apiKey: "customAudience", apiField: "customAudience",
    from: "custom_audience", idField: "custom_audience.id", rowKey: "customAudience", rowId: "id",
    fields: "custom_audience.id, custom_audience.name, custom_audience.resource_name, custom_audience.status, custom_audience.type",
  },
  {
    key: "lifeEvents", collection: "lifeEvents", label: "lifeEvents", apiKey: "lifeEvent", apiField: "lifeEvent",
    from: "life_event", idField: "life_event.id", rowKey: "lifeEvent", rowId: "id",
    fields: "life_event.id, life_event.name, life_event.resource_name",
  },
  {
    key: "detailedDemographics", collection: "detailedDemographics", label: "detailedDemographics", apiKey: "detailedDemographic", apiField: "detailedDemographic",
    from: "detailed_demographic", idField: "detailed_demographic.id", rowKey: "detailedDemographic", rowId: "id",
    fields: "detailed_demographic.id, detailed_demographic.name, detailed_demographic.resource_name",
  },
] as const;
type SegmentKey = (typeof SEGMENT_TYPES)[number]["key"];

interface DemographicDim {
  values: string[];
  includeUndetermined: boolean;
}
interface AgeDim {
  ranges: Array<{ minAge: number; maxAge?: number }>;
  includeUndetermined: boolean;
}
export interface AudienceSpec {
  userLists: string[];
  userInterests: string[];
  customAudiences: string[];
  lifeEvents: string[];
  detailedDemographics: string[];
  age?: AgeDim;
  genders?: DemographicDim;
  incomeRanges?: DemographicDim;
  parentalStatuses?: DemographicDim;
  excludeUserLists: string[];
}

export interface AudienceInput {
  userLists?: unknown;
  userInterests?: unknown;
  customAudiences?: unknown;
  lifeEvents?: unknown;
  detailedDemographics?: unknown;
  ageRanges?: unknown;
  genders?: unknown;
  incomeRanges?: unknown;
  parentalStatuses?: unknown;
  excludeUserLists?: unknown;
}

const emptySpec = (): AudienceSpec => ({
  userLists: [], userInterests: [], customAudiences: [], lifeEvents: [], detailedDemographics: [], excludeUserLists: [],
});

function parseAgeRanges(values: unknown, problems: string[]): AgeDim {
  const dim: AgeDim = { ranges: [], includeUndetermined: false };
  for (const entry of ensureArray<unknown>(values)) {
    const raw = typeof entry === "string" ? entry.trim().toUpperCase() : "";
    if (raw === "UNDETERMINED" || raw === "AGE_RANGE_UNDETERMINED") {
      dim.includeUndetermined = true;
      continue;
    }
    const match = /^(\d{2})\s*(?:-\s*(\d{2})|\+)$/.exec(raw);
    if (!match) {
      problems.push(`ageRanges: "${String(entry)}" inválida — use "18-24", "25-54", "65+" ou "UNDETERMINED"`);
      continue;
    }
    const minAge = Number(match[1]);
    const maxAge = match[2] !== undefined ? Number(match[2]) : undefined;
    if (!AGE_MIN.includes(minAge)) {
      problems.push(`ageRanges: idade mínima ${minAge} não é aceita (válidas: ${AGE_MIN.join(", ")})`);
      continue;
    }
    if (maxAge !== undefined && (!AGE_MAX.includes(maxAge) || maxAge <= minAge)) {
      problems.push(`ageRanges: idade máxima ${maxAge} inválida para mínimo ${minAge} (válidas: ${AGE_MAX.join(", ")}, maior que o mínimo)`);
      continue;
    }
    if (!dim.ranges.some((range) => range.minAge === minAge && range.maxAge === maxAge)) {
      dim.ranges.push(maxAge === undefined ? { minAge } : { minAge, maxAge });
    }
  }
  dim.ranges.sort((a, b) => a.minAge - b.minAge);
  return dim;
}

function parseDemographic(values: unknown, allowed: string[], label: string, problems: string[]): DemographicDim {
  const dim: DemographicDim = { values: [], includeUndetermined: false };
  for (const entry of ensureArray<unknown>(values)) {
    const raw = typeof entry === "string" ? entry.trim().toUpperCase() : "";
    if (raw === "UNDETERMINED" || raw === "INCOME_RANGE_UNDETERMINED") {
      dim.includeUndetermined = true;
      continue;
    }
    if (!allowed.includes(raw)) {
      problems.push(`${label}: "${String(entry)}" inválido (válidos: ${[...allowed, "UNDETERMINED"].join(", ")})`);
      continue;
    }
    if (!dim.values.includes(raw)) dim.values.push(raw);
  }
  dim.values.sort();
  return dim;
}

/** Só as partes que o usuário informou (undefined = não mexer). */
function parseAudienceInput(input: AudienceInput, cid: string, problems: string[]): Partial<AudienceSpec> {
  const spec: Partial<AudienceSpec> = {};
  for (const type of SEGMENT_TYPES) {
    const value = input[type.key];
    if (value !== undefined) spec[type.key] = collectRefs(value, cid, type.collection, type.label, problems);
  }
  if (input.ageRanges !== undefined) spec.age = parseAgeRanges(input.ageRanges, problems);
  if (input.genders !== undefined) spec.genders = parseDemographic(input.genders, GENDERS, "genders", problems);
  if (input.incomeRanges !== undefined) spec.incomeRanges = parseDemographic(input.incomeRanges, INCOME_RANGES, "incomeRanges", problems);
  if (input.parentalStatuses !== undefined) {
    spec.parentalStatuses = parseDemographic(input.parentalStatuses, PARENTAL_STATUSES, "parentalStatuses", problems);
  }
  if (input.excludeUserLists !== undefined) {
    spec.excludeUserLists = collectRefs(input.excludeUserLists, cid, "userLists", "excludeUserLists", problems);
  }
  return spec;
}

const dimIsSet = (dim: DemographicDim | AgeDim | undefined): boolean =>
  !!dim && (("values" in dim ? dim.values.length : dim.ranges.length) > 0 || dim.includeUndetermined);

function hasPositiveDimension(spec: AudienceSpec): boolean {
  return SEGMENT_TYPES.some((type) => spec[type.key].length > 0) ||
    dimIsSet(spec.age) || dimIsSet(spec.genders) || dimIsSet(spec.incomeRanges) || dimIsSet(spec.parentalStatuses);
}

/** AudienceSpec → Audience.dimensions e Audience.exclusion_dimension (JSON REST). */
export function buildAudienceDimensions(spec: AudienceSpec): { dimensions: Row[]; exclusionDimension: Row } {
  const segments: Row[] = [];
  for (const type of SEGMENT_TYPES) {
    for (const resourceName of spec[type.key]) segments.push({ [type.apiKey]: { [type.apiField]: resourceName } });
  }
  const dimensions: Row[] = [];
  if (segments.length > 0) dimensions.push({ audienceSegments: { segments } });
  if (dimIsSet(spec.age)) dimensions.push({ age: { ageRanges: spec.age!.ranges, includeUndetermined: spec.age!.includeUndetermined } });
  if (dimIsSet(spec.genders)) dimensions.push({ gender: { genders: spec.genders!.values, includeUndetermined: spec.genders!.includeUndetermined } });
  if (dimIsSet(spec.incomeRanges)) {
    dimensions.push({ householdIncome: { incomeRanges: spec.incomeRanges!.values, includeUndetermined: spec.incomeRanges!.includeUndetermined } });
  }
  if (dimIsSet(spec.parentalStatuses)) {
    dimensions.push({
      parentalStatus: { parentalStatuses: spec.parentalStatuses!.values, includeUndetermined: spec.parentalStatuses!.includeUndetermined },
    });
  }
  const exclusionDimension = { exclusions: spec.excludeUserLists.map((userList) => ({ userList: { userList } })) };
  return { dimensions, exclusionDimension };
}

/** Audience lida da API → AudienceSpec (inverso de buildAudienceDimensions). */
function specFromAudience(audience: Row): AudienceSpec {
  const spec = emptySpec();
  for (const dimension of asRows(audience.dimensions)) {
    for (const segment of asRows(asObj(dimension.audienceSegments).segments)) {
      for (const type of SEGMENT_TYPES) {
        const value = str(asObj(segment[type.apiKey])[type.apiField]);
        if (value && !spec[type.key].includes(value)) spec[type.key].push(value);
      }
    }
    if (dimension.age) {
      const age = asObj(dimension.age);
      spec.age = {
        ranges: asRows(age.ageRanges)
          .map((range) => (range.maxAge !== undefined ? { minAge: num(range.minAge), maxAge: num(range.maxAge) } : { minAge: num(range.minAge) }))
          .sort((a, b) => a.minAge - b.minAge),
        includeUndetermined: age.includeUndetermined === true,
      };
    }
    const demo = (value: unknown, listKey: string): DemographicDim => ({
      values: ((asObj(value)[listKey] as unknown[]) ?? []).map(String).sort(),
      includeUndetermined: asObj(value).includeUndetermined === true,
    });
    if (dimension.gender) spec.genders = demo(dimension.gender, "genders");
    if (dimension.householdIncome) spec.incomeRanges = demo(dimension.householdIncome, "incomeRanges");
    if (dimension.parentalStatus) spec.parentalStatuses = demo(dimension.parentalStatus, "parentalStatuses");
  }
  for (const exclusion of asRows(asObj(audience.exclusionDimension).exclusions)) {
    const value = str(asObj(exclusion.userList).userList);
    if (value && !spec.excludeUserLists.includes(value)) spec.excludeUserLists.push(value);
  }
  return spec;
}

/** Forma canônica para comparar (ordem não importa). */
function canonicalPositive(spec: AudienceSpec): string {
  const sorted = (list: string[]) => [...list].sort();
  const demo = (dim?: DemographicDim) => (dimIsSet(dim) ? { v: sorted(dim!.values), u: dim!.includeUndetermined } : null);
  return JSON.stringify({
    segments: SEGMENT_TYPES.map((type) => sorted(spec[type.key])),
    age: dimIsSet(spec.age) ? { r: spec.age!.ranges.map((r) => `${r.minAge}-${r.maxAge ?? ""}`).sort(), u: spec.age!.includeUndetermined } : null,
    genders: demo(spec.genders),
    income: demo(spec.incomeRanges),
    parental: demo(spec.parentalStatuses),
  });
}

interface SegmentCheck {
  names: Map<string, string>;
  missing: string[];
  notes: string[];
}

/** Confere na conta que cada segmento existe (e pega o nome para o relatório). */
async function verifySegments(client: GoogleAdsClient, cid: string, spec: Partial<AudienceSpec>): Promise<SegmentCheck> {
  const names = new Map<string, string>();
  const missing: string[] = [];
  const notes: string[] = [];
  const refsByType = new Map<string, string[]>();
  for (const type of SEGMENT_TYPES) {
    const refs = [...(spec[type.key] ?? [])];
    if (type.key === "userLists") refs.push(...(spec.excludeUserLists ?? []));
    if (refs.length > 0) refsByType.set(type.key, [...new Set(refs)]);
  }
  for (const type of SEGMENT_TYPES) {
    const refs = refsByType.get(type.key);
    if (!refs) continue;
    const ids = refs.map(lastSegment);
    const rows = await client.searchStream(cid, `SELECT ${type.fields} FROM ${type.from} WHERE ${type.idField} IN (${ids.join(", ")})`);
    const byId = new Map<string, Row>();
    for (const row of rows) {
      const data = asObj(row[type.rowKey]);
      byId.set(str(data[type.rowId]), data);
    }
    for (const ref of refs) {
      const data = byId.get(lastSegment(ref));
      if (!data || (type.key === "customAudiences" && data.status === "REMOVED")) {
        missing.push(`${type.label}: ${ref}`);
        continue;
      }
      names.set(ref, str(data.name));
      if (type.key === "userLists" && data.membershipStatus === "CLOSED") {
        notes.push(`A lista "${str(data.name)}" (${ref}) está fechada (CLOSED) — não recebe membros novos.`);
      }
      if (type.key === "userLists" && data.sizeForDisplay !== undefined && num(data.sizeForDisplay) === 0 && num(data.sizeForSearch) === 0) {
        notes.push(`A lista "${str(data.name)}" (${ref}) está vazia (tamanho 0 em Display e Pesquisa).`);
      }
    }
  }
  return { names, missing, notes };
}

const ageLabel = (range: { minAge: number; maxAge?: number }) => (range.maxAge === undefined ? `${range.minAge}+` : `${range.minAge}-${range.maxAge}`);

/** Descrição legível da composição do público. */
function describeSpec(spec: AudienceSpec, names: Map<string, string>): Row {
  const out: Row = {};
  for (const type of SEGMENT_TYPES) {
    if (spec[type.key].length > 0) {
      out[type.key] = spec[type.key].map((rn) => (names.get(rn) ? { resource_name: rn, name: names.get(rn) } : { resource_name: rn }));
    }
  }
  if (dimIsSet(spec.age)) out.ageRanges = [...spec.age!.ranges.map(ageLabel), ...(spec.age!.includeUndetermined ? ["UNDETERMINED"] : [])];
  const demo = (dim?: DemographicDim) => [...dim!.values, ...(dim!.includeUndetermined ? ["UNDETERMINED"] : [])];
  if (dimIsSet(spec.genders)) out.genders = demo(spec.genders);
  if (dimIsSet(spec.incomeRanges)) out.incomeRanges = demo(spec.incomeRanges);
  if (dimIsSet(spec.parentalStatuses)) out.parentalStatuses = demo(spec.parentalStatuses);
  if (spec.excludeUserLists.length > 0) {
    out.excludeUserLists = spec.excludeUserLists.map((rn) => (names.get(rn) ? { resource_name: rn, name: names.get(rn) } : { resource_name: rn }));
  }
  return out;
}

// ── Schemas compartilhados ──────────────────────────────────────────

const audienceShape = {
  userLists: flexArray(z.string()).optional().describe(
    "Listas de público (remarketing, Customer Match, GA4): ID numérico ou customers/{cid}/userLists/{id}. Veja list_remarketing_lists."
  ),
  userInterests: flexArray(z.string()).optional().describe(
    "Interesses (afinidade e no mercado): ID de user_interest ou customers/{cid}/userInterests/{id}. Ache com run_gaql em user_interest."
  ),
  customAudiences: flexArray(z.string()).optional().describe(
    "Segmentos personalizados: ID de custom_audience ou customers/{cid}/customAudiences/{id}."
  ),
  lifeEvents: flexArray(z.string()).optional().describe("Eventos da vida: ID de life_event ou customers/{cid}/lifeEvents/{id}."),
  detailedDemographics: flexArray(z.string()).optional().describe(
    "Dados demográficos detalhados: ID de detailed_demographic ou customers/{cid}/detailedDemographics/{id}."
  ),
  ageRanges: flexArray(z.string()).optional().describe(
    'Faixas etárias: "18-24", "25-34", "35-44", "45-54", "55-64", "65+", faixas contíguas como "25-54", e "UNDETERMINED" ' +
    `(idade desconhecida). Mínimos aceitos ${AGE_MIN.join("/")}; máximos ${AGE_MAX.join("/")}.`
  ),
  genders: flexArray(z.string()).optional().describe('Gêneros: "MALE", "FEMALE", "UNDETERMINED".'),
  incomeRanges: flexArray(z.string()).optional().describe(
    `Renda familiar: ${INCOME_RANGES.join(", ")} (0_50 = 50% inferiores ... 90_UP = 10% superiores), "UNDETERMINED".`
  ),
  parentalStatuses: flexArray(z.string()).optional().describe('Situação parental: "PARENT", "NOT_A_PARENT", "UNDETERMINED".'),
  excludeUserLists: flexArray(z.string()).optional().describe(
    "Listas a EXCLUIR do público (a API só aceita user lists na exclusão). Ex.: compradores dos últimos 30 dias."
  ),
};

// ── Núcleo reutilizado por create_audience e create_audience_from_lists ──

export interface CreateAudienceInput extends AudienceInput {
  toolName: string;
  name?: string;
  description?: string;
  scope?: "CUSTOMER" | "ASSET_GROUP";
  assetGroupId?: string;
  linkAsSignal?: boolean;
  replaceExistingSignal?: boolean;
  confirm?: boolean;
}

export async function createAudienceCore(client: GoogleAdsClient, cid: string, input: CreateAudienceInput): Promise<ToolResult> {
  const problems: string[] = [];
  const provided = parseAudienceInput(input, cid, problems);
  const spec: AudienceSpec = { ...emptySpec(), ...provided };
  const scope = input.scope ?? "CUSTOMER";
  const name = input.name?.trim();
  const assetGroupId = input.assetGroupId?.trim();
  const linkAsSignal = input.linkAsSignal ?? scope === "ASSET_GROUP";

  if (scope === "CUSTOMER" && !name) problems.push("name é obrigatório para público de escopo CUSTOMER (1 a 255 caracteres)");
  if (name && name.length > 255) problems.push(`name tem ${name.length} caracteres (máx. 255)`);
  if (scope === "ASSET_GROUP" && name) {
    problems.push("público de escopo ASSET_GROUP não aceita name (regra da API) — omita o name ou use scope CUSTOMER");
  }
  if (scope === "ASSET_GROUP" && !assetGroupId) problems.push("scope ASSET_GROUP exige assetGroupId");
  if (linkAsSignal && !assetGroupId) problems.push("linkAsSignal exige assetGroupId");
  if (assetGroupId !== undefined && !isId(assetGroupId)) problems.push(`assetGroupId deve ser numérico, recebido "${assetGroupId}"`);
  if (!hasPositiveDimension(spec)) {
    problems.push("informe ao menos um segmento ou dimensão positiva (userLists, userInterests, customAudiences, lifeEvents, " +
      "detailedDemographics, ageRanges, genders, incomeRanges, parentalStatuses) — exclusão sozinha não forma público");
  }
  if (problems.length > 0) return fail(`${input.toolName}: nada foi criado.\n- ${problems.join("\n- ")}`);

  let group: AssetGroupInfo | undefined;
  if (assetGroupId) {
    group = (await loadAssetGroups(client, cid, [assetGroupId])).get(assetGroupId);
    const problem = assetGroupProblem(group, assetGroupId, cid);
    if (problem) return fail(`${problem} Nada foi criado.`);
  }

  if (scope === "CUSTOMER" && name) {
    const existing = await client.searchStream(cid,
      `SELECT audience.id, audience.name, audience.status FROM audience WHERE audience.name = '${gaqlLiteral(name)}'`);
    const clash = existing.map((row) => asObj(row.audience)).find((audience) => audience.status !== "REMOVED");
    if (clash) {
      return fail(`Já existe o público "${name}" (id ${str(clash.id)}) na conta ${cid}. Use update_audience para mudá-lo ou escolha outro nome. Nada foi criado.`);
    }
  }

  const check = await verifySegments(client, cid, spec);
  if (check.missing.length > 0) {
    return fail(`Segmentos não encontrados na conta ${cid} — nada foi criado:\n- ${check.missing.join("\n- ")}`);
  }

  let replaced: SignalInfo | undefined;
  if (linkAsSignal && group) {
    const signals = await loadSignals(client, cid, `asset_group.id = ${group.id}`);
    const current = signals.find((signal) => signal.kind === "audience");
    if (current) {
      if (!input.replaceExistingSignal) {
        return fail(
          `O grupo ${group.id} ("${group.name}") já usa o público ${current.audience} como sinal, e a API aceita um só por grupo ` +
          "(ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP). Opções: editar esse público com update_audience, ou repetir com " +
          "replaceExistingSignal: true e confirm: true para trocar. Nada foi criado."
        );
      }
      if (!input.confirm) {
        return fail(`Trocar o sinal de público do grupo ${group.id} remove o vínculo com ${current.audience}. Envie confirm: true. Nada foi criado.`);
      }
      replaced = current;
    }
  }

  const { dimensions, exclusionDimension } = buildAudienceDimensions(spec);
  const audience: Row = { scope, dimensions };
  if (spec.excludeUserLists.length > 0) audience.exclusionDimension = exclusionDimension;
  if (scope === "CUSTOMER") audience.name = name;
  if (scope === "ASSET_GROUP" && group) audience.assetGroup = group.resourceName;
  if (input.description?.trim()) audience.description = input.description.trim();

  const dryRun = client.isDryRun;
  let audienceResource: string | undefined;
  let signalResource: string | undefined;
  try {
    if (linkAsSignal && group) {
      const tempAudience = `customers/${cid}/audiences/-1`;
      const operations: Row[] = [{ audienceOperation: { create: { ...audience, resourceName: tempAudience } } }];
      if (replaced) operations.push({ assetGroupSignalOperation: { remove: replaced.resourceName } });
      operations.push({ assetGroupSignalOperation: { create: { assetGroup: group.resourceName, audience: { audience: tempAudience } } } });
      const response = await client.batchMutate(cid, operations);
      const responses = asRows(response.mutateOperationResponses);
      audienceResource = str(asObj(responses[0]?.audienceResult).resourceName) || undefined;
      signalResource = str(asObj(responses[responses.length - 1]?.assetGroupSignalResult).resourceName) || undefined;
      if (!dryRun && !audienceResource) return fail(`A API não confirmou a criação do público — confira a conta antes de repetir.\n\n${formatJson(response)}`);
    } else {
      const response = await client.mutate(cid, "audiences", [{ create: audience } as MutateOperation]);
      audienceResource = str(asRows(response.results)[0]?.resourceName) || undefined;
      if (!dryRun && !audienceResource) return fail(`A API não confirmou a criação do público — confira a conta antes de repetir.\n\n${formatJson(response)}`);
    }
  } catch (err) {
    return fail(`${input.toolName}: a API recusou — nada foi criado.\nErro: ${explainApiError(errorMessage(err))}\n\n${formatJson({ audience })}`);
  }

  const header = dryRun
    ? dryRunHeader(true, "")
    : `Público criado${linkAsSignal && group ? ` e vinculado como sinal do grupo ${group.id} ("${group.name}")` : ""}.`;
  const report: Row = {
    audience: {
      resource_name: audienceResource ?? (dryRun ? "(não criado — dry-run)" : undefined),
      name: scope === "CUSTOMER" ? name : undefined,
      scope,
      asset_group: scope === "ASSET_GROUP" ? group?.resourceName : undefined,
    },
    composition: describeSpec(spec, check.names),
  };
  if (linkAsSignal && group) {
    report.signal = { asset_group: group.resourceName, asset_group_name: group.name, resource_name: signalResource };
    if (replaced) report.replaced_signal = { resource_name: replaced.resourceName, audience: replaced.audience };
  }
  if (check.notes.length > 0) report.warnings = check.notes;
  const next = linkAsSignal && group
    ? "Confira com list_asset_group_signals."
    : "Para usar como sinal de PMax: manage_asset_group_signals (setAudience) ou add_audience_signal.";
  return ok(`${header}\n\n${formatJson(report)}\n\n${dryRun ? "Para gravar de verdade, rode sem validateOnly/GOOGLE_ADS_DRY_RUN." : next}`);
}

// ── add_audience_signal (tool do núcleo, implementação aqui) ─────────

export interface AddSignalInput {
  assetGroupId: string;
  signalType: "audience" | "search_theme";
  audienceResourceName?: string;
  searchThemeText?: string;
}

/** Limpa, conta palavras e tira repetidos (sem diferenciar maiúsculas). */
function cleanSearchThemes(values: unknown, problems: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of ensureArray<unknown>(values)) {
    if (typeof entry !== "string") {
      problems.push(`tema inválido ${JSON.stringify(entry)} — use texto`);
      continue;
    }
    const theme = entry.trim().replace(/\s+/g, " ");
    if (!theme) continue;
    const words = theme.split(" ").length;
    if (words > MAX_SEARCH_THEME_WORDS) {
      problems.push(`tema "${theme}" tem ${words} palavras (máx. ${MAX_SEARCH_THEME_WORDS})`);
      continue;
    }
    const key = theme.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(theme);
    }
  }
  return out;
}

export async function addAudienceSignal(client: GoogleAdsClient, customerId: string, input: AddSignalInput): Promise<ToolResult> {
  const cid = normCid(customerId);
  if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
  const assetGroupId = String(input.assetGroupId ?? "").trim();
  if (!isId(assetGroupId)) return fail(`assetGroupId deve ser numérico, recebido "${input.assetGroupId}". Nada foi alterado.`);

  let theme: string | undefined;
  let audienceRef: string | undefined;
  if (input.signalType === "search_theme") {
    const problems: string[] = [];
    theme = cleanSearchThemes([input.searchThemeText ?? ""], problems)[0];
    if (problems.length > 0) return fail(`Nada foi alterado: ${problems.join("; ")}.`);
    if (!theme) return fail("Informe searchThemeText para o tipo search_theme. Nada foi alterado.");
  } else {
    if (!input.audienceResourceName) return fail("Informe audienceResourceName (ou o ID do público) para o tipo audience. Nada foi alterado.");
    const parsed = parseRef(input.audienceResourceName, cid, "audiences");
    if ("error" in parsed) return fail(`audienceResourceName: ${parsed.error}. Nada foi alterado.`);
    audienceRef = parsed.resourceName;
  }

  const group = (await loadAssetGroups(client, cid, [assetGroupId])).get(assetGroupId);
  const problem = assetGroupProblem(group, assetGroupId, cid);
  if (problem) return fail(`${problem} Nada foi alterado.`);
  const signals = await loadSignals(client, cid, `asset_group.id = ${assetGroupId}`);
  const groupLine = `Grupo ${assetGroupId} ("${group!.name}", campanha ${group!.campaignId})`;

  let create: Row;
  if (theme !== undefined) {
    const existing = signals.find((signal) => signal.kind === "search_theme" && signal.searchTheme?.toLowerCase() === theme!.toLowerCase());
    if (existing) {
      return ok(`${groupLine}: o tema "${theme}" já existe (${existing.resourceName}, ${existing.approvalStatus ?? "status desconhecido"}). Nenhuma escrita foi enviada.`);
    }
    create = { assetGroup: group!.resourceName, searchTheme: { text: theme } };
  } else {
    const audiences = await loadAudiences(client, cid, [audienceRef!]);
    const audience = audiences.get(audienceRef!);
    if (!audience || audience.status === "REMOVED") return fail(`Público ${audienceRef} não encontrado (ou removido) na conta ${cid}. Nada foi alterado.`);
    if (audience.scope === "ASSET_GROUP" && audience.assetGroup !== group!.resourceName) {
      return fail(`O público ${audienceRef} tem escopo do grupo ${audience.assetGroup}, não do ${assetGroupId} (AUDIENCE_WITH_WRONG_ASSET_GROUP_ID). Nada foi alterado.`);
    }
    const current = signals.find((signal) => signal.kind === "audience");
    if (current?.audience === audienceRef) {
      return ok(`${groupLine}: o público ${audienceRef} já é o sinal deste grupo. Nenhuma escrita foi enviada.`);
    }
    if (current) {
      return fail(
        `${groupLine} já usa o público ${current.audience} como sinal, e a API aceita um só por grupo (ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP). ` +
        "Para trocar, use manage_asset_group_signals com setAudience e confirm: true; para mudar a composição, update_audience. Nada foi alterado."
      );
    }
    create = { assetGroup: group!.resourceName, audience: { audience: audienceRef } };
  }

  const dryRun = client.isDryRun;
  try {
    const response = await client.mutate(cid, "assetGroupSignals", [{ create } as MutateOperation]);
    const resourceName = str(asRows(response.results)[0]?.resourceName);
    const what = theme !== undefined ? `tema de pesquisa "${theme}"` : `público ${audienceRef}`;
    if (dryRun) return ok(`${dryRunHeader(true, "")}\n${groupLine}: ${what} seria adicionado.`);
    return ok(`${groupLine}: ${what} adicionado como sinal.\nResource: ${resourceName}\n\n` +
      "Temas passam por revisão de política — confira o status com list_asset_group_signals.");
  } catch (err) {
    return fail(`${groupLine}: a API recusou o sinal — nada foi alterado.\nErro: ${explainApiError(errorMessage(err))}`);
  }
}

// ── Registro das tools ──────────────────────────────────────────────

export function registerPmaxSignalsTools(ctx: ToolContext): void {
  const { mcp } = ctx;

  // ════════════════════════ Sinais e públicos ════════════════════════

  mcp.registerTool(
    "create_audience",
    {
      description: [
        "Cria um público (Audience) para sinal de Performance Max ou segmentação de Demand Gen.",
        "WRITE OPERATION.",
        "",
        "Combina, num público só: listas de público (userLists), interesses (userInterests), segmentos",
        "personalizados (customAudiences), eventos da vida, dados demográficos detalhados, faixa etária,",
        "gênero, renda e situação parental; excludeUserLists exclui listas. Segmentos entram em OU;",
        "dimensões diferentes (ex.: segmentos E idade) entram em E.",
        "",
        "- scope CUSTOMER (padrão): público reutilizável, exige name único na conta.",
        "- scope ASSET_GROUP: público exclusivo de um grupo de recursos (assetGroupId), sem name.",
        "- linkAsSignal: cria e já vincula como sinal do grupo, numa única chamada atômica (padrão true com",
        "  ASSET_GROUP). O grupo aceita UM público: se já houver outro, passe replaceExistingSignal + confirm.",
        "",
        "Confere antes na conta que cada segmento existe e que o nome não está em uso.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().optional().describe("Nome único do público (obrigatório no escopo CUSTOMER; proibido no ASSET_GROUP)."),
        description: z.string().optional().describe("Descrição opcional."),
        scope: z.enum(["CUSTOMER", "ASSET_GROUP"]).optional().describe("CUSTOMER (padrão, reutilizável) ou ASSET_GROUP (exclusivo de um grupo)."),
        assetGroupId: z.string().optional().describe("Grupo de recursos PMax (obrigatório com ASSET_GROUP ou linkAsSignal)."),
        linkAsSignal: z.boolean().optional().describe("true = vincula o público como sinal do assetGroupId na mesma chamada."),
        replaceExistingSignal: z.boolean().optional().describe("Com linkAsSignal: troca o público que o grupo já usa (exige confirm)."),
        confirm: z.boolean().optional().describe("Obrigatório com replaceExistingSignal (remove o vínculo atual)."),
        ...audienceShape,
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi criado.`);
      return createAudienceCore(ctx.getClient(), cid, { ...args, toolName: "create_audience" });
    }
  );

  mcp.registerTool(
    "update_audience",
    {
      description: [
        "Edita um público (Audience) existente — é o único jeito suportado de mudar um sinal de público do PMax.",
        "WRITE OPERATION.",
        "",
        "Cada campo informado SUBSTITUI aquela parte do público ([] limpa); o que não for informado fica como está.",
        "Ex.: genders: [\"FEMALE\"] troca só o gênero e mantém listas, interesses e idade.",
        "- name/description: renomeia (name só em público de escopo CUSTOMER).",
        "- promoteToCustomerScope: transforma um público ASSET_GROUP em CUSTOMER (exige name e confirm: true).",
        "  IRREVERSÍVEL: a API não deixa voltar de CUSTOMER para ASSET_GROUP e limpa o vínculo exclusivo com o grupo.",
        "  Sem confirm, devolve o plano (antes/depois e grupos que usam o público) e não envia nada.",
        "",
        "Mostra antes/depois e os grupos de recursos que usam o público. Sem mudança, nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        audienceId: z.string().describe("ID do público ou customers/{cid}/audiences/{id} (veja list_asset_group_signals ou list_audience_segments)."),
        name: z.string().optional().describe("Novo nome (só escopo CUSTOMER)."),
        description: z.string().optional().describe("Nova descrição (\"\" limpa)."),
        promoteToCustomerScope: z.boolean().optional().describe("true = muda o escopo de ASSET_GROUP para CUSTOMER (exige name e confirm; não tem volta)."),
        confirm: z.boolean().optional().describe("Obrigatório com promoteToCustomerScope num público ASSET_GROUP (mudança irreversível)."),
        ...audienceShape,
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi alterado.`);
      const ref = parseRef(args.audienceId, cid, "audiences");
      if ("error" in ref) return fail(`audienceId: ${ref.error}. Nada foi alterado.`);
      const problems: string[] = [];
      const provided = parseAudienceInput(args, cid, problems);
      const newName = args.name?.trim();
      if (args.name !== undefined && !newName) problems.push("name não pode ser vazio");
      if (newName && newName.length > 255) problems.push(`name tem ${newName.length} caracteres (máx. 255)`);
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);
      if (Object.keys(provided).length === 0 && args.name === undefined && args.description === undefined && !args.promoteToCustomerScope) {
        return fail("Informe ao menos um ajuste (segmentos, dimensões, excludeUserLists, name, description ou promoteToCustomerScope).");
      }

      const client = ctx.getClient();
      const audience = (await loadAudiences(client, cid, [ref.resourceName])).get(ref.resourceName);
      if (!audience) return fail(`Público ${ref.resourceName} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (audience.status === "REMOVED") return fail(`Público ${ref.resourceName} está removido. Nada foi alterado.`);

      const before = specFromAudience(audience.raw);
      const after: AudienceSpec = { ...before, ...provided };
      if (!hasPositiveDimension(after)) {
        return fail("O público ficaria sem nenhum segmento ou dimensão positiva — a API exige ao menos um. Nada foi alterado.");
      }

      const update: Row = { resourceName: ref.resourceName };
      const mask: string[] = [];
      const changes: Row[] = [];
      const unchanged: string[] = [];
      const promote = args.promoteToCustomerScope === true;

      if (promote && audience.scope === "CUSTOMER") unchanged.push("escopo (já é CUSTOMER)");
      const willBeCustomer = audience.scope === "CUSTOMER" || promote;
      if (newName !== undefined && !willBeCustomer) {
        return fail("Público de escopo ASSET_GROUP não aceita name. Use promoteToCustomerScope: true junto com o name. Nada foi alterado.");
      }
      // Promoção de escopo: a API aceita ASSET_GROUP → CUSTOMER, mas nunca o caminho de volta (resources/audience.proto).
      const promoting = promote && audience.scope !== "CUSTOMER";
      if (promoting) {
        if (!newName) return fail("promoteToCustomerScope exige name (público CUSTOMER precisa de nome único). Nada foi alterado.");
        update.scope = "CUSTOMER";
        mask.push("scope");
        changes.push({ setting: "escopo", before: audience.scope, after: "CUSTOMER" });
      }
      if (newName !== undefined) {
        if (newName === audience.name) {
          unchanged.push("name");
        } else {
          const clash = (await client.searchStream(cid,
            `SELECT audience.id, audience.name, audience.status FROM audience WHERE audience.name = '${gaqlLiteral(newName)}'`))
            .map((row) => asObj(row.audience))
            .find((row) => row.status !== "REMOVED" && str(row.id) !== audience.id);
          if (clash) return fail(`Já existe o público "${newName}" (id ${str(clash.id)}). Nada foi alterado.`);
          update.name = newName;
          mask.push("name");
          changes.push({ setting: "name", before: audience.name || null, after: newName });
        }
      }
      if (args.description !== undefined) {
        const description = args.description.trim();
        if (description === audience.description) {
          unchanged.push("description");
        } else {
          update.description = description;
          mask.push("description");
          changes.push({ setting: "description", before: audience.description, after: description });
        }
      }

      // Segmentos novos precisam existir; os que já estavam no público não são reconferidos.
      const added: Partial<AudienceSpec> = {};
      for (const type of SEGMENT_TYPES) {
        const fresh = after[type.key].filter((rn) => !before[type.key].includes(rn));
        if (fresh.length) added[type.key] = fresh;
      }
      const freshExclusions = after.excludeUserLists.filter((rn) => !before.excludeUserLists.includes(rn));
      if (freshExclusions.length) added.excludeUserLists = freshExclusions;
      const check = await verifySegments(client, cid, added);
      if (check.missing.length > 0) {
        return fail(`Segmentos não encontrados na conta ${cid} — nada foi alterado:\n- ${check.missing.join("\n- ")}`);
      }

      const built = buildAudienceDimensions(after);
      if (canonicalPositive(before) !== canonicalPositive(after)) {
        update.dimensions = built.dimensions;
        mask.push("dimensions");
      } else if (Object.keys(provided).some((key) => key !== "excludeUserLists")) {
        unchanged.push("dimensões");
      }
      if ([...before.excludeUserLists].sort().join() !== [...after.excludeUserLists].sort().join()) {
        update.exclusionDimension = built.exclusionDimension;
        mask.push("exclusion_dimension.exclusions");
      } else if (provided.excludeUserLists !== undefined) {
        unchanged.push("excludeUserLists");
      }

      const names = new Map(check.names);
      const beforeView = describeSpec(before, names);
      const afterView = describeSpec(after, names);
      const usedBy = (await client.searchStream(cid,
        `SELECT asset_group.id, asset_group.name, campaign.id, campaign.name, asset_group_signal.resource_name
         FROM asset_group_signal
         WHERE asset_group_signal.audience.audience = '${gaqlLiteral(ref.resourceName)}'`))
        .map((row) => ({
          asset_group_id: str(asObj(row.assetGroup).id),
          asset_group_name: str(asObj(row.assetGroup).name),
          campaign_id: str(asObj(row.campaign).id),
          campaign_name: str(asObj(row.campaign).name),
        }));
      const label = `Público ${audience.id}${audience.name ? ` ("${audience.name}")` : ""}`;

      if (mask.length === 0) {
        return ok(`${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n` +
          formatJson({ unchanged, composition: beforeView, used_by: usedBy }));
      }

      if (promoting && args.confirm !== true) {
        return fail(`${label}: mudar o escopo de ASSET_GROUP para CUSTOMER é IRREVERSÍVEL — a API não deixa voltar para ` +
          `ASSET_GROUP e limpa o vínculo exclusivo com o grupo ${lastSegment(audience.assetGroup) || "(desconhecido)"}. ` +
          "Revise o plano e repita com confirm: true. Nada foi enviado.\n\n" +
          formatJson({
            update_mask: mask,
            changes,
            unchanged,
            scope: { before: audience.scope, after: "CUSTOMER" },
            asset_group: { before: audience.assetGroup || null, after: null },
            before: beforeView,
            after: afterView,
            used_by: usedBy,
            ...(check.notes.length ? { warnings: check.notes } : {}),
          }));
      }

      const dryRun = client.isDryRun;
      try {
        await client.mutate(cid, "audiences", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`${label}: a API recusou a alteração — nada foi gravado.\nErro: ${explainApiError(errorMessage(err))}\n\n` +
          formatJson({ update_mask: mask, before: beforeView, after: afterView }));
      }
      return ok(`${label} — ${dryRunHeader(dryRun, "alteração gravada.")}\n` +
        (usedBy.length ? `Vale para ${usedBy.length} grupo(s) de recursos que usam este público.\n` : "") + "\n" +
        formatJson({
          update_mask: mask,
          changes,
          unchanged,
          before: beforeView,
          after: afterView,
          used_by: usedBy,
          ...(check.notes.length ? { warnings: check.notes } : {}),
        }));
    }
  );

  mcp.registerTool(
    "list_asset_group_signals",
    {
      description: [
        "Lista os sinais dos grupos de recursos PMax: temas de pesquisa (com status de aprovação e motivos de",
        "reprovação) e o público de cada grupo (nome, escopo e composição).",
        "READ OPERATION.",
        "",
        "Informe assetGroupId (um grupo) ou campaignId (todos os grupos da campanha).",
        "Tema DISAPPROVED não veicula — veja disapproval_reasons e troque o texto com manage_asset_group_signals.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().optional().describe("ID do grupo de recursos."),
        campaignId: z.string().optional().describe("ID da campanha PMax (todos os grupos)."),
        format: formatSchema,
      },
    },
    async ({ customerId, assetGroupId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!assetGroupId && !campaignId) return fail("Informe assetGroupId ou campaignId.");
      if (assetGroupId !== undefined && !isId(assetGroupId)) return fail(`assetGroupId deve ser numérico, recebido "${assetGroupId}".`);
      if (campaignId !== undefined && !isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);

      const client = ctx.getClient();
      const where = [assetGroupId ? `asset_group.id = ${assetGroupId.trim()}` : "", campaignId ? `campaign.id = ${campaignId.trim()}` : ""]
        .filter(Boolean)
        .join(" AND ");
      const signals = await loadSignals(client, cid, where);
      const audiences = await loadAudiences(client, cid, signals.map((signal) => signal.audience ?? "").filter(Boolean));

      const rows = signals.map((signal) => {
        const audience = signal.audience ? audiences.get(signal.audience) : undefined;
        return {
          campaign_id: signal.campaignId,
          campaign_name: signal.campaignName,
          asset_group_id: signal.assetGroupId,
          asset_group_name: signal.assetGroupName,
          signal_id: signal.signalId,
          type: signal.kind === "audience" ? "AUDIENCE" : signal.kind === "search_theme" ? "SEARCH_THEME" : "OTHER",
          value: signal.kind === "audience" ? audience?.name || signal.audience : signal.searchTheme ?? "",
          audience_resource_name: signal.audience ?? "",
          audience_scope: audience?.scope ?? "",
          approval_status: signal.approvalStatus ?? "",
          disapproval_reasons: signal.disapprovalReasons.join("; "),
        };
      });
      if (format === "table") return ok(formatAsTable(rows));
      if (format === "csv") return ok(formatAsCsv(rows));

      const groups = new Map<string, Row>();
      for (const signal of signals) {
        const entry = groups.get(signal.assetGroupId) ?? {
          asset_group_id: signal.assetGroupId,
          asset_group_name: signal.assetGroupName,
          campaign_id: signal.campaignId,
          audience: null,
          search_themes: [] as Row[],
        };
        if (signal.kind === "audience") {
          const audience = audiences.get(signal.audience!);
          entry.audience = {
            signal_id: signal.signalId,
            resource_name: signal.audience,
            name: audience?.name || null,
            scope: audience?.scope ?? null,
            composition: audience ? describeSpec(specFromAudience(audience.raw), new Map()) : null,
          };
        } else if (signal.kind === "search_theme") {
          (entry.search_themes as Row[]).push({
            signal_id: signal.signalId,
            text: signal.searchTheme,
            approval_status: signal.approvalStatus ?? null,
            ...(signal.disapprovalReasons.length ? { disapproval_reasons: signal.disapprovalReasons } : {}),
          });
        }
        groups.set(signal.assetGroupId, entry);
      }
      const disapproved = signals.filter((signal) => signal.approvalStatus === "DISAPPROVED").length;
      return ok(`${signals.length} sinal(is) em ${groups.size} grupo(s) de recursos` +
        (disapproved ? ` — ${disapproved} tema(s) REPROVADO(s)` : "") + `.\n\n${formatJson([...groups.values()])}`);
    }
  );

  mcp.registerTool(
    "manage_asset_group_signals",
    {
      description: [
        "Adiciona e remove sinais de um grupo de recursos PMax em lote.",
        "WRITE OPERATION.",
        "",
        "- addSearchThemes: temas de pesquisa (até 10 palavras cada). Repetidos e já existentes são pulados.",
        "- removeSearchThemes: remove temas pelo texto; removeSignalIds: remove pelo ID do sinal.",
        "- setAudience: define o público do grupo (ID ou resource name). O grupo aceita UM público: se já houver",
        "  outro, ele é trocado numa chamada atômica (remove + cria).",
        "- removeAudience: remove o sinal de público do grupo.",
        "Remoções (e troca de público) exigem confirm: true.",
        "",
        "Temas e remoções vão com partial failure: cada tema recusado (política, palavras demais) volta com o",
        "erro próprio e os demais são aplicados. Para mudar a composição do público, use update_audience.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("ID do grupo de recursos PMax."),
        addSearchThemes: flexArray(z.string()).optional().describe("Temas de pesquisa a adicionar."),
        removeSearchThemes: flexArray(z.string()).optional().describe("Temas a remover (pelo texto, sem diferenciar maiúsculas)."),
        removeSignalIds: flexArray(z.string()).optional().describe("IDs de sinais a remover (signal_id de list_asset_group_signals ou o resource name)."),
        setAudience: z.string().optional().describe("Público do grupo: ID ou customers/{cid}/audiences/{id}."),
        removeAudience: z.boolean().optional().describe("true = remove o sinal de público do grupo."),
        confirm: z.boolean().optional().describe("Obrigatório quando há remoção ou troca de público."),
      },
    },
    async ({ customerId, assetGroupId, addSearchThemes, removeSearchThemes, removeSignalIds, setAudience, removeAudience, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!isId(assetGroupId)) return fail(`assetGroupId deve ser numérico, recebido "${assetGroupId}". Nada foi alterado.`);
      const agId = assetGroupId.trim();
      const problems: string[] = [];
      const themesToAdd = cleanSearchThemes(addSearchThemes, problems);
      const themesToRemove = cleanSearchThemes(removeSearchThemes, problems);
      const signalIdsToRemove: string[] = [];
      for (const entry of ensureArray<unknown>(removeSignalIds)) {
        const value = typeof entry === "string" ? entry.trim() : "";
        const match = /^customers\/([\d-]+)\/assetGroupSignals\/(\d+)~(\d+)$/.exec(value);
        if (/^\d+$/.test(value)) signalIdsToRemove.push(value);
        else if (match && match[1].replace(/-/g, "") === cid && match[2] === agId) signalIdsToRemove.push(match[3]);
        else problems.push(`removeSignalIds: "${String(entry)}" não é um ID de sinal deste grupo (${agId}) nesta conta`);
      }
      let audienceRef: string | undefined;
      if (setAudience !== undefined) {
        const parsed = parseRef(setAudience, cid, "audiences");
        if ("error" in parsed) problems.push(`setAudience: ${parsed.error}`);
        else audienceRef = parsed.resourceName;
      }
      if (setAudience !== undefined && removeAudience) problems.push("use setAudience OU removeAudience, não os dois");
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);
      if (!themesToAdd.length && !themesToRemove.length && !signalIdsToRemove.length && !audienceRef && !removeAudience) {
        return fail("Informe ao menos uma ação: addSearchThemes, removeSearchThemes, removeSignalIds, setAudience ou removeAudience.");
      }

      const client = ctx.getClient();
      const group = (await loadAssetGroups(client, cid, [agId])).get(agId);
      const problem = assetGroupProblem(group, agId, cid);
      if (problem) return fail(`${problem} Nada foi alterado.`);
      const signals = await loadSignals(client, cid, `asset_group.id = ${agId}`);
      const currentAudience = signals.find((signal) => signal.kind === "audience");
      const groupLine = `Grupo ${agId} ("${group!.name}", campanha ${group!.campaignId})`;

      const skipped: Row[] = [];
      const notFound: Row[] = [];
      // Operações com partial failure: temas novos e remoções de temas/sinais
      const partialOps: Array<{ op: MutateOperation; describe: Row }> = [];
      for (const theme of themesToAdd) {
        const existing = signals.find((signal) => signal.kind === "search_theme" && signal.searchTheme?.toLowerCase() === theme.toLowerCase());
        if (existing) {
          skipped.push({ search_theme: theme, reason: `já existe (${existing.approvalStatus ?? "sem status"})`, signal_id: existing.signalId });
          continue;
        }
        partialOps.push({
          op: { create: { assetGroup: group!.resourceName, searchTheme: { text: theme } } },
          describe: { action: "add_search_theme", search_theme: theme },
        });
      }
      const removing = new Set<string>();
      for (const theme of themesToRemove) {
        const existing = signals.find((signal) => signal.kind === "search_theme" && signal.searchTheme?.toLowerCase() === theme.toLowerCase());
        if (!existing) {
          notFound.push({ search_theme: theme, reason: "tema não existe neste grupo" });
          continue;
        }
        if (removing.has(existing.resourceName)) continue;
        removing.add(existing.resourceName);
        partialOps.push({
          op: { remove: existing.resourceName },
          describe: { action: "remove_search_theme", search_theme: existing.searchTheme, signal_id: existing.signalId },
        });
      }
      for (const signalId of signalIdsToRemove) {
        const existing = signals.find((signal) => signal.signalId === signalId);
        if (!existing) {
          notFound.push({ signal_id: signalId, reason: "sinal não existe neste grupo" });
          continue;
        }
        if (existing.kind === "audience") {
          notFound.push({ signal_id: signalId, reason: "é o sinal de público — use removeAudience: true" });
          continue;
        }
        if (removing.has(existing.resourceName)) continue;
        removing.add(existing.resourceName);
        partialOps.push({
          op: { remove: existing.resourceName },
          describe: { action: "remove_signal", signal_id: signalId, search_theme: existing.searchTheme },
        });
      }

      // Público: operação atômica separada (remove + cria não pode ficar pela metade)
      let audienceOps: MutateOperation[] = [];
      let audienceDescribe: Row | undefined;
      if (audienceRef) {
        if (currentAudience?.audience === audienceRef) {
          skipped.push({ audience: audienceRef, reason: "já é o público deste grupo" });
        } else {
          const audience = (await loadAudiences(client, cid, [audienceRef])).get(audienceRef);
          if (!audience || audience.status === "REMOVED") return fail(`Público ${audienceRef} não encontrado (ou removido) na conta ${cid}. Nada foi alterado.`);
          if (audience.scope === "ASSET_GROUP" && audience.assetGroup !== group!.resourceName) {
            return fail(`O público ${audienceRef} tem escopo do grupo ${audience.assetGroup}, não do ${agId}. Nada foi alterado.`);
          }
          audienceOps = [
            ...(currentAudience ? [{ remove: currentAudience.resourceName }] : []),
            { create: { assetGroup: group!.resourceName, audience: { audience: audienceRef } } },
          ];
          audienceDescribe = {
            action: currentAudience ? "replace_audience" : "set_audience",
            audience: audienceRef,
            audience_name: audience.name || null,
            ...(currentAudience ? { previous_audience: currentAudience.audience } : {}),
          };
        }
      } else if (removeAudience) {
        if (!currentAudience) {
          notFound.push({ audience: null, reason: "o grupo não tem sinal de público" });
        } else {
          audienceOps = [{ remove: currentAudience.resourceName }];
          audienceDescribe = { action: "remove_audience", audience: currentAudience.audience, signal_id: currentAudience.signalId };
        }
      }

      const plan = [...partialOps.map((item) => item.describe), ...(audienceDescribe ? [audienceDescribe] : [])];
      if (plan.length === 0) {
        return ok(`${groupLine}: nada a fazer — nenhuma escrita foi enviada.\n\n${formatJson({ skipped, not_found: notFound })}`);
      }
      const hasRemoval = partialOps.some((item) => item.op.remove) || audienceOps.some((op) => op.remove);
      if (hasRemoval && !confirm) {
        return fail(`${groupLine}: o plano remove sinais. Revise e repita com confirm: true. Nada foi enviado.\n\n` +
          formatJson({ plan, skipped, not_found: notFound }));
      }

      const dryRun = client.isDryRun;
      const applied: Row[] = [];
      const errors: Row[] = [];
      if (partialOps.length > 0) {
        try {
          const response = await client.mutate(cid, "assetGroupSignals", partialOps.map((item) => item.op), { partialFailure: true });
          perOperation(response, partialOps.length, dryRun).forEach((outcome, index) => {
            const entry = { ...partialOps[index].describe, ...(outcome.resourceName ? { resource_name: outcome.resourceName } : {}) };
            if (outcome.ok) applied.push(entry);
            else errors.push({ ...entry, error: outcome.error });
          });
        } catch (err) {
          for (const item of partialOps) errors.push({ ...item.describe, error: explainApiError(errorMessage(err)) });
        }
      }
      if (audienceOps.length > 0 && audienceDescribe) {
        try {
          await client.mutate(cid, "assetGroupSignals", audienceOps);
          applied.push(audienceDescribe);
        } catch (err) {
          errors.push({ ...audienceDescribe, error: explainApiError(errorMessage(err)) });
        }
      }

      const header = dryRun
        ? `${groupLine} — DRY-RUN (validateOnly): nada foi gravado. Validadas: ${applied.length} | Com erro: ${errors.length}`
        : `${groupLine} — aplicadas: ${applied.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ [dryRun ? "validated" : "applied"]: applied, errors, skipped, not_found: notFound })}\n\n` +
          "Temas novos passam por revisão de política — confira com list_asset_group_signals.")],
        ...(errors.length > 0 ? { isError: true } : {}),
      };
    }
  );

  mcp.registerTool(
    "copy_asset_group_signals",
    {
      description: [
        "Copia os sinais de um grupo de recursos PMax para outros grupos (da mesma conta).",
        "WRITE OPERATION.",
        "",
        "- Temas de pesquisa: copia os que faltam no destino; temas REPROVADOS na origem não são copiados.",
        "- Público de escopo CUSTOMER: vinculado ao destino se o destino ainda não tiver público.",
        "- Público de escopo ASSET_GROUP: cria uma cópia com escopo do grupo de destino e vincula, na mesma",
        "  chamada atômica.",
        "Nunca troca nem remove o público que o destino já tem — esses casos voltam em skipped.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        sourceAssetGroupId: z.string().describe("Grupo de recursos de origem."),
        targetAssetGroupIds: flexArray(z.string()).describe("Grupos de recursos de destino (até 20)."),
        includeSearchThemes: z.boolean().optional().describe("Copiar temas de pesquisa. Padrão: true."),
        includeAudience: z.boolean().optional().describe("Copiar o público. Padrão: true."),
      },
    },
    async ({ customerId, sourceAssetGroupId, targetAssetGroupIds, includeSearchThemes, includeAudience }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!isId(sourceAssetGroupId)) return fail(`sourceAssetGroupId deve ser numérico, recebido "${sourceAssetGroupId}". Nada foi alterado.`);
      const sourceId = sourceAssetGroupId.trim();
      const targets: string[] = [];
      for (const entry of ensureArray<unknown>(targetAssetGroupIds)) {
        const value = typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : "";
        if (!/^\d+$/.test(value)) return fail(`targetAssetGroupIds: "${String(entry)}" não é numérico. Nada foi alterado.`);
        if (value !== sourceId && !targets.includes(value)) targets.push(value);
      }
      if (targets.length === 0) return fail("Informe ao menos um grupo de destino diferente da origem.");
      if (targets.length > 20) return fail(`${targets.length} grupos de destino (máx. 20 por chamada).`);
      const copyThemes = includeSearchThemes ?? true;
      const copyAudience = includeAudience ?? true;
      if (!copyThemes && !copyAudience) return fail("includeSearchThemes e includeAudience estão os dois false — nada a copiar.");

      const client = ctx.getClient();
      const groups = await loadAssetGroups(client, cid, [sourceId, ...targets]);
      const sourceProblem = assetGroupProblem(groups.get(sourceId), sourceId, cid);
      if (sourceProblem) return fail(`Origem: ${sourceProblem} Nada foi alterado.`);
      const targetProblems = targets.map((id) => assetGroupProblem(groups.get(id), id, cid)).filter(Boolean);
      if (targetProblems.length) return fail(`Destino inválido — nada foi alterado:\n- ${targetProblems.join("\n- ")}`);

      const signals = await loadSignals(client, cid, `asset_group.id IN (${[sourceId, ...targets].join(", ")})`);
      const sourceSignals = signals.filter((signal) => signal.assetGroupId === sourceId);
      const sourceThemes = sourceSignals.filter((signal) => signal.kind === "search_theme");
      const sourceAudienceSignal = sourceSignals.find((signal) => signal.kind === "audience");
      const sourceAudience = copyAudience && sourceAudienceSignal
        ? (await loadAudiences(client, cid, [sourceAudienceSignal.audience!])).get(sourceAudienceSignal.audience!)
        : undefined;

      const skipped: Row[] = [];
      const themeOps: Array<{ op: MutateOperation; describe: Row }> = [];
      const audienceCopies: Array<{ target: AssetGroupInfo; operations: Row[]; describe: Row }> = [];
      const audienceLinks: Array<{ op: MutateOperation; describe: Row }> = [];
      let temp = -1;
      for (const targetId of targets) {
        const target = groups.get(targetId)!;
        const targetSignals = signals.filter((signal) => signal.assetGroupId === targetId);
        if (copyThemes) {
          for (const theme of sourceThemes) {
            if (theme.approvalStatus === "DISAPPROVED") {
              skipped.push({ target: targetId, search_theme: theme.searchTheme, reason: "reprovado na origem" });
              continue;
            }
            if (targetSignals.some((signal) => signal.kind === "search_theme" && signal.searchTheme?.toLowerCase() === theme.searchTheme?.toLowerCase())) {
              skipped.push({ target: targetId, search_theme: theme.searchTheme, reason: "já existe no destino" });
              continue;
            }
            themeOps.push({
              op: { create: { assetGroup: target.resourceName, searchTheme: { text: theme.searchTheme } } },
              describe: { target: targetId, action: "add_search_theme", search_theme: theme.searchTheme },
            });
          }
        }
        if (copyAudience && sourceAudienceSignal) {
          const targetAudience = targetSignals.find((signal) => signal.kind === "audience");
          if (!sourceAudience || sourceAudience.status === "REMOVED") {
            skipped.push({ target: targetId, audience: sourceAudienceSignal.audience, reason: "público da origem não encontrado" });
          } else if (targetAudience?.audience === sourceAudience.resourceName) {
            skipped.push({ target: targetId, audience: sourceAudience.resourceName, reason: "o destino já usa este público" });
          } else if (targetAudience) {
            skipped.push({
              target: targetId,
              audience: sourceAudience.resourceName,
              reason: `o destino já tem outro público (${targetAudience.audience}); troque com manage_asset_group_signals`,
            });
          } else if (sourceAudience.scope === "CUSTOMER") {
            audienceLinks.push({
              op: { create: { assetGroup: target.resourceName, audience: { audience: sourceAudience.resourceName } } },
              describe: { target: targetId, action: "link_audience", audience: sourceAudience.resourceName, audience_name: sourceAudience.name },
            });
          } else {
            const tempName = `customers/${cid}/audiences/${temp--}`;
            const copy: Row = {
              resourceName: tempName,
              scope: "ASSET_GROUP",
              assetGroup: target.resourceName,
              dimensions: sourceAudience.raw.dimensions ?? [],
            };
            const exclusions = asRows(asObj(sourceAudience.raw.exclusionDimension).exclusions);
            if (exclusions.length) copy.exclusionDimension = { exclusions };
            if (sourceAudience.description) copy.description = sourceAudience.description;
            audienceCopies.push({
              target,
              operations: [
                { audienceOperation: { create: copy } },
                { assetGroupSignalOperation: { create: { assetGroup: target.resourceName, audience: { audience: tempName } } } },
              ],
              describe: { target: targetId, action: "copy_asset_group_audience", source_audience: sourceAudience.resourceName },
            });
          }
        }
      }

      const partialOps = [...themeOps, ...audienceLinks];
      if (partialOps.length === 0 && audienceCopies.length === 0) {
        return ok(`Nada a copiar do grupo ${sourceId} — nenhuma escrita foi enviada.\n\n${formatJson({ skipped })}`);
      }
      const dryRun = client.isDryRun;
      const applied: Row[] = [];
      const errors: Row[] = [];
      if (partialOps.length > 0) {
        try {
          const response = await client.mutate(cid, "assetGroupSignals", partialOps.map((item) => item.op), { partialFailure: true });
          perOperation(response, partialOps.length, dryRun).forEach((outcome, index) => {
            const entry = { ...partialOps[index].describe, ...(outcome.resourceName ? { resource_name: outcome.resourceName } : {}) };
            if (outcome.ok) applied.push(entry);
            else errors.push({ ...entry, error: outcome.error });
          });
        } catch (err) {
          for (const item of partialOps) errors.push({ ...item.describe, error: explainApiError(errorMessage(err)) });
        }
      }
      for (const copy of audienceCopies) {
        try {
          const response = await client.batchMutate(cid, copy.operations);
          const responses = asRows(response.mutateOperationResponses);
          applied.push({ ...copy.describe, new_audience: str(asObj(responses[0]?.audienceResult).resourceName) || undefined });
        } catch (err) {
          errors.push({ ...copy.describe, error: explainApiError(errorMessage(err)) });
        }
      }
      const header = dryRun
        ? `Cópia de sinais do grupo ${sourceId} — DRY-RUN (validateOnly): nada foi gravado. Validadas: ${applied.length} | Com erro: ${errors.length}`
        : `Cópia de sinais do grupo ${sourceId} — aplicadas: ${applied.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ [dryRun ? "validated" : "applied"]: applied, errors, skipped })}`)],
        ...(errors.length > 0 ? { isError: true } : {}),
      };
    }
  );

  // ════════════════════════ Automação e expansão de URL ════════════════════════

  /** Estado atual + padrões do PMax, por tipo de automação. */
  function automationState(campaign: Row): Array<{ key: AutomationKey; type: string; label: string; explicit?: string; effective: string }> {
    const settings = asRows(campaign.assetAutomationSettings);
    return PMAX_AUTOMATION.map((item) => {
      const explicit = str(settings.find((setting) => setting.assetAutomationType === item.type)?.assetAutomationStatus) || undefined;
      return { key: item.key, type: item.type, label: item.label, explicit, effective: explicit ?? `${item.pmaxDefault} (padrão)` };
    });
  }

  interface Exclusion {
    criterionId: string;
    resourceName: string;
    name: string;
    conditions: Array<{ operand: string; operator?: string; argument: string }>;
    key: string;
  }

  async function loadUrlExclusions(client: GoogleAdsClient, cid: string, campaignId: string): Promise<Exclusion[]> {
    const rows = await client.searchStream(cid,
      `SELECT campaign_criterion.criterion_id, campaign_criterion.resource_name, campaign_criterion.negative,
              campaign_criterion.status, campaign_criterion.type, campaign_criterion.webpage.criterion_name,
              campaign_criterion.webpage.conditions
       FROM campaign_criterion
       WHERE campaign.id = ${campaignId}
         AND campaign_criterion.type = 'WEBPAGE'
         AND campaign_criterion.negative = TRUE`);
    return rows
      .map((row) => asObj(row.campaignCriterion))
      .filter((criterion) => criterion.status !== "REMOVED")
      .map((criterion) => {
        const webpage = asObj(criterion.webpage);
        const conditions = asRows(webpage.conditions).map((condition) => ({
          operand: str(condition.operand),
          operator: condition.operator !== undefined ? str(condition.operator) : undefined,
          argument: str(condition.argument),
        }));
        return {
          criterionId: str(criterion.criterionId),
          resourceName: str(criterion.resourceName),
          name: str(webpage.criterionName),
          conditions,
          key: exclusionKey(conditions),
        };
      });
  }

  function exclusionKey(conditions: Array<{ operand: string; operator?: string; argument: string }>): string {
    return conditions
      .map((c) => `${c.operand}|${c.operand === "CUSTOM_LABEL" ? "" : c.operator ?? "EQUALS"}|${c.argument.trim().toLowerCase()}`)
      .sort()
      .join("&");
  }

  async function loadPageFeeds(client: GoogleAdsClient, cid: string, campaignId: string): Promise<Row[]> {
    const rows = await client.searchStream(cid,
      `SELECT campaign_asset_set.resource_name, campaign_asset_set.status, asset_set.id, asset_set.name, asset_set.type
       FROM campaign_asset_set
       WHERE campaign.id = ${campaignId}
         AND asset_set.type = 'PAGE_FEED'
         AND campaign_asset_set.status = 'ENABLED'`);
    return rows.map((row) => ({
      asset_set_id: str(asObj(row.assetSet).id),
      asset_set_name: str(asObj(row.assetSet).name),
      link: str(asObj(row.campaignAssetSet).resourceName),
    }));
  }

  async function loadCampaignFinalUrls(client: GoogleAdsClient, cid: string, campaignId: string): Promise<Array<{ id: string; name: string; urls: string[] }>> {
    const rows = await client.searchStream(cid,
      `SELECT asset_group.id, asset_group.name, asset_group.final_urls, asset_group.status
       FROM asset_group
       WHERE campaign.id = ${campaignId}
         AND asset_group.status != 'REMOVED'`);
    return rows.map((row) => {
      const group = asObj(row.assetGroup);
      return { id: str(group.id), name: str(group.name), urls: ((group.finalUrls as unknown[]) ?? []).map(String) };
    });
  }

  const normUrl = (url: string) =>
    url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

  mcp.registerTool(
    "get_pmax_automation_settings",
    {
      description: [
        "Mostra a automação de assets de uma campanha PMax e o que controla a expansão de URL final.",
        "READ OPERATION.",
        "",
        "Traz: cada tipo de automação (expansão de URL final, personalização de texto, melhoria de imagens,",
        "vídeos aprimorados, extração de imagens) com o valor explícito ou o padrão do PMax; as exclusões de URL",
        "(critérios WEBPAGE negativos); feeds de páginas vinculados; e as URLs finais dos grupos de recursos",
        "(que continuam veiculando mesmo se excluídas).",
        "Para alterar: set_pmax_asset_automation e set_pmax_url_exclusions.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
      },
    },
    async ({ customerId, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const client = ctx.getClient();
      const campaign = await loadCampaign(client, cid, campaignId.trim(), ["campaign.asset_automation_settings"]);
      const problem = pmaxCampaignProblem(campaign, campaignId, cid);
      if (problem) return fail(problem);
      const [exclusions, pageFeeds, finalUrls] = await Promise.all([
        loadUrlExclusions(client, cid, campaignId.trim()),
        loadPageFeeds(client, cid, campaignId.trim()),
        loadCampaignFinalUrls(client, cid, campaignId.trim()),
      ]);
      const automation = automationState(campaign!);
      const fue = automation.find((item) => item.key === "finalUrlExpansion")!;
      const notes: string[] = [];
      if (fue.explicit === "OPTED_OUT" && exclusions.length) notes.push("A expansão de URL final está desligada: as exclusões de URL não têm efeito enquanto ela estiver desligada.");
      if (pageFeeds.length) notes.push("Há feed de páginas vinculado: a personalização de texto não pode ser desligada sem remover o feed antes.");
      return ok(`Campanha ${campaignId} ("${str(campaign!.name)}") — automação de assets PMax.\n\n` + formatJson({
        automation: automation.map((item) => ({ type: item.type, label: item.label, explicit: item.explicit ?? null, effective: item.effective })),
        url_exclusions: exclusions.map((item) => ({ criterion_id: item.criterionId, name: item.name, conditions: item.conditions })),
        page_feeds: pageFeeds,
        asset_group_final_urls: finalUrls,
        notes,
      }));
    }
  );

  mcp.registerTool(
    "set_pmax_asset_automation",
    {
      description: [
        "Liga/desliga a automação de assets de uma campanha Performance Max.",
        "WRITE OPERATION — altera só Campaign.asset_automation_settings; não mexe em orçamento, lances nem segmentação.",
        "",
        "- finalUrlExpansion: expansão de URL final (FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION). Padrão do PMax: ligada.",
        "- textCustomization: personalização de texto (TEXT_ASSET_AUTOMATION). Não pode ser desligada com a",
        "  expansão de URL ligada nem com feed de páginas vinculado (remova o feed antes).",
        "- imageEnhancement: melhoria de imagens (GENERATE_IMAGE_ENHANCEMENT).",
        "- enhancedVideos: vídeos aprimorados (GENERATE_ENHANCED_YOUTUBE_VIDEOS).",
        "- imageExtraction: extração de imagens da página (GENERATE_IMAGE_EXTRACTION).",
        "",
        "Lê o estado atual, junta com o pedido e reenvia a lista inteira (o campo é repetido). Valor igual ao",
        "atual não é reenviado. Para Pesquisa/Shopping use set_ai_max_settings.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
        finalUrlExpansion: z.boolean().optional().describe("true = OPTED_IN, false = OPTED_OUT."),
        textCustomization: z.boolean().optional().describe("true = OPTED_IN, false = OPTED_OUT."),
        imageEnhancement: z.boolean().optional().describe("true = OPTED_IN, false = OPTED_OUT."),
        enhancedVideos: z.boolean().optional().describe("true = OPTED_IN, false = OPTED_OUT."),
        imageExtraction: z.boolean().optional().describe("true = OPTED_IN, false = OPTED_OUT."),
      },
    },
    async (args) => {
      const { customerId, campaignId } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`);
      const requested = PMAX_AUTOMATION.filter((item) => args[item.key] !== undefined);
      if (requested.length === 0) {
        return fail("Informe ao menos um ajuste: finalUrlExpansion, textCustomization, imageEnhancement, enhancedVideos ou imageExtraction.");
      }
      const client = ctx.getClient();
      const id = campaignId.trim();
      const campaign = await loadCampaign(client, cid, id, ["campaign.asset_automation_settings"]);
      const problem = pmaxCampaignProblem(campaign, id, cid);
      if (problem) return fail(`${problem} Nada foi alterado.`);
      const current = automationState(campaign!);
      const campaignLine = `Campanha ${id} ("${str(campaign!.name)}")`;

      const statusOf = (value: boolean) => (value ? "OPTED_IN" : "OPTED_OUT");
      const effectiveAfter = (key: AutomationKey) => {
        const value = args[key];
        if (value !== undefined) return statusOf(value);
        const item = current.find((entry) => entry.key === key)!;
        return item.explicit ?? PMAX_AUTOMATION.find((entry) => entry.key === key)!.pmaxDefault;
      };
      if (args.textCustomization === false) {
        if (effectiveAfter("finalUrlExpansion") === "OPTED_IN") {
          return fail(`${campaignLine}: a personalização de texto não pode ser desligada com a expansão de URL final ligada ` +
            "(a expansão também gera textos). Envie finalUrlExpansion: false junto. Nada foi alterado.");
        }
        const pageFeeds = await loadPageFeeds(client, cid, id);
        if (pageFeeds.length > 0) {
          return fail(`${campaignLine}: há feed de páginas vinculado (${pageFeeds.map((feed) => `"${feed.asset_set_name}"`).join(", ")}). ` +
            "A API exige remover o CampaignAssetSet PAGE_FEED antes de desligar a personalização de texto " +
            "(senão OPERATION_NOT_PERMITTED_FOR_CONTEXT). Nada foi alterado.\n\n" + formatJson(pageFeeds));
        }
      }

      let settings = asRows(campaign!.assetAutomationSettings).map((setting) => ({
        assetAutomationType: str(setting.assetAutomationType),
        assetAutomationStatus: str(setting.assetAutomationStatus),
      }));
      const changes: Row[] = [];
      const unchanged: string[] = [];
      for (const item of requested) {
        const status = statusOf(args[item.key]!);
        const before = current.find((entry) => entry.key === item.key)!;
        if (before.explicit === status) {
          unchanged.push(`${item.label} (${status})`);
          continue;
        }
        settings = settings.filter((setting) => setting.assetAutomationType !== item.type)
          .concat([{ assetAutomationType: item.type, assetAutomationStatus: status }]);
        changes.push({ setting: item.label, type: item.type, before: before.explicit ?? before.effective, after: status });
      }
      const warnings: string[] = [];
      if (args.finalUrlExpansion === true && effectiveAfter("textCustomization") === "OPTED_OUT") {
        warnings.push("Ligar a expansão de URL final também liga a geração de textos: não há expansão sem personalização de texto.");
      }
      if (changes.length === 0) {
        return ok(`${campaignLine}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n` +
          formatJson({ unchanged, current: current.map((item) => ({ type: item.type, effective: item.effective })) }));
      }
      const dryRun = client.isDryRun;
      try {
        await client.mutateCampaigns(cid, [{
          update: { resourceName: `customers/${cid}/campaigns/${id}`, assetAutomationSettings: settings },
          updateMask: "asset_automation_settings",
        }]);
      } catch (err) {
        return fail(`${campaignLine}: a API recusou a alteração — nada foi gravado.\nErro: ${explainApiError(errorMessage(err))}\n\n` +
          formatJson({ attempted: changes }));
      }
      return ok(`${campaignLine} — ${dryRunHeader(dryRun, `${changes.length} ajuste(s) gravado(s).`)}\n\n` +
        formatJson({ changes, unchanged, warnings, update_mask: "asset_automation_settings", sent: settings }));
    }
  );

  mcp.registerTool(
    "set_pmax_url_exclusions",
    {
      description: [
        "Gerencia as exclusões de URL da expansão de URL final de uma campanha PMax (critérios WEBPAGE negativos).",
        "WRITE OPERATION.",
        "",
        "- rules: [{operator: EQUALS|CONTAINS, url}] — ex.: {operator: \"CONTAINS\", url: \"/blog\"}, {operator:",
        "  \"EQUALS\", url: \"https://site.com/politica-de-privacidade\"}. Uma exclusão por regra.",
        "- customLabels: rótulos personalizados do feed de páginas a excluir.",
        "- removeCriterionIds: remove exclusões pelo criterion_id (veja get_pmax_automation_settings).",
        "- replace: true remove as exclusões atuais que não estiverem em rules/customLabels.",
        "Remoção reabre o tráfego para aquelas páginas: exige confirm: true.",
        "Pedir a mesma regra em rules/customLabels e remover, em removeCriterionIds, a exclusão que já a aplica é",
        "contraditório: a chamada é recusada sem enviar nada.",
        "",
        "A URL final de um grupo de recursos não pode ser excluída (regra do Google — ela continua veiculando):",
        "EQUALS igual a uma URL final é recusado aqui. As exclusões só têm efeito com a expansão de URL ligada.",
        "Regras de título/conteúdo de página são legadas e não são criadas aqui.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
        rules: flexArray(z.object({
          operator: z.enum(["EQUALS", "CONTAINS"]).optional().describe("EQUALS (URL exata) ou CONTAINS (trecho). Padrão: CONTAINS."),
          url: z.string().describe("URL completa (EQUALS) ou trecho da URL (CONTAINS)."),
        })).optional().describe("Regras de URL a excluir."),
        customLabels: flexArray(z.string()).optional().describe("Rótulos personalizados (custom label) do feed de páginas a excluir."),
        removeCriterionIds: flexArray(z.string()).optional().describe("criterion_id das exclusões a remover."),
        replace: z.boolean().optional().describe("true = a lista informada vira a lista completa (remove as demais; exige confirm)."),
        confirm: z.boolean().optional().describe("Obrigatório quando alguma exclusão é removida."),
      },
    },
    async ({ customerId, campaignId, rules, customLabels, removeCriterionIds, replace, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`);
      const id = campaignId.trim();
      const problems: string[] = [];
      const wanted: Array<{ conditions: Array<{ operand: string; operator?: string; argument: string }>; label: string; key: string }> = [];
      const addWanted = (conditions: Array<{ operand: string; operator?: string; argument: string }>, label: string) => {
        const key = exclusionKey(conditions);
        if (!wanted.some((item) => item.key === key)) wanted.push({ conditions, label, key });
      };
      for (const entry of ensureArray<unknown>(rules)) {
        const rule = asObj(entry);
        const url = typeof rule.url === "string" ? rule.url.trim() : "";
        const operator = rule.operator === undefined ? "CONTAINS" : str(rule.operator).toUpperCase();
        if (!url) {
          problems.push(`rules: item sem url ${JSON.stringify(entry)}`);
          continue;
        }
        if (operator !== "EQUALS" && operator !== "CONTAINS") {
          problems.push(`rules: operator "${str(rule.operator)}" inválido (EQUALS ou CONTAINS)`);
          continue;
        }
        addWanted([{ operand: "URL", operator, argument: url }], `URL ${operator === "EQUALS" ? "igual a" : "contém"} ${url}`);
      }
      for (const entry of ensureArray<unknown>(customLabels)) {
        const label = typeof entry === "string" ? entry.trim() : "";
        if (!label) {
          problems.push(`customLabels: item inválido ${JSON.stringify(entry)}`);
          continue;
        }
        addWanted([{ operand: "CUSTOM_LABEL", argument: label }], `rótulo ${label}`);
      }
      const removeIds: string[] = [];
      for (const entry of ensureArray<unknown>(removeCriterionIds)) {
        const value = typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : "";
        if (!/^\d+$/.test(value)) problems.push(`removeCriterionIds: "${String(entry)}" não é numérico`);
        else if (!removeIds.includes(value)) removeIds.push(value);
      }
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);
      if (wanted.length === 0 && removeIds.length === 0 && !replace) {
        return fail("Informe rules, customLabels, removeCriterionIds ou replace: true.");
      }

      const client = ctx.getClient();
      const campaign = await loadCampaign(client, cid, id, ["campaign.asset_automation_settings"]);
      const problem = pmaxCampaignProblem(campaign, id, cid);
      if (problem) return fail(`${problem} Nada foi alterado.`);
      const [existing, finalUrls] = await Promise.all([loadUrlExclusions(client, cid, id), loadCampaignFinalUrls(client, cid, id)]);
      const campaignLine = `Campanha ${id} ("${str(campaign!.name)}")`;

      // Remoções explícitas primeiro: uma exclusão marcada para remoção não pode contar como "já excluída".
      const toRemove: Exclusion[] = [];
      const notFound: string[] = [];
      for (const removeId of removeIds) {
        const match = existing.find((exclusion) => exclusion.criterionId === removeId);
        if (match) toRemove.push(match);
        else notFound.push(removeId);
      }

      const refused: Row[] = [];
      const conflicts: Row[] = [];
      const warnings: string[] = [];
      const alreadyExcluded: Row[] = [];
      const toCreate: typeof wanted = [];
      for (const item of wanted) {
        const condition = item.conditions[0];
        if (condition.operand === "URL") {
          const target = normUrl(condition.argument);
          const hits = finalUrls.filter((group) => group.urls.some((url) =>
            condition.operator === "EQUALS" ? normUrl(url) === target : url.toLowerCase().includes(condition.argument.toLowerCase())));
          if (hits.length && condition.operator === "EQUALS") {
            refused.push({
              rule: item.label,
              reason: `é a URL final do(s) grupo(s) ${hits.map((group) => `${group.id} ("${group.name}")`).join(", ")} — a URL final de um grupo não pode ser excluída e continuaria veiculando`,
            });
            continue;
          }
          if (hits.length) {
            warnings.push(`"${item.label}" também casa com a URL final do(s) grupo(s) ${hits.map((group) => group.id).join(", ")}; ` +
              "a URL final continua veiculando — a regra só vale para as páginas da expansão.");
          }
        }
        // Só conta como já excluída uma exclusão que continua de pé (não está em removeCriterionIds).
        const match = existing.find((exclusion) => exclusion.key === item.key && !toRemove.includes(exclusion));
        if (match) {
          alreadyExcluded.push({ rule: item.label, criterion_id: match.criterionId });
          continue;
        }
        const removedMatch = toRemove.find((exclusion) => exclusion.key === item.key);
        if (removedMatch) {
          // Pedido contraditório: excluir a regra e remover a exclusão que já a aplica.
          conflicts.push({
            rule: item.label,
            criterion_id: removedMatch.criterionId,
            reason: `a regra já está excluída pelo critério ${removedMatch.criterionId}, que removeCriterionIds manda remover`,
          });
          continue;
        }
        toCreate.push(item);
      }
      if (replace) {
        for (const exclusion of existing) {
          if (!wanted.some((item) => item.key === exclusion.key) && !toRemove.includes(exclusion)) toRemove.push(exclusion);
        }
      }
      if (refused.length > 0 || conflicts.length > 0) {
        const reasons = [
          refused.length ? "regra(s) recusada(s)" : "",
          conflicts.length ? "pedido contraditório (a mesma exclusão aparece para manter e para remover)" : "",
        ].filter(Boolean).join(" e ");
        const hint = conflicts.length
          ? "\nPara manter a exclusão, tire o ID de removeCriterionIds; para removê-la, tire a regra de rules/customLabels."
          : "";
        return fail(`${campaignLine}: ${reasons} — nada foi alterado.${hint}\n\n` +
          formatJson({ ...(refused.length ? { refused } : {}), ...(conflicts.length ? { conflicts } : {}) }));
      }
      const automation = automationState(campaign!);
      if (automation.find((item) => item.key === "finalUrlExpansion")?.explicit === "OPTED_OUT" && toCreate.length) {
        warnings.push("A expansão de URL final está desligada nesta campanha: as exclusões só têm efeito com ela ligada (set_pmax_asset_automation).");
      }
      const plan = {
        create: toCreate.map((item) => ({ rule: item.label, conditions: item.conditions })),
        remove: toRemove.map((item) => ({ criterion_id: item.criterionId, name: item.name, conditions: item.conditions })),
      };
      if (toCreate.length === 0 && toRemove.length === 0) {
        return ok(`${campaignLine}: nada a mudar — nenhuma escrita foi enviada.\n\n` +
          formatJson({ already_excluded: alreadyExcluded, not_found: notFound, warnings }));
      }
      if (toRemove.length > 0 && !confirm) {
        return fail(`${campaignLine}: o plano remove ${toRemove.length} exclusão(ões) — as páginas voltam a receber tráfego da expansão. ` +
          "Repita com confirm: true. Nada foi enviado.\n\n" + formatJson({ plan, not_found: notFound, warnings }));
      }

      const campaignResource = `customers/${cid}/campaigns/${id}`;
      const operations: Array<{ op: MutateOperation; describe: Row }> = [
        ...toCreate.map((item) => ({
          op: {
            create: {
              campaign: campaignResource,
              negative: true,
              webpage: { criterionName: `Exclusão: ${item.label}`.slice(0, 255), conditions: item.conditions },
            },
          },
          describe: { action: "create", rule: item.label } as Row,
        })),
        ...toRemove.map((item) => ({
          op: { remove: item.resourceName || `customers/${cid}/campaignCriteria/${id}~${item.criterionId}` },
          describe: { action: "remove", criterion_id: item.criterionId, name: item.name } as Row,
        })),
      ];
      const dryRun = client.isDryRun;
      const applied: Row[] = [];
      const errors: Row[] = [];
      try {
        const response = await client.mutate(cid, "campaignCriteria", operations.map((item) => item.op), { partialFailure: true });
        perOperation(response, operations.length, dryRun).forEach((outcome, index) => {
          const entry = { ...operations[index].describe, ...(outcome.resourceName ? { resource_name: outcome.resourceName } : {}) };
          if (outcome.ok) applied.push(entry);
          else errors.push({ ...entry, error: outcome.error });
        });
      } catch (err) {
        return fail(`${campaignLine}: a API recusou — nada foi gravado.\nErro: ${explainApiError(errorMessage(err))}\n\n${formatJson({ plan })}`);
      }
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): nada foi gravado. Validadas: ${applied.length} | Com erro: ${errors.length}`
        : `${campaignLine} — aplicadas: ${applied.length} | Com erro: ${errors.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({
          [dryRun ? "validated" : "applied"]: applied,
          errors,
          already_excluded: alreadyExcluded,
          not_found: notFound,
          warnings,
        })}`)],
        ...(errors.length > 0 ? { isError: true } : {}),
      };
    }
  );

  mcp.registerTool(
    "list_url_expansion_assets",
    {
      description: [
        "Lista os textos gerados pela expansão de URL final (final_url_expansion_asset_view) de uma campanha:",
        "o texto, o tipo (título/descrição), a URL de destino escolhida pelo Google, o status e as métricas.",
        "READ OPERATION.",
        "",
        "Use para revisar o que o Google gerou; para tirar um asset: remove_auto_created_assets com asset_id + field_type.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha (PMax ou Pesquisa com AI Max)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const dateClause = buildDateClause(dateRange, days);
      const client = ctx.getClient();
      const target = await urlExpansionCampaignFilter(client, cid, campaignId.trim());
      if ("error" in target) return fail(target.error);
      // PMax só aceita o grupo de recursos e Pesquisa só o grupo de anúncios: a API recusa o outro
      // ("Cannot select ad group in the query" / "Cannot select asset group in the query")
      const groupFields = target.channel === PMAX
        ? "final_url_expansion_asset_view.asset_group, asset_group.name"
        : "final_url_expansion_asset_view.ad_group, ad_group.name";
      const rows = await client.searchStream(cid,
        `SELECT final_url_expansion_asset_view.asset, final_url_expansion_asset_view.field_type,
                final_url_expansion_asset_view.final_url, final_url_expansion_asset_view.status, ${groupFields},
                asset.id, asset.type, asset.text_asset.text,
                metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
         FROM final_url_expansion_asset_view
         WHERE ${target.where}
           AND ${dateClause}
         ORDER BY metrics.impressions DESC`);
      const agg = new Map<string, Row>();
      for (const row of rows) {
        const view = asObj(row.finalUrlExpansionAssetView);
        const asset = asObj(row.asset);
        const metrics = asObj(row.metrics);
        const assetId = str(asset.id) || lastSegment(view.asset);
        const key = `${assetId}|${str(view.fieldType)}|${str(view.finalUrl)}`;
        const entry = agg.get(key) ?? {
          asset_id: assetId,
          field_type: str(view.fieldType),
          text: str(asObj(asset.textAsset).text),
          final_url: str(view.finalUrl),
          status: str(view.status),
          asset_group: str(asObj(row.assetGroup).name) || lastSegment(view.assetGroup) || "",
          ad_group: str(asObj(row.adGroup).name) || lastSegment(view.adGroup),
          impressions: 0,
          clicks: 0,
          spend: 0,
          conversions: 0,
          conversions_value: 0,
        };
        entry.impressions = num(entry.impressions) + num(metrics.impressions);
        entry.clicks = num(entry.clicks) + num(metrics.clicks);
        entry.spend = round2(num(entry.spend) + microsToMoney(metrics.costMicros));
        entry.conversions = round2(num(entry.conversions) + num(metrics.conversions));
        entry.conversions_value = round2(num(entry.conversions_value) + num(metrics.conversionsValue));
        agg.set(key, entry);
      }
      const list = [...agg.values()].sort((a, b) => num(b.impressions) - num(a.impressions));
      if (format === "table") return ok(formatAsTable(list));
      if (format === "csv") return ok(formatAsCsv(list));
      return ok(`${list.length} asset(s) gerado(s) pela expansão de URL final na campanha ${campaignId}.\n\n${formatJson(list)}`);
    }
  );

  mcp.registerTool(
    "remove_auto_created_assets",
    {
      description: [
        "Remove de uma campanha textos gerados automaticamente pela expansão de URL final",
        "(AutomaticallyCreatedAssetRemovalService.RemoveCampaignAutomaticallyCreatedAsset).",
        "WRITE OPERATION — irreversível pela API (asset gerado não pode ser recriado nem revinculado): exige confirm: true.",
        "",
        "items: [{assetId, fieldType}] tirados de list_url_expansion_assets. Cada item é conferido na campanha antes;",
        "os que não aparecem lá não são enviados. Partial failure: cada item volta com o próprio resultado.",
        "Este endpoint não aceita validate_only: com validateOnly/dry-run a tool só mostra o plano, sem enviar.",
        "Para parar de gerar novos textos: set_pmax_asset_automation (finalUrlExpansion: false).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha."),
        items: flexArray(z.object({
          assetId: z.string().describe("ID do asset (asset_id em list_url_expansion_assets)."),
          fieldType: z.string().describe("Field type (ex.: HEADLINE, DESCRIPTION)."),
        })).describe("Assets a remover."),
        confirm: z.boolean().optional().describe("Obrigatório: a remoção não tem volta."),
      },
    },
    async ({ customerId, campaignId, items, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi removido.`);
      const id = campaignId.trim();
      const problems: string[] = [];
      const wanted: Array<{ assetId: string; fieldType: string }> = [];
      for (const entry of ensureArray<unknown>(items)) {
        const item = asObj(entry);
        const assetId = str(item.assetId).trim();
        const fieldType = str(item.fieldType).trim().toUpperCase();
        if (!/^\d+$/.test(assetId)) {
          problems.push(`assetId inválido em ${JSON.stringify(entry)}`);
          continue;
        }
        if (!ASSET_FIELD_TYPES.has(fieldType)) {
          problems.push(`fieldType "${str(item.fieldType)}" não existe no AssetFieldType da v25`);
          continue;
        }
        if (!wanted.some((w) => w.assetId === assetId && w.fieldType === fieldType)) wanted.push({ assetId, fieldType });
      }
      if (problems.length > 0) return fail(`Nada foi removido:\n- ${problems.join("\n- ")}`);
      if (wanted.length === 0) return fail("Informe items: [{assetId, fieldType}].");
      if (wanted.length > 1000) return fail(`${wanted.length} itens (máx. 1000 por chamada).`);

      const client = ctx.getClient();
      const target = await urlExpansionCampaignFilter(client, cid, id);
      if ("error" in target) return fail(`${target.error} Nada foi removido.`);
      const { campaign } = target;
      const rows = await client.searchStream(cid,
        `SELECT final_url_expansion_asset_view.asset, final_url_expansion_asset_view.field_type,
                final_url_expansion_asset_view.status, final_url_expansion_asset_view.final_url,
                asset.id, asset.text_asset.text
         FROM final_url_expansion_asset_view
         WHERE ${target.where}
           AND asset.id IN (${[...new Set(wanted.map((w) => w.assetId))].join(", ")})`);
      const known = new Map<string, Row>();
      for (const row of rows) {
        const view = asObj(row.finalUrlExpansionAssetView);
        const assetId = str(asObj(row.asset).id) || lastSegment(view.asset);
        known.set(`${assetId}|${str(view.fieldType)}`, { text: str(asObj(asObj(row.asset).textAsset).text), status: str(view.status) });
      }
      const toRemove = wanted.filter((w) => known.has(`${w.assetId}|${w.fieldType}`));
      const notFound = wanted.filter((w) => !known.has(`${w.assetId}|${w.fieldType}`))
        .map((w) => ({ ...w, reason: "não aparece como asset gerado pela expansão de URL nesta campanha" }));
      const campaignLine = `Campanha ${id} ("${str(campaign.name)}")`;
      const plan = toRemove.map((w) => ({ ...w, text: known.get(`${w.assetId}|${w.fieldType}`)!.text }));
      if (toRemove.length === 0) {
        return fail(`${campaignLine}: nenhum dos itens é um asset gerado desta campanha — nada foi enviado.\n\n${formatJson({ not_found: notFound })}`);
      }
      if (!confirm) {
        return fail(`${campaignLine}: a remoção é irreversível. Revise e repita com confirm: true. Nada foi enviado.\n\n` +
          formatJson({ plan, not_found: notFound }));
      }
      if (client.isDryRun) {
        return fail(`${campaignLine}: RemoveCampaignAutomaticallyCreatedAsset não aceita validate_only — em validateOnly/dry-run ` +
          "nada é enviado. A checagem local passou (itens existem na campanha); rode sem validateOnly para remover.\n\n" +
          formatJson({ plan, not_found: notFound }));
      }
      const campaignResource = `customers/${cid}/campaigns/${id}`;
      const operations = toRemove.map((w) => ({ campaign: campaignResource, asset: `customers/${cid}/assets/${w.assetId}`, fieldType: w.fieldType }));
      let response: Row;
      try {
        response = await client.customerWriteAction(cid, ":removeCampaignAutomaticallyCreatedAsset", { operations, partialFailure: true });
      } catch (err) {
        return fail(`${campaignLine}: a API recusou — nada foi removido.\nErro: ${explainApiError(errorMessage(err))}\n\n${formatJson({ plan })}`);
      }
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, operations.length);
      const removed: Row[] = [];
      const errors: Row[] = [];
      plan.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...item, error: explainApiError(opErrors.join("; ")) });
        else if (unattributed.length) errors.push({ ...item, error: `resultado incerto: ${unattributed.join("; ")}` });
        else removed.push(item);
      });
      return {
        content: [text(`${campaignLine} — removidos: ${removed.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ removed, errors, not_found: notFound }))],
        ...(errors.length > 0 ? { isError: true } : {}),
      };
    }
  );

  // ════════════════════════ Diretrizes de marca ════════════════════════

  interface BrandLink {
    resourceName: string;
    assetId: string;
    fieldType: string;
    status: string;
    source: string;
    primaryStatus: string;
    asset: AssetInfo;
  }

  async function loadBrandLinks(client: GoogleAdsClient, cid: string, campaignId: string): Promise<BrandLink[]> {
    const rows = await client.searchStream(cid,
      `SELECT campaign_asset.resource_name, campaign_asset.asset, campaign_asset.field_type, campaign_asset.status,
              campaign_asset.source, campaign_asset.primary_status, asset.id, asset.name, asset.type,
              asset.text_asset.text, asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels,
              asset.image_asset.full_size.height_pixels
       FROM campaign_asset
       WHERE campaign_asset.campaign = 'customers/${cid}/campaigns/${campaignId}'
         AND campaign_asset.field_type IN ('BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO')
         AND campaign_asset.status != 'REMOVED'`);
    return rows.map((row) => {
      const link = asObj(row.campaignAsset);
      const asset = toAssetInfo(asObj(row.asset));
      return {
        resourceName: str(link.resourceName),
        assetId: asset.id || lastSegment(link.asset),
        fieldType: str(link.fieldType),
        status: str(link.status),
        source: str(link.source),
        primaryStatus: str(link.primaryStatus),
        asset,
      };
    });
  }

  const brandLinkView = (link: BrandLink) => ({
    field_type: link.fieldType,
    asset_id: link.assetId,
    content: assetContent(link.asset),
    ...(link.asset.width ? { size: `${link.asset.width}x${link.asset.height}` } : {}),
    status: link.status,
    primary_status: link.primaryStatus || undefined,
  });

  function validateColorsAndFont(input: { mainColor?: string; accentColor?: string; fontFamily?: string }, problems: string[]): void {
    for (const [label, value] of [["mainColor", input.mainColor], ["accentColor", input.accentColor]] as const) {
      if (value !== undefined && value !== "" && !HEX_COLOR.test(value.trim())) problems.push(`${label} "${value}" inválida — use hex #RRGGBB (ex.: #00ff00)`);
    }
    if (input.fontFamily !== undefined && input.fontFamily !== "" && !BRAND_FONTS.includes(input.fontFamily.trim())) {
      problems.push(`fontFamily "${input.fontFamily}" não aceita — use exatamente uma de: ${BRAND_FONTS.join(", ")}`);
    }
  }

  /** Confere tipo e proporção dos assets de marca (logo 1:1, logo paisagem 4:1, nome = TEXT até 25). */
  function brandAssetProblem(asset: AssetInfo | undefined, id: string, fieldType: string): string | null {
    if (!asset) return `asset ${id} não encontrado na conta`;
    if (fieldType === "BUSINESS_NAME") {
      if (asset.type !== "TEXT") return `asset ${id} é ${asset.type}, e o nome da empresa precisa ser TEXT`;
      if ((asset.text ?? "").length > MAX_BUSINESS_NAME_CHARS) return `nome da empresa "${asset.text}" passa de ${MAX_BUSINESS_NAME_CHARS} caracteres`;
      return null;
    }
    if (asset.type !== "IMAGE") return `asset ${id} é ${asset.type}, e ${fieldType} precisa ser IMAGE`;
    if (asset.width && asset.height) {
      const ratio = asset.width / asset.height;
      const expected = fieldType === "LOGO" ? 1 : 4;
      if (Math.abs(ratio - expected) / expected > 0.02) {
        return `asset ${id} tem ${asset.width}x${asset.height} — ${fieldType} exige proporção ${fieldType === "LOGO" ? "1:1" : "4:1"}`;
      }
    }
    return null;
  }

  mcp.registerTool(
    "get_pmax_brand_settings",
    {
      description: [
        "Mostra as diretrizes de marca de uma campanha PMax: se estão ativas, cores, fonte, nome da empresa e",
        "logotipos vinculados no nível da campanha, com as regras (1 nome, 1+ logo quadrado, até 5 logos).",
        "READ OPERATION.",
        "",
        "Em campanha antiga (sem diretrizes), lista os nomes/logos que hoje estão nos grupos de recursos —",
        "é o que enable_pmax_brand_guidelines pode usar na migração.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
      },
    },
    async ({ customerId, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const id = campaignId.trim();
      const client = ctx.getClient();
      const campaign = await loadCampaign(client, cid, id, [
        "campaign.brand_guidelines_enabled",
        "campaign.brand_guidelines.main_color",
        "campaign.brand_guidelines.accent_color",
        "campaign.brand_guidelines.predefined_font_family",
      ]);
      const problem = pmaxCampaignProblem(campaign, id, cid);
      if (problem) return fail(problem);
      const enabled = campaign!.brandGuidelinesEnabled === true;
      const guidelines = asObj(campaign!.brandGuidelines);
      const links = await loadBrandLinks(client, cid, id);
      const count = (type: string) => links.filter((link) => link.fieldType === type).length;
      const checks = enabled
        ? {
            business_name: `${count("BUSINESS_NAME")} (exige exatamente 1)`,
            logo: `${count("LOGO")} (exige ao menos 1)`,
            total_logos: `${count("LOGO") + count("LANDSCAPE_LOGO")} (máx. ${MAX_BRAND_LOGOS})`,
          }
        : undefined;
      const report: Row = {
        campaign: { id, name: str(campaign!.name), status: str(campaign!.status) },
        brand_guidelines_enabled: enabled,
        colors: { main_color: str(guidelines.mainColor) || null, accent_color: str(guidelines.accentColor) || null },
        font: str(guidelines.predefinedFontFamily) || null,
        campaign_brand_assets: links.map(brandLinkView),
        ...(checks ? { checks } : {}),
      };
      if (!enabled) {
        const groupRows = await client.searchStream(cid,
          `SELECT asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, asset_group.id,
                  asset_group.name, asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url
           FROM asset_group_asset
           WHERE campaign.id = ${id}
             AND asset_group_asset.field_type IN ('BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO')
             AND asset_group_asset.status != 'REMOVED'`);
        const distinct = new Map<string, Row>();
        for (const row of groupRows) {
          const asset = toAssetInfo(asObj(row.asset));
          const fieldType = str(asObj(row.assetGroupAsset).fieldType);
          const key = `${asset.id}|${fieldType}`;
          const entry = distinct.get(key) ?? { field_type: fieldType, asset_id: asset.id, content: assetContent(asset), asset_groups: [] as string[] };
          (entry.asset_groups as string[]).push(str(asObj(row.assetGroup).id));
          distinct.set(key, entry);
        }
        report.asset_group_brand_assets = [...distinct.values()];
        report.next_step = "Diretrizes de marca desligadas: migre com enable_pmax_brand_guidelines (autoPopulateBrandAssets ou os assets acima).";
      }
      return ok(`Campanha ${id} ("${str(campaign!.name)}") — diretrizes de marca ${enabled ? "ATIVAS" : "DESLIGADAS"}.\n\n${formatJson(report)}`);
    }
  );

  mcp.registerTool(
    "enable_pmax_brand_guidelines",
    {
      description: [
        "Migra campanhas PMax existentes para diretrizes de marca (CampaignService.EnablePMaxBrandGuidelines).",
        "WRITE OPERATION — IRREVERSÍVEL (a API não desliga diretrizes de marca): exige confirm: true.",
        "",
        "Até 10 campanhas por chamada. Escolha UM modo:",
        "- autoPopulateBrandAssets: true — o Google escolhe os melhores nome/logos da campanha;",
        "- ou businessNameAsset + logoAssets (+ landscapeLogoAssets): exatamente 1 nome, 1+ logo quadrado, até 5 logos.",
        "Opcional: finalUriDomain, mainColor + accentColor (hex, os dois juntos) e fontFamily.",
        "",
        "Confere antes: campanha existe, é PMax, não está removida e ainda não tem diretrizes (essas são puladas).",
        "O endpoint não aceita validate_only: com validateOnly/dry-run a tool só mostra o plano.",
        "Resultado por campanha (uma pode falhar e as outras seguirem).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignIds: flexArray(z.string()).describe("IDs das campanhas PMax (até 10)."),
        autoPopulateBrandAssets: z.boolean().optional().describe("true = o Google escolhe nome e logos; não combine com os assets."),
        businessNameAsset: z.string().optional().describe("Asset TEXT do nome da empresa (ID ou resource name)."),
        logoAssets: flexArray(z.string()).optional().describe("Logos quadrados 1:1 (ID ou resource name)."),
        landscapeLogoAssets: flexArray(z.string()).optional().describe("Logos paisagem 4:1 (ID ou resource name)."),
        finalUriDomain: z.string().optional().describe("Domínio da URL final (ex.: loja.com.br)."),
        mainColor: z.string().optional().describe("Cor principal em hex (#RRGGBB); exige accentColor."),
        accentColor: z.string().optional().describe("Cor de destaque em hex (#RRGGBB); exige mainColor."),
        fontFamily: z.string().optional().describe(`Fonte: ${BRAND_FONTS.join(", ")}.`),
        confirm: z.boolean().optional().describe("Obrigatório: a migração não tem volta."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi alterado.`);
      const problems: string[] = [];
      const campaignIds: string[] = [];
      for (const entry of ensureArray<unknown>(args.campaignIds)) {
        const value = typeof entry === "string" || typeof entry === "number" ? String(entry).trim() : "";
        if (!/^\d+$/.test(value)) problems.push(`campaignIds: "${String(entry)}" não é numérico`);
        else if (!campaignIds.includes(value)) campaignIds.push(value);
      }
      if (campaignIds.length === 0) problems.push("informe ao menos uma campanha em campaignIds");
      if (campaignIds.length > MAX_ENABLE_BRAND_OPS) problems.push(`${campaignIds.length} campanhas (máx. ${MAX_ENABLE_BRAND_OPS} por chamada)`);
      const businessName = args.businessNameAsset !== undefined ? parseRef(args.businessNameAsset, cid, "assets") : undefined;
      if (businessName && "error" in businessName) problems.push(`businessNameAsset: ${businessName.error}`);
      const logos = collectRefs(args.logoAssets, cid, "assets", "logoAssets", problems);
      const landscapeLogos = collectRefs(args.landscapeLogoAssets, cid, "assets", "landscapeLogoAssets", problems);
      const manual = businessName !== undefined || logos.length > 0 || landscapeLogos.length > 0;
      if (args.autoPopulateBrandAssets && manual) {
        problems.push("use autoPopulateBrandAssets OU os assets (businessNameAsset/logoAssets) — a API recusa os dois juntos");
      }
      if (!args.autoPopulateBrandAssets) {
        if (!businessName) problems.push("sem autoPopulateBrandAssets, businessNameAsset é obrigatório");
        if (logos.length === 0) problems.push("sem autoPopulateBrandAssets, informe ao menos um logo quadrado em logoAssets");
      }
      if (logos.length + landscapeLogos.length > MAX_BRAND_LOGOS) {
        problems.push(`${logos.length + landscapeLogos.length} logos (máx. ${MAX_BRAND_LOGOS} somando LOGO e LANDSCAPE_LOGO)`);
      }
      if ((args.mainColor === undefined) !== (args.accentColor === undefined)) problems.push("mainColor e accentColor vão juntas (regra da API)");
      validateColorsAndFont(args, problems);
      let domain: string | undefined;
      if (args.finalUriDomain !== undefined) {
        const raw = args.finalUriDomain.trim();
        try {
          domain = /^https?:\/\//i.test(raw) ? new URL(raw).hostname : raw.replace(/\/.*$/, "");
        } catch {
          domain = undefined;
        }
        if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) problems.push(`finalUriDomain "${args.finalUriDomain}" não é um domínio (ex.: loja.com.br)`);
      }
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const campaignRows = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.brand_guidelines_enabled
         FROM campaign
         WHERE campaign.id IN (${campaignIds.join(", ")})`);
      const campaigns = new Map(campaignRows.map((row) => [str(asObj(row.campaign).id), asObj(row.campaign)]));
      const skipped: Row[] = [];
      const eligible: Row[] = [];
      for (const campaignId of campaignIds) {
        const campaign = campaigns.get(campaignId) ?? null;
        const problem = pmaxCampaignProblem(campaign, campaignId, cid);
        if (problem) skipped.push({ campaign_id: campaignId, reason: problem });
        else if (campaign!.brandGuidelinesEnabled === true) skipped.push({ campaign_id: campaignId, name: str(campaign!.name), reason: "diretrizes de marca já ativas" });
        else eligible.push(campaign!);
      }
      if (manual) {
        const assets = await loadAssetsById(client, cid, [
          ...(businessName && !("error" in businessName) ? [businessName.id] : []),
          ...logos.map(lastSegment),
          ...landscapeLogos.map(lastSegment),
        ]);
        const assetProblems = [
          ...(businessName && !("error" in businessName) ? [brandAssetProblem(assets.get(businessName.id), businessName.id, "BUSINESS_NAME")] : []),
          ...logos.map((rn) => brandAssetProblem(assets.get(lastSegment(rn)), lastSegment(rn), "LOGO")),
          ...landscapeLogos.map((rn) => brandAssetProblem(assets.get(lastSegment(rn)), lastSegment(rn), "LANDSCAPE_LOGO")),
        ].filter((item): item is string => !!item);
        if (assetProblems.length) return fail(`Assets de marca inválidos — nada foi alterado:\n- ${assetProblems.join("\n- ")}`);
      }
      if (eligible.length === 0) {
        return ok(`Nenhuma campanha para migrar — nenhuma escrita foi enviada.\n\n${formatJson({ skipped })}`);
      }
      const operations = eligible.map((campaign) => {
        const operation: Row = {
          campaign: `customers/${cid}/campaigns/${str(campaign.id)}`,
          autoPopulateBrandAssets: args.autoPopulateBrandAssets === true,
        };
        if (manual && businessName && !("error" in businessName)) {
          operation.brandAssets = {
            businessNameAsset: businessName.resourceName,
            logoAsset: logos,
            ...(landscapeLogos.length ? { landscapeLogoAsset: landscapeLogos } : {}),
          };
        }
        if (domain) operation.finalUriDomain = domain;
        if (args.mainColor) operation.mainColor = args.mainColor.trim();
        if (args.accentColor) operation.accentColor = args.accentColor.trim();
        if (args.fontFamily) operation.fontFamily = args.fontFamily.trim();
        return operation;
      });
      const plan = { campaigns: eligible.map((campaign) => ({ id: str(campaign.id), name: str(campaign.name) })), operations, skipped };
      if (!args.confirm) {
        return fail("A migração para diretrizes de marca é irreversível. Revise e repita com confirm: true. Nada foi enviado.\n\n" + formatJson(plan));
      }
      if (client.isDryRun) {
        return fail("EnablePMaxBrandGuidelines não aceita validate_only — em validateOnly/dry-run nada é enviado. " +
          "A checagem local passou; rode sem validateOnly para migrar.\n\n" + formatJson(plan));
      }
      let response: Row;
      try {
        response = await client.customerWriteAction(cid, "campaigns:enablePMaxBrandGuidelines", { operations });
      } catch (err) {
        return fail(`A API recusou a migração — nada foi alterado.\nErro: ${explainApiError(errorMessage(err))}\n\n${formatJson(plan)}`);
      }
      const results = asRows(response.results);
      const enabled: Row[] = [];
      const errors: Row[] = [];
      eligible.forEach((campaign, index) => {
        const resourceName = `customers/${cid}/campaigns/${str(campaign.id)}`;
        const result = results.find((item) => item.campaign === resourceName) ?? results[index];
        const error = asObj(result?.enablementError);
        const entry = { campaign_id: str(campaign.id), name: str(campaign.name) };
        // google.rpc.Status vazio (ou code 0) = sucesso
        const failed = (error.code !== undefined && num(error.code) !== 0) || !!error.message;
        if (!result) {
          errors.push({ ...entry, error: "a API não devolveu resultado para esta campanha — confira com get_pmax_brand_settings" });
        } else if (failed) {
          const details = asRows(error.details).flatMap((detail) => asRows(detail.errors))
            .map((item) => {
              const codes = Object.entries(asObj(item.errorCode)).map(([key, value]) => `${key}.${str(value)}`);
              return `${str(item.message)}${codes.length ? ` [${codes.join(", ")}]` : ""}`;
            })
            .filter(Boolean);
          errors.push({ ...entry, error: explainApiError([str(error.message), ...details].filter(Boolean).join(" — ")) });
        } else {
          enabled.push(entry);
        }
      });
      return {
        content: [text(`Diretrizes de marca — ativadas: ${enabled.length} | Com erro: ${errors.length} | Puladas: ${skipped.length}\n\n` +
          formatJson({ enabled, errors, skipped }) + "\n\nConfira com get_pmax_brand_settings.")],
        ...(errors.length > 0 ? { isError: true } : {}),
      };
    }
  );

  mcp.registerTool(
    "update_pmax_brand_assets",
    {
      description: [
        "Troca nome da empresa e logotipos de uma campanha PMax com diretrizes de marca, e ajusta cores e fonte.",
        "WRITE OPERATION — tudo numa chamada atômica (googleAds:mutate): adiciona antes de remover, então a",
        "campanha nunca fica abaixo do mínimo (1 nome, 1+ logo quadrado; máx. 5 logos).",
        "",
        "- businessNameAsset (ID/resource name de asset TEXT) ou businessNameText (até 25 caracteres; reaproveita",
        "  asset de texto igual ou cria um) — troca o nome atual.",
        "- addLogos / addLandscapeLogos e removeLogos / removeLandscapeLogos (IDs de asset).",
        "- mainColor + accentColor (hex, juntas; \"\" nas duas limpa) e fontFamily (\"\" limpa).",
        "Remoção ou troca exige confirm: true. Campanha sem diretrizes: use enable_pmax_brand_guidelines antes.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
        businessNameAsset: z.string().optional().describe("Novo nome da empresa: asset TEXT existente (ID ou resource name)."),
        businessNameText: z.string().optional().describe("Novo nome da empresa como texto (até 25 caracteres)."),
        addLogos: flexArray(z.string()).optional().describe("Logos quadrados (1:1) a vincular."),
        addLandscapeLogos: flexArray(z.string()).optional().describe("Logos paisagem (4:1) a vincular."),
        removeLogos: flexArray(z.string()).optional().describe("Logos quadrados a desvincular."),
        removeLandscapeLogos: flexArray(z.string()).optional().describe("Logos paisagem a desvincular."),
        mainColor: z.string().optional().describe("Cor principal #RRGGBB (com accentColor)."),
        accentColor: z.string().optional().describe("Cor de destaque #RRGGBB (com mainColor)."),
        fontFamily: z.string().optional().describe(`Fonte: ${BRAND_FONTS.join(", ")}.`),
        confirm: z.boolean().optional().describe("Obrigatório quando algo é removido ou trocado."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(args.customerId);
      if (!cid) return fail(`customerId inválido: "${args.customerId}". Nada foi alterado.`);
      if (!isId(args.campaignId)) return fail(`campaignId deve ser numérico, recebido "${args.campaignId}". Nada foi alterado.`);
      const id = args.campaignId.trim();
      const problems: string[] = [];
      if (args.businessNameAsset !== undefined && args.businessNameText !== undefined) problems.push("use businessNameAsset OU businessNameText");
      const bnRef = args.businessNameAsset !== undefined ? parseRef(args.businessNameAsset, cid, "assets") : undefined;
      if (bnRef && "error" in bnRef) problems.push(`businessNameAsset: ${bnRef.error}`);
      const bnText = args.businessNameText?.trim();
      if (args.businessNameText !== undefined && !bnText) problems.push("businessNameText vazio");
      if (bnText && bnText.length > MAX_BUSINESS_NAME_CHARS) problems.push(`businessNameText tem ${bnText.length} caracteres (máx. ${MAX_BUSINESS_NAME_CHARS})`);
      const addLogos = collectRefs(args.addLogos, cid, "assets", "addLogos", problems).map(lastSegment);
      const addLandscape = collectRefs(args.addLandscapeLogos, cid, "assets", "addLandscapeLogos", problems).map(lastSegment);
      const removeLogos = collectRefs(args.removeLogos, cid, "assets", "removeLogos", problems).map(lastSegment);
      const removeLandscape = collectRefs(args.removeLandscapeLogos, cid, "assets", "removeLandscapeLogos", problems).map(lastSegment);
      if (addLogos.some((a) => removeLogos.includes(a)) || addLandscape.some((a) => removeLandscape.includes(a))) {
        problems.push("o mesmo logo está em add e remove");
      }
      if ((args.mainColor === undefined) !== (args.accentColor === undefined)) problems.push("mainColor e accentColor vão juntas (regra da API)");
      if (args.mainColor !== undefined && args.accentColor !== undefined && (args.mainColor.trim() === "") !== (args.accentColor.trim() === "")) {
        problems.push("para limpar as cores, envie \"\" nas duas");
      }
      validateColorsAndFont(args, problems);
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);
      const nothing = !bnRef && !bnText && !addLogos.length && !addLandscape.length && !removeLogos.length && !removeLandscape.length &&
        args.mainColor === undefined && args.fontFamily === undefined;
      if (nothing) return fail("Informe ao menos uma mudança (nome da empresa, logos, cores ou fonte).");

      const client = ctx.getClient();
      const campaign = await loadCampaign(client, cid, id, [
        "campaign.brand_guidelines_enabled",
        "campaign.brand_guidelines.main_color",
        "campaign.brand_guidelines.accent_color",
        "campaign.brand_guidelines.predefined_font_family",
      ]);
      const problem = pmaxCampaignProblem(campaign, id, cid);
      if (problem) return fail(`${problem} Nada foi alterado.`);
      if (campaign!.brandGuidelinesEnabled !== true) {
        return fail(`Campanha ${id} ("${str(campaign!.name)}") não tem diretrizes de marca — nome e logos ficam nos grupos de recursos. ` +
          "Migre antes com enable_pmax_brand_guidelines. Nada foi alterado.");
      }
      const campaignLine = `Campanha ${id} ("${str(campaign!.name)}")`;
      const links = await loadBrandLinks(client, cid, id);
      const linked = (type: string) => links.filter((link) => link.fieldType === type);

      const creates: Array<{ assetId: string; fieldType: string }> = [];
      const removes: BrandLink[] = [];
      const unchanged: string[] = [];
      const notLinked: string[] = [];
      // Nome da empresa
      let newTextAsset: string | undefined;
      let bnTargetId: string | undefined;
      if (bnText) {
        const same = linked("BUSINESS_NAME").find((link) => (link.asset.text ?? "") === bnText);
        if (same) unchanged.push(`nome da empresa ("${bnText}")`);
        else {
          const existingText = await client.searchStream(cid,
            `SELECT asset.id, asset.text_asset.text FROM asset WHERE asset.type = 'TEXT' AND asset.text_asset.text = '${gaqlLiteral(bnText)}'`);
          bnTargetId = str(asObj(existingText[0]?.asset).id) || undefined;
          if (!bnTargetId) newTextAsset = bnText;
        }
      } else if (bnRef && !("error" in bnRef)) {
        if (linked("BUSINESS_NAME").some((link) => link.assetId === bnRef.id)) unchanged.push(`nome da empresa (asset ${bnRef.id})`);
        else bnTargetId = bnRef.id;
      }
      const swapBusinessName = !!bnTargetId || !!newTextAsset;
      if (bnTargetId) creates.push({ assetId: bnTargetId, fieldType: "BUSINESS_NAME" });
      if (swapBusinessName) removes.push(...linked("BUSINESS_NAME"));
      // Logos
      for (const [ids, type] of [[addLogos, "LOGO"], [addLandscape, "LANDSCAPE_LOGO"]] as const) {
        for (const assetId of ids) {
          if (linked(type).some((link) => link.assetId === assetId)) unchanged.push(`${type} ${assetId} (já vinculado)`);
          else creates.push({ assetId, fieldType: type });
        }
      }
      for (const [ids, type] of [[removeLogos, "LOGO"], [removeLandscape, "LANDSCAPE_LOGO"]] as const) {
        for (const assetId of ids) {
          const link = linked(type).find((item) => item.assetId === assetId);
          if (link) removes.push(link);
          else notLinked.push(`${type} ${assetId}`);
        }
      }
      if (notLinked.length) return fail(`${campaignLine}: não estão vinculados — nada foi alterado:\n- ${notLinked.join("\n- ")}`);

      // Assets novos: existem, tipo e proporção certos
      const assetIds = creates.map((item) => item.assetId);
      if (assetIds.length) {
        const assets = await loadAssetsById(client, cid, assetIds);
        const assetProblems = creates.map((item) => brandAssetProblem(assets.get(item.assetId), item.assetId, item.fieldType))
          .filter((item): item is string => !!item);
        if (assetProblems.length) return fail(`${campaignLine}: assets inválidos — nada foi alterado:\n- ${assetProblems.join("\n- ")}`);
      }

      // Contagem depois da mudança
      const after = (type: string) =>
        linked(type).filter((link) => !removes.includes(link)).length + creates.filter((item) => item.fieldType === type).length +
        (type === "BUSINESS_NAME" && newTextAsset ? 1 : 0);
      const countProblems: string[] = [];
      if (after("BUSINESS_NAME") !== 1) countProblems.push(`nome da empresa ficaria com ${after("BUSINESS_NAME")} (exige exatamente 1)`);
      if (after("LOGO") < 1) countProblems.push("nenhum logo quadrado (LOGO) restaria — exige ao menos 1");
      if (after("LOGO") + after("LANDSCAPE_LOGO") > MAX_BRAND_LOGOS) {
        countProblems.push(`${after("LOGO") + after("LANDSCAPE_LOGO")} logos no total (máx. ${MAX_BRAND_LOGOS})`);
      }
      if (countProblems.length) return fail(`${campaignLine}: a mudança quebraria as regras de marca — nada foi alterado:\n- ${countProblems.join("\n- ")}`);

      // Cores e fonte (folhas de brand_guidelines)
      const guidelines = asObj(campaign!.brandGuidelines);
      const guidelineUpdate: Row = {};
      const mask: string[] = [];
      const guidelineChanges: Row[] = [];
      if (args.mainColor !== undefined && args.accentColor !== undefined) {
        const main = args.mainColor.trim();
        const accent = args.accentColor.trim();
        if (main.toLowerCase() === str(guidelines.mainColor).toLowerCase() && accent.toLowerCase() === str(guidelines.accentColor).toLowerCase()) {
          unchanged.push("cores");
        } else {
          guidelineUpdate.mainColor = main;
          guidelineUpdate.accentColor = accent;
          mask.push("brand_guidelines.main_color", "brand_guidelines.accent_color");
          guidelineChanges.push({ setting: "cores", before: [str(guidelines.mainColor) || null, str(guidelines.accentColor) || null], after: [main || null, accent || null] });
        }
      }
      if (args.fontFamily !== undefined) {
        const font = args.fontFamily.trim();
        if (font === str(guidelines.predefinedFontFamily)) unchanged.push("fonte");
        else {
          guidelineUpdate.predefinedFontFamily = font;
          mask.push("brand_guidelines.predefined_font_family");
          guidelineChanges.push({ setting: "fonte", before: str(guidelines.predefinedFontFamily) || null, after: font || null });
        }
      }

      const plan = {
        link: [...(newTextAsset ? [{ field_type: "BUSINESS_NAME", new_text_asset: newTextAsset }] : []),
          ...creates.map((item) => ({ field_type: item.fieldType, asset_id: item.assetId }))],
        unlink: removes.map(brandLinkView),
        guidelines: guidelineChanges,
      };
      if (!plan.link.length && !removes.length && !mask.length) {
        return ok(`${campaignLine}: nada a mudar — nenhuma escrita foi enviada.\n\n${formatJson({ unchanged })}`);
      }
      if (removes.length && !args.confirm) {
        return fail(`${campaignLine}: o plano desvincula ${removes.length} asset(s) de marca. Revise e repita com confirm: true. Nada foi enviado.\n\n` +
          formatJson(plan));
      }

      const campaignResource = `customers/${cid}/campaigns/${id}`;
      const operations: Row[] = [];
      if (newTextAsset) {
        const temp = `customers/${cid}/assets/-1`;
        operations.push({ assetOperation: { create: { resourceName: temp, textAsset: { text: newTextAsset } } } });
        operations.push({ campaignAssetOperation: { create: { campaign: campaignResource, asset: temp, fieldType: "BUSINESS_NAME" } } });
      }
      for (const item of creates) {
        operations.push({
          campaignAssetOperation: { create: { campaign: campaignResource, asset: `customers/${cid}/assets/${item.assetId}`, fieldType: item.fieldType } },
        });
      }
      for (const link of removes) {
        operations.push({
          campaignAssetOperation: { remove: link.resourceName || `customers/${cid}/campaignAssets/${id}~${link.assetId}~${link.fieldType}` },
        });
      }
      if (mask.length) {
        operations.push({ campaignOperation: { update: { resourceName: campaignResource, brandGuidelines: guidelineUpdate }, updateMask: mask.join(",") } });
      }
      const dryRun = client.isDryRun;
      try {
        await client.batchMutate(cid, operations);
      } catch (err) {
        return fail(`${campaignLine}: a API recusou — nada foi alterado (chamada atômica).\nErro: ${explainApiError(errorMessage(err))}\n\n${formatJson(plan)}`);
      }
      return ok(`${campaignLine} — ${dryRunHeader(dryRun, "marca atualizada (chamada atômica).")}\n\n` +
        formatJson({ ...plan, unchanged, ...(mask.length ? { update_mask: mask.join(",") } : {}) }) +
        (dryRun ? "" : "\n\nConfira com get_pmax_brand_settings."));
    }
  );

  // ════════════════════════ Prévias e combinações ════════════════════════

  mcp.registerTool(
    "get_shareable_preview",
    {
      description: [
        "Gera links de prévia compartilháveis para aprovação do cliente (ShareablePreviewService).",
        "READ OPERATION — não altera a conta; gera URLs públicas com validade (expiration_date_time).",
        "",
        "- assetGroupIds: grupos de recursos Performance Max → prévia da interface do Google Ads (UI_PREVIEW).",
        "- adGroupAdIds: anúncios de vídeo/áudio do YouTube no formato \"adGroupId~adId\" → prévia no YouTube e",
        "  YouTube TV (YOUTUBE_LIVE_PREVIEW). RSA e display responsivo não têm prévia (UNSUPPORTED_AD_TYPE).",
        "Até 10 itens no total. A API não tem partial failure: um ID inválido derruba o pedido inteiro, por isso",
        "todos são conferidos na conta antes. Os links não abrem em iframe.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupIds: flexArray(z.string()).optional().describe("IDs de grupos de recursos PMax."),
        adGroupAdIds: flexArray(z.string()).optional().describe("Anúncios no formato adGroupId~adId (ou customers/{cid}/adGroupAds/{adGroupId}~{adId})."),
      },
    },
    async ({ customerId, assetGroupIds, adGroupAdIds }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const problems: string[] = [];
      const groupIds: string[] = [];
      for (const entry of ensureArray<unknown>(assetGroupIds)) {
        const parsed = parseRef(entry, cid, "assetGroups");
        if ("error" in parsed) problems.push(`assetGroupIds: ${parsed.error}`);
        else if (!groupIds.includes(parsed.id)) groupIds.push(parsed.id);
      }
      const adRefs: string[] = [];
      for (const entry of ensureArray<unknown>(adGroupAdIds)) {
        const value = typeof entry === "string" ? entry.trim() : "";
        const short = /^(\d+)~(\d+)$/.exec(value);
        const full = /^customers\/([\d-]+)\/adGroupAds\/(\d+)~(\d+)$/.exec(value);
        let rn: string | undefined;
        if (short) rn = `customers/${cid}/adGroupAds/${short[1]}~${short[2]}`;
        else if (full && full[1].replace(/-/g, "") === cid) rn = `customers/${cid}/adGroupAds/${full[2]}~${full[3]}`;
        if (!rn) problems.push(`adGroupAdIds: "${String(entry)}" inválido — use adGroupId~adId desta conta`);
        else if (!adRefs.includes(rn)) adRefs.push(rn);
      }
      if (groupIds.length + adRefs.length === 0) problems.push("informe assetGroupIds e/ou adGroupAdIds");
      if (groupIds.length + adRefs.length > MAX_PREVIEW_RESOURCES) {
        problems.push(`${groupIds.length + adRefs.length} itens (máx. ${MAX_PREVIEW_RESOURCES} por pedido, somando grupos e anúncios)`);
      }
      if (problems.length > 0) return fail(`Nada foi pedido:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const refused: string[] = [];
      const groups = await loadAssetGroups(client, cid, groupIds);
      for (const groupId of groupIds) {
        const group = groups.get(groupId);
        if (!group) refused.push(`grupo de recursos ${groupId} não existe na conta ${cid}`);
        else if (group.channel !== PMAX) refused.push(`grupo ${groupId} é de campanha ${group.channel}; a prévia UI_PREVIEW é só para Performance Max`);
      }
      if (adRefs.length) {
        const rows = await client.searchStream(cid,
          `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type,
                  ad_group.id, ad_group.name, campaign.id, campaign.advertising_channel_type
           FROM ad_group_ad
           WHERE ad_group_ad.resource_name IN (${adRefs.map((rn) => `'${rn}'`).join(", ")})`);
        const ads = new Map(rows.map((row) => [str(asObj(row.adGroupAd).resourceName), row]));
        for (const rn of adRefs) {
          const row = ads.get(rn);
          const type = str(asObj(asObj(asObj(row?.adGroupAd).ad)).type);
          if (!row) refused.push(`anúncio ${rn.split("/").pop()} não existe na conta ${cid}`);
          else if (!/VIDEO|AUDIO/.test(type)) refused.push(`anúncio ${rn.split("/").pop()} é ${type} — só formatos de vídeo/áudio do YouTube têm prévia`);
        }
      }
      if (refused.length) return fail(`Pedido recusado antes da API (sem partial failure, um item ruim derrubaria todos):\n- ${refused.join("\n- ")}`);

      const shareablePreviews = [
        ...groupIds.map((groupId) => ({ previewType: "UI_PREVIEW", assetGroup: groups.get(groupId)!.resourceName })),
        ...adRefs.map((rn) => ({ previewType: "YOUTUBE_LIVE_PREVIEW", adGroupAd: rn })),
      ];
      let response: Row;
      try {
        response = await client.customerAction(cid, ":generateShareablePreviews", { operation: { shareablePreviews } });
      } catch (err) {
        return fail(`A API recusou o pedido de prévia.\nErro: ${explainApiError(errorMessage(err))}`);
      }
      const previews = asRows(asObj(response.result).previews).map((preview) => {
        const ui = asObj(preview.uiPreviewResult);
        const youtube = asObj(preview.youtubeLivePreviewResult);
        return {
          asset_group: preview.assetGroup ? lastSegment(preview.assetGroup) : undefined,
          asset_group_name: preview.assetGroup ? groups.get(lastSegment(preview.assetGroup))?.name : undefined,
          ad_group_ad: preview.adGroupAd ? lastSegment(preview.adGroupAd) : undefined,
          preview_url: str(ui.shareablePreviewUrl) || undefined,
          youtube_preview_url: str(youtube.youtubePreviewUrl) || undefined,
          youtube_tv_preview_url: str(youtube.youtubeTvPreviewUrl) || undefined,
          expires_at: str(preview.expirationDateTime) || undefined,
        };
      });
      if (previews.length === 0) return fail(`A API não devolveu prévias.\n\n${formatJson(response)}`);
      return ok(`${previews.length} prévia(s) gerada(s). Os links são públicos para quem os tiver — compartilhe só com o cliente.\n\n${formatJson(previews)}`);
    }
  );

  mcp.registerTool(
    "get_pmax_top_combinations",
    {
      description: [
        "Mostra as combinações de assets que o Google mais veiculou juntas em cada grupo de recursos PMax",
        "(asset_group_top_combination_view), com cada asset resolvido para o texto, a URL da imagem ou o vídeo.",
        "READ OPERATION.",
        "",
        "Informe campaignId (todos os grupos) ou assetGroupId. Período opcional (dateRange ou days); sem ele,",
        "vale o padrão da API. Útil para montar novos grupos com as combinações que já funcionam.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("ID da campanha PMax."),
        assetGroupId: z.string().optional().describe("ID do grupo de recursos."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe("Dias para trás (opcional; sem dateRange nem days, sem filtro de data)."),
        limitPerGroup: z.number().optional().describe("Máximo de combinações por grupo. Padrão: 10."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, assetGroupId, dateRange, days, limitPerGroup, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!campaignId && !assetGroupId) return fail("Informe campaignId ou assetGroupId.");
      if (campaignId !== undefined && !isId(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      if (assetGroupId !== undefined && !isId(assetGroupId)) return fail(`assetGroupId deve ser numérico, recebido "${assetGroupId}".`);
      const limit = limitPerGroup === undefined ? 10 : Math.floor(limitPerGroup);
      if (!Number.isFinite(limit) || limit < 1) return fail(`limitPerGroup inválido: ${limitPerGroup}.`);
      const filters = [
        campaignId ? `campaign.id = ${campaignId.trim()}` : "",
        assetGroupId ? `asset_group.id = ${assetGroupId.trim()}` : "",
        dateRange || days !== undefined ? buildDateClause(dateRange, days) : "",
      ].filter(Boolean);
      const client = ctx.getClient();
      const rows = await client.searchStream(cid,
        `SELECT asset_group_top_combination_view.asset_group_top_combinations, asset_group.id, asset_group.name,
                asset_group.status, campaign.id, campaign.name
         FROM asset_group_top_combination_view
         WHERE ${filters.join(" AND ")}`);

      const assetIds = new Set<string>();
      const combos: Array<{ group: Row; campaign: Row; served: Row[][] }> = [];
      for (const row of rows) {
        const view = asObj(row.assetGroupTopCombinationView);
        const served = asRows(view.assetGroupTopCombinations).map((combo) => asRows(combo.assetCombinationServedAssets));
        for (const combo of served) for (const usage of combo) assetIds.add(lastSegment(usage.asset));
        combos.push({ group: asObj(row.assetGroup), campaign: asObj(row.campaign), served });
      }
      const assets = await loadAssetsById(client, cid, [...assetIds]);
      const byGroup = new Map<string, Row>();
      for (const entry of combos) {
        const groupId = str(entry.group.id);
        const target = byGroup.get(groupId) ?? {
          asset_group_id: groupId,
          asset_group_name: str(entry.group.name),
          campaign_id: str(entry.campaign.id),
          combinations: [] as Row[],
        };
        const list = target.combinations as Row[];
        for (const combo of entry.served) {
          if (list.length >= limit) break;
          list.push({
            rank: list.length + 1,
            assets: combo.map((usage) => {
              const assetId = lastSegment(usage.asset);
              const asset = assets.get(assetId);
              return { field_type: str(usage.servedAssetFieldType), asset_id: assetId, type: asset?.type ?? "", content: assetContent(asset) };
            }),
          });
        }
        byGroup.set(groupId, target);
      }
      const result = [...byGroup.values()];
      if (format === "table" || format === "csv") {
        const flat = result.flatMap((group) => (group.combinations as Row[]).map((combo) => ({
          asset_group_id: group.asset_group_id,
          asset_group_name: group.asset_group_name,
          rank: combo.rank,
          assets: (combo.assets as Row[]).map((asset) => `${str(asset.field_type)}: ${str(asset.content)}`).join(" | "),
        })));
        return ok(format === "table" ? formatAsTable(flat) : formatAsCsv(flat));
      }
      const total = result.reduce((sum, group) => sum + (group.combinations as Row[]).length, 0);
      return ok(`${total} combinação(ões) em ${result.length} grupo(s) de recursos.\n\n${formatJson(result)}`);
    }
  );
}
