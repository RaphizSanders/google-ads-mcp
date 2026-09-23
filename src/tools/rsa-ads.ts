/**
 * Lote rsa-ads: anúncios responsivos de Pesquisa, customizadores e auditoria de anúncios.
 *
 * - Fixação (pin) de títulos e descrições no create_ad e no update_ad, que agora lê o RSA
 *   antes de gravar e preserva os pins dos textos mantidos (antes a edição apagava todos).
 * - Auditoria de anúncios de todos os tipos (list_ads) e relatório de assets sem o rótulo
 *   de performance que a API deixou de devolver para Pesquisa e Display na v23.
 * - Customizadores de anúncio: atributos e valores por conta, campanha, grupo e palavra-chave.
 * - Inventário e migração dos anúncios só de chamada (CALL_AD), que param de veicular em
 *   fevereiro de 2027.
 *
 * As tools de anúncio que vieram do núcleo (create_ad, update_ad, update_ad_status,
 * delete_ad, get_ad_creatives, get_ad_performance, get_asset_performance) também são
 * registradas aqui; a classificação read/write delas continua em src/read-only.ts.
 * As tools novas estão em rsa-ads.catalog.ts.
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
  localIsoDate,
  microsToMoney,
  num,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const asRow = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]).map(asRow) : []);
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const done = (message: string): ToolResult => ({ content: [text(message)] });
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cleanCid = (customerId: string) => customerId.replace(/-/g, "");
/** ID informado? "" conta como ausente, como nas tools antigas. */
const given = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Confere que os IDs informados são numéricos antes de entrarem no GAQL ou num resource name. */
function invalidIds(ids: Record<string, unknown>): string | null {
  const bad = Object.entries(ids)
    .filter(([, value]) => value !== undefined && value !== "" && !/^\d+$/.test(String(value)))
    .map(([name, value]) => `${name}="${value}"`);
  return bad.length ? `IDs devem ser numéricos: ${bad.join(", ")}. Nada foi enviado.` : null;
}

function renderRows(rows: Row[], format: string | undefined, header: string, body: unknown): ToolResult {
  if (format === "table") return done(formatAsTable(rows));
  if (format === "csv") return done(formatAsCsv(rows));
  return done(`${header}\n\n${formatJson(body)}`);
}

const dryRunLine = (client: GoogleAdsClient) =>
  client.isDryRun ? "DRY-RUN (validateOnly): a API só validou — nada foi gravado na conta." : "";

// ── Textos de RSA e fixação (pin) ─────────────────────────────────────

const HEADLINE_PINS = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const;
const DESCRIPTION_PINS = ["DESCRIPTION_1", "DESCRIPTION_2"] as const;
const PIN_VALUES = [...HEADLINE_PINS, ...DESCRIPTION_PINS] as const;
type TextKind = "HEADLINE" | "DESCRIPTION";

/** Limites do RSA (ResponsiveSearchAdInfo): 3–15 títulos de 30 caracteres, 2–4 descrições de 90. */
const KIND_INFO: Record<TextKind, { label: string; plural: string; min: number; max: number; chars: number; pins: readonly string[] }> = {
  HEADLINE: { label: "título", plural: "títulos (headlines)", min: 3, max: 15, chars: 30, pins: HEADLINE_PINS },
  DESCRIPTION: { label: "descrição", plural: "descrições (descriptions)", min: 2, max: 4, chars: 90, pins: DESCRIPTION_PINS },
};
const PATH_MAX_CHARS = 15;

/** Uma instância por uso: schema zod compartilhado vira $ref no JSON Schema publicado da tool. */
const pinSchema = () =>
  z
    .enum(PIN_VALUES)
    .nullable()
    .optional()
    .describe("Posição fixa: HEADLINE_1/2/3 (títulos) ou DESCRIPTION_1/2 (descrições). null = soltar o pin.");
const pinAliasSchema = () =>
  z
    .enum(PIN_VALUES)
    .nullable()
    .optional()
    .describe("Mesmo que pin — é o nome que list_ads, get_ad_creatives e get_asset_performance devolvem.");

/**
 * Chaves de pin aceitas num item de texto. pinned_field/pinnedField são o formato das leituras
 * (list_ads, get_ad_creatives, get_asset_performance) e da API: o agente copia o item lido e
 * manda de volta. Precisam estar no schema — o zod descarta chave que não conhece, e o pin
 * sumia sem aviso antes de chegar ao handler.
 */
const PIN_KEYS = ["pin", "pinnedField", "pinned_field"] as const;
/**
 * Chaves só de leitura que as leituras devolvem junto do texto (approval_status do list_ads;
 * assetPerformanceLabel e policySummaryInfo, campos output-only do AdTextAsset). Não significam
 * nada numa escrita e são ignoradas; qualquer outra chave desconhecida é recusada.
 */
const READ_ONLY_TEXT_KEYS = new Set([
  "approval_status",
  "assetPerformanceLabel",
  "asset_performance_label",
  "policySummaryInfo",
  "policy_summary_info",
]);

/**
 * { text, pin } como objeto: os aliases de pin estão no schema e o passthrough deixa as demais
 * chaves chegarem ao handler, que recusa as desconhecidas (parseTextEntry). Assim a lista enviada
 * como array (validada pelo zod) e como string JSON (flexArray não valida os itens) dão o mesmo
 * resultado, e nada é descartado em silêncio.
 */
const textAssetObject = () =>
  z.object({ text: z.string(), pin: pinSchema(), pinnedField: pinAliasSchema(), pinned_field: pinAliasSchema() }).passthrough();
/** Texto simples ou { text, pin } — o formato que create_ad e update_ad aceitam. */
const textAssetInput = () => z.union([z.string(), textAssetObject()]);

interface TextItem {
  text: string;
  /** undefined = não informado (update_ad mantém o pin atual); null = sem pin. */
  pin?: string | null;
}
interface FinalText {
  text: string;
  pin: string | null;
}

const normalizePin = (value: unknown): string | null => {
  const pin = String(value ?? "");
  return (PIN_VALUES as readonly string[]).includes(pin) ? pin : null;
};

/**
 * Lê um item de texto (string ou { text, pin | pinnedField | pinned_field }). pinGiven=false quando
 * nenhuma chave de pin veio; pin null = soltar. Chave desconhecida e aliases com valores diferentes
 * são erro — o que o usuário pediu nunca é descartado em silêncio.
 */
