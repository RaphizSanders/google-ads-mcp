/**
 * Lote targeting-geo: segmentação geográfica e de idioma.
 *
 * Tools deste módulo:
 * - get_geo_performance (movida de tools.ts): país, estado, cidade... com nomes, presença x
 *   interesse, filtro de campanha, locais segmentados (location_view) e distância (distance_view).
 * - list_geo_targets (movida): busca por nome ou resolve IDs.
 * - set_campaign_locations (movida): lê antes, só grava a diferença, roteia Demand Gen com
 *   segmentação aprimorada para os grupos de anúncios.
 * - set_campaign_languages (movida): recusa idioma em Pesquisa (removido pelo Google no fim de
 *   set/2026), limpeza opcional, códigos de idioma, replace atômico, aviso de PMax, Demand Gen.
 * - set_geo_target_type: presença x presença-ou-interesse (Campaign.geo_target_type_setting).
 * - add_proximity_target: raio em volta de endereço ou lat/lng (ProximityInfo).
 * - add_location_group_target: raio em volta dos locais da conta (LocationGroupInfo + asset sets).
 * - remove_campaign_geo_targets: remove LOCATION / PROXIMITY / LOCATION_GROUP com confirmação.
 * - get_campaign_geo_targeting: a segmentação geográfica e de idioma atual, com nomes.
 *
 * Toda query aqui foi conferida contra os metadados da v25 (tests/gaql-validator.ts) e todo
 * payload contra os protos oficiais da v25 (common/criteria.proto, resources/campaign.proto).
 */
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  addMetrics,
  buildDateClause,
  checkCustomerAccess,
  dateRangeSchema,
  emptyTotals,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  metricsView,
  partialFailureByOperation,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Utilitários ──────────────────────────────────────────────────────

const NUMERIC_ID = /^\d+$/;
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const camel = (field: string) => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const lastSegment = (resourceName: unknown) => str(resourceName).split("/").pop() ?? "";
const unique = (values: string[]) => [...new Set(values)];

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** IDs numéricos de uma lista (flexArray ou string); devolve os inválidos à parte. */
function parseIds(raw: unknown): { ids: string[]; invalid: string[] } {
  const values = ensureArray<unknown>(raw).map((v) => str(v).trim()).filter(Boolean);
  const invalid = values.filter((v) => !NUMERIC_ID.test(v));
  return { ids: unique(values.filter((v) => NUMERIC_ID.test(v))), invalid };
}

function customerIdError(customerId: string): ToolResult | null {
  return NUMERIC_ID.test(customerId.replace(/-/g, ""))
    ? null
    : fail(`customerId inválido: "${customerId}". Use só dígitos (com ou sem hífens). Nada foi enviado.`);
}

/** Traduz os erros de critério mais comuns de localização / idioma para PT-BR. */
const CRITERION_ERROR_HINTS: Array<[RegExp, string]> = [
  [/OPERATION_NOT_PERMITTED_FOR_CONTEXT|not (?:allowed|permitted) for the given context/i,
    "A API recusou a operação para este tipo de campanha (ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT): " +
    "o recurso não é configurável neste canal. (Idioma em Pesquisa cai aqui desde o fim de set/2026.)"],
  [/CANNOT_TARGET_LANGUAGE|not allowed to be targeted for the language/i,
    "O Google recusou o idioma (CriterionError.CANNOT_TARGET_LANGUAGE): a Performance Max valida o idioma contra o país " +
    "da campanha. Escolha um idioma falado nos países segmentados."],
  [/INVALID_PROXIMITY_RADIUS_UNITS|Units for the distance for the radius/i,
    "Unidade do raio inválida (INVALID_PROXIMITY_RADIUS_UNITS). Use KILOMETERS ou MILES."],
  [/INVALID_PROXIMITY_RADIUS\b|Distance for the radius for the proximity criterion is invalid/i,
    "Raio inválido para o Google (INVALID_PROXIMITY_RADIUS). Ajuste o valor do raio e tente de novo."],
  [/INVALID_PROXIMITY_ADDRESS|cannot be geocoded/i,
    "O Google não conseguiu geocodificar o endereço (INVALID_PROXIMITY_ADDRESS). Confira rua, cidade, CEP e país, " +
    "ou informe latitude/longitude."],
  [/PROXIMITY_GEOPOINT_AND_ADDRESS_BOTH_CANNOT_BE_NULL|Both address and geoPoint cannot be null/i,
    "Informe endereço ou latitude/longitude (PROXIMITY_GEOPOINT_AND_ADDRESS_BOTH_CANNOT_BE_NULL)."],
  [/INVALID_LATITUDE|Latitude for the GeoPoint is not valid/i, "Latitude inválida (INVALID_LATITUDE)."],
  [/INVALID_LONGITUDE|Longitude for the GeoPoint is not valid/i, "Longitude inválida (INVALID_LONGITUDE)."],
  [/INVALID_STREETADDRESS_LENGTH|Street address in the address is not valid/i, "Rua inválida ou longa demais (INVALID_STREETADDRESS_LENGTH)."],
  [/INVALID_CITYNAME_LENGTH|City name in the address is not valid/i, "Nome da cidade inválido (INVALID_CITYNAME_LENGTH)."],
  [/INVALID_REGIONCODE_LENGTH|Region code in the address is not valid/i, "Código do estado inválido (INVALID_REGIONCODE_LENGTH) — ex.: SP."],
  [/INVALID_REGIONNAME_LENGTH|Region name in the address is not valid/i, "Nome do estado inválido (INVALID_REGIONNAME_LENGTH)."],
  [/INVALID_POSTALCODE_LENGTH|Postal code in the address is not valid/i, "CEP inválido (INVALID_POSTALCODE_LENGTH)."],
  [/INVALID_COUNTRY_CODE|Country code in the address is not valid/i, "Código de país inválido (INVALID_COUNTRY_CODE) — use ISO de 2 letras, ex.: BR."],
  [/INVALID_LOCATION_GROUP_ASSET_SET|location group asset set id is invalid/i,
    "Conjunto de locais inválido para grupo de locais (INVALID_LOCATION_GROUP_ASSET_SET)."],
  [/INVALID_LOCATION_GROUP_RADIUS_UNIT|location group radius unit is invalid/i,
    "Unidade do raio inválida para grupo de locais (INVALID_LOCATION_GROUP_RADIUS_UNIT) — com conjuntos de locais valem METERS ou MILLI_MILES."],
  [/INVALID_LOCATION_GROUP_RADIUS\b|not at the valid increment/i,
    "Raio do grupo de locais fora do incremento aceito (INVALID_LOCATION_GROUP_RADIUS). Arredonde o raio (ex.: km inteiros) e tente de novo."],
  [/CANNOT_TARGET_AND_EXCLUDE|Cannot target and exclude the same criterion/i,
    "O mesmo local não pode ser segmentado e excluído ao mesmo tempo (CANNOT_TARGET_AND_EXCLUDE)."],
  [/CANNOT_REMOVE_ALL_LOCATIONS_FROM_LOCAL_SERVICES_PMAX_CAMPAIGN|at least one positive location criterion must remain/i,
    "PMax de Serviços Locais precisa manter ao menos um local segmentado."],
  [/CANNOT_TARGET_BOTH_PROXIMITY_AND_LOCATION_CRITERIA_FOR_SMART_CAMPAIGN|CANNOT_TARGET_MULTIPLE_PROXIMITY_CRITERIA_FOR_SMART_CAMPAIGN|Smart campaign may not target/i,
    "Campanha inteligente (Smart) aceita um único raio e não mistura raio com local."],
  [/LOCATION_TARGETING_NOT_ELIGIBLE_FOR_RESTRICTED_CAMPAIGN|outside of restricted area/i,
    "A campanha é restrita a uma área e não aceita local fora dela (LOCATION_TARGETING_NOT_ELIGIBLE_FOR_RESTRICTED_CAMPAIGN)."],
];

export function explainCriterionError(message: string): string {
  const hints = CRITERION_ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\n→ ${hints.join("\n→ ")}` : message;
}

// ── Leituras compartilhadas ──────────────────────────────────────────

interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  channel: string;
  subType: string;
  positiveGeoTargetType: string;
  negativeGeoTargetType: string;
  upgradedTargeting: boolean;
}

function toCampaignInfo(row: Row): CampaignInfo {
  const campaign = obj(row.campaign);
  const geo = obj(campaign.geoTargetTypeSetting);
  return {
    id: str(campaign.id),
    name: str(campaign.name),
    status: str(campaign.status),
    channel: str(campaign.advertisingChannelType),
    subType: str(campaign.advertisingChannelSubType),
    positiveGeoTargetType: str(geo.positiveGeoTargetType),
    negativeGeoTargetType: str(geo.negativeGeoTargetType),
    upgradedTargeting: obj(campaign.demandGenCampaignSettings).upgradedTargeting === true,
  };
}

const CAMPAIGN_FIELDS = `campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.advertising_channel_sub_type,
                campaign.geo_target_type_setting.positive_geo_target_type,
                campaign.geo_target_type_setting.negative_geo_target_type,
                campaign.demand_gen_campaign_settings.upgraded_targeting`;

async function fetchCampaigns(client: GoogleAdsClient, customerId: string, campaignIds: string[]): Promise<Map<string, CampaignInfo>> {
  const out = new Map<string, CampaignInfo>();
  for (const group of chunk(campaignIds, 500)) {
    const rows = await client.searchStream(customerId,
      `SELECT ${CAMPAIGN_FIELDS}
         FROM campaign
        WHERE campaign.id IN (${group.join(", ")})`);
    for (const row of rows) {
      const info = toCampaignInfo(row);
      if (info.id) out.set(info.id, info);
    }
  }
  return out;
}

async function fetchCampaign(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<CampaignInfo | null> {
  const rows = await client.searchStream(customerId,
    `SELECT ${CAMPAIGN_FIELDS}
       FROM campaign
      WHERE campaign.id = ${campaignId}`);
  return rows[0] ? toCampaignInfo(rows[0]) : null;
}

/** Demand Gen com segmentação aprimorada: local e idioma ficam nos grupos de anúncios. */
const isUpgradedDemandGen = (campaign: CampaignInfo) => campaign.channel === "DEMAND_GEN" && campaign.upgradedTargeting;

/**
 * adGroupIds só existe para Demand Gen com segmentação aprimorada. Em qualquer outra campanha o
 * critério é da campanha e vale para TODOS os grupos: gravar ignorando adGroupIds seria uma escrita
 * mais ampla do que a pedida. Recusa antes de qualquer escrita.
 */
function adGroupScopeRefusal(campaign: CampaignInfo, what: "local" | "idioma"): ToolResult {
  const kind = campaign.channel === "DEMAND_GEN"
    ? "é Demand Gen sem segmentação aprimorada (upgraded_targeting desligado)"
    : `é do tipo ${campaign.channel || "desconhecido"}`;
  return fail(
    `adGroupIds só vale para Demand Gen com segmentação aprimorada (upgraded_targeting), onde ${what} fica nos grupos ` +
    `de anúncios. A campanha ${campaign.id} ("${campaign.name}") ${kind}: nela ${what} é configurado no nível da ` +
    `campanha e vale para TODOS os grupos — não dá para limitar a alguns. Nada foi gravado. ` +
    "Para aplicar à campanha inteira, reenvie sem adGroupIds."
  );
}

interface GeoConstant {
  id: string;
  name: string;
  canonical_name: string;
  target_type: string;
  country_code: string;
  status: string;
}

async function resolveGeoTargets(client: GoogleAdsClient, customerId: string, ids: string[]): Promise<Map<string, GeoConstant>> {
  const out = new Map<string, GeoConstant>();
  const valid = unique(ids.filter((id) => NUMERIC_ID.test(id)));
  for (const group of chunk(valid, 500)) {
    const rows = await client.searchStream(customerId,
      `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name,
              geo_target_constant.target_type, geo_target_constant.country_code, geo_target_constant.status
         FROM geo_target_constant
        WHERE geo_target_constant.id IN (${group.join(", ")})`);
    for (const row of rows) {
      const geo = obj(row.geoTargetConstant);
      const id = str(geo.id);
      if (!id) continue;
      out.set(id, {
        id,
        name: str(geo.name),
        canonical_name: str(geo.canonicalName),
        target_type: str(geo.targetType),
        country_code: str(geo.countryCode),
        status: str(geo.status),
      });
    }
  }
  return out;
}

interface LanguageConstant {
  id: string;
  code: string;
  name: string;
  targetable: boolean;
}

/**
 * Chave de comparação de código de idioma: sem diferenciar maiúsculas e com '-' = '_'.
 * 'PT' → 'pt', 'zh-cn' / 'ZH_CN' → 'zh_cn' (o código real em language_constant é 'zh_CN').
 */
const languageCodeKey = (code: string) => code.trim().toLowerCase().replace(/-/g, "_");

async function resolveLanguages(
  client: GoogleAdsClient,
  customerId: string,
  ids: string[],
  codes: string[]
): Promise<{ byId: Map<string, LanguageConstant>; byCode: Map<string, LanguageConstant> }> {
  const byId = new Map<string, LanguageConstant>();
  const byCode = new Map<string, LanguageConstant>();
  const add = (rows: Row[]) => {
    for (const row of rows) {
      const lang = obj(row.languageConstant);
      const item = { id: str(lang.id), code: str(lang.code), name: str(lang.name), targetable: lang.targetable === true };
      if (!item.id) continue;
      byId.set(item.id, item);
      if (item.code) byCode.set(languageCodeKey(item.code), item);
    }
  };
  const fields = "language_constant.id, language_constant.code, language_constant.name, language_constant.targetable";
  if (codes.length) {
    // `=` e `IN` do GAQL diferenciam maiúsculas em string (guia "Case sensitivity"), e os códigos
    // reais são 'pt', 'es', 'zh_CN'. Um `code IN ('PT')` não acharia nada. A tabela é pequena
    // (algumas dezenas de idiomas): lê tudo — o que já cobre os IDs — e casa no cliente com
    // languageCodeKey. Sem filtro de targetable, para dizer "não é segmentável" em vez de "não existe".
    add(await client.searchStream(customerId, `SELECT ${fields} FROM language_constant`));
  } else if (ids.length) {
    add(await client.searchStream(customerId, `SELECT ${fields} FROM language_constant WHERE language_constant.id IN (${ids.join(", ")})`));
  }
  return { byId, byCode };
}

interface CampaignCriterionRow {
  campaignId: string;
  resourceName: string;
  criterionId: string;
  type: string;
  negative: boolean;
  bidModifier?: number;
  geoTargetId?: string;
  languageId?: string;
  proximity?: Row;
  locationGroup?: Row;
}

const GEO_CRITERION_TYPES = ["LOCATION", "PROXIMITY", "LOCATION_GROUP"] as const;

async function fetchCampaignCriteria(
  client: GoogleAdsClient,
  customerId: string,
  campaignIds: string[] | null,
  types: readonly string[]
): Promise<CampaignCriterionRow[]> {
  const typeList = types.map((t) => `'${t}'`).join(", ");
  const campaignFilter = campaignIds ? `AND campaign.id IN (${campaignIds.join(", ")})` : "";
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.criterion_id,
            campaign_criterion.type, campaign_criterion.negative, campaign_criterion.bid_modifier,
            campaign_criterion.location.geo_target_constant,
            campaign_criterion.language.language_constant,
            campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
            campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
            campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
            campaign_criterion.proximity.address.street_address, campaign_criterion.proximity.address.city_name,
            campaign_criterion.proximity.address.postal_code, campaign_criterion.proximity.address.province_code,
            campaign_criterion.proximity.address.province_name, campaign_criterion.proximity.address.country_code,
            campaign_criterion.location_group
       FROM campaign_criterion
      WHERE campaign_criterion.type IN (${typeList})
        AND campaign_criterion.status != 'REMOVED'
        ${campaignFilter}`);
  const out: CampaignCriterionRow[] = [];
  for (const row of rows) {
    const cc = obj(row.campaignCriterion);
    const type = str(cc.type);
    // Dupla checagem do tipo no cliente: a query já filtra, mas um critério de outro tipo
    // aqui viraria um remove indevido.
    if (!types.includes(type) || !cc.resourceName) continue;
    out.push({
      campaignId: str(obj(row.campaign).id) || str(cc.resourceName).split("/").pop()?.split("~")[0] || "",
      resourceName: str(cc.resourceName),
      criterionId: str(cc.criterionId),
      type,
      // negative=false vem omitido no JSON (default do proto3): undefined vale false.
      negative: cc.negative === true,
      bidModifier: cc.bidModifier === undefined ? undefined : Number(cc.bidModifier),
      geoTargetId: cc.location ? lastSegment(obj(cc.location).geoTargetConstant) : undefined,
      languageId: cc.language ? lastSegment(obj(cc.language).languageConstant) : undefined,
      proximity: cc.proximity ? obj(cc.proximity) : undefined,
      locationGroup: cc.locationGroup ? obj(cc.locationGroup) : undefined,
    });
  }
  return out;
}

