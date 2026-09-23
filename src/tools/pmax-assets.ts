/**
 * Lote pmax-assets: Performance Max — criação e gestão de asset groups.
 *
 * Tools deste módulo:
 * - create_pmax_campaign e create_asset_group (reescritas): um único googleAds:mutate
 *   atômico, com os assets de texto criados por ID temporário no mesmo pedido, as regras
 *   de marca (diretrizes de marca ligadas → nome/logos na campanha; desligadas → no
 *   asset group) e o nó raiz de listing group para varejo.
 * - update_asset_group (nome, status, URLs, path1/path2) e list_asset_groups (motivos
 *   de status e itens de cobertura de assets).
 * - list_asset_group_assets e update_asset_group_assets: ver e trocar assets de um
 *   asset group existente sem recriá-lo, respeitando mínimos e máximos da v25.
 * - update_display_ad e update_demand_gen_ad: AdService com updateMask aninhado.
 * - unlink_campaign_image_assets: remove vínculos AD_IMAGE de campanhas de Pesquisa.
 *
 * Fontes (v25): developers.google.com/google-ads/api/performance-max/{asset-requirements,
 * asset-groups,structure-requests,create-campaign,troubleshooting,optimizations,retail}
 * e os protos resources/{asset_group,asset_group_asset,campaign,ad}.proto,
 * common/ad_type_infos.proto, services/{google_ads_service,ad_service}.proto.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  EU_POLITICAL_DECLARATION,
  checkCustomerAccess,
  ensureArray,
  fetchCampaignImageLinks,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  isPositiveMicros,
  num,
  parseImageAssetRef,
  partialFailureByOperation,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;

const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const fail = (message: string) => ({ content: [text(message)], isError: true as const });
const chars = (value: string) => [...value].length;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ── Regras de asset group (developers.google.com/google-ads/api/performance-max/asset-requirements) ──

interface Aspect {
  ratio: number;
  label: string;
}

export const ASPECTS = {
  LANDSCAPE: { ratio: 1.91, label: "1.91:1 (paisagem)" },
  SQUARE: { ratio: 1, label: "1:1 (quadrada)" },
  PORTRAIT: { ratio: 0.8, label: "4:5 (retrato)" },
  LANDSCAPE_LOGO: { ratio: 4, label: "4:1 (logo paisagem)" },
  TALL_PORTRAIT: { ratio: 9 / 16, label: "9:16 (retrato alto)" },
} satisfies Record<string, Aspect>;

/** Tolerância de proporção documentada nos protos dos anúncios responsivos (±1%). */
const ASPECT_TOLERANCE = 0.01;

export function aspectMatches(width: number, height: number, aspect: Aspect): boolean {
  if (!width || !height) return true; // sem dimensões conhecidas, a API decide
  return Math.abs(width / height - aspect.ratio) / aspect.ratio <= ASPECT_TOLERANCE;
}

type AssetKind = "TEXT" | "IMAGE" | "YOUTUBE_VIDEO" | "CALL_TO_ACTION";

interface GroupFieldSpec {
  kind: AssetKind;
  min: number;
  max: number;
  maxChars?: number;
  aspect?: Aspect;
  /** Asset de marca: com diretrizes de marca ligadas ele vai na campanha, não no asset group. */
  brand?: boolean;
  label: string;
}

/**
 * Mínimos e máximos por asset group (tabela "Asset Requirements" da v25). BUSINESS_NAME,
 * LOGO e LANDSCAPE_LOGO só entram no asset group quando a campanha está com as diretrizes
 * de marca desligadas; ligadas, ficam como CampaignAsset.
 */
export const ASSET_GROUP_FIELDS = {
  HEADLINE: { kind: "TEXT", min: 3, max: 15, maxChars: 30, label: "título" },
  LONG_HEADLINE: { kind: "TEXT", min: 1, max: 5, maxChars: 90, label: "título longo" },
  DESCRIPTION: { kind: "TEXT", min: 2, max: 5, maxChars: 90, label: "descrição" },
  MARKETING_IMAGE: { kind: "IMAGE", min: 1, max: 20, aspect: ASPECTS.LANDSCAPE, label: "imagem paisagem" },
  SQUARE_MARKETING_IMAGE: { kind: "IMAGE", min: 1, max: 20, aspect: ASPECTS.SQUARE, label: "imagem quadrada" },
  PORTRAIT_MARKETING_IMAGE: { kind: "IMAGE", min: 0, max: 20, aspect: ASPECTS.PORTRAIT, label: "imagem retrato" },
  YOUTUBE_VIDEO: { kind: "YOUTUBE_VIDEO", min: 0, max: 15, label: "vídeo do YouTube" },
  CALL_TO_ACTION_SELECTION: { kind: "CALL_TO_ACTION", min: 0, max: 1, label: "call-to-action" },
  BUSINESS_NAME: { kind: "TEXT", min: 1, max: 1, maxChars: 25, brand: true, label: "nome da empresa" },
  LOGO: { kind: "IMAGE", min: 1, max: 5, aspect: ASPECTS.SQUARE, brand: true, label: "logo quadrado" },
  LANDSCAPE_LOGO: { kind: "IMAGE", min: 0, max: 20, aspect: ASPECTS.LANDSCAPE_LOGO, brand: true, label: "logo paisagem" },
} satisfies Record<string, GroupFieldSpec>;

export type GroupFieldType = keyof typeof ASSET_GROUP_FIELDS;
export const GROUP_FIELD_TYPES = Object.keys(ASSET_GROUP_FIELDS) as GroupFieldType[];
const BRAND_FIELDS: GroupFieldType[] = ["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"];
const spec = (field: GroupFieldType): GroupFieldSpec => ASSET_GROUP_FIELDS[field];

/** AssetGroupError.SHORT_DESCRIPTION_REQUIRED: ao menos uma DESCRIPTION com até 60 caracteres. */
export const SHORT_DESCRIPTION_MAX_CHARS = 60;
/** Máximo de asset groups por campanha (performance-max/asset-groups). */
export const MAX_ASSET_GROUPS_PER_CAMPAIGN = 100;
/** Diretrizes de marca: 1 BUSINESS_NAME, ≥1 LOGO e até 5 logos somando LOGO e LANDSCAPE_LOGO. */
export const CAMPAIGN_BRAND_LOGO_MAX = 5;

export const CALL_TO_ACTION_TYPES = [
  "LEARN_MORE", "GET_QUOTE", "APPLY_NOW", "SIGN_UP", "CONTACT_US", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW",
  "SHOP_NOW", "BUY_NOW", "DONATE_NOW", "ORDER_NOW", "PLAY_NOW", "SEE_MORE", "START_NOW", "VISIT_SITE", "WATCH_NOW",
] as const;

/** Campaign.brand_guidelines.predefined_font_family (lista fechada, sensível a maiúsculas). */
export const BRAND_FONTS = [
  "Open Sans", "Roboto", "Montserrat", "Poppins", "Lato", "Oswald", "Playfair Display", "Roboto Slab",
] as const;

const EXPECTED_ASSET_TYPE: Record<AssetKind, string> = {
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  YOUTUBE_VIDEO: "YOUTUBE_VIDEO",
  CALL_TO_ACTION: "CALL_TO_ACTION",
};

type Counts = Record<GroupFieldType, number>;

export function emptyCounts(): Counts {
  return Object.fromEntries(GROUP_FIELD_TYPES.map((field) => [field, 0])) as Counts;
}

/**
 * Problemas de mínimo/máximo de um asset group completo (criação). Campos de marca só
 * contam quando vão no próprio asset group (diretrizes de marca desligadas).
 */
export function newGroupProblems(counts: Counts, shortDescriptions: number, brandAtGroupLevel: boolean): string[] {
  const problems: string[] = [];
  for (const field of GROUP_FIELD_TYPES) {
    const rule = spec(field);
    if (rule.brand && !brandAtGroupLevel) continue;
    const n = counts[field];
    if (n < rule.min) problems.push(`${field}: ${n} (mínimo ${rule.min}, falta${rule.min - n > 1 ? "m" : ""} ${rule.min - n})`);
    if (n > rule.max) problems.push(`${field}: ${n} (máximo ${rule.max})`);
  }
  if (counts.DESCRIPTION > 0 && shortDescriptions === 0) {
    problems.push(`DESCRIPTION: nenhuma com até ${SHORT_DESCRIPTION_MAX_CHARS} caracteres (a API exige uma descrição curta — SHORT_DESCRIPTION_REQUIRED)`);
  }
  return problems;
}

// ── Entrada ────────────────────────────────────────────────────────────

interface AssetRef {
  assetId: string;
  resourceName: string;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(value);
}

/** Lista de textos: apara, recusa vazio, repetido e acima do limite de caracteres. */
function parseTexts(values: unknown, field: GroupFieldType, errors: string[]): string[] {
  const rule = spec(field);
  const list = ensureArray<unknown>(values).map((value) => str(value).trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    if (!value) {
      errors.push(`${field}: texto vazio.`);
      continue;
    }
    if (seen.has(value)) {
      errors.push(`${field}: "${value}" repetido.`);
      continue;
    }
    seen.add(value);
    if (rule.maxChars && chars(value) > rule.maxChars) {
      errors.push(`${field}: "${value}" tem ${chars(value)} caracteres (máximo ${rule.maxChars}).`);
      continue;
    }
    out.push(value);
  }
  return out;
}

/** Referências de asset (ID ou resource name desta conta), sem repetidos. */
function parseRefs(values: unknown, cid: string, label: string, errors: string[]): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  for (const raw of ensureArray<unknown>(values).map((value) => str(value).trim()).filter(Boolean)) {
    const parsed = parseImageAssetRef(raw, cid);
    if ("error" in parsed) {
      errors.push(`${label}: ${parsed.error}`);
      continue;
    }
    if (seen.has(parsed.assetId)) {
      errors.push(`${label}: asset ${parsed.assetId} repetido.`);
      continue;
    }
    seen.add(parsed.assetId);
    out.push(parsed);
  }
  return out;
}

/** Criativos de um asset group novo, como chegam em create_asset_group / create_pmax_campaign. */
interface CreativeArgs {
  headlines?: unknown;
  longHeadlines?: unknown;
  descriptions?: unknown;
  businessName?: string;
  businessNameAsset?: string;
  marketingImageAssets?: unknown;
  squareMarketingImageAssets?: unknown;
  portraitMarketingImageAssets?: unknown;
  logoAssets?: unknown;
  landscapeLogoAssets?: unknown;
  videoAssets?: unknown;
  callToAction?: string;
}

type RefField = "MARKETING_IMAGE" | "SQUARE_MARKETING_IMAGE" | "PORTRAIT_MARKETING_IMAGE" | "LOGO" | "LANDSCAPE_LOGO" | "YOUTUBE_VIDEO";
type TextField = "HEADLINE" | "LONG_HEADLINE" | "DESCRIPTION";

interface Creative {
  texts: Record<TextField, string[]>;
  businessNameText?: string;
  businessNameRef?: AssetRef;
  refs: Record<RefField, AssetRef[]>;
  callToAction?: string;
}

const REF_PARAMS: Array<[RefField, keyof CreativeArgs]> = [
  ["MARKETING_IMAGE", "marketingImageAssets"],
  ["SQUARE_MARKETING_IMAGE", "squareMarketingImageAssets"],
  ["PORTRAIT_MARKETING_IMAGE", "portraitMarketingImageAssets"],
  ["LOGO", "logoAssets"],
  ["LANDSCAPE_LOGO", "landscapeLogoAssets"],
  ["YOUTUBE_VIDEO", "videoAssets"],
];

function parseCreative(args: CreativeArgs, cid: string, errors: string[]): Creative {
  const creative: Creative = {
    texts: {
      HEADLINE: parseTexts(args.headlines, "HEADLINE", errors),
      LONG_HEADLINE: parseTexts(args.longHeadlines, "LONG_HEADLINE", errors),
      DESCRIPTION: parseTexts(args.descriptions, "DESCRIPTION", errors),
    },
    refs: {} as Record<RefField, AssetRef[]>,
    callToAction: args.callToAction,
  };
  for (const [field, param] of REF_PARAMS) creative.refs[field] = parseRefs(args[param], cid, String(param), errors);
  const businessName = args.businessName?.trim();
  const businessNameAsset = args.businessNameAsset?.trim();
  if (businessName && businessNameAsset) {
    errors.push("Use businessName (texto novo) OU businessNameAsset (asset TEXT existente), não os dois.");
  } else if (businessName) {
    const max = spec("BUSINESS_NAME").maxChars!;
    if (chars(businessName) > max) errors.push(`businessName tem ${chars(businessName)} caracteres (máximo ${max}).`);
    else creative.businessNameText = businessName;
  } else if (businessNameAsset) {
    const [ref] = parseRefs([businessNameAsset], cid, "businessNameAsset", errors);
    if (ref) creative.businessNameRef = ref;
  } else if (args.businessName !== undefined) {
    errors.push("businessName vazio.");
  }
  return creative;
}

function creativeCounts(creative: Creative): Counts {
  const counts = emptyCounts();
  for (const field of Object.keys(creative.texts) as TextField[]) counts[field] = creative.texts[field].length;
  for (const field of Object.keys(creative.refs) as RefField[]) counts[field] = creative.refs[field].length;
  counts.BUSINESS_NAME = creative.businessNameText || creative.businessNameRef ? 1 : 0;
  counts.CALL_TO_ACTION_SELECTION = creative.callToAction ? 1 : 0;
  return counts;
}

const shortDescriptionCount = (texts: string[]) => texts.filter((t) => chars(t) <= SHORT_DESCRIPTION_MAX_CHARS).length;
const nonBrandTotal = (counts: Counts) =>
  GROUP_FIELD_TYPES.filter((field) => !spec(field).brand).reduce((total, field) => total + counts[field], 0);
const brandTotal = (counts: Counts) => BRAND_FIELDS.reduce((total, field) => total + counts[field], 0);

/** Máximos que valem em qualquer caso — conferidos antes de qualquer chamada à API. */
function maxProblems(counts: Counts): string[] {
  const problems: string[] = [];
  for (const field of GROUP_FIELD_TYPES) {
    const rule = spec(field);
    if (counts[field] > rule.max) problems.push(`${field}: ${counts[field]} (máximo ${rule.max}).`);
  }
  return problems;
}

/** URLs e caminhos de exibição do asset group. */
function parseGroupUrls(
  args: { finalUrl?: string; finalMobileUrl?: string; path1?: string; path2?: string },
  errors: string[]
) {
  const finalUrl = args.finalUrl?.trim() ?? "";
  if (!isHttpUrl(finalUrl)) errors.push(`finalUrl inválida: "${args.finalUrl ?? ""}" (use http:// ou https://).`);
  const finalMobileUrl = args.finalMobileUrl?.trim() || undefined;
  if (finalMobileUrl && !isHttpUrl(finalMobileUrl)) errors.push(`finalMobileUrl inválida: "${finalMobileUrl}".`);
  const path1 = args.path1?.trim() || undefined;
  const path2 = args.path2?.trim() || undefined;
  if (path2 && !path1) errors.push("path2 exige path1 (AssetGroupError.PATH1_REQUIRED_WHEN_PATH2_IS_SET).");
  return { finalUrl, finalMobileUrl, path1, path2 };
}

function parseGroupName(value: string, errors: string[]): string {
  const name = value.trim();
  if (!name) errors.push("name vazio.");
  else if (chars(name) > 128) errors.push(`name tem ${chars(name)} caracteres (máximo 128).`);
  return name;
}

// ── Leituras ───────────────────────────────────────────────────────────

interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  channel: string;
  brandGuidelines: boolean;
  merchantId?: string;
  resourceName: string;
}