function parseTextEntry(
  entry: unknown,
  where: string,
  errors: string[]
): { text: string; pinGiven: boolean; pin: string | null | undefined } | undefined {
  if (typeof entry === "string") {
    if (entry.trim()) return { text: entry.trim(), pinGiven: false, pin: undefined };
    errors.push(`${where}: texto vazio ou ausente.`);
    return undefined;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${where}: texto vazio ou ausente.`);
    return undefined;
  }
  const item = entry as Row;
  const unknownKeys = Object.keys(item).filter(
    (key) => key !== "text" && !(PIN_KEYS as readonly string[]).includes(key) && !READ_ONLY_TEXT_KEYS.has(key)
  );
  if (unknownKeys.length) {
    errors.push(
      `${where}: chave(s) desconhecida(s) ${unknownKeys.map((key) => `"${key}"`).join(", ")} — use { text, pin } ` +
        "(pin também aceita pinnedField ou pinned_field)."
    );
    return undefined;
  }
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text) {
    errors.push(`${where}: texto vazio ou ausente.`);
    return undefined;
  }
  const pinKeys = PIN_KEYS.filter((key) => item[key] !== undefined);
  const pins = pinKeys.map((key) => (item[key] === null || item[key] === "" ? null : String(item[key]).trim().toUpperCase()));
  if (new Set(pins).size > 1) {
    errors.push(
      `${where}: "${text}" com pins diferentes (${pinKeys.map((key, i) => `${key}=${pins[i] ?? "null"}`).join(", ")}) — informe um só.`
    );
    return undefined;
  }
  return pinKeys.length ? { text, pinGiven: true, pin: pins[0] } : { text, pinGiven: false, pin: undefined };
}

/** Lê a lista informada pelo usuário (string ou objeto), sem chamar a API. */
function parseTextItems(raw: unknown, kind: TextKind, field: string, errors: string[]): TextItem[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const items: TextItem[] = [];
  list.forEach((entry, index) => {
    const parsed = parseTextEntry(entry, `${field}[${index}]`, errors);
    if (!parsed) return;
    const { text: trimmed, pinGiven, pin } = parsed;
    if (!pinGiven) {
      items.push({ text: trimmed });
      return;
    }
    if (pin === null) {
      items.push({ text: trimmed, pin: null });
      return;
    }
    const upper = String(pin);
    if (!KIND_INFO[kind].pins.includes(upper)) {
      errors.push(
        `${field}: "${trimmed}" com pin ${upper} — ${KIND_INFO[kind].label} só pode ser fixado em ` +
          `${KIND_INFO[kind].pins.join(", ")} (ou null para soltar).`
      );
      return;
    }
    items.push({ text: trimmed, pin: upper });
  });
  return items;
}

/** Textos do RSA como a API devolve (AdTextAsset com pinnedField). */
function readTexts(list: unknown): FinalText[] {
  return asRows(list).map((asset) => ({ text: String(asset.text ?? ""), pin: normalizePin(asset.pinnedField) }));
}

function validateFinalTexts(list: FinalText[], kind: TextKind, errors: string[]): void {
  const info = KIND_INFO[kind];
  if (list.length < info.min || list.length > info.max) {
    errors.push(`O RSA precisa de ${info.min} a ${info.max} ${info.plural}; ficariam ${list.length}.`);
  }
  const seen = new Set<string>();
  for (const item of list) {
    // Com {KeyWord:...}, {CUSTOMIZER.x:...} ou {COUNTDOWN(...)} o tamanho que conta é o do
    // texto servido — quem mede é a API. Texto puro é conferido aqui.
    const length = [...item.text].length;
    if (!item.text.includes("{") && length > info.chars) {
      errors.push(`${info.label} "${item.text}" tem ${length} caracteres (máx. ${info.chars}).`);
    }
    if (seen.has(item.text)) errors.push(`${info.label} repetido: "${item.text}" — cada texto precisa ser único no anúncio.`);
    seen.add(item.text);
  }
}

function pinWarnings(headlines: FinalText[], descriptions: FinalText[]): string[] {
  const warnings: string[] = [];
  const positions = [...new Set([...headlines, ...descriptions].map((item) => item.pin).filter((pin): pin is string => Boolean(pin)))];
  if (positions.length > 1) {
    warnings.push(
      `${positions.length} posições fixadas (${positions.join(", ")}): cada posição fixada reduz as combinações ` +
        "que o Google pode testar e costuma baixar a força do anúncio."
    );
  }
  if (headlines.length > 0 && headlines.every((item) => item.pin)) {
    warnings.push("Todos os títulos estão fixados: o Google não tem combinação para testar e a força do anúncio cai.");
  }
  if (descriptions.length > 0 && descriptions.every((item) => item.pin)) {
    warnings.push("Todas as descrições estão fixadas: o Google não tem combinação para testar.");
  }
  if (positions.includes("HEADLINE_3") || positions.includes("DESCRIPTION_2")) {
    warnings.push(
      "HEADLINE_3 e DESCRIPTION_2 nem sempre aparecem no anúncio: texto que precisa sair sempre (marca, aviso legal) " +
        "vai em HEADLINE_1, HEADLINE_2 ou DESCRIPTION_1."
    );
  }
  return warnings;
}

const showTexts = (list: FinalText[]) => list.map((item) => (item.pin ? `${item.text} [${item.pin}]` : item.text));
const apiTexts = (list: FinalText[]) =>
  list.map((item) => (item.pin ? { text: item.text, pinnedField: item.pin } : { text: item.text }));
/** Mesmo conjunto de (texto, pin)? A ordem não importa para o RSA. */
function sameTexts(a: FinalText[], b: FinalText[]): boolean {
  const key = (list: FinalText[]) => list.map((item) => `${item.text}\u0000${item.pin ?? ""}`).sort().join("\u0001");
  return key(a) === key(b);
}

function checkUrl(value: string | undefined, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  const url = value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) errors.push(`${field} inválida: "${value}". Use uma URL http(s) completa.`);
  return url;
}

function checkPath(value: string | undefined, field: string, errors: string[]): void {
  if (value !== undefined && [...value].length > PATH_MAX_CHARS) {
    errors.push(`${field} "${value}" tem ${[...value].length} caracteres (máx. ${PATH_MAX_CHARS}).`);
  }
}

// ── Customizadores referenciados nos textos ───────────────────────────

const CUSTOMIZER_TYPES = ["TEXT", "NUMBER", "PRICE", "PERCENT"] as const;
const MAX_ENABLED_CUSTOMIZER_ATTRIBUTES = 40;
const CUSTOMIZER_TAG = /\{CUSTOMIZER\.([^:{}]*)(?::([^{}]*))?\}/gi;

function customizerRefs(texts: string[]): Array<{ name: string; hasDefault: boolean; text: string }> {
  const refs: Array<{ name: string; hasDefault: boolean; text: string }> = [];
  for (const value of texts) {
    for (const match of value.matchAll(CUSTOMIZER_TAG)) {
      refs.push({ name: match[1].trim(), hasDefault: (match[2] ?? "").trim() !== "", text: value });
    }
  }
  return refs;
}

interface CustomizerAttribute {
  id: string;
  name: string;
  type: string;
  status: string;
  resourceName: string;
}

async function fetchAttributes(client: GoogleAdsClient, customerId: string, includeRemoved = false): Promise<CustomizerAttribute[]> {
  const rows = await client.searchStream(customerId,
    `SELECT customizer_attribute.id, customizer_attribute.name, customizer_attribute.type,
            customizer_attribute.status, customizer_attribute.resource_name
     FROM customizer_attribute${includeRemoved ? "" : "\n     WHERE customizer_attribute.status = 'ENABLED'"}`);
  return rows.map((row) => {
    const attribute = asRow(row.customizerAttribute);
    return {
      id: String(attribute.id ?? ""),
      name: String(attribute.name ?? ""),
      type: String(attribute.type ?? ""),
      status: String(attribute.status ?? ""),
      resourceName: String(attribute.resourceName ?? ""),
    };
  });
}

/**
 * Confere {CUSTOMIZER.Nome:Padrão} contra os atributos ativos da conta. Só consulta a API
 * quando algum texto usa customizador.
 */
async function checkCustomizerRefs(
  client: GoogleAdsClient,
  customerId: string,
  texts: string[]
): Promise<{ errors: string[]; warnings: string[] }> {
  const refs = customizerRefs(texts);
  if (refs.length === 0) return { errors: [], warnings: [] };
  const attributes = await fetchAttributes(client, customerId);
  const byName = new Map(attributes.map((attribute) => [attribute.name.toLowerCase(), attribute]));
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const ref of refs) {
    if (!byName.has(ref.name.toLowerCase())) {
      errors.push(
        `"${ref.text}" usa {CUSTOMIZER.${ref.name}}, mas não há atributo ativo "${ref.name}" nesta conta ` +
          `(crie com create_customizer_attribute). Ativos: ${attributes.map((a) => a.name).join(", ") || "nenhum"}.`
      );
    } else if (!ref.hasDefault) {
      warnings.push(
        `"${ref.text}" usa {CUSTOMIZER.${ref.name}} sem valor padrão: onde não houver valor definido, ` +
          `o texto não pode ser exibido. Use {CUSTOMIZER.${ref.name}:padrão}.`
      );
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// ── Leituras comuns ───────────────────────────────────────────────────

async function fetchAdGroup(client: GoogleAdsClient, customerId: string, adGroupId: string): Promise<Row | null> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
            campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  return rows[0] ?? null;
}

/** Motivo para não criar RSA no grupo (ou null se o grupo serve). */
function searchAdGroupProblem(row: Row | null, adGroupId: string, cid: string): string | null {
  if (!row) return `Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}.`;
  const adGroup = asRow(row.adGroup);
  const campaign = asRow(row.campaign);
  if (adGroup.status === "REMOVED") return `O grupo ${adGroupId} ("${adGroup.name}") está removido.`;
  if (campaign.advertisingChannelType && campaign.advertisingChannelType !== "SEARCH") {
    return `O grupo ${adGroupId} ("${adGroup.name}") é de uma campanha ${campaign.advertisingChannelType}, não SEARCH: RSA só existe em Pesquisa.`;
  }
  if (adGroup.type && adGroup.type !== "SEARCH_STANDARD") {
    return `O grupo ${adGroupId} ("${adGroup.name}") é do tipo ${adGroup.type}; RSA só vai em grupo SEARCH_STANDARD.`;
  }
  return null;
}

const adGroupInfo = (row: Row) => {
  const adGroup = asRow(row.adGroup);
  const campaign = asRow(row.campaign);
  return {
    ad_group_id: String(adGroup.id ?? ""),
    ad_group: adGroup.name,
    ad_group_status: adGroup.status,
    campaign_id: String(campaign.id ?? ""),
    campaign: campaign.name,
  };
};

const RSA_READ_FIELDS = `ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad.final_urls,
            ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
            ad_group.id, ad_group.name, campaign.id, campaign.name`;

const idFromResource = (resourceName: unknown) => String(resourceName ?? "").split(/[/~]/).pop() ?? "";

// ── Auditoria de anúncios (list_ads) ──────────────────────────────────

const AD_TYPE_FILTERS: Record<string, string[]> = {
  RSA: ["RESPONSIVE_SEARCH_AD"],
  RDA: ["RESPONSIVE_DISPLAY_AD"],
  DEMAND_GEN: ["DEMAND_GEN_MULTI_ASSET_AD", "DEMAND_GEN_CAROUSEL_AD", "DEMAND_GEN_VIDEO_RESPONSIVE_AD", "DEMAND_GEN_PRODUCT_AD"],
  DEMAND_GEN_MULTI_ASSET: ["DEMAND_GEN_MULTI_ASSET_AD"],
  DEMAND_GEN_CAROUSEL: ["DEMAND_GEN_CAROUSEL_AD"],
  DEMAND_GEN_VIDEO_RESPONSIVE: ["DEMAND_GEN_VIDEO_RESPONSIVE_AD"],
  DEMAND_GEN_PRODUCT: ["DEMAND_GEN_PRODUCT_AD"],
  VIDEO_RESPONSIVE: ["VIDEO_RESPONSIVE_AD"],
  CALL_ONLY: ["CALL_AD"],
};
const LIST_AD_TYPES = ["ALL", ...Object.keys(AD_TYPE_FILTERS)] as [string, ...string[]];
const AD_STRENGTHS = ["PENDING", "NO_ADS", "POOR", "AVERAGE", "GOOD", "EXCELLENT"] as const;

/**
 * Conteúdo de cada tipo de anúncio na v25 (common/ad_type_infos.proto): listas de
 * AdTextAsset, textos únicos, listas e itens de asset (imagem, vídeo, card, CTA) e strings.
 */
interface AdContentSpec {
  key: string;
  gaql: string;
  lists: string[];
  single: string[];
  assetLists: string[];
  singleAssets: string[];
  strings: string[];
}
const AD_CONTENT: Record<string, AdContentSpec> = {
  RESPONSIVE_SEARCH_AD: {
    key: "responsiveSearchAd", gaql: "responsive_search_ad",
    lists: ["headlines", "descriptions"], single: [], assetLists: [], singleAssets: [], strings: ["path1", "path2"],
  },
  RESPONSIVE_DISPLAY_AD: {
    key: "responsiveDisplayAd", gaql: "responsive_display_ad",
    lists: ["headlines", "descriptions"], single: ["longHeadline"],
    assetLists: ["marketingImages", "squareMarketingImages", "logoImages", "squareLogoImages", "youtubeVideos"],
    singleAssets: [], strings: ["businessName", "callToActionText"],
  },
  DEMAND_GEN_MULTI_ASSET_AD: {
    key: "demandGenMultiAssetAd", gaql: "demand_gen_multi_asset_ad",
    lists: ["headlines", "descriptions"], single: [],
    assetLists: ["marketingImages", "squareMarketingImages", "portraitMarketingImages", "tallPortraitMarketingImages", "logoImages", "classicDisplayImages"],
    singleAssets: [], strings: ["businessName", "callToActionText"],
  },
  DEMAND_GEN_CAROUSEL_AD: {
    key: "demandGenCarouselAd", gaql: "demand_gen_carousel_ad",
    lists: [], single: ["headline", "description"], assetLists: ["carouselCards"], singleAssets: ["logoImage"],
    strings: ["businessName", "callToActionText"],
  },
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: {
    key: "demandGenVideoResponsiveAd", gaql: "demand_gen_video_responsive_ad",
    lists: ["headlines", "longHeadlines", "descriptions"], single: ["businessName"],
    assetLists: ["videos", "logoImages", "companionBanners", "callToActions"], singleAssets: [],
    strings: ["breadcrumb1", "breadcrumb2"],
  },
  DEMAND_GEN_PRODUCT_AD: {
    key: "demandGenProductAd", gaql: "demand_gen_product_ad",
    lists: [], single: ["headline", "description", "businessName"], assetLists: [], singleAssets: ["logoImage", "callToAction"],
    strings: ["breadcrumb1", "breadcrumb2"],
  },
  VIDEO_RESPONSIVE_AD: {
    key: "videoResponsiveAd", gaql: "video_responsive_ad",
    lists: ["headlines", "longHeadlines", "descriptions", "callToActions"], single: ["businessName"],
    assetLists: ["videos", "logoImages", "companionBanners"], singleAssets: [], strings: ["breadcrumb1", "breadcrumb2"],
  },
};

const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function contentFields(types: string[]): string[] {
  const fields: string[] = [];
  for (const type of types) {
    const spec = AD_CONTENT[type];
    if (!spec) continue;
    for (const field of [...spec.lists, ...spec.single, ...spec.assetLists, ...spec.singleAssets, ...spec.strings]) {
      fields.push(`ad_group_ad.ad.${spec.gaql}.${snake(field)}`);
    }
  }
  return fields;
}

function collectAssetRefs(ad: Row, type: string, into: Set<string>): void {
  const spec = AD_CONTENT[type];
  if (!spec) return;
  const data = asRow(ad[spec.key]);
  for (const field of spec.assetLists) for (const item of asRows(data[field])) if (item.asset) into.add(String(item.asset));
  for (const field of spec.singleAssets) {
    const item = asRow(data[field]);
    if (item.asset) into.add(String(item.asset));
  }
}

async function fetchAssetInfo(client: GoogleAdsClient, customerId: string, resourceNames: Iterable<string>): Promise<Map<string, Row>> {
  const ids = [...new Set([...resourceNames].map(idFromResource).filter((id) => /^\d+$/.test(id)))];
  const info = new Map<string, Row>();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const rows = await client.searchStream(customerId,
      `SELECT asset.id, asset.name, asset.type, asset.text_asset.text,
              asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels,
              asset.image_asset.full_size.height_pixels, asset.youtube_video_asset.youtube_video_id,
              asset.youtube_video_asset.youtube_video_title, asset.call_to_action_asset.call_to_action,
              asset.demand_gen_carousel_card_asset.headline
       FROM asset
       WHERE asset.id IN (${chunk.join(", ")})`);
    for (const row of rows) {
      const asset = asRow(row.asset);
      info.set(String(asset.id ?? ""), asset);
    }
  }
  return info;
}

function assetView(resourceName: string, info: Map<string, Row>): Row {
  const id = idFromResource(resourceName);
  const asset = info.get(id);
  if (!asset) return { asset_id: id, asset: resourceName };
  const image = asRow(asRow(asset.imageAsset).fullSize);
  const video = asRow(asset.youtubeVideoAsset);
  const width = num(image.widthPixels);
  const height = num(image.heightPixels);
  const view: Row = { asset_id: id, type: asset.type };
  if (asset.name) view.name = asset.name;
  if (image.url) view.url = image.url;
  if (width && height) view.dimensions = `${width}x${height}`;
  if (video.youtubeVideoId) {
    view.youtube_video_id = video.youtubeVideoId;
    if (video.youtubeVideoTitle) view.youtube_title = video.youtubeVideoTitle;
  }
  const textValue = asRow(asset.textAsset).text;
  if (textValue) view.text = textValue;
  const cta = asRow(asset.callToActionAsset).callToAction;
  if (cta) view.call_to_action = cta;
  const card = asRow(asset.demandGenCarouselCardAsset).headline;
  if (card) view.card_headline = card;
  return view;
}

function textView(asset: Row): Row {
  const view: Row = { text: asset.text };
  const pin = normalizePin(asset.pinnedField);
  if (pin) view.pinned_field = pin;
  const approval = asRow(asset.policySummaryInfo).approvalStatus;
  if (approval && approval !== "APPROVED") view.approval_status = approval;
  return view;
}

function adContent(ad: Row, type: string, info: Map<string, Row>): { content: Row; counts: Record<string, number> } | null {
  const spec = AD_CONTENT[type];
  if (!spec) return null;
  const data = asRow(ad[spec.key]);
  const content: Row = {};
  const counts: Record<string, number> = {};
  for (const field of spec.lists) {
    const list = asRows(data[field]);
    counts[field] = list.length;
    content[snake(field)] = list.map(textView);
  }
  for (const field of spec.single) {
    const value = asRow(data[field]);
    if (value.text !== undefined) content[snake(field)] = textView(value);
  }
  for (const field of spec.assetLists) {
    const list = asRows(data[field]);
    counts[field] = list.length;
    content[snake(field)] = list.map((item) => assetView(String(item.asset ?? ""), info));
  }
  for (const field of spec.singleAssets) {
    const item = asRow(data[field]);
    if (item.asset) content[snake(field)] = assetView(String(item.asset), info);
  }
  for (const field of spec.strings) {
    if (data[field] !== undefined && data[field] !== "") content[snake(field)] = data[field];
  }
  return { content, counts };
}

function adIssues(adGroupAd: Row, type: string): string[] {
  const issues: string[] = [];
  const policy = asRow(adGroupAd.policySummary);
  const approval = String(policy.approvalStatus ?? "");
  const strength = String(adGroupAd.adStrength ?? "");
  const primary = String(adGroupAd.primaryStatus ?? "");
  const reasons = (adGroupAd.primaryStatusReasons as string[] | undefined) ?? [];
  const actionItems = (adGroupAd.actionItems as string[] | undefined) ?? [];
  if (type === "CALL_AD") {
    issues.push("anúncio só de chamada: criação encerrada em jan/2026 e veiculação termina em fev/2027 — migre (list_call_only_ads)");
  }
  if (approval === "DISAPPROVED") issues.push("reprovado pela política de anúncios");
  if (approval === "APPROVED_LIMITED") issues.push("aprovado com restrições");
  if (approval === "AREA_OF_INTEREST_ONLY") issues.push("só veicula para quem mostra interesse na área (AREA_OF_INTEREST_ONLY)");
  if (policy.reviewStatus === "UNDER_APPEAL") issues.push("em contestação (UNDER_APPEAL)");
  if (primary === "NOT_ELIGIBLE" || primary === "LIMITED") {
    issues.push(`primary_status ${primary}${reasons.length ? ` (${reasons.join(", ")})` : ""}`);
  }
  if (strength === "POOR" || strength === "AVERAGE") issues.push(`força do anúncio ${strength}`);
  if (actionItems.length) issues.push(`${actionItems.length} sugestão(ões) para melhorar a força`);
  return issues;
}

// ── Relatório de assets (get_asset_performance) ───────────────────────

/** O Google só tem estatística completa por asset de RSA a partir desta data. */
const ASSET_STATS_START = "2025-06-05";
/** Rótulos que ainda significam algo; NOT_APPLICABLE veio na v23 para Pesquisa e Display. */
const MEANINGFUL_LABELS = new Set(["PENDING", "LEARNING", "LOW", "GOOD", "BEST"]);
const ASSET_VIEW_FIELD_TYPES = [
  "HEADLINE", "DESCRIPTION", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "LOGO", "YOUTUBE_VIDEO",
  "LONG_HEADLINE", "BUSINESS_NAME", "CALL_TO_ACTION_SELECTION",
] as const;

/** Enum conferido no código antes de entrar no GAQL/payload (o zod só valida na camada MCP). */
function badEnum(field: string, value: unknown, allowed: readonly string[]): string | null {
  if (value === undefined) return null;
  return allowed.includes(String(value)) ? null : `${field} inválido: "${value}". Use ${allowed.join(", ")}. Nada foi enviado.`;
}

function periodStart(dateRange: { since: string; until: string } | undefined, days: number | undefined): string {
  if (dateRange?.since) return dateRange.since;
  const start = new Date();
  start.setDate(start.getDate() - (days ?? 30));
  return localIsoDate(start);
}

// ── Customizadores: níveis ────────────────────────────────────────────

type CustomizerLevel = "CUSTOMER" | "CAMPAIGN" | "AD_GROUP" | "KEYWORD";
/** REST de cada nível conforme o google.api.http da v25 (note as maiúsculas em dois deles). */
const LEVEL_SPEC: Record<CustomizerLevel, { resource: string; rowKey: string; service: string; linkField?: string; linkJson?: string; label: string }> = {
  CUSTOMER: { resource: "customer_customizer", rowKey: "customerCustomizer", service: "CustomerCustomizers", label: "conta" },
  CAMPAIGN: { resource: "campaign_customizer", rowKey: "campaignCustomizer", service: "campaignCustomizers", linkField: "campaign", linkJson: "campaign", label: "campanha" },
  AD_GROUP: { resource: "ad_group_customizer", rowKey: "adGroupCustomizer", service: "adGroupCustomizers", linkField: "ad_group", linkJson: "adGroup", label: "grupo de anúncios" },
  KEYWORD: { resource: "ad_group_criterion_customizer", rowKey: "adGroupCriterionCustomizer", service: "AdGroupCriterionCustomizers", linkField: "ad_group_criterion", linkJson: "adGroupCriterion", label: "palavra-chave" },
};
const LEVELS = ["CUSTOMER", "CAMPAIGN", "AD_GROUP", "KEYWORD"] as const;

/**
 * Valor no formato do tipo do atributo. PRICE: moeda antes ou depois do número, sem espaço
 * (a API recusa "$ 100"); os outros tipos, como a ajuda do Google descreve.
 */
function checkCustomizerValue(type: string, raw: string): { value?: string; error?: string; warnings: string[] } {
  const value = raw.trim();
  const warnings: string[] = [];
  if (!value) return { error: "value não pode ser vazio.", warnings };
  const number = String.raw`\d+(?:[.,]\d+)*`;
  if (type === "NUMBER") {
    if (!new RegExp(`^-?${number}$`).test(value)) return { error: `"${raw}" não é número (ex.: 12 ou 11,5).`, warnings };
  } else if (type === "PERCENT") {
    if (!new RegExp(`^-?${number}%$`).test(value)) {
      return { error: `"${raw}" não é percentual: use o número seguido de %, sem espaço (ex.: 15%).`, warnings };
    }
  } else if (type === "PRICE") {
    if (/\s/.test(value)) {
      return {
        error: `"${raw}" tem espaço: em PRICE a moeda fica colada no número (ex.: ${value.replace(/\s+/g, "")}).`,
        warnings,
      };
    }
    const currency = String.raw`[^\d\s.,%-]{1,4}`;
    if (!new RegExp(`^(?:${currency}${number}|${number}${currency})$`).test(value)) {
      return { error: `"${raw}" não é preço: use moeda + número, sem espaço (ex.: R$99,90, BRL99,90 ou 99,90BRL).`, warnings };
    }
  } else if (type === "TEXT") {
    if ([...value].length > 30) {
      warnings.push(
        `O valor tem ${[...value].length} caracteres: num título (máx. 30) o texto final estoura e o anúncio usa o valor padrão.`
      );
    }
  } else {
    return { error: `Atributo de tipo ${type} não é suportado aqui.`, warnings };
  }
  return { value, warnings };
}

interface CustomizerTarget {
  level: CustomizerLevel;
  /** resource name do alvo (campanha, grupo ou critério); undefined no nível da conta. */
  resourceName?: string;
  label: string;
  info: Row;
}

/** Lê o alvo do valor (campanha, grupo ou palavra-chave) e confere que existe e aceita valor. */
async function resolveTarget(
  client: GoogleAdsClient,
  customerId: string,
  cid: string,
  level: CustomizerLevel,
  ids: { campaignId?: string; adGroupId?: string; criterionId?: string }
): Promise<CustomizerTarget | { error: string }> {
  if (level === "CUSTOMER") return { level, label: `conta ${cid}`, info: { customer_id: cid } };
  if (level === "CAMPAIGN") {
    const rows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${ids.campaignId}`);
    const campaign = asRow(rows[0]?.campaign);
    if (!rows[0]) return { error: `Campanha ${ids.campaignId} não encontrada na conta ${cid}.` };
    if (campaign.status === "REMOVED") return { error: `A campanha ${ids.campaignId} ("${campaign.name}") está removida.` };
    return {
      level,
      resourceName: `customers/${cid}/campaigns/${ids.campaignId}`,
      label: `campanha ${ids.campaignId} ("${campaign.name}")`,
      info: { campaign_id: ids.campaignId, campaign: campaign.name },
    };
  }
  if (level === "AD_GROUP") {
    const row = await fetchAdGroup(client, customerId, ids.adGroupId!);
    if (!row) return { error: `Grupo de anúncios ${ids.adGroupId} não encontrado na conta ${cid}.` };
    const adGroup = asRow(row.adGroup);
    if (adGroup.status === "REMOVED") return { error: `O grupo ${ids.adGroupId} ("${adGroup.name}") está removido.` };
    return {
      level,
      resourceName: `customers/${cid}/adGroups/${ids.adGroupId}`,
      label: `grupo ${ids.adGroupId} ("${adGroup.name}")`,
      info: adGroupInfo(row),
    };
  }
  const rows = await client.searchStream(customerId,
    `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type, ad_group_criterion.status,
            ad_group_criterion.negative, ad_group.id, ad_group.name
     FROM ad_group_criterion
     WHERE ad_group.id = ${ids.adGroupId}
       AND ad_group_criterion.criterion_id = ${ids.criterionId}
       AND ad_group_criterion.type = 'KEYWORD'`);
  const criterion = asRow(rows[0]?.adGroupCriterion);
  if (!rows[0]) {
    return { error: `Palavra-chave ${ids.criterionId} não encontrada no grupo ${ids.adGroupId} da conta ${cid} (valor por palavra-chave só vale para KEYWORD).` };
  }
  const keyword = asRow(criterion.keyword);
  if (criterion.status === "REMOVED") return { error: `A palavra-chave "${keyword.text}" está removida.` };
  if (criterion.negative) return { error: `"${keyword.text}" é palavra-chave negativa: não recebe customizador.` };
  return {
    level,
    resourceName: `customers/${cid}/adGroupCriteria/${ids.adGroupId}~${ids.criterionId}`,
    label: `palavra-chave "${keyword.text}" [${keyword.matchType}] do grupo ${ids.adGroupId}`,
    info: { ad_group_id: ids.adGroupId, criterion_id: ids.criterionId, keyword: keyword.text, match_type: keyword.matchType },
  };
}