interface AdGroupInfo {
  id: string;
  name: string;
  status: string;
}

async function fetchAdGroups(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<AdGroupInfo[]> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status
       FROM ad_group
      WHERE campaign.id = ${campaignId}
        AND ad_group.status != 'REMOVED'`);
  return rows.map((row) => {
    const ag = obj(row.adGroup);
    return { id: str(ag.id), name: str(ag.name), status: str(ag.status) };
  }).filter((ag) => ag.id);
}

interface AdGroupCriterionRow {
  campaignId: string;
  adGroupId: string;
  adGroupName: string;
  resourceName: string;
  criterionId: string;
  type: string;
  negative: boolean;
  geoTargetId?: string;
  languageId?: string;
}

async function fetchAdGroupGeoCriteria(
  client: GoogleAdsClient,
  customerId: string,
  campaignIds: string[],
  types: Array<"LOCATION" | "LANGUAGE">
): Promise<AdGroupCriterionRow[]> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.resource_name,
            ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative,
            ad_group_criterion.location.geo_target_constant, ad_group_criterion.language.language_constant
       FROM ad_group_criterion
      WHERE ad_group_criterion.type IN (${types.map((t) => `'${t}'`).join(", ")})
        AND ad_group_criterion.status != 'REMOVED'
        AND campaign.id IN (${campaignIds.join(", ")})`);
  const out: AdGroupCriterionRow[] = [];
  for (const row of rows) {
    const agc = obj(row.adGroupCriterion);
    const type = str(agc.type);
    if (!(types as string[]).includes(type) || !agc.resourceName) continue;
    out.push({
      campaignId: str(obj(row.campaign).id),
      adGroupId: str(obj(row.adGroup).id),
      adGroupName: str(obj(row.adGroup).name),
      resourceName: str(agc.resourceName),
      criterionId: str(agc.criterionId),
      type,
      negative: agc.negative === true,
      geoTargetId: agc.location ? lastSegment(obj(agc.location).geoTargetConstant) : undefined,
      languageId: agc.language ? lastSegment(obj(agc.language).languageConstant) : undefined,
    });
  }
  return out;
}

// ── Textos fixos ─────────────────────────────────────────────────────

export const SEARCH_LANGUAGE_NOTE = [
  "Idioma em campanha de Pesquisa: o Google anunciou (blog do Google Ads API, ago/2026) que, a partir do fim de",
  "setembro de 2026, a segmentação por idioma no nível da campanha deixa de existir em Pesquisa e em AI Max para",
  "Pesquisa — a mudança está entrando em vigor agora. Os anúncios passam a ser combinados pelo idioma do próprio",
  "anúncio (e pelas preferências de idioma do usuário). Criar ou alterar critério de idioma em Pesquisa volta",
  "ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT; os critérios antigos continuam aparecendo nas consultas, mas são ignorados.",
  "O que fazer: escreva títulos, descrições e landing page no idioma do público (pt-BR). Limpar os critérios antigos",
  "é opcional: set_campaign_languages com cleanup=true e confirm=true.",
].join("\n");

export const PMAX_LANGUAGE_NOTE =
  "Performance Max: desde o fim de set/2026 o idioma da campanha não vale para os anúncios na Pesquisa do Google " +
  "(lá vale o idioma dos anúncios); continua valendo em YouTube, Display, Discover e Gmail. A PMax valida o idioma " +
  "contra o país da campanha (CriterionError.CANNOT_TARGET_LANGUAGE).";

const PRESENCE_OR_INTEREST_HINT =
  "Presença ou interesse (PRESENCE_OR_INTEREST): também alcança quem está fora da área mas demonstrou interesse nela. " +
  "Para lead-gen local, considere set_geo_target_type positive=PRESENCE.";

const GEO_TARGET_TYPES = ["PRESENCE", "PRESENCE_OR_INTEREST"] as const;

/** Máximo de IDs que list_geo_targets resolve numa chamada (uma única query IN). */
const MAX_GEO_IDS = 1000;

// ── Relatório geográfico ────────────────────────────────────────────

const GEO_VIEWS = ["geographic", "user_location", "targeted", "distance"] as const;
const GEO_GRANULARITY: Record<string, string | null> = {
  country: null,
  region: "geo_target_region",
  state: "geo_target_state",
  province: "geo_target_province",
  metro: "geo_target_metro",
  county: "geo_target_county",
  district: "geo_target_district",
  city: "geo_target_city",
  postal_code: "geo_target_postal_code",
  most_specific: "geo_target_most_specific_location",
};
const GRANULARITIES = Object.keys(GEO_GRANULARITY) as [string, ...string[]];
const GEO_METRICS = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
const LOCATION_TYPE_LABEL: Record<string, string> = {
  LOCATION_OF_PRESENCE: "presença",
  AREA_OF_INTEREST: "interesse",
};