async function fetchCampaign(client: GoogleAdsClient, customerId: string, cid: string, campaignId: string): Promise<CampaignInfo | null> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.brand_guidelines_enabled, campaign.shopping_setting.merchant_id
     FROM campaign
     WHERE campaign.id = ${campaignId}`);
  if (rows.length === 0) return null;
  const campaign = obj(rows[0].campaign);
  const merchantId = str(obj(campaign.shoppingSetting).merchantId);
  return {
    id: str(campaign.id) || campaignId,
    name: str(campaign.name),
    status: str(campaign.status),
    channel: str(campaign.advertisingChannelType),
    brandGuidelines: campaign.brandGuidelinesEnabled === true,
    merchantId: merchantId && merchantId !== "0" ? merchantId : undefined,
    resourceName: `customers/${cid}/campaigns/${campaignId}`,
  };
}

interface GroupSummary {
  id: string;
  name: string;
  status: string;
}

async function fetchCampaignGroups(client: GoogleAdsClient, customerId: string, campaignResource: string): Promise<GroupSummary[]> {
  const rows = await client.searchStream(customerId,
    `SELECT asset_group.id, asset_group.name, asset_group.status
     FROM asset_group
     WHERE asset_group.campaign = '${gaqlLiteral(campaignResource)}'`);
  return rows.map((row) => {
    const group = obj(row.assetGroup);
    return { id: str(group.id), name: str(group.name), status: str(group.status) };
  });
}

interface BrandLink {
  fieldType: string;
  assetId: string;
  status: string;
  resourceName: string;
}

/** Nome da empresa e logos vinculados na campanha (diretrizes de marca). */
async function fetchCampaignBrandLinks(
  client: GoogleAdsClient,
  customerId: string,
  campaignResources: string[]
): Promise<Map<string, BrandLink[]>> {
  const out = new Map<string, BrandLink[]>();
  if (campaignResources.length === 0) return out;
  const rows = await client.searchStream(customerId,
    `SELECT campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type,
            campaign_asset.status, campaign_asset.resource_name
     FROM campaign_asset
     WHERE campaign_asset.campaign IN (${campaignResources.map((rn) => `'${gaqlLiteral(rn)}'`).join(", ")})
       AND campaign_asset.field_type IN ('BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO')
       AND campaign_asset.status != 'REMOVED'`);
  for (const row of rows) {
    const link = obj(row.campaignAsset);
    const campaign = str(link.campaign);
    const list = out.get(campaign) ?? [];
    list.push({
      fieldType: str(link.fieldType),
      assetId: str(link.asset).split("/").pop() ?? "",
      status: str(link.status),
      resourceName: str(link.resourceName),
    });
    out.set(campaign, list);
  }
  return out;
}

const brandCounts = (links: BrandLink[]) => ({
  businessName: links.filter((l) => l.fieldType === "BUSINESS_NAME").length,
  logo: links.filter((l) => l.fieldType === "LOGO").length,
  landscapeLogo: links.filter((l) => l.fieldType === "LANDSCAPE_LOGO").length,
});

async function fetchAssets(client: GoogleAdsClient, customerId: string, ids: string[]): Promise<Map<string, Row>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Row>();
  if (unique.length === 0) return out;
  const rows = await client.searchStream(customerId,
    `SELECT asset.id, asset.name, asset.type, asset.text_asset.text,
            asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels,
            asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title,
            asset.call_to_action_asset.call_to_action
     FROM asset
     WHERE asset.id IN (${unique.join(", ")})`);
  for (const row of rows) {
    const asset = obj(row.asset);
    out.set(str(asset.id), asset);
  }
  return out;
}

function imageSize(asset: Row): { width: number; height: number } {
  const full = obj(obj(asset.imageAsset).fullSize);
  return { width: num(full.widthPixels), height: num(full.heightPixels) };
}

/** Confere se o asset existe, se o tipo casa com o campo e (imagem) se a proporção bate. */
function checkAssetForField(
  assetId: string,
  asset: Row | undefined,
  field: string,
  expectedType: string,
  cid: string,
  extra: { maxChars?: number; aspect?: Aspect } = {}
): string | null {
  if (!asset) return `asset ${assetId} não existe na conta ${cid} (${field}).`;
  const label = `asset ${assetId}${asset.name ? ` ("${asset.name}")` : ""}`;
  if (str(asset.type) !== expectedType) return `${label} é do tipo ${str(asset.type) || "desconhecido"}; ${field} exige ${expectedType}.`;
  if (extra.maxChars) {
    const value = str(obj(asset.textAsset).text);
    if (chars(value) > extra.maxChars) return `${label} tem ${chars(value)} caracteres; ${field} aceita até ${extra.maxChars}.`;
  }
  if (extra.aspect) {
    const { width, height } = imageSize(asset);
    if (!aspectMatches(width, height, extra.aspect)) {
      return `${label} tem ${width}x${height} (${(width / height).toFixed(2)}:1); ${field} exige proporção ${extra.aspect.label}.`;
    }
  }
  return null;
}

function checkGroupAsset(ref: AssetRef, asset: Row | undefined, field: GroupFieldType, cid: string): string | null {
  const rule = spec(field);
  return checkAssetForField(ref.assetId, asset, field, EXPECTED_ASSET_TYPE[rule.kind], cid, {
    maxChars: rule.maxChars,
    aspect: rule.aspect,
  });
}

/** Todas as referências de um criativo, com o campo em que vão entrar. */
function creativeRefs(creative: Creative): Array<{ ref: AssetRef; field: GroupFieldType }> {
  const out: Array<{ ref: AssetRef; field: GroupFieldType }> = [];
  for (const field of Object.keys(creative.refs) as RefField[]) {
    for (const ref of creative.refs[field]) out.push({ ref, field });
  }
  if (creative.businessNameRef) out.push({ ref: creative.businessNameRef, field: "BUSINESS_NAME" });
  return out;
}

async function checkCreativeAssets(client: GoogleAdsClient, customerId: string, cid: string, creative: Creative): Promise<string[]> {
  const refs = creativeRefs(creative);
  const assets = await fetchAssets(client, customerId, refs.map((item) => item.ref.assetId));
  return refs
    .map((item) => checkGroupAsset(item.ref, assets.get(item.ref.assetId), item.field, cid))
    .filter((error): error is string => error !== null);
}

// ── Operações do googleAds:mutate ─────────────────────────────────────

/** IDs temporários (negativos e únicos no pedido) para referenciar o que ainda vai ser criado. */
class TempIds {
  private last = 0;
  next(): number {
    this.last -= 1;
    return this.last;
  }
}

const textAssetOp = (resourceName: string, value: string) => ({
  assetOperation: { create: { resourceName, textAsset: { text: value } } },
});
const ctaAssetOp = (resourceName: string, callToAction: string) => ({
  assetOperation: { create: { resourceName, callToActionAsset: { callToAction } } },
});
const groupLinkOp = (assetGroup: string, asset: string, fieldType: string) => ({
  assetGroupAssetOperation: { create: { assetGroup, asset, fieldType } },
});
const campaignLinkOp = (campaign: string, asset: string, fieldType: string) => ({
  campaignAssetOperation: { create: { campaign, asset, fieldType } },
});
/** Árvore mínima de listing group: um nó raiz que inclui todos os produtos do feed. */
const listingRootOp = (assetGroup: string) => ({
  assetGroupListingGroupFilterOperation: { create: { assetGroup, type: "UNIT_INCLUDED", listingSource: "SHOPPING" } },
});

type BrandLevel = "group" | "campaign" | "none";

/**
 * Monta as operações de um criativo novo. Ordem exigida pela API: todos os AssetOperation
 * antes dos vínculos, e os AssetGroupAssetOperation consecutivos (a API confere os mínimos
 * depois do último da sequência — performance-max/structure-requests).
 */
function buildCreativeOps(
  cid: string,
  creative: Creative,
  ids: TempIds,
  target: { assetGroup: string; campaign: string; brandLevel: BrandLevel }
) {
  const assetOps: Row[] = [];
  const campaignLinkOps: Row[] = [];
  const groupLinkOps: Row[] = [];
  const tempAsset = () => `customers/${cid}/assets/${ids.next()}`;
  const linkBrand = (asset: string, fieldType: string) => {
    if (target.brandLevel === "group") groupLinkOps.push(groupLinkOp(target.assetGroup, asset, fieldType));
    else if (target.brandLevel === "campaign") campaignLinkOps.push(campaignLinkOp(target.campaign, asset, fieldType));
  };
  for (const field of ["HEADLINE", "LONG_HEADLINE", "DESCRIPTION"] as TextField[]) {
    for (const value of creative.texts[field]) {
      const rn = tempAsset();
      assetOps.push(textAssetOp(rn, value));
      groupLinkOps.push(groupLinkOp(target.assetGroup, rn, field));
    }
  }
  if (creative.businessNameText) {
    const rn = tempAsset();
    assetOps.push(textAssetOp(rn, creative.businessNameText));
    linkBrand(rn, "BUSINESS_NAME");
  } else if (creative.businessNameRef) {
    linkBrand(creative.businessNameRef.resourceName, "BUSINESS_NAME");
  }
  for (const field of ["LOGO", "LANDSCAPE_LOGO"] as RefField[]) {
    for (const ref of creative.refs[field]) linkBrand(ref.resourceName, field);
  }
  for (const field of ["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "YOUTUBE_VIDEO"] as RefField[]) {
    for (const ref of creative.refs[field]) groupLinkOps.push(groupLinkOp(target.assetGroup, ref.resourceName, field));
  }
  if (creative.callToAction) {
    const rn = tempAsset();
    assetOps.push(ctaAssetOp(rn, creative.callToAction));
    groupLinkOps.push(groupLinkOp(target.assetGroup, rn, "CALL_TO_ACTION_SELECTION"));
  }
  return { assetOps, campaignLinkOps, groupLinkOps };
}

function mutateResponses(response: Row): Row[] {
  return arr(response.mutateOperationResponses).map(obj);
}

function resultResourceName(responses: Row[], key: string): string | undefined {
  for (const response of responses) {
    const name = str(obj(response[key]).resourceName);
    if (name) return name;
  }
  return undefined;
}

const nonZero = (counts: Counts) =>
  Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)) as Partial<Counts>;

// ── Erros da API ──────────────────────────────────────────────────────

/**
 * Dicas em PT-BR para os erros mais comuns. O client devolve só as mensagens da API, então
 * o casamento é pelo nome do enum OU pelo texto em inglês (protos errors/*.proto).
 */
const API_ERROR_HINTS: Array<[RegExp, string]> = [
  [/NOT_ENOUGH_HEADLINE|not enough headline/i, "faltam títulos (HEADLINE): mínimo 3."],
  [/NOT_ENOUGH_LONG_HEADLINE|not enough long headline/i, "falta título longo (LONG_HEADLINE): mínimo 1."],
  [/NOT_ENOUGH_DESCRIPTION|not enough description/i, "faltam descrições (DESCRIPTION): mínimo 2."],
  [/SHORT_DESCRIPTION_REQUIRED|short description/i, `inclua ao menos uma descrição com até ${SHORT_DESCRIPTION_MAX_CHARS} caracteres.`],
  [/NOT_ENOUGH_BUSINESS_NAME|not enough business name/i, "falta o nome da empresa (BUSINESS_NAME)."],
  [/NOT_ENOUGH_SQUARE_MARKETING_IMAGE|not enough square marketing image/i, "falta imagem quadrada (SQUARE_MARKETING_IMAGE, 1:1)."],
  [/NOT_ENOUGH_MARKETING_IMAGE|not enough marketing image/i, "falta imagem paisagem (MARKETING_IMAGE, 1.91:1)."],
  [/NOT_ENOUGH_LOGO|not enough logo/i, "falta logo (LOGO, 1:1)."],
  [/BRAND_ASSETS_NOT_LINKED_AT_ASSET_GROUP_LEVEL|linked as AssetGroupAssets/i,
    "a campanha está com as diretrizes de marca DESLIGADAS: nome da empresa e logos vão no asset group."],
  [/BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL|linked as CampaignAssets/i,
    "a campanha está com as diretrizes de marca LIGADAS: nome da empresa e logos vão na campanha, não no asset group."],
  [/REQUIRED_BUSINESS_NAME_ASSET_NOT_LINKED|REQUIRED_LOGO_ASSET_NOT_LINKED/i,
    "a campanha com diretrizes de marca precisa de 1 nome da empresa e ao menos 1 logo vinculados na campanha, no mesmo pedido."],
  [/ASPECT_RATIO_NOT_ALLOWED|aspect ratio/i,
    "proporção da imagem não aceita no campo: paisagem 1.91:1, quadrada 1:1, retrato 4:5, logo 1:1, logo paisagem 4:1."],
  [/IMAGE_NOT_WITHIN_SPECIFIED_DIMENSION_RANGE|not within the dimension/i, "imagem fora das dimensões mínimas do campo."],
  [/DUPLICATE_NAME|unique name/i, "já existe um asset group com esse nome na campanha."],
  [/FINAL_URL_SHOPPING_MERCHANT_HOME_PAGE_URL_DOMAINS_DIFFER|same domain/i,
    "em varejo, a URL final precisa ser do mesmo domínio do site cadastrado no Merchant Center."],
  [/DUPLICATE_RESOURCE|duplicated asset group asset/i, "esse asset já está vinculado com esse tipo de campo."],
  [/FIELD_TYPE_INCOMPATIBLE_WITH_ASSET_TYPE/i, "o tipo do asset não serve para esse campo (ex.: texto em campo de imagem)."],
  [/FIELD_HAS_SUBFIELDS/i, "updateMask nomeou uma mensagem inteira — informe o caminho da folha."],
  [/CANNOT_REMOVE_ALL_ASSET_GROUPS_FROM_CAMPAIGN/i, "a campanha precisa de ao menos um asset group."],
];

export function explainApiError(message: string): string {
  const hints = API_ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => `- ${hint}`);
  return hints.length ? `${message}\nO que fazer:\n${hints.join("\n")}` : message;
}

async function safely<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

// ── Leitura de asset groups e seus vínculos ───────────────────────────

const GROUP_REASON_PT: Record<string, string> = {
  ASSET_GROUP_PAUSED: "asset group pausado",
  ASSET_GROUP_REMOVED: "asset group removido",
  CAMPAIGN_REMOVED: "campanha removida",
  CAMPAIGN_PAUSED: "campanha pausada",
  CAMPAIGN_PENDING: "campanha com início no futuro",
  CAMPAIGN_ENDED: "campanha encerrada (data final passou)",
  ASSET_GROUP_LIMITED: "aprovado, mas veicula de forma limitada por políticas",
  ASSET_GROUP_DISAPPROVED: "asset group reprovado",
  ASSET_GROUP_UNDER_REVIEW: "asset group em análise de política",
};

const LINK_REASON_PT: Record<string, string> = {
  ASSET_LINK_PAUSED: "vínculo pausado",
  ASSET_LINK_REMOVED: "vínculo removido",
  ASSET_DISAPPROVED: "asset reprovado",
  ASSET_UNDER_REVIEW: "asset em análise de política",
  ASSET_APPROVED_LABELED: "aprovado com restrição de política",
};

const VIDEO_RATIO_PT: Record<string, string> = {
  HORIZONTAL: "horizontal 16:9",
  SQUARE: "quadrado 1:1",
  VERTICAL: "vertical 9:16",
};

/** Item de asset_group.asset_coverage.ad_strength_action_items em texto. */
export function describeActionItem(item: unknown): string {
  const action = obj(item);
  const type = str(action.actionItemType);
  if (type !== "ADD_ASSET") return type || "ação desconhecida";
  const details = obj(action.addAssetDetails);
  const count = details.assetCount !== undefined ? `${num(details.assetCount)} ` : "";
  const ratio = VIDEO_RATIO_PT[str(details.videoAspectRatioRequirement)];
  return `adicionar ${count}${str(details.assetFieldType) || "asset"}${ratio ? ` (${ratio})` : ""}`;
}

const reasonsPt = (reasons: unknown, map: Record<string, string>) =>
  arr(reasons).map((reason) => `${str(reason)}${map[str(reason)] ? ` — ${map[str(reason)]}` : ""}`);

const GROUP_FIELDS_SELECT = `asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength,
            asset_group.primary_status, asset_group.primary_status_reasons,
            asset_group.final_urls, asset_group.final_mobile_urls, asset_group.path1, asset_group.path2,
            asset_group.asset_coverage.ad_strength_action_items,
            campaign.id, campaign.name, campaign.advertising_channel_type,
            campaign.brand_guidelines_enabled, campaign.shopping_setting.merchant_id`;

function groupView(row: Row) {
  const group = obj(row.assetGroup);
  const campaign = obj(row.campaign);
  const merchantId = str(obj(campaign.shoppingSetting).merchantId);
  return {
    asset_group_id: str(group.id),
    name: str(group.name),
    status: str(group.status),
    ad_strength: str(group.adStrength),
    primary_status: str(group.primaryStatus),
    primary_status_reasons: reasonsPt(group.primaryStatusReasons, GROUP_REASON_PT),
    final_urls: arr(group.finalUrls).map(str),
    final_mobile_urls: arr(group.finalMobileUrls).map(str),
    path1: str(group.path1) || undefined,
    path2: str(group.path2) || undefined,
    coverage_actions: arr(obj(group.assetCoverage).adStrengthActionItems).map(describeActionItem),
    campaign_id: str(campaign.id),
    campaign_name: str(campaign.name),
    brand_guidelines: campaign.brandGuidelinesEnabled === true,
    retail_merchant_id: merchantId && merchantId !== "0" ? merchantId : undefined,
  };
}

interface GroupLink {
  groupId: string;
  resourceName: string;
  fieldType: string;
  status: string;
  source: string;
  assetId: string;
  assetRn: string;
  text?: string;
  callToAction?: string;
  row: Row;
}

async function fetchGroupLinks(
  client: GoogleAdsClient,
  customerId: string,
  where: string,
  opts: { includeRemoved?: boolean; fieldTypes?: string[]; detailed?: boolean } = {}
): Promise<GroupLink[]> {
  const detailFields = opts.detailed
    ? `,
            asset_group_asset.primary_status, asset_group_asset.primary_status_reasons,
            asset_group_asset.policy_summary.approval_status, asset_group_asset.policy_summary.review_status,
            asset_group_asset.policy_summary.policy_topic_entries,
            asset.name, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels,
            asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id,
            asset.youtube_video_asset.youtube_video_title`
    : "";
  const filters = [where];
  if (!opts.includeRemoved) filters.push("asset_group_asset.status != 'REMOVED'");
  if (opts.fieldTypes?.length) filters.push(`asset_group_asset.field_type IN (${opts.fieldTypes.map((f) => `'${f}'`).join(", ")})`);
  const rows = await client.searchStream(customerId,
    `SELECT asset_group.id, asset_group_asset.resource_name, asset_group_asset.field_type,
            asset_group_asset.status, asset_group_asset.source,
            asset.id, asset.resource_name, asset.type, asset.text_asset.text,
            asset.call_to_action_asset.call_to_action${detailFields}
     FROM asset_group_asset
     WHERE ${filters.join("\n       AND ")}`);
  return rows.map((row) => {
    const link = obj(row.assetGroupAsset);
    const asset = obj(row.asset);
    const assetId = str(asset.id);
    return {
      groupId: str(obj(row.assetGroup).id),
      resourceName: str(link.resourceName),
      fieldType: str(link.fieldType),
      status: str(link.status),
      source: str(link.source),
      assetId,
      assetRn: str(asset.resourceName),
      text: obj(asset.textAsset).text !== undefined ? str(obj(asset.textAsset).text) : undefined,
      callToAction: str(obj(asset.callToActionAsset).callToAction) || undefined,
      row,
    };
  });
}

/** Vínculos que contam para os mínimos: do anunciante (não os criados automaticamente) e não removidos. */
const countsForMinimum = (link: GroupLink) => link.status !== "REMOVED" && link.source !== "AUTOMATICALLY_CREATED";

function linkCounts(links: GroupLink[]): { counts: Counts; shortDescriptions: number } {
  const counts = emptyCounts();
  let shortDescriptions = 0;
  for (const link of links.filter(countsForMinimum)) {
    if (link.fieldType in counts) counts[link.fieldType as GroupFieldType] += 1;
    if (link.fieldType === "DESCRIPTION" && link.text !== undefined && chars(link.text) <= SHORT_DESCRIPTION_MAX_CHARS) shortDescriptions += 1;
  }
  return { counts, shortDescriptions };
}

// ── Anúncios (AdService) ──────────────────────────────────────────────

type AdFieldKind = "assetList" | "textList" | "textAsset" | "string" | "image" | "bool" | "color";

interface AdFieldSpec {
  prop: string;
  /** Caminho no updateMask, relativo ao oneof do anúncio (sempre uma folha ou campo repetido). */
  path: string;
  kind: AdFieldKind;
  assetType?: string;
  aspect?: Aspect;
  min?: number;
  max?: number;
  maxChars?: number;
  pool?: string;
}

interface AdTypeSpec {
  adType: string;
  key: string;
  path: string;
  label: string;
  fields: Record<string, AdFieldSpec>;
  pools?: Record<string, { max: number; label: string }>;
  requireOneOf?: string[][];
}

const imageList = (prop: string, path: string, extra: Partial<AdFieldSpec> = {}): AdFieldSpec => ({
  prop, path, kind: "assetList", assetType: "IMAGE", ...extra,
});

/** ResponsiveDisplayAdInfo (common/ad_type_infos.proto, v25). */
export const DISPLAY_AD_SPEC: AdTypeSpec = {
  adType: "RESPONSIVE_DISPLAY_AD",
  key: "responsiveDisplayAd",
  path: "responsive_display_ad",
  label: "anúncio display responsivo",
  pools: {
    marketing: { max: 15, label: "MARKETING_IMAGES + SQUARE_MARKETING_IMAGES" },
    logos: { max: 5, label: "LOGO_IMAGES + SQUARE_LOGO_IMAGES" },
  },
  fields: {
    MARKETING_IMAGES: imageList("marketingImages", "marketing_images", { aspect: ASPECTS.LANDSCAPE, min: 1, pool: "marketing" }),
    SQUARE_MARKETING_IMAGES: imageList("squareMarketingImages", "square_marketing_images", { aspect: ASPECTS.SQUARE, min: 1, pool: "marketing" }),
    LOGO_IMAGES: imageList("logoImages", "logo_images", { aspect: ASPECTS.LANDSCAPE_LOGO, pool: "logos" }),
    SQUARE_LOGO_IMAGES: imageList("squareLogoImages", "square_logo_images", { aspect: ASPECTS.SQUARE, pool: "logos" }),
    YOUTUBE_VIDEOS: { prop: "youtubeVideos", path: "youtube_videos", kind: "assetList", assetType: "YOUTUBE_VIDEO", max: 5 },
    headlines: { prop: "headlines", path: "headlines", kind: "textList", min: 1, max: 5, maxChars: 30 },
    longHeadline: { prop: "longHeadline", path: "long_headline.text", kind: "textAsset", maxChars: 90 },
    descriptions: { prop: "descriptions", path: "descriptions", kind: "textList", min: 1, max: 5, maxChars: 90 },
    businessName: { prop: "businessName", path: "business_name", kind: "string", maxChars: 25 },
    callToActionText: { prop: "callToActionText", path: "call_to_action_text", kind: "string", maxChars: 30 },
    mainColor: { prop: "mainColor", path: "main_color", kind: "color" },
    accentColor: { prop: "accentColor", path: "accent_color", kind: "color" },
    allowFlexibleColor: { prop: "allowFlexibleColor", path: "allow_flexible_color", kind: "bool" },
  },
};

/** Os quatro formatos de anúncio Demand Gen editáveis pelo AdService (v25). */
export const DEMAND_GEN_AD_SPECS: AdTypeSpec[] = [
  {
    adType: "DEMAND_GEN_MULTI_ASSET_AD",
    key: "demandGenMultiAssetAd",
    path: "demand_gen_multi_asset_ad",
    label: "anúncio Demand Gen de imagem (multi-asset)",
    pools: { images: { max: 20, label: "MARKETING + SQUARE + PORTRAIT + TALL_PORTRAIT" } },
    requireOneOf: [["MARKETING_IMAGES", "SQUARE_MARKETING_IMAGES"]],
    fields: {
      MARKETING_IMAGES: imageList("marketingImages", "marketing_images", { aspect: ASPECTS.LANDSCAPE, pool: "images" }),
      SQUARE_MARKETING_IMAGES: imageList("squareMarketingImages", "square_marketing_images", { aspect: ASPECTS.SQUARE, pool: "images" }),
      PORTRAIT_MARKETING_IMAGES: imageList("portraitMarketingImages", "portrait_marketing_images", { aspect: ASPECTS.PORTRAIT, pool: "images" }),
      TALL_PORTRAIT_MARKETING_IMAGES: imageList("tallPortraitMarketingImages", "tall_portrait_marketing_images", { aspect: ASPECTS.TALL_PORTRAIT, pool: "images" }),
      LOGO_IMAGES: imageList("logoImages", "logo_images", { aspect: ASPECTS.SQUARE, min: 1, max: 5 }),
      CLASSIC_DISPLAY_IMAGES: imageList("classicDisplayImages", "classic_display_images", { max: 20 }),
      headlines: { prop: "headlines", path: "headlines", kind: "textList", min: 1, max: 5, maxChars: 30 },
      descriptions: { prop: "descriptions", path: "descriptions", kind: "textList", min: 1, max: 5, maxChars: 90 },
      businessName: { prop: "businessName", path: "business_name", kind: "string", maxChars: 25 },
      callToActionText: { prop: "callToActionText", path: "call_to_action_text", kind: "string" },
    },
  },
  {
    adType: "DEMAND_GEN_VIDEO_RESPONSIVE_AD",
    key: "demandGenVideoResponsiveAd",
    path: "demand_gen_video_responsive_ad",
    label: "anúncio Demand Gen de vídeo",
    fields: {
      VIDEOS: { prop: "videos", path: "videos", kind: "assetList", assetType: "YOUTUBE_VIDEO", min: 1 },
      LOGO_IMAGES: imageList("logoImages", "logo_images", { aspect: ASPECTS.SQUARE, min: 1 }),
      COMPANION_BANNERS: imageList("companionBanners", "companion_banners", { max: 1 }),
      headlines: { prop: "headlines", path: "headlines", kind: "textList" },
      longHeadlines: { prop: "longHeadlines", path: "long_headlines", kind: "textList" },
      descriptions: { prop: "descriptions", path: "descriptions", kind: "textList" },
      businessName: { prop: "businessName", path: "business_name.text", kind: "textAsset" },
      breadcrumb1: { prop: "breadcrumb1", path: "breadcrumb1", kind: "string" },
      breadcrumb2: { prop: "breadcrumb2", path: "breadcrumb2", kind: "string" },
    },
  },
  {
    adType: "DEMAND_GEN_CAROUSEL_AD",
    key: "demandGenCarouselAd",
    path: "demand_gen_carousel_ad",
    label: "anúncio Demand Gen em carrossel",
    fields: {
      CAROUSEL_CARDS: { prop: "carouselCards", path: "carousel_cards", kind: "assetList", assetType: "DEMAND_GEN_CAROUSEL_CARD", min: 2, max: 10 },
      logoImageAsset: { prop: "logoImage", path: "logo_image.asset", kind: "image", assetType: "IMAGE", aspect: ASPECTS.SQUARE },
      headline: { prop: "headline", path: "headline.text", kind: "textAsset" },
      description: { prop: "description", path: "description.text", kind: "textAsset" },
      businessName: { prop: "businessName", path: "business_name", kind: "string" },
      callToActionText: { prop: "callToActionText", path: "call_to_action_text", kind: "string" },
    },
  },
  {
    adType: "DEMAND_GEN_PRODUCT_AD",
    key: "demandGenProductAd",
    path: "demand_gen_product_ad",
    label: "anúncio Demand Gen de produto",
    fields: {
      logoImageAsset: { prop: "logoImage", path: "logo_image.asset", kind: "image", assetType: "IMAGE", aspect: ASPECTS.SQUARE },
      headline: { prop: "headline", path: "headline.text", kind: "textAsset" },
      description: { prop: "description", path: "description.text", kind: "textAsset" },
      businessName: { prop: "businessName", path: "business_name.text", kind: "textAsset" },
      breadcrumb1: { prop: "breadcrumb1", path: "breadcrumb1", kind: "string" },
      breadcrumb2: { prop: "breadcrumb2", path: "breadcrumb2", kind: "string" },
    },
  },
];

/** Campos do SELECT para ler o anúncio (a raiz de cada caminho do updateMask). */
function adSelectFields(specs: AdTypeSpec[]): string[] {
  const fields = new Set<string>();
  for (const adSpec of specs) {
    for (const field of Object.values(adSpec.fields)) fields.add(`ad_group_ad.ad.${adSpec.path}.${field.path.split(".")[0]}`);
  }
  return [...fields];
}

interface AdAssetChange {
  field: string;
  asset: string;
}

interface AdChangeRequest {
  addAssets: AdAssetChange[];
  removeAssets: AdAssetChange[];
  values: Record<string, unknown>;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Calcula o update de um anúncio responsivo: listas de assets por adição/remoção sobre o
 * estado atual, textos por substituição. Devolve só o que muda, com o updateMask aninhado.
 */
async function planAdUpdate(
  client: GoogleAdsClient,
  customerId: string,
  cid: string,
  adSpec: AdTypeSpec,
  current: Row,
  request: AdChangeRequest
): Promise<{ errors: string[]; notes: string[]; payload: Row; paths: string[]; before: Row; after: Row }> {
  const errors: string[] = [];
  const notes: string[] = [];
  const payload: Row = {};
  const paths: string[] = [];
  const before: Row = {};
  const after: Row = {};
  const supported = Object.keys(adSpec.fields);

  // Campos pedidos que não existem neste formato de anúncio
  for (const change of [...request.addAssets, ...request.removeAssets]) {
    const field = adSpec.fields[change.field];
    if (!field || field.kind !== "assetList") {
      errors.push(`${change.field} não existe em ${adSpec.adType}. Listas deste formato: ${supported.filter((f) => adSpec.fields[f].kind === "assetList").join(", ") || "nenhuma"}.`);
    }
  }
  for (const key of Object.keys(request.values)) {
    if (!adSpec.fields[key]) errors.push(`${key} não se aplica a ${adSpec.adType}. Campos deste formato: ${supported.join(", ")}.`);
  }
  if (errors.length) return { errors, notes, payload, paths, before, after };

  // Referências de assets: formato/conta antes de ler a API
  const refs = new Map<string, { field: string; ref: AssetRef }[]>();
  const parseAdRef = (field: string, raw: string): AssetRef | null => {
    const parsed = parseImageAssetRef(raw, cid);
    if ("error" in parsed) {
      errors.push(`${field}: ${parsed.error}`);
      return null;
    }
    return parsed;
  };
  const adds = new Map<string, AssetRef[]>();
  const removes = new Map<string, AssetRef[]>();
  for (const [list, target] of [[request.addAssets, adds], [request.removeAssets, removes]] as const) {
    for (const change of list) {
      const ref = parseAdRef(change.field, change.asset);
      if (!ref) continue;
      target.set(change.field, [...(target.get(change.field) ?? []), ref]);
      if (target === adds) refs.set(ref.assetId, [...(refs.get(ref.assetId) ?? []), { field: change.field, ref }]);
    }
  }
  for (const [field, list] of adds) {
    const removed = new Set((removes.get(field) ?? []).map((r) => r.assetId));
    for (const ref of list) if (removed.has(ref.assetId)) errors.push(`${field}: asset ${ref.assetId} está em addAssets e removeAssets ao mesmo tempo.`);
  }
  const singleImages: Array<{ key: string; ref: AssetRef }> = [];
  for (const [key, value] of Object.entries(request.values)) {
    const field = adSpec.fields[key];
    if (field.kind === "image") {
      const ref = parseAdRef(key, str(value));
      if (ref) singleImages.push({ key, ref });
    }
  }
  if (errors.length) return { errors, notes, payload, paths, before, after };

  // Assets novos: existem nesta conta, tipo e proporção certos
  const assets = await fetchAssets(client, customerId, [...refs.keys(), ...singleImages.map((s) => s.ref.assetId)]);
  for (const [assetId, uses] of refs) {
    for (const use of uses) {
      const field = adSpec.fields[use.field];
      const error = checkAssetForField(assetId, assets.get(assetId), use.field, field.assetType ?? "IMAGE", cid, { aspect: field.aspect });
      if (error) errors.push(error);
    }
  }
  for (const single of singleImages) {
    const field = adSpec.fields[single.key];
    const error = checkAssetForField(single.ref.assetId, assets.get(single.ref.assetId), single.key, field.assetType ?? "IMAGE", cid, { aspect: field.aspect });
    if (error) errors.push(error);
  }
  if (errors.length) return { errors, notes, payload, paths, before, after };

  const finalLists = new Map<string, number>();
  for (const [key, field] of Object.entries(adSpec.fields)) {
    const currentValue = current[field.prop];
    if (field.kind === "assetList") {
      const items = arr(currentValue).map(obj);
      finalLists.set(key, items.length);
      if (!adds.has(key) && !removes.has(key)) continue;
      const currentIds = items.map((item) => str(item.asset).split("/").pop() ?? "");
      let next = [...items];
      for (const ref of removes.get(key) ?? []) {
        if (!currentIds.includes(ref.assetId)) {
          notes.push(`${key}: asset ${ref.assetId} não estava no anúncio — nada a remover.`);
          continue;
        }
        next = next.filter((item) => str(item.asset).split("/").pop() !== ref.assetId);
      }
      for (const ref of adds.get(key) ?? []) {
        if (currentIds.includes(ref.assetId)) {
          notes.push(`${key}: asset ${ref.assetId} já estava no anúncio.`);
          continue;
        }
        next.push({ asset: ref.resourceName });
      }
      const beforeIds = items.map((item) => str(item.asset));
      const afterIds = next.map((item) => str(item.asset));
      finalLists.set(key, next.length);
      if (beforeIds.join("|") === afterIds.join("|")) continue;
      if (field.min !== undefined && next.length < field.min) errors.push(`${key}: ficaria com ${next.length} (mínimo ${field.min}).`);
      if (field.max !== undefined && next.length > field.max) errors.push(`${key}: ficaria com ${next.length} (máximo ${field.max}).`);
      payload[field.prop] = next;
      paths.push(field.path);
      before[key] = beforeIds;
      after[key] = afterIds;
      continue;
    }
    if (!(key in request.values)) continue;
    const value = request.values[key];
    if (field.kind === "textList") {
      const texts = ensureArray<unknown>(value).map((v) => str(v).trim());
      const problems: string[] = [];
      if (texts.some((t) => !t)) problems.push(`${key}: texto vazio.`);
      if (new Set(texts).size !== texts.length) problems.push(`${key}: textos repetidos.`);
      for (const t of texts) if (field.maxChars && chars(t) > field.maxChars) problems.push(`${key}: "${t}" tem ${chars(t)} caracteres (máximo ${field.maxChars}).`);
      if (field.min !== undefined && texts.length < field.min) problems.push(`${key}: ${texts.length} (mínimo ${field.min}).`);
      if (field.max !== undefined && texts.length > field.max) problems.push(`${key}: ${texts.length} (máximo ${field.max}).`);
      if (texts.length === 0 && field.min === undefined) problems.push(`${key}: lista vazia.`);
      if (problems.length) {
        errors.push(...problems);
        continue;
      }
      const currentTexts = arr(currentValue).map((item) => str(obj(item).text));
      if (currentTexts.join("\u0000") === texts.join("\u0000")) continue;
      payload[field.prop] = texts.map((t) => ({ text: t }));
      paths.push(field.path);
      before[key] = currentTexts;
      after[key] = texts;
      continue;
    }
    if (field.kind === "bool") {
      if (typeof value !== "boolean") {
        errors.push(`${key} deve ser true ou false.`);
        continue;
      }
      if (currentValue === value) continue;
      payload[field.prop] = value;
      paths.push(field.path);
      before[key] = currentValue ?? null;
      after[key] = value;
      continue;
    }
    if (field.kind === "image") {
      const single = singleImages.find((s) => s.key === key)!;
      const currentAsset = str(obj(currentValue).asset);
      if (currentAsset === single.ref.resourceName) continue;
      payload[field.prop] = { asset: single.ref.resourceName };
      paths.push(field.path);
      before[key] = currentAsset || null;
      after[key] = single.ref.resourceName;
      continue;
    }
    // string, color, textAsset
    const next = str(value).trim();
    if (!next) {
      errors.push(`${key} vazio — informe o novo valor.`);
      continue;
    }
    if (field.kind === "color" && !HEX_COLOR.test(next)) {
      errors.push(`${key} deve ser uma cor hexadecimal como #1A2B3C, recebido "${next}".`);
      continue;
    }
    if (field.maxChars && chars(next) > field.maxChars) {
      errors.push(`${key}: "${next}" tem ${chars(next)} caracteres (máximo ${field.maxChars}).`);
      continue;
    }
    const currentText = field.kind === "textAsset" ? str(obj(currentValue).text) : str(currentValue);
    if (currentText === next) continue;
    payload[field.prop] = field.kind === "textAsset" ? { text: next } : next;
    paths.push(field.path);
    before[key] = currentText || null;
    after[key] = next;
  }

  // Limites que somam mais de uma lista (ex.: até 15 imagens entre paisagem e quadrada)
  for (const [poolName, pool] of Object.entries(adSpec.pools ?? {})) {
    const members = Object.entries(adSpec.fields).filter(([, f]) => f.pool === poolName).map(([k]) => k);
    if (!members.some((m) => m in after)) continue;
    const total = members.reduce((sum, m) => sum + (finalLists.get(m) ?? 0), 0);
    if (total > pool.max) errors.push(`${pool.label}: ficaria com ${total} (máximo ${pool.max} somando as listas).`);
  }
  for (const group of adSpec.requireOneOf ?? []) {
    if (!group.some((m) => m in after)) continue;
    if (group.every((m) => (finalLists.get(m) ?? 0) === 0)) errors.push(`${group.join(" ou ")}: o anúncio precisa de ao menos uma imagem em uma dessas listas.`);
  }
  // Cores do display responsivo: as duas juntas; sem cores, allow_flexible_color precisa ser true
  if (adSpec.adType === "RESPONSIVE_DISPLAY_AD" && ["mainColor", "accentColor", "allowFlexibleColor"].some((k) => k in after)) {
    const main = str(after.mainColor ?? current.mainColor);
    const accent = str(after.accentColor ?? current.accentColor);
    const flexible = (after.allowFlexibleColor ?? current.allowFlexibleColor ?? true) as boolean;
    if (Boolean(main) !== Boolean(accent)) errors.push("mainColor e accentColor vão juntas: informe as duas (a API exige ambas).");
    if (!main && !accent && flexible === false) errors.push("Sem mainColor/accentColor, allowFlexibleColor precisa ser true.");
  }
  return { errors, notes, payload, paths, before, after };
}