function targetIdsProblem(level: CustomizerLevel, ids: { campaignId?: string; adGroupId?: string; criterionId?: string }): string | null {
  const need: Record<CustomizerLevel, string[]> = {
    CUSTOMER: [],
    CAMPAIGN: ["campaignId"],
    AD_GROUP: ["adGroupId"],
    KEYWORD: ["adGroupId", "criterionId"],
  };
  const missing = need[level].filter((key) => !given(ids[key as keyof typeof ids]));
  if (missing.length) return `level=${level} exige ${missing.join(" e ")}. Nada foi enviado.`;
  return invalidIds(ids);
}

/** Resolve o atributo por ID numérico ou por nome (sem diferenciar maiúsculas). */
function findAttribute(attributes: CustomizerAttribute[], ref: string): CustomizerAttribute | undefined {
  const wanted = ref.trim();
  if (/^\d+$/.test(wanted)) {
    const byId = attributes.find((attribute) => attribute.id === wanted);
    if (byId) return byId;
  }
  const matches = attributes.filter((attribute) => attribute.name.toLowerCase() === wanted.toLowerCase());
  return matches.find((attribute) => attribute.status === "ENABLED") ?? matches[0];
}

async function fetchLevelValue(
  client: GoogleAdsClient,
  customerId: string,
  level: CustomizerLevel,
  attribute: CustomizerAttribute,
  targetResource: string | undefined
): Promise<{ resourceName: string; type: string; value: string } | null> {
  const spec = LEVEL_SPEC[level];
  const filters = [
    `${spec.resource}.customizer_attribute = '${attribute.resourceName}'`,
    `${spec.resource}.status = 'ENABLED'`,
  ];
  if (spec.linkField && targetResource) filters.push(`${spec.resource}.${spec.linkField} = '${targetResource}'`);
  const rows = await client.searchStream(customerId,
    `SELECT ${spec.resource}.resource_name, ${spec.resource}.status,
            ${spec.resource}.value.type, ${spec.resource}.value.string_value
     FROM ${spec.resource}
     WHERE ${filters.join(" AND ")}`);
  const link = asRow(rows[0]?.[spec.rowKey]);
  if (!rows[0]) return null;
  const value = asRow(link.value);
  return { resourceName: String(link.resourceName ?? ""), type: String(value.type ?? ""), value: String(value.stringValue ?? "") };
}

function customizerCreate(level: CustomizerLevel, attribute: CustomizerAttribute, target: CustomizerTarget, value: string): Row {
  const spec = LEVEL_SPEC[level];
  return {
    ...(spec.linkJson && target.resourceName ? { [spec.linkJson]: target.resourceName } : {}),
    customizerAttribute: attribute.resourceName,
    value: { type: attribute.type, stringValue: value },
  };
}