function formatRows(rows: Row[], format: string | undefined, header: string, extra: Row = {}): ToolResult {
  if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(rows)}`)] };
  if (format === "csv") return { content: [text(formatAsCsv(rows))] };
  return { content: [text(`${header}\n\n${formatJson({ ...extra, rows })}`)] };
}

// ── Proximidade ──────────────────────────────────────────────────────

const proximityTargetSchema = z.object({
  latitude: z.number().optional().describe("Latitude em graus decimais (-90 a 90). Use com longitude."),
  longitude: z.number().optional().describe("Longitude em graus decimais (-180 a 180). Use com latitude."),
  streetAddress: z.string().optional().describe("Rua e número (ex.: 'Av. Paulista, 1000')."),
  cityName: z.string().optional().describe("Cidade (ex.: 'São Paulo')."),
  postalCode: z.string().optional().describe("CEP (ex.: '01310-100')."),
  provinceCode: z.string().optional().describe("Sigla do estado (ex.: 'SP')."),
  provinceName: z.string().optional().describe("Nome do estado."),
  countryCode: z.string().optional().describe("País ISO de 2 letras (ex.: 'BR'). Obrigatório quando usar endereço."),
  radius: z.number().describe("Raio (> 0)."),
  radiusUnits: z.enum(["KILOMETERS", "MILES"]).optional().describe("Unidade do raio. Default: KILOMETERS."),
  bidModifier: z.number().optional().describe("Ajuste de lance para este raio (0.1 a 10.0; 1.2 = +20%). Opcional."),
  label: z.string().optional().describe("Rótulo livre só para o relatório (ex.: 'Loja Moema')."),
});
type ProximityTarget = z.infer<typeof proximityTargetSchema>;

const ADDRESS_FIELDS = ["streetAddress", "cityName", "postalCode", "provinceCode", "provinceName", "countryCode"] as const;
const MAX_PROXIMITY_PER_CALL = 100;

function normalizeAddressPart(value: unknown): string {
  return str(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function proximityKeys(proximity: Row): string[] {
  const units = str(proximity.radiusUnits) || "KILOMETERS";
  const radius = Number(proximity.radius ?? 0);
  const keys: string[] = [];
  const point = obj(proximity.geoPoint);
  if (point.latitudeInMicroDegrees !== undefined && point.longitudeInMicroDegrees !== undefined) {
    keys.push(`geo:${Number(point.latitudeInMicroDegrees)}:${Number(point.longitudeInMicroDegrees)}:${radius}:${units}`);
  }
  const address = obj(proximity.address);
  const parts = ["streetAddress", "cityName", "postalCode", "provinceCode", "countryCode"].map((k) => normalizeAddressPart(address[k]));
  if (parts.some(Boolean)) keys.push(`addr:${parts.join("|")}:${radius}:${units}`);
  return keys;
}

/** Valida um alvo de proximidade e monta o ProximityInfo (REST, lowerCamelCase). */
function buildProximity(target: ProximityTarget, index: number): { proximity: Row; errors: string[] } {
  const errors: string[] = [];
  const where = `targets[${index}]${target.label ? ` ("${target.label}")` : ""}`;
  const hasLat = target.latitude !== undefined && target.latitude !== null;
  const hasLng = target.longitude !== undefined && target.longitude !== null;
  const hasAddress = ADDRESS_FIELDS.some((k) => str(target[k]).trim());
  if (hasLat !== hasLng) errors.push(`${where}: latitude e longitude vão juntas.`);
  if (hasLat && (typeof target.latitude !== "number" || !Number.isFinite(target.latitude) || target.latitude < -90 || target.latitude > 90)) {
    errors.push(`${where}: latitude fora de -90..90 (${target.latitude}).`);
  }
  if (hasLng && (typeof target.longitude !== "number" || !Number.isFinite(target.longitude) || target.longitude < -180 || target.longitude > 180)) {
    errors.push(`${where}: longitude fora de -180..180 (${target.longitude}).`);
  }
  if (!(hasLat && hasLng) && !hasAddress) errors.push(`${where}: informe latitude/longitude ou um endereço.`);
  if (!(hasLat && hasLng) && hasAddress) {
    if (!str(target.countryCode).trim()) errors.push(`${where}: countryCode é obrigatório com endereço (ex.: BR).`);
    if (!["streetAddress", "cityName", "postalCode"].some((k) => str(target[k as keyof ProximityTarget]).trim())) {
      errors.push(`${where}: o endereço precisa de rua, cidade ou CEP.`);
    }
  }
  if (target.countryCode !== undefined && str(target.countryCode).trim() && !/^[A-Za-z]{2}$/.test(str(target.countryCode).trim())) {
    errors.push(`${where}: countryCode deve ter 2 letras (ISO 3166-1), recebido "${target.countryCode}".`);
  }
  if (typeof target.radius !== "number" || !Number.isFinite(target.radius) || target.radius <= 0) {
    errors.push(`${where}: radius precisa ser um número maior que zero (recebido ${target.radius}).`);
  }
  const units = target.radiusUnits ?? "KILOMETERS";
  if (units !== "KILOMETERS" && units !== "MILES") errors.push(`${where}: radiusUnits deve ser KILOMETERS ou MILES (recebido ${units}).`);
  if (target.bidModifier !== undefined && (typeof target.bidModifier !== "number" || !(target.bidModifier >= 0.1 && target.bidModifier <= 10))) {
    errors.push(`${where}: bidModifier deve ficar entre 0.1 e 10.0 (recebido ${target.bidModifier}).`);
  }

  const proximity: Row = { radius: target.radius, radiusUnits: units };
  if (hasLat && hasLng) {
    proximity.geoPoint = {
      latitudeInMicroDegrees: Math.round(Number(target.latitude) * 1_000_000),
      longitudeInMicroDegrees: Math.round(Number(target.longitude) * 1_000_000),
    };
  }
  if (hasAddress) {
    const address: Row = {};
    for (const key of ADDRESS_FIELDS) {
      const value = str(target[key]).trim();
      if (value) address[key] = key === "countryCode" || key === "provinceCode" ? value.toUpperCase() : value;
    }
    proximity.address = address;
  }
  return { proximity, errors };
}

interface ProximityView {
  latitude?: number;
  longitude?: number;
  radius?: number;
  radius_units: string;
  address?: Row;
}

function describeProximity(proximity: Row): ProximityView {
  const point = obj(proximity.geoPoint);
  const lat = point.latitudeInMicroDegrees;
  const lng = point.longitudeInMicroDegrees;
  return {
    latitude: lat === undefined ? undefined : Number(lat) / 1_000_000,
    longitude: lng === undefined ? undefined : Number(lng) / 1_000_000,
    radius: proximity.radius === undefined ? undefined : Number(proximity.radius),
    radius_units: str(proximity.radiusUnits) || "KILOMETERS",
    address: proximity.address ? obj(proximity.address) : undefined,
  };
}

// ── Grupo de locais ─────────────────────────────────────────────────

const LOCATION_ASSET_SET_TYPES = new Set([
  "LOCATION_SYNC",
  "BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP",
  "CHAIN_DYNAMIC_LOCATION_GROUP",
  "STATIC_LOCATION_GROUP",
]);

function locationGroupKey(group: Row): string {
  return JSON.stringify({
    radius: str(group.radius),
    units: str(group.radiusUnits),
    sets: ensureArray<string>(group.locationGroupAssetSets).map(String).sort(),
    customer: group.enableCustomerLevelLocationAssetSet === true,
    geo: ensureArray<string>(group.geoTargetConstants).map(String).sort(),
  });
}

function describeLocationGroup(c: CampaignCriterionRow) {
  const group = c.locationGroup ?? {};
  return {
    criterion_id: c.criterionId,
    radius: str(group.radius),
    radius_units: str(group.radiusUnits),
    asset_sets: ensureArray<string>(group.locationGroupAssetSets).map((name) => lastSegment(name)),
    customer_locations: group.enableCustomerLevelLocationAssetSet === true,
    geo_target_constants: ensureArray<string>(group.geoTargetConstants).map((name) => lastSegment(name)),
    bid_modifier: c.bidModifier,
  };
}

// ── Registro ────────────────────────────────────────────────────────

export function registerTargetingGeoTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;

  // ── get_geo_performance ───────────────────────────────────────────

  mcp.registerTool(
    "get_geo_performance",
    {
      description: [
        "Performance por localização. READ OPERATION.",
        "",
        "view (default geographic):",
        "- geographic: geographic_view — onde o usuário estava OU a área de interesse dele (basis=presence|interest|all).",
        "- user_location: user_location_view — localização física do usuário, com targeting_location (local segmentado ou não).",
        "- targeted: location_view — performance por local SEGMENTADO na campanha, com o bid_modifier atual e o criterion_id.",
        "- distance: distance_view — por faixa de distância dos seus locais (recursos de local). As faixas são",
        "  cumulativas (\"até 5 km\" inclui \"até 1 km\"): não some linhas.",
        "",
        "granularity (geographic/user_location): country (default), region, state, province, metro, county, district,",
        "city, postal_code, most_specific. Nomes vêm resolvidos (geo_target_constant). Em conta só-Brasil use state ou city.",
        "level: campaign (default, uma linha por campanha × local) ou account (soma a conta). campaignId filtra uma campanha.",
        "",
        "location_id alimenta set_location_bid_adjustment e set_campaign_locations (negative=true para excluir).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        view: z.enum(GEO_VIEWS).optional().describe("geographic (default) | user_location | targeted | distance."),
        granularity: z.enum(GRANULARITIES).optional().describe("Nível geográfico (geographic/user_location). Default: country."),
        basis: z.enum(["all", "presence", "interest"]).optional().describe("Só view=geographic: presença física, interesse ou ambos (default all)."),
        level: z.enum(["campaign", "account"]).optional().describe("campaign (default) separa por campanha; account soma a conta."),
        campaignId: z.string().optional().describe("Filtra uma campanha (ID numérico)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máximo de linhas (1 a 10000). Default: 30."),
        format: formatSchema,
      },
    },
    async ({ customerId, view, granularity, basis, level, campaignId, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const selectedView = view ?? "geographic";
      if (!(GEO_VIEWS as readonly string[]).includes(selectedView)) {
        return fail(`view inválida: "${view}". Use ${GEO_VIEWS.join(", ")}.`);
      }
      const grain = granularity ?? "country";
      if (!(grain in GEO_GRANULARITY)) return fail(`granularity inválida: "${granularity}". Use ${GRANULARITIES.join(", ")}.`);
      const selectedBasis = basis ?? "all";
      if (!["all", "presence", "interest"].includes(selectedBasis)) return fail(`basis inválido: "${basis}". Use all, presence ou interest.`);
      const selectedLevel = level ?? "campaign";
      if (selectedLevel !== "campaign" && selectedLevel !== "account") return fail(`level inválido: "${level}". Use campaign ou account.`);
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId inválido: "${campaignId}". Use o ID numérico.`);
      const rowLimit = limit ?? 30;
      if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 10_000) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 10000.`);
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }

      const client = getClient();
      const notes: string[] = [];
      const byCampaign = selectedLevel === "campaign" || campaignId !== undefined;
      const campaignFields = byCampaign ? "campaign.id, campaign.name, " : "";
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";
      if (campaignId && selectedLevel === "account") notes.push("campaignId informado: as linhas saem por campanha.");

      if (selectedView === "targeted" || selectedView === "distance") {
        if (grain !== "country") notes.push(`granularity=${grain} não se aplica a view=${selectedView} (ignorado).`);
        if (selectedBasis !== "all") notes.push(`basis=${selectedBasis} só vale para view=geographic (ignorado).`);
      } else if (selectedView === "user_location" && selectedBasis !== "all") {
        notes.push("basis só vale para view=geographic: user_location_view já é a localização física do usuário (ignorado).");
      }

      // ── targeted: location_view ──
      if (selectedView === "targeted") {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.geo_target_type_setting.positive_geo_target_type,
                  campaign_criterion.criterion_id, campaign_criterion.type,
                  campaign_criterion.bid_modifier, campaign_criterion.location.geo_target_constant,
                  campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
                  campaign_criterion.proximity.address.city_name,
                  ${GEO_METRICS}
             FROM location_view
            WHERE ${dateClause}
              ${campaignFilter}
            ORDER BY metrics.cost_micros DESC
            LIMIT ${rowLimit}`);
        const geoIds = rows.map((r) => lastSegment(obj(obj(r.campaignCriterion).location).geoTargetConstant)).filter(Boolean);
        let names = new Map<string, GeoConstant>();
        try {
          names = await resolveGeoTargets(client, customerId, geoIds);
        } catch (err) {
          notes.push(`Nomes dos locais não resolvidos: ${(err as Error).message}`);
        }
        const out = rows.map((r) => {
          const campaign = obj(r.campaign);
          const cc = obj(r.campaignCriterion);
          const geoId = lastSegment(obj(cc.location).geoTargetConstant);
          const geo = names.get(geoId);
          const proximity = obj(cc.proximity);
          return {
            campaign_id: str(campaign.id),
            campaign_name: str(campaign.name),
            positive_geo_target_type: str(obj(campaign.geoTargetTypeSetting).positiveGeoTargetType) || undefined,
            criterion_id: str(cc.criterionId),
            criterion_type: str(cc.type),
            location_id: geoId || undefined,
            location_name: geo?.canonical_name || geo?.name || (cc.proximity
              ? `raio ${str(proximity.radius)} ${str(proximity.radiusUnits) || "KILOMETERS"}${obj(proximity.address).cityName ? ` — ${str(obj(proximity.address).cityName)}` : ""}`
              : undefined),
            location_type: geo?.target_type || undefined,
            bid_modifier: cc.bidModifier === undefined ? null : Number(cc.bidModifier),
            ...metricsView(addMetrics(emptyTotals(), obj(r.metrics))),
          };
        });
        const header = `${out.length} local(is) segmentado(s) com dados (location_view).` +
          (out.length === 0 ? " Sem linhas: a campanha não tem critério de local no período ou não houve tráfego." : "") +
          (notes.length ? `\n${notes.join("\n")}` : "");
        return formatRows(out, format, header);
      }

      // ── distance: distance_view ──
      if (selectedView === "distance") {
        const rows = await client.searchStream(customerId,
          `SELECT ${campaignFields}distance_view.distance_bucket, distance_view.metric_system,
                  ${GEO_METRICS}
             FROM distance_view
            WHERE ${dateClause}
              ${campaignFilter}
            ORDER BY metrics.cost_micros DESC
            LIMIT ${rowLimit}`);
        const out = rows.map((r) => {
          const dv = obj(r.distanceView);
          const campaign = obj(r.campaign);
          return {
            ...(byCampaign ? { campaign_id: str(campaign.id), campaign_name: str(campaign.name) } : {}),
            distance_bucket: str(dv.distanceBucket),
            metric_system: dv.metricSystem === true,
            ...metricsView(addMetrics(emptyTotals(), obj(r.metrics))),
          };
        });
        const header = `${out.length} faixa(s) de distância (distance_view). As faixas são cumulativas — não some as linhas.` +
          (out.length === 0 ? " Sem linhas: distance_view só tem dados com recursos de local (location assets) ativos." : "") +
          (notes.length ? `\n${notes.join("\n")}` : "");
        return formatRows(out, format, header);
      }

      // ── geographic / user_location ──
      const segment = GEO_GRANULARITY[grain];
      const segmentField = segment ? `segments.${segment}` : "";
      const isGeographic = selectedView === "geographic";
      const resource = isGeographic ? "geographic_view" : "user_location_view";
      const viewFields = isGeographic
        ? "geographic_view.country_criterion_id, geographic_view.location_type"
        : "user_location_view.country_criterion_id, user_location_view.targeting_location";
      const basisFilter = isGeographic && selectedBasis !== "all"
        ? `AND geographic_view.location_type = '${selectedBasis === "presence" ? "LOCATION_OF_PRESENCE" : "AREA_OF_INTEREST"}'`
        : "";
      const rows = await client.searchStream(customerId,
        `SELECT ${campaignFields}${viewFields}${segmentField ? `, ${segmentField}` : ""},
                ${GEO_METRICS}
           FROM ${resource}
          WHERE ${dateClause}
            AND metrics.impressions > 0
            ${campaignFilter}
            ${basisFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${rowLimit}`);

      const viewKey = camel(resource);
      const segmentKey = segment ? camel(segment) : "";
      const ids = new Set<string>();
      for (const r of rows) {
        const countryId = str(obj(r[viewKey]).countryCriterionId);
        if (countryId) ids.add(countryId);
        if (segmentKey) {
          const id = lastSegment(obj(r.segments)[segmentKey]);
          if (id) ids.add(id);
        }
      }
      let names = new Map<string, GeoConstant>();
      try {
        names = await resolveGeoTargets(client, customerId, [...ids]);
      } catch (err) {
        notes.push(`Nomes dos locais não resolvidos: ${(err as Error).message}`);
      }
      const out = rows.map((r) => {
        const v = obj(r[viewKey]);
        const campaign = obj(r.campaign);
        const countryId = str(v.countryCriterionId);
        const locationId = segmentKey ? lastSegment(obj(r.segments)[segmentKey]) : countryId;
        const geo = names.get(locationId);
        return {
          ...(byCampaign ? { campaign_id: str(campaign.id), campaign_name: str(campaign.name) } : {}),
          country: names.get(countryId)?.name || countryId || undefined,
          ...(isGeographic
            ? { basis: LOCATION_TYPE_LABEL[str(v.locationType)] ?? str(v.locationType) }
            : { targeted_location: v.targetingLocation === true }),
          location_id: locationId || undefined,
          location_name: locationId ? (geo?.name || locationId) : "(não determinado)",
          location_canonical_name: geo?.canonical_name || undefined,
          location_type: geo?.target_type || undefined,
          ...metricsView(addMetrics(emptyTotals(), obj(r.metrics))),
        };
      });
      const header = `${out.length} linha(s) — ${resource}, granularidade ${grain}` +
        `${isGeographic ? `, base ${selectedBasis}` : ""}, ${byCampaign ? "por campanha" : "conta inteira"}.` +
        (rows.length === rowLimit ? ` Limite de ${rowLimit} atingido (ordenado por custo).` : "") +
        (notes.length ? `\n${notes.join("\n")}` : "");
      return formatRows(out, format, header);
    }
  );

  // ── list_geo_targets ──────────────────────────────────────────────

  mcp.registerTool(
    "list_geo_targets",
    {
      description: [
        "Busca geo target IDs por nome, ou resolve IDs em nomes. READ OPERATION.",
        "Use os IDs em set_campaign_locations, generate_keyword_ideas e set_location_bid_adjustment.",
        "",
        "Ex.: query='São Paulo', countryCode='BR' → IDs de cidade, estado e região.",
        "Ex.: ids=['2076','20106'] → nomes, tipo e status (inclui REMOVAL_PLANNED).",
        "Busca por nome traz só locais ENABLED.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Nome (ou parte do nome) da localização. Obrigatório se não usar ids."),
        ids: flexArray(z.string()).optional().describe(`geo_target_constant IDs para resolver em nomes (até ${MAX_GEO_IDS} por chamada).`),
        countryCode: z.string().optional().describe("Filtra por país (ISO de 2 letras, ex.: 'BR')."),
        targetType: z.string().optional().describe("Filtra por tipo (ex.: 'City', 'State', 'Country', 'Neighborhood')."),
        limit: z.number().optional().describe("Máximo de resultados (1 a 1000). Default: 25."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, ids: rawIds, countryCode, targetType, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const { ids, invalid } = parseIds(rawIds);
      if (invalid.length) return fail(`IDs inválidos (só dígitos): ${invalid.join(", ")}.`);
      if (ids.length > MAX_GEO_IDS) {
        // Consultar só parte e relatar o resto como "não encontrado" seria uma resposta errada.
        return fail(`ids aceita no máximo ${MAX_GEO_IDS} IDs por chamada (recebidos ${ids.length}). Divida em lotes de até ${MAX_GEO_IDS}. Nada foi consultado.`);
      }
      const search = str(query).trim();
      if (!search && ids.length === 0) return fail("Informe query (nome) ou ids.");
      if (search.length > 100) return fail("query longa demais (máx. 100 caracteres).");
      const country = str(countryCode).trim();
      if (country && !/^[A-Za-z]{2}$/.test(country)) return fail(`countryCode deve ter 2 letras (ISO), recebido "${countryCode}".`);
      const type = str(targetType).trim();
      if (type && !/^[\p{L} ]{2,40}$/u.test(type)) return fail(`targetType inválido: "${targetType}" (ex.: City, State, Country).`);
      const rowLimit = limit ?? 25;
      if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 1000) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 1000.`);

      const client = getClient();
      const filters: string[] = [];
      if (ids.length) {
        filters.push(`geo_target_constant.id IN (${ids.join(", ")})`);
      } else {
        filters.push(`geo_target_constant.name LIKE '%${gaqlLiteral(search)}%'`, "geo_target_constant.status = 'ENABLED'");
      }
      if (country) filters.push(`geo_target_constant.country_code = '${country.toUpperCase()}'`);
      if (type) filters.push(`geo_target_constant.target_type = '${gaqlLiteral(type)}'`);

      const results = await client.searchStream(customerId,
        `SELECT geo_target_constant.id, geo_target_constant.name,
                geo_target_constant.canonical_name, geo_target_constant.country_code,
                geo_target_constant.target_type, geo_target_constant.status,
                geo_target_constant.parent_geo_target
         FROM geo_target_constant
         WHERE ${filters.join(" AND ")}
         LIMIT ${ids.length ? Math.max(rowLimit, ids.length) : rowLimit}`);

      const rows = results.map((r) => {
        const g = obj(r.geoTargetConstant);
        return {
          geo_target_id: str(g.id),
          name: str(g.name),
          canonical_name: str(g.canonicalName),
          country: str(g.countryCode),
          type: str(g.targetType),
          status: str(g.status),
          parent_id: lastSegment(g.parentGeoTarget) || undefined,
        };
      });
      const found = new Set(rows.map((row) => row.geo_target_id));
      const missing = ids.filter((id) => !found.has(id));
      // Com countryCode/targetType, um ID que existe mas é de outro país/tipo também não volta.
      const missingLabel = country || type ? "Não encontrados ou fora dos filtros countryCode/targetType" : "Não encontrados";

      if (format === "table") return { content: [text(formatAsTable(rows as Row[]))] };
      if (format === "csv") return { content: [text(formatAsCsv(rows as Row[]))] };
      const header = ids.length
        ? `${rows.length} de ${ids.length} ID(s) resolvido(s).${missing.length ? ` ${missingLabel}: ${missing.join(", ")}.` : ""}`
        : `${rows.length} localização(ões) para "${search}".`;
      return { content: [text(`${header}\n\n${formatJson(rows)}`)] };
    }
  );

  // ── set_campaign_locations ────────────────────────────────────────

  mcp.registerTool(
    "set_campaign_locations",
    {
      description: [
        "Segmentação geográfica (país, estado, cidade...) de uma campanha. WRITE OPERATION.",
        "",
        "Por padrão ADICIONA (replace=false): o resultado é a UNIÃO com os locais que a campanha já tinha.",
        "replace=true substitui só os critérios de LOCATION da mesma polaridade (os positivos, ou as exclusões",
        "com negative=true): remove os que saíram e cria os novos numa única requisição atômica. Locais que",
        "continuam são mantidos (com o ajuste de lance). Raio, grupo de locais, idioma e o resto ficam intactos.",
        "",
        "Antes de gravar: confere que a campanha existe, que cada ID existe (geo_target_constant) e pula o que já",
        "está aplicado (sem escrita quando nada muda). Local já segmentado não pode ser excluído (e vice-versa).",
        "Demand Gen com segmentação aprimorada (upgraded_targeting): local fica nos GRUPOS de anúncios — a tool",
        "aplica em todos os grupos ativos/pausados, ou só em adGroupIds. Em qualquer outra campanha o local é da",
        "campanha inteira: adGroupIds é recusado (nada é gravado).",
        "",
        "Presença x interesse: veja/ajuste com set_geo_target_type (para lead-gen local, PRESENCE).",
        "IDs comuns: Brasil=2076, estado de SP=20106, cidade de São Paulo=1001773. Busque com list_geo_targets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        locationIds: flexArray(z.string()).describe("geo_target_constant IDs."),
        negative: z.boolean().optional().describe("true = excluir. Default: false."),
        replace: z.boolean().optional().describe("true = substitui os locais atuais da mesma polaridade. Default: false (adiciona)."),
        adGroupIds: flexArray(z.string()).optional().describe("Só Demand Gen com segmentação aprimorada: limita aos grupos informados. Em outra campanha é recusado (lá o critério é da campanha inteira)."),
      },
    },
    async ({ customerId, campaignId, locationIds: rawLocationIds, negative, replace, adGroupIds: rawAdGroupIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      // campaignId entra cru em GAQL e em resource names: só dígitos.
      if (!NUMERIC_ID.test(str(campaignId))) {
        return fail("campaignId inválido — use apenas o ID numérico da campanha. Nada foi enviado.");
      }
      const { ids: locationIds, invalid } = parseIds(rawLocationIds);
      if (invalid.length) return fail(`locationIds inválidos (só dígitos): ${invalid.join(", ")}. Nada foi enviado.`);
      if (locationIds.length === 0) return fail("locationIds vazio — informe ao menos um geo_target_constant ID. Nada foi enviado.");
      const adGroupFilter = parseIds(rawAdGroupIds);
      if (adGroupFilter.invalid.length) return fail(`adGroupIds inválidos: ${adGroupFilter.invalid.join(", ")}. Nada foi enviado.`);
      const isNegative = negative === true;
      const polarity = isNegative ? "exclusão" : "segmentação";

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`);
      if (adGroupFilter.ids.length && !isUpgradedDemandGen(campaign)) return adGroupScopeRefusal(campaign, "local");

      const geo = await resolveGeoTargets(client, customerId, locationIds);
      const unknown = locationIds.filter((id) => !geo.has(id));
      if (unknown.length) {
        return fail(`geo_target_constant inexistente(s): ${unknown.join(", ")}. Busque os IDs com list_geo_targets. Nada foi gravado.`);
      }
      const warnings: string[] = [];
      for (const id of locationIds) {
        if (geo.get(id)!.status && geo.get(id)!.status !== "ENABLED") {
          warnings.push(`${id} (${geo.get(id)!.canonical_name}) está ${geo.get(id)!.status} — o Google vai descontinuar este local.`);
        }
      }
      const label = (id: string) => ({ id, name: geo.get(id)?.canonical_name || geo.get(id)?.name || id });
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.channel})`;
      const dryRun = client.isDryRun;

      // ── Demand Gen com segmentação aprimorada: critérios nos grupos ──
      if (isUpgradedDemandGen(campaign)) {
        const adGroups = await fetchAdGroups(client, customerId, campaignId);
        const foreign = adGroupFilter.ids.filter((id) => !adGroups.some((ag) => ag.id === id));
        if (foreign.length) return fail(`Grupo(s) ${foreign.join(", ")} não pertencem à campanha ${campaignId} (ou estão removidos). Nada foi gravado.`);
        const targets = adGroupFilter.ids.length ? adGroups.filter((ag) => adGroupFilter.ids.includes(ag.id)) : adGroups;
        if (targets.length === 0) {
          return fail(`${campaignLine} usa segmentação aprimorada (local por grupo de anúncios) e não tem grupos ativos. Crie o grupo e rode de novo. Nada foi gravado.`);
        }
        const existing = await fetchAdGroupGeoCriteria(client, customerId, [campaignId], ["LOCATION"]);
        const ops: MutateOperation[] = [];
        const perGroup: Row[] = [];
        const conflicts: string[] = [];
        for (const ag of targets) {
          const mine = existing.filter((c) => c.adGroupId === ag.id);
          const same = mine.filter((c) => c.negative === isNegative);
          const opposite = new Set(mine.filter((c) => c.negative !== isNegative).map((c) => c.geoTargetId));
          for (const id of locationIds) if (opposite.has(id)) conflicts.push(`grupo ${ag.id}: ${label(id).name} (${id})`);
          const sameIds = new Set(same.map((c) => c.geoTargetId));
          const create = locationIds.filter((id) => !sameIds.has(id));
          const remove = replace ? same.filter((c) => !locationIds.includes(c.geoTargetId ?? "")) : [];
          for (const c of remove) ops.push({ remove: c.resourceName });
          for (const id of create) {
            ops.push({ create: { adGroup: `customers/${cid}/adGroups/${ag.id}`, location: { geoTargetConstant: `geoTargetConstants/${id}` }, negative: isNegative } });
          }
          perGroup.push({
            ad_group_id: ag.id,
            ad_group_name: ag.name,
            created: create.map(label),
            removed: remove.map((c) => ({ id: c.geoTargetId, criterion_id: c.criterionId })),
            already_present: locationIds.filter((id) => sameIds.has(id)).map(label),
          });
        }
        if (conflicts.length) {
          return fail(`Local já está do outro lado (segmentado x excluído) — a API recusaria (CANNOT_TARGET_AND_EXCLUDE):\n- ${conflicts.join("\n- ")}\nNada foi gravado.`);
        }
        if (ops.length === 0) {
          return { content: [text(`${campaignLine}: nada a mudar — a ${polarity} pedida já está em todos os grupos. Nenhuma escrita foi enviada.\n\n${formatJson({ ad_groups: perGroup })}`)] };
        }
        try {
          await client.mutate(customerId, "adGroupCriteria", ops);
        } catch (err) {
          return fail(`${campaignLine}: a API recusou a alteração nos grupos (nada foi gravado — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}`);
        }
        return {
          content: [text(
            `${campaignLine} — Demand Gen com segmentação aprimorada: ${polarity} aplicada em ${targets.length} grupo(s)` +
            (dryRun ? " — DRY-RUN (validateOnly): a API validou, nada foi gravado." : ".") +
            `\n\n${formatJson({ routed_to: "ad_group_criterion", replace: replace === true, ad_groups: perGroup, warnings })}`
          )],
        };
      }

      // ── Critérios de campanha ──
      const existing = await fetchCampaignCriteria(client, customerId, [campaignId], ["LOCATION"]);
      const extraIds = existing.map((c) => c.geoTargetId ?? "").filter((id) => id && !geo.has(id));
      if (extraIds.length) {
        try {
          for (const [id, info] of await resolveGeoTargets(client, customerId, extraIds)) geo.set(id, info);
        } catch {
          // só para exibir nomes; os IDs continuam no relatório
        }
      }
      const same = existing.filter((c) => c.negative === isNegative);
      const opposite = existing.filter((c) => c.negative !== isNegative);
      const conflicts = locationIds.filter((id) => opposite.some((c) => c.geoTargetId === id));
      if (conflicts.length) {
        return fail(
          `${campaignLine}: ${conflicts.map((id) => `${label(id).name} (${id})`).join(", ")} já está ${isNegative ? "segmentado" : "excluído"} ` +
          "na campanha — o mesmo local não pode ser segmentado e excluído (CANNOT_TARGET_AND_EXCLUDE). " +
          "Remova antes com remove_campaign_geo_targets. Nada foi gravado."
        );
      }
      const sameIds = new Set(same.map((c) => c.geoTargetId));
      const toCreate = locationIds.filter((id) => !sameIds.has(id));
      const toRemove = replace ? same.filter((c) => !locationIds.includes(c.geoTargetId ?? "")) : [];
      const describeSet = (criteria: CampaignCriterionRow[]) =>
        criteria.map((c) => ({ ...label(c.geoTargetId ?? ""), criterion_id: c.criterionId, bid_modifier: c.bidModifier }));
      const before = { targeted: describeSet(existing.filter((c) => !c.negative)), excluded: describeSet(existing.filter((c) => c.negative)) };
      const keptSame = same.filter((c) => !toRemove.includes(c));
      const afterSame = [...keptSame.map((c) => label(c.geoTargetId ?? "")), ...toCreate.map(label)];
      const after = isNegative
        ? { targeted: before.targeted.map(({ id, name }) => ({ id, name })), excluded: afterSame }
        : { targeted: afterSame, excluded: before.excluded.map(({ id, name }) => ({ id, name })) };
      if (!isNegative && campaign.positiveGeoTargetType === "PRESENCE_OR_INTEREST") warnings.push(PRESENCE_OR_INTEREST_HINT);

      const summary = {
        campaign: { id: campaignId, name: campaign.name, channel: campaign.channel, positive_geo_target_type: campaign.positiveGeoTargetType || undefined },
        mode: replace ? "replace" : "add",
        polarity: isNegative ? "excluded" : "targeted",
        created: toCreate.map(label),
        removed: toRemove.map((c) => ({ ...label(c.geoTargetId ?? ""), criterion_id: c.criterionId })),
        already_present: locationIds.filter((id) => sameIds.has(id)).map(label),
        before,
        after,
        warnings,
      };
      if (toCreate.length === 0 && toRemove.length === 0) {
        return { content: [text(`${campaignLine}: nada a mudar — a ${polarity} pedida já está aplicada. Nenhuma escrita foi enviada.\n\n${formatJson(summary)}`)] };
      }

      // Remove e create na MESMA requisição, sem partialFailure: a API aplica tudo ou nada.
      // Em duas requisições, um create recusado deixaria a campanha sem local nenhum —
      // entregando no mundo inteiro.
      const ops: MutateOperation[] = [
        ...toRemove.map((c) => ({ remove: c.resourceName })),
        ...toCreate.map((id) => ({
          create: { campaign: `customers/${cid}/campaigns/${campaignId}`, location: { geoTargetConstant: `geoTargetConstants/${id}` }, negative: isNegative },
        })),
      ];
      try {
        await client.mutate(customerId, "campaignCriteria", ops);
      } catch (err) {
        return fail(`${campaignLine}: a API recusou a alteração (nada foi gravado — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}\n\n${formatJson(summary)}`);
      }
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): a API validou ${toCreate.length} criação(ões) e ${toRemove.length} remoção(ões); nada foi gravado.`
        : `${campaignLine}: ${polarity} — ${toCreate.length} local(is) adicionado(s), ${toRemove.length} removido(s)` +
          `${replace ? " (substituição)" : " (adicionando à segmentação existente)"}.`;
      return { content: [text(`${header}\n\n${formatJson(summary)}`)] };
    }
  );

  // ── set_campaign_languages ────────────────────────────────────────

  mcp.registerTool(
    "set_campaign_languages",
    {
      description: [
        "Segmentação por idioma de uma campanha. WRITE OPERATION.",
        "",
        "PESQUISA (inclui AI Max para Pesquisa): o Google removeu o idioma de campanha em Pesquisa a partir do fim de",
        "set/2026 — os anúncios passam a ser combinados pelo idioma do próprio anúncio. A tool RECUSA adicionar idioma",
        "em Pesquisa (a API responde OPERATION_NOT_PERMITTED_FOR_CONTEXT). Escreva anúncios e landing page em pt-BR.",
        "cleanup=true + confirm=true remove os critérios de idioma antigos (opcional; eles já são ignorados).",
        "PERFORMANCE MAX: aceita, mas o idioma só vale fora da Pesquisa (YouTube, Display, Discover, Gmail) e é",
        "validado contra o país da campanha (CANNOT_TARGET_LANGUAGE).",
        "DEMAND GEN com segmentação aprimorada: idioma fica nos grupos de anúncios (todos, ou adGroupIds). Em qualquer",
        "outra campanha o idioma é da campanha inteira: adGroupIds é recusado (nada é gravado).",
        "",
        "Idiomas por languageCodes (ex.: ['pt','es','zh_CN'], sem diferenciar maiúsculas; resolvidos em language_constant.code) ou languageIds",
        "(pt=1014, en=1000, es=1003). Por padrão ADICIONA; replace=true deixa exatamente a lista pedida (remove os",
        "outros e cria os novos numa requisição atômica). Idioma já aplicado não é recriado (sem escrita se nada muda).",
        "Sem nenhum idioma a campanha alcança todos os idiomas.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        languageIds: flexArray(z.string()).optional().describe("language_constant IDs (ex.: 1014 = português)."),
        languageCodes: flexArray(z.string()).optional().describe("Códigos de idioma (ex.: 'pt', 'es', 'en', 'zh_CN'). Maiúsculas e '-' no lugar de '_' são aceitos ('PT', 'zh-cn')."),
        replace: z.boolean().optional().describe("true = a campanha fica só com os idiomas pedidos. Default: false (adiciona)."),
        cleanup: z.boolean().optional().describe("true = remove TODOS os critérios de idioma da campanha (em Pesquisa: limpeza dos legados). Exige confirm."),
        confirm: z.boolean().optional().describe("Obrigatório (true) com cleanup."),
        adGroupIds: flexArray(z.string()).optional().describe("Só Demand Gen com segmentação aprimorada: limita aos grupos informados. Em outra campanha é recusado (lá o critério é da campanha inteira)."),
      },
    },
    async ({ customerId, campaignId, languageIds: rawIds, languageCodes: rawCodes, replace, cleanup, confirm, adGroupIds: rawAdGroupIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      if (!NUMERIC_ID.test(str(campaignId))) return fail("campaignId inválido — use apenas o ID numérico da campanha. Nada foi enviado.");
      const { ids: languageIds, invalid } = parseIds(rawIds);
      if (invalid.length) return fail(`languageIds inválidos (só dígitos): ${invalid.join(", ")}. Nada foi enviado.`);
      // Deduplica sem diferenciar maiúsculas ('pt' e 'PT' são o mesmo idioma).
      const codes = [...new Map(
        ensureArray<unknown>(rawCodes).map((c) => str(c).trim()).filter(Boolean).map((c) => [languageCodeKey(c), c] as const)
      ).values()];
      const badCodes = codes.filter((c) => !/^[A-Za-z]{2,3}(?:[_-][A-Za-z]{2,4})?$/.test(c));
      if (badCodes.length) return fail(`languageCodes inválidos: ${badCodes.join(", ")} (ex.: pt, es, en, zh_CN). Nada foi enviado.`);
      const adGroupFilter = parseIds(rawAdGroupIds);
      if (adGroupFilter.invalid.length) return fail(`adGroupIds inválidos: ${adGroupFilter.invalid.join(", ")}. Nada foi enviado.`);
      const wantsLanguages = languageIds.length > 0 || codes.length > 0;
      if (cleanup && wantsLanguages) return fail("cleanup=true remove todos os idiomas — não combine com languageIds/languageCodes (para trocar, use replace=true). Nada foi enviado.");
      if (cleanup && replace) return fail("Use cleanup ou replace, não os dois. Nada foi enviado.");
      if (!cleanup && !wantsLanguages) return fail("Informe languageCodes ou languageIds (ou cleanup=true para remover todos). Nada foi enviado.");

      const client = getClient();
      const dryRun = client.isDryRun;
      const campaign = await fetchCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`);
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.channel})`;
      const upgradedDg = isUpgradedDemandGen(campaign);
      // Vale também para a limpeza em Pesquisa: com adGroupIds ela removeria os idiomas da campanha inteira.
      if (adGroupFilter.ids.length && !upgradedDg) return adGroupScopeRefusal(campaign, "idioma");

      const existing = await fetchCampaignCriteria(client, customerId, [campaignId], ["LANGUAGE"]);
      const existingAdGroup = upgradedDg ? await fetchAdGroupGeoCriteria(client, customerId, [campaignId], ["LANGUAGE"]) : [];
      const existingLangIds = unique([...existing, ...existingAdGroup].map((c) => c.languageId ?? "").filter(Boolean));

      // Resolve os idiomas pedidos e os existentes (para mostrar nomes). Em Pesquisa o pedido
      // é recusado de qualquer forma: só os existentes interessam.
      const isSearch = campaign.channel === "SEARCH";
      const { byId, byCode } = await resolveLanguages(
        client,
        customerId,
        unique([...(isSearch ? [] : languageIds), ...existingLangIds]),
        isSearch ? [] : codes
      );
      const langLabel = (id: string) => {
        const lang = byId.get(id);
        return { id, code: lang?.code || undefined, name: lang?.name || id };
      };

      // ── Pesquisa: idioma removido pelo Google ──
      if (isSearch) {
        const legacy = existing.map((c) => ({ ...langLabel(c.languageId ?? ""), criterion_id: c.criterionId }));
        if (!cleanup) {
          return fail(
            `${campaignLine}: idioma não é mais configurável em campanha de Pesquisa. Nada foi enviado.\n\n${SEARCH_LANGUAGE_NOTE}\n\n` +
            formatJson({ legacy_language_criteria: legacy })
          );
        }
        if (existing.length === 0) {
          return { content: [text(`${campaignLine}: não há critérios de idioma para limpar. Nenhuma escrita foi enviada.`)] };
        }
        if (!confirm && !dryRun) {
          return fail(
            `${campaignLine}: prévia da limpeza — ${existing.length} critério(s) de idioma legado(s) seriam removidos ` +
            "(já são ignorados em Pesquisa; depois de removidos não podem ser recriados). Nada foi gravado. " +
            `Reenvie com confirm: true para aplicar.\n\n${formatJson({ would_remove: legacy })}`
          );
        }
        try {
          await client.mutate(customerId, "campaignCriteria", existing.map((c) => ({ remove: c.resourceName })));
        } catch (err) {
          return fail(`${campaignLine}: a API recusou a limpeza (nada foi removido — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}`);
        }
        return {
          content: [text(
            (dryRun
              ? `${campaignLine} — DRY-RUN (validateOnly): a API validou a remoção de ${existing.length} critério(s) de idioma; nada foi gravado.`
              : `${campaignLine}: ${existing.length} critério(s) de idioma legado(s) removido(s).`) +
            `\n\n${formatJson({ removed: legacy, note: "Em Pesquisa os anúncios são combinados pelo idioma do anúncio." })}`
          )],
        };
      }

      // Idiomas pedidos → IDs (e validação de targetable).
      const wanted: string[] = [];
      const problems: string[] = [];
      for (const id of languageIds) {
        const lang = byId.get(id);
        if (!lang) problems.push(`languageId ${id} não existe`);
        else if (!lang.targetable) problems.push(`${lang.name} (${id}) não é segmentável`);
        else wanted.push(id);
      }
      for (const code of codes) {
        const lang = byCode.get(languageCodeKey(code));
        if (!lang) problems.push(`código "${code}" não existe em language_constant`);
        else if (!lang.targetable) problems.push(`${lang.name} (${lang.code}) não é segmentável`);
        else wanted.push(lang.id);
      }
      if (problems.length) {
        return fail(
          `Nada foi gravado — idioma(s) inválido(s):\n- ${problems.join("\n- ")}\n` +
          "Liste os válidos com run_gaql: SELECT language_constant.id, language_constant.code, language_constant.name FROM language_constant WHERE language_constant.targetable = TRUE"
        );
      }
      const wantedIds = unique(wanted);
      const warnings: string[] = [];
      if (campaign.channel === "PERFORMANCE_MAX") warnings.push(PMAX_LANGUAGE_NOTE);

      // ── Demand Gen com segmentação aprimorada: idioma nos grupos ──
      if (upgradedDg) {
        const adGroups = await fetchAdGroups(client, customerId, campaignId);
        const foreign = adGroupFilter.ids.filter((id) => !adGroups.some((ag) => ag.id === id));
        if (foreign.length) return fail(`Grupo(s) ${foreign.join(", ")} não pertencem à campanha ${campaignId} (ou estão removidos). Nada foi gravado.`);
        const targets = adGroupFilter.ids.length ? adGroups.filter((ag) => adGroupFilter.ids.includes(ag.id)) : adGroups;
        if (targets.length === 0) {
          return fail(`${campaignLine} usa segmentação aprimorada (idioma por grupo de anúncios) e não tem grupos ativos. Crie o grupo e rode de novo. Nada foi gravado.`);
        }
        if (existing.length) {
          warnings.push(`A campanha ainda tem ${existing.length} critério(s) de idioma no nível da campanha; com segmentação aprimorada vale o do grupo.`);
        }
        const ops: MutateOperation[] = [];
        const perGroup: Row[] = [];
        for (const ag of targets) {
          const mine = existingAdGroup.filter((c) => c.adGroupId === ag.id);
          const mineIds = new Set(mine.map((c) => c.languageId));
          const remove = cleanup ? mine : replace ? mine.filter((c) => !wantedIds.includes(c.languageId ?? "")) : [];
          const create = cleanup ? [] : wantedIds.filter((id) => !mineIds.has(id));
          for (const c of remove) ops.push({ remove: c.resourceName });
          for (const id of create) {
            ops.push({ create: { adGroup: `customers/${cid}/adGroups/${ag.id}`, language: { languageConstant: `languageConstants/${id}` } } });
          }
          perGroup.push({
            ad_group_id: ag.id,
            ad_group_name: ag.name,
            before: mine.map((c) => langLabel(c.languageId ?? "")),
            created: create.map(langLabel),
            removed: remove.map((c) => langLabel(c.languageId ?? "")),
          });
        }
        if (ops.length === 0) {
          return { content: [text(`${campaignLine}: nada a mudar nos grupos. Nenhuma escrita foi enviada.\n\n${formatJson({ ad_groups: perGroup, warnings })}`)] };
        }
        if (cleanup && !confirm && !dryRun) {
          return fail(`${campaignLine}: prévia — removeria todos os idiomas de ${targets.length} grupo(s) (passariam a alcançar todos os idiomas). Nada foi gravado. Reenvie com confirm: true.\n\n${formatJson({ ad_groups: perGroup })}`);
        }
        try {
          await client.mutate(customerId, "adGroupCriteria", ops);
        } catch (err) {
          return fail(`${campaignLine}: a API recusou a alteração nos grupos (nada foi gravado — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}`);
        }
        return {
          content: [text(
            `${campaignLine} — Demand Gen com segmentação aprimorada: idioma aplicado em ${targets.length} grupo(s)` +
            (dryRun ? " — DRY-RUN (validateOnly): a API validou, nada foi gravado." : ".") +
            `\n\n${formatJson({ routed_to: "ad_group_criterion", ad_groups: perGroup, warnings })}`
          )],
        };
      }

      // ── Critérios de campanha ──
      const existingIds = new Set(existing.map((c) => c.languageId));
      const toRemove = cleanup ? existing : replace ? existing.filter((c) => !wantedIds.includes(c.languageId ?? "")) : [];
      const toCreate = cleanup ? [] : wantedIds.filter((id) => !existingIds.has(id));
      const beforeList = existing.map((c) => langLabel(c.languageId ?? ""));
      const afterIds = [...existing.filter((c) => !toRemove.includes(c)).map((c) => c.languageId ?? ""), ...toCreate];
      const summary = {
        campaign: { id: campaignId, name: campaign.name, channel: campaign.channel },
        mode: cleanup ? "cleanup" : replace ? "replace" : "add",
        before: beforeList.length ? beforeList : "todos os idiomas (nenhum critério)",
        created: toCreate.map(langLabel),
        removed: toRemove.map((c) => ({ ...langLabel(c.languageId ?? ""), criterion_id: c.criterionId })),
        after: afterIds.length ? afterIds.map(langLabel) : "todos os idiomas (nenhum critério)",
        warnings,
      };
      if (toCreate.length === 0 && toRemove.length === 0) {
        return { content: [text(`${campaignLine}: nada a mudar — os idiomas pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n${formatJson(summary)}`)] };
      }
      if (cleanup && !confirm && !dryRun) {
        return fail(`${campaignLine}: prévia — removeria ${toRemove.length} idioma(s); a campanha passaria a alcançar todos os idiomas. Nada foi gravado. Reenvie com confirm: true.\n\n${formatJson(summary)}`);
      }
      const ops: MutateOperation[] = [
        ...toRemove.map((c) => ({ remove: c.resourceName })),
        ...toCreate.map((id) => ({ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, language: { languageConstant: `languageConstants/${id}` } } })),
      ];
      try {
        // Atômico (sem partialFailure): no replace, remover sem conseguir criar abriria a campanha para todos os idiomas.
        await client.mutate(customerId, "campaignCriteria", ops);
      } catch (err) {
        return fail(`${campaignLine}: a API recusou a alteração (nada foi gravado — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}\n\n${formatJson(summary)}`);
      }
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): a API validou ${toCreate.length} criação(ões) e ${toRemove.length} remoção(ões); nada foi gravado.`
        : `${campaignLine}: ${toCreate.length} idioma(s) adicionado(s), ${toRemove.length} removido(s).`;
      return { content: [text(`${header}\n\n${formatJson(summary)}`)] };
    }
  );

  // ── set_geo_target_type ───────────────────────────────────────────

  mcp.registerTool(
    "set_geo_target_type",
    {
      description: [
        "Opções avançadas de local: presença x interesse (Campaign.geo_target_type_setting). WRITE OPERATION.",
        "",
        "positive (locais segmentados):",
        "- PRESENCE: só quem está (ou costuma estar) na área. Recomendado para lead-gen local e serviço com área de atendimento.",
        "- PRESENCE_OR_INTEREST (padrão do Google): também quem está fora mas demonstrou interesse na área.",
        "negative (locais excluídos): PRESENCE (recomendado) ou PRESENCE_OR_INTEREST (em geral não suportado — a API decide).",
        "",
        "Lê o valor atual, só envia o que muda (updateMask com as folhas geo_target_type_setting.*) e devolve antes/depois.",
        "Aceita várias campanhas (campaignIds, até 50; mais de 10 exige confirm). Não mexe em locais, lances ou orçamento.",
        "Veja o valor atual com get_campaign_geo_targeting.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campaign ID (ou use campaignIds)."),
        campaignIds: flexArray(z.string()).optional().describe("Várias campanhas (até 50)."),
        positive: z.enum(GEO_TARGET_TYPES).optional().describe("PRESENCE | PRESENCE_OR_INTEREST."),
        negative: z.enum(GEO_TARGET_TYPES).optional().describe("PRESENCE | PRESENCE_OR_INTEREST."),
        confirm: z.boolean().optional().describe("Obrigatório (true) ao alterar mais de 10 campanhas."),
      },
    },
    async ({ customerId, campaignId, campaignIds: rawIds, positive, negative, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      const parsed = parseIds([...(campaignId !== undefined ? [campaignId] : []), ...ensureArray<unknown>(rawIds)]);
      if (parsed.invalid.length) return fail(`campaignId(s) inválido(s): ${parsed.invalid.join(", ")}. Nada foi enviado.`);
      const ids = parsed.ids;
      if (ids.length === 0) return fail("Informe campaignId ou campaignIds. Nada foi enviado.");
      if (ids.length > 50) return fail(`No máximo 50 campanhas por chamada (recebidas ${ids.length}). Nada foi enviado.`);
      if (positive === undefined && negative === undefined) return fail("Informe positive e/ou negative. Nada foi enviado.");
      for (const [name, value] of [["positive", positive], ["negative", negative]] as const) {
        if (value !== undefined && !(GEO_TARGET_TYPES as readonly string[]).includes(value)) {
          return fail(`${name} inválido: "${value}". Use PRESENCE ou PRESENCE_OR_INTEREST. Nada foi enviado.`);
        }
      }

      const client = getClient();
      const dryRun = client.isDryRun;
      const campaigns = await fetchCampaigns(client, customerId, ids);
      const missing = ids.filter((id) => !campaigns.has(id));
      if (missing.length) return fail(`Campanha(s) não encontrada(s) na conta ${cid}: ${missing.join(", ")}. Nada foi gravado.`);
      const removed = ids.filter((id) => campaigns.get(id)!.status === "REMOVED");
      if (removed.length) return fail(`Campanha(s) removida(s): ${removed.join(", ")}. Nada foi gravado.`);

      const warnings: string[] = [];
      if (negative === "PRESENCE_OR_INTEREST") {
        warnings.push("negative=PRESENCE_OR_INTEREST em geral não é suportado pelo Google para exclusões; se a API recusar, use PRESENCE.");
      }
      const plan: Array<{ id: string; update: Row; mask: string[]; before: Row; after: Row }> = [];
      const unchanged: Row[] = [];
      for (const id of ids) {
        const c = campaigns.get(id)!;
        const before = { positive: c.positiveGeoTargetType || "não definido", negative: c.negativeGeoTargetType || "não definido" };
        const setting: Row = {};
        const mask: string[] = [];
        if (positive !== undefined && positive !== c.positiveGeoTargetType) {
          setting.positiveGeoTargetType = positive;
          mask.push("geo_target_type_setting.positive_geo_target_type");
        }
        if (negative !== undefined && negative !== c.negativeGeoTargetType) {
          setting.negativeGeoTargetType = negative;
          mask.push("geo_target_type_setting.negative_geo_target_type");
        }
        if (mask.length === 0) {
          unchanged.push({ campaign_id: id, name: c.name, current: before });
          continue;
        }
        plan.push({
          id,
          update: { resourceName: `customers/${cid}/campaigns/${id}`, geoTargetTypeSetting: setting },
          mask,
          before,
          after: { positive: positive ?? before.positive, negative: negative ?? before.negative },
        });
      }
      if (plan.length === 0) {
        return { content: [text(`Nada a mudar — ${unchanged.length} campanha(s) já estão com o valor pedido. Nenhuma escrita foi enviada.\n\n${formatJson({ unchanged, warnings })}`)] };
      }
      if (plan.length > 10 && !confirm && !dryRun) {
        return fail(`Alteraria ${plan.length} campanhas de uma vez. Nada foi gravado. Reenvie com confirm: true.\n\n${formatJson({ would_change: plan.map((p) => ({ campaign_id: p.id, before: p.before, after: p.after })) })}`);
      }

      let response: Row;
      try {
        response = await client.mutate(customerId, "campaigns", plan.map((p) => ({ update: p.update, updateMask: p.mask.join(",") })), { partialFailure: true });
      } catch (err) {
        return fail(`A API recusou a alteração (nada foi gravado).\nErro: ${explainCriterionError((err as Error).message)}\n\n${formatJson({ attempted: plan.map((p) => ({ campaign_id: p.id, before: p.before, after: p.after })) })}`);
      }
      const results = ensureArray<Row>(response.results);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, plan.length);
      const changed: Row[] = [];
      const errors: Row[] = [];
      plan.forEach((p, index) => {
        const c = campaigns.get(p.id)!;
        const item = { campaign_id: p.id, name: c.name, channel: c.channel, before: p.before, after: p.after, update_mask: p.mask.join(",") };
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...item, error: explainCriterionError(opErrors.join("; ")) });
        else if (!dryRun && !obj(results[index]).resourceName) errors.push({ ...item, error: "a API não confirmou a alteração" });
        else changed.push(item);
      });
      for (const message of unattributed) errors.push({ error: message });
      const header = dryRun
        ? `DRY-RUN (validateOnly): ${changed.length} campanha(s) validada(s), nada foi gravado.`
        : `${changed.length} campanha(s) alterada(s).`;
      return {
        content: [text(`${header} Sem mudança: ${unchanged.length} | Com erro: ${errors.length}\n\n${formatJson({ [dryRun ? "validated" : "changed"]: changed, unchanged, errors, warnings })}`)],
        isError: errors.length > 0,
      };
    }
  );

  // ── add_proximity_target ──────────────────────────────────────────

  mcp.registerTool(
    "add_proximity_target",
    {
      description: [
        "Segmentação por raio (proximidade) em volta de um endereço ou de latitude/longitude. WRITE OPERATION.",
        "",
        "Cada item de targets vira um CampaignCriterion.proximity: raio em KILOMETERS (default) ou MILES,",
        "ajuste de lance opcional (bidModifier 0.1–10). Endereço precisa de countryCode (ex.: BR) e rua, cidade ou",
        "CEP; o Google geocodifica. Com lat/lng o ponto é exato. Raio só pode ser segmentado (não excluído).",
        "",
        "Confere que a campanha existe e pula raio idêntico já existente. Cada alvo é independente (partialFailure):",
        "o relatório separa criados, já existentes e erros, com o erro do Google explicado em PT-BR.",
        "Depois de gravar, mostra o ponto que o Google geocodificou. Remova com remove_campaign_geo_targets.",
        "Performance Max: a documentação de critérios de PMax não lista PROXIMITY — se a API recusar, use",
        "add_location_group_target (raio em volta dos locais da conta). Máx. 100 alvos por chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        targets: flexArray(proximityTargetSchema).describe("Raios a criar (1 a 100)."),
      },
    },
    async ({ customerId, campaignId, targets: rawTargets }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      if (!NUMERIC_ID.test(str(campaignId))) return fail("campaignId inválido — use apenas o ID numérico da campanha. Nada foi enviado.");
      const targets = ensureArray<ProximityTarget>(rawTargets).map((t) => obj(t) as unknown as ProximityTarget);
      if (targets.length === 0) return fail("Informe ao menos um alvo em targets. Nada foi enviado.");
      if (targets.length > MAX_PROXIMITY_PER_CALL) return fail(`No máximo ${MAX_PROXIMITY_PER_CALL} alvos por chamada (recebidos ${targets.length}). Nada foi enviado.`);
      const built = targets.map((t, i) => ({ target: t, ...buildProximity(t, i) }));
      const invalid = built.flatMap((b) => b.errors);
      if (invalid.length) return fail(`Nada foi enviado — alvo(s) inválido(s):\n- ${invalid.join("\n- ")}`);

      const client = getClient();
      const dryRun = client.isDryRun;
      const campaign = await fetchCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`);
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.channel})`;
      const warnings: string[] = [];
      if (campaign.channel === "PERFORMANCE_MAX") {
        warnings.push("PMax: a documentação de critérios de Performance Max não lista PROXIMITY. Se a API recusar, use add_location_group_target.");
      }
      if (isUpgradedDemandGen(campaign)) {
        warnings.push("Demand Gen com segmentação aprimorada: local fica nos grupos de anúncios; raio só existe no nível da campanha e a API pode recusar.");
      }
      if (campaign.positiveGeoTargetType === "PRESENCE_OR_INTEREST") warnings.push(PRESENCE_OR_INTEREST_HINT);

      const existing = await fetchCampaignCriteria(client, customerId, [campaignId], ["PROXIMITY"]);
      const existingKeys = new Map<string, CampaignCriterionRow>();
      for (const c of existing) for (const key of proximityKeys(c.proximity ?? {})) existingKeys.set(key, c);

      const toCreate: typeof built = [];
      const alreadyPresent: Row[] = [];
      const seen = new Set<string>();
      for (const b of built) {
        const keys = proximityKeys(b.proximity);
        const match = keys.map((k) => existingKeys.get(k)).find(Boolean);
        const describe = { label: b.target.label, ...describeProximity(b.proximity) };
        if (match) {
          alreadyPresent.push({ ...describe, criterion_id: match.criterionId, note: "raio idêntico já existe — não recriado" });
        } else if (keys.some((k) => seen.has(k))) {
          alreadyPresent.push({ ...describe, note: "repetido na própria chamada — enviado uma vez só" });
        } else {
          keys.forEach((k) => seen.add(k));
          toCreate.push(b);
        }
      }
      if (toCreate.length === 0) {
        return { content: [text(`${campaignLine}: nada a fazer — todos os raios já existem. Nenhuma escrita foi enviada.\n\n${formatJson({ already_present: alreadyPresent, warnings })}`)] };
      }

      const ops: MutateOperation[] = toCreate.map((b) => ({
        create: {
          campaign: `customers/${cid}/campaigns/${campaignId}`,
          proximity: b.proximity,
          ...(b.target.bidModifier !== undefined ? { bidModifier: b.target.bidModifier } : {}),
        },
      }));
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignCriteria", ops, { partialFailure: true });
      } catch (err) {
        return fail(`${campaignLine}: a API recusou a requisição (nada foi gravado).\nErro: ${explainCriterionError((err as Error).message)}`);
      }
      const results = ensureArray<Row>(response.results);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, ops.length);
      const created: Row[] = [];
      const errors: Row[] = [];
      toCreate.forEach((b, index) => {
        const describe = { label: b.target.label, ...describeProximity(b.proximity), bid_modifier: b.target.bidModifier };
        const opErrors = byIndex.get(index);
        const resourceName = str(obj(results[index]).resourceName);
        if (opErrors) errors.push({ ...describe, error: explainCriterionError(opErrors.join("; ")) });
        else if (!dryRun && !resourceName) errors.push({ ...describe, error: "a API não confirmou a criação" });
        else created.push({ ...describe, resource_name: resourceName || undefined, criterion_id: resourceName ? resourceName.split("~").pop() : undefined });
      });
      for (const message of unattributed) errors.push({ error: explainCriterionError(message) });

      // Depois de gravar: o ponto que o Google geocodificou (endereço → lat/lng).
      if (!dryRun && created.some((c) => c.resource_name)) {
        try {
          const names = created.map((c) => `'${gaqlLiteral(str(c.resource_name))}'`).filter((n) => n !== "''");
          const rows = await client.searchStream(customerId,
            `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id,
                    campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
                    campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
                    campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units
               FROM campaign_criterion
              WHERE campaign_criterion.resource_name IN (${names.join(", ")})`);
          for (const row of rows) {
            const cc = obj(row.campaignCriterion);
            const item = created.find((c) => c.resource_name === cc.resourceName);
            if (item) item.stored = describeProximity(obj(cc.proximity));
          }
        } catch {
          warnings.push("Não foi possível reler os raios criados; confira com get_campaign_geo_targeting.");
        }
      }

      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): ${created.length} raio(s) validado(s), nada foi gravado.`
        : `${campaignLine}: ${created.length} raio(s) criado(s).`;
      return {
        content: [text(`${header} Já existentes: ${alreadyPresent.length} | Com erro: ${errors.length}\n\n${formatJson({ [dryRun ? "validated" : "created"]: created, already_present: alreadyPresent, errors, warnings })}`)],
        isError: errors.length > 0,
      };
    }
  );

  // ── add_location_group_target ─────────────────────────────────────

  mcp.registerTool(
    "add_location_group_target",
    {
      description: [
        "Segmentação por raio em volta dos LOCAIS da conta (grupo de locais / LocationGroupInfo). WRITE OPERATION.",
        "",
        "Use com Perfil da Empresa conectado (recursos de local). Duas formas (exatamente uma):",
        "- useCustomerLocations=true: todos os locais do conjunto de locais da conta (LOCATION_SYNC).",
        "- assetSetIds: conjuntos de locais específicos (LOCATION_SYNC ou grupos BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP,",
        "  CHAIN_DYNAMIC_LOCATION_GROUP, STATIC_LOCATION_GROUP).",
        "Raio + unidade: com conjuntos de locais o Google aceita METERS e MILLI_MILES; KILOMETERS e MILES são",
        "convertidos (km → m, mi → milli-milhas). Suportado em Performance Max (entre outros; a API decide).",
        "",
        "Confere campanha e conjuntos de locais antes de gravar e pula grupo idêntico já existente.",
        "Remova com remove_campaign_geo_targets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        assetSetIds: flexArray(z.string()).optional().describe("IDs de asset sets de locais (ou use useCustomerLocations)."),
        useCustomerLocations: z.boolean().optional().describe("true = usa o conjunto de locais da conta (LOCATION_SYNC)."),
        radius: z.number().describe("Raio (> 0)."),
        radiusUnits: z.enum(["METERS", "MILLI_MILES", "KILOMETERS", "MILES"]).optional().describe("Default: METERS. KILOMETERS/MILES são convertidos."),
      },
    },
    async ({ customerId, campaignId, assetSetIds: rawAssetSets, useCustomerLocations, radius, radiusUnits }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      if (!NUMERIC_ID.test(str(campaignId))) return fail("campaignId inválido — use apenas o ID numérico da campanha. Nada foi enviado.");
      const { ids: assetSetIds, invalid } = parseIds(rawAssetSets);
      if (invalid.length) return fail(`assetSetIds inválidos (só dígitos): ${invalid.join(", ")}. Nada foi enviado.`);
      const useCustomer = useCustomerLocations === true;
      if (useCustomer === (assetSetIds.length > 0)) {
        return fail("Use exatamente uma forma: assetSetIds OU useCustomerLocations=true (o Google não aceita as duas juntas). Nada foi enviado.");
      }
      const units = radiusUnits ?? "METERS";
      const conversions: Record<string, [string, number]> = {
        METERS: ["METERS", 1], MILLI_MILES: ["MILLI_MILES", 1], KILOMETERS: ["METERS", 1000], MILES: ["MILLI_MILES", 1000],
      };
      if (!conversions[units]) return fail(`radiusUnits inválido: "${radiusUnits}". Use METERS, MILLI_MILES, KILOMETERS ou MILES. Nada foi enviado.`);
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) return fail(`radius precisa ser maior que zero (recebido ${radius}). Nada foi enviado.`);
      const [apiUnits, factor] = conversions[units];
      const apiRadius = Math.round(radius * factor);
      if (apiRadius < 1) return fail(`radius pequeno demais depois da conversão para ${apiUnits} (${radius} ${units}). Nada foi enviado.`);

      const client = getClient();
      const dryRun = client.isDryRun;
      const campaign = await fetchCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`);
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.channel})`;
      const warnings: string[] = [];
      if (units !== apiUnits) warnings.push(`Raio convertido: ${radius} ${units} → ${apiRadius} ${apiUnits}.`);

      let assetSets: Row[] = [];
      if (assetSetIds.length) {
        const rows = await client.searchStream(customerId,
          `SELECT asset_set.id, asset_set.name, asset_set.type, asset_set.status
             FROM asset_set
            WHERE asset_set.id IN (${assetSetIds.join(", ")})`);
        assetSets = rows.map((r) => obj(r.assetSet));
        const problems: string[] = [];
        for (const id of assetSetIds) {
          const set = assetSets.find((s) => str(s.id) === id);
          if (!set) problems.push(`asset set ${id} não existe na conta ${cid}`);
          else if (!LOCATION_ASSET_SET_TYPES.has(str(set.type))) problems.push(`asset set ${id} ("${str(set.name)}") é ${str(set.type)}, não um conjunto de locais`);
          else if (str(set.status) === "REMOVED") problems.push(`asset set ${id} ("${str(set.name)}") está removido`);
        }
        if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}`);
      } else {
        const rows = await client.searchStream(customerId,
          `SELECT customer_asset_set.asset_set, customer_asset_set.status, asset_set.id, asset_set.type
             FROM customer_asset_set
            WHERE asset_set.type = 'LOCATION_SYNC'
              AND customer_asset_set.status = 'ENABLED'`);
        if (rows.length === 0) {
          return fail(
            "A conta não tem um conjunto de locais (LOCATION_SYNC) vinculado — sem ele, useCustomerLocations não tem locais para " +
            "segmentar. Conecte o Perfil da Empresa (recursos de local) e tente de novo. Nada foi gravado."
          );
        }
      }

      const locationGroup: Row = {
        radius: String(apiRadius),
        radiusUnits: apiUnits,
        ...(useCustomer
          ? { enableCustomerLevelLocationAssetSet: true }
          : { locationGroupAssetSets: assetSetIds.map((id) => `customers/${cid}/assetSets/${id}`) }),
      };
      const existing = await fetchCampaignCriteria(client, customerId, [campaignId], ["LOCATION_GROUP"]);
      const key = locationGroupKey(locationGroup);
      const duplicate = existing.find((c) => locationGroupKey(c.locationGroup ?? {}) === key);
      const report = {
        location_group: { radius: apiRadius, radius_units: apiUnits, asset_sets: assetSets.map((s) => ({ id: str(s.id), name: str(s.name), type: str(s.type) })), customer_locations: useCustomer },
        existing_location_groups: existing.map(describeLocationGroup),
        warnings,
      };
      if (duplicate) {
        return { content: [text(`${campaignLine}: nada a fazer — grupo de locais idêntico já existe (criterion ${duplicate.criterionId}). Nenhuma escrita foi enviada.\n\n${formatJson(report)}`)] };
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignCriteria", [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, locationGroup } }]);
      } catch (err) {
        return fail(`${campaignLine}: a API recusou o grupo de locais (nada foi gravado).\nErro: ${explainCriterionError((err as Error).message)}\n\n${formatJson(report)}`);
      }
      const resourceName = str(obj(ensureArray<Row>(response.results)[0]).resourceName);
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): a API validou o grupo de locais; nada foi gravado.`
        : `${campaignLine}: grupo de locais criado${resourceName ? ` (${resourceName})` : ""}.`;
      return { content: [text(`${header}\n\n${formatJson({ ...report, resource_name: resourceName || undefined })}`)] };
    }
  );

  // ── remove_campaign_geo_targets ───────────────────────────────────

  mcp.registerTool(
    "remove_campaign_geo_targets",
    {
      description: [
        "Remove critérios geográficos de uma campanha: local (LOCATION, segmentado ou excluído), raio (PROXIMITY) e",
        "grupo de locais (LOCATION_GROUP). WRITE OPERATION — exige confirm: true (sem confirm devolve a prévia).",
        "",
        "Pegue os criterionIds em get_campaign_geo_targeting. Só aceita critérios geográficos desta campanha.",
        "Se a remoção deixar a campanha sem nenhum local/raio/grupo segmentado, ela passa a veicular no MUNDO TODO:",
        "a tool recusa, a menos que allowWorldwide=true. Remoção atômica (tudo ou nada).",
        "Idioma: use set_campaign_languages (replace ou cleanup).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        criterionIds: flexArray(z.string()).describe("criterion_id dos critérios a remover."),
        allowWorldwide: z.boolean().optional().describe("true = aceita que a campanha fique sem segmentação geográfica (mundo todo)."),
        confirm: z.boolean().optional().describe("Precisa ser true para remover."),
      },
    },
    async ({ customerId, campaignId, criterionIds: rawIds, allowWorldwide, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      const cid = customerId.replace(/-/g, "");
      if (!NUMERIC_ID.test(str(campaignId))) return fail("campaignId inválido — use apenas o ID numérico da campanha. Nada foi enviado.");
      const { ids, invalid } = parseIds(rawIds);
      if (invalid.length) return fail(`criterionIds inválidos (só dígitos): ${invalid.join(", ")}. Nada foi enviado.`);
      if (ids.length === 0) return fail("Informe ao menos um criterionId. Nada foi enviado.");

      const client = getClient();
      const dryRun = client.isDryRun;
      const campaign = await fetchCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`);
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.channel})`;
      const existing = await fetchCampaignCriteria(client, customerId, [campaignId], GEO_CRITERION_TYPES);
      const notFound = ids.filter((id) => !existing.some((c) => c.criterionId === id));
      if (notFound.length) {
        return fail(
          `${campaignLine}: criterionId(s) ${notFound.join(", ")} não são critérios geográficos ativos desta campanha. Nada foi gravado.\n\n` +
          formatJson({ geo_criteria: existing.map((c) => ({ criterion_id: c.criterionId, type: c.type, negative: c.negative, location_id: c.geoTargetId })) })
        );
      }
      const toRemove = existing.filter((c) => ids.includes(c.criterionId));
      const geo = await resolveGeoTargets(client, customerId, toRemove.map((c) => c.geoTargetId ?? "").filter(Boolean)).catch(() => new Map<string, GeoConstant>());
      const describe = (c: CampaignCriterionRow) => ({
        criterion_id: c.criterionId,
        type: c.type,
        negative: c.negative,
        ...(c.type === "LOCATION" ? { location_id: c.geoTargetId, name: geo.get(c.geoTargetId ?? "")?.canonical_name || c.geoTargetId } : {}),
        ...(c.type === "PROXIMITY" ? describeProximity(c.proximity ?? {}) : {}),
        ...(c.type === "LOCATION_GROUP" ? { location_group: describeLocationGroup(c) } : {}),
        bid_modifier: c.bidModifier,
      });
      const positivesBefore = existing.filter((c) => !c.negative);
      const positivesAfter = positivesBefore.filter((c) => !ids.includes(c.criterionId));
      const worldwide = positivesBefore.length > 0 && positivesAfter.length === 0 && !isUpgradedDemandGen(campaign);
      const preview = { would_remove: toRemove.map(describe), positive_geo_criteria_after: positivesAfter.length, worldwide_after: worldwide };
      if (worldwide && allowWorldwide !== true) {
        return fail(
          `${campaignLine}: a remoção tiraria toda a segmentação geográfica positiva — a campanha passaria a veicular no MUNDO TODO. ` +
          "Nada foi gravado. Se é isso mesmo, reenvie com allowWorldwide: true (e confirm: true). Para trocar de local, use " +
          `set_campaign_locations com replace=true.\n\n${formatJson(preview)}`
        );
      }
      if (!confirm && !dryRun) {
        return fail(`${campaignLine}: prévia — ${toRemove.length} critério(s) seriam removidos. Nada foi gravado. Reenvie com confirm: true.\n\n${formatJson(preview)}`);
      }
      try {
        await client.mutate(customerId, "campaignCriteria", toRemove.map((c) => ({ remove: c.resourceName })));
      } catch (err) {
        return fail(`${campaignLine}: a API recusou a remoção (nada foi removido — requisição atômica).\nErro: ${explainCriterionError((err as Error).message)}\n\n${formatJson(preview)}`);
      }
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): a API validou a remoção de ${toRemove.length} critério(s); nada foi gravado.`
        : `${campaignLine}: ${toRemove.length} critério(s) geográfico(s) removido(s).`;
      return { content: [text(`${header}\n\n${formatJson({ removed: toRemove.map(describe), positive_geo_criteria_after: positivesAfter.length, worldwide_after: worldwide })}`)] };
    }
  );

  // ── get_campaign_geo_targeting ────────────────────────────────────

  mcp.registerTool(
    "get_campaign_geo_targeting",
    {
      description: [
        "Segmentação geográfica e de idioma atual por campanha. READ OPERATION.",
        "",
        "Mostra: presença x interesse (geo_target_type_setting), locais segmentados e excluídos com nomes e ajuste de",
        "lance, raios (proximidade), grupos de locais, idiomas e — em Demand Gen com segmentação aprimorada — local e",
        "idioma por grupo de anúncios. Traz os criterion_id usados por remove_campaign_geo_targets e avisos",
        "(campanha sem local = mundo todo; idioma legado em Pesquisa; presença-ou-interesse em campanha local).",
        "Sem campaignId: todas as campanhas ativas e pausadas.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campaign ID (opcional)."),
        limit: z.number().optional().describe("Máximo de campanhas sem campaignId (1 a 1000). Default: 100."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const badCustomer = customerIdError(customerId);
      if (badCustomer) return badCustomer;
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) return fail(`campaignId inválido: "${campaignId}". Use o ID numérico.`);
      const maxCampaigns = limit ?? 100;
      if (!Number.isInteger(maxCampaigns) || maxCampaigns < 1 || maxCampaigns > 1000) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 1000.`);

      const client = getClient();
      const campaignRows = await client.searchStream(customerId,
        `SELECT ${CAMPAIGN_FIELDS}
           FROM campaign
          WHERE campaign.status != 'REMOVED'
            ${campaignId ? `AND campaign.id = ${campaignId}` : ""}
          ORDER BY campaign.name
          LIMIT ${maxCampaigns}`);
      const campaigns = campaignRows.map(toCampaignInfo).filter((c) => c.id);
      if (campaigns.length === 0) {
        return campaignId
          ? fail(`Campanha ${campaignId} não encontrada (ou removida) na conta ${customerId.replace(/-/g, "")}.`)
          : { content: [text("Nenhuma campanha ativa ou pausada na conta.")] };
      }
      const ids = campaigns.map((c) => c.id);
      const criteria: CampaignCriterionRow[] = [];
      for (const group of chunk(ids, 500)) {
        criteria.push(...await fetchCampaignCriteria(client, customerId, group, [...GEO_CRITERION_TYPES, "LANGUAGE"]));
      }
      const upgraded = campaigns.filter(isUpgradedDemandGen).map((c) => c.id);
      const adGroupCriteria = upgraded.length ? await fetchAdGroupGeoCriteria(client, customerId, upgraded, ["LOCATION", "LANGUAGE"]) : [];

      const geoIds = [...criteria, ...adGroupCriteria].map((c) => c.geoTargetId ?? "").filter(Boolean);
      const langIds = unique([...criteria, ...adGroupCriteria].map((c) => c.languageId ?? "").filter(Boolean));
      const notes: string[] = [];
      let geo = new Map<string, GeoConstant>();
      let langs = new Map<string, LanguageConstant>();
      try {
        geo = await resolveGeoTargets(client, customerId, geoIds);
        if (langIds.length) langs = (await resolveLanguages(client, customerId, langIds, [])).byId;
      } catch (err) {
        notes.push(`Nomes não resolvidos: ${(err as Error).message}`);
      }
      const geoLabel = (id?: string) => ({ location_id: id, name: geo.get(id ?? "")?.canonical_name || geo.get(id ?? "")?.name || id, target_type: geo.get(id ?? "")?.target_type || undefined });
      const langLabel = (id?: string) => ({ language_id: id, code: langs.get(id ?? "")?.code || undefined, name: langs.get(id ?? "")?.name || id });

      const report = campaigns.map((c) => {
        const mine = criteria.filter((cc) => cc.campaignId === c.id);
        const locations = mine.filter((cc) => cc.type === "LOCATION");
        const proximities = mine.filter((cc) => cc.type === "PROXIMITY");
        const groups = mine.filter((cc) => cc.type === "LOCATION_GROUP");
        const languages = mine.filter((cc) => cc.type === "LANGUAGE");
        const warnings: string[] = [];
        const positives = mine.filter((cc) => cc.type !== "LANGUAGE" && !cc.negative);
        const upgradedDg = isUpgradedDemandGen(c);
        if (!upgradedDg && positives.length === 0) warnings.push("Sem local, raio ou grupo de locais segmentado: a campanha pode veicular no mundo todo.");
        if (c.positiveGeoTargetType === "PRESENCE_OR_INTEREST" && positives.length > 0) warnings.push(PRESENCE_OR_INTEREST_HINT);
        if (c.channel === "SEARCH" && languages.length > 0) {
          warnings.push("Idiomas legados em Pesquisa: ignorados desde o fim de set/2026 (vale o idioma do anúncio). Limpeza opcional: set_campaign_languages cleanup=true confirm=true.");
        }
        if (c.channel === "PERFORMANCE_MAX" && languages.length > 0) warnings.push(PMAX_LANGUAGE_NOTE);
        if (upgradedDg) warnings.push("Demand Gen com segmentação aprimorada: local e idioma valem por grupo de anúncios (ad_group_targeting).");
        const agRows = adGroupCriteria.filter((a) => a.campaignId === c.id);
        return {
          campaign_id: c.id,
          name: c.name,
          status: c.status,
          channel: c.channel,
          geo_target_type: { positive: c.positiveGeoTargetType || "não definido", negative: c.negativeGeoTargetType || "não definido" },
          targeted_locations: locations.filter((l) => !l.negative).map((l) => ({ criterion_id: l.criterionId, ...geoLabel(l.geoTargetId), bid_modifier: l.bidModifier })),
          excluded_locations: locations.filter((l) => l.negative).map((l) => ({ criterion_id: l.criterionId, ...geoLabel(l.geoTargetId) })),
          proximity: proximities.map((p) => ({ criterion_id: p.criterionId, ...describeProximity(p.proximity ?? {}), bid_modifier: p.bidModifier })),
          location_groups: groups.map((g) => describeLocationGroup(g)),
          languages: languages.length ? languages.map((l) => ({ criterion_id: l.criterionId, ...langLabel(l.languageId) })) : "todos (nenhum critério)",
          ...(upgradedDg
            ? {
                ad_group_targeting: agRows.map((a) => ({
                  ad_group_id: a.adGroupId,
                  ad_group_name: a.adGroupName,
                  criterion_id: a.criterionId,
                  type: a.type,
                  negative: a.negative,
                  ...(a.type === "LOCATION" ? geoLabel(a.geoTargetId) : langLabel(a.languageId)),
                })),
              }
            : {}),
          warnings,
        };
      });

      if (format === "table" || format === "csv") {
        const flat: Row[] = [];
        for (const c of report) {
          const base = { campaign_id: c.campaign_id, campaign: c.name, channel: c.channel, positive_geo_target_type: c.geo_target_type.positive };
          for (const l of c.targeted_locations) flat.push({ ...base, kind: "local segmentado", criterion_id: l.criterion_id, target: l.name, bid_modifier: l.bid_modifier ?? "" });
          for (const l of c.excluded_locations) flat.push({ ...base, kind: "local excluído", criterion_id: l.criterion_id, target: l.name, bid_modifier: "" });
          for (const p of c.proximity) flat.push({ ...base, kind: "raio", criterion_id: p.criterion_id, target: `${p.radius} ${p.radius_units} @ ${p.latitude ?? ""},${p.longitude ?? ""}`, bid_modifier: p.bid_modifier ?? "" });
          for (const g of c.location_groups) flat.push({ ...base, kind: "grupo de locais", criterion_id: g.criterion_id, target: `${g.radius} ${g.radius_units}`, bid_modifier: g.bid_modifier ?? "" });
          if (Array.isArray(c.languages)) for (const l of c.languages) flat.push({ ...base, kind: "idioma", criterion_id: l.criterion_id, target: l.name, bid_modifier: "" });
          if (flat.every((row) => row.campaign_id !== c.campaign_id)) flat.push({ ...base, kind: "(nenhum critério)", criterion_id: "", target: "", bid_modifier: "" });
        }
        return format === "csv" ? { content: [text(formatAsCsv(flat))] } : { content: [text(formatAsTable(flat))] };
      }
      const capped = !campaignId && campaigns.length === maxCampaigns ? ` Limite de ${maxCampaigns} atingido — use campaignId ou limit.` : "";
      return { content: [text(`${report.length} campanha(s).${capped}${notes.length ? `\n${notes.join("\n")}` : ""}\n\n${formatJson(report)}`)] };
    }
  );
}