const adAssetChangeSchema = (fields: [string, ...string[]]) =>
  z.object({
    field: z.enum(fields).describe("Lista do anúncio."),
    asset: z.string().describe("Asset: ID numérico ou customers/{customerId}/assets/{assetId}."),
  });

interface AdToolArgs {
  customerId: string;
  adId: string;
  addAssets?: unknown;
  removeAssets?: unknown;
  [key: string]: unknown;
}

/** Fluxo comum de update_display_ad e update_demand_gen_ad. */
async function runAdUpdate(ctx: ToolContext, toolName: string, specs: AdTypeSpec[], valueKeys: string[], args: AdToolArgs) {
  const cid = args.customerId.replace(/-/g, "");
  if (!/^\d+$/.test(cid)) return fail(`customerId inválido: "${args.customerId}". Nada foi gravado.`);
  if (!/^\d+$/.test(args.adId)) return fail(`adId deve ser numérico, recebido "${args.adId}". Nada foi gravado.`);
  const request: AdChangeRequest = {
    addAssets: ensureArray<AdAssetChange>(args.addAssets).map((c) => ({ field: str(obj(c).field), asset: str(obj(c).asset).trim() })),
    removeAssets: ensureArray<AdAssetChange>(args.removeAssets).map((c) => ({ field: str(obj(c).field), asset: str(obj(c).asset).trim() })),
    values: Object.fromEntries(valueKeys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])),
  };
  if (request.addAssets.length + request.removeAssets.length + Object.keys(request.values).length === 0) {
    return fail("Informe ao menos uma mudança (addAssets, removeAssets ou um dos campos de texto). Nada foi enviado.");
  }

  const client = ctx.getClient();
  const rows = await client.searchStream(args.customerId,
    `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type,
            ad_group_ad.ad.resource_name, campaign.id, campaign.name, campaign.advertising_channel_type,
            ${adSelectFields(specs).join(", ")}
     FROM ad_group_ad
     WHERE ad_group_ad.ad.id = ${args.adId}
       AND ad_group_ad.status != 'REMOVED'`);
  if (rows.length === 0) return fail(`Anúncio ${args.adId} não encontrado (ou removido) na conta ${cid}. Nada foi gravado.`);
  const ad = obj(obj(rows[0].adGroupAd).ad);
  const campaign = obj(rows[0].campaign);
  const adType = str(ad.type);
  const adSpec = specs.find((s) => s.adType === adType);
  if (!adSpec) {
    return fail(
      `Anúncio ${args.adId} é ${adType || "de tipo desconhecido"}; ${toolName} edita só ${specs.map((s) => s.adType).join(", ")}. ` +
        "O AdService não permite editar TextAd, ExpandedDynamicSearchAd, GmailAd nem ImageAd; RSA se edita com update_ad. Nada foi gravado."
    );
  }
  const plan = await planAdUpdate(client, args.customerId, cid, adSpec, obj(ad[adSpec.key]), request);
  if (plan.errors.length) return fail(`Nada foi gravado:\n- ${plan.errors.join("\n- ")}`);
  const adInfo = {
    ad_id: args.adId,
    type: adType,
    campaign: `${str(campaign.id)} (${str(campaign.name)})`,
    ad_groups: rows.length,
  };
  if (plan.paths.length === 0) {
    return {
      content: [text(`${adSpec.label} ${args.adId}: nada a mudar — o anúncio já está assim. Nenhuma escrita foi enviada.\n\n` +
        formatJson({ ad: adInfo, notes: plan.notes }))],
    };
  }
  const updateMask = plan.paths.map((p) => `${adSpec.path}.${p}`).join(",");
  const update = { resourceName: `customers/${cid}/ads/${args.adId}`, [adSpec.key]: plan.payload };
  const dryRun = client.isDryRun;
  try {
    await client.mutate(args.customerId, "ads", [{ update, updateMask }]);
  } catch (err) {
    return fail(`A API recusou a alteração do anúncio ${args.adId}${dryRun ? " (validação, nada gravado)" : " — nada foi gravado"}.\n${explainApiError((err as Error).message)}`);
  }
  const header = dryRun
    ? `${adSpec.label} ${args.adId} — DRY-RUN (validateOnly): validado, nada foi gravado.`
    : `${adSpec.label} ${args.adId} atualizado. O anúncio volta para análise de política.`;
  return {
    content: [text(`${header}\n\n` + formatJson({ ad: adInfo, update_mask: updateMask, before: plan.before, after: plan.after, notes: plan.notes }))],
  };
}