/** Anúncios RSA (não removidos) que usam cada atributo, pelo texto {CUSTOMIZER.Nome...}. */
async function customizerUsage(
  client: GoogleAdsClient,
  customerId: string,
  filters: string[] = []
): Promise<Map<string, Array<{ ad_id: string; ad_group_id: string; campaign_id: string; status: unknown; texts: string[] }>>> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions, ad_group.id, campaign.id
     FROM ad_group_ad
     WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
       AND ad_group_ad.status != 'REMOVED'${filters.map((f) => `\n       AND ${f}`).join("")}`);
  const usage = new Map<string, Array<{ ad_id: string; ad_group_id: string; campaign_id: string; status: unknown; texts: string[] }>>();
  for (const row of rows) {
    const adGroupAd = asRow(row.adGroupAd);
    const ad = asRow(adGroupAd.ad);
    const rsa = asRow(ad.responsiveSearchAd);
    const texts = [...readTexts(rsa.headlines), ...readTexts(rsa.descriptions)].map((item) => item.text);
    const byName = new Map<string, string[]>();
    for (const ref of customizerRefs(texts)) {
      const key = ref.name.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), ref.text]);
    }
    for (const [name, refTexts] of byName) {
      usage.set(name, [
        ...(usage.get(name) ?? []),
        {
          ad_id: String(ad.id ?? ""),
          ad_group_id: String(asRow(row.adGroup).id ?? ""),
          campaign_id: String(asRow(row.campaign).id ?? ""),
          status: adGroupAd.status,
          texts: [...new Set(refTexts)],
        },
      ]);
    }
  }
  return usage;
}

// ── Anúncios só de chamada ────────────────────────────────────────────

/** Deprecação oficial: sem criação desde jan/2026; param de veicular em fev/2027. */
const CALL_ONLY_SUNSET = "2027-02-01";
const digitsOf = (phone: unknown) => String(phone ?? "").replace(/\D/g, "");

// ══════════════════════════════════════════════════════════════════════

export function registerRsaAdsTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── Leitura: desempenho e criativos ─────────────────────────────────

  mcp.registerTool(
    "get_ad_performance",
    {
      description: [
        "Métricas por anúncio no período (gasto, impressões, cliques, CTR, conversões, receita, ROAS).",
        "READ OPERATION.",
        "",
        "Cada linha traz ad_id, ad_group_id e campaign_id — os IDs que update_ad, update_ad_status e",
        "delete_ad pedem — mais força do anúncio (ad_strength) e aprovação. Só anúncios com impressão no período.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios."),
        limit: z.number().optional().describe("Máximo de linhas. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, adGroupId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badIds = invalidIds({ customerId: cleanCid(customerId), campaignId, adGroupId });
      if (badIds) return fail(badIds);
      const max = limit ?? 50;
      if (!Number.isInteger(max) || max < 1) return fail(`limit inválido: ${limit}. Use um inteiro positivo.`);
      const client = getClient();
      const filters = [buildDateClause(dateRange, days), "ad_group_ad.status != 'REMOVED'", "metrics.impressions > 0"];
      if (given(campaignId)) filters.push(`campaign.id = ${campaignId}`);
      if (given(adGroupId)) filters.push(`ad_group.id = ${adGroupId}`);

      const results = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status,
                ad_group.id, ad_group.name, campaign.id, campaign.name,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM ad_group_ad
         WHERE ${filters.join("\n           AND ")}
         ORDER BY metrics.cost_micros DESC
         LIMIT ${max}`);

      const ads = results.map((row) => {
        const adGroupAd = asRow(row.adGroupAd);
        const ad = asRow(adGroupAd.ad);
        const adGroup = asRow(row.adGroup);
        const campaign = asRow(row.campaign);
        const metrics = asRow(row.metrics);
        const spend = microsToMoney(metrics.costMicros);
        const conversions = num(metrics.conversions);
        const revenue = num(metrics.conversionsValue);
        return {
          ad_id: ad.id,
          ad_name: ad.name,
          ad_type: ad.type,
          status: adGroupAd.status,
          ad_strength: adGroupAd.adStrength,
          approval_status: asRow(adGroupAd.policySummary).approvalStatus,
          ad_group_id: adGroup.id,
          ad_group_name: adGroup.name,
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          spend: round2(spend),
          impressions: num(metrics.impressions),
          clicks: num(metrics.clicks),
          ctr: round2(num(metrics.ctr) * 100),
          conversions,
          revenue: round2(revenue),
          roas: spend > 0 ? round2(revenue / spend) : 0,
        };
      });
      return renderRows(ads, format, `${ads.length} ad(s).`, ads);
    }
  );

  mcp.registerTool(
    "get_ad_creatives",
    {
      description: [
        "Criativos dos anúncios: títulos e descrições de RSA com a posição fixada (pinned_field),",
        "URLs finais, paths, status, força do anúncio e aprovação. READ OPERATION.",
        "",
        "Traz ad_id, ad_group_id e campaign_id para encadear com update_ad / update_ad_status / delete_ad.",
        "Para Display, Demand Gen e vídeo (imagens, vídeos, cards) e para problemas de política, use list_ads.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios."),
        limit: z.number().optional().describe("Máximo de anúncios. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badIds = invalidIds({ customerId: cleanCid(customerId), campaignId, adGroupId });
      if (badIds) return fail(badIds);
      const max = limit ?? 50;
      if (!Number.isInteger(max) || max < 1) return fail(`limit inválido: ${limit}. Use um inteiro positivo.`);
      const client = getClient();
      const filters = ["ad_group_ad.status != 'REMOVED'"];
      if (given(campaignId)) filters.push(`campaign.id = ${campaignId}`);
      if (given(adGroupId)) filters.push(`ad_group.id = ${adGroupId}`);

      const results = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name,
                ad_group_ad.ad.responsive_search_ad.headlines,
                ad_group_ad.ad.responsive_search_ad.descriptions,
                ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2,
                ad_group_ad.ad.final_urls, ad_group_ad.ad.display_url,
                ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status,
                ad_group.id, ad_group.name, campaign.id, campaign.name
         FROM ad_group_ad
         WHERE ${filters.join(" AND ")}
         LIMIT ${max}`);

      const creatives = results.map((row) => {
        const adGroupAd = asRow(row.adGroupAd);
        const ad = asRow(adGroupAd.ad);
        const rsa = asRow(ad.responsiveSearchAd);
        const adGroup = asRow(row.adGroup);
        const campaign = asRow(row.campaign);
        return {
          ad_id: ad.id,
          ad_type: ad.type,
          status: adGroupAd.status,
          ad_strength: adGroupAd.adStrength,
          approval_status: asRow(adGroupAd.policySummary).approvalStatus,
          ad_group_id: adGroup.id,
          ad_group_name: adGroup.name,
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          final_urls: ad.finalUrls ?? [],
          ...(ad.displayUrl ? { display_url: ad.displayUrl } : {}),
          ...(rsa.path1 ? { path1: rsa.path1 } : {}),
          ...(rsa.path2 ? { path2: rsa.path2 } : {}),
          headlines: asRows(rsa.headlines).map(textView),
          descriptions: asRows(rsa.descriptions).map(textView),
        };
      });
      if (format === "table" || format === "csv") {
        const flat = creatives.map((c) => ({
          ...c,
          final_urls: (c.final_urls as string[]).join(" "),
          headlines: c.headlines.map((h) => (h.pinned_field ? `${h.text} [${h.pinned_field}]` : h.text)).join(" | "),
          descriptions: c.descriptions.map((d) => (d.pinned_field ? `${d.text} [${d.pinned_field}]` : d.text)).join(" | "),
        }));
        return renderRows(flat, format, "", flat);
      }
      return done(`${creatives.length} creative(s).\n\n${formatJson(creatives)}`);
    }
  );

  mcp.registerTool(
    "get_asset_performance",
    {
      description: [
        "Desempenho por asset (título, descrição, imagem, vídeo). READ OPERATION.",
        "",
        "level='AD' (default): ad_group_ad_asset_view — RSA, Demand Gen e App (o Google não oferece",
        "esta visão para anúncio responsivo de Display). Uma linha por asset em cada anúncio, com",
        "ad_id/ad_group_id/campaign_id, posição fixada (pinned_field), origem (source) e métricas",
        "comparadas à média do mesmo tipo de asset no anúncio: ctr_index e conv_rate_index (1 = média),",
        "ctr_rank (1/N = maior CTR entre os títulos, ou descrições, do anúncio), share_of_impressions_pct,",
        "CPA, ROAS e um sinal (acima/abaixo da média, poucos dados).",
        "O performance_label (LOW/GOOD/BEST) só aparece quando a API devolve (Demand Gen, App): para",
        "Pesquisa e Display ele deixou de vir na v23. Por padrão só assets ativos no anúncio",
        "(enabled=TRUE); includeRemoved inclui os que já saíram. Estatística completa por asset de RSA",
        `só existe a partir de ${ASSET_STATS_START}.`,
        "groupBy='ASSET' soma o mesmo asset em todos os anúncios (sem IDs de anúncio).",
        "",
        "level='PMAX': assets de asset groups PMax, com métricas no período + primary_status",
        "(o status de veiculação/política do link). Assets sem impressões no período podem não aparecer.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(["AD", "PMAX"]).optional().describe("AD (assets de anúncio) ou PMAX (assets de asset group). Default: AD."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (level=AD)."),
        adId: z.string().optional().describe("Filtra por anúncio (level=AD)."),
        assetGroupId: z.string().optional().describe("Filtra por asset group (level=PMAX)."),
        fieldType: z.enum(ASSET_VIEW_FIELD_TYPES).optional()
          .describe("Filtra pelo papel do asset no anúncio (level=AD)."),
        groupBy: z.enum(["AD", "ASSET"]).optional().describe("AD (default): por asset em cada anúncio. ASSET: soma o asset em todos os anúncios."),
        includeRemoved: z.boolean().optional().describe("Inclui assets que já saíram do anúncio (enabled=false). Default: false."),
        minImpressions: z.number().optional().describe("Abaixo disso o sinal é 'poucos dados'. Default: 100."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, level, campaignId, adGroupId, adId, assetGroupId, fieldType, groupBy, includeRemoved, minImpressions, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badIds = invalidIds({ customerId: cleanCid(customerId), campaignId, adGroupId, adId, assetGroupId }) ??
        badEnum("fieldType", fieldType, ASSET_VIEW_FIELD_TYPES) ?? badEnum("level", level, ["AD", "PMAX"]) ??
        badEnum("groupBy", groupBy, ["AD", "ASSET"]);
      if (badIds) return fail(badIds);
      const dateClause = buildDateClause(dateRange, days);
      const client = getClient();

      if ((level ?? "AD") === "PMAX") {
        // asset_group_asset não tem performance_label; o sinal equivalente é primary_status.
        const filters = ["asset_group_asset.status != 'REMOVED'", dateClause];
        if (given(assetGroupId)) filters.push(`asset_group.id = ${assetGroupId}`);
        if (given(campaignId)) filters.push(`campaign.id = ${campaignId}`);
        const results = await client.searchStream(customerId,
          `SELECT campaign.name, asset_group.name, asset_group_asset.field_type,
                  asset_group_asset.primary_status, asset_group_asset.primary_status_reasons,
                  asset_group_asset.status,
                  asset.id, asset.name, asset.text_asset.text, asset.image_asset.full_size.url,
                  asset.youtube_video_asset.youtube_video_id,
                  metrics.impressions, metrics.clicks, metrics.conversions,
                  metrics.conversions_value, metrics.cost_micros
           FROM asset_group_asset
           WHERE ${filters.join(" AND ")}
           ORDER BY metrics.impressions DESC`);
        const rows = results.map((r) => {
          const link = asRow(r.assetGroupAsset);
          const asset = asRow(r.asset);
          const metrics = asRow(r.metrics);
          return {
            asset_group: asRow(r.assetGroup).name,
            field_type: link.fieldType,
            primary_status: link.primaryStatus,
            primary_status_reasons: link.primaryStatusReasons,
            status: link.status,
            asset_id: asset.id,
            content: asRow(asset.textAsset).text ?? asRow(asRow(asset.imageAsset).fullSize).url ?? asRow(asset.youtubeVideoAsset).youtubeVideoId ?? asset.name,
            impressions: num(metrics.impressions),
            clicks: num(metrics.clicks),
            conversions: num(metrics.conversions),
            conversions_value: num(metrics.conversionsValue),
            spend: microsToMoney(metrics.costMicros),
          };
        });
        return renderRows(rows, format, `${rows.length} asset(s) PMax no período (primary_status + métricas).`, rows);
      }

      const minImpr = minImpressions ?? 100;
      const filters = [dateClause];
      if (!includeRemoved) filters.push("ad_group_ad_asset_view.enabled = TRUE");
      if (given(campaignId)) filters.push(`campaign.id = ${campaignId}`);
      if (given(adGroupId)) filters.push(`ad_group.id = ${adGroupId}`);
      if (given(adId)) filters.push(`ad_group_ad.ad.id = ${adId}`);
      if (fieldType) filters.push(`ad_group_ad_asset_view.field_type = '${fieldType}'`);

      const results = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
                ad_group_ad.ad.id, ad_group_ad.ad.type,
                ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.pinned_field,
                ad_group_ad_asset_view.source, ad_group_ad_asset_view.enabled,
                ad_group_ad_asset_view.performance_label, ad_group_ad_asset_view.policy_summary,
                asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url,
                asset.youtube_video_asset.youtube_video_id,
                metrics.impressions, metrics.clicks, metrics.conversions,
                metrics.conversions_value, metrics.cost_micros
         FROM ad_group_ad_asset_view
         WHERE ${filters.join("\n           AND ")}
         ORDER BY metrics.impressions DESC`);

      interface AssetRow {
        key: string;
        groupKey: string;
        base: Row;
        impressions: number;
        clicks: number;
        conversions: number;
        value: number;
        costMicros: number;
      }
      const byKey = new Map<string, AssetRow>();
      for (const r of results) {
        const view = asRow(r.adGroupAdAssetView);
        const asset = asRow(r.asset);
        const metrics = asRow(r.metrics);
        const ad = asRow(asRow(r.adGroupAd).ad);
        const adGroup = asRow(r.adGroup);
        const campaign = asRow(r.campaign);
        const adKey = groupBy === "ASSET" ? "" : String(ad.id ?? "");
        const key = `${adKey}|${asset.id}|${view.fieldType}`;
        const label = String(view.performanceLabel ?? "");
        const approval = asRow(view.policySummary).approvalStatus;
        const content = asRow(asset.textAsset).text ?? asRow(asRow(asset.imageAsset).fullSize).url ?? asRow(asset.youtubeVideoAsset).youtubeVideoId ?? asset.id;
        const base: Row = groupBy === "ASSET"
          ? { field_type: view.fieldType, asset_id: asset.id, asset_type: asset.type, content }
          : {
              campaign_id: campaign.id,
              campaign: campaign.name,
              ad_group_id: adGroup.id,
              ad_group: adGroup.name,
              ad_id: ad.id,
              ad_type: ad.type,
              field_type: view.fieldType,
              asset_id: asset.id,
              content,
              ...(normalizePin(view.pinnedField) ? { pinned_field: normalizePin(view.pinnedField) } : {}),
              source: view.source,
              ...(view.enabled === false ? { enabled: false } : {}),
              ...(approval && approval !== "APPROVED" ? { approval_status: approval } : {}),
              ...(MEANINGFUL_LABELS.has(label) ? { performance_label: label } : {}),
            };
        const entry = byKey.get(key) ?? {
          key,
          groupKey: `${adKey}|${view.fieldType}`,
          base,
          impressions: 0, clicks: 0, conversions: 0, value: 0, costMicros: 0,
        };
        entry.impressions += num(metrics.impressions);
        entry.clicks += num(metrics.clicks);
        entry.conversions += num(metrics.conversions);
        entry.value += num(metrics.conversionsValue);
        entry.costMicros += num(metrics.costMicros);
        byKey.set(key, entry);
      }

      // Média do mesmo tipo de asset no mesmo anúncio (ou na conta, com groupBy=ASSET)
      const groups = new Map<string, { impressions: number; clicks: number; conversions: number }>();
      for (const entry of byKey.values()) {
        const group = groups.get(entry.groupKey) ?? { impressions: 0, clicks: 0, conversions: 0 };
        group.impressions += entry.impressions;
        group.clicks += entry.clicks;
        group.conversions += entry.conversions;
        groups.set(entry.groupKey, group);
      }
      const rows = [...byKey.values()].map((entry): Row => {
        const group = groups.get(entry.groupKey)!;
        const spend = entry.costMicros / 1_000_000;
        const ctr = entry.impressions ? entry.clicks / entry.impressions : 0;
        const convRate = entry.clicks ? entry.conversions / entry.clicks : 0;
        const groupCtr = group.impressions ? group.clicks / group.impressions : 0;
        const groupConvRate = group.clicks ? group.conversions / group.clicks : 0;
        const ctrIndex = groupCtr ? round2(ctr / groupCtr) : null;
        const convIndex = groupConvRate ? round2(convRate / groupConvRate) : null;
        let signal = "na média";
        if (entry.impressions < minImpr) signal = "poucos dados";
        else if (ctrIndex !== null && ctrIndex < 0.8 && (convIndex === null || convIndex < 0.8)) signal = "abaixo da média";
        else if (ctrIndex !== null && ctrIndex > 1.2 && (convIndex === null || convIndex >= 1)) signal = "acima da média";
        return {
          ...entry.base,
          impressions: entry.impressions,
          clicks: entry.clicks,
          ctr_pct: round2(ctr * 100),
          conversions: round2(entry.conversions),
          conv_rate_pct: round2(convRate * 100),
          conversions_value: round2(entry.value),
          spend: round2(spend),
          cpa: entry.conversions ? round2(spend / entry.conversions) : null,
          roas: spend ? round2(entry.value / spend) : null,
          share_of_impressions_pct: group.impressions ? round2((entry.impressions / group.impressions) * 100) : 0,
          ctr_index: ctrIndex,
          conv_rate_index: convIndex,
          signal,
        };
      });
      // Posição por CTR entre os assets do mesmo tipo no mesmo anúncio (1 = maior CTR)
      const rankGroups = new Map<string, Row[]>();
      [...byKey.values()].forEach((entry, index) => {
        rankGroups.set(entry.groupKey, [...(rankGroups.get(entry.groupKey) ?? []), rows[index]]);
      });
      for (const group of rankGroups.values()) {
        [...group].sort((a, b) => num(b.ctr_pct) - num(a.ctr_pct) || num(b.impressions) - num(a.impressions))
          .forEach((row, index) => { row.ctr_rank = `${index + 1}/${group.length}`; });
      }
      rows.sort((a, b) =>
        String(a.ad_id ?? "").localeCompare(String(b.ad_id ?? "")) ||
        String(a.field_type ?? "").localeCompare(String(b.field_type ?? "")) ||
        num(b.impressions) - num(a.impressions)
      );

      const notes: string[] = [];
      const start = periodStart(dateRange, days);
      if (start < ASSET_STATS_START) {
        notes.push(`O período começa em ${start}: o Google só tem estatística completa por asset de RSA a partir de ${ASSET_STATS_START}; antes disso os números por asset vêm incompletos.`);
      }
      notes.push("performance_label só aparece quando a API devolve (Demand Gen, App); para Pesquisa e Display a API deixou de devolver o rótulo na v23 — use ctr_index/conv_rate_index.");
      if (format === "table" || format === "csv") return renderRows(rows, format, "", rows);
      return done(
        `${rows.length} asset(s) ${groupBy === "ASSET" ? "somados em todos os anúncios" : "por anúncio"} no período.\n` +
          `${notes.map((n) => `- ${n}`).join("\n")}\n\n${formatJson(rows)}`
      );
    }
  );

  // ── Escrita: RSA ─────────────────────────────────────────────────────

  mcp.registerTool(
    "create_ad",
    {
      description: [
        "Cria um anúncio responsivo de Pesquisa (RSA) num grupo de anúncios. WRITE OPERATION — criado PAUSADO.",
        "",
        "headlines: 3–15 (até 30 caracteres); descriptions: 2–4 (até 90). Cada item é um texto ou",
        "{ text, pin } para fixar a posição: títulos em HEADLINE_1/HEADLINE_2/HEADLINE_3, descrições em",
        "DESCRIPTION_1/DESCRIPTION_2. Vários textos na mesma posição se revezam. Fixar reduz as",
        "combinações e costuma baixar a força do anúncio; texto que precisa aparecer sempre (marca, aviso",
        "legal) vai em HEADLINE_1, HEADLINE_2 ou DESCRIPTION_1. A chave do pin também pode ser pinnedField",
        "ou pinned_field (formato de list_ads/get_ad_creatives); chave desconhecida no item é recusada.",
        "",
        "Customizadores {CUSTOMIZER.Nome:Padrão} são conferidos contra os atributos da conta antes de",
        "gravar (ver list_customizers). {KeyWord:...}, {LOCATION(City):...} e {COUNTDOWN(...)} passam direto.",
        "Antes de gravar, confere que o grupo existe nesta conta e é de Pesquisa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios (SEARCH_STANDARD)."),
        finalUrl: z.string().describe("URL final (landing page)."),
        headlines: flexArray(textAssetInput()).describe("3–15 títulos: texto ou { text, pin: HEADLINE_1|HEADLINE_2|HEADLINE_3 }."),
        descriptions: flexArray(textAssetInput()).describe("2–4 descrições: texto ou { text, pin: DESCRIPTION_1|DESCRIPTION_2 }."),
        path1: z.string().optional().describe("Caminho 1 da URL exibida (máx. 15)."),
        path2: z.string().optional().describe("Caminho 2 da URL exibida (máx. 15)."),
      },
    },
    async ({ customerId, adGroupId, finalUrl, headlines, descriptions, path1, path2 }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, adGroupId });
      if (badIds) return fail(badIds);

      const errors: string[] = [];
      const url = checkUrl(finalUrl, "finalUrl", errors);
      const heads = parseTextItems(headlines, "HEADLINE", "headlines", errors).map((item) => ({ text: item.text, pin: item.pin ?? null }));
      const descs = parseTextItems(descriptions, "DESCRIPTION", "descriptions", errors).map((item) => ({ text: item.text, pin: item.pin ?? null }));
      validateFinalTexts(heads, "HEADLINE", errors);
      validateFinalTexts(descs, "DESCRIPTION", errors);
      checkPath(path1, "path1", errors);
      checkPath(path2, "path2", errors);
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const adGroupRow = await fetchAdGroup(client, customerId, adGroupId);
      const problem = searchAdGroupProblem(adGroupRow, adGroupId, cid);
      if (problem) return fail(`${problem} Nada foi enviado.`);
      const customizers = await checkCustomizerRefs(client, customerId, [...heads, ...descs].map((item) => item.text));
      if (customizers.errors.length) return fail(`Nada foi enviado:\n- ${customizers.errors.join("\n- ")}`);
      const warnings = [...pinWarnings(heads, descs), ...customizers.warnings];

      const adGroupAd: Row = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: {
          finalUrls: [url],
          responsiveSearchAd: {
            headlines: apiTexts(heads),
            descriptions: apiTexts(descs),
            ...(path1 ? { path1 } : {}),
            ...(path2 ? { path2 } : {}),
          },
        },
      };
      let result: Row;
      try {
        result = await client.mutateAdGroupAds(customerId, [{ create: adGroupAd }]);
      } catch (err) {
        return fail(`A API recusou o anúncio: ${errorMessage(err)}\nNada foi criado.`);
      }
      const resourceName = String(asRows(result.results)[0]?.resourceName ?? "");
      const summary = {
        ...adGroupInfo(adGroupRow!),
        ...(resourceName ? { ad_id: idFromResource(resourceName), resource_name: resourceName } : {}),
        status: "PAUSED",
        final_url: url,
        headlines: showTexts(heads),
        descriptions: showTexts(descs),
        warnings,
      };
      const header = client.isDryRun
        ? dryRunLine(client)
        : `RSA criado (PAUSADO) com ${heads.length} títulos e ${descs.length} descrições. Ative com update_ad_status depois de revisar.`;
      return done(`${header}\n\n${formatJson(summary)}`);
    }
  );

  mcp.registerTool(
    "update_ad",
    {
      description: [
        "Edita um RSA existente: títulos, descrições, fixação (pin), URL final e paths. WRITE OPERATION.",
        "",
        "Lê o anúncio antes e só envia o que muda (nada muda = nenhuma escrita). Os pins dos textos que",
        "continuam no anúncio são mantidos por padrão — antes, reenviar a lista apagava todos.",
        "",
        "- headlines / descriptions: substituem a lista inteira. Item = texto (mantém o pin atual daquele",
        "  texto) ou { text, pin } (pin: HEADLINE_1..3 / DESCRIPTION_1..2; null solta o pin).",
        "  keepExistingPins=false descarta os pins atuais dos textos sem pin informado.",
        "- addHeadlines / removeHeadlines / addDescriptions / removeDescriptions: mexem só nos textos",
        "  citados, sem reenviar os outros (não combine com headlines/descriptions da mesma lista).",
        "- setPins: [{ text, pin }] muda só a fixação de textos que já estão no anúncio (pin obrigatório;",
        "  null solta). Em todos os itens a chave do pin também pode ser pinnedField ou pinned_field.",
        "- finalUrl, path1, path2 (\"\" limpa o path).",
        "Mostra antes/depois e avisa quando muitas posições ficam fixadas. O anúncio passa por nova revisão.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adId: z.string().describe("ID do anúncio."),
        adGroupId: z.string().optional().describe("ID do grupo (opcional, confere que o anúncio é desse grupo)."),
        finalUrl: z.string().optional().describe("Nova URL final."),
        headlines: flexArray(textAssetInput()).optional().describe("Nova lista completa de títulos (3–15)."),
        descriptions: flexArray(textAssetInput()).optional().describe("Nova lista completa de descrições (2–4)."),
        addHeadlines: flexArray(textAssetInput()).optional().describe("Títulos a acrescentar."),
        removeHeadlines: flexArray(z.string()).optional().describe("Textos de títulos a retirar."),
        addDescriptions: flexArray(textAssetInput()).optional().describe("Descrições a acrescentar."),
        removeDescriptions: flexArray(z.string()).optional().describe("Textos de descrições a retirar."),
        setPins: flexArray(textAssetObject()).optional()
          .describe("Muda a fixação de textos existentes: [{ text, pin }] (pin obrigatório; null = soltar)."),
        keepExistingPins: z.boolean().optional().describe("Ao substituir a lista, manter o pin dos textos que continuam. Default: true."),
        path1: z.string().optional().describe("Novo path 1 (\"\" limpa)."),
        path2: z.string().optional().describe("Novo path 2 (\"\" limpa)."),
      },
    },
    async (args) => {
      const { customerId, adId, adGroupId, finalUrl, path1, path2 } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, adId, adGroupId });
      if (badIds) return fail(badIds);

      const errors: string[] = [];
      const touches = (value: unknown) => value !== undefined;
      const headlineOps = touches(args.headlines) || touches(args.addHeadlines) || touches(args.removeHeadlines);
      const descriptionOps = touches(args.descriptions) || touches(args.addDescriptions) || touches(args.removeDescriptions);
      const pinOps = touches(args.setPins);
      if (!headlineOps && !descriptionOps && !pinOps && finalUrl === undefined && path1 === undefined && path2 === undefined) {
        return fail("Informe ao menos uma mudança (títulos, descrições, setPins, finalUrl, path1 ou path2). Nada foi enviado.");
      }
      if (touches(args.headlines) && (touches(args.addHeadlines) || touches(args.removeHeadlines))) {
        errors.push("Use headlines (lista completa) OU addHeadlines/removeHeadlines, não os dois.");
      }
      if (touches(args.descriptions) && (touches(args.addDescriptions) || touches(args.removeDescriptions))) {
        errors.push("Use descriptions (lista completa) OU addDescriptions/removeDescriptions, não os dois.");
      }
      const replaceHeads = touches(args.headlines) ? parseTextItems(args.headlines, "HEADLINE", "headlines", errors) : undefined;
      const replaceDescs = touches(args.descriptions) ? parseTextItems(args.descriptions, "DESCRIPTION", "descriptions", errors) : undefined;
      const addHeads = parseTextItems(args.addHeadlines, "HEADLINE", "addHeadlines", errors);
      const addDescs = parseTextItems(args.addDescriptions, "DESCRIPTION", "addDescriptions", errors);
      const removeHeads = (Array.isArray(args.removeHeadlines) ? args.removeHeadlines : []).map((t) => String(t).trim()).filter(Boolean);
      const removeDescs = (Array.isArray(args.removeDescriptions) ? args.removeDescriptions : []).map((t) => String(t).trim()).filter(Boolean);
      const pinChanges: Array<{ text: string; pin: string | null }> = [];
      (Array.isArray(args.setPins) ? args.setPins : []).forEach((entry: unknown, index: number) => {
        const where = `setPins[${index}]`;
        if (typeof entry === "string") {
          errors.push(`${where}: use { text, pin } — "${entry}" não diz a posição (pin null solta).`);
          return;
        }
        const parsed = parseTextEntry(entry, where, errors);
        if (!parsed) return;
        // Sem chave de pin não há o que mudar: antes, na string JSON, isso soltava o pin em silêncio
        if (!parsed.pinGiven) errors.push(`${where}: informe pin para "${parsed.text}" (HEADLINE_1..3, DESCRIPTION_1..2 ou null para soltar).`);
        else if (parsed.pin && !(PIN_VALUES as readonly string[]).includes(parsed.pin)) errors.push(`${where}: pin inválido "${parsed.pin}".`);
        else pinChanges.push({ text: parsed.text, pin: parsed.pin ?? null });
      });
      const url = finalUrl !== undefined ? checkUrl(finalUrl, "finalUrl", errors) : undefined;
      checkPath(path1, "path1", errors);
      checkPath(path2, "path2", errors);
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${RSA_READ_FIELDS}
         FROM ad_group_ad
         WHERE ad_group_ad.ad.id = ${adId}
           AND ad_group_ad.status != 'REMOVED'${given(adGroupId) ? `\n           AND ad_group.id = ${adGroupId}` : ""}`);
      if (rows.length === 0) {
        return fail(`Anúncio ${adId} não encontrado${given(adGroupId) ? ` no grupo ${adGroupId}` : ""} da conta ${cid} (ou está removido). Nada foi enviado.`);
      }
      const adGroupAd = asRow(rows[0].adGroupAd);
      const ad = asRow(adGroupAd.ad);
      const rsa = asRow(ad.responsiveSearchAd);
      const isRsa = ad.type === "RESPONSIVE_SEARCH_AD";
      if (!isRsa && (headlineOps || descriptionOps || pinOps || path1 !== undefined || path2 !== undefined)) {
        return fail(`O anúncio ${adId} é ${ad.type}, não RSA: títulos, descrições, pins e paths só valem para RSA. Nada foi enviado.`);
      }

      const keepPins = args.keepExistingPins !== false;
      const currentHeads = readTexts(rsa.headlines);
      const currentDescs = readTexts(rsa.descriptions);
      const notes: string[] = [];

      const applyChanges = (
        current: FinalText[],
        kind: TextKind,
        replace: TextItem[] | undefined,
        add: TextItem[],
        remove: string[]
      ): FinalText[] => {
        const info = KIND_INFO[kind];
        let next = current.map((item) => ({ ...item }));
        if (replace) {
          const pinByText = new Map(current.map((item) => [item.text, item.pin]));
          next = replace.map((item) => ({
            text: item.text,
            pin: item.pin !== undefined ? item.pin : keepPins ? pinByText.get(item.text) ?? null : null,
          }));
          const kept = replace.filter((item) => item.pin === undefined && keepPins && pinByText.get(item.text));
          if (kept.length) notes.push(`${kept.length} ${info.label}(s) mantiveram o pin atual: ${kept.map((item) => `"${item.text}"`).join(", ")}.`);
          const lost = current.filter((item) => item.pin && !replace.some((r) => r.text === item.text));
          if (lost.length) notes.push(`Saíram ${info.label}(s) fixados: ${lost.map((item) => `"${item.text}" [${item.pin}]`).join(", ")}.`);
        }
        for (const value of remove) {
          const index = next.findIndex((item) => item.text === value);
          if (index < 0) {
            errors.push(`${info.label} "${value}" não está no anúncio. Atuais: ${next.map((item) => `"${item.text}"`).join(", ")}.`);
            continue;
          }
          if (next[index].pin) notes.push(`Saiu o ${info.label} fixado "${value}" [${next[index].pin}].`);
          next.splice(index, 1);
        }
        for (const item of add) {
          const existing = next.find((entry) => entry.text === item.text);
          if (existing) {
            if (item.pin !== undefined && item.pin !== existing.pin) existing.pin = item.pin;
            else notes.push(`${info.label} "${item.text}" já estava no anúncio.`);
            continue;
          }
          next.push({ text: item.text, pin: item.pin ?? null });
        }
        return next;
      };

      const nextHeads = headlineOps ? applyChanges(currentHeads, "HEADLINE", replaceHeads, addHeads, removeHeads) : currentHeads.map((item) => ({ ...item }));
      const nextDescs = descriptionOps ? applyChanges(currentDescs, "DESCRIPTION", replaceDescs, addDescs, removeDescs) : currentDescs.map((item) => ({ ...item }));
      for (const change of pinChanges) {
        const head = nextHeads.find((item) => item.text === change.text);
        const desc = nextDescs.find((item) => item.text === change.text);
        const target = head ?? desc;
        if (!target) {
          errors.push(`setPins: "${change.text}" não é título nem descrição do anúncio (depois das outras mudanças).`);
          continue;
        }
        const kind: TextKind = head ? "HEADLINE" : "DESCRIPTION";
        if (change.pin !== null && !KIND_INFO[kind].pins.includes(change.pin)) {
          errors.push(`setPins: "${change.text}" é ${KIND_INFO[kind].label}; use ${KIND_INFO[kind].pins.join(", ")} ou null.`);
          continue;
        }
        target.pin = change.pin;
      }
      const headsChanged = isRsa && !sameTexts(currentHeads, nextHeads);
      const descsChanged = isRsa && !sameTexts(currentDescs, nextDescs);
      if (headsChanged) validateFinalTexts(nextHeads, "HEADLINE", errors);
      if (descsChanged) validateFinalTexts(nextDescs, "DESCRIPTION", errors);
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const currentTexts = new Set([...currentHeads, ...currentDescs].map((item) => item.text));
      const newTexts = [...nextHeads, ...nextDescs].map((item) => item.text).filter((value) => !currentTexts.has(value));
      const customizers = await checkCustomizerRefs(client, customerId, newTexts);
      if (customizers.errors.length) return fail(`Nada foi enviado:\n- ${customizers.errors.join("\n- ")}`);

      const update: Row = { resourceName: `customers/${cid}/ads/${adId}` };
      const rsaUpdate: Row = {};
      const mask: string[] = [];
      const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
      if (headsChanged) {
        rsaUpdate.headlines = apiTexts(nextHeads);
        mask.push("responsive_search_ad.headlines");
        changes.push({ field: "headlines", before: showTexts(currentHeads), after: showTexts(nextHeads) });
      }
      if (descsChanged) {
        rsaUpdate.descriptions = apiTexts(nextDescs);
        mask.push("responsive_search_ad.descriptions");
        changes.push({ field: "descriptions", before: showTexts(currentDescs), after: showTexts(nextDescs) });
      }
      // path1/path2 são de ResponsiveSearchAdInfo (caminho aninhado); "" limpa
      for (const [field, value] of [["path1", path1], ["path2", path2]] as const) {
        if (value !== undefined && value !== String(rsa[field] ?? "")) {
          rsaUpdate[field] = value;
          mask.push(`responsive_search_ad.${field}`);
          changes.push({ field, before: rsa[field] ?? "", after: value });
        }
      }
      if (url !== undefined) {
        const before = (ad.finalUrls as string[] | undefined) ?? [];
        if (before.length !== 1 || before[0] !== url) {
          update.finalUrls = [url];
          mask.push("final_urls");
          changes.push({ field: "final_urls", before, after: [url] });
        }
      }
      if (Object.keys(rsaUpdate).length) update.responsiveSearchAd = rsaUpdate;
      const label = `Anúncio ${adId} (grupo ${asRow(rows[0].adGroup).id}, "${asRow(rows[0].adGroup).name}")`;
      if (mask.length === 0) {
        return done(`${label}: nada a mudar — o anúncio já está assim. Nenhuma escrita foi enviada.${notes.length ? `\n- ${notes.join("\n- ")}` : ""}`);
      }
      const warnings = [
        ...(headsChanged || descsChanged ? pinWarnings(nextHeads, nextDescs) : []),
        ...customizers.warnings,
      ];

      let result: Row;
      try {
        result = await client.mutate(customerId, "ads", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`A API recusou a edição de ${label}: ${errorMessage(err)}\nNada foi alterado.`);
      }
      const header = client.isDryRun ? `${label} — ${dryRunLine(client)}` : `${label} atualizado: ${mask.join(", ")}. O anúncio passa por nova revisão.`;
      return done(`${header}\n\n${formatJson({ changes, notes, warnings, update_mask: mask.join(","), result })}`);
    }
  );

  mcp.registerTool(
    "update_ad_status",
    {
      description: [
        "Pausa ou ativa um anúncio. WRITE OPERATION.",
        "Confere antes que o anúncio existe no grupo; se já está no status pedido, nada é enviado.",
        "Avisa ao ativar anúncio reprovado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios."),
        adId: z.string().describe("ID do anúncio."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("Novo status."),
      },
    },
    async ({ customerId, adGroupId, adId, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, adGroupId, adId }) ?? badEnum("status", status, ["ENABLED", "PAUSED"]);
      if (badIds) return fail(badIds);
      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status,
                ad_group_ad.policy_summary.approval_status, ad_group.id, ad_group.name, campaign.name
         FROM ad_group_ad
         WHERE ad_group.id = ${adGroupId}
           AND ad_group_ad.ad.id = ${adId}`);
      if (!rows[0]) return fail(`Anúncio ${adId} não encontrado no grupo ${adGroupId} da conta ${cid}. Nada foi enviado.`);
      const adGroupAd = asRow(rows[0].adGroupAd);
      const label = `Anúncio ${adId} (${asRow(adGroupAd.ad).type}, grupo "${asRow(rows[0].adGroup).name}")`;
      if (adGroupAd.status === "REMOVED") return fail(`${label} está removido: não pode ser pausado nem ativado. Nada foi enviado.`);
      if (adGroupAd.status === status) return done(`${label} já está ${status}. Nenhuma escrita foi enviada.`);
      const warnings: string[] = [];
      const approval = asRow(adGroupAd.policySummary).approvalStatus;
      if (status === "ENABLED" && approval === "DISAPPROVED") {
        warnings.push("O anúncio está reprovado (DISAPPROVED): mesmo ativo, não veicula até ser corrigido ou aprovado.");
      }
      let result: Row;
      try {
        result = await client.mutateAdGroupAds(customerId, [
          { update: { resourceName: `customers/${cid}/adGroupAds/${adGroupId}~${adId}`, status }, updateMask: "status" },
        ]);
      } catch (err) {
        return fail(`A API recusou a mudança de status de ${label}: ${errorMessage(err)}\nNada foi alterado.`);
      }
      const header = client.isDryRun ? `${label} — ${dryRunLine(client)}` : `${label}: status ${adGroupAd.status} → ${status}.`;
      return done(`${header}\n\n${formatJson({ before: adGroupAd.status, after: status, warnings, result })}`);
    }
  );

  mcp.registerTool(
    "delete_ad",
    {
      description: [
        "Remove um anúncio (status REMOVED). WRITE OPERATION — não dá para desfazer; prefira pausar.",
        "Exige confirm: true. Confere antes que o anúncio existe no grupo, mostra o que sai e avisa se o",
        "grupo fica sem anúncio ativo. Anúncio já removido: nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios."),
        adId: z.string().describe("ID do anúncio."),
        confirm: z.boolean().describe("Precisa ser true para remover."),
      },
    },
    async ({ customerId, adGroupId, adId, confirm }) => {
      if (confirm !== true) return fail("Remoção não confirmada: envie confirm: true (ou pause com update_ad_status). Nada foi enviado.");
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, adGroupId, adId });
      if (badIds) return fail(badIds);
      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status,
                ad_group_ad.ad.responsive_search_ad.headlines, ad_group.id, ad_group.name, campaign.name
         FROM ad_group_ad
         WHERE ad_group.id = ${adGroupId}`);
      const target = rows.find((row) => String(asRow(asRow(row.adGroupAd).ad).id) === adId);
      if (!target) return fail(`Anúncio ${adId} não encontrado no grupo ${adGroupId} da conta ${cid}. Nada foi enviado.`);
      const adGroupAd = asRow(target.adGroupAd);
      const ad = asRow(adGroupAd.ad);
      const label = `Anúncio ${adId} (${ad.type}, grupo "${asRow(target.adGroup).name}")`;
      if (adGroupAd.status === "REMOVED") return done(`${label} já estava removido. Nenhuma escrita foi enviada.`);
      const otherEnabled = rows.filter((row) => row !== target && asRow(row.adGroupAd).status === "ENABLED").length;
      const warnings = otherEnabled === 0 ? ["O grupo fica sem nenhum anúncio ATIVO depois desta remoção — ele para de veicular."] : [];
      let result: Row;
      try {
        result = await client.mutateAdGroupAds(customerId, [{ remove: `customers/${cid}/adGroupAds/${adGroupId}~${adId}` }]);
      } catch (err) {
        return fail(`A API recusou a remoção de ${label}: ${errorMessage(err)}\nNada foi alterado.`);
      }
      const removed = {
        ad_id: adId,
        type: ad.type,
        previous_status: adGroupAd.status,
        headlines: showTexts(readTexts(asRow(ad.responsiveSearchAd).headlines)),
        other_enabled_ads_in_group: otherEnabled,
      };
      const header = client.isDryRun ? `${label} — ${dryRunLine(client)}` : `${label} REMOVIDO.`;
      return done(`${header}\n\n${formatJson({ removed, warnings, result })}`);
    }
  );

  // ── Auditoria ────────────────────────────────────────────────────────

  mcp.registerTool(
    "list_ads",
    {
      description: [
        "Auditoria de anúncios de qualquer tipo: RSA, Display responsivo (RDA), Demand Gen (multi-asset,",
        "carrossel, vídeo, produto), vídeo responsivo e só de chamada. READ OPERATION.",
        "",
        "Por anúncio: ad_id, ad_group_id, campaign_id (para update_ad / update_ad_status / delete_ad),",
        "status, primary_status e motivos, aprovação e tópicos de política, força do anúncio",
        "(ad_strength) e as sugestões do Google (action_items), contagem de assets, textos com a posição",
        "fixada e as imagens/vídeos/logos resolvidos (nome, URL, dimensões, ID do YouTube).",
        "onlyIssues=true deixa só anúncios com problema (reprovado, limitado, força POOR/AVERAGE,",
        "sugestões pendentes, só de chamada). includeTopCombinations traz as combinações de títulos e",
        "descrições mais exibidas de cada RSA no período (ad_group_ad_asset_combination_view).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios."),
        adType: z.enum(LIST_AD_TYPES).optional().describe("ALL (default), RSA, RDA, DEMAND_GEN (os 4 tipos), DEMAND_GEN_*, VIDEO_RESPONSIVE, CALL_ONLY."),
        adStrength: flexArray(z.enum(AD_STRENGTHS)).optional().describe("Só estas forças, ex.: [\"POOR\",\"AVERAGE\"]."),
        onlyIssues: z.boolean().optional().describe("Só anúncios com problema. Default: false."),
        includePaused: z.boolean().optional().describe("Inclui anúncios pausados. Default: true."),
        includeRemoved: z.boolean().optional().describe("Inclui anúncios removidos. Default: false."),
        resolveAssets: z.boolean().optional().describe("Resolve imagens/vídeos/logos (uma consulta a mais). Default: true."),
        includeTopCombinations: z.boolean().optional().describe("Combinações mais exibidas de cada RSA no período. Default: false."),
        combinationsPerAd: z.number().optional().describe("Combinações por RSA. Default: 3."),
        dateRange: dateRangeSchema.describe(`${DATE_RANGE_DESC} Só para includeTopCombinations.`),
        days: z.number().optional().describe(`${DAYS_DESC} Só para includeTopCombinations.`),
        limit: z.number().optional().describe("Máximo de anúncios. Default: 100."),
        format: formatSchema,
      },
    },
    async (args) => {
      const { customerId, campaignId, adGroupId, adType, onlyIssues, includePaused, includeRemoved, resolveAssets, includeTopCombinations, combinationsPerAd, dateRange, days, limit, format } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badIds = invalidIds({ customerId: cleanCid(customerId), campaignId, adGroupId }) ?? badEnum("adType", adType, LIST_AD_TYPES);
      if (badIds) return fail(badIds);
      const max = limit ?? 100;
      if (!Number.isInteger(max) || max < 1) return fail(`limit inválido: ${limit}. Use um inteiro positivo.`);
      const strengths = (Array.isArray(args.adStrength) ? args.adStrength : []).map((s) => String(s).toUpperCase());
      const badStrength = strengths.filter((s) => !(AD_STRENGTHS as readonly string[]).includes(s));
      if (badStrength.length) return fail(`adStrength inválido: ${badStrength.join(", ")}. Use ${AD_STRENGTHS.join(", ")}.`);
      const perAd = combinationsPerAd ?? 3;
      if (!Number.isInteger(perAd) || perAd < 1) return fail(`combinationsPerAd inválido: ${combinationsPerAd}.`);
      const comboDateClause = includeTopCombinations ? buildDateClause(dateRange, days) : "";

      const types = adType && adType !== "ALL" ? AD_TYPE_FILTERS[adType] : Object.keys(AD_CONTENT);
      const statuses = ["ENABLED", ...(includePaused === false ? [] : ["PAUSED"]), ...(includeRemoved ? ["REMOVED"] : [])];
      const filters = [`ad_group_ad.status IN (${statuses.map((s) => `'${s}'`).join(", ")})`];
      if (adType && adType !== "ALL") filters.push(`ad_group_ad.ad.type IN (${types.map((t) => `'${t}'`).join(", ")})`);
      if (given(campaignId)) filters.push(`campaign.id = ${campaignId}`);
      if (given(adGroupId)) filters.push(`ad_group.id = ${adGroupId}`);
      if (strengths.length) filters.push(`ad_group_ad.ad_strength IN (${strengths.map((s) => `'${s}'`).join(", ")})`);
      const select = [
        "ad_group_ad.ad.id", "ad_group_ad.ad.type", "ad_group_ad.ad.name", "ad_group_ad.status",
        "ad_group_ad.ad_strength", "ad_group_ad.action_items", "ad_group_ad.primary_status",
        "ad_group_ad.primary_status_reasons", "ad_group_ad.policy_summary.approval_status",
        "ad_group_ad.policy_summary.review_status", "ad_group_ad.policy_summary.policy_topic_entries",
        "ad_group_ad.ad.final_urls", "ad_group.id", "ad_group.name", "campaign.id", "campaign.name",
        "campaign.advertising_channel_type",
        ...contentFields(types),
      ];
      const client = getClient();
      // onlyIssues filtra depois (OR entre campos), então o LIMIT vai no código
      const rows = await client.searchStream(customerId,
        `SELECT ${select.join(", ")}
         FROM ad_group_ad
         WHERE ${filters.join("\n           AND ")}
         ORDER BY campaign.id, ad_group.id${onlyIssues ? "" : `\n         LIMIT ${max}`}`);

      const candidates = rows
        .map((row) => ({ row, type: String(asRow(asRow(row.adGroupAd).ad).type ?? "") }))
        .map((entry) => ({ ...entry, issues: adIssues(asRow(entry.row.adGroupAd), entry.type) }))
        .filter((entry) => !onlyIssues || entry.issues.length > 0)
        .slice(0, max);

      const refs = new Set<string>();
      if (resolveAssets !== false) for (const entry of candidates) collectAssetRefs(asRow(asRow(entry.row.adGroupAd).ad), entry.type, refs);
      const assetInfo = refs.size ? await fetchAssetInfo(client, customerId, refs) : new Map<string, Row>();

      const ads = candidates.map(({ row, type, issues }) => {
        const adGroupAd = asRow(row.adGroupAd);
        const ad = asRow(adGroupAd.ad);
        const policy = asRow(adGroupAd.policySummary);
        const content = adContent(ad, type, assetInfo);
        const topics = asRows(policy.policyTopicEntries).map((entry) => `${entry.topic} (${entry.type})`);
        return {
          ad_id: String(ad.id ?? ""),
          ad_group_id: String(asRow(row.adGroup).id ?? ""),
          ad_group: asRow(row.adGroup).name,
          campaign_id: String(asRow(row.campaign).id ?? ""),
          campaign: asRow(row.campaign).name,
          channel: asRow(row.campaign).advertisingChannelType,
          type,
          ...(ad.name ? { name: ad.name } : {}),
          status: adGroupAd.status,
          primary_status: adGroupAd.primaryStatus,
          primary_status_reasons: adGroupAd.primaryStatusReasons ?? [],
          approval_status: policy.approvalStatus,
          review_status: policy.reviewStatus,
          policy_topics: topics,
          ad_strength: adGroupAd.adStrength,
          action_items: adGroupAd.actionItems ?? [],
          final_urls: ad.finalUrls ?? [],
          asset_counts: content?.counts ?? {},
          ...(content ? { content: content.content } : {}),
          ...(type === "CALL_AD" ? { note: "a v23 removeu o conteúdo de CallAdInfo da API: só dá para ver IDs, status e métricas" } : {}),
          issues,
        };
      });

      // Combinações mais exibidas (só RSA tem esta visão)
      const combos = new Map<string, Row[]>();
      const rsaIds = ads.filter((ad) => ad.type === "RESPONSIVE_SEARCH_AD").map((ad) => ad.ad_id).filter((id) => /^\d+$/.test(id));
      if (includeTopCombinations && rsaIds.length) {
        const comboRows: Row[] = [];
        for (let start = 0; start < rsaIds.length; start += 200) {
          comboRows.push(...await client.searchStream(customerId,
            `SELECT ad_group_ad.ad.id, ad_group_ad_asset_combination_view.served_assets,
                    ad_group_ad_asset_combination_view.enabled, metrics.impressions
             FROM ad_group_ad_asset_combination_view
             WHERE ${comboDateClause}
               AND ad_group_ad_asset_combination_view.enabled = TRUE
               AND ad_group_ad.ad.id IN (${rsaIds.slice(start, start + 200).join(", ")})
             ORDER BY metrics.impressions DESC`));
        }
        const served = new Set<string>();
        for (const row of comboRows) for (const usage of asRows(asRow(row.adGroupAdAssetCombinationView).servedAssets)) served.add(String(usage.asset ?? ""));
        const servedInfo = served.size ? await fetchAssetInfo(client, customerId, served) : new Map<string, Row>();
        for (const row of comboRows) {
          const id = String(asRow(asRow(row.adGroupAd).ad).id ?? "");
          const list = combos.get(id) ?? [];
          if (list.length >= perAd) continue;
          list.push({
            impressions: num(asRow(row.metrics).impressions),
            served: asRows(asRow(row.adGroupAdAssetCombinationView).servedAssets).map((usage) => ({
              position: usage.servedAssetFieldType,
              text: asRow(servedInfo.get(idFromResource(usage.asset))?.textAsset).text ?? usage.asset,
            })),
          });
          combos.set(id, list);
        }
      }
      const output = ads.map((ad) => (combos.has(ad.ad_id) ? { ...ad, top_combinations: combos.get(ad.ad_id) } : ad));

      const countBy = (key: "type" | "ad_strength" | "approval_status") => {
        const counts: Record<string, number> = {};
        for (const ad of ads) {
          const value = String(ad[key] ?? "—");
          counts[value] = (counts[value] ?? 0) + 1;
        }
        return counts;
      };
      const summary = {
        ads: ads.length,
        with_issues: ads.filter((ad) => ad.issues.length).length,
        by_type: countBy("type"),
        by_strength: countBy("ad_strength"),
        by_approval: countBy("approval_status"),
      };
      if (format === "table" || format === "csv") {
        const flat = ads.map((ad) => ({
          ad_id: ad.ad_id, ad_group_id: ad.ad_group_id, campaign_id: ad.campaign_id, type: ad.type, status: ad.status,
          primary_status: ad.primary_status, approval: ad.approval_status, ad_strength: ad.ad_strength,
          headlines: num(ad.asset_counts.headlines), descriptions: num(ad.asset_counts.descriptions),
          action_items: (ad.action_items as unknown[]).length, issues: ad.issues.join("; "),
        }));
        return renderRows(flat, format, "", flat);
      }
      const truncated = !onlyIssues && rows.length >= max ? `\nMostrando os primeiros ${max} (aumente limit ou filtre por campanha/grupo).` : "";
      return done(`${ads.length} anúncio(s)${onlyIssues ? " com problema" : ""}.${truncated}\n\n${formatJson({ summary, ads: output })}`);
    }
  );

  // ── Customizadores ───────────────────────────────────────────────────

  mcp.registerTool(
    "list_customizers",
    {
      description: [
        "Customizadores de anúncio: atributos (nome, tipo TEXT/NUMBER/PRICE/PERCENT, status) e os valores",
        "definidos por conta, campanha, grupo de anúncios e palavra-chave. READ OPERATION.",
        "",
        "Nos RSAs o texto {CUSTOMIZER.Nome:Padrão} vira o valor do nível mais específico (palavra-chave >",
        "grupo > campanha > conta); sem valor, o padrão. Com includeUsage (default) mostra quantos RSAs",
        "usam cada atributo, referências a atributos inexistentes e atributos sem uso. Limite do Google:",
        `${MAX_ENABLED_CUSTOMIZER_ATTRIBUTES} atributos ativos por conta.`,
        "",
        "level/campaignId/adGroupId filtram os valores exibidos (values). ads_without_value sempre considera",
        "os valores ativos de todos os níveis acima de cada anúncio (conta, campanha, grupo, palavra-chave),",
        "então um anúncio que herda o valor da conta não aparece como sem valor só porque a conta foi filtrada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        attribute: z.string().optional().describe("Filtra por nome (ou ID) do atributo."),
        level: z.enum(["ALL", ...LEVELS]).optional().describe("Nível dos valores: ALL (default), CUSTOMER, CAMPAIGN, AD_GROUP, KEYWORD."),
        campaignId: z.string().optional().describe("Filtra valores de campanha/grupo/palavra-chave por campanha."),
        adGroupId: z.string().optional().describe("Filtra valores de grupo/palavra-chave por grupo."),
        includeRemoved: z.boolean().optional().describe("Inclui atributos e valores removidos. Default: false."),
        includeUsage: z.boolean().optional().describe("Varre os RSAs para ver quem usa cada atributo. Default: true."),
        format: formatSchema,
      },
    },
    async ({ customerId, attribute, level, campaignId, adGroupId, includeRemoved, includeUsage, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badIds = invalidIds({ customerId: cleanCid(customerId), campaignId, adGroupId }) ?? badEnum("level", level, ["ALL", ...LEVELS]);
      if (badIds) return fail(badIds);
      const client = getClient();
      const allAttributes = await fetchAttributes(client, customerId, includeRemoved === true);
      const attributes = given(attribute)
        ? allAttributes.filter((a) => a.id === attribute.trim() || a.name.toLowerCase() === attribute.trim().toLowerCase())
        : allAttributes;
      if (given(attribute) && attributes.length === 0) {
        return fail(`Atributo "${attribute}" não encontrado. Existentes: ${allAttributes.map((a) => a.name).join(", ") || "nenhum"}.`);
      }
      const wanted = new Set(attributes.map((a) => a.resourceName));
      const statusFilter = (resource: string) => (includeRemoved ? [] : [`${resource}.status = 'ENABLED'`]);
      const levels: CustomizerLevel[] = level && level !== "ALL" ? [level] : [...LEVELS];
      const withUsage = includeUsage !== false;
      // level/campaignId/adGroupId filtram só o que aparece em values. Valor da conta não é "da
      // campanha" e valor da campanha não é "do grupo", então saem da exibição com esses filtros.
      const shows = (lvl: CustomizerLevel) =>
        levels.includes(lvl) &&
        (lvl !== "CUSTOMER" || (!given(campaignId) && !given(adGroupId))) &&
        (lvl !== "CAMPAIGN" || !given(adGroupId));
      // A cobertura (ads_without_value) precisa de todos os níveis acima de cada anúncio, qualquer
      // que seja o filtro: sem isso, um anúncio que herda o valor da conta ou da campanha aparecia
      // como "cai no padrão" só porque aquele nível não foi exibido.
      const needs = (lvl: CustomizerLevel) => shows(lvl) || withUsage;

      type ValueRow = Row & { attribute: string; level: CustomizerLevel };
      const values: ValueRow[] = [];
      /** Valores que o anúncio realmente usa: todos os níveis, sem os removidos. */
      const coverage: ValueRow[] = [];
      const push = (lvl: CustomizerLevel, rowKey: string, rows: Row[], extra: (row: Row) => Row) => {
        for (const row of rows) {
          const link = asRow(row[rowKey]);
          if (!wanted.has(String(link.customizerAttribute ?? ""))) continue;
          const value: ValueRow = {
            attribute: String(asRow(row.customizerAttribute).name ?? idFromResource(link.customizerAttribute)),
            level: lvl,
            ...extra(row),
            value: asRow(link.value).stringValue,
            status: link.status,
          };
          if (shows(lvl)) values.push(value);
          if (withUsage && link.status !== "REMOVED") coverage.push(value);
        }
      };
      const where = (list: string[]) => (list.length ? `\n         WHERE ${list.join(" AND ")}` : "");
      if (needs("CUSTOMER")) {
        push("CUSTOMER", "customerCustomizer", await client.searchStream(customerId,
          `SELECT customer_customizer.customizer_attribute, customer_customizer.status,
                  customer_customizer.value.type, customer_customizer.value.string_value, customizer_attribute.name
           FROM customer_customizer${where(statusFilter("customer_customizer"))}`), () => ({}));
      }
      if (needs("CAMPAIGN")) {
        // Com só adGroupId, a campanha do grupo não é conhecida aqui: vêm todas (são poucas linhas)
        const filters = [...statusFilter("campaign_customizer"), ...(given(campaignId) ? [`campaign.id = ${campaignId}`] : [])];
        push("CAMPAIGN", "campaignCustomizer", await client.searchStream(customerId,
          `SELECT campaign_customizer.customizer_attribute, campaign_customizer.status,
                  campaign_customizer.value.type, campaign_customizer.value.string_value,
                  customizer_attribute.name, campaign.id, campaign.name
           FROM campaign_customizer${where(filters)}`),
          (row) => ({ campaign_id: String(asRow(row.campaign).id ?? ""), campaign: asRow(row.campaign).name }));
      }
      if (needs("AD_GROUP")) {
        const filters = [
          ...statusFilter("ad_group_customizer"),
          ...(given(campaignId) ? [`campaign.id = ${campaignId}`] : []),
          ...(given(adGroupId) ? [`ad_group.id = ${adGroupId}`] : []),
        ];
        push("AD_GROUP", "adGroupCustomizer", await client.searchStream(customerId,
          `SELECT ad_group_customizer.customizer_attribute, ad_group_customizer.status,
                  ad_group_customizer.value.type, ad_group_customizer.value.string_value,
                  customizer_attribute.name, ad_group.id, ad_group.name, campaign.id
           FROM ad_group_customizer${where(filters)}`),
          (row) => ({ campaign_id: String(asRow(row.campaign).id ?? ""), ad_group_id: String(asRow(row.adGroup).id ?? ""), ad_group: asRow(row.adGroup).name }));
      }
      if (needs("KEYWORD")) {
        const filters = [
          ...statusFilter("ad_group_criterion_customizer"),
          ...(given(campaignId) ? [`campaign.id = ${campaignId}`] : []),
          ...(given(adGroupId) ? [`ad_group.id = ${adGroupId}`] : []),
        ];
        push("KEYWORD", "adGroupCriterionCustomizer", await client.searchStream(customerId,
          `SELECT ad_group_criterion_customizer.customizer_attribute, ad_group_criterion_customizer.status,
                  ad_group_criterion_customizer.value.type, ad_group_criterion_customizer.value.string_value,
                  customizer_attribute.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group.id, campaign.id
           FROM ad_group_criterion_customizer${where(filters)}`),
          (row) => ({
            campaign_id: String(asRow(row.campaign).id ?? ""),
            ad_group_id: String(asRow(row.adGroup).id ?? ""),
            criterion_id: String(asRow(row.adGroupCriterion).criterionId ?? ""),
            keyword: asRow(asRow(row.adGroupCriterion).keyword).text,
            match_type: asRow(asRow(row.adGroupCriterion).keyword).matchType,
          }));
      }

      const usageFilters = [
        ...(given(campaignId) ? [`campaign.id = ${campaignId}`] : []),
        ...(given(adGroupId) ? [`ad_group.id = ${adGroupId}`] : []),
      ];
      const usage = withUsage ? await customizerUsage(client, customerId, usageFilters) : null;
      const enabledNames = new Set(allAttributes.filter((a) => a.status === "ENABLED").map((a) => a.name.toLowerCase()));

      const report = attributes.map((a) => {
        const sameAttribute = (v: ValueRow) => v.attribute.toLowerCase() === a.name.toLowerCase();
        const own = values.filter(sameAttribute);
        const users = usage?.get(a.name.toLowerCase()) ?? [];
        // Anúncios que caem no padrão: nenhum valor ativo na conta, na campanha nem no grupo do
        // anúncio. Conta com todos os níveis (coverage), não só com os exibidos em values.
        const covering = coverage.filter(sameAttribute);
        const hasCustomer = covering.some((v) => v.level === "CUSTOMER");
        const fallsToDefault = users.filter((u) =>
          !hasCustomer &&
          !covering.some((v) => (v.level === "CAMPAIGN" && v.campaign_id === u.campaign_id) || ((v.level === "AD_GROUP" || v.level === "KEYWORD") && v.ad_group_id === u.ad_group_id))
        );
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          status: a.status,
          syntax: `{CUSTOMIZER.${a.name}:padrão}`,
          values: own.map(({ attribute: _attribute, ...rest }) => rest),
          ...(usage
            ? {
                used_by_ads: users.length,
                ads_using: users.slice(0, 20).map((u) => ({ ad_id: u.ad_id, ad_group_id: u.ad_group_id, status: u.status })),
                ads_without_value: fallsToDefault.length,
              }
            : {}),
        };
      });
      const broken = usage
        ? [...usage.entries()].filter(([name]) => !enabledNames.has(name)).map(([name, users]) => ({
            reference: `{CUSTOMIZER.${name}}`,
            ads: users.map((u) => ({ ad_id: u.ad_id, ad_group_id: u.ad_group_id })),
          }))
        : [];
      const enabledCount = allAttributes.filter((a) => a.status === "ENABLED").length;
      const summary = {
        enabled_attributes: `${enabledCount}/${MAX_ENABLED_CUSTOMIZER_ATTRIBUTES}`,
        values: values.length,
        ...(usage ? { unused_attributes: report.filter((r) => r.used_by_ads === 0).map((r) => r.name), broken_references: broken } : {}),
      };
      if (format === "table" || format === "csv") {
        const flat = values.map((v) => ({ ...v }));
        return renderRows(flat, format, "", flat);
      }
      return done(`${report.length} atributo(s), ${values.length} valor(es).\n\n${formatJson({ summary, attributes: report })}`);
    }
  );

  mcp.registerTool(
    "create_customizer_attribute",
    {
      description: [
        "Cria um atributo de customizador de anúncio (ex.: Preco, Parcelas, Desconto, Cidade). WRITE OPERATION.",
        "",
        "type: TEXT (qualquer texto, ex.: \"12x sem juros\"), NUMBER (ex.: 11,5), PRICE (moeda colada no",
        "número, ex.: R$99,90) ou PERCENT (ex.: 15%). Nome: até 40 caracteres, único na conta (sem",
        `diferenciar maiúsculas); o Google aceita até ${MAX_ENABLED_CUSTOMIZER_ATTRIBUTES} atributos ativos.`,
        "Se já existe atributo ativo com o mesmo nome e tipo, nada é criado. Depois defina valores com",
        "set_customizer_value e use {CUSTOMIZER.Nome:padrão} nos títulos/descrições do RSA.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do atributo (1–40 caracteres; letras, números, _ e espaço)."),
        type: z.enum(CUSTOMIZER_TYPES).describe("TEXT, NUMBER, PRICE ou PERCENT."),
      },
    },
    async ({ customerId, name, type }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid }) ?? badEnum("type", type, CUSTOMIZER_TYPES);
      if (badIds) return fail(badIds);
      const clean = name.trim();
      if (!clean || [...clean].length > 40) return fail(`Nome inválido: "${name}" — precisa ter de 1 a 40 caracteres. Nada foi enviado.`);
      if (clean.startsWith("_") || !/^[\p{L}\p{N}_ ]+$/u.test(clean)) {
        return fail(
          `Nome inválido: "${name}" — use letras, números, _ e espaço, sem começar com _ (pontuação e símbolos quebram ` +
            "a sintaxe {CUSTOMIZER.Nome:padrão} e o Google pode reprovar o anúncio). Nada foi enviado."
        );
      }
      const client = getClient();
      const attributes = await fetchAttributes(client, customerId);
      const same = attributes.find((a) => a.name.toLowerCase() === clean.toLowerCase());
      if (same) {
        if (same.type === type) {
          return done(
            `O atributo "${same.name}" (${same.type}) já existe e está ativo — nada foi criado.\n\n` +
              formatJson({ id: same.id, resource_name: same.resourceName, name: same.name, type: same.type, syntax: `{CUSTOMIZER.${same.name}:padrão}` })
          );
        }
        return fail(`Já existe atributo ativo "${same.name}" do tipo ${same.type} (pedido: ${type}). O tipo não muda depois de criado; use outro nome. Nada foi enviado.`);
      }
      if (attributes.length >= MAX_ENABLED_CUSTOMIZER_ATTRIBUTES) {
        return fail(
          `A conta já tem ${attributes.length} atributos ativos (limite do Google: ${MAX_ENABLED_CUSTOMIZER_ATTRIBUTES}). ` +
            "Remova um sem uso (list_customizers mostra os sem uso; remove_customizer_attribute remove). Nada foi enviado."
        );
      }
      let result: Row;
      try {
        result = await client.mutate(customerId, "customizerAttributes", [{ create: { name: clean, type } }]);
      } catch (err) {
        return fail(`A API recusou o atributo "${clean}": ${errorMessage(err)}\nNada foi criado.`);
      }
      const resourceName = String(asRows(result.results)[0]?.resourceName ?? "");
      const info = {
        ...(resourceName ? { id: idFromResource(resourceName), resource_name: resourceName } : {}),
        name: clean,
        type,
        syntax: `{CUSTOMIZER.${clean}:padrão}`,
        next_step: "set_customizer_value para definir o valor na conta, campanha, grupo ou palavra-chave.",
      };
      const header = client.isDryRun ? dryRunLine(client) : `Atributo "${clean}" (${type}) criado.`;
      return done(`${header}\n\n${formatJson(info)}`);
    }
  );

  mcp.registerTool(
    "set_customizer_value",
    {
      description: [
        "Define o valor de um customizador num nível: CUSTOMER (conta), CAMPAIGN, AD_GROUP ou KEYWORD.",
        "WRITE OPERATION.",
        "",
        "O valor tem que casar com o tipo do atributo: PRICE com a moeda colada (R$99,90 ou 99,90BRL, sem",
        "espaço), PERCENT com % (15%), NUMBER (12 ou 11,5), TEXT livre. Lê o valor atual antes; valor",
        "igual = nenhuma escrita. A API não edita valor de customizador (só cria e remove) e não aceita",
        "mexer no mesmo recurso duas vezes na mesma requisição: trocar o valor é remover o atual e criar o",
        "novo, em duas chamadas — se a criação falhar, o valor antigo é recriado. Em validateOnly com valor",
        "já existente, só a remoção é validada pela API (o formato do novo valor é conferido aqui).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        attribute: z.string().describe("Nome ou ID do atributo (list_customizers)."),
        level: z.enum(LEVELS).describe("CUSTOMER, CAMPAIGN, AD_GROUP ou KEYWORD."),
        campaignId: z.string().optional().describe("Obrigatório em level=CAMPAIGN."),
        adGroupId: z.string().optional().describe("Obrigatório em level=AD_GROUP e KEYWORD."),
        criterionId: z.string().optional().describe("ID da palavra-chave (criterion_id), obrigatório em level=KEYWORD."),
        value: z.string().describe("Valor (ex.: R$99,90 · 15% · 12x sem juros)."),
      },
    },
    async ({ customerId, attribute, level, campaignId, adGroupId, criterionId, value }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const ids = { campaignId, adGroupId, criterionId };
      const problem = invalidIds({ customerId: cid }) ?? badEnum("level", level, LEVELS) ?? targetIdsProblem(level, ids);
      if (problem) return fail(problem);
      if (!value.trim()) return fail("value não pode ser vazio (para tirar o valor use remove_customizer_value). Nada foi enviado.");

      const client = getClient();
      const attr = findAttribute(await fetchAttributes(client, customerId), attribute);
      if (!attr) return fail(`Atributo ativo "${attribute}" não encontrado nesta conta (list_customizers / create_customizer_attribute). Nada foi enviado.`);
      const checked = checkCustomizerValue(attr.type, value);
      if (checked.error) return fail(`${checked.error} Atributo "${attr.name}" é ${attr.type}. Nada foi enviado.`);
      const target = await resolveTarget(client, customerId, cid, level, ids);
      if ("error" in target) return fail(`${target.error} Nada foi enviado.`);
      const current = await fetchLevelValue(client, customerId, level, attr, target.resourceName);
      const newValue = checked.value!;
      const label = `"${attr.name}" na ${target.label}`;
      const spec = LEVEL_SPEC[level];
      const create = customizerCreate(level, attr, target, newValue);
      const report = (extra: Row) => formatJson({ attribute: { id: attr.id, name: attr.name, type: attr.type }, level, target: target.info, before: current?.value ?? null, after: newValue, warnings: checked.warnings, ...extra });

      if (current && current.value === newValue) return done(`${label} já vale ${newValue}. Nenhuma escrita foi enviada.`);

      if (!current) {
        try {
          const result = await client.mutate(customerId, spec.service, [{ create }]);
          const header = client.isDryRun ? `${label} — ${dryRunLine(client)}` : `${label} definido: ${newValue}.`;
          return done(`${header}\n\n${report({ action: "created", result })}`);
        } catch (err) {
          return fail(`A API recusou o valor de ${label}: ${errorMessage(err)}\nNada foi alterado.`);
        }
      }

      // Troca: remove e cria em chamadas separadas (MutateError.ID_EXISTS_IN_MULTIPLE_MUTATES)
      if (client.isDryRun) {
        try {
          await client.mutate(customerId, spec.service, [{ remove: current.resourceName }]);
        } catch (err) {
          return fail(`${label}: a API recusou (validação) a remoção do valor atual: ${errorMessage(err)}\nNada foi gravado.`);
        }
        return done(
          `${label} — ${dryRunLine(client)}\nA remoção do valor atual (${current.value}) foi validada pela API. A criação do ` +
            `novo valor (${newValue}) não pode ser validada enquanto o atual existe; o formato ${attr.type} foi conferido aqui.\n\n` +
            report({ action: "replace (validado parcialmente)" })
        );
      }
      try {
        await client.mutate(customerId, spec.service, [{ remove: current.resourceName }]);
      } catch (err) {
        return fail(`A API recusou a remoção do valor atual de ${label} (${current.value}): ${errorMessage(err)}\nNada foi alterado.`);
      }
      try {
        const result = await client.mutate(customerId, spec.service, [{ create }]);
        return done(`${label}: ${current.value} → ${newValue}.\n\n${report({ action: "replaced", result })}`);
      } catch (err) {
        const reason = errorMessage(err);
        let rollback: string;
        try {
          await client.mutate(customerId, spec.service, [{ create: customizerCreate(level, attr, target, current.value) }]);
          rollback = `o valor anterior (${current.value}) foi recriado — a conta ficou como estava.`;
        } catch (rollbackErr) {
          rollback =
            `ATENÇÃO: não foi possível recriar o valor anterior (${current.value}): ${errorMessage(rollbackErr)}. ` +
            `Os anúncios usam agora o valor de um nível acima ou o padrão do texto. Recrie com set_customizer_value.`;
        }
        return fail(`A API recusou o novo valor de ${label} (${newValue}): ${reason}\nO valor atual tinha sido removido; ${rollback}`);
      }
    }
  );

  mcp.registerTool(
    "remove_customizer_value",
    {
      description: [
        "Remove o valor de um customizador num nível (CUSTOMER, CAMPAIGN, AD_GROUP, KEYWORD). WRITE OPERATION.",
        "Exige confirm: true. Sem o valor, os anúncios passam a usar o valor do nível acima (conta <",
        "campanha < grupo < palavra-chave) ou o padrão escrito no texto. Sem valor atual: nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        attribute: z.string().describe("Nome ou ID do atributo."),
        level: z.enum(LEVELS).describe("CUSTOMER, CAMPAIGN, AD_GROUP ou KEYWORD."),
        campaignId: z.string().optional().describe("Obrigatório em level=CAMPAIGN."),
        adGroupId: z.string().optional().describe("Obrigatório em level=AD_GROUP e KEYWORD."),
        criterionId: z.string().optional().describe("Obrigatório em level=KEYWORD."),
        confirm: z.boolean().describe("Precisa ser true."),
      },
    },
    async ({ customerId, attribute, level, campaignId, adGroupId, criterionId, confirm }) => {
      if (confirm !== true) return fail("Remoção não confirmada: envie confirm: true. Nada foi enviado.");
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const ids = { campaignId, adGroupId, criterionId };
      const problem = invalidIds({ customerId: cid }) ?? badEnum("level", level, LEVELS) ?? targetIdsProblem(level, ids);
      if (problem) return fail(problem);
      const client = getClient();
      const attr = findAttribute(await fetchAttributes(client, customerId), attribute);
      if (!attr) return fail(`Atributo ativo "${attribute}" não encontrado nesta conta. Nada foi enviado.`);
      const target = await resolveTarget(client, customerId, cid, level, ids);
      if ("error" in target) return fail(`${target.error} Nada foi enviado.`);
      const current = await fetchLevelValue(client, customerId, level, attr, target.resourceName);
      const label = `"${attr.name}" na ${target.label}`;
      if (!current) return done(`${label} não tem valor definido. Nenhuma escrita foi enviada.`);
      let result: Row;
      try {
        result = await client.mutate(customerId, LEVEL_SPEC[level].service, [{ remove: current.resourceName }]);
      } catch (err) {
        return fail(`A API recusou a remoção de ${label}: ${errorMessage(err)}\nNada foi alterado.`);
      }
      const header = client.isDryRun ? `${label} — ${dryRunLine(client)}` : `${label}: valor ${current.value} removido.`;
      return done(
        `${header}\nOs anúncios passam a usar o valor de um nível acima, se houver, ou o padrão do texto.\n\n` +
          formatJson({ attribute: attr.name, level, target: target.info, removed_value: current.value, result })
      );
    }
  );

  mcp.registerTool(
    "remove_customizer_attribute",
    {
      description: [
        "Remove um atributo de customizador (libera vaga no limite de 40 ativos). WRITE OPERATION.",
        "Exige confirm: true. Se algum RSA não removido usa {CUSTOMIZER.Nome}, recusa — a menos que",
        "force: true (esses textos passam a ter referência quebrada). Atributo já removido: nada é enviado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        attribute: z.string().describe("Nome ou ID do atributo."),
        confirm: z.boolean().describe("Precisa ser true."),
        force: z.boolean().optional().describe("Remove mesmo com RSAs usando o atributo. Default: false."),
      },
    },
    async ({ customerId, attribute, confirm, force }) => {
      if (confirm !== true) return fail("Remoção não confirmada: envie confirm: true. Nada foi enviado.");
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid });
      if (badIds) return fail(badIds);
      const client = getClient();
      const attr = findAttribute(await fetchAttributes(client, customerId, true), attribute);
      if (!attr) return fail(`Atributo "${attribute}" não encontrado nesta conta. Nada foi enviado.`);
      if (attr.status !== "ENABLED") return done(`O atributo "${attr.name}" já está ${attr.status}. Nenhuma escrita foi enviada.`);
      const users = (await customizerUsage(client, customerId)).get(attr.name.toLowerCase()) ?? [];
      if (users.length && force !== true) {
        return fail(
          `${users.length} RSA(s) usam {CUSTOMIZER.${attr.name}}: ${users.slice(0, 20).map((u) => `ad ${u.ad_id} (grupo ${u.ad_group_id})`).join(", ")}. ` +
            "Troque esses textos (update_ad) ou envie force: true. Nada foi enviado."
        );
      }
      let result: Row;
      try {
        result = await client.mutate(customerId, "customizerAttributes", [{ remove: attr.resourceName }]);
      } catch (err) {
        return fail(`A API recusou a remoção do atributo "${attr.name}": ${errorMessage(err)}\nNada foi alterado.`);
      }
      const header = client.isDryRun ? `Atributo "${attr.name}" — ${dryRunLine(client)}` : `Atributo "${attr.name}" removido.`;
      return done(`${header}\n\n${formatJson({ id: attr.id, name: attr.name, type: attr.type, ads_still_referencing: users.length, result })}`);
    }
  );

  // ── Anúncios só de chamada (call-only) ───────────────────────────────

  mcp.registerTool(
    "list_call_only_ads",
    {
      description: [
        "Inventário dos anúncios só de chamada (CALL_AD) para migrar: o Google não cria mais esse tipo",
        "desde jan/2026 e eles param de veicular em fev/2027; a troca é RSA + recurso de chamada. READ OPERATION.",
        "",
        "Por anúncio: IDs, status, métricas no período (impressões, cliques, chamadas, custo, conversões),",
        "quantos RSAs ativos o grupo tem e qual recurso de chamada cobre o grupo (do próprio grupo, da",
        "campanha ou da conta, com o telefone). A v23 tirou o conteúdo do CallAdInfo da API: o telefone e os",
        "textos do anúncio antigo não podem ser lidos. Próximo passo: migrate_call_only_ad.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        includePaused: z.boolean().optional().describe("Inclui anúncios pausados. Default: true."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, includePaused, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, campaignId });
      if (badIds) return fail(badIds);
      const dateClause = buildDateClause(dateRange, days);
      const client = getClient();
      const campaignFilter = given(campaignId) ? `\n           AND campaign.id = ${campaignId}` : "";
      const statuses = includePaused === false ? "'ENABLED'" : "'ENABLED', 'PAUSED'";
      const inventory = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.primary_status,
                ad_group_ad.policy_summary.approval_status, ad_group.id, ad_group.name, ad_group.status,
                campaign.id, campaign.name, campaign.status
         FROM ad_group_ad
         WHERE ad_group_ad.ad.type = 'CALL_AD'
           AND ad_group_ad.status IN (${statuses})${campaignFilter}`);
      const daysLeft = Math.ceil((Date.parse(`${CALL_ONLY_SUNSET}T00:00:00Z`) - Date.now()) / 86_400_000);
      const deadline = `Anúncios só de chamada param de veicular em fevereiro de 2027 (~${Math.max(daysLeft, 0)} dias).`;
      if (inventory.length === 0) {
        return done(`Nenhum anúncio só de chamada ${includePaused === false ? "ativo" : "ativo ou pausado"} nesta conta${given(campaignId) ? ` (campanha ${campaignId})` : ""}. ${deadline}`);
      }

      // Métricas separadas: com filtro de data, anúncio sem impressão some da consulta principal
      const metricsRows = await client.searchStream(customerId,
        `SELECT ad_group_ad.ad.id, ad_group.id, metrics.impressions, metrics.clicks,
                metrics.phone_calls, metrics.cost_micros, metrics.conversions
         FROM ad_group_ad
         WHERE ad_group_ad.ad.type = 'CALL_AD'
           AND ${dateClause}${campaignFilter}`);
      const metricsByAd = new Map<string, Row>();
      for (const row of metricsRows) metricsByAd.set(`${asRow(row.adGroup).id}~${asRow(asRow(row.adGroupAd).ad).id}`, asRow(row.metrics));

      const adGroupIds = [...new Set(inventory.map((row) => String(asRow(row.adGroup).id ?? "")).filter((id) => /^\d+$/.test(id)))];
      const campaignIds = [...new Set(inventory.map((row) => String(asRow(row.campaign).id ?? "")).filter((id) => /^\d+$/.test(id)))];
      // Lista vazia em IN () seria GAQL inválido: sem IDs, a consulta nem sai
      const searchIn = async (ids: string[], query: string) => (ids.length ? client.searchStream(customerId, query) : []);
      const rsaCount = new Map<string, number>();
      for (const row of await searchIn(adGroupIds,
        `SELECT ad_group.id, ad_group_ad.ad.id
         FROM ad_group_ad
         WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
           AND ad_group_ad.status = 'ENABLED'
           AND ad_group.id IN (${adGroupIds.join(", ")})`)) {
        const id = String(asRow(row.adGroup).id ?? "");
        rsaCount.set(id, (rsaCount.get(id) ?? 0) + 1);
      }
      const phoneOf = (row: Row) => {
        const call = asRow(asRow(row.asset).callAsset);
        return `${call.phoneNumber ?? "?"} (${call.countryCode ?? "?"})`;
      };
      const groupPhones = new Map<string, string[]>();
      for (const row of await searchIn(adGroupIds,
        `SELECT ad_group_asset.ad_group, ad_group_asset.status, asset.id,
                asset.call_asset.phone_number, asset.call_asset.country_code
         FROM ad_group_asset
         WHERE ad_group_asset.field_type = 'CALL'
           AND ad_group_asset.status = 'ENABLED'
           AND ad_group_asset.ad_group IN (${adGroupIds.map((id) => `'customers/${cid}/adGroups/${id}'`).join(", ")})`)) {
        const id = idFromResource(asRow(row.adGroupAsset).adGroup);
        groupPhones.set(id, [...(groupPhones.get(id) ?? []), phoneOf(row)]);
      }
      const campaignPhones = new Map<string, string[]>();
      for (const row of await searchIn(campaignIds,
        `SELECT campaign_asset.campaign, campaign_asset.status, asset.id,
                asset.call_asset.phone_number, asset.call_asset.country_code
         FROM campaign_asset
         WHERE campaign_asset.field_type = 'CALL'
           AND campaign_asset.status = 'ENABLED'
           AND campaign_asset.campaign IN (${campaignIds.map((id) => `'customers/${cid}/campaigns/${id}'`).join(", ")})`)) {
        const id = idFromResource(asRow(row.campaignAsset).campaign);
        campaignPhones.set(id, [...(campaignPhones.get(id) ?? []), phoneOf(row)]);
      }
      const accountPhones = (await client.searchStream(customerId,
        `SELECT customer_asset.asset, customer_asset.status, asset.id,
                asset.call_asset.phone_number, asset.call_asset.country_code
         FROM customer_asset
         WHERE customer_asset.field_type = 'CALL'
           AND customer_asset.status = 'ENABLED'`)).map(phoneOf);

      const ads = inventory.map((row) => {
        const adGroupAd = asRow(row.adGroupAd);
        const adId = String(asRow(adGroupAd.ad).id ?? "");
        const adGroupId = String(asRow(row.adGroup).id ?? "");
        const campaignIdOf = String(asRow(row.campaign).id ?? "");
        const metrics = metricsByAd.get(`${adGroupId}~${adId}`) ?? {};
        const rsas = rsaCount.get(adGroupId) ?? 0;
        const coverage = groupPhones.get(adGroupId)?.length
          ? { level: "grupo", phones: groupPhones.get(adGroupId) }
          : campaignPhones.get(campaignIdOf)?.length
            ? { level: "campanha", phones: campaignPhones.get(campaignIdOf) }
            : accountPhones.length
              ? { level: "conta", phones: accountPhones }
              : null;
        const missing = [...(rsas === 0 ? ["RSA ativo no grupo"] : []), ...(coverage ? [] : ["recurso de chamada (grupo, campanha ou conta)"])];
        return {
          ad_id: adId,
          ad_group_id: adGroupId,
          ad_group: asRow(row.adGroup).name,
          campaign_id: campaignIdOf,
          campaign: asRow(row.campaign).name,
          status: adGroupAd.status,
          primary_status: adGroupAd.primaryStatus,
          approval_status: asRow(adGroupAd.policySummary).approvalStatus,
          impressions: num(metrics.impressions),
          clicks: num(metrics.clicks),
          phone_calls: num(metrics.phoneCalls),
          spend: round2(microsToMoney(metrics.costMicros)),
          conversions: round2(num(metrics.conversions)),
          enabled_rsas_in_group: rsas,
          call_asset_coverage: coverage,
          migration_status: missing.length ? `falta: ${missing.join(" e ")}` : "pronto: RSA ativo + recurso de chamada — pode pausar o call-only",
        };
      });
      if (format === "table" || format === "csv") {
        const flat = ads.map((ad) => ({ ...ad, call_asset_coverage: ad.call_asset_coverage ? `${ad.call_asset_coverage.level}: ${(ad.call_asset_coverage.phones ?? []).join(" ")}` : "" }));
        return renderRows(flat, format, "", flat);
      }
      const ready = ads.filter((ad) => ad.migration_status.startsWith("pronto")).length;
      return done(
        `${ads.length} anúncio(s) só de chamada; ${ready} pronto(s) para pausar. ${deadline}\n` +
          "Próximo passo: migrate_call_only_ad (vincula o telefone ao grupo, cria o RSA e, se pedir, pausa o call-only).\n\n" +
          formatJson(ads)
      );
    }
  );

  mcp.registerTool(
    "migrate_call_only_ad",
    {
      description: [
        "Migra um grupo com anúncio só de chamada (CALL_AD) para RSA + recurso de chamada, numa única",
        "gravação atômica (googleAds:mutate): tudo é aplicado ou nada é. WRITE OPERATION.",
        "",
        "Faz o que for pedido, nesta ordem: (1) vincula um recurso de chamada ao GRUPO — número novo",
        "(phoneNumber + countryCode, default BR) ou asset existente (callAssetId); telefone já vinculado",
        "ao grupo não é duplicado e vínculo pausado não é reativado; (2) cria o RSA (rsa: finalUrl,",
        "headlines, descriptions com pins opcionais; PAUSADO, ou ENABLED com rsaStatus); (3) pausa o",
        "call-only (pauseCallOnlyAd + confirm: true) — recusado se o grupo ficaria sem RSA ativo.",
        "O telefone do anúncio antigo não pode ser lido pela API (a v23 removeu CallAdInfo): informe o número.",
        "Recurso no grupo tem precedência sobre o da campanha e o da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios."),
        callOnlyAdId: z.string().optional().describe("ID do anúncio só de chamada (list_call_only_ads)."),
        phoneNumber: z.string().optional().describe("Telefone para o recurso de chamada (ex.: +55 11 99999-9999)."),
        countryCode: z.string().optional().describe("País do telefone (2 letras). Default: BR."),
        callAssetId: z.string().optional().describe("Ou: ID de um asset de chamada já existente na conta."),
        rsa: z.object({
          finalUrl: z.string().describe("URL final do RSA."),
          headlines: flexArray(textAssetInput()).describe("3–15 títulos (texto ou { text, pin })."),
          descriptions: flexArray(textAssetInput()).describe("2–4 descrições (texto ou { text, pin })."),
          path1: z.string().optional(),
          path2: z.string().optional(),
        }).optional().describe("RSA a criar no grupo."),
        rsaStatus: z.enum(["PAUSED", "ENABLED"]).optional().describe("Status do RSA novo. Default: PAUSED."),
        pauseCallOnlyAd: z.boolean().optional().describe("Pausa o anúncio só de chamada. Default: false."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para pauseCallOnlyAd."),
      },
    },
    async ({ customerId, adGroupId, callOnlyAdId, phoneNumber, countryCode, callAssetId, rsa, rsaStatus, pauseCallOnlyAd, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const badIds = invalidIds({ customerId: cid, adGroupId, callOnlyAdId, callAssetId });
      if (badIds) return fail(badIds);
      const errors: string[] = [];
      if (given(phoneNumber) && given(callAssetId)) errors.push("Use phoneNumber OU callAssetId, não os dois.");
      const phone = phoneNumber?.trim();
      if (given(phone) && (!/^\+?[\d\s().-]+$/.test(phone) || digitsOf(phone).length < 8 || digitsOf(phone).length > 15)) {
        errors.push(`phoneNumber inválido: "${phoneNumber}" (8 a 15 dígitos; aceita +, espaço, parênteses e hífen).`);
      }
      const enumProblem = badEnum("rsaStatus", rsaStatus, ["PAUSED", "ENABLED"]);
      if (enumProblem) errors.push(enumProblem);
      const country = (countryCode ?? "BR").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) errors.push(`countryCode inválido: "${countryCode}" (2 letras, ex.: BR).`);
      if (pauseCallOnlyAd && !given(callOnlyAdId)) errors.push("pauseCallOnlyAd exige callOnlyAdId.");
      if (pauseCallOnlyAd && confirm !== true) errors.push("Pausar o anúncio só de chamada exige confirm: true.");
      if (!given(phone) && !given(callAssetId) && !rsa && !pauseCallOnlyAd) {
        errors.push("Nada a fazer: informe phoneNumber/callAssetId, rsa e/ou pauseCallOnlyAd.");
      }
      let heads: FinalText[] = [];
      let descs: FinalText[] = [];
      let rsaUrl: string | undefined;
      if (rsa) {
        rsaUrl = checkUrl(rsa.finalUrl, "rsa.finalUrl", errors);
        heads = parseTextItems(rsa.headlines, "HEADLINE", "rsa.headlines", errors).map((i) => ({ text: i.text, pin: i.pin ?? null }));
        descs = parseTextItems(rsa.descriptions, "DESCRIPTION", "rsa.descriptions", errors).map((i) => ({ text: i.text, pin: i.pin ?? null }));
        validateFinalTexts(heads, "HEADLINE", errors);
        validateFinalTexts(descs, "DESCRIPTION", errors);
        checkPath(rsa.path1, "rsa.path1", errors);
        checkPath(rsa.path2, "rsa.path2", errors);
      }
      if (errors.length) return fail(`Nada foi enviado:\n- ${errors.join("\n- ")}`);

      const client = getClient();
      const adGroupRow = await fetchAdGroup(client, customerId, adGroupId);
      const problem = searchAdGroupProblem(adGroupRow, adGroupId, cid);
      if (problem) return fail(`${problem} Nada foi enviado.`);
      const adGroupResource = `customers/${cid}/adGroups/${adGroupId}`;
      const notes: string[] = [];

      let callOnly: Row | null = null;
      if (given(callOnlyAdId)) {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group.id
           FROM ad_group_ad
           WHERE ad_group.id = ${adGroupId}
             AND ad_group_ad.ad.id = ${callOnlyAdId}`);
        callOnly = rows[0] ? asRow(rows[0].adGroupAd) : null;
        if (!callOnly) return fail(`Anúncio ${callOnlyAdId} não encontrado no grupo ${adGroupId}. Nada foi enviado.`);
        if (asRow(callOnly.ad).type !== "CALL_AD") return fail(`O anúncio ${callOnlyAdId} é ${asRow(callOnly.ad).type}, não só de chamada (CALL_AD). Nada foi enviado.`);
        if (callOnly.status === "REMOVED") return fail(`O anúncio ${callOnlyAdId} já está removido. Nada foi enviado.`);
      }

      // Vínculos de chamada que o grupo já tem, em qualquer status
      const links = await client.searchStream(customerId,
        `SELECT ad_group_asset.asset, ad_group_asset.status, asset.id,
                asset.call_asset.phone_number, asset.call_asset.country_code
         FROM ad_group_asset
         WHERE ad_group_asset.ad_group = '${adGroupResource}'
           AND ad_group_asset.field_type = 'CALL'`);
      const linkView = links.map((row) => ({
        asset_id: String(asRow(row.asset).id ?? idFromResource(asRow(row.adGroupAsset).asset)),
        status: String(asRow(row.adGroupAsset).status ?? ""),
        phone: String(asRow(asRow(row.asset).callAsset).phoneNumber ?? ""),
      }));

      const operations: Row[] = [];
      let linkAction = "nenhum";
      if (given(callAssetId)) {
        const assetRows = await client.searchStream(customerId,
          `SELECT asset.id, asset.type, asset.call_asset.phone_number, asset.call_asset.country_code
           FROM asset
           WHERE asset.id = ${callAssetId}`);
        const asset = asRow(assetRows[0]?.asset);
        if (!assetRows[0]) return fail(`Asset ${callAssetId} não existe na conta ${cid}. Nada foi enviado.`);
        if (asset.type !== "CALL") return fail(`Asset ${callAssetId} é do tipo ${asset.type}, não CALL. Nada foi enviado.`);
        const existing = linkView.find((l) => l.asset_id === callAssetId && l.status !== "REMOVED");
        if (existing) {
          linkAction = existing.status === "PAUSED" ? "já vinculado, PAUSADO (não foi reativado)" : "já vinculado";
          notes.push(`Asset de chamada ${callAssetId} ${linkAction} ao grupo.`);
        } else {
          operations.push({ adGroupAssetOperation: { create: { adGroup: adGroupResource, asset: `customers/${cid}/assets/${callAssetId}`, fieldType: "CALL" } } });
          linkAction = `vincular asset ${callAssetId} (${asRow(asset.callAsset).phoneNumber})`;
        }
      } else if (given(phone)) {
        const existing = linkView.find((l) => l.status !== "REMOVED" && digitsOf(l.phone) === digitsOf(phone));
        if (existing) {
          linkAction = existing.status === "PAUSED" ? "telefone já vinculado, PAUSADO (não foi reativado)" : "telefone já vinculado";
          notes.push(`O telefone ${phone} ${linkAction} ao grupo (asset ${existing.asset_id}).`);
        } else {
          const tempAsset = `customers/${cid}/assets/-1`;
          operations.push({ assetOperation: { create: { resourceName: tempAsset, callAsset: { countryCode: country, phoneNumber: phone } } } });
          operations.push({ adGroupAssetOperation: { create: { adGroup: adGroupResource, asset: tempAsset, fieldType: "CALL" } } });
          linkAction = `criar recurso de chamada ${phone} (${country}) e vincular ao grupo`;
        }
      }

      if (rsa) {
        const customizers = await checkCustomizerRefs(client, customerId, [...heads, ...descs].map((i) => i.text));
        if (customizers.errors.length) return fail(`Nada foi enviado:\n- ${customizers.errors.join("\n- ")}`);
        notes.push(...pinWarnings(heads, descs), ...customizers.warnings);
        operations.push({
          adGroupAdOperation: {
            create: {
              adGroup: adGroupResource,
              status: rsaStatus ?? "PAUSED",
              ad: {
                finalUrls: [rsaUrl],
                responsiveSearchAd: {
                  headlines: apiTexts(heads),
                  descriptions: apiTexts(descs),
                  ...(rsa.path1 ? { path1: rsa.path1 } : {}),
                  ...(rsa.path2 ? { path2: rsa.path2 } : {}),
                },
              },
            },
          },
        });
      }

      if (pauseCallOnlyAd && callOnly) {
        if (callOnly.status === "PAUSED") {
          notes.push(`O anúncio só de chamada ${callOnlyAdId} já estava pausado.`);
        } else {
          const enabledRsas = await client.searchStream(customerId,
            `SELECT ad_group_ad.ad.id
             FROM ad_group_ad
             WHERE ad_group.id = ${adGroupId}
               AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
               AND ad_group_ad.status = 'ENABLED'`);
          if (enabledRsas.length === 0 && !(rsa && rsaStatus === "ENABLED")) {
            return fail(
              "Pausar o call-only deixaria o grupo sem RSA ativo (o grupo pararia de veicular). Crie o RSA com " +
                "rsaStatus: ENABLED nesta mesma chamada ou ative um RSA antes. Nada foi enviado."
            );
          }
          operations.push({
            adGroupAdOperation: {
              update: { resourceName: `customers/${cid}/adGroupAds/${adGroupId}~${callOnlyAdId}`, status: "PAUSED" },
              updateMask: "status",
            },
          });
        }
      }

      const plan = {
        ...adGroupInfo(adGroupRow!),
        call_asset: linkAction,
        existing_call_links: linkView,
        rsa: rsa ? { status: rsaStatus ?? "PAUSED", final_url: rsaUrl, headlines: showTexts(heads), descriptions: showTexts(descs) } : null,
        pause_call_only_ad: pauseCallOnlyAd ? callOnlyAdId : null,
        notes,
      };
      if (operations.length === 0) {
        return done(`Grupo ${adGroupId}: nada a fazer — o que foi pedido já está aplicado. Nenhuma escrita foi enviada.\n\n${formatJson(plan)}`);
      }
      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`A API recusou a migração: ${errorMessage(err)}\nA gravação é atômica: nada foi alterado.\n\n${formatJson(plan)}`);
      }
      const created = asRows(response.mutateOperationResponses).map((r) => {
        const [kind, value] = Object.entries(r)[0] ?? ["", {}];
        return { kind, resource_name: asRow(value).resourceName };
      });
      const header = client.isDryRun
        ? `Grupo ${adGroupId} — ${dryRunLine(client)} (${operations.length} operação(ões) validadas numa única chamada atômica)`
        : `Grupo ${adGroupId}: migração aplicada (${operations.length} operação(ões), atômica).` +
          (rsa && (rsaStatus ?? "PAUSED") === "PAUSED" ? " O RSA foi criado PAUSADO: ative com update_ad_status." : "");
      return done(`${header}\n\n${formatJson({ ...plan, results: created })}`);
    }
  );
}