// ── Registro ───────────────────────────────────────────────────────────

const creativeSchema = {
  headlines: flexArray(z.string()).optional().describe("Títulos (HEADLINE): 3 a 15, até 30 caracteres."),
  longHeadlines: flexArray(z.string()).optional().describe("Títulos longos (LONG_HEADLINE): 1 a 5, até 90 caracteres."),
  descriptions: flexArray(z.string()).optional().describe(
    `Descrições (DESCRIPTION): 2 a 5, até 90 caracteres; ao menos uma com até ${SHORT_DESCRIPTION_MAX_CHARS}.`
  ),
  businessName: z.string().optional().describe("Nome da empresa (até 25 caracteres) — cria o asset TEXT no mesmo pedido."),
  businessNameAsset: z.string().optional().describe("OU um asset TEXT existente com o nome da empresa (ID ou resource name)."),
  marketingImageAssets: flexArray(z.string()).optional().describe("Imagens paisagem 1.91:1 (MARKETING_IMAGE): 1 a 20. ID ou resource name."),
  squareMarketingImageAssets: flexArray(z.string()).optional().describe("Imagens quadradas 1:1 (SQUARE_MARKETING_IMAGE): 1 a 20."),
  portraitMarketingImageAssets: flexArray(z.string()).optional().describe("Imagens retrato 4:5 (PORTRAIT_MARKETING_IMAGE): até 20, opcional."),
  logoAssets: flexArray(z.string()).optional().describe("Logos quadrados 1:1 (LOGO)."),
  landscapeLogoAssets: flexArray(z.string()).optional().describe("Logos paisagem 4:1 (LANDSCAPE_LOGO), opcional."),
  videoAssets: flexArray(z.string()).optional().describe("Vídeos do YouTube já cadastrados como asset (YOUTUBE_VIDEO): até 15, opcional."),
  callToAction: z.enum(CALL_TO_ACTION_TYPES).optional().describe("Call-to-action fixo (CALL_TO_ACTION_SELECTION). Omitido = automático."),
};

export function registerPmaxAssetsTools(ctx: ToolContext): void {
  // ── create_pmax_campaign ──────────────────────────────────────────────
  ctx.mcp.registerTool(
    "create_pmax_campaign",
    {
      description: [
        "Cria uma campanha Performance Max completa num ÚNICO pedido atômico (googleAds:mutate): orçamento,",
        "campanha, assets de texto, nome da empresa e logos na campanha (diretrizes de marca), asset group com",
        "todos os vínculos, raiz do listing group (varejo), sinal de público opcional, local Brasil e idioma português.",
        "WRITE OPERATION — campanha e asset group nascem PAUSADOS. Se qualquer parte for recusada, nada é criado.",
        "",
        "Mínimos da API v25 (conferidos antes de enviar):",
        "- headlines 3-15 (30 caracteres), longHeadlines 1-5 (90), descriptions 2-5 (90, ao menos uma com até 60);",
        "- 1+ imagem paisagem 1.91:1 e 1+ quadrada 1:1 (até 20 cada); retrato 4:5 opcional (até 20);",
        "- diretrizes de marca: exatamente 1 nome da empresa (businessName ou businessNameAsset) e 1+ logo 1:1;",
        "  logos + logos paisagem 4:1 somam no máximo 5 — todos são vinculados na campanha;",
        "- vídeos até 15; call-to-action opcional; cores (principal + destaque) e fonte da marca opcionais.",
        "",
        "Varejo (merchantId): o asset group pode ir SEM nenhum asset (o Google gera a partir do feed) ou com o",
        "conjunto mínimo completo; a raiz do listing group (todos os produtos) é criada no mesmo pedido.",
        "feedLabel é opcional: sem ele a campanha usa todos os feeds do Merchant Center.",
        "Imagens e vídeos: IDs ou resource names de upload_image_asset / get_image_assets / get_video_assets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da campanha (único na conta)."),
        dailyBudgetMicros: z.number().describe("Orçamento diário em MICROS (1000000 = R$1)."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]).optional()
          .describe("Estratégia de lance. Padrão: MAXIMIZE_CONVERSION_VALUE."),
        targetRoas: z.number().optional().describe("ROAS alvo (ex.: 5.0 = 500%). Só com MAXIMIZE_CONVERSION_VALUE."),
        assetGroupName: z.string().describe("Nome do asset group."),
        finalUrl: z.string().describe("URL final (landing page)."),
        finalMobileUrl: z.string().optional().describe("URL final mobile (opcional)."),
        path1: z.string().optional().describe("Caminho de exibição 1 (opcional)."),
        path2: z.string().optional().describe("Caminho de exibição 2 (exige path1)."),
        ...creativeSchema,
        brandMainColor: z.string().optional().describe("Cor principal da marca, hex (#1A2B3C). Vai junto com brandAccentColor."),
        brandAccentColor: z.string().optional().describe("Cor de destaque da marca, hex. Vai junto com brandMainColor."),
        brandFontFamily: z.enum(BRAND_FONTS).optional().describe("Fonte da marca (lista fechada do Google)."),
        merchantId: z.string().optional().describe("ID do Merchant Center (PMax de varejo)."),
        feedLabel: z.string().optional().describe("Feed label do Merchant Center (opcional; sem ele, todos os feeds)."),
        audienceResourceName: z.string().optional().describe(
          "Público (customers/{id}/audiences/{id}) para o sinal do asset group. Listas de remarketing precisam virar público antes (create_audience_from_lists)."
        ),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = args.customerId.replace(/-/g, "");
      const errors: string[] = [];
      if (!/^\d+$/.test(cid)) errors.push(`customerId inválido: "${args.customerId}".`);
      const name = args.name.trim();
      if (!name) errors.push("name vazio.");
      if (!isPositiveMicros(args.dailyBudgetMicros)) {
        errors.push(`dailyBudgetMicros deve ser um inteiro positivo em micros, recebido ${args.dailyBudgetMicros}.`);
      }
      const strategy = args.biddingStrategy ?? "MAXIMIZE_CONVERSION_VALUE";
      if (args.targetRoas !== undefined) {
        if (!(args.targetRoas > 0)) errors.push(`targetRoas deve ser positivo, recebido ${args.targetRoas}.`);
        if (strategy !== "MAXIMIZE_CONVERSION_VALUE") errors.push("targetRoas só vale com MAXIMIZE_CONVERSION_VALUE.");
      }
      const groupName = parseGroupName(args.assetGroupName, errors);
      const urls = parseGroupUrls(args, errors);
      const merchantId = args.merchantId?.trim() || undefined;
      if (merchantId && !/^\d+$/.test(merchantId)) errors.push(`merchantId deve ser numérico, recebido "${merchantId}".`);
      const feedLabel = args.feedLabel?.trim() || undefined;
      if (feedLabel && !merchantId) errors.push("feedLabel só vale com merchantId.");
      if (feedLabel && !/^[A-Z0-9_-]{1,20}$/.test(feedLabel)) {
        errors.push(`feedLabel inválido: "${feedLabel}" (até 20 caracteres: letras maiúsculas, números, - e _).`);
      }
      const mainColor = args.brandMainColor?.trim() || undefined;
      const accentColor = args.brandAccentColor?.trim() || undefined;
      if (Boolean(mainColor) !== Boolean(accentColor)) errors.push("brandMainColor e brandAccentColor vão juntas (a API exige as duas).");
      for (const [label, color] of [["brandMainColor", mainColor], ["brandAccentColor", accentColor]] as const) {
        if (color && !HEX_COLOR.test(color)) errors.push(`${label} deve ser hex como #1A2B3C, recebido "${color}".`);
      }
      const audience = args.audienceResourceName?.trim() || undefined;
      if (audience) {
        const match = /^customers\/(\d+)\/audiences\/(\d+)$/.exec(audience);
        if (!match) {
          errors.push(`audienceResourceName precisa ser customers/{id}/audiences/{id} (recebido "${audience}"). Lista de remarketing vira público com create_audience_from_lists.`);
        } else if (match[1] !== cid) {
          errors.push(`audienceResourceName pertence à conta ${match[1]}, não à ${cid}.`);
        }
      }

      const creative = parseCreative(args, cid, errors);
      const counts = creativeCounts(creative);
      errors.push(...maxProblems(counts));
      const logosTotal = counts.LOGO + counts.LANDSCAPE_LOGO;
      const retail = Boolean(merchantId);
      const assetless = retail && nonBrandTotal(counts) === 0;
      const brandGiven = brandTotal(counts) > 0;
      if (!assetless || brandGiven) {
        // Diretrizes de marca: 1 nome da empresa e ≥1 logo na campanha, no mesmo pedido
        if (counts.BUSINESS_NAME !== 1) errors.push("Diretrizes de marca: informe exatamente um nome da empresa (businessName ou businessNameAsset).");
        if (counts.LOGO < 1) errors.push("Diretrizes de marca: informe ao menos um logo quadrado 1:1 (logoAssets).");
        if (logosTotal > CAMPAIGN_BRAND_LOGO_MAX) {
          errors.push(`Diretrizes de marca: logos + logos paisagem somam ${logosTotal} (máximo ${CAMPAIGN_BRAND_LOGO_MAX}).`);
        }
      }
      if (!assetless) {
        const problems = newGroupProblems(counts, shortDescriptionCount(creative.texts.DESCRIPTION), false);
        if (problems.length) {
          errors.push(`Asset group abaixo do mínimo da API: ${problems.join("; ")}.` +
            (retail ? " Em varejo, o asset group pode ir sem nenhum asset ou com o conjunto mínimo completo." : ""));
        }
      }
      if (errors.length) return fail(`Nada foi enviado — entrada inválida:\n- ${errors.join("\n- ")}`);

      const client = ctx.getClient();
      const duplicated = await client.searchStream(args.customerId,
        `SELECT campaign.id, campaign.name, campaign.status
         FROM campaign
         WHERE campaign.name = '${gaqlLiteral(name)}'
           AND campaign.status != 'REMOVED'`);
      if (duplicated.length > 0) {
        return fail(`Já existe a campanha "${name}" (id ${str(obj(duplicated[0].campaign).id)}) nesta conta. Use outro nome. Nada foi gravado.`);
      }
      const assetErrors = await checkCreativeAssets(client, args.customerId, cid, creative);
      if (assetErrors.length) return fail(`Nada foi gravado:\n- ${assetErrors.join("\n- ")}`);

      const ids = new TempIds();
      const budgetRn = `customers/${cid}/campaignBudgets/${ids.next()}`;
      const campaignRn = `customers/${cid}/campaigns/${ids.next()}`;
      const groupRn = `customers/${cid}/assetGroups/${ids.next()}`;
      const campaignCreate: Row = {
        resourceName: campaignRn,
        name,
        status: "PAUSED",
        advertisingChannelType: "PERFORMANCE_MAX",
        campaignBudget: budgetRn,
        containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        brandGuidelinesEnabled: true,
        ...(strategy === "MAXIMIZE_CONVERSION_VALUE"
          ? { maximizeConversionValue: args.targetRoas ? { targetRoas: args.targetRoas } : {} }
          : { maximizeConversions: {} }),
      };
      if (mainColor || args.brandFontFamily) {
        campaignCreate.brandGuidelines = {
          ...(mainColor ? { mainColor, accentColor } : {}),
          ...(args.brandFontFamily ? { predefinedFontFamily: args.brandFontFamily } : {}),
        };
      }
      if (merchantId) campaignCreate.shoppingSetting = { merchantId, ...(feedLabel ? { feedLabel } : {}) };

      const built = buildCreativeOps(cid, creative, ids, { assetGroup: groupRn, campaign: campaignRn, brandLevel: "campaign" });
      const groupCreate: Row = {
        resourceName: groupRn,
        name: groupName,
        campaign: campaignRn,
        status: "PAUSED",
        finalUrls: [urls.finalUrl],
        ...(urls.finalMobileUrl ? { finalMobileUrls: [urls.finalMobileUrl] } : {}),
        ...(urls.path1 ? { path1: urls.path1 } : {}),
        ...(urls.path2 ? { path2: urls.path2 } : {}),
      };
      const operations: Row[] = [
        {
          campaignBudgetOperation: {
            create: { resourceName: budgetRn, name: `Budget — ${name}`, amountMicros: String(args.dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false },
          },
        },
        { campaignOperation: { create: campaignCreate } },
        ...built.assetOps,
        ...built.campaignLinkOps,
        { assetGroupOperation: { create: groupCreate } },
        ...built.groupLinkOps,
        ...(retail ? [listingRootOp(groupRn)] : []),
        ...(audience ? [{ assetGroupSignalOperation: { create: { assetGroup: groupRn, audience: { audience } } } }] : []),
        { campaignCriterionOperation: { create: { campaign: campaignRn, location: { geoTargetConstant: "geoTargetConstants/2076" }, negative: false } } },
        { campaignCriterionOperation: { create: { campaign: campaignRn, language: { languageConstant: "languageConstants/1014" } } } },
      ];

      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.batchMutate(args.customerId, operations);
      } catch (err) {
        const message = explainApiError((err as Error).message);
        if (dryRun) return fail(`DRY-RUN (validateOnly): a API recusou — nada foi gravado.\n${message}`);
        const after = await safely(() => client.searchStream(args.customerId,
          `SELECT campaign.id, campaign.name, campaign.status
           FROM campaign
           WHERE campaign.name = '${gaqlLiteral(name)}'
             AND campaign.status != 'REMOVED'`));
        if (after === null) {
          return fail(`A requisição falhou e não deu para conferir a conta depois — resultado INCERTO. Procure a campanha "${name}" antes de repetir.\nErro: ${message}`);
        }
        if (after.length > 0) {
          return fail(`A requisição devolveu erro, mas a campanha "${name}" existe (id ${str(obj(after[0].campaign).id)}). Confira antes de repetir.\nErro: ${message}`);
        }
        return fail(`A API recusou a criação — nada foi gravado (pedido atômico; conferido na conta).\n${message}`);
      }
      const responses = mutateResponses(response);
      const campaignResult = resultResourceName(responses, "campaignResult");
      const groupResult = resultResourceName(responses, "assetGroupResult");
      if (!dryRun && (!campaignResult || !groupResult)) {
        return fail(`A API respondeu sem confirmar a campanha e o asset group. Confira na conta antes de repetir.\n${formatJson(response)}`);
      }
      const summary = {
        dry_run: dryRun,
        campaign: campaignResult ?? "(validado, sem ID — nada gravado)",
        asset_group: groupResult ?? "(validado, sem ID — nada gravado)",
        name,
        budget_per_day: `R$ ${(args.dailyBudgetMicros / 1_000_000).toFixed(2)}`,
        bidding: `${strategy}${args.targetRoas ? ` (ROAS alvo ${args.targetRoas})` : ""}`,
        brand_guidelines: {
          business_name: counts.BUSINESS_NAME ? (creative.businessNameText ?? creative.businessNameRef?.resourceName) : "(varejo sem assets: não exigido)",
          logos: counts.LOGO,
          landscape_logos: counts.LANDSCAPE_LOGO,
          ...(mainColor ? { main_color: mainColor, accent_color: accentColor } : {}),
          ...(args.brandFontFamily ? { font: args.brandFontFamily } : {}),
        },
        asset_group_assets: assetless ? "nenhum (varejo: o Google gera a partir do feed)" : nonZero(counts),
        merchant_center: merchantId ? { merchant_id: merchantId, feed_label: feedLabel ?? "(todos os feeds)", listing_group: "raiz UNIT_INCLUDED (todos os produtos)" } : undefined,
        audience_signal: audience,
        targeting: "local Brasil (geoTargetConstants/2076) + idioma português (languageConstants/1014)",
        operations: operations.length,
      };
      const header = dryRun
        ? `DRY-RUN (validateOnly): a API validou o pedido inteiro — nada foi gravado.`
        : `Campanha PMax criada (PAUSADA): ${name}`;
      const next = dryRun
        ? "Para gravar, repita fora do modo validação (sem validateOnly e sem GOOGLE_ADS_DRY_RUN)."
        : "Próximos passos: confira com list_asset_group_assets; ative o asset group (update_asset_group status ENABLED) e depois a campanha (update_campaign).";
      return { content: [text(`${header}\n\n${formatJson(summary)}\n\n${next}`)] };
    }
  );

  // ── create_asset_group ────────────────────────────────────────────────
  ctx.mcp.registerTool(
    "create_asset_group",
    {
      description: [
        "Cria um asset group numa campanha Performance Max existente, num ÚNICO pedido atômico (googleAds:mutate):",
        "assets de texto novos + asset group + todos os vínculos (+ raiz do listing group em varejo).",
        "WRITE OPERATION — o asset group nasce PAUSADO. Se a API recusar qualquer parte, nada é criado.",
        "",
        "Antes de enviar, lê a campanha: precisa ser PERFORMANCE_MAX (Demand Gen usa grupos de anúncios, não asset",
        "groups), confere nome único e o limite de 100 asset groups, e aplica as regras da v25:",
        "- headlines 3-15 (30), longHeadlines 1-5 (90), descriptions 2-5 (90, ao menos uma com até 60);",
        "- 1+ imagem paisagem 1.91:1 e 1+ quadrada 1:1 (até 20 cada); retrato 4:5, vídeos (até 15) e CTA opcionais;",
        "- diretrizes de marca LIGADAS: nome da empresa e logos ficam na campanha — não informe aqui;",
        "- diretrizes DESLIGADAS: exatamente 1 nome da empresa e 1-5 logos 1:1 no próprio asset group",
        "  (logos paisagem 4:1 opcionais);",
        "- varejo (Merchant Center): pode criar SEM nenhum asset (o Google gera do feed) ou com o mínimo completo;",
        "  a raiz do listing group (todos os produtos) é criada junto. URL final no domínio do Merchant Center.",
        "Imagens/vídeos: IDs ou resource names desta conta (upload_image_asset, get_image_assets, get_video_assets).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha Performance Max."),
        name: z.string().describe("Nome do asset group (1-128 caracteres, único na campanha)."),
        finalUrl: z.string().describe("URL final (landing page)."),
        finalMobileUrl: z.string().optional().describe("URL final mobile (opcional)."),
        path1: z.string().optional().describe("Caminho de exibição 1 (opcional)."),
        path2: z.string().optional().describe("Caminho de exibição 2 (exige path1)."),
        ...creativeSchema,
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = args.customerId.replace(/-/g, "");
      const errors: string[] = [];
      if (!/^\d+$/.test(cid)) errors.push(`customerId inválido: "${args.customerId}".`);
      if (!/^\d+$/.test(args.campaignId)) errors.push(`campaignId deve ser numérico, recebido "${args.campaignId}".`);
      const name = parseGroupName(args.name, errors);
      const urls = parseGroupUrls(args, errors);
      const creative = parseCreative(args, cid, errors);
      const counts = creativeCounts(creative);
      errors.push(...maxProblems(counts));
      if (errors.length) return fail(`Nada foi enviado — entrada inválida:\n- ${errors.join("\n- ")}`);

      const client = ctx.getClient();
      const campaign = await fetchCampaign(client, args.customerId, cid, args.campaignId);
      if (!campaign) return fail(`Campanha ${args.campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (campaign.channel !== "PERFORMANCE_MAX") {
        return fail(
          `Campanha ${args.campaignId} ("${campaign.name}") é ${campaign.channel}, não PERFORMANCE_MAX. ` +
            "Asset groups existem só em Performance Max (Demand Gen usa grupos de anúncios e anúncios). Nada foi gravado."
        );
      }
      if (campaign.status === "REMOVED") return fail(`Campanha ${args.campaignId} ("${campaign.name}") está removida. Nada foi gravado.`);

      const groups = (await fetchCampaignGroups(client, args.customerId, campaign.resourceName)).filter((g) => g.status !== "REMOVED");
      const sameName = groups.find((g) => g.name === name);
      if (sameName) return fail(`Já existe o asset group "${name}" (id ${sameName.id}) nesta campanha. Use outro nome. Nada foi gravado.`);
      if (groups.length >= MAX_ASSET_GROUPS_PER_CAMPAIGN) {
        return fail(`A campanha já tem ${groups.length} asset groups (máximo ${MAX_ASSET_GROUPS_PER_CAMPAIGN}). Nada foi gravado.`);
      }

      const retail = Boolean(campaign.merchantId);
      const brandGiven = brandTotal(counts) > 0;
      const assetless = retail && nonBrandTotal(counts) === 0 && !brandGiven;
      let brandLevel: BrandLevel = campaign.brandGuidelines ? "none" : "group";
      let campaignBrandNote = campaign.brandGuidelines ? "herdados da campanha (diretrizes de marca)" : "no asset group (diretrizes de marca desligadas)";
      if (!assetless) {
        const problems: string[] = [];
        if (campaign.brandGuidelines) {
          const links = (await fetchCampaignBrandLinks(client, args.customerId, [campaign.resourceName])).get(campaign.resourceName) ?? [];
          const existing = brandCounts(links);
          if (existing.businessName > 0 && existing.logo > 0) {
            if (brandGiven) {
              return fail(
                "A campanha está com as diretrizes de marca LIGADAS e já tem nome da empresa e logo na campanha — " +
                  "eles valem para todos os asset groups. Retire businessName/businessNameAsset/logoAssets/landscapeLogoAssets " +
                  "(a troca dos assets de marca da campanha é outra operação). Nada foi gravado."
              );
            }
          } else {
            // Varejo sem assets de marca: ao ganhar assets, a campanha precisa de nome e logo no MESMO pedido
            if (existing.businessName > 0 && counts.BUSINESS_NAME > 0) problems.push("a campanha já tem BUSINESS_NAME; não informe outro");
            if (existing.businessName === 0 && counts.BUSINESS_NAME !== 1) problems.push("informe o nome da empresa (businessName ou businessNameAsset) — vai para a campanha");
            if (existing.logo === 0 && counts.LOGO === 0) problems.push("informe ao menos um logo 1:1 (logoAssets) — vai para a campanha");
            const totalLogos = existing.logo + existing.landscapeLogo + counts.LOGO + counts.LANDSCAPE_LOGO;
            if (totalLogos > CAMPAIGN_BRAND_LOGO_MAX) problems.push(`logos na campanha somariam ${totalLogos} (máximo ${CAMPAIGN_BRAND_LOGO_MAX})`);
            brandLevel = "campaign";
            campaignBrandNote = "vinculados na campanha neste mesmo pedido (a campanha ainda não tinha nome/logo)";
          }
        }
        problems.push(...newGroupProblems(counts, shortDescriptionCount(creative.texts.DESCRIPTION), brandLevel === "group"));
        if (problems.length) {
          return fail(
            `Nada foi gravado — o asset group não atende às regras da API:\n- ${problems.join("\n- ")}` +
              (retail ? "\nEm varejo, o asset group pode ser criado sem nenhum asset (o Google gera do feed) ou com o conjunto mínimo completo." : "")
          );
        }
      }

      const assetErrors = await checkCreativeAssets(client, args.customerId, cid, creative);
      if (assetErrors.length) return fail(`Nada foi gravado:\n- ${assetErrors.join("\n- ")}`);

      const ids = new TempIds();
      const groupRn = `customers/${cid}/assetGroups/${ids.next()}`;
      const built = buildCreativeOps(cid, creative, ids, { assetGroup: groupRn, campaign: campaign.resourceName, brandLevel });
      const groupCreate: Row = {
        resourceName: groupRn,
        name,
        campaign: campaign.resourceName,
        status: "PAUSED",
        finalUrls: [urls.finalUrl],
        ...(urls.finalMobileUrl ? { finalMobileUrls: [urls.finalMobileUrl] } : {}),
        ...(urls.path1 ? { path1: urls.path1 } : {}),
        ...(urls.path2 ? { path2: urls.path2 } : {}),
      };
      const operations: Row[] = [
        ...built.assetOps,
        ...built.campaignLinkOps,
        { assetGroupOperation: { create: groupCreate } },
        ...built.groupLinkOps,
        ...(retail ? [listingRootOp(groupRn)] : []),
      ];

      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.batchMutate(args.customerId, operations);
      } catch (err) {
        const message = explainApiError((err as Error).message);
        if (dryRun) return fail(`DRY-RUN (validateOnly): a API recusou — nada foi gravado.\n${message}`);
        // Pedido atômico: erro da API = nada gravado. Erro de transporte pode vir depois de gravar — confere.
        const after = await safely(() => fetchCampaignGroups(client, args.customerId, campaign.resourceName));
        if (after === null) {
          return fail(`A requisição falhou e não deu para conferir a conta depois — resultado INCERTO. Confira com list_asset_groups antes de repetir.\nErro: ${message}`);
        }
        const created = after.find((g) => g.name === name && g.status !== "REMOVED");
        if (created) {
          return fail(`A requisição devolveu erro, mas o asset group "${name}" existe (id ${created.id}). Confira com list_asset_group_assets.\nErro: ${message}`);
        }
        return fail(`A API recusou a criação — nada foi gravado (pedido atômico; conferido na conta).\n${message}`);
      }
      const groupResult = resultResourceName(mutateResponses(response), "assetGroupResult");
      if (!dryRun && !groupResult) {
        return fail(`A API respondeu sem confirmar o asset group. Confira com list_asset_groups antes de repetir.\n${formatJson(response)}`);
      }
      const summary = {
        dry_run: dryRun,
        campaign: { id: campaign.id, name: campaign.name, brand_guidelines: campaign.brandGuidelines, retail_merchant_id: campaign.merchantId },
        asset_group: {
          resource_name: groupResult ?? "(validado, sem ID — nada gravado)",
          name,
          status: "PAUSED",
          final_urls: [urls.finalUrl],
          ...(urls.finalMobileUrl ? { final_mobile_urls: [urls.finalMobileUrl] } : {}),
          ...(urls.path1 ? { path1: urls.path1 } : {}),
          ...(urls.path2 ? { path2: urls.path2 } : {}),
        },
        assets: assetless ? "nenhum (varejo: o Google gera a partir do feed)" : nonZero(counts),
        brand_assets: assetless ? "não exigidos (grupo sem assets)" : campaignBrandNote,
        listing_group: retail ? "raiz UNIT_INCLUDED (todos os produtos)" : undefined,
        operations: operations.length,
      };
      const header = dryRun
        ? "DRY-RUN (validateOnly): a API validou o pedido inteiro — nada foi gravado."
        : `Asset group criado (PAUSADO): ${name}`;
      const next = dryRun
        ? "Para gravar, repita fora do modo validação (sem validateOnly e sem GOOGLE_ADS_DRY_RUN)."
        : "Próximos passos: confira com list_asset_group_assets e ative com update_asset_group (status ENABLED).";
      return { content: [text(`${header}\n\n${formatJson(summary)}\n\n${next}`)] };
    }
  );

  // ── update_asset_group ────────────────────────────────────────────────
  ctx.mcp.registerTool(
    "update_asset_group",
    {
      description: [
        "Altera nome, status, URL final, URL final mobile e caminhos de exibição (path1/path2) de um asset group.",
        "WRITE OPERATION — lê o asset group antes, mostra antes/depois e não envia nada se não houver mudança.",
        "Para trocar textos, imagens, vídeos ou logos do asset group use update_asset_group_assets.",
        "finalMobileUrl, path1 e path2 aceitam \"\" para limpar. path2 exige path1.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("ID numérico do asset group."),
        name: z.string().optional().describe("Novo nome (1-128 caracteres, único na campanha)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Novo status."),
        finalUrl: z.string().optional().describe("Nova URL final (substitui a lista de URLs finais)."),
        finalMobileUrl: z.string().optional().describe("Nova URL final mobile (\"\" limpa)."),
        path1: z.string().optional().describe("Caminho de exibição 1 (\"\" limpa)."),
        path2: z.string().optional().describe("Caminho de exibição 2 (\"\" limpa; exige path1)."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = args.customerId.replace(/-/g, "");
      const errors: string[] = [];
      if (!/^\d+$/.test(cid)) errors.push(`customerId inválido: "${args.customerId}".`);
      if (!/^\d+$/.test(args.assetGroupId)) errors.push(`assetGroupId deve ser numérico, recebido "${args.assetGroupId}".`);
      const name = args.name !== undefined ? parseGroupName(args.name, errors) : undefined;
      const finalUrl = args.finalUrl?.trim();
      if (finalUrl !== undefined && !isHttpUrl(finalUrl)) errors.push(`finalUrl inválida: "${args.finalUrl}" (o asset group precisa de uma URL final).`);
      const finalMobileUrl = args.finalMobileUrl?.trim();
      if (finalMobileUrl && !isHttpUrl(finalMobileUrl)) errors.push(`finalMobileUrl inválida: "${finalMobileUrl}".`);
      const path1 = args.path1?.trim();
      const path2 = args.path2?.trim();
      const given = [name, args.status, finalUrl, finalMobileUrl, path1, path2].some((v) => v !== undefined);
      if (!given) errors.push("Informe ao menos um campo para alterar (name, status, finalUrl, finalMobileUrl, path1, path2).");
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = ctx.getClient();
      const rows = await client.searchStream(args.customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.campaign,
                asset_group.final_urls, asset_group.final_mobile_urls, asset_group.path1, asset_group.path2,
                campaign.id, campaign.name
         FROM asset_group
         WHERE asset_group.id = ${args.assetGroupId}`);
      if (rows.length === 0) return fail(`Asset group ${args.assetGroupId} não encontrado na conta ${cid}. Nada foi gravado.`);
      const group = obj(rows[0].assetGroup);
      if (str(group.status) === "REMOVED") return fail(`Asset group ${args.assetGroupId} está removido. Nada foi gravado.`);
      const current = {
        name: str(group.name),
        status: str(group.status),
        final_urls: arr(group.finalUrls).map(str),
        final_mobile_urls: arr(group.finalMobileUrls).map(str),
        path1: str(group.path1),
        path2: str(group.path2),
      };
      const update: Row = { resourceName: `customers/${cid}/assetGroups/${args.assetGroupId}` };
      const fields: string[] = [];
      const before: Row = {};
      const after: Row = {};
      const change = (key: keyof typeof current, mask: string, prop: string, value: unknown) => {
        if (JSON.stringify(current[key]) === JSON.stringify(value)) return;
        update[prop] = value;
        fields.push(mask);
        before[key] = current[key];
        after[key] = value;
      };
      if (name !== undefined) change("name", "name", "name", name);
      if (args.status) change("status", "status", "status", args.status);
      if (finalUrl !== undefined) change("final_urls", "final_urls", "finalUrls", [finalUrl]);
      if (finalMobileUrl !== undefined) change("final_mobile_urls", "final_mobile_urls", "finalMobileUrls", finalMobileUrl ? [finalMobileUrl] : []);
      if (path1 !== undefined) change("path1", "path1", "path1", path1);
      if (path2 !== undefined) change("path2", "path2", "path2", path2);
      const effectivePath1 = path1 !== undefined ? path1 : current.path1;
      const effectivePath2 = path2 !== undefined ? path2 : current.path2;
      if (effectivePath2 && !effectivePath1) {
        return fail("path2 exige path1 (AssetGroupError.PATH1_REQUIRED_WHEN_PATH2_IS_SET): informe path1 ou limpe path2. Nada foi gravado.");
      }
      const groupInfo = { asset_group_id: args.assetGroupId, campaign: `${str(obj(rows[0].campaign).id)} (${str(obj(rows[0].campaign).name)})` };
      if (fields.length === 0) {
        return { content: [text(`Asset group ${args.assetGroupId}: nada a mudar — já está assim. Nenhuma escrita foi enviada.\n\n${formatJson({ ...groupInfo, current })}`)] };
      }
      if (fields.includes("name")) {
        const siblings = await fetchCampaignGroups(client, args.customerId, str(group.campaign));
        const clash = siblings.find((g) => g.name === name && g.id !== args.assetGroupId && g.status !== "REMOVED");
        if (clash) return fail(`Já existe o asset group "${name}" (id ${clash.id}) nesta campanha. Nada foi gravado.`);
      }
      const dryRun = client.isDryRun;
      try {
        await client.mutateAssetGroups(args.customerId, [{ update, updateMask: fields.join(",") }]);
      } catch (err) {
        return fail(`A API recusou a alteração${dryRun ? " (validação, nada gravado)" : " — nada foi gravado"}.\n${explainApiError((err as Error).message)}`);
      }
      const header = dryRun
        ? `Asset group ${args.assetGroupId} — DRY-RUN (validateOnly): validado, nada foi gravado.`
        : `Asset group ${args.assetGroupId} atualizado: ${fields.join(", ")}.`;
      return { content: [text(`${header}\n\n${formatJson({ ...groupInfo, update_mask: fields.join(","), before, after })}`)] };
    }
  );

  // ── list_asset_groups ─────────────────────────────────────────────────
  ctx.mcp.registerTool(
    "list_asset_groups",
    {
      description: [
        "Lista os asset groups de uma campanha Performance Max. READ OPERATION.",
        "Por asset group: status, ad strength, primary_status com os motivos (em PT-BR), URLs, path1/path2 e os",
        "itens de cobertura de assets do Google (ex.: 'adicionar 3 HEADLINE', 'adicionar 1 YOUTUBE_VIDEO (vertical 9:16)').",
        "Para ver cada asset vinculado use list_asset_group_assets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${GROUP_FIELDS_SELECT}
         FROM asset_group
         WHERE campaign.id = ${campaignId}
           AND asset_group.status != 'REMOVED'`);
      const groups = rows.map(groupView);
      if (format === "table" || format === "csv") {
        const flat = groups.map((g) => ({
          ...g,
          primary_status_reasons: g.primary_status_reasons.join("; "),
          final_urls: g.final_urls.join(" "),
          final_mobile_urls: g.final_mobile_urls.join(" "),
          coverage_actions: g.coverage_actions.join("; "),
        }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      return { content: [text(`${groups.length} asset group(s).\n\n${formatJson(groups)}`)] };
    }
  );

  // ── list_asset_group_assets ───────────────────────────────────────────
  ctx.mcp.registerTool(
    "list_asset_group_assets",
    {
      description: [
        "Lista os assets vinculados aos asset groups de Performance Max, agrupados por tipo de campo. READ OPERATION.",
        "Informe assetGroupId OU campaignId (todos os asset groups da campanha).",
        "",
        "Por asset group: contagem por tipo contra o mínimo/máximo da API (nome da empresa e logos contam na",
        "campanha quando as diretrizes de marca estão ligadas), descrição curta (até 60), itens de cobertura do Google",
        "(ex.: 'adicionar 3 HEADLINE'), ad strength e motivos de status. Por asset: ID, texto/nome, dimensões,",
        "vídeo, status do vínculo, origem (anunciante ou criado automaticamente), primary_status com motivos e política.",
        "Use antes de update_asset_group_assets para escolher o que trocar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().optional().describe("ID numérico do asset group."),
        campaignId: z.string().optional().describe("OU ID numérico da campanha (lista todos os asset groups dela)."),
        fieldTypes: flexArray(z.enum(GROUP_FIELD_TYPES as [GroupFieldType, ...GroupFieldType[]])).optional()
          .describe("Filtra por tipo de campo (ex.: [\"HEADLINE\", \"MARKETING_IMAGE\"])."),
        includeRemoved: z.boolean().optional().describe("Inclui vínculos removidos. Padrão: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, assetGroupId, campaignId, fieldTypes, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (Boolean(assetGroupId) === Boolean(campaignId)) return fail("Informe assetGroupId OU campaignId (um dos dois).");
      const id = (assetGroupId ?? campaignId)!;
      if (!/^\d+$/.test(id)) return fail(`${assetGroupId ? "assetGroupId" : "campaignId"} deve ser numérico, recebido "${id}".`);
      const types = ensureArray<string>(fieldTypes).map(str);
      const invalidTypes = types.filter((t) => !GROUP_FIELD_TYPES.includes(t as GroupFieldType));
      if (invalidTypes.length) return fail(`fieldTypes inválido(s): ${invalidTypes.join(", ")}. Válidos: ${GROUP_FIELD_TYPES.join(", ")}.`);

      const client = ctx.getClient();
      const where = assetGroupId ? `asset_group.id = ${assetGroupId}` : `campaign.id = ${campaignId}`;
      const groupRows = await client.searchStream(customerId,
        `SELECT ${GROUP_FIELDS_SELECT}
         FROM asset_group
         WHERE ${where}${assetGroupId ? "" : "\n           AND asset_group.status != 'REMOVED'"}`);
      if (groupRows.length === 0) {
        return fail(assetGroupId ? `Asset group ${assetGroupId} não encontrado.` : `Nenhum asset group na campanha ${campaignId}.`);
      }
      const groups = groupRows.map(groupView);
      const listedIds = new Set(groups.map((g) => g.asset_group_id));
      const links = (await fetchGroupLinks(client, customerId, where, { includeRemoved: includeRemoved === true, fieldTypes: types, detailed: true }))
        .filter((l) => listedIds.has(l.groupId));
      const bgCampaigns = [...new Set(groups.filter((g) => g.brand_guidelines).map((g) => `customers/${customerId.replace(/-/g, "")}/campaigns/${g.campaign_id}`))];
      const brandLinks = await fetchCampaignBrandLinks(client, customerId, bgCampaigns);

      const assetRow = (link: GroupLink) => {
        const asset = obj(link.row.asset);
        const groupAsset = obj(link.row.assetGroupAsset);
        const policy = obj(groupAsset.policySummary);
        const { width, height } = imageSize(asset);
        const video = obj(asset.youtubeVideoAsset);
        return {
          asset_group_id: link.groupId,
          field_type: link.fieldType,
          asset_id: link.assetId,
          text: link.text,
          name: str(asset.name) || undefined,
          dimensions: width && height ? `${width}x${height}` : undefined,
          image_url: str(obj(obj(asset.imageAsset).fullSize).url) || undefined,
          youtube_video_id: str(video.youtubeVideoId) || undefined,
          youtube_video_title: str(video.youtubeVideoTitle) || undefined,
          call_to_action: str(obj(asset.callToActionAsset).callToAction) || undefined,
          status: link.status,
          source: link.source,
          primary_status: str(groupAsset.primaryStatus),
          primary_status_reasons: reasonsPt(groupAsset.primaryStatusReasons, LINK_REASON_PT),
          approval_status: str(policy.approvalStatus) || undefined,
          review_status: str(policy.reviewStatus) || undefined,
          policy_topics: arr(policy.policyTopicEntries).map((e) => str(obj(e).topic)).filter(Boolean),
        };
      };

      if (format === "table" || format === "csv") {
        const flat = links.map(assetRow).map((r) => ({
          ...r,
          primary_status_reasons: r.primary_status_reasons.join("; "),
          policy_topics: r.policy_topics.join("; "),
        }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }

      const report = groups.map((group) => {
        const groupLinks = links.filter((l) => l.groupId === group.asset_group_id);
        const { counts, shortDescriptions } = linkCounts(groupLinks);
        const campaignRn = `customers/${customerId.replace(/-/g, "")}/campaigns/${group.campaign_id}`;
        const campaignBrand = group.brand_guidelines ? brandCounts(brandLinks.get(campaignRn) ?? []) : undefined;
        const advertiserTotal = groupLinks.filter(countsForMinimum).length;
        const assetless = Boolean(group.retail_merchant_id) && advertiserTotal === 0 && types.length === 0;
        const requirements = GROUP_FIELD_TYPES
          .filter((field) => types.length === 0 || types.includes(field))
          .map((field) => {
            const rule = spec(field);
            const atCampaign = rule.brand && group.brand_guidelines;
            const linked = atCampaign
              ? field === "BUSINESS_NAME" ? campaignBrand!.businessName : field === "LOGO" ? campaignBrand!.logo : campaignBrand!.landscapeLogo
              : counts[field];
            const auto = groupLinks.filter((l) => l.fieldType === field && l.source === "AUTOMATICALLY_CREATED" && l.status !== "REMOVED").length;
            const min = atCampaign && field === "LANDSCAPE_LOGO" ? 0 : rule.min;
            const max = atCampaign ? (field === "BUSINESS_NAME" ? 1 : CAMPAIGN_BRAND_LOGO_MAX) : rule.max;
            const situation = assetless
              ? "grupo sem assets (varejo)"
              : linked < min ? `faltam ${min - linked}` : linked > max ? `acima do máximo em ${linked - max}` : "ok";
            return {
              field_type: field,
              level: atCampaign ? "campanha (diretrizes de marca)" : "asset group",
              linked,
              ...(auto ? { automatically_created: auto } : {}),
              min,
              max,
              situation,
            };
          });
        const byField: Record<string, unknown[]> = {};
        for (const link of groupLinks) (byField[link.fieldType] ??= []).push(assetRow(link));
        return {
          asset_group: group,
          ...(assetless ? { note: "Grupo de varejo sem assets: o Google gera anúncios do feed. Para adicionar assets, é preciso enviar o conjunto mínimo completo de uma vez." } : {}),
          requirements,
          short_description_ok: counts.DESCRIPTION === 0 ? null : shortDescriptions > 0,
          coverage_actions: group.coverage_actions,
          assets: byField,
        };
      });
      return { content: [text(`${groups.length} asset group(s), ${links.length} vínculo(s).\n\n${formatJson(report)}`)] };
    }
  );

  // ── update_asset_group_assets ─────────────────────────────────────────
  const assetChangeItem = z.object({
    fieldType: z.enum(GROUP_FIELD_TYPES as [GroupFieldType, ...GroupFieldType[]]).describe("Tipo de campo no asset group."),
    asset: z.string().optional().describe("Asset existente: ID numérico ou customers/{customerId}/assets/{assetId}."),
    text: z.string().optional().describe("Texto novo (HEADLINE, LONG_HEADLINE, DESCRIPTION, BUSINESS_NAME) — cria o asset no mesmo pedido."),
    callToAction: z.enum(CALL_TO_ACTION_TYPES).optional().describe("Para CALL_TO_ACTION_SELECTION: cria o asset de CTA."),
  });
  ctx.mcp.registerTool(
    "update_asset_group_assets",
    {
      description: [
        "Adiciona, remove ou troca assets de asset groups de Performance Max existentes, num ÚNICO pedido atômico",
        "(googleAds:mutate): cria os assets de texto/CTA, vincula os novos e depois remove os antigos.",
        "WRITE OPERATION. Remoção ou aplicação em mais de um asset group exige confirm: true (sem ele, mostra o plano",
        "e não grava). Com validateOnly a API só valida.",
        "",
        "add: [{fieldType, asset | text | callToAction}]; remove: [{fieldType, asset}]. Troca = add + remove juntos.",
        "Antes de enviar: lê os asset groups e os vínculos atuais, pula o que já está vinculado/o que não existe,",
        "e recusa o que a API recusaria — passar do máximo por tipo, ou uma remoção que deixe o grupo abaixo do",
        "mínimo (3 títulos, 1 título longo, 2 descrições com uma de até 60, 1 paisagem, 1 quadrada; nome da empresa",
        "e logo no grupo só com diretrizes de marca desligadas). Grupo de varejo sem assets só aceita o conjunto",
        "mínimo completo de uma vez. assetGroupIds com vários IDs aplica a mesma mudança em todos (tudo ou nada).",
        "Veja o estado atual com list_asset_group_assets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupIds: flexArray(z.string()).describe("ID(s) numérico(s) do(s) asset group(s). Até 20."),
        add: flexArray(assetChangeItem).optional().describe("Assets a vincular."),
        remove: flexArray(z.object({
          fieldType: z.enum(GROUP_FIELD_TYPES as [GroupFieldType, ...GroupFieldType[]]),
          asset: z.string().describe("ID numérico ou resource name do asset vinculado."),
        })).optional().describe("Vínculos a remover (o asset continua na biblioteca)."),
        confirm: z.boolean().optional().describe("true = aplicar remoções e mudanças em vários asset groups."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = args.customerId.replace(/-/g, "");
      const errors: string[] = [];
      if (!/^\d+$/.test(cid)) errors.push(`customerId inválido: "${args.customerId}".`);
      const groupIds = [...new Set(ensureArray<unknown>(args.assetGroupIds).map((v) => str(v).trim()).filter(Boolean))];
      if (groupIds.length === 0) errors.push("Informe ao menos um asset group em assetGroupIds.");
      if (groupIds.length > 20) errors.push(`No máximo 20 asset groups por chamada (recebidos ${groupIds.length}).`);
      for (const id of groupIds) if (!/^\d+$/.test(id)) errors.push(`assetGroupId deve ser numérico, recebido "${id}".`);

      interface AddItem { field: GroupFieldType; ref?: AssetRef; text?: string; callToAction?: string }
      const adds: AddItem[] = [];
      for (const raw of ensureArray<Row>(args.add).map(obj)) {
        const field = str(raw.fieldType) as GroupFieldType;
        if (!GROUP_FIELD_TYPES.includes(field)) {
          errors.push(`add: fieldType inválido "${str(raw.fieldType)}". Válidos: ${GROUP_FIELD_TYPES.join(", ")}.`);
          continue;
        }
        const rule = spec(field);
        const given = ["asset", "text", "callToAction"].filter((k) => raw[k] !== undefined && str(raw[k]).trim() !== "");
        if (given.length !== 1) {
          errors.push(`add ${field}: informe exatamente um entre asset, text e callToAction.`);
          continue;
        }
        if (raw.text !== undefined && str(raw.text).trim()) {
          if (rule.kind !== "TEXT") {
            errors.push(`add ${field}: text só vale para campos de texto (HEADLINE, LONG_HEADLINE, DESCRIPTION, BUSINESS_NAME).`);
            continue;
          }
          const value = str(raw.text).trim();
          if (rule.maxChars && chars(value) > rule.maxChars) {
            errors.push(`add ${field}: "${value}" tem ${chars(value)} caracteres (máximo ${rule.maxChars}).`);
            continue;
          }
          adds.push({ field, text: value });
        } else if (raw.callToAction !== undefined && str(raw.callToAction).trim()) {
          const cta = str(raw.callToAction).trim();
          if (field !== "CALL_TO_ACTION_SELECTION") {
            errors.push(`add ${field}: callToAction só vale para CALL_TO_ACTION_SELECTION.`);
            continue;
          }
          if (!(CALL_TO_ACTION_TYPES as readonly string[]).includes(cta)) {
            errors.push(`add: callToAction inválido "${cta}". Válidos: ${CALL_TO_ACTION_TYPES.join(", ")}.`);
            continue;
          }
          adds.push({ field, callToAction: cta });
        } else {
          const [ref] = parseRefs([raw.asset], cid, `add ${field}`, errors);
          if (ref) adds.push({ field, ref });
        }
      }
      const removes: Array<{ field: GroupFieldType; ref: AssetRef }> = [];
      for (const raw of ensureArray<Row>(args.remove).map(obj)) {
        const field = str(raw.fieldType) as GroupFieldType;
        if (!GROUP_FIELD_TYPES.includes(field)) {
          errors.push(`remove: fieldType inválido "${str(raw.fieldType)}".`);
          continue;
        }
        const [ref] = parseRefs([raw.asset], cid, `remove ${field}`, errors);
        if (ref) removes.push({ field, ref });
      }
      if (adds.length + removes.length === 0) errors.push("Informe ao menos um item em add ou remove.");
      for (const add of adds) {
        if (add.ref && removes.some((r) => r.field === add.field && r.ref.assetId === add.ref!.assetId)) {
          errors.push(`${add.field}: asset ${add.ref.assetId} está em add e remove ao mesmo tempo.`);
        }
      }
      const addKey = (a: AddItem) => `${a.field}|${a.ref?.assetId ?? ""}|${a.text ?? ""}|${a.callToAction ?? ""}`;
      if (new Set(adds.map(addKey)).size !== adds.length) errors.push("add tem itens repetidos.");
      if (errors.length) return fail(`Nada foi enviado — entrada inválida:\n- ${errors.join("\n- ")}`);

      const client = ctx.getClient();
      const groupRows = await client.searchStream(args.customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.status,
                campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.brand_guidelines_enabled, campaign.shopping_setting.merchant_id
         FROM asset_group
         WHERE asset_group.id IN (${groupIds.join(", ")})`);
      const groupsById = new Map(groupRows.map((row) => [str(obj(row.assetGroup).id), row]));
      const problems: string[] = [];
      for (const id of groupIds) {
        const row = groupsById.get(id);
        if (!row) problems.push(`asset group ${id} não existe na conta ${cid}.`);
        else if (str(obj(row.assetGroup).status) === "REMOVED") problems.push(`asset group ${id} está removido.`);
        else if (str(obj(row.campaign).advertisingChannelType) !== "PERFORMANCE_MAX") problems.push(`asset group ${id} não é de Performance Max.`);
      }
      if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}`);

      // Assets referenciados: existem, tipo e proporção
      const refAdds = adds.filter((a) => a.ref);
      const assets = await fetchAssets(client, args.customerId, refAdds.map((a) => a.ref!.assetId));
      const assetErrors = refAdds
        .map((a) => checkGroupAsset(a.ref!, assets.get(a.ref!.assetId), a.field, cid))
        .filter((e): e is string => e !== null);
      if (assetErrors.length) return fail(`Nada foi gravado:\n- ${assetErrors.join("\n- ")}`);

      const links = await fetchGroupLinks(client, args.customerId, `asset_group.id IN (${groupIds.join(", ")})`);
      const ids = new TempIds();
      const textAssets = new Map<string, string>(); // "texto" → resource name temporário (um asset por texto)
      const ctaAssets = new Map<string, string>();
      const assetOps: Row[] = [];
      const createOps: Row[] = [];
      const removeOps: Row[] = [];
      const plans: Row[] = [];
      const warnings: string[] = [];
      const firstAssetsWithBrandGuidelines: Array<{ id: string; campaignRn: string }> = [];
      for (const id of groupIds) {
        const row = groupsById.get(id)!;
        const campaign = obj(row.campaign);
        const brandGuidelines = campaign.brandGuidelinesEnabled === true;
        const merchantId = str(obj(campaign.shoppingSetting).merchantId);
        const retail = Boolean(merchantId && merchantId !== "0");
        const groupRn = `customers/${cid}/assetGroups/${id}`;
        const groupLinks = links.filter((l) => l.groupId === id && l.status !== "REMOVED");
        const beforeState = linkCounts(groupLinks);
        const afterCounts = { ...beforeState.counts };
        let afterShort = beforeState.shortDescriptions;
        const added: Row[] = [];
        const removed: Row[] = [];
        const skipped: string[] = [];
        for (const add of adds) {
          if (spec(add.field).brand && brandGuidelines) {
            problems.push(`asset group ${id}: a campanha está com diretrizes de marca LIGADAS — ${add.field} fica na campanha, não no asset group.`);
            continue;
          }
          const existing = groupLinks.find((l) =>
            l.fieldType === add.field &&
            (add.ref ? l.assetId === add.ref.assetId : add.text !== undefined ? l.text === add.text : l.callToAction === add.callToAction));
          if (existing) {
            skipped.push(`${add.field}: ${add.ref ? `asset ${add.ref.assetId}` : `"${add.text ?? add.callToAction}"`} já vinculado`);
            continue;
          }
          let assetRn: string;
          if (add.ref) assetRn = add.ref.resourceName;
          else if (add.text !== undefined) {
            assetRn = textAssets.get(add.text) ?? `customers/${cid}/assets/${ids.next()}`;
            if (!textAssets.has(add.text)) {
              textAssets.set(add.text, assetRn);
              assetOps.push(textAssetOp(assetRn, add.text));
            }
          } else {
            assetRn = ctaAssets.get(add.callToAction!) ?? `customers/${cid}/assets/${ids.next()}`;
            if (!ctaAssets.has(add.callToAction!)) {
              ctaAssets.set(add.callToAction!, assetRn);
              assetOps.push(ctaAssetOp(assetRn, add.callToAction!));
            }
          }
          createOps.push(groupLinkOp(groupRn, assetRn, add.field));
          afterCounts[add.field] += 1;
          if (add.field === "DESCRIPTION" && add.text !== undefined && chars(add.text) <= SHORT_DESCRIPTION_MAX_CHARS) afterShort += 1;
          if (add.field === "DESCRIPTION" && add.ref) {
            const value = str(obj(assets.get(add.ref.assetId)?.textAsset).text);
            if (chars(value) <= SHORT_DESCRIPTION_MAX_CHARS) afterShort += 1;
          }
          added.push({ field_type: add.field, asset: add.ref?.resourceName ?? "(novo)", ...(add.text ? { text: add.text } : {}), ...(add.callToAction ? { call_to_action: add.callToAction } : {}) });
        }
        for (const rem of removes) {
          const link = groupLinks.find((l) => l.fieldType === rem.field && l.assetId === rem.ref.assetId);
          if (!link) {
            skipped.push(`${rem.field}: asset ${rem.ref.assetId} não está vinculado — nada a remover`);
            continue;
          }
          removeOps.push({ assetGroupAssetOperation: { remove: link.resourceName } });
          if (countsForMinimum(link)) {
            afterCounts[rem.field] -= 1;
            if (rem.field === "DESCRIPTION" && link.text !== undefined && chars(link.text) <= SHORT_DESCRIPTION_MAX_CHARS) afterShort -= 1;
          }
          if (link.source === "AUTOMATICALLY_CREATED") {
            warnings.push(`asset group ${id}: ${rem.field} ${rem.ref.assetId} foi criado automaticamente pelo Google — a API pode recusar a remoção por aqui.`);
          }
          removed.push({ field_type: rem.field, asset_id: rem.ref.assetId, ...(link.text !== undefined ? { text: link.text } : {}), source: link.source });
        }

        // Regras de mínimo/máximo sobre o estado final
        const beforeTotal = GROUP_FIELD_TYPES.reduce((t, f) => t + beforeState.counts[f], 0);
        const afterTotal = GROUP_FIELD_TYPES.reduce((t, f) => t + afterCounts[f], 0);
        const brandAtGroup = !brandGuidelines;
        if (retail && beforeTotal === 0 && afterTotal > 0) {
          if (brandGuidelines) firstAssetsWithBrandGuidelines.push({ id, campaignRn: `customers/${cid}/campaigns/${str(campaign.id)}` });
          const missing = newGroupProblems(afterCounts, afterShort, brandAtGroup);
          if (missing.length) {
            problems.push(`asset group ${id} (varejo, hoje sem assets): o primeiro envio precisa do conjunto mínimo completo — ${missing.join("; ")}.`);
          }
        } else if (added.length + removed.length > 0) {
          for (const field of GROUP_FIELD_TYPES) {
            const rule = spec(field);
            if (rule.brand && !brandAtGroup) continue;
            const before = beforeState.counts[field];
            const after = afterCounts[field];
            if (after > rule.max) problems.push(`asset group ${id}: ${field} ficaria com ${after} (máximo ${rule.max}).`);
            if (after < rule.min && after < before) {
              problems.push(`asset group ${id}: ${field} ficaria com ${after} (mínimo ${rule.min}) — adicione outro no mesmo pedido para trocar.`);
            } else if (after < rule.min && (added.length > 0 || removed.length > 0) && before < rule.min) {
              warnings.push(`asset group ${id}: ${field} continua com ${after} (mínimo ${rule.min}) — a API pode recusar.`);
            }
          }
          if (afterCounts.DESCRIPTION > 0 && afterShort === 0) {
            if (beforeState.shortDescriptions > 0) {
              problems.push(`asset group ${id}: sairia a única descrição com até ${SHORT_DESCRIPTION_MAX_CHARS} caracteres (a API exige uma).`);
            } else {
              warnings.push(`asset group ${id}: nenhuma descrição com até ${SHORT_DESCRIPTION_MAX_CHARS} caracteres — a API pode recusar.`);
            }
          }
        }
        plans.push({
          asset_group_id: id,
          name: str(obj(row.assetGroup).name),
          campaign: `${str(campaign.id)} (${str(campaign.name)})`,
          brand_guidelines: brandGuidelines,
          add: added,
          remove: removed,
          skipped,
          counts_before: nonZero(beforeState.counts),
          counts_after: nonZero(afterCounts),
        });
      }
      // Varejo com diretrizes de marca: o primeiro envio de assets exige nome e logo na campanha
      // (CampaignError.REQUIRED_BUSINESS_NAME_ASSET_NOT_LINKED / REQUIRED_LOGO_ASSET_NOT_LINKED).
      if (problems.length === 0 && firstAssetsWithBrandGuidelines.length > 0) {
        const brand = await fetchCampaignBrandLinks(client, args.customerId, [...new Set(firstAssetsWithBrandGuidelines.map((g) => g.campaignRn))]);
        for (const item of firstAssetsWithBrandGuidelines) {
          const counts = brandCounts(brand.get(item.campaignRn) ?? []);
          if (counts.businessName === 0 || counts.logo === 0) {
            problems.push(
              `asset group ${item.id}: a campanha de varejo usa diretrizes de marca e ainda não tem nome da empresa e logo — ` +
                "sem eles a API recusa o primeiro envio de assets. Crie o asset group com create_asset_group (que vincula a marca na campanha no mesmo pedido) ou vincule a marca na campanha antes."
            );
          }
        }
      }
      if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}\n\n${formatJson({ plan: plans })}`);

      const operations = [...assetOps, ...createOps, ...removeOps];
      const dryRun = client.isDryRun;
      if (createOps.length + removeOps.length === 0) {
        return { content: [text(`Nada a mudar — tudo já estava assim. Nenhuma escrita foi enviada.\n\n${formatJson({ plan: plans, warnings })}`)] };
      }
      if (!dryRun && args.confirm !== true && (removeOps.length > 0 || groupIds.length > 1)) {
        return {
          content: [text(
            `Plano (NADA foi gravado): ${plural(createOps.length, "vínculo novo", "vínculos novos")}, ` +
              `${plural(removeOps.length, "remoção", "remoções")} em ${plural(groupIds.length, "asset group", "asset groups")}. ` +
              "Remoções e mudanças em mais de um asset group exigem confirm: true.\n\n" +
              formatJson({ plan: plans, warnings })
          )],
        };
      }
      try {
        await client.batchMutate(args.customerId, operations);
      } catch (err) {
        const message = explainApiError((err as Error).message);
        if (dryRun) return fail(`DRY-RUN (validateOnly): a API recusou — nada foi gravado.\n${message}\n\n${formatJson({ plan: plans })}`);
        const after = await safely(() => fetchGroupLinks(client, args.customerId, `asset_group.id IN (${groupIds.join(", ")})`));
        if (after === null) {
          return fail(`A requisição falhou e não deu para conferir a conta — resultado INCERTO. Confira com list_asset_group_assets antes de repetir.\nErro: ${message}`);
        }
        // Pedido atômico: ou mudou tudo, ou nada. Compara os vínculos ativos antes e depois.
        const active = (list: GroupLink[]) => new Set(list.filter((l) => l.status !== "REMOVED").map((l) => l.resourceName));
        const beforeSet = active(links);
        const afterSet = active(after);
        const changed = beforeSet.size !== afterSet.size || [...beforeSet].some((name) => !afterSet.has(name));
        return fail(
          (changed
            ? "A requisição devolveu erro, mas os vínculos mudaram na conta — confira com list_asset_group_assets antes de repetir."
            : "A API recusou — nada foi gravado (pedido atômico; conferido na conta).") + `\n${message}\n\n${formatJson({ plan: plans })}`
        );
      }
      const header = dryRun
        ? "DRY-RUN (validateOnly): a API validou o pedido inteiro — nada foi gravado."
        : `Assets atualizados: ${plural(createOps.length, "vínculo criado", "vínculos criados")}, ${plural(removeOps.length, "removido", "removidos")} ` +
          `em ${plural(groupIds.length, "asset group", "asset groups")}.`;
      return { content: [text(`${header}\n\n${formatJson({ plan: plans, warnings, operations: operations.length })}\n\nConfira com list_asset_group_assets.`)] };
    }
  );

  // ── update_display_ad ─────────────────────────────────────────────────
  const displayListFields = Object.entries(DISPLAY_AD_SPEC.fields).filter(([, f]) => f.kind === "assetList").map(([k]) => k) as [string, ...string[]];
  ctx.mcp.registerTool(
    "update_display_ad",
    {
      description: [
        "Edita um anúncio display responsivo (RESPONSIVE_DISPLAY_AD) pelo AdService, com updateMask aninhado.",
        "WRITE OPERATION — lê o anúncio, aplica só o que muda e mostra antes/depois. O anúncio volta para análise.",
        "",
        "Imagens/vídeos: addAssets/removeAssets [{field, asset}] sobre a lista atual (trocar = remover + adicionar).",
        "Listas: MARKETING_IMAGES 1.91:1 e SQUARE_MARKETING_IMAGES 1:1 (1+ cada, até 15 somadas), LOGO_IMAGES 4:1 e",
        "SQUARE_LOGO_IMAGES 1:1 (até 5 somados), YOUTUBE_VIDEOS (até 5).",
        "Textos substituem o valor atual: headlines (1-5, 30), longHeadline (90), descriptions (1-5, 90),",
        "businessName (25), callToActionText (30), mainColor/accentColor (hex, juntas), allowFlexibleColor.",
        "Não edita ImageAd/TextAd (o AdService não permite).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adId: z.string().describe("ID numérico do anúncio (ad_group_ad.ad.id)."),
        addAssets: flexArray(adAssetChangeSchema(displayListFields)).optional().describe("Assets a incluir nas listas."),
        removeAssets: flexArray(adAssetChangeSchema(displayListFields)).optional().describe("Assets a tirar das listas."),
        headlines: flexArray(z.string()).optional().describe("Novos títulos (substituem os atuais)."),
        longHeadline: z.string().optional().describe("Novo título longo."),
        descriptions: flexArray(z.string()).optional().describe("Novas descrições (substituem as atuais)."),
        businessName: z.string().optional().describe("Novo nome da empresa."),
        callToActionText: z.string().optional().describe("Novo texto de call-to-action."),
        mainColor: z.string().optional().describe("Cor principal hex (#1A2B3C) — junto com accentColor."),
        accentColor: z.string().optional().describe("Cor de destaque hex — junto com mainColor."),
        allowFlexibleColor: z.boolean().optional().describe("Permite ao Google variar as cores."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      return runAdUpdate(ctx, "update_display_ad", [DISPLAY_AD_SPEC],
        ["headlines", "longHeadline", "descriptions", "businessName", "callToActionText", "mainColor", "accentColor", "allowFlexibleColor"],
        args as AdToolArgs);
    }
  );

  // ── update_demand_gen_ad ──────────────────────────────────────────────
  const demandGenListFields = [...new Set(DEMAND_GEN_AD_SPECS.flatMap((s) =>
    Object.entries(s.fields).filter(([, f]) => f.kind === "assetList").map(([k]) => k)))] as [string, ...string[]];
  ctx.mcp.registerTool(
    "update_demand_gen_ad",
    {
      description: [
        "Edita um anúncio Demand Gen (imagem/multi-asset, vídeo, carrossel ou produto) pelo AdService, com updateMask",
        "aninhado. WRITE OPERATION — lê o anúncio, aplica só o que muda e mostra antes/depois. Volta para análise.",
        "",
        "Listas por addAssets/removeAssets [{field, asset}] (trocar = remover + adicionar):",
        "- imagem: MARKETING_IMAGES 1.91:1, SQUARE_MARKETING_IMAGES 1:1, PORTRAIT_MARKETING_IMAGES 4:5,",
        "  TALL_PORTRAIT_MARKETING_IMAGES 9:16 (até 20 somadas), LOGO_IMAGES 1:1 (1-5), CLASSIC_DISPLAY_IMAGES;",
        "- vídeo: VIDEOS (1+), LOGO_IMAGES 1:1 (1+), COMPANION_BANNERS (1); carrossel: CAROUSEL_CARDS (2-10).",
        "Textos substituem: headlines, longHeadlines (vídeo), descriptions, headline/description (carrossel e produto),",
        "businessName, callToActionText, breadcrumb1/2 (vídeo e produto), logoImageAsset (carrossel e produto).",
        "Campo que não existe no formato do anúncio é recusado antes de enviar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adId: z.string().describe("ID numérico do anúncio (ad_group_ad.ad.id)."),
        addAssets: flexArray(adAssetChangeSchema(demandGenListFields)).optional().describe("Assets a incluir nas listas."),
        removeAssets: flexArray(adAssetChangeSchema(demandGenListFields)).optional().describe("Assets a tirar das listas."),
        headlines: flexArray(z.string()).optional().describe("Novos títulos (multi-asset e vídeo)."),
        longHeadlines: flexArray(z.string()).optional().describe("Novos títulos longos (vídeo)."),
        descriptions: flexArray(z.string()).optional().describe("Novas descrições (multi-asset e vídeo)."),
        headline: z.string().optional().describe("Novo título (carrossel e produto)."),
        description: z.string().optional().describe("Nova descrição (carrossel e produto)."),
        businessName: z.string().optional().describe("Novo nome da empresa."),
        callToActionText: z.string().optional().describe("Novo texto de call-to-action (multi-asset e carrossel)."),
        breadcrumb1: z.string().optional().describe("Breadcrumb 1 (vídeo e produto)."),
        breadcrumb2: z.string().optional().describe("Breadcrumb 2 (vídeo e produto)."),
        logoImageAsset: z.string().optional().describe("Logo 1:1 (carrossel e produto): ID ou resource name."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      return runAdUpdate(ctx, "update_demand_gen_ad", DEMAND_GEN_AD_SPECS,
        ["headlines", "longHeadlines", "descriptions", "headline", "description", "businessName", "callToActionText", "breadcrumb1", "breadcrumb2", "logoImageAsset"],
        args as AdToolArgs);
    }
  );

  // ── unlink_campaign_image_assets ──────────────────────────────────────
  ctx.mcp.registerTool(
    "unlink_campaign_image_assets",
    {
      description: [
        "Remove vínculos de imagem (AD_IMAGE) de uma campanha — o inverso de link_campaign_image_assets.",
        "WRITE OPERATION — exige confirm: true (sem ele, mostra o que seria removido e não grava).",
        "A imagem continua na biblioteca; só o vínculo com a campanha sai. Vínculo inexistente é ignorado.",
        "Cada remoção é relatada separadamente (partial failure). Confira com list_campaign_image_assets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha."),
        assetResourceNames: flexArray(z.string()).describe("Imagens a desvincular: IDs ou customers/{customerId}/assets/{assetId}. Máx. 20."),
        confirm: z.boolean().optional().describe("true = remover de fato."),
      },
    },
    async ({ customerId, campaignId, assetResourceNames, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!/^\d+$/.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi gravado.`);
      const errors: string[] = [];
      const refs = parseRefs(assetResourceNames, cid, "assetResourceNames", errors);
      if (errors.length) return fail(`Nada foi gravado — referência(s) inválida(s):\n- ${errors.join("\n- ")}`);
      if (refs.length === 0) return fail("Informe ao menos uma imagem em assetResourceNames. Nada foi gravado.");
      if (refs.length > 20) return fail(`No máximo 20 imagens por chamada (recebidas ${refs.length}). Nada foi gravado.`);

      const client = ctx.getClient();
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = obj(campaignRows[0]?.campaign);
      if (campaignRows.length === 0) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      const campaignResource = `customers/${cid}/campaigns/${campaignId}`;
      const links = await fetchCampaignImageLinks(client, customerId, campaignResource);
      const toRemove = refs.filter((ref) => {
        const link = links.get(ref.assetId);
        return link && link.status !== "REMOVED";
      });
      const notLinked = refs.filter((ref) => !toRemove.includes(ref)).map((ref) => ({ asset_id: ref.assetId, note: "não estava vinculada — nada a remover" }));
      const campaignInfo = { id: campaignId, name: str(campaign.name), channel: str(campaign.advertisingChannelType) };
      if (toRemove.length === 0) {
        return { content: [text(`Campanha ${campaignId}: nenhuma dessas imagens está vinculada. Nenhuma escrita foi enviada.\n\n${formatJson({ campaign: campaignInfo, not_linked: notLinked })}`)] };
      }
      const dryRun = client.isDryRun;
      const planned = toRemove.map((ref) => ({ asset_id: ref.assetId, link_resource_name: links.get(ref.assetId)!.resourceName, link_status: links.get(ref.assetId)!.status }));
      if (!dryRun && confirm !== true) {
        return {
          content: [text(`Plano (NADA foi gravado): remover ${plural(toRemove.length, "vínculo", "vínculos")} AD_IMAGE da campanha ${campaignId}. ` +
            `Repita com confirm: true para aplicar.\n\n${formatJson({ campaign: campaignInfo, to_remove: planned, not_linked: notLinked })}`)],
        };
      }
      let response: Row;
      try {
        response = await client.mutateCampaignAssets(customerId, planned.map((p) => ({ remove: p.link_resource_name })), { partialFailure: true });
      } catch (err) {
        const message = (err as Error).message;
        if (dryRun) return fail(`DRY-RUN (validateOnly): a API recusou — nada foi gravado.\n${message}`);
        const after = await safely(() => fetchCampaignImageLinks(client, customerId, campaignResource));
        if (after === null) return fail(`A requisição falhou e não deu para conferir — resultado INCERTO. Confira com list_campaign_image_assets.\nErro: ${message}`);
        const gone = planned.filter((p) => { const link = after.get(p.asset_id); return !link || link.status === "REMOVED"; });
        return fail(`A requisição falhou; estado conferido na conta: ${gone.length} de ${planned.length} vínculo(s) removido(s).\nErro: ${message}\n\n` +
          formatJson({ removed: gone, still_linked: planned.filter((p) => !gone.includes(p)) }));
      }
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, planned.length);
      const results = arr(response.results).map(obj);
      const removed: Row[] = [];
      const failed: Row[] = [];
      planned.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) failed.push({ ...item, error: opErrors.join("; ") });
        else if (!dryRun && !str(results[index]?.resourceName)) failed.push({ ...item, error: "a API não confirmou a remoção" });
        else if (dryRun && unattributed.length) failed.push({ ...item, error: "validação não confirmada" });
        else removed.push(item);
      });
      for (const message of unattributed) failed.push({ error: message });
      const header = dryRun
        ? `Campanha ${campaignId} — DRY-RUN (validateOnly): nada foi gravado. Validadas: ${removed.length} | Com erro: ${failed.length}`
        : `Campanha ${campaignId}: ${plural(removed.length, "vínculo removido", "vínculos removidos")} | Com erro: ${failed.length}`;
      return {
        content: [text(`${header}\n\n${formatJson({ campaign: campaignInfo, dry_run: dryRun, [dryRun ? "validated" : "removed"]: removed, not_linked: notLinked, errors: failed })}`)],
        isError: failed.length > 0,
      };
    }
  );
}
