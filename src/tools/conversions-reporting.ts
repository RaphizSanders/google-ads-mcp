/**
 * Lote conversions-reporting: regras de valor, detalhamento de conversões, lift e leads.
 *
 * - get_conversions_by_action / get_conversion_lag: de onde vêm as conversões (ação, primária x
 *   secundária, view-through) e quantos dias recentes ainda estão incompletos (atraso).
 * - list/create/update_conversion_value_rule e get_value_rule_impact: regras de valor de conversão
 *   (ConversionValueRule + ConversionValueRuleSet) e o efeito delas no valor.
 * - get_lift_results: estudos de Conversion Lift e Brand Lift (somente leitura, v25.1).
 * - list_lead_forms / create_lead_form / link_lead_form_to_campaigns / get_lead_form_submissions:
 *   formulários de lead (LeadFormAsset + CampaignAsset LEAD_FORM) e os leads recebidos.
 *
 * Campos, enums e compatibilidades conferidos na referência v25 (fields/v25, protos v25).
 * Toda tool chama checkCustomerAccess (o teste de allowlist confere no fonte).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  CONVERSION_CATEGORY_ALIASES,
  DATE_RANGE_DESC,
  DAYS_DESC,
  ISO_DATE,
  buildDateClause,
  checkCustomerAccess,
  conversionCategorySchema,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  localIsoDate,
  num,
  partialFailureByOperation,
  resolveEnumAlias,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type Format = "json" | "table" | "csv" | undefined;

// ── Helpers do módulo ────────────────────────────────────────────────

const NUMERIC_ID = /^\d+$/;
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).map(String);
const fail = (message: string) => ({ content: [text(message)], isError: true });
const lastSegment = (resourceName: unknown) => String(resourceName ?? "").split("/").pop() ?? "";
const brl = (value: number) => `R$ ${value.toFixed(2)}`;
const pct = (part: number, total: number) => (total ? round2((part / total) * 100) : 0);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** snake_case do GAQL → chave lowerCamelCase do JSON REST (p90 → P90, p_value → PValue). */
const camel = (field: string) => field.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function dateClauseOrError(
  dateRange: { since: string; until: string } | undefined,
  days: number | undefined,
  defaultDays = 30
): { clause: string } | { error: string } {
  try {
    return { clause: buildDateClause(dateRange, days ?? defaultDays) };
  } catch (err) {
    return { error: errorText(err) };
  }
}

/** Soma dias a uma data ISO (YYYY-MM-DD) em UTC — sem efeito de horário de verão. */
function shiftIsoDate(iso: string, deltaDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Primeiro e último dia da janela de um filtro de data já montado: "segments.date BETWEEN 'a' AND 'b'"
 * ou "segments.date DURING LAST_N_DAYS" (que termina ontem, sem hoje). Lido da própria cláusula para
 * seguir o que foi consultado, sem refazer a regra de buildDateClause.
 */
function reportWindow(clause: string): { since?: string; until: string } {
  const between = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(clause);
  if (between) return { since: between[1], until: between[2] };
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const until = localIsoDate(yesterday);
  const lastN = /DURING LAST_(\d+)_DAYS/.exec(clause);
  return lastN ? { since: shiftIsoDate(until, -(Number(lastN[1]) - 1)), until } : { until };
}

function periodLabel(dateRange: { since: string; until: string } | undefined, days: number | undefined, defaultDays = 30) {
  return dateRange?.since && dateRange?.until ? `${dateRange.since} a ${dateRange.until}` : `últimos ${days ?? defaultDays} dias`;
}

function render(rows: Row[], format: Format, header: string, jsonBody: unknown = rows): string {
  if (format === "table") return `${header}\n\n${formatAsTable(rows)}`;
  if (format === "csv") return formatAsCsv(rows);
  return `${header}\n\n${formatJson(jsonBody)}`;
}

/** Acrescenta uma explicação em PT-BR à mensagem crua da API quando o erro é conhecido. */
function explainApiError(err: unknown, hints: Array<[RegExp, string]>): string {
  const message = errorText(err);
  const hint = hints.find(([pattern]) => pattern.test(message))?.[1];
  return hint ? `${message}\n→ ${hint}` : message;
}

/** Lista de strings já validadas para um IN (...) do GAQL. */
const inList = (values: string[]) => values.map((v) => `'${gaqlLiteral(v)}'`).join(", ");

function normalizeIds(values: unknown, label: string): { ids: string[] } | { error: string } {
  const ids = [...new Set(ensureArray<unknown>(values).map((v) => String(v).trim()).filter(Boolean))];
  const bad = ids.filter((id) => !NUMERIC_ID.test(id));
  if (bad.length) return { error: `${label} precisa de IDs numéricos — inválido(s): ${bad.join(", ")}. Nada foi enviado.` };
  return { ids };
}

function mutateResults(response: Row): Row[] {
  return list(response.mutateOperationResponses).map(obj);
}

// ── Conversões por ação e atraso (item 69) ───────────────────────────

/** Buckets de segments.conversion_lag_bucket (enum ConversionLagBucket v25) com o intervalo em dias. */
const LAG_BUCKETS: Array<{ bucket: string; from: number; to: number }> = [
  { bucket: "LESS_THAN_ONE_DAY", from: 0, to: 1 },
  { bucket: "ONE_TO_TWO_DAYS", from: 1, to: 2 },
  { bucket: "TWO_TO_THREE_DAYS", from: 2, to: 3 },
  { bucket: "THREE_TO_FOUR_DAYS", from: 3, to: 4 },
  { bucket: "FOUR_TO_FIVE_DAYS", from: 4, to: 5 },
  { bucket: "FIVE_TO_SIX_DAYS", from: 5, to: 6 },
  { bucket: "SIX_TO_SEVEN_DAYS", from: 6, to: 7 },
  { bucket: "SEVEN_TO_EIGHT_DAYS", from: 7, to: 8 },
  { bucket: "EIGHT_TO_NINE_DAYS", from: 8, to: 9 },
  { bucket: "NINE_TO_TEN_DAYS", from: 9, to: 10 },
  { bucket: "TEN_TO_ELEVEN_DAYS", from: 10, to: 11 },
  { bucket: "ELEVEN_TO_TWELVE_DAYS", from: 11, to: 12 },
  { bucket: "TWELVE_TO_THIRTEEN_DAYS", from: 12, to: 13 },
  { bucket: "THIRTEEN_TO_FOURTEEN_DAYS", from: 13, to: 14 },
  { bucket: "FOURTEEN_TO_TWENTY_ONE_DAYS", from: 14, to: 21 },
  { bucket: "TWENTY_ONE_TO_THIRTY_DAYS", from: 21, to: 30 },
  { bucket: "THIRTY_TO_FORTY_FIVE_DAYS", from: 30, to: 45 },
  { bucket: "FORTY_FIVE_TO_SIXTY_DAYS", from: 45, to: 60 },
  { bucket: "SIXTY_TO_NINETY_DAYS", from: 60, to: 90 },
];

// ── Regras de valor (item 74) ────────────────────────────────────────

const VALUE_RULE_OPERATIONS = ["ADD", "MULTIPLY", "SET"] as const;
const VALUE_RULE_DEVICES = ["MOBILE", "DESKTOP", "TABLET"] as const;
const GEO_MATCH_TYPES = ["ANY", "LOCATION_OF_PRESENCE"] as const;
const RULE_DIMENSIONS = ["GEO_LOCATION", "DEVICE", "AUDIENCE"] as const;
type RuleDimension = (typeof RULE_DIMENSIONS)[number];
/** Conjunto por campanha: só Pesquisa e Display (ConversionValueRuleSetError.VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE). */
const VALUE_RULE_CAMPAIGN_CHANNELS = new Set(["SEARCH", "DISPLAY"]);

const GEO_RN = /^geoTargetConstants\/\d+$/;
const customerScoped = (kind: string) => new RegExp(`^customers/\\d+/${kind}/\\d+$`);
const USER_LIST_RN = customerScoped("userLists");
const USER_INTEREST_RN = customerScoped("userInterests");
const CAMPAIGN_RN = customerScoped("campaigns");

const VALUE_RULE_SELECT = `conversion_value_rule.id, conversion_value_rule.resource_name, conversion_value_rule.status,
       conversion_value_rule.owner_customer, conversion_value_rule.action.operation, conversion_value_rule.action.value,
       conversion_value_rule.geo_location_condition.geo_target_constants,
       conversion_value_rule.geo_location_condition.geo_match_type,
       conversion_value_rule.geo_location_condition.excluded_geo_target_constants,
       conversion_value_rule.geo_location_condition.excluded_geo_match_type,
       conversion_value_rule.device_condition.device_types,
       conversion_value_rule.audience_condition.user_lists,
       conversion_value_rule.audience_condition.user_interests,
       conversion_value_rule.itinerary_condition.advance_booking_window.min_days,
       conversion_value_rule.itinerary_condition.advance_booking_window.max_days,
       conversion_value_rule.itinerary_condition.travel_length.min_nights,
       conversion_value_rule.itinerary_condition.travel_length.max_nights`;

const VALUE_RULE_SET_QUERY = `SELECT conversion_value_rule_set.id, conversion_value_rule_set.resource_name,
       conversion_value_rule_set.status, conversion_value_rule_set.owner_customer,
       conversion_value_rule_set.dimensions, conversion_value_rule_set.attachment_type,
       conversion_value_rule_set.campaign, conversion_value_rule_set.conversion_value_rules,
       conversion_value_rule_set.conversion_action_categories
FROM conversion_value_rule_set`;

interface ValueRule {
  id: string;
  resourceName: string;
  status: string;
  owner: string;
  operation: string;
  value: number;
  geo: string[];
  geoMatch: string;
  excludedGeo: string[];
  excludedGeoMatch: string;
  devices: string[];
  userLists: string[];
  userInterests: string[];
  itinerary: boolean;
}

interface ValueRuleSet {
  id: string;
  resourceName: string;
  status: string;
  owner: string;
  dimensions: string[];
  attachmentType: string;
  campaign: string;
  rules: string[];
  categories: string[];
}

function parseValueRule(row: Row): ValueRule {
  const rule = obj(row.conversionValueRule);
  const action = obj(rule.action);
  const geo = obj(rule.geoLocationCondition);
  const itinerary = obj(rule.itineraryCondition);
  return {
    id: String(rule.id ?? lastSegment(rule.resourceName)),
    resourceName: String(rule.resourceName ?? ""),
    status: String(rule.status ?? ""),
    owner: String(rule.ownerCustomer ?? ""),
    operation: String(action.operation ?? ""),
    value: num(action.value),
    geo: strings(geo.geoTargetConstants),
    geoMatch: String(geo.geoMatchType ?? ""),
    excludedGeo: strings(geo.excludedGeoTargetConstants),
    excludedGeoMatch: String(geo.excludedGeoMatchType ?? ""),
    devices: strings(obj(rule.deviceCondition).deviceTypes),
    userLists: strings(obj(rule.audienceCondition).userLists),
    userInterests: strings(obj(rule.audienceCondition).userInterests),
    itinerary: Object.keys(obj(itinerary.advanceBookingWindow)).length + Object.keys(obj(itinerary.travelLength)).length > 0,
  };
}

function parseValueRuleSet(row: Row): ValueRuleSet {
  const set = obj(row.conversionValueRuleSet);
  return {
    id: String(set.id ?? lastSegment(set.resourceName)),
    resourceName: String(set.resourceName ?? ""),
    status: String(set.status ?? ""),
    owner: String(set.ownerCustomer ?? ""),
    dimensions: strings(set.dimensions),
    attachmentType: String(set.attachmentType ?? ""),
    campaign: String(set.campaign ?? ""),
    rules: strings(set.conversionValueRules),
    categories: strings(set.conversionActionCategories),
  };
}

function ruleDimensions(rule: Pick<ValueRule, "geo" | "excludedGeo" | "devices" | "userLists" | "userInterests">): RuleDimension[] {
  const dims: RuleDimension[] = [];
  if (rule.geo.length || rule.excludedGeo.length) dims.push("GEO_LOCATION");
  if (rule.devices.length) dims.push("DEVICE");
  if (rule.userLists.length || rule.userInterests.length) dims.push("AUDIENCE");
  return dims;
}

/**
 * Assinatura das condições: duas regras com a mesma assinatura no conjunto conflitam. O tipo de
 * correspondência dos locais (geoMatch/excludedGeoMatch) fica de fora de propósito — mesmos locais com
 * outra correspondência ainda são a mesma regra; a diferença é reportada por ruleDifferences.
 */
function conditionSignature(rule: Pick<ValueRule, "geo" | "excludedGeo" | "devices" | "userLists" | "userInterests">): string {
  const sorted = (values: string[]) => [...values].sort().join(",");
  return [sorted(rule.geo), sorted(rule.excludedGeo), sorted(rule.devices), sorted(rule.userLists), sorted(rule.userInterests)].join("|");
}

/**
 * O que separa uma regra existente (mesma assinatura de condições) do pedido: ação, status e tipo de
 * correspondência dos locais. Lista vazia = o pedido já está aplicado (no-op). Cada item traz o parâmetro
 * de update_conversion_value_rule que leva a regra ao pedido.
 */
function ruleDifferences(
  existing: ValueRule,
  wanted: { operation: string; value: number; geoMatch: string; excludedGeoMatch: string }
): Array<{ what: string; fix: string }> {
  const diffs: Array<{ what: string; fix: string }> = [];
  if (existing.operation !== wanted.operation || existing.value !== wanted.value) {
    diffs.push({
      what: `ação: a regra faz "${describeAction(existing.operation, existing.value)}"; o pedido é "${describeAction(wanted.operation, wanted.value)}"`,
      fix: `operation: "${wanted.operation}", value: ${wanted.value}`,
    });
  }
  if (existing.status !== "ENABLED") {
    diffs.push({ what: `status: a regra está ${existing.status} (a tool nunca reativa sozinha)`, fix: 'status: "ENABLED"' });
  }
  const match = (value: string) => value || "UNSPECIFIED";
  if (wanted.geoMatch && match(existing.geoMatch) !== wanted.geoMatch) {
    diffs.push({
      what: `correspondência dos locais incluídos: a regra usa ${match(existing.geoMatch)}; o pedido é ${wanted.geoMatch}`,
      fix: `geoMatchType: "${wanted.geoMatch}"`,
    });
  }
  if (wanted.excludedGeoMatch && match(existing.excludedGeoMatch) !== wanted.excludedGeoMatch) {
    diffs.push({
      what: `correspondência dos locais excluídos: a regra usa ${match(existing.excludedGeoMatch)}; o pedido é ${wanted.excludedGeoMatch}`,
      fix: `excludedGeoMatchType: "${wanted.excludedGeoMatch}"`,
    });
  }
  return diffs;
}

/** Faixas do ValueRuleAction (guia "Conversion value rules"): ADD e SET > 0; MULTIPLY entre 0,5 e 10. */
function valueRangeError(operation: string, value: number): string | null {
  if (!Number.isFinite(value)) return `value inválido: ${value}.`;
  if (operation === "MULTIPLY" && (value < 0.5 || value > 10)) {
    return `MULTIPLY exige value entre 0,5 e 10 (recebido ${value}).`;
  }
  if ((operation === "ADD" || operation === "SET") && value <= 0) {
    return `${operation} exige value maior que 0 (recebido ${value}).`;
  }
  return null;
}

function describeAction(operation: string, value: number): string {
  if (operation === "ADD") return `somar ${brl(value)} ao valor da conversão`;
  if (operation === "MULTIPLY") return `multiplicar o valor da conversão por ${value}`;
  if (operation === "SET") return `definir o valor da conversão como ${brl(value)}`;
  return `${operation} ${value}`;
}

interface NameMaps {
  geo: Map<string, string>;
  userLists: Map<string, string>;
  userInterests: Map<string, string>;
  campaigns: Map<string, string>;
}

function describeConditions(rule: ValueRule, names: NameMaps): string[] {
  const label = (map: Map<string, string>, rn: string) => {
    const name = map.get(rn);
    return name ? `${name} (${lastSegment(rn)})` : rn;
  };
  const parts: string[] = [];
  if (rule.geo.length) parts.push(`local: ${rule.geo.map((g) => label(names.geo, g)).join(", ")} [${rule.geoMatch || "?"}]`);
  if (rule.excludedGeo.length) parts.push(`exceto local: ${rule.excludedGeo.map((g) => label(names.geo, g)).join(", ")} [${rule.excludedGeoMatch || "?"}]`);
  if (rule.devices.length) parts.push(`dispositivo: ${rule.devices.join(", ")}`);
  if (rule.userLists.length) parts.push(`lista de público: ${rule.userLists.map((u) => label(names.userLists, u)).join(", ")}`);
  if (rule.userInterests.length) parts.push(`interesse: ${rule.userInterests.map((u) => label(names.userInterests, u)).join(", ")}`);
  if (rule.itinerary) parts.push("itinerário de viagem (recurso de allowlist)");
  return parts;
}

/** Nomes de locais, listas, interesses e campanhas citados nas regras (só resource names bem formados). */
async function resolveRuleNames(client: GoogleAdsClient, customerId: string, rules: ValueRule[], sets: ValueRuleSet[]): Promise<NameMaps> {
  const names: NameMaps = { geo: new Map(), userLists: new Map(), userInterests: new Map(), campaigns: new Map() };
  const geo = [...new Set(rules.flatMap((r) => [...r.geo, ...r.excludedGeo]))].filter((rn) => GEO_RN.test(rn));
  const lists = [...new Set(rules.flatMap((r) => r.userLists))].filter((rn) => USER_LIST_RN.test(rn));
  const interests = [...new Set(rules.flatMap((r) => r.userInterests))].filter((rn) => USER_INTEREST_RN.test(rn));
  const campaigns = [...new Set(sets.map((s) => s.campaign))].filter((rn) => CAMPAIGN_RN.test(rn));
  if (geo.length) {
    const rows = await client.searchStream(customerId,
      `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name
       FROM geo_target_constant
       WHERE geo_target_constant.resource_name IN (${inList(geo)})`);
    for (const row of rows) {
      const g = obj(row.geoTargetConstant);
      names.geo.set(String(g.resourceName), String(g.canonicalName ?? ""));
    }
  }
  if (lists.length) {
    const rows = await client.searchStream(customerId,
      `SELECT user_list.resource_name, user_list.name FROM user_list WHERE user_list.resource_name IN (${inList(lists)})`);
    for (const row of rows) names.userLists.set(String(obj(row.userList).resourceName), String(obj(row.userList).name ?? ""));
  }
  if (interests.length) {
    const rows = await client.searchStream(customerId,
      `SELECT user_interest.resource_name, user_interest.name FROM user_interest WHERE user_interest.resource_name IN (${inList(interests)})`);
    for (const row of rows) names.userInterests.set(String(obj(row.userInterest).resourceName), String(obj(row.userInterest).name ?? ""));
  }
  if (campaigns.length) {
    const rows = await client.searchStream(customerId,
      `SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.resource_name IN (${inList(campaigns)})`);
    for (const row of rows) names.campaigns.set(String(obj(row.campaign).resourceName), String(obj(row.campaign).name ?? ""));
  }
  return names;
}

/*
 * Dicas de erro. O GoogleAdsClient monta a mensagem só com errors[].message (o errorCode fica de
 * fora), e essa mensagem é o texto em inglês do comentário do enum no proto v25. Por isso cada dica
 * casa pelo TEXTO do proto (errors/conversion_value_rule_error.proto, conversion_value_rule_set_error.proto,
 * database_error.proto, asset_error.proto, policy_finding_error.proto); o nome do enum fica na
 * alternância só como reserva. `\s+` entre palavras: o comentário do proto quebra linha.
 */
const VALUE_RULE_ERROR_HINTS: Array<[RegExp, string]> = [
  // CONFLICTING_CONDITIONS / CONFLICTING_VALUE_RULE_CONDITIONS
  [/CONFLICTING_(VALUE_RULE_)?CONDITIONS|conflicting\s+conditions/i,
    "Outra regra do mesmo conjunto tem condição conflitante. Veja com list_conversion_value_rules e altere a existente com update_conversion_value_rule."],
  // CONDITION_TYPE_NOT_ALLOWED / CONDITION_NOT_ALLOWED
  [/CONDITION(_TYPE)?_NOT_ALLOWED|not\s+specified\s+in\s+the\s+dimensions|not\s+allowed\s+by\s+the\s+value\s+rule\s+set/i,
    "A condição da regra não está nas dimensões do conjunto (máximo 2 dimensões por conjunto)."],
  [/VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE|does\s+not\s+support\s+value\s+rules/i,
    "Conjunto por campanha só em campanhas de Pesquisa ou Display — para as demais use o conjunto da conta (sem campaignId)."],
  [/CANNOT_REMOVE_IF_INCLUDED_IN_VALUE_RULE_SET|still\s+included\s+in\s+some\s+value\s+rule\s+set/i,
    "A regra ainda está num conjunto: tire-a do conjunto antes (update_conversion_value_rule com status REMOVED faz isso numa operação só)."],
  // CANNOT_PAUSE_UNLESS_VALUE_RULE_SET_IS_PAUSED / CANNOT_PAUSE_UNLESS_ALL_VALUE_RULES_ARE_PAUSED /
  // SHOULD_PAUSE_WHEN_ALL_VALUE_RULES_ARE_PAUSED
  [/CANNOT_PAUSE_UNLESS|SHOULD_PAUSE_WHEN_ALL|requires\s+pausing\s+the\s+value\s+rule\s+set|must\s+be\s+paused\s+in\s+the\s+same\s+command|the\s+value\s+rule\s+set\s+must\s+be\s+paused/i,
    "A API exige que regra e conjunto sejam pausados juntos quando é a última regra ativa do conjunto."],
  [/DIMENSIONS_UPDATE_ONLY_ALLOW_APPEND|replace\/remove\s+some\s+existing\s+elements\s+in\s+the\s+dimensions/i,
    "As dimensões de um conjunto só podem ser acrescentadas, nunca trocadas ou removidas."],
  // INVALID_GEO_TARGET_CONSTANT / UNTARGETABLE_GEO_TARGET / CONFLICTING_INCLUDED_AND_EXCLUDED_GEO_TARGET
  [/INVALID_GEO_TARGET_CONSTANT|UNTARGETABLE_GEO_TARGET|CONFLICTING_INCLUDED_AND_EXCLUDED_GEO_TARGET|invalid\s+geo\s+target\s+constant|untargetable\s+geo\s+target|conflicting\s+included\s+and\s+excluded\s+geo\s+targets/i,
    "Confira os locais (list_geo_targets): inexistente, não segmentável ou incluído e excluído ao mesmo tempo."],
  // INVALID_AUDIENCE_USER_LIST / INACCESSIBLE_USER_LIST / INVALID_AUDIENCE_USER_INTEREST
  [/INVALID_AUDIENCE_USER_LIST|INACCESSIBLE_USER_LIST|INVALID_AUDIENCE_USER_INTEREST|invalid\s+user\s+list|inaccessible\s+user\s+list|invalid\s+user_interest/i,
    "Lista de público ou interesse inexistente ou inacessível nesta conta (list_remarketing_lists)."],
  // DatabaseError.DATA_CONSTRAINT_VIOLATION — o guia de regras de valor cita este erro para regra em dois conjuntos.
  [/DATA_CONSTRAINT_VIOLATION|request\s+conflicted\s+with\s+existing\s+data/i,
    "Conflito com dados existentes — em regras de valor, costuma ser a regra já estar em outro conjunto ENABLED/PAUSED (cada regra só pode estar em um conjunto por vez)."],
];

// ── Lift (item 95) ───────────────────────────────────────────────────

const CONVERSION_LIFT_METRICS = [
  "incremental_conversions", "incremental_conversions_p90_lower_bound", "incremental_conversions_p90_upper_bound",
  "incremental_conversions_p_value",
  "incremental_conversion_value", "incremental_conversion_value_p90_lower_bound", "incremental_conversion_value_p90_upper_bound",
  "incremental_conversion_value_p_value",
  "incremental_conversion_value_per_cost", "incremental_conversion_value_per_cost_p90_lower_bound",
  "incremental_conversion_value_per_cost_p90_upper_bound",
  "relative_conversion_lift", "relative_conversion_lift_p90_lower_bound", "relative_conversion_lift_p90_upper_bound",
  "relative_conversion_value_lift", "relative_conversion_value_lift_p90_lower_bound", "relative_conversion_value_lift_p90_upper_bound",
  "cost_per_incremental_conversion", "cost_per_incremental_conversion_p90_lower_bound", "cost_per_incremental_conversion_p90_upper_bound",
  "conversion_lift_baseline_conversions", "conversion_lift_exposed_conversions",
  "conversion_lift_baseline_conversion_value", "conversion_lift_exposed_conversion_value",
];
/** Winner score só combina com os segmentos conversion_lift_* e experiment_arm. */
const CONVERSION_LIFT_WINNER_METRICS = [
  "incremental_conversions_winner_score", "incremental_conversion_value_winner_score",
  "incremental_conversion_value_per_cost_winner_score", "cost_per_incremental_conversion_winner_score",
];
const BRAND_LIFT_METRICS = [
  "absolute_brand_lift", "absolute_brand_lift_p90_lower_bound", "absolute_brand_lift_p90_upper_bound", "absolute_brand_lift_p_value",
  "relative_brand_lift", "relative_brand_lift_p90_lower_bound", "relative_brand_lift_p90_upper_bound",
  "headroom_brand_lift", "headroom_brand_lift_p90_lower_bound", "headroom_brand_lift_p90_upper_bound",
  "brand_lift_baseline_positive_response_rate", "brand_lift_exposed_positive_response_rate",
  "brand_lift_total_responses", "brand_lift_responses_exposed", "brand_lift_responses_suppressed",
  "fractional_lifted_cookies", "fractional_lifted_cookies_p90_lower_bound", "fractional_lifted_cookies_p90_upper_bound",
  "cost_per_lifted_cookie", "cost_per_lifted_cookie_p90_lower_bound", "cost_per_lifted_cookie_p90_upper_bound",
];
const CONVERSION_LIFT_PERIOD_SEGMENTS = [
  "conversion_lift_start_date", "conversion_lift_end_date",
  "conversion_lift_conversion_category", "conversion_lift_included_conversion_action_types",
];
const CONVERSION_LIFT_BREAKDOWNS: Record<string, string[]> = {
  NONE: [],
  CONVERSION_ACTION: ["conversion_action", "conversion_action_name"],
  AGE_RANGE: ["age_range"],
  GENDER: ["gender"],
  DEVICE: ["device"],
  COUNTRY: ["country", "country_localized_name"],
  EXPERIMENT_ARM: ["experiment_arm"],
};
/** Brand Lift por dimensão: recurso próprio (lift_measurement_<dim>) e o campo da dimensão. */
const BRAND_LIFT_BREAKDOWNS: Record<string, { resource: string; fields: string[] }> = {
  NONE: { resource: "lift_measurement_config", fields: ["name"] },
  CAMPAIGN: { resource: "lift_measurement_campaign", fields: ["campaign"] },
  AGE_RANGE: { resource: "lift_measurement_age_range", fields: ["campaign", "age_range"] },
  GENDER: { resource: "lift_measurement_gender", fields: ["campaign", "gender"] },
  DEVICE: { resource: "lift_measurement_device", fields: ["campaign", "device"] },
  VIDEO: { resource: "lift_measurement_video", fields: ["campaign", "video"] },
};

/** Leitura em linguagem simples de um resultado com intervalo de 90% e p-valor. */
function liftVerdict(lower: number | undefined, upper: number | undefined, pValue: number | undefined): string {
  if (lower === undefined || upper === undefined) return "sem intervalo de confiança (dados insuficientes ou estudo em andamento)";
  if (lower > 0) return `positivo e significativo a 90% (intervalo ${lower} a ${upper}${pValue !== undefined ? `, p=${pValue}` : ""})`;
  if (upper < 0) return `negativo e significativo a 90% (intervalo ${lower} a ${upper}${pValue !== undefined ? `, p=${pValue}` : ""})`;
  return `inconclusivo — o intervalo de 90% (${lower} a ${upper}) inclui zero${pValue !== undefined ? `, p=${pValue}` : ""}`;
}

const maybe = (value: unknown): number | undefined => (value === undefined || value === null || value === "" ? undefined : Number(value));

// ── Formulários de lead (item extra) ────────────────────────────────

/** LeadFormCallToActionType (v25). */
const LEAD_FORM_CTA = [
  "LEARN_MORE", "GET_QUOTE", "APPLY_NOW", "SIGN_UP", "CONTACT_US", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW",
  "GET_OFFER", "REGISTER", "GET_INFO", "REQUEST_DEMO", "JOIN_NOW", "GET_STARTED",
] as const;
/** LeadFormPostSubmitCallToActionType (v25). */
const LEAD_FORM_POST_SUBMIT_CTA = ["VISIT_SITE", "DOWNLOAD", "LEARN_MORE", "SHOP_NOW"] as const;
/** LeadFormFieldUserInputType (v25): dados de contato (< 1000). */
const LEAD_FORM_CONTACT_FIELDS = [
  "FULL_NAME", "EMAIL", "PHONE_NUMBER", "POSTAL_CODE", "STREET_ADDRESS", "CITY", "REGION", "COUNTRY", "WORK_EMAIL",
  "COMPANY_NAME", "WORK_PHONE", "JOB_TITLE", "GOVERNMENT_ISSUED_ID_CPF_BR", "GOVERNMENT_ISSUED_ID_DNI_AR",
  "GOVERNMENT_ISSUED_ID_DNI_PE", "GOVERNMENT_ISSUED_ID_RUT_CL", "GOVERNMENT_ISSUED_ID_CC_CO", "GOVERNMENT_ISSUED_ID_CI_EC",
  "GOVERNMENT_ISSUED_ID_RFC_MX", "FIRST_NAME", "LAST_NAME",
];
/** LeadFormFieldUserInputType (v25): perguntas pré-aprovadas (>= 1001), limite de 5 e sem mistura com perguntas personalizadas. */
const LEAD_FORM_QUALIFYING_QUESTIONS = [
  "VEHICLE_MODEL", "VEHICLE_TYPE", "PREFERRED_DEALERSHIP", "VEHICLE_PURCHASE_TIMELINE", "VEHICLE_OWNERSHIP",
  "VEHICLE_PAYMENT_TYPE", "VEHICLE_CONDITION", "COMPANY_SIZE", "ANNUAL_SALES", "YEARS_IN_BUSINESS", "JOB_DEPARTMENT",
  "JOB_ROLE", ...Array.from({ length: 48 }, (_, i) => `OVER_${18 + i}_AGE`), "EDUCATION_PROGRAM", "EDUCATION_COURSE",
  "PRODUCT", "SERVICE", "OFFER", "CATEGORY", "PREFERRED_CONTACT_METHOD", "PREFERRED_LOCATION", "PREFERRED_CONTACT_TIME",
  "PURCHASE_TIMELINE", "YEARS_OF_EXPERIENCE", "JOB_INDUSTRY", "LEVEL_OF_EDUCATION", "PROPERTY_TYPE", "REALTOR_HELP_GOAL",
  "PROPERTY_COMMUNITY", "PRICE_RANGE", "NUMBER_OF_BEDROOMS", "FURNISHED_PROPERTY", "PETS_ALLOWED_PROPERTY",
  "NEXT_PLANNED_PURCHASE", "EVENT_SIGNUP_INTEREST", "PREFERRED_SHOPPING_PLACES", "FAVORITE_BRAND",
  "TRANSPORTATION_COMMERCIAL_LICENSE_TYPE", "EVENT_BOOKING_INTEREST", "DESTINATION_COUNTRY", "DESTINATION_CITY",
  "DEPARTURE_COUNTRY", "DEPARTURE_CITY", "DEPARTURE_DATE", "RETURN_DATE", "NUMBER_OF_TRAVELERS", "TRAVEL_BUDGET",
  "TRAVEL_ACCOMMODATION",
];
const MAX_QUALIFYING_QUESTIONS = 5;
const MAX_CUSTOM_QUESTIONS = 5;
const MIN_CHOICES = 2;
const MAX_CHOICES = 12;
/** CustomLeadFormSubmissionField.question_text: no máximo 300 caracteres (proto v25). */
const MAX_CUSTOM_QUESTION_CHARS = 300;
/** Leads ficam 60 dias no Google Ads (Central de Ajuda "About lead form assets"). */
const LEAD_RETENTION_DAYS = 60;
/** Esquema de payload do webhook usado no exemplo oficial add-lead-form-asset. */
const DEFAULT_WEBHOOK_SCHEMA_VERSION = 3;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** Casadas pelo texto do proto v25 (errors/asset_error.proto, policy_finding_error.proto) — ver VALUE_RULE_ERROR_HINTS. */
const LEAD_FORM_ERROR_HINTS: Array<[RegExp, string]> = [
  [/LEAD_FORM_MISSING_AGREEMENT|Terms\s+of\s+Service\s+have\s+been\s+agreed/i,
    "A conta não aceitou os termos de formulários de lead. Aceite-os na interface do Google Ads (o campo é somente leitura na API)."],
  [/LEAD_FORM_INVALID_FIELDS_COMBINATION|invalid\s+combination\s+of\s+input\s+fields/i,
    "Combinação de campos recusada (ex.: FULL_NAME junto com FIRST_NAME/LAST_NAME)."],
  [/LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED|qualifying\s+questions\s+cannot\s+be\s+in\s+the\s+same\s+Lead\s+Form/i,
    "Perguntas pré-aprovadas (inputType de qualificação) não podem ficar no mesmo formulário que perguntas personalizadas."],
  [/LEAD_FORM_LOCATION_ANSWER_TYPE_DISALLOWED|disallowed\s+to\s+use\s+`?LOCATION`?\s+answer\s+type/i,
    "Resposta do tipo local não é permitida neste formulário."],
  // DUPLICATE_ASSET_NAME / NAME_CONFLICT_FOR_ASSET_TYPE
  [/DUPLICATE_ASSET_NAME|NAME_CONFLICT_FOR_ASSET_TYPE|asset\s+name\s+is\s+duplicated|unique\s+name\s+is\s+required/i,
    "Já existe um asset com esse nome — escolha outro name."],
  // PolicyFindingError.POLICY_FINDING ("...since the policy summary includes policy topics of type PROHIBITED") /
  // PolicyViolationError.POLICY_ERROR ("A policy was violated...")
  [/POLICY_FINDING|POLICY_ERROR|policy\s+summary\s+includes|policy\s+was\s+violated/i,
    "Recusado por política: confira texto, URL de privacidade e a elegibilidade do vertical para formulários de lead."],
];

function maskLeadValue(fieldType: string, value: string): string {
  if (!value) return value;
  if (/EMAIL/.test(fieldType) && value.includes("@")) {
    const [user, domain] = value.split("@");
    return `${user.slice(0, 1)}***@${domain}`;
  }
  if (/PHONE/.test(fieldType)) return `***${value.replace(/\D/g, "").slice(-2)}`;
  return `${value.slice(0, 1)}***`;
}

function leadDateClause(dateRange: { since: string; until: string } | undefined, days: number | undefined): { clause: string; label: string } | { error: string } {
  const field = "lead_form_submission_data.submission_date_time";
  if (dateRange && (dateRange.since || dateRange.until)) {
    if (!ISO_DATE.test(dateRange.since ?? "") || !ISO_DATE.test(dateRange.until ?? "")) {
      return { error: `dateRange inválido — use since e until em YYYY-MM-DD (recebido ${dateRange.since} → ${dateRange.until}). Nada foi consultado.` };
    }
    if (dateRange.since > dateRange.until) return { error: `dateRange invertido: ${dateRange.since} é depois de ${dateRange.until}. Nada foi consultado.` };
    return {
      clause: `${field} >= '${dateRange.since} 00:00:00' AND ${field} <= '${dateRange.until} 23:59:59'`,
      label: `${dateRange.since} a ${dateRange.until}`,
    };
  }
  const n = days ?? 30;
  if (!Number.isInteger(n) || n < 1 || n > LEAD_RETENTION_DAYS) {
    return { error: `days inválido: ${days}. Use um inteiro de 1 a ${LEAD_RETENTION_DAYS} — o Google Ads guarda os leads por ${LEAD_RETENTION_DAYS} dias.` };
  }
  const since = new Date();
  since.setDate(since.getDate() - n);
  const today = new Date();
  return {
    clause: `${field} >= '${localIsoDate(since)} 00:00:00' AND ${field} <= '${localIsoDate(today)} 23:59:59'`,
    label: `últimos ${n} dias`,
  };
}

const leadFieldSchema = z.object({
  inputType: z.string().describe("LeadFormFieldUserInputType: FULL_NAME, EMAIL, PHONE_NUMBER, ... ou pergunta pré-aprovada (ex.: PREFERRED_CONTACT_TIME)."),
  answers: z.array(z.string()).optional().describe("Só para perguntas pré-aprovadas: 2 a 12 opções de resposta única. Sem answers = texto livre."),
});
const customQuestionSchema = z.object({
  question: z.string().describe("Texto da pergunta personalizada (até 300 caracteres)."),
  answers: z.array(z.string()).optional().describe("2 a 12 opções de resposta única. Sem answers = texto livre."),
});

function parseList<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): { items: Array<z.infer<T>> } | { error: string } {
  const parsed = z.array(schema).safeParse(ensureArray(value));
  if (!parsed.success) {
    return { error: `${label} inválido: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(raiz)"} ${i.message}`).join("; ")}. Nada foi enviado.` };
  }
  return { items: parsed.data };
}

// ══════════════════════════════════════════════════════════════════════

export function registerConversionsReportingTools(ctx: ToolContext): void {
  // ── get_conversions_by_action ──────────────────────────────────────

  ctx.mcp.registerTool(
    "get_conversions_by_action",
    {
      description: [
        "Detalha as conversões por AÇÃO de conversão (e opcionalmente por campanha × ação).",
        "Mostra o que alimenta a coluna Conversões (ações primárias, usadas nos lances) e o que só entra em",
        "Todas as conversões (ações secundárias), com valor e conversões view-through de cada ação.",
        "Use antes de julgar CPA/ROAS: uma ação secundária inflando 'Todas as conversões' ou uma ação errada",
        "como primária muda a leitura. Filtros: campaignId, category (ex.: PURCHASE, SUBMIT_LEAD_FORM).",
        "includeSecondary=false mostra só as ações que entram na coluna Conversões.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        category: conversionCategorySchema.optional().describe("Só ações desta categoria (LEAD vira SUBMIT_LEAD_FORM)."),
        includeSecondary: z.boolean().optional().describe("true (padrão) = inclui ações secundárias. false = só as da coluna Conversões."),
        breakdown: z.enum(["action", "campaign"]).optional().describe("action (padrão) = uma linha por ação; campaign = campanha × ação."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, category, includeSecondary, breakdown, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) {
        return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi consultado.`);
      }
      const date = dateClauseOrError(dateRange, days);
      if ("error" in date) return fail(date.error);
      const resolvedCategory = category ? resolveEnumAlias(category, CONVERSION_CATEGORY_ALIASES) : undefined;
      const client = ctx.getClient();

      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, segments.conversion_action, segments.conversion_action_name,
                segments.conversion_action_category, metrics.conversions, metrics.conversions_value,
                metrics.all_conversions, metrics.all_conversions_value, metrics.view_through_conversions
         FROM campaign
         WHERE ${date.clause}
           AND campaign.status != 'REMOVED'${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}${resolvedCategory ? `
           AND segments.conversion_action_category = '${resolvedCategory}'` : ""}`);
      // Configuração de cada ação (inclusive removidas, que ainda podem ter conversões no período).
      const actionRows = await client.searchStream(customerId,
        `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status,
                conversion_action.type, conversion_action.origin, conversion_action.category,
                conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric,
                conversion_action.owner_customer
         FROM conversion_action`);
      // Chave pelo ID: ações da MCC (acompanhamento entre contas) têm outro customer no resource name.
      const config = new Map<string, Row>();
      for (const row of actionRows) {
        const action = obj(row.conversionAction);
        config.set(lastSegment(action.resourceName), action);
      }

      interface Agg {
        conversion_action_id: string;
        conversion_action: string;
        category: string;
        status: string | null;
        primary_for_goal: boolean | null;
        include_in_conversions_metric: boolean | null;
        in_conversions_column: boolean;
        campaign_id?: string;
        campaign?: string;
        conversions: number;
        conversions_value: number;
        all_conversions: number;
        all_conversions_value: number;
        secondary_conversions: number;
        view_through_conversions: number;
        campaigns: Set<string>;
      }
      const groups = new Map<string, Agg>();
      for (const row of rows) {
        const seg = obj(row.segments);
        const m = obj(row.metrics);
        const camp = obj(row.campaign);
        const actionRn = String(seg.conversionAction ?? "");
        const cfg = config.get(lastSegment(actionRn));
        const key = breakdown === "campaign" ? `${camp.id}|${actionRn}` : actionRn;
        const agg = groups.get(key) ?? {
          conversion_action_id: lastSegment(actionRn),
          conversion_action: String(seg.conversionActionName ?? cfg?.name ?? actionRn),
          category: String(seg.conversionActionCategory ?? cfg?.category ?? ""),
          status: cfg ? String(cfg.status ?? "") : null,
          primary_for_goal: cfg && cfg.primaryForGoal !== undefined ? Boolean(cfg.primaryForGoal) : null,
          include_in_conversions_metric: cfg && cfg.includeInConversionsMetric !== undefined ? Boolean(cfg.includeInConversionsMetric) : null,
          in_conversions_column: false,
          ...(breakdown === "campaign" ? { campaign_id: String(camp.id ?? ""), campaign: String(camp.name ?? "") } : {}),
          conversions: 0, conversions_value: 0, all_conversions: 0, all_conversions_value: 0,
          secondary_conversions: 0, view_through_conversions: 0, campaigns: new Set<string>(),
        };
        agg.conversions += num(m.conversions);
        agg.conversions_value += num(m.conversionsValue);
        agg.all_conversions += num(m.allConversions);
        agg.all_conversions_value += num(m.allConversionsValue);
        agg.view_through_conversions += num(m.viewThroughConversions);
        agg.campaigns.add(String(camp.id ?? ""));
        groups.set(key, agg);
      }

      const all = [...groups.values()].map((agg) => {
        // O observado manda: com conversões em Todas e zero na coluna Conversões, a ação está fora das metas
        // (secundária ou meta da campanha). Só sem nenhuma conversão vale a configuração da ação.
        agg.in_conversions_column = agg.conversions > 0
          ? true
          : agg.all_conversions > 0 ? false : agg.include_in_conversions_metric === true;
        agg.secondary_conversions = Math.max(0, agg.all_conversions - agg.conversions);
        return agg;
      });
      const kept = includeSecondary === false ? all.filter((a) => a.in_conversions_column) : all;
      kept.sort((a, b) => b.all_conversions - a.all_conversions || b.conversions - a.conversions);
      const out: Row[] = kept.map(({ campaigns, ...agg }) => ({
        ...agg,
        conversions: round2(agg.conversions),
        conversions_value: round2(agg.conversions_value),
        all_conversions: round2(agg.all_conversions),
        all_conversions_value: round2(agg.all_conversions_value),
        secondary_conversions: round2(agg.secondary_conversions),
        view_through_conversions: round2(agg.view_through_conversions),
        ...(breakdown === "campaign" ? {} : { campaigns: campaigns.size }),
      }));

      const totals = all.reduce((t, a) => {
        t.conversions += a.conversions;
        t.value += a.conversions_value;
        t.all += a.all_conversions;
        t.allValue += a.all_conversions_value;
        t.viewThrough += a.view_through_conversions;
        return t;
      }, { conversions: 0, value: 0, all: 0, allValue: 0, viewThrough: 0 });
      const secondaryNames = [...new Set(all.filter((a) => !a.in_conversions_column && a.all_conversions > 0).map((a) => a.conversion_action))];
      const header = [
        `Conversões por ação — ${periodLabel(dateRange, days)}${campaignId ? `, campanha ${campaignId}` : ""}` +
          `${resolvedCategory ? `, categoria ${resolvedCategory}` : ""}: ${out.length} linha(s).`,
        `Coluna Conversões (primárias): ${round2(totals.conversions)} — valor ${brl(totals.value)}.`,
        `Todas as conversões: ${round2(totals.all)} — valor ${brl(totals.allValue)} ` +
          `(${pct(totals.conversions, totals.all)}% delas estão na coluna Conversões). View-through: ${round2(totals.viewThrough)}.`,
        secondaryNames.length
          ? `Ações só em Todas as conversões (secundárias ou fora das metas): ${secondaryNames.join(", ")}.`
          : "Nenhuma ação secundária com conversões no período.",
        includeSecondary === false ? "Filtro: só ações da coluna Conversões." : "",
      ].filter(Boolean).join("\n");
      return { content: [text(render(out, format, header))] };
    }
  );

  // ── get_conversion_lag ─────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_conversion_lag",
    {
      description: [
        "Atraso das conversões: quantos dias passam entre a impressão e a conversão (segments.conversion_lag_bucket)",
        "e a comparação dia a dia entre conversões pela data da interação (padrão dos relatórios) e pela data da",
        "conversão (metrics.*_by_conversion_date).",
        "Responde 'quantos dias recentes ainda estão incompletos?' antes de julgar CPA/ROAS de uma semana recente.",
        "Filtros: campaignId, conversionActionId. Período padrão: 90 dias (atraso precisa de janela longa).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe("Dias para trás (use isto OU dateRange). Padrão: 90."),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        conversionActionId: z.string().optional().describe("Só esta ação de conversão (ID de list_conversion_actions)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, conversionActionId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      for (const [label, value] of [["campaignId", campaignId], ["conversionActionId", conversionActionId]] as const) {
        if (value !== undefined && !NUMERIC_ID.test(value)) return fail(`${label} deve ser numérico, recebido "${value}". Nada foi consultado.`);
      }
      const date = dateClauseOrError(dateRange, days, 90);
      if ("error" in date) return fail(date.error);
      const client = ctx.getClient();
      const cid = customerId.replace(/-/g, "");

      let actionName: string | undefined;
      if (conversionActionId) {
        const found = await client.searchStream(customerId,
          `SELECT conversion_action.id, conversion_action.name FROM conversion_action WHERE conversion_action.id = ${conversionActionId}`);
        if (!found.length) return fail(`Ação de conversão ${conversionActionId} não encontrada na conta ${cid}. Veja list_conversion_actions.`);
        actionName = String(obj(found[0].conversionAction).name ?? "");
      }
      // FROM customer não aceita campaign.id; com campanha a consulta sai de FROM campaign.
      const from = campaignId ? "campaign" : "customer";
      const actionSelect = conversionActionId ? ", segments.conversion_action" : "";
      const filters = [
        date.clause,
        campaignId ? `campaign.id = ${campaignId}` : "",
        conversionActionId ? `segments.conversion_action = 'customers/${cid}/conversionActions/${conversionActionId}'` : "",
      ].filter(Boolean).join("\n           AND ");

      const lagRows = await client.searchStream(customerId,
        `SELECT segments.conversion_lag_bucket${actionSelect}, metrics.conversions, metrics.conversions_value,
                metrics.all_conversions
         FROM ${from}
         WHERE ${filters}`);
      const dailyRows = await client.searchStream(customerId,
        `SELECT segments.date${actionSelect}, metrics.conversions, metrics.conversions_by_conversion_date,
                metrics.conversions_value, metrics.conversions_value_by_conversion_date,
                metrics.all_conversions, metrics.all_conversions_by_conversion_date
         FROM ${from}
         WHERE ${filters}
         ORDER BY segments.date`);

      const byBucket = new Map<string, { conversions: number; all: number; value: number }>();
      for (const row of lagRows) {
        const bucket = String(obj(row.segments).conversionLagBucket ?? "UNKNOWN");
        const m = obj(row.metrics);
        const acc = byBucket.get(bucket) ?? { conversions: 0, all: 0, value: 0 };
        acc.conversions += num(m.conversions);
        acc.all += num(m.allConversions);
        acc.value += num(m.conversionsValue);
        byBucket.set(bucket, acc);
      }
      // Só os buckets com faixa conhecida entram na distribuição (UNKNOWN/UNSPECIFIED ficam de fora).
      const known = LAG_BUCKETS.map((b) => byBucket.get(b.bucket)).filter((b): b is { conversions: number; all: number; value: number } => !!b);
      const totalPrimary = known.reduce((s, b) => s + b.conversions, 0);
      const totalAll = known.reduce((s, b) => s + b.all, 0);
      // Ação secundária não tem metrics.conversions: aí a distribuição usa Todas as conversões.
      const basis = totalPrimary > 0 ? "conversions" : "all_conversions";
      const total = basis === "conversions" ? totalPrimary : totalAll;
      let cumulative = 0;
      const thresholds: Record<string, number | null> = { p50: null, p90: null, p95: null };
      const distribution: Row[] = LAG_BUCKETS.filter((b) => byBucket.has(b.bucket)).map((b) => {
        const acc = byBucket.get(b.bucket)!;
        const count = basis === "conversions" ? acc.conversions : acc.all;
        cumulative += count;
        const share = pct(count, total);
        const cumShare = pct(cumulative, total);
        for (const [key, limit] of [["p50", 50], ["p90", 90], ["p95", 95]] as const) {
          if (thresholds[key] === null && cumShare >= limit) thresholds[key] = b.to;
        }
        return {
          lag_bucket: b.bucket,
          days: `${b.from}–${b.to}`,
          conversions: round2(acc.conversions),
          all_conversions: round2(acc.all),
          conversions_value: round2(acc.value),
          share_pct: share,
          cumulative_pct: cumShare,
        };
      });

      const daily: Row[] = [];
      const byDate = new Map<string, Row>();
      for (const row of dailyRows) {
        const day = String(obj(row.segments).date ?? "");
        const m = obj(row.metrics);
        const acc = (byDate.get(day) ?? {
          date: day, conversions_by_interaction_date: 0, conversions_by_conversion_date: 0,
          value_by_interaction_date: 0, value_by_conversion_date: 0,
          all_conversions_by_interaction_date: 0, all_conversions_by_conversion_date: 0,
        }) as Record<string, number | string>;
        acc.conversions_by_interaction_date = num(acc.conversions_by_interaction_date) + num(m.conversions);
        acc.conversions_by_conversion_date = num(acc.conversions_by_conversion_date) + num(m.conversionsByConversionDate);
        acc.value_by_interaction_date = num(acc.value_by_interaction_date) + num(m.conversionsValue);
        acc.value_by_conversion_date = num(acc.value_by_conversion_date) + num(m.conversionsValueByConversionDate);
        acc.all_conversions_by_interaction_date = num(acc.all_conversions_by_interaction_date) + num(m.allConversions);
        acc.all_conversions_by_conversion_date = num(acc.all_conversions_by_conversion_date) + num(m.allConversionsByConversionDate);
        byDate.set(day, acc);
      }
      for (const acc of [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        daily.push(Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, typeof v === "number" ? round2(v) : v])));
      }
      // Últimos 7 dias do CALENDÁRIO da janela (o GAQL omite dias sem conversão: as 7 últimas linhas
      // podem cobrir meses numa conta de lead gen).
      const span = reportWindow(date.clause);
      const recentFrom = span.since && span.since > shiftIsoDate(span.until, -6) ? span.since : shiftIsoDate(span.until, -6);
      const lastDays = daily.filter((row) => String(row.date) >= recentFrom && String(row.date) <= span.until);
      const sum = (rows: Row[], key: string) => round2(rows.reduce((s, r) => s + num(r[key]), 0));
      const recent = {
        from: recentFrom,
        to: span.until,
        calendar_days: daysBetween(recentFrom, span.until) + 1,
        days_with_data: lastDays.length,
        by_interaction_date: sum(lastDays, basis === "conversions" ? "conversions_by_interaction_date" : "all_conversions_by_interaction_date"),
        by_conversion_date: sum(lastDays, basis === "conversions" ? "conversions_by_conversion_date" : "all_conversions_by_conversion_date"),
      };

      const scope = [
        periodLabel(dateRange, days, 90),
        campaignId ? `campanha ${campaignId}` : "conta inteira",
        conversionActionId ? `ação ${actionName || conversionActionId}` : "todas as ações",
      ].join(", ");
      const lines = [`Atraso de conversão — ${scope}.`];
      if (total === 0) {
        lines.push("Sem conversões no período: não há distribuição de atraso para calcular.");
      } else {
        lines.push(
          `Base: ${basis === "conversions" ? "coluna Conversões" : "Todas as conversões (a ação não entra na coluna Conversões)"}, ${round2(total)} conversões.`,
          `Metade das conversões acontece em até ${thresholds.p50} dia(s) após a impressão; 90% em até ${thresholds.p90} dia(s); 95% em até ${thresholds.p95} dia(s).`,
          `Leitura: nos relatórios por data da interação (o padrão), os últimos ~${thresholds.p90} dia(s) ainda vão receber conversões — ` +
            "não julgue CPA/ROAS desse trecho como final; compare períodos fechados ou use as colunas por data da conversão.",
        );
        lines.push(
          `Últimos ${recent.calendar_days} dia(s) do período (${recent.from} a ${recent.to}; ${recent.days_with_data} com conversões): ` +
            `${recent.by_interaction_date} pela data da interação × ${recent.by_conversion_date} pela data da conversão.`
        );
      }
      const header = lines.join("\n");
      const body = { basis, total: round2(total), threshold_days: thresholds, incomplete_recent_days: thresholds.p90, recent_7_days: recent, distribution, daily };
      if (format === "table") {
        return { content: [text(`${header}\n\n${formatAsTable(distribution)}\n\nPor dia:\n${formatAsTable(daily)}`)] };
      }
      if (format === "csv") return { content: [text(formatAsCsv(distribution))] };
      return { content: [text(`${header}\n\n${formatJson(body)}`)] };
    }
  );

  // ── list_conversion_value_rules ────────────────────────────────────

  ctx.mcp.registerTool(
    "list_conversion_value_rules",
    {
      description: [
        "Lista as regras de valor de conversão e os conjuntos de regras (conta inteira ou por campanha).",
        "Para cada conjunto: escopo, dimensões (a primeira é a dimensão primária do relatório), categorias",
        "de conversão e as regras NA ORDEM de avaliação — vale a primeira regra cujas condições casam.",
        "Regras fora de qualquer conjunto não são aplicadas (e nem aparecem na interface).",
        "Nomes de locais, listas de público, interesses e campanhas vêm resolvidos.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeRemoved: z.boolean().optional().describe("true = inclui regras removidas. Padrão: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = ctx.getClient();
      const cid = customerId.replace(/-/g, "");
      const ruleRows = await client.searchStream(customerId,
        `SELECT ${VALUE_RULE_SELECT}
         FROM conversion_value_rule${includeRemoved ? "" : `
         WHERE conversion_value_rule.status != 'REMOVED'`}`);
      const setRows = await client.searchStream(customerId, VALUE_RULE_SET_QUERY);
      const rules = ruleRows.map(parseValueRule);
      const sets = setRows.map(parseValueRuleSet);
      const names = await resolveRuleNames(client, customerId, rules, sets);
      const byResource = new Map(rules.map((rule) => [rule.resourceName, rule]));
      const own = (owner: string) => !owner || owner === `customers/${cid}`;
      const view = (rule: ValueRule) => ({
        rule_id: rule.id,
        status: rule.status,
        conditions: describeConditions(rule, names),
        action: describeAction(rule.operation, rule.value),
        operation: rule.operation,
        value: rule.value,
        ...(own(rule.owner) ? {} : { inherited_from: rule.owner }),
      });

      const inSets = new Set<string>();
      const flat: Row[] = [];
      const setViews = sets.map((set) => {
        const scope = set.attachmentType === "CAMPAIGN"
          ? `campanha ${names.campaigns.get(set.campaign) ?? ""} (${lastSegment(set.campaign)})`.replace("  ", " ")
          : "conta inteira";
        const ordered = set.rules.map((rn, index) => {
          inSets.add(rn);
          const rule = byResource.get(rn);
          const item = rule ? { order: index + 1, ...view(rule) } : { order: index + 1, rule: rn, note: "regra não retornada (removida ou de outra conta)" };
          flat.push({
            rule_set_id: set.id, scope, order: index + 1, rule_id: rule?.id ?? lastSegment(rn), status: rule?.status ?? "",
            conditions: rule ? describeConditions(rule, names).join("; ") : "", action: rule ? describeAction(rule.operation, rule.value) : "",
          });
          return item;
        });
        return {
          rule_set_id: set.id,
          scope,
          status: set.status,
          primary_dimension: set.dimensions[0] ?? null,
          dimensions: set.dimensions,
          conversion_action_categories: set.categories.length ? set.categories : "todas",
          ...(own(set.owner) ? {} : { inherited_from: set.owner }),
          rules: ordered,
        };
      });
      const outside = rules.filter((rule) => !inSets.has(rule.resourceName));
      for (const rule of outside) {
        flat.push({ rule_set_id: "", scope: "fora de conjunto (não aplicada)", order: "", rule_id: rule.id, status: rule.status,
          conditions: describeConditions(rule, names).join("; "), action: describeAction(rule.operation, rule.value) });
      }
      const header = [
        `${sets.length} conjunto(s) de regras e ${rules.length} regra(s) de valor na conta ${cid}.`,
        sets.length
          ? "Precedência: se a campanha tem conjunto próprio, só ele vale; senão vale o da conta. Dentro do conjunto, a primeira regra que casa é aplicada (locais: o mais específico)."
          : "Sem conjuntos: nenhuma regra de valor está sendo aplicada.",
        outside.length ? `${outside.length} regra(s) fora de conjunto — não são aplicadas.` : "",
      ].filter(Boolean).join("\n");
      return { content: [text(render(flat, format, header, { rule_sets: setViews, rules_outside_sets: outside.map(view) }))] };
    }
  );

  // ── create_conversion_value_rule ───────────────────────────────────

  ctx.mcp.registerTool(
    "create_conversion_value_rule",
    {
      description: [
        "Cria uma regra de valor de conversão e a coloca no conjunto de regras do escopo, numa operação atômica",
        "(googleAds:mutate): se o conjunto já existe a regra entra no FIM da lista e a dimensão nova é acrescentada;",
        "se não existe, o conjunto é criado junto. WRITE OPERATION.",
        "",
        "Condição (1 ou 2 tipos por regra): local (geoTargetConstantIds / excludedGeoTargetConstantIds — IDs de",
        "list_geo_targets), dispositivo (deviceTypes) e/ou público (userListIds / userInterestIds).",
        "Ação: ADD soma value ao valor (> 0); MULTIPLY multiplica (0,5 a 10); SET define o valor (> 0; a API só",
        "aceita SET em contas na allowlist).",
        "Escopo: sem campaignId = conjunto da conta inteira; com campaignId = conjunto da campanha (só Pesquisa e",
        "Display). Um conjunto aceita no máximo 2 dimensões, e as dimensões só podem ser acrescentadas.",
        "PRECEDÊNCIA: se a campanha tem conjunto próprio, SÓ os conjuntos da campanha valem para ela. Criar o",
        "primeiro conjunto de uma campanha faz as regras da conta deixarem de valer nela — com regras ativas na",
        "conta a tool lista o que deixaria de valer e exige confirm: true.",
        "Afeta lances por valor (Maximizar valor de conversão / ROAS desejado). Confira depois com",
        "list_conversion_value_rules e get_value_rule_impact.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha de Pesquisa ou Display (conjunto da campanha). Omitir = conta inteira."),
        operation: z.enum(VALUE_RULE_OPERATIONS).describe("ADD, MULTIPLY ou SET."),
        value: z.number().describe("ADD/SET: valor na moeda da conta (> 0). MULTIPLY: fator de 0,5 a 10."),
        geoTargetConstantIds: flexArray(z.string()).optional().describe("Locais incluídos (IDs de geo target constant)."),
        excludedGeoTargetConstantIds: flexArray(z.string()).optional().describe("Locais excluídos."),
        geoMatchType: z.enum(GEO_MATCH_TYPES).optional().describe("Locais incluídos: ANY (padrão; presença ou interesse) ou LOCATION_OF_PRESENCE."),
        excludedGeoMatchType: z.enum(GEO_MATCH_TYPES).optional().describe("Locais excluídos: ANY (padrão) ou LOCATION_OF_PRESENCE."),
        deviceTypes: flexArray(z.enum(VALUE_RULE_DEVICES)).optional().describe("MOBILE, DESKTOP, TABLET."),
        userListIds: flexArray(z.string()).optional().describe("Listas de público (IDs de list_remarketing_lists)."),
        userInterestIds: flexArray(z.string()).optional().describe("Interesses (IDs de user_interest)."),
        primaryDimension: z.enum(RULE_DIMENSIONS).optional().describe("Só ao criar o conjunto: qual dimensão vem primeiro (dimensão primária do relatório)."),
        confirm: z.boolean().optional().describe(
          "Com campaignId: obrigatório (true) quando o conjunto da campanha faria regras ATIVAS da conta deixarem de valer nela (a tool lista quais)."
        ),
      },
    },
    async (args) => {
      const { customerId, campaignId, operation, value, geoMatchType, excludedGeoMatchType, primaryDimension, confirm } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) {
        return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi enviado.`);
      }
      const parsed = {
        geo: normalizeIds(args.geoTargetConstantIds, "geoTargetConstantIds"),
        excludedGeo: normalizeIds(args.excludedGeoTargetConstantIds, "excludedGeoTargetConstantIds"),
        userLists: normalizeIds(args.userListIds, "userListIds"),
        userInterests: normalizeIds(args.userInterestIds, "userInterestIds"),
      };
      for (const result of Object.values(parsed)) if ("error" in result) return fail(result.error);
      const ids = Object.fromEntries(Object.entries(parsed).map(([k, r]) => [k, "ids" in r ? r.ids : []])) as Record<keyof typeof parsed, string[]>;
      const devices = [...new Set(ensureArray<unknown>(args.deviceTypes).map(String))];
      const badDevices = devices.filter((d) => !(VALUE_RULE_DEVICES as readonly string[]).includes(d));
      if (badDevices.length) return fail(`deviceTypes inválido(s): ${badDevices.join(", ")}. Use MOBILE, DESKTOP ou TABLET. Nada foi enviado.`);
      const rangeError = valueRangeError(operation, value);
      if (rangeError) return fail(`${rangeError} Nada foi enviado.`);
      const overlap = ids.geo.filter((id) => ids.excludedGeo.includes(id));
      if (overlap.length) return fail(`Local incluído e excluído ao mesmo tempo: ${overlap.join(", ")}. Nada foi enviado.`);
      if (geoMatchType && !ids.geo.length) return fail("geoMatchType sem geoTargetConstantIds. Nada foi enviado.");
      if (excludedGeoMatchType && !ids.excludedGeo.length) return fail("excludedGeoMatchType sem excludedGeoTargetConstantIds. Nada foi enviado.");

      const draft = {
        geo: ids.geo.map((id) => `geoTargetConstants/${id}`),
        excludedGeo: ids.excludedGeo.map((id) => `geoTargetConstants/${id}`),
        devices,
        userLists: ids.userLists.map((id) => `customers/${cid}/userLists/${id}`),
        userInterests: ids.userInterests.map((id) => `customers/${cid}/userInterests/${id}`),
      };
      const dims = ruleDimensions(draft);
      if (dims.length === 0) {
        return fail("Informe ao menos uma condição: locais, deviceTypes ou público (userListIds/userInterestIds). Nada foi enviado.");
      }
      if (dims.length > 2) {
        return fail(`A API aceita no máximo 2 tipos de condição por regra — recebidos ${dims.join(", ")}. Nada foi enviado.`);
      }
      if (primaryDimension && !dims.includes(primaryDimension)) {
        return fail(`primaryDimension ${primaryDimension} não está entre as condições da regra (${dims.join(", ")}). Nada foi enviado.`);
      }
      const orderedDims = primaryDimension ? [primaryDimension, ...dims.filter((d) => d !== primaryDimension)] : dims;
      const client = ctx.getClient();

      // Leitura antes da escrita: campanha, locais, listas e interesses existem nesta conta.
      let campaignRn: string | undefined;
      let campaignName = "";
      if (campaignId) {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
           FROM campaign WHERE campaign.id = ${campaignId}`);
        const camp = obj(rows[0]?.campaign);
        if (!rows.length || camp.status === "REMOVED") {
          return fail(`Campanha ${campaignId} não encontrada (ou removida) na conta ${cid}. Nada foi enviado.`);
        }
        if (!VALUE_RULE_CAMPAIGN_CHANNELS.has(String(camp.advertisingChannelType))) {
          return fail(
            `A campanha ${campaignId} é ${camp.advertisingChannelType}: conjunto de regras por campanha só existe em Pesquisa e Display ` +
            "(VALUE_RULES_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE). Use o conjunto da conta (sem campaignId). Nada foi enviado."
          );
        }
        campaignRn = `customers/${cid}/campaigns/${campaignId}`;
        campaignName = String(camp.name ?? "");
      }
      const names: NameMaps = { geo: new Map(), userLists: new Map(), userInterests: new Map(), campaigns: new Map() };
      const geoIds = [...ids.geo, ...ids.excludedGeo];
      if (geoIds.length) {
        const rows = await client.searchStream(customerId,
          `SELECT geo_target_constant.id, geo_target_constant.canonical_name, geo_target_constant.status
           FROM geo_target_constant WHERE geo_target_constant.id IN (${geoIds.join(", ")})`);
        for (const row of rows) {
          const g = obj(row.geoTargetConstant);
          names.geo.set(`geoTargetConstants/${g.id}`, String(g.canonicalName ?? ""));
        }
        const missing = geoIds.filter((id) => !names.geo.has(`geoTargetConstants/${id}`));
        if (missing.length) return fail(`Local(is) inexistente(s): ${missing.join(", ")} (confira em list_geo_targets). Nada foi enviado.`);
      }
      if (ids.userLists.length) {
        const rows = await client.searchStream(customerId,
          `SELECT user_list.id, user_list.name FROM user_list WHERE user_list.id IN (${ids.userLists.join(", ")})`);
        for (const row of rows) names.userLists.set(`customers/${cid}/userLists/${obj(row.userList).id}`, String(obj(row.userList).name ?? ""));
        const missing = ids.userLists.filter((id) => !names.userLists.has(`customers/${cid}/userLists/${id}`));
        if (missing.length) return fail(`Lista(s) de público não encontrada(s) na conta ${cid}: ${missing.join(", ")}. Nada foi enviado.`);
      }
      if (ids.userInterests.length) {
        const rows = await client.searchStream(customerId,
          `SELECT user_interest.user_interest_id, user_interest.name
           FROM user_interest WHERE user_interest.user_interest_id IN (${ids.userInterests.join(", ")})`);
        for (const row of rows) {
          names.userInterests.set(`customers/${cid}/userInterests/${obj(row.userInterest).userInterestId}`, String(obj(row.userInterest).name ?? ""));
        }
        const missing = ids.userInterests.filter((id) => !names.userInterests.has(`customers/${cid}/userInterests/${id}`));
        if (missing.length) return fail(`Interesse(s) não encontrado(s): ${missing.join(", ")}. Nada foi enviado.`);
      }

      // Conjunto do escopo: geral (sem categorias; os de STORE_VISIT/STORE_SALE são outro caso).
      const sets = (await client.searchStream(customerId, VALUE_RULE_SET_QUERY)).map(parseValueRuleSet);
      const inScope = sets.filter((s) => s.status !== "REMOVED" && s.categories.length === 0 &&
        (campaignRn ? s.attachmentType === "CAMPAIGN" && s.campaign === campaignRn : s.attachmentType === "CUSTOMER"));
      const owned = inScope.filter((s) => !s.owner || s.owner === `customers/${cid}`);
      const scopeLabel = campaignRn ? `campanha ${campaignName} (${campaignId})` : "conta inteira";
      if (inScope.length && !owned.length) {
        return fail(
          `O conjunto de regras da ${scopeLabel} é herdado de ${inScope[0].owner} e não pode ser alterado a partir da conta ${cid}. ` +
          "Crie a regra na conta gerente (customerId da MCC). Nada foi enviado."
        );
      }
      if (owned.length > 1) {
        return fail(`Há ${owned.length} conjuntos gerais para a ${scopeLabel} (${owned.map((s) => s.id).join(", ")}) — ambíguo. Nada foi enviado.`);
      }
      const target = owned[0];

      /*
       * Precedência (guia "Conversion value rules"): se existe conjunto CAMPAIGN para a campanha, só os
       * conjuntos da campanha valem para ela; senão valem os da conta. Sem conjunto ATIVO da campanha, a
       * regra nova liga essa precedência e as regras da conta (todas as categorias, inclusive herdadas da
       * MCC) deixam de valer para a campanha.
       */
      const liveSets = sets.filter((s) => s.status !== "REMOVED");
      const campaignAlreadyScoped = campaignRn
        ? liveSets.some((s) => s.attachmentType === "CAMPAIGN" && s.campaign === campaignRn && s.status === "ENABLED")
        : false;
      const switchesPrecedence = Boolean(campaignRn) && !campaignAlreadyScoped;
      const accountSets = liveSets.filter((s) => s.attachmentType === "CUSTOMER");

      const allRules = target || (switchesPrecedence && accountSets.length)
        ? (await client.searchStream(customerId,
          `SELECT ${VALUE_RULE_SELECT}
           FROM conversion_value_rule
           WHERE conversion_value_rule.status != 'REMOVED'`)).map(parseValueRule)
        : [];
      const ruleByRn = new Map(allRules.map((rule) => [rule.resourceName, rule]));

      if (target) {
        const existing = allRules.filter((rule) => target.rules.includes(rule.resourceName));
        const same = existing.find((rule) => conditionSignature(rule) === conditionSignature(draft));
        if (same) {
          const differences = ruleDifferences(same, {
            operation,
            value,
            geoMatch: draft.geo.length ? geoMatchType ?? "ANY" : "",
            excludedGeoMatch: draft.excludedGeo.length ? excludedGeoMatchType ?? "ANY" : "",
          });
          if (!differences.length) {
            return { content: [text(`Nada a fazer: a regra ${same.id} do conjunto ${target.id} já tem essas condições, essa correspondência de locais e essa ação (${describeAction(operation, value)}), e está ENABLED. Nenhuma escrita foi enviada.`)] };
          }
          return fail([
            `Já existe a regra ${same.id} (${same.status}) com os mesmos locais/dispositivos/públicos no conjunto ${target.id} — ` +
              "duas regras com as mesmas condições no conjunto conflitam. O que difere do pedido:",
            ...differences.map((d) => `- ${d.what}`),
            `Para aplicar o pedido, altere a regra existente: update_conversion_value_rule com conversionValueRuleId "${same.id}" e ` +
              `${differences.map((d) => d.fix).join(", ")}. Nada foi enviado.`,
          ].join("\n"));
        }
      }

      let newDims: string[] | undefined;
      if (target) {
        const missing = orderedDims.filter((d) => !target.dimensions.includes(d));
        if (missing.length) {
          if (target.dimensions.includes("NO_CONDITION") || target.dimensions.length + missing.length > 2) {
            return fail(
              `O conjunto ${target.id} (${scopeLabel}) usa as dimensões ${target.dimensions.join(", ")}; um conjunto aceita no máximo 2 e só permite ` +
              `acrescentar — a regra com ${missing.join(", ")} não cabe nele. Nada foi enviado.`
            );
          }
          newDims = [...target.dimensions, ...missing];
        }
      }

      // Regras ATIVAS da conta que deixariam de valer para a campanha (só quando a precedência muda).
      const lost = switchesPrecedence
        ? accountSets
          .map((set) => ({
            set,
            rules: set.rules.map((rn) => ruleByRn.get(rn)).filter((rule): rule is ValueRule => !!rule && rule.status === "ENABLED"),
            // Conjunto ENABLED cujas regras a consulta não devolveu: conta como ativo, pelo resource name.
            unresolved: set.status === "ENABLED" ? set.rules.filter((rn) => !ruleByRn.has(rn)) : [],
          }))
          .filter((entry) => entry.rules.length || entry.unresolved.length)
        : [];
      const lostIds = lost.flatMap((entry) => [...entry.rules.map((rule) => rule.id), ...entry.unresolved.map(lastSegment)]);
      const setLabel = (set: ValueRuleSet) =>
        `conjunto ${set.id} (conta inteira` +
        `${set.owner && set.owner !== `customers/${cid}` ? `, herdado de ${set.owner}` : ""}` +
        `${set.categories.length ? `, categorias ${set.categories.join(", ")}` : ""})`;
      if (lost.length && confirm !== true) {
        const lostNames = await resolveRuleNames(client, customerId, lost.flatMap((entry) => entry.rules), []);
        return fail([
          `A campanha ${campaignName} (${campaignId}) ainda não tem conjunto de regras próprio ativo. Pela precedência do Google Ads, ` +
            "quando a campanha tem conjunto próprio SÓ os conjuntos da campanha valem para ela — estas regras ATIVAS da conta " +
            `deixariam de ajustar o valor das conversões (e os lances por valor) da campanha ${campaignId}:`,
          ...lost.flatMap(({ set, rules, unresolved }) => [
            `- ${setLabel(set)}:`,
            ...rules.map((rule) =>
              `  • regra ${rule.id}: se ${describeConditions(rule, lostNames).join(" e ") || "sem condição"} → ${describeAction(rule.operation, rule.value)}`),
            ...unresolved.map((rn) => `  • regra ${lastSegment(rn)} (não retornada pela consulta)`),
          ]),
          "Para criar mesmo assim, envie confirm: true (e, se quiser manter esses ajustes nessa campanha, recrie-os no conjunto dela). " +
            "Para só acrescentar a regra à conta inteira, chame sem campaignId. Nada foi enviado.",
        ].join("\n"));
      }

      // Uma requisição atômica: a regra (ID temporário -1) e o conjunto que a referencia.
      const ruleTemp = `customers/${cid}/conversionValueRules/-1`;
      const rule: Row = { resourceName: ruleTemp, action: { operation, value }, status: "ENABLED" };
      if (draft.geo.length || draft.excludedGeo.length) {
        rule.geoLocationCondition = {
          ...(draft.geo.length ? { geoTargetConstants: draft.geo, geoMatchType: geoMatchType ?? "ANY" } : {}),
          ...(draft.excludedGeo.length ? { excludedGeoTargetConstants: draft.excludedGeo, excludedGeoMatchType: excludedGeoMatchType ?? "ANY" } : {}),
        };
      }
      if (draft.devices.length) rule.deviceCondition = { deviceTypes: draft.devices };
      if (draft.userLists.length || draft.userInterests.length) {
        rule.audienceCondition = {
          ...(draft.userLists.length ? { userLists: draft.userLists } : {}),
          ...(draft.userInterests.length ? { userInterests: draft.userInterests } : {}),
        };
      }
      const operations: Row[] = [{ conversionValueRuleOperation: { create: rule } }];
      if (target) {
        const update: Row = { resourceName: target.resourceName, conversionValueRules: [...target.rules, ruleTemp] };
        if (newDims) update.dimensions = newDims;
        operations.push({ conversionValueRuleSetOperation: { update, updateMask: newDims ? "conversion_value_rules,dimensions" : "conversion_value_rules" } });
      } else {
        operations.push({
          conversionValueRuleSetOperation: {
            create: {
              resourceName: `customers/${cid}/conversionValueRuleSets/-2`,
              conversionValueRules: [ruleTemp],
              dimensions: orderedDims,
              attachmentType: campaignRn ? "CAMPAIGN" : "CUSTOMER",
              ...(campaignRn ? { campaign: campaignRn } : {}),
            },
          },
        });
      }

      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi gravado (operação atômica).\n${explainApiError(err, VALUE_RULE_ERROR_HINTS)}`);
      }
      const dryRun = client.isDryRun;
      const results = mutateResults(response);
      const ruleRn = String(obj(results[0]?.conversionValueRuleResult).resourceName ?? "");
      const setRn = String(obj(results[1]?.conversionValueRuleSetResult).resourceName ?? "");
      const describedDraft = { ...draft, id: "", resourceName: "", status: "", owner: "", operation, value, geoMatch: geoMatchType ?? "ANY", excludedGeoMatch: excludedGeoMatchType ?? "ANY", itinerary: false };
      const verb = (now: string, conditional: string) => (dryRun ? conditional : now);
      let precedence: string;
      if (campaignRn && switchesPrecedence) {
        precedence = lost.length
          ? `Precedência: com conjunto próprio ativo, a campanha ${campaignId} ${verb("passa", "passaria")} a ignorar os conjuntos da conta — ` +
            `${lostIds.length} regra(s) ativa(s) da conta ${verb("deixam", "deixariam")} de valer para ela (confirm: true recebido): ` +
            `${lost.map(({ set, rules, unresolved }) => `${setLabel(set)} regras ${[...rules.map((r) => r.id), ...unresolved.map(lastSegment)].join(", ")}`).join("; ")}.`
          : `Precedência: com conjunto próprio ativo, a campanha ${campaignId} ${verb("passa", "passaria")} a ignorar os conjuntos da conta ` +
            "(hoje sem regras ativas); regras criadas depois no conjunto da conta não valerão para ela.";
      } else if (campaignRn) {
        precedence = `Precedência: a campanha ${campaignId} já tem conjunto próprio ativo, então os conjuntos da conta já não valem para ela — nada muda nisso.`;
      } else {
        const scopedCampaigns = [...new Set(liveSets.filter((s) => s.attachmentType === "CAMPAIGN" && s.status === "ENABLED").map((s) => lastSegment(s.campaign)))];
        precedence = scopedCampaigns.length
          ? `Precedência: ${scopedCampaigns.length} campanha(s) com conjunto próprio ativo (${scopedCampaigns.join(", ")}) ignoram o conjunto da conta e não recebem esta regra.`
          : "";
      }
      const lines = [
        dryRun
          ? "DRY-RUN (validateOnly): regra e conjunto validados pela API — nada foi gravado."
          : ruleRn ? "Regra de valor criada." : "A API não devolveu o resource name da regra — confira com list_conversion_value_rules antes de repetir.",
        `Regra: se ${describeConditions(describedDraft, names).join(" e ")} → ${describeAction(operation, value)}.`,
        target
          ? `Conjunto ${target.id} (${scopeLabel}): regras ${target.rules.length} → ${target.rules.length + 1} (a nova é a ${target.rules.length + 1}ª na ordem)` +
            (newDims ? `; dimensões ${target.dimensions.join(", ")} → ${newDims.join(", ")}.` : ".")
          : `Conjunto novo (${scopeLabel}) com dimensões ${orderedDims.join(", ")} — primária ${orderedDims[0]}.`,
        "Dentro do conjunto vale a primeira regra cujas condições casam; lances por valor passam a usar o valor ajustado.",
        precedence,
        operation === "SET" ? "Atenção: SET só é aceito pela API em contas na allowlist." : "",
        !dryRun && ruleRn ? `Recursos: ${ruleRn}${setRn ? ` | ${setRn}` : ""}` : "",
      ].filter(Boolean);
      return { content: [text(lines.join("\n"))] };
    }
  );

  // ── update_conversion_value_rule ───────────────────────────────────

  ctx.mcp.registerTool(
    "update_conversion_value_rule",
    {
      description: [
        "Altera uma regra de valor de conversão: ação (operation/value), condições, status (ENABLED/PAUSED)",
        "ou remove (status REMOVED, exige confirm: true). WRITE OPERATION.",
        "Listas de condição substituem a atual (ex.: deviceTypes: [\"MOBILE\"]); [] limpa aquele tipo, desde que",
        "sobre ao menos uma condição. A condição precisa caber nas dimensões do conjunto da regra.",
        "Remover: a regra sai do conjunto e é removida numa operação atômica; se era a única regra do conjunto,",
        "é preciso removeRuleSetIfEmpty: true (o conjunto vai junto). Só grava o que muda.",
        "IDs em list_conversion_value_rules.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionValueRuleId: z.string().describe("ID da regra (list_conversion_value_rules)."),
        operation: z.enum(VALUE_RULE_OPERATIONS).optional().describe("Nova operação: ADD, MULTIPLY ou SET."),
        value: z.number().optional().describe("Novo valor (ADD/SET > 0; MULTIPLY 0,5 a 10)."),
        status: z.enum(["ENABLED", "PAUSED", "REMOVED"]).optional().describe("ENABLED, PAUSED ou REMOVED (permanente; exige confirm)."),
        geoTargetConstantIds: flexArray(z.string()).optional().describe("Substitui os locais incluídos."),
        excludedGeoTargetConstantIds: flexArray(z.string()).optional().describe("Substitui os locais excluídos."),
        geoMatchType: z.enum(GEO_MATCH_TYPES).optional().describe("ANY ou LOCATION_OF_PRESENCE (locais incluídos)."),
        excludedGeoMatchType: z.enum(GEO_MATCH_TYPES).optional().describe("ANY ou LOCATION_OF_PRESENCE (locais excluídos)."),
        deviceTypes: flexArray(z.enum(VALUE_RULE_DEVICES)).optional().describe("Substitui os dispositivos."),
        userListIds: flexArray(z.string()).optional().describe("Substitui as listas de público."),
        userInterestIds: flexArray(z.string()).optional().describe("Substitui os interesses."),
        removeRuleSetIfEmpty: z.boolean().optional().describe("Com status REMOVED: se a regra é a única do conjunto, remove o conjunto junto."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para status REMOVED."),
      },
    },
    async (args) => {
      const { customerId, conversionValueRuleId, operation, value, status, geoMatchType, excludedGeoMatchType, removeRuleSetIfEmpty, confirm } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!NUMERIC_ID.test(conversionValueRuleId)) {
        return fail(`conversionValueRuleId deve ser numérico, recebido "${conversionValueRuleId}". Nada foi enviado.`);
      }
      const conditionArgs = {
        geo: args.geoTargetConstantIds, excludedGeo: args.excludedGeoTargetConstantIds,
        devices: args.deviceTypes, userLists: args.userListIds, userInterests: args.userInterestIds,
      };
      const provided = Object.entries(conditionArgs).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (status === "REMOVED") {
        if (provided.length || operation !== undefined || value !== undefined || geoMatchType || excludedGeoMatchType) {
          return fail("status REMOVED não se combina com outras mudanças — remova em uma chamada separada. Nada foi enviado.");
        }
        if (confirm !== true) {
          return fail("Remover a regra é permanente (a API não reativa regra removida). Envie confirm: true para prosseguir. Nada foi enviado.");
        }
      }
      const parsed = {
        geo: normalizeIds(conditionArgs.geo, "geoTargetConstantIds"),
        excludedGeo: normalizeIds(conditionArgs.excludedGeo, "excludedGeoTargetConstantIds"),
        userLists: normalizeIds(conditionArgs.userLists, "userListIds"),
        userInterests: normalizeIds(conditionArgs.userInterests, "userInterestIds"),
      };
      for (const result of Object.values(parsed)) if ("error" in result) return fail(result.error);
      const ids = Object.fromEntries(Object.entries(parsed).map(([k, r]) => [k, "ids" in r ? r.ids : []])) as Record<keyof typeof parsed, string[]>;
      const devices = [...new Set(ensureArray<unknown>(conditionArgs.devices).map(String))];
      const badDevices = devices.filter((d) => !(VALUE_RULE_DEVICES as readonly string[]).includes(d));
      if (badDevices.length) return fail(`deviceTypes inválido(s): ${badDevices.join(", ")}. Nada foi enviado.`);
      if (value !== undefined && !Number.isFinite(value)) return fail(`value inválido: ${value}. Nada foi enviado.`);

      const client = ctx.getClient();
      const ruleRows = await client.searchStream(customerId,
        `SELECT ${VALUE_RULE_SELECT}
         FROM conversion_value_rule
         WHERE conversion_value_rule.id = ${conversionValueRuleId}`);
      if (!ruleRows.length) return fail(`Regra de valor ${conversionValueRuleId} não encontrada na conta ${cid}. Nada foi enviado.`);
      const rule = parseValueRule(ruleRows[0]);
      if (rule.status === "REMOVED") return fail(`A regra ${rule.id} já está removida. Nada foi enviado.`);
      if (rule.owner && rule.owner !== `customers/${cid}`) {
        return fail(`A regra ${rule.id} é herdada de ${rule.owner}: altere-a na conta gerente. Nada foi enviado.`);
      }
      const sets = (await client.searchStream(customerId, VALUE_RULE_SET_QUERY)).map(parseValueRuleSet);
      const set = sets.find((s) => s.status !== "REMOVED" && s.rules.includes(rule.resourceName));
      if (set && set.owner && set.owner !== `customers/${cid}`) {
        return fail(`A regra ${rule.id} está no conjunto ${set.id}, herdado de ${set.owner}: altere na conta gerente. Nada foi enviado.`);
      }

      // ── Remoção: tira do conjunto e remove, atômico ──
      if (status === "REMOVED") {
        const operations: Row[] = [];
        let setNote = "A regra não estava em nenhum conjunto.";
        if (set) {
          const remaining = set.rules.filter((rn) => rn !== rule.resourceName);
          if (!remaining.length) {
            if (removeRuleSetIfEmpty !== true) {
              return fail(
                `A regra ${rule.id} é a única do conjunto ${set.id} e um conjunto precisa de ao menos uma regra. ` +
                "Para remover as duas coisas envie também removeRuleSetIfEmpty: true (ou pause a regra com status PAUSED). Nada foi enviado."
              );
            }
            operations.push({ conversionValueRuleSetOperation: { remove: set.resourceName } });
            setNote = `O conjunto ${set.id} ficaria vazio e é removido junto.`;
            const otherCampaignSet = sets.some((s) => s.id !== set.id && s.status === "ENABLED" && s.attachmentType === "CAMPAIGN" && s.campaign === set.campaign);
            if (set.attachmentType === "CAMPAIGN" && !otherCampaignSet) {
              setNote += ` Precedência: sem conjunto próprio, a campanha ${lastSegment(set.campaign)} volta a usar os conjuntos da conta.`;
            }
          } else {
            operations.push({ conversionValueRuleSetOperation: { update: { resourceName: set.resourceName, conversionValueRules: remaining }, updateMask: "conversion_value_rules" } });
            setNote = `Sai do conjunto ${set.id}: regras ${set.rules.length} → ${remaining.length}.`;
          }
        }
        operations.push({ conversionValueRuleOperation: { remove: rule.resourceName } });
        try {
          await client.batchMutate(customerId, operations);
        } catch (err) {
          return fail(`Nada foi gravado (operação atômica).\n${explainApiError(err, VALUE_RULE_ERROR_HINTS)}`);
        }
        return {
          content: [text([
            client.isDryRun ? "DRY-RUN (validateOnly): remoção validada — nada foi gravado." : `Regra ${rule.id} removida.`,
            `Antes: ${describeAction(rule.operation, rule.value)} (${rule.status}).`,
            setNote,
          ].join("\n"))],
        };
      }

      // ── Alteração: só os caminhos que mudam ──
      const nextOperation = operation ?? rule.operation;
      const nextValue = value ?? rule.value;
      if (operation !== undefined || value !== undefined) {
        const rangeError = valueRangeError(nextOperation, nextValue);
        if (rangeError) return fail(`${rangeError} Nada foi enviado.`);
      }
      const next = {
        geo: conditionArgs.geo !== undefined ? ids.geo.map((id) => `geoTargetConstants/${id}`) : rule.geo,
        excludedGeo: conditionArgs.excludedGeo !== undefined ? ids.excludedGeo.map((id) => `geoTargetConstants/${id}`) : rule.excludedGeo,
        devices: conditionArgs.devices !== undefined ? devices : rule.devices,
        userLists: conditionArgs.userLists !== undefined ? ids.userLists.map((id) => `customers/${cid}/userLists/${id}`) : rule.userLists,
        userInterests: conditionArgs.userInterests !== undefined ? ids.userInterests.map((id) => `customers/${cid}/userInterests/${id}`) : rule.userInterests,
      };
      const overlap = next.geo.filter((g) => next.excludedGeo.includes(g));
      if (overlap.length) return fail(`Local incluído e excluído ao mesmo tempo: ${overlap.map(lastSegment).join(", ")}. Nada foi enviado.`);
      const nextDims = ruleDimensions(next);
      if (provided.length) {
        if (!nextDims.length && !rule.itinerary) return fail("A regra ficaria sem nenhuma condição. Nada foi enviado.");
        if (nextDims.length > 2) return fail(`A API aceita no máximo 2 tipos de condição por regra — ficariam ${nextDims.join(", ")}. Nada foi enviado.`);
        const outside = set ? nextDims.filter((d) => !set.dimensions.includes(d)) : [];
        if (outside.length) {
          return fail(
            `O conjunto ${set!.id} só aceita condições de ${set!.dimensions.join(", ")} — ${outside.join(", ")} não cabe. ` +
            "Crie uma regra nova com create_conversion_value_rule. Nada foi enviado."
          );
        }
      }
      const same = (a: string[], b: string[]) => [...a].sort().join(",") === [...b].sort().join(",");
      const newGeo = next.geo.filter((g) => !rule.geo.includes(g) && !rule.excludedGeo.includes(g));
      const newExcluded = next.excludedGeo.filter((g) => !rule.geo.includes(g) && !rule.excludedGeo.includes(g));
      const geoCheck = [...new Set([...newGeo, ...newExcluded])].map(lastSegment);
      if (geoCheck.length) {
        const rows = await client.searchStream(customerId,
          `SELECT geo_target_constant.id, geo_target_constant.status
           FROM geo_target_constant WHERE geo_target_constant.id IN (${geoCheck.join(", ")})`);
        const found = new Set(rows.map((r) => String(obj(r.geoTargetConstant).id)));
        const missing = geoCheck.filter((id) => !found.has(id));
        if (missing.length) return fail(`Local(is) inexistente(s): ${missing.join(", ")}. Nada foi enviado.`);
      }
      const newLists = next.userLists.filter((u) => !rule.userLists.includes(u)).map(lastSegment);
      if (newLists.length) {
        const rows = await client.searchStream(customerId,
          `SELECT user_list.id, user_list.name FROM user_list WHERE user_list.id IN (${newLists.join(", ")})`);
        const found = new Set(rows.map((r) => String(obj(r.userList).id)));
        const missing = newLists.filter((id) => !found.has(id));
        if (missing.length) return fail(`Lista(s) de público não encontrada(s) na conta ${cid}: ${missing.join(", ")}. Nada foi enviado.`);
      }
      const newInterests = next.userInterests.filter((u) => !rule.userInterests.includes(u)).map(lastSegment);
      if (newInterests.length) {
        const rows = await client.searchStream(customerId,
          `SELECT user_interest.user_interest_id, user_interest.name
           FROM user_interest WHERE user_interest.user_interest_id IN (${newInterests.join(", ")})`);
        const found = new Set(rows.map((r) => String(obj(r.userInterest).userInterestId)));
        const missing = newInterests.filter((id) => !found.has(id));
        if (missing.length) return fail(`Interesse(s) não encontrado(s): ${missing.join(", ")}. Nada foi enviado.`);
      }

      const update: Row = { resourceName: rule.resourceName };
      const mask: string[] = [];
      const changes: string[] = [];
      if (nextOperation !== rule.operation || nextValue !== rule.value) {
        update.action = {
          ...(nextOperation !== rule.operation ? { operation: nextOperation } : {}),
          ...(nextValue !== rule.value ? { value: nextValue } : {}),
        };
        if (nextOperation !== rule.operation) mask.push("action.operation");
        if (nextValue !== rule.value) mask.push("action.value");
        changes.push(`ação: ${describeAction(rule.operation, rule.value)} → ${describeAction(nextOperation, nextValue)}`);
      }
      if (status !== undefined && status !== rule.status) {
        update.status = status;
        mask.push("status");
        changes.push(`status: ${rule.status} → ${status}`);
      }
      const geoCondition: Row = {};
      if (!same(next.geo, rule.geo)) {
        geoCondition.geoTargetConstants = next.geo;
        mask.push("geo_location_condition.geo_target_constants");
        changes.push(`locais incluídos: [${rule.geo.map(lastSegment).join(", ")}] → [${next.geo.map(lastSegment).join(", ")}]`);
      }
      const wantMatch = geoMatchType ?? (next.geo.length && !rule.geoMatch ? "ANY" : undefined);
      if (wantMatch && wantMatch !== rule.geoMatch && next.geo.length) {
        geoCondition.geoMatchType = wantMatch;
        mask.push("geo_location_condition.geo_match_type");
        changes.push(`tipo de correspondência (incluídos): ${rule.geoMatch || "—"} → ${wantMatch}`);
      }
      if (!same(next.excludedGeo, rule.excludedGeo)) {
        geoCondition.excludedGeoTargetConstants = next.excludedGeo;
        mask.push("geo_location_condition.excluded_geo_target_constants");
        changes.push(`locais excluídos: [${rule.excludedGeo.map(lastSegment).join(", ")}] → [${next.excludedGeo.map(lastSegment).join(", ")}]`);
      }
      const wantExcludedMatch = excludedGeoMatchType ?? (next.excludedGeo.length && !rule.excludedGeoMatch ? "ANY" : undefined);
      if (wantExcludedMatch && wantExcludedMatch !== rule.excludedGeoMatch && next.excludedGeo.length) {
        geoCondition.excludedGeoMatchType = wantExcludedMatch;
        mask.push("geo_location_condition.excluded_geo_match_type");
        changes.push(`tipo de correspondência (excluídos): ${rule.excludedGeoMatch || "—"} → ${wantExcludedMatch}`);
      }
      if (Object.keys(geoCondition).length) update.geoLocationCondition = geoCondition;
      if (!same(next.devices, rule.devices)) {
        update.deviceCondition = { deviceTypes: next.devices };
        mask.push("device_condition.device_types");
        changes.push(`dispositivos: [${rule.devices.join(", ")}] → [${next.devices.join(", ")}]`);
      }
      const audience: Row = {};
      if (!same(next.userLists, rule.userLists)) {
        audience.userLists = next.userLists;
        mask.push("audience_condition.user_lists");
        changes.push(`listas: [${rule.userLists.map(lastSegment).join(", ")}] → [${next.userLists.map(lastSegment).join(", ")}]`);
      }
      if (!same(next.userInterests, rule.userInterests)) {
        audience.userInterests = next.userInterests;
        mask.push("audience_condition.user_interests");
        changes.push(`interesses: [${rule.userInterests.map(lastSegment).join(", ")}] → [${next.userInterests.map(lastSegment).join(", ")}]`);
      }
      if (Object.keys(audience).length) update.audienceCondition = audience;

      if (!mask.length) {
        return { content: [text(`Regra ${rule.id}: nada a mudar — já está assim (${describeAction(rule.operation, rule.value)}, ${rule.status}). Nenhuma escrita foi enviada.`)] };
      }
      const conditionsChanged = mask.some((path) => path.includes("_condition."));
      if (conditionsChanged && set) {
        const others = (await client.searchStream(customerId,
          `SELECT ${VALUE_RULE_SELECT}
           FROM conversion_value_rule
           WHERE conversion_value_rule.status != 'REMOVED'`))
          .map(parseValueRule)
          .filter((other) => other.resourceName !== rule.resourceName && set.rules.includes(other.resourceName));
        const clash = others.find((other) => conditionSignature(other) === conditionSignature(next));
        if (clash) {
          return fail(`A regra ${clash.id} do mesmo conjunto já tem essas condições — duas regras iguais conflitam. Nada foi enviado.`);
        }
      }
      try {
        await client.mutate(customerId, "conversionValueRules", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`Nada foi gravado.\n${explainApiError(err, VALUE_RULE_ERROR_HINTS)}`);
      }
      return {
        content: [text([
          client.isDryRun ? `DRY-RUN (validateOnly): alteração da regra ${rule.id} validada — nada foi gravado.` : `Regra ${rule.id} atualizada.`,
          ...changes.map((c) => `- ${c}`),
          `Campos: ${mask.join(", ")}`,
        ].join("\n"))],
      };
    }
  );

  // ── get_value_rule_impact ──────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_value_rule_impact",
    {
      description: [
        "Efeito das regras de valor no valor de conversão: compara metrics.conversions_value (depois dos ajustes)",
        "com metrics.original_conversion_value (antes dos ajustes) por campanha, e quebra o valor por",
        "segments.conversion_value_rule_primary_dimension (NO_RULE_APPLIED, ORIGINAL, GEO_LOCATION, DEVICE,",
        "AUDIENCE...). original_conversion_value também exclui ajustes de metas de ciclo de vida (cliente novo),",
        "então a diferença não é só de regras de valor.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) {
        return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi consultado.`);
      }
      const date = dateClauseOrError(dateRange, days);
      if ("error" in date) return fail(date.error);
      const client = ctx.getClient();

      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, metrics.conversions, metrics.conversions_value,
                metrics.original_conversion_value
         FROM campaign
         WHERE ${date.clause}
           AND campaign.status != 'REMOVED'${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}`);
      // O segmento de dimensão primária só combina com conversions_value/all_conversions_value (não com original_conversion_value).
      const dimensionRows = await client.searchStream(customerId,
        `SELECT segments.conversion_value_rule_primary_dimension, metrics.conversions_value, metrics.all_conversions_value
         FROM ${campaignId ? "campaign" : "customer"}
         WHERE ${date.clause}${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}`);
      const sets = (await client.searchStream(customerId, VALUE_RULE_SET_QUERY)).map(parseValueRuleSet)
        .filter((s) => s.status !== "REMOVED");

      const byCampaign = new Map<string, { campaign_id: string; campaign: string; conversions: number; adjusted: number; original: number }>();
      for (const row of campaignRows) {
        const camp = obj(row.campaign);
        const m = obj(row.metrics);
        const key = String(camp.id ?? "");
        const acc = byCampaign.get(key) ?? { campaign_id: key, campaign: String(camp.name ?? ""), conversions: 0, adjusted: 0, original: 0 };
        acc.conversions += num(m.conversions);
        acc.adjusted += num(m.conversionsValue);
        acc.original += num(m.originalConversionValue);
        byCampaign.set(key, acc);
      }
      const rows: Row[] = [...byCampaign.values()]
        .map((c) => ({
          campaign_id: c.campaign_id,
          campaign: c.campaign,
          conversions: round2(c.conversions),
          original_value: round2(c.original),
          adjusted_value: round2(c.adjusted),
          adjustment: round2(c.adjusted - c.original),
          adjustment_pct: c.original ? round2(((c.adjusted - c.original) / c.original) * 100) : null,
        }))
        .sort((a, b) => Math.abs(num(b.adjustment)) - Math.abs(num(a.adjustment)));
      const totalOriginal = [...byCampaign.values()].reduce((s, c) => s + c.original, 0);
      const totalAdjusted = [...byCampaign.values()].reduce((s, c) => s + c.adjusted, 0);

      /*
       * Segmento conversion_value_rule_primary_dimension (guia "Conversion value rules", seção Metrics):
       * NO_RULE_APPLIED = valor das conversões sem regra; ORIGINAL = valor ORIGINAL das conversões com regra;
       * GEO_LOCATION, DEVICE, AUDIENCE, NO_CONDITION (e demais do enum) = valor DEPOIS da regra, agrupado pela
       * primeira dimensão do conjunto. O ajuste das regras é a soma dessas linhas menos ORIGINAL.
       */
      const NOT_AFTER_RULE = new Set(["NO_RULE_APPLIED", "ORIGINAL", "UNKNOWN", "UNSPECIFIED"]);
      const MEANING: Record<string, string> = {
        NO_RULE_APPLIED: "valor das conversões sem regra aplicada",
        ORIGINAL: "valor original (antes da regra) das conversões em que uma regra foi aplicada",
        UNKNOWN: "dimensão não reconhecida nesta versão da API",
        UNSPECIFIED: "dimensão não informada",
      };
      const AFTER_RULE_MEANING = "valor depois da regra (conversões com regra, agrupadas pela dimensão primária do conjunto)";
      const byDimension = new Map<string, { conversions_value: number; all_conversions_value: number }>();
      for (const row of dimensionRows) {
        const dim = String(obj(row.segments).conversionValueRulePrimaryDimension ?? "UNKNOWN");
        const m = obj(row.metrics);
        const acc = byDimension.get(dim) ?? { conversions_value: 0, all_conversions_value: 0 };
        acc.conversions_value += num(m.conversionsValue);
        acc.all_conversions_value += num(m.allConversionsValue);
        byDimension.set(dim, acc);
      }
      const dimensions = [...byDimension.entries()].map(([dimension, acc]) => ({
        dimension,
        meaning: MEANING[dimension] ?? AFTER_RULE_MEANING,
        conversions_value: round2(acc.conversions_value),
        all_conversions_value: round2(acc.all_conversions_value),
      }));
      const ruleEffect = (key: "conversions_value" | "all_conversions_value") => {
        const original = byDimension.get("ORIGINAL")?.[key] ?? 0;
        const afterRules = [...byDimension.entries()].filter(([dim]) => !NOT_AFTER_RULE.has(dim)).reduce((s, [, acc]) => s + acc[key], 0);
        return { original_value: round2(original), value_after_rules: round2(afterRules), adjustment: round2(afterRules - original) };
      };
      const effect = { conversions_value: ruleEffect("conversions_value"), all_conversions_value: ruleEffect("all_conversions_value") };

      const diff = totalAdjusted - totalOriginal;
      const signed = (value: number) => `${value >= 0 ? "+" : "-"}${brl(Math.abs(value))}`;
      const ruled = effect.conversions_value;
      const header = [
        `Impacto das regras de valor — ${periodLabel(dateRange, days)}${campaignId ? `, campanha ${campaignId}` : ""}.`,
        `Valor original (antes dos ajustes): ${brl(totalOriginal)}; valor ajustado (coluna Valor conv.): ${brl(totalAdjusted)}; ` +
          `diferença ${signed(diff)}${totalOriginal ? ` (${diff >= 0 ? "+" : ""}${round2((diff / totalOriginal) * 100)}%)` : ""}.`,
        byDimension.size
          ? `Só as conversões em que uma regra foi aplicada: valor original ${brl(ruled.original_value)} → ${brl(ruled.value_after_rules)} depois das regras ` +
            `(ajuste ${signed(ruled.adjustment)}). Nas linhas por dimensão, ORIGINAL é o antes e as dimensões (GEO_LOCATION, DEVICE, AUDIENCE...) são o valor DEPOIS da regra, não o ajuste.`
          : "",
        sets.length
          ? `${sets.length} conjunto(s) de regras ativo(s) ou pausado(s) na conta (detalhes em list_conversion_value_rules).`
          : "Nenhum conjunto de regras na conta: diferença, se houver, vem de outros ajustes (ex.: metas de ciclo de vida).",
      ].filter(Boolean).join("\n");
      if (format === "table") {
        return { content: [text(`${header}\n\n${formatAsTable(rows)}\n\nPor dimensão primária:\n${formatAsTable(dimensions)}`)] };
      }
      if (format === "csv") return { content: [text(formatAsCsv(rows))] };
      return {
        content: [text(`${header}\n\n${formatJson({
          totals: { original_value: round2(totalOriginal), adjusted_value: round2(totalAdjusted), adjustment: round2(diff) },
          campaigns: rows,
          by_primary_dimension: dimensions,
          rule_effect: effect,
        })}`)],
      };
    }
  );

  // ── get_lift_results ───────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_lift_results",
    {
      description: [
        "Resultados de estudos de Conversion Lift e Brand Lift (recursos lift_measurement_*, v25.1, somente leitura).",
        "Os estudos são montados com o Google; aqui se leem os estudos, os voos (flights) e os resultados.",
        "Conversion Lift: conversões e valor incrementais, lift relativo, custo por conversão incremental e ROAS",
        "incremental, cada um com intervalo de 90% e p-valor, mais um veredito em linguagem simples.",
        "Brand Lift: lift absoluto, relativo e headroom por tipo de pergunta (lembrança, consideração...), respostas",
        "coletadas e custo por usuário impactado.",
        "breakdown — Conversion Lift: NONE, CONVERSION_ACTION, AGE_RANGE, GENDER, DEVICE, COUNTRY, EXPERIMENT_ARM;",
        "Brand Lift: NONE, CAMPAIGN, AGE_RANGE, GENDER, DEVICE, VIDEO.",
        "Taxas, lifts relativos e custos saem como a API devolve (sem conversão de unidade).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        liftMeasurementConfigId: z.string().optional().describe("ID do estudo (lift_measurement_config_id). Omitir = todos."),
        liftType: z.enum(["AUTO", "CONVERSION", "BRAND"]).optional().describe("AUTO (padrão) segue o tipo dos voos do estudo."),
        breakdown: z.enum(["NONE", "CONVERSION_ACTION", "AGE_RANGE", "GENDER", "DEVICE", "COUNTRY", "EXPERIMENT_ARM", "CAMPAIGN", "VIDEO"])
          .optional().describe("Quebra dos resultados. Padrão: NONE."),
        format: formatSchema,
      },
    },
    async ({ customerId, liftMeasurementConfigId, liftType, breakdown, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (liftMeasurementConfigId !== undefined && !NUMERIC_ID.test(liftMeasurementConfigId)) {
        return fail(`liftMeasurementConfigId deve ser numérico, recebido "${liftMeasurementConfigId}". Nada foi consultado.`);
      }
      const kind = liftType ?? "AUTO";
      const dim = breakdown ?? "NONE";
      const conversionDims = CONVERSION_LIFT_BREAKDOWNS[dim];
      const brandSpec = BRAND_LIFT_BREAKDOWNS[dim];
      if (kind === "CONVERSION" && !conversionDims) {
        return fail(`breakdown ${dim} não existe para Conversion Lift. Use: ${Object.keys(CONVERSION_LIFT_BREAKDOWNS).join(", ")}.`);
      }
      if (kind === "BRAND" && !brandSpec) {
        return fail(`breakdown ${dim} não existe para Brand Lift. Use: ${Object.keys(BRAND_LIFT_BREAKDOWNS).join(", ")}.`);
      }
      const client = ctx.getClient();
      const where = (resource: string) => (liftMeasurementConfigId
        ? `\n         WHERE ${resource}.lift_measurement_config_id = ${liftMeasurementConfigId}`
        : "");

      const configRows = await client.searchStream(customerId,
        `SELECT lift_measurement_config.lift_measurement_config_id, lift_measurement_config.name,
                lift_measurement_config.campaigns, lift_measurement_config.conversion_actions,
                lift_measurement_config.conversion_lift_holdback_ratio_micros, lift_measurement_config.survey_language,
                lift_measurement_config.single_measurement_question_set.question_measurements
         FROM lift_measurement_config${where("lift_measurement_config")}`);
      if (!configRows.length) {
        if (liftMeasurementConfigId) return fail(`Estudo de lift ${liftMeasurementConfigId} não encontrado nesta conta.`);
        return { content: [text("Nenhum estudo de lift (Conversion Lift ou Brand Lift) nesta conta. Os estudos são montados com o Google; a API só lê resultados.")] };
      }
      const flightRows = await client.searchStream(customerId,
        `SELECT lift_measurement_flight.lift_measurement_config_id, lift_measurement_flight.lift_measurement_flight_id,
                lift_measurement_flight.name, lift_measurement_flight.status, lift_measurement_flight.lift_type,
                lift_measurement_flight.start_date, lift_measurement_flight.end_date,
                lift_measurement_flight.survey_lift_measurement.response_collection_ratio_micros
         FROM lift_measurement_flight${where("lift_measurement_flight")}`);

      const campaignRns = [...new Set(configRows.flatMap((row) => strings(obj(row.liftMeasurementConfig).campaigns)))]
        .filter((rn) => CAMPAIGN_RN.test(rn));
      const campaignNames = new Map<string, string>();
      if (campaignRns.length) {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.resource_name, campaign.name FROM campaign WHERE campaign.resource_name IN (${inList(campaignRns)})`);
        for (const row of rows) campaignNames.set(String(obj(row.campaign).resourceName), String(obj(row.campaign).name ?? ""));
      }
      const flightsByConfig = new Map<string, Row[]>();
      for (const row of flightRows) {
        const flight = obj(row.liftMeasurementFlight);
        const key = String(flight.liftMeasurementConfigId ?? "");
        const collected = maybe(obj(flight.surveyLiftMeasurement).responseCollectionRatioMicros);
        flightsByConfig.set(key, [...(flightsByConfig.get(key) ?? []), {
          flight_id: String(flight.liftMeasurementFlightId ?? ""),
          name: String(flight.name ?? ""),
          status: String(flight.status ?? ""),
          lift_type: String(flight.liftType ?? ""),
          start_date: String(flight.startDate ?? ""),
          end_date: String(flight.endDate ?? ""),
          // response_collection_ratio_micros: 0 = 0%, 1.000.000 = 100% (proto v25)
          ...(collected !== undefined ? { survey_responses_collected_pct: round2(collected / 10_000) } : {}),
        }]);
      }
      const studies = configRows.map((row) => {
        const config = obj(row.liftMeasurementConfig);
        const id = String(config.liftMeasurementConfigId ?? "");
        const holdback = maybe(config.conversionLiftHoldbackRatioMicros);
        return {
          config_id: id,
          name: String(config.name ?? ""),
          campaigns: strings(config.campaigns).map((rn) => `${campaignNames.get(rn) ?? ""} (${lastSegment(rn)})`.trim()),
          conversion_actions: strings(config.conversionActions).map(lastSegment),
          ...(holdback !== undefined ? { conversion_lift_holdback_ratio_micros: holdback } : {}),
          ...(config.surveyLanguage ? { survey_language: String(config.surveyLanguage) } : {}),
          brand_questions: strings(obj(config.singleMeasurementQuestionSet).questionMeasurements),
          flights: flightsByConfig.get(id) ?? [],
        };
      });
      const flightTypes = new Set(studies.flatMap((s) => s.flights.map((f) => String(f.lift_type))));
      const hasConversionStudy = flightTypes.has("CONVERSION") || studies.some((s) => s.conversion_actions.length > 0);
      const hasBrandStudy = flightTypes.has("SURVEY") || studies.some((s) => s.brand_questions.length > 0);
      const unknownType = !hasConversionStudy && !hasBrandStudy;
      const runConversion = !!conversionDims && (kind === "CONVERSION" || (kind === "AUTO" && (hasConversionStudy || unknownType)));
      const runBrand = !!brandSpec && (kind === "BRAND" || (kind === "AUTO" && (hasBrandStudy || unknownType)));
      const notes: string[] = [];
      if (kind === "AUTO" && hasConversionStudy && !conversionDims) notes.push(`breakdown ${dim} não existe para Conversion Lift — parte de conversão omitida.`);
      if (kind === "AUTO" && hasBrandStudy && !brandSpec) notes.push(`breakdown ${dim} não existe para Brand Lift — parte de marca omitida.`);
      if (flightTypes.has("SEARCH")) notes.push("Há voo de Search Lift: a API v25 não expõe métricas próprias dele nestes recursos.");

      const conversion: Row[] = [];
      const summaries: string[] = [];
      if (runConversion && conversionDims) {
        const withWinner = dim === "NONE" || dim === "EXPERIMENT_ARM";
        const metricNames = [...CONVERSION_LIFT_METRICS, ...(withWinner ? CONVERSION_LIFT_WINNER_METRICS : [])];
        const segmentFields = [...CONVERSION_LIFT_PERIOD_SEGMENTS, ...conversionDims].map((s) => `segments.${s}`);
        const rows = await client.searchStream(customerId,
          `SELECT lift_measurement_config.lift_measurement_config_id, lift_measurement_config.name,
                  ${segmentFields.join(", ")},
                  ${metricNames.map((m) => `metrics.${m}`).join(", ")}
           FROM lift_measurement_config${where("lift_measurement_config")}`);
        for (const row of rows) {
          const config = obj(row.liftMeasurementConfig);
          const seg = obj(row.segments);
          const m = obj(row.metrics);
          const get = (field: string) => maybe(m[camel(field)]);
          const pValue = get("incremental_conversions_p_value");
          const verdict = liftVerdict(get("incremental_conversions_p90_lower_bound"), get("incremental_conversions_p90_upper_bound"), pValue);
          const out: Row = {
            config_id: String(config.liftMeasurementConfigId ?? ""),
            study: String(config.name ?? ""),
            period: `${seg.conversionLiftStartDate ?? "?"} a ${seg.conversionLiftEndDate ?? "?"}`,
            category: seg.conversionLiftConversionCategory ?? null,
            included_conversion_types: seg.conversionLiftIncludedConversionActionTypes ?? null,
            ...Object.fromEntries(conversionDims.map((s) => [s, seg[camel(s)] ?? null])),
            verdict,
            significant_90: pValue !== undefined ? pValue <= 0.1 : null,
            ...Object.fromEntries(metricNames.map((f) => [f, get(f) ?? null])),
          };
          conversion.push(out);
          if (dim === "NONE") {
            summaries.push(
              `Conversion Lift — "${out.study}" (${out.config_id}), ${out.period}${out.category ? `, ${out.category}` : ""}: ` +
              `${get("incremental_conversions") ?? "?"} conversões incrementais → ${verdict}. ` +
              (verdict.startsWith("positivo")
                ? "As campanhas geraram conversões que não aconteceriam sem os anúncios."
                : verdict.startsWith("negativo")
                  ? "O grupo exposto converteu menos que o controle — investigue antes de escalar."
                  : "Ainda não dá para afirmar ganho incremental.") +
              ` Custo por conversão incremental: ${get("cost_per_incremental_conversion") ?? "?"}; lift relativo: ${get("relative_conversion_lift") ?? "?"}.`
            );
          }
        }
        if (!rows.length) notes.push("Conversion Lift: sem resultados ainda (estudo em andamento ou dados insuficientes).");
      }

      const brand: Row[] = [];
      if (runBrand && brandSpec) {
        const resource = brandSpec.resource;
        const fields = [`${resource}.lift_measurement_config_id`, ...brandSpec.fields.map((f) => `${resource}.${f}`)];
        const rows = await client.searchStream(customerId,
          `SELECT ${fields.join(", ")}, segments.brand_lift_measurement_type,
                  ${BRAND_LIFT_METRICS.map((m) => `metrics.${m}`).join(", ")}
           FROM ${resource}${where(resource)}`);
        for (const row of rows) {
          const res = obj(row[camel(resource)]);
          const m = obj(row.metrics);
          const get = (field: string) => maybe(m[camel(field)]);
          const verdict = liftVerdict(get("absolute_brand_lift_p90_lower_bound"), get("absolute_brand_lift_p90_upper_bound"), get("absolute_brand_lift_p_value"));
          const out: Row = {
            config_id: String(res.liftMeasurementConfigId ?? ""),
            ...Object.fromEntries(brandSpec.fields.map((f) => [f, res[camel(f)] ?? null])),
            question_type: obj(row.segments).brandLiftMeasurementType ?? null,
            verdict,
            ...Object.fromEntries(BRAND_LIFT_METRICS.map((f) => [f, get(f) ?? null])),
          };
          brand.push(out);
          if (dim === "NONE") {
            summaries.push(
              `Brand Lift — estudo ${out.config_id}, ${out.question_type}: lift absoluto ${get("absolute_brand_lift") ?? "?"} → ${verdict}; ` +
              `${get("brand_lift_total_responses") ?? "?"} respostas.`
            );
          }
        }
        if (!rows.length) notes.push("Brand Lift: sem resultados ainda (pesquisa coletando respostas ou dados insuficientes).");
      }

      const header = [
        `${studies.length} estudo(s) de lift${liftMeasurementConfigId ? ` (filtro ${liftMeasurementConfigId})` : ""}; breakdown ${dim}.`,
        ...summaries,
        ...notes,
        "Leitura: significativo = intervalo de 90% inteiro acima (ou abaixo) de zero; p ≤ 0,10 equivale a 90% de confiança.",
      ].join("\n");
      if (format === "table") {
        return {
          content: [text([
            header,
            conversion.length ? `Conversion Lift:\n${formatAsTable(conversion)}` : "",
            brand.length ? `Brand Lift:\n${formatAsTable(brand)}` : "",
          ].filter(Boolean).join("\n\n"))],
        };
      }
      if (format === "csv") return { content: [text(formatAsCsv(conversion.length ? conversion : brand))] };
      return { content: [text(`${header}\n\n${formatJson({ studies, conversion_lift: conversion, brand_lift: brand })}`)] };
    }
  );

  // ── list_lead_forms ────────────────────────────────────────────────

  ctx.mcp.registerTool(
    "list_lead_forms",
    {
      description: [
        "Lista os formulários de lead (assets LEAD_FORM) da conta, as campanhas em que estão vinculados e se a conta",
        "já aceitou os termos de formulário de lead (pré-requisito para criar um).",
        "Mostra campos, perguntas, CTA, textos pós-envio e o webhook de entrega (o segredo nunca é exibido).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só formulários vinculados a esta campanha."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) {
        return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi consultado.`);
      }
      const client = ctx.getClient();
      const customerRows = await client.searchStream(customerId,
        `SELECT customer.id, customer.customer_agreement_setting.accepted_lead_form_terms FROM customer LIMIT 1`);
      const accepted = obj(obj(obj(customerRows[0]).customer).customerAgreementSetting).acceptedLeadFormTerms === true;
      const assetRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.final_urls, asset.lead_form_asset.business_name,
                asset.lead_form_asset.headline, asset.lead_form_asset.description,
                asset.lead_form_asset.call_to_action_type, asset.lead_form_asset.call_to_action_description,
                asset.lead_form_asset.privacy_policy_url, asset.lead_form_asset.post_submit_headline,
                asset.lead_form_asset.post_submit_description, asset.lead_form_asset.post_submit_call_to_action_type,
                asset.lead_form_asset.desired_intent, asset.lead_form_asset.background_image_asset,
                asset.lead_form_asset.fields, asset.lead_form_asset.custom_question_fields,
                asset.lead_form_asset.delivery_methods
         FROM asset
         WHERE asset.type = 'LEAD_FORM'`);
      const linkRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign_asset.asset, campaign_asset.status,
                campaign_asset.primary_status
         FROM campaign_asset
         WHERE campaign_asset.field_type = 'LEAD_FORM'
           AND campaign_asset.status != 'REMOVED'${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}`);
      const links = new Map<string, Row[]>();
      for (const row of linkRows) {
        const link = obj(row.campaignAsset);
        const camp = obj(row.campaign);
        const assetId = lastSegment(link.asset);
        links.set(assetId, [...(links.get(assetId) ?? []), {
          campaign_id: String(camp.id ?? ""), campaign: String(camp.name ?? ""), campaign_status: String(camp.status ?? ""),
          link_status: String(link.status ?? ""), primary_status: String(link.primaryStatus ?? ""),
        }]);
      }
      const answersOf = (item: Row) => strings(obj(item.singleChoiceAnswers).answers);
      const forms = assetRows.map((row) => {
        const asset = obj(row.asset);
        const form = obj(asset.leadFormAsset);
        const webhook = list(form.deliveryMethods).map((d) => obj(obj(d).webhook)).find((w) => Object.keys(w).length);
        return {
          asset_id: String(asset.id ?? ""),
          name: String(asset.name ?? ""),
          business_name: form.businessName ?? null,
          headline: form.headline ?? null,
          description: form.description ?? null,
          call_to_action: `${form.callToActionType ?? "?"}: ${form.callToActionDescription ?? ""}`,
          privacy_policy_url: form.privacyPolicyUrl ?? null,
          final_urls: strings(asset.finalUrls),
          fields: list(form.fields).map((f) => {
            const answers = answersOf(obj(f));
            return answers.length ? `${obj(f).inputType} (${answers.join(" / ")})` : String(obj(f).inputType);
          }),
          custom_questions: list(form.customQuestionFields).map((q) => {
            const answers = answersOf(obj(q));
            return answers.length ? `${obj(q).customQuestionText} (${answers.join(" / ")})` : String(obj(q).customQuestionText);
          }),
          post_submit: {
            headline: form.postSubmitHeadline ?? null,
            description: form.postSubmitDescription ?? null,
            call_to_action: form.postSubmitCallToActionType ?? null,
          },
          desired_intent: form.desiredIntent ?? null,
          background_image_asset: form.backgroundImageAsset ?? null,
          webhook: webhook
            ? { url: webhook.advertiserWebhookUrl ?? null, payload_schema_version: webhook.payloadSchemaVersion ?? null, google_secret: webhook.googleSecret ? "*** (oculto)" : null }
            : null,
          campaigns: links.get(String(asset.id ?? "")) ?? [],
        };
      });
      const shown = campaignId ? forms.filter((f) => f.campaigns.length > 0) : forms;
      const header = [
        `Termos de formulário de lead: ${accepted ? "aceitos" : "NÃO aceitos — create_lead_form fica bloqueado até aceitar na interface do Google Ads"}.`,
        `${shown.length} formulário(s) de lead${campaignId ? ` vinculado(s) à campanha ${campaignId}` : ""}.`,
      ].join("\n");
      const flat = shown.map((f) => ({
        asset_id: f.asset_id, name: f.name, headline: f.headline, call_to_action: f.call_to_action,
        fields: f.fields.join("; "), custom_questions: f.custom_questions.join("; "),
        webhook: f.webhook ? String(f.webhook.url) : "",
        campaigns: f.campaigns.map((c) => `${c.campaign} (${c.campaign_id}, ${c.link_status})`).join("; "),
      }));
      return { content: [text(render(flat, format, header, { accepted_lead_form_terms: accepted, lead_forms: shown }))] };
    }
  );

  // ── create_lead_form ───────────────────────────────────────────────

  ctx.mcp.registerTool(
    "create_lead_form",
    {
      description: [
        "Cria um formulário de lead (LeadFormAsset) e o vincula às campanhas (CampaignAsset LEAD_FORM) numa",
        "operação atômica (googleAds:mutate). WRITE OPERATION.",
        "Pré-requisito: a conta ter aceitado os termos de formulário de lead (veja em list_lead_forms) — a API não",
        "aceita os termos; sem eles nada é enviado.",
        "fields: campos de contato (FULL_NAME, EMAIL, PHONE_NUMBER, GOVERNMENT_ISSUED_ID_CPF_BR, ...) e perguntas",
        "pré-aprovadas (ex.: PREFERRED_CONTACT_TIME, com answers de 2 a 12; no máximo 5). customQuestions: até 5",
        "perguntas próprias — não se misturam com as pré-aprovadas. FULL_NAME não se combina com FIRST_NAME/LAST_NAME.",
        "webhook (url + googleSecret) entrega cada lead no CRM; os leads também ficam 60 dias na conta",
        "(get_lead_form_submissions). O formulário aparece nas campanhas ativas assim que criado.",
        "Lead form é aceito em Pesquisa e Performance Max; outros tipos dependem de elegibilidade da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignIds: flexArray(z.string()).describe("Campanhas que recebem o formulário (IDs numéricos)."),
        name: z.string().optional().describe("Nome interno do asset (padrão: empresa – título – data). Precisa ser único."),
        businessName: z.string().describe("Nome da empresa exibido no formulário."),
        headline: z.string().describe("Título do formulário aberto."),
        description: z.string().describe("Descrição do formulário aberto."),
        callToActionType: z.enum(LEAD_FORM_CTA).describe("Texto do botão que abre o formulário."),
        callToActionDescription: z.string().describe("Frase de proposta de valor ao lado do botão."),
        privacyPolicyUrl: z.string().describe("URL da política de privacidade (obrigatória)."),
        finalUrl: z.string().describe("URL final do asset (site do anunciante)."),
        fields: flexArray(leadFieldSchema).describe("Campos em ordem: [{ inputType, answers? }]."),
        customQuestions: flexArray(customQuestionSchema).optional().describe("Até 5 perguntas próprias: [{ question, answers? }]."),
        postSubmitHeadline: z.string().optional().describe("Título exibido após o envio."),
        postSubmitDescription: z.string().optional().describe("Texto exibido após o envio."),
        postSubmitCallToActionType: z.enum(LEAD_FORM_POST_SUBMIT_CTA).optional().describe("Botão após o envio."),
        desiredIntent: z.enum(["LOW_INTENT", "HIGH_INTENT"]).optional().describe("LOW_INTENT = mais volume; HIGH_INTENT = mais qualificado."),
        backgroundImageAssetId: z.string().optional().describe("ID de um asset de imagem 1200x628 para o fundo."),
        customDisclosure: z.string().optional().describe("Aviso próprio junto do aviso do Google (só contas liberadas)."),
        webhook: z.object({
          url: z.string().describe("URL do webhook do CRM."),
          googleSecret: z.string().describe("Chave que o Google envia em cada lead para o CRM validar a origem."),
          payloadSchemaVersion: z.number().int().optional().describe("Versão do payload (padrão 3)."),
        }).optional().describe("Entrega dos leads por webhook."),
      },
    },
    async (args) => {
      const { customerId } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const campaignIds = normalizeIds(args.campaignIds, "campaignIds");
      if ("error" in campaignIds) return fail(campaignIds.error);
      if (!campaignIds.ids.length) return fail("Informe ao menos uma campanha em campaignIds. Nada foi enviado.");

      const required: Array<[string, string]> = [
        ["businessName", args.businessName], ["headline", args.headline], ["description", args.description],
        ["callToActionDescription", args.callToActionDescription], ["privacyPolicyUrl", args.privacyPolicyUrl], ["finalUrl", args.finalUrl],
      ];
      const empty = required.filter(([, v]) => !String(v ?? "").trim()).map(([k]) => k);
      if (empty.length) return fail(`Campo(s) obrigatório(s) vazio(s): ${empty.join(", ")}. Nada foi enviado.`);
      for (const [label, url] of [["privacyPolicyUrl", args.privacyPolicyUrl], ["finalUrl", args.finalUrl], ["webhook.url", args.webhook?.url]] as const) {
        if (url !== undefined && !HTTP_URL.test(url.trim())) return fail(`${label} precisa ser uma URL http(s) completa, recebido "${url}". Nada foi enviado.`);
      }
      if (args.webhook && !args.webhook.googleSecret.trim()) return fail("webhook.googleSecret vazio — o CRM precisa dele para validar os leads. Nada foi enviado.");
      if (args.backgroundImageAssetId !== undefined && !NUMERIC_ID.test(args.backgroundImageAssetId)) {
        return fail(`backgroundImageAssetId deve ser numérico, recebido "${args.backgroundImageAssetId}". Nada foi enviado.`);
      }

      const fieldList = parseList(leadFieldSchema, args.fields, "fields");
      if ("error" in fieldList) return fail(fieldList.error);
      const fields = fieldList.items.map((f) => ({
        inputType: f.inputType.trim().toUpperCase(),
        answers: (f.answers ?? []).map((a) => a.trim()).filter(Boolean),
      }));
      if (!fields.length) return fail("fields precisa de ao menos um campo (ex.: FULL_NAME, EMAIL, PHONE_NUMBER). Nada foi enviado.");
      const known = new Set([...LEAD_FORM_CONTACT_FIELDS, ...LEAD_FORM_QUALIFYING_QUESTIONS]);
      const unknown = fields.filter((f) => !known.has(f.inputType)).map((f) => f.inputType);
      if (unknown.length) {
        return fail(`inputType desconhecido: ${unknown.join(", ")}. Campos de contato: ${LEAD_FORM_CONTACT_FIELDS.join(", ")}; ` +
          "perguntas pré-aprovadas seguem o enum LeadFormFieldUserInputType (ex.: PREFERRED_CONTACT_TIME). Nada foi enviado.");
      }
      const types = fields.map((f) => f.inputType);
      const duplicated = types.filter((t, i) => types.indexOf(t) !== i);
      if (duplicated.length) return fail(`Campo repetido: ${[...new Set(duplicated)].join(", ")}. Nada foi enviado.`);
      if (types.includes("FULL_NAME") && (types.includes("FIRST_NAME") || types.includes("LAST_NAME"))) {
        return fail("FULL_NAME não pode ficar junto de FIRST_NAME/LAST_NAME (regra do enum LeadFormFieldUserInputType). Nada foi enviado.");
      }
      const contactWithAnswers = fields.filter((f) => f.answers.length && LEAD_FORM_CONTACT_FIELDS.includes(f.inputType)).map((f) => f.inputType);
      if (contactWithAnswers.length) {
        return fail(`answers só vale para perguntas pré-aprovadas, não para ${contactWithAnswers.join(", ")}. Nada foi enviado.`);
      }
      const qualifying = fields.filter((f) => LEAD_FORM_QUALIFYING_QUESTIONS.includes(f.inputType));
      if (qualifying.length > MAX_QUALIFYING_QUESTIONS) {
        return fail(`No máximo ${MAX_QUALIFYING_QUESTIONS} perguntas pré-aprovadas por formulário (recebidas ${qualifying.length}). Nada foi enviado.`);
      }
      const badChoices = fields.filter((f) => f.answers.length && (f.answers.length < MIN_CHOICES || f.answers.length > MAX_CHOICES)).map((f) => f.inputType);
      if (badChoices.length) return fail(`answers precisa de ${MIN_CHOICES} a ${MAX_CHOICES} opções: ${badChoices.join(", ")}. Nada foi enviado.`);

      let custom: Array<{ question: string; answers: string[] }> = [];
      if (args.customQuestions !== undefined) {
        const parsed = parseList(customQuestionSchema, args.customQuestions, "customQuestions");
        if ("error" in parsed) return fail(parsed.error);
        custom = parsed.items.map((q) => ({ question: q.question.trim(), answers: (q.answers ?? []).map((a) => a.trim()).filter(Boolean) }));
      }
      if (custom.length > MAX_CUSTOM_QUESTIONS) return fail(`No máximo ${MAX_CUSTOM_QUESTIONS} perguntas personalizadas (recebidas ${custom.length}). Nada foi enviado.`);
      if (custom.some((q) => !q.question)) return fail("Pergunta personalizada com texto vazio. Nada foi enviado.");
      const longQuestion = custom.find((q) => q.question.length > MAX_CUSTOM_QUESTION_CHARS);
      if (longQuestion) return fail(`Pergunta com mais de ${MAX_CUSTOM_QUESTION_CHARS} caracteres: "${longQuestion.question.slice(0, 40)}…". Nada foi enviado.`);
      const badCustomChoices = custom.filter((q) => q.answers.length && (q.answers.length < MIN_CHOICES || q.answers.length > MAX_CHOICES));
      if (badCustomChoices.length) return fail(`answers de pergunta personalizada precisa de ${MIN_CHOICES} a ${MAX_CHOICES} opções. Nada foi enviado.`);
      if (custom.length && qualifying.length) {
        return fail(
          `Perguntas pré-aprovadas (${qualifying.map((q) => q.inputType).join(", ")}) não podem ficar no mesmo formulário que perguntas ` +
          "personalizadas (LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED). Use só um dos tipos. Nada foi enviado."
        );
      }
      const name = (args.name ?? `${args.businessName.trim()} – ${args.headline.trim()} – ${localIsoDate(new Date())}`).trim();

      const client = ctx.getClient();
      // Pré-requisito: termos aceitos (campo somente leitura na API).
      const customerRows = await client.searchStream(customerId,
        `SELECT customer.id, customer.customer_agreement_setting.accepted_lead_form_terms FROM customer LIMIT 1`);
      const accepted = obj(obj(obj(customerRows[0]).customer).customerAgreementSetting).acceptedLeadFormTerms === true;
      if (!accepted) {
        return fail(
          `A conta ${cid} ainda não aceitou os termos de formulário de lead (customer_agreement_setting.accepted_lead_form_terms = false). ` +
          "Os termos só podem ser aceitos na interface do Google Ads, ao criar um formulário de lead; a API recusaria com " +
          "LEAD_FORM_MISSING_AGREEMENT. Nada foi enviado."
        );
      }
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
         FROM campaign WHERE campaign.id IN (${campaignIds.ids.join(", ")})`);
      const campaigns = new Map(campaignRows.map((row) => [String(obj(row.campaign).id), obj(row.campaign)]));
      const missing = campaignIds.ids.filter((id) => !campaigns.has(id) || campaigns.get(id)?.status === "REMOVED");
      if (missing.length) return fail(`Campanha(s) não encontrada(s) ou removida(s) na conta ${cid}: ${missing.join(", ")}. Nada foi enviado.`);
      const sameName = await client.searchStream(customerId,
        `SELECT asset.id, asset.name FROM asset WHERE asset.type = 'LEAD_FORM' AND asset.name = '${gaqlLiteral(name)}'`);
      if (sameName.length) {
        return fail(
          `Já existe o formulário "${name}" (asset ${obj(sameName[0].asset).id}). Para usá-lo em outras campanhas use ` +
          "link_lead_form_to_campaigns; para um novo, escolha outro name. Nada foi enviado."
        );
      }
      if (args.backgroundImageAssetId) {
        const rows = await client.searchStream(customerId,
          `SELECT asset.id, asset.type, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
           FROM asset WHERE asset.id = ${args.backgroundImageAssetId}`);
        const image = obj(rows[0]?.asset);
        const size = obj(obj(image.imageAsset).fullSize);
        if (!rows.length || image.type !== "IMAGE") {
          return fail(`backgroundImageAssetId ${args.backgroundImageAssetId} não é um asset de imagem desta conta. Nada foi enviado.`);
        }
        if (num(size.widthPixels) !== 1200 || num(size.heightPixels) !== 628) {
          return fail(`A imagem de fundo precisa ter exatamente 1200x628 (a ${args.backgroundImageAssetId} tem ${size.widthPixels}x${size.heightPixels}). Nada foi enviado.`);
        }
      }
      const existingLinks = await client.searchStream(customerId,
        `SELECT campaign.id, campaign_asset.asset, campaign_asset.status
         FROM campaign_asset
         WHERE campaign_asset.field_type = 'LEAD_FORM'
           AND campaign_asset.status != 'REMOVED'
           AND campaign.id IN (${campaignIds.ids.join(", ")})`);

      const assetTemp = `customers/${cid}/assets/-1`;
      const leadFormAsset: Row = {
        businessName: args.businessName.trim(),
        callToActionType: args.callToActionType,
        callToActionDescription: args.callToActionDescription.trim(),
        headline: args.headline.trim(),
        description: args.description.trim(),
        privacyPolicyUrl: args.privacyPolicyUrl.trim(),
        fields: fields.map((f) => ({ inputType: f.inputType, ...(f.answers.length ? { singleChoiceAnswers: { answers: f.answers } } : {}) })),
        ...(custom.length ? {
          customQuestionFields: custom.map((q) => ({ customQuestionText: q.question, ...(q.answers.length ? { singleChoiceAnswers: { answers: q.answers } } : {}) })),
        } : {}),
        ...(args.postSubmitHeadline ? { postSubmitHeadline: args.postSubmitHeadline.trim() } : {}),
        ...(args.postSubmitDescription ? { postSubmitDescription: args.postSubmitDescription.trim() } : {}),
        ...(args.postSubmitCallToActionType ? { postSubmitCallToActionType: args.postSubmitCallToActionType } : {}),
        ...(args.desiredIntent ? { desiredIntent: args.desiredIntent } : {}),
        ...(args.customDisclosure ? { customDisclosure: args.customDisclosure.trim() } : {}),
        ...(args.backgroundImageAssetId ? { backgroundImageAsset: `customers/${cid}/assets/${args.backgroundImageAssetId}` } : {}),
        ...(args.webhook ? {
          deliveryMethods: [{
            webhook: {
              advertiserWebhookUrl: args.webhook.url.trim(),
              googleSecret: args.webhook.googleSecret,
              payloadSchemaVersion: String(args.webhook.payloadSchemaVersion ?? DEFAULT_WEBHOOK_SCHEMA_VERSION),
            },
          }],
        } : {}),
      };
      const operations: Row[] = [
        { assetOperation: { create: { resourceName: assetTemp, name, finalUrls: [args.finalUrl.trim()], leadFormAsset } } },
        ...campaignIds.ids.map((id) => ({
          campaignAssetOperation: { create: { asset: assetTemp, campaign: `customers/${cid}/campaigns/${id}`, fieldType: "LEAD_FORM" } },
        })),
      ];
      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi gravado (operação atômica).\n${explainApiError(err, LEAD_FORM_ERROR_HINTS)}`);
      }
      const dryRun = client.isDryRun;
      const results = mutateResults(response);
      const assetRn = String(obj(results[0]?.assetResult).resourceName ?? "");
      const channelNotes = campaignIds.ids
        .filter((id) => !["SEARCH", "PERFORMANCE_MAX"].includes(String(campaigns.get(id)?.advertisingChannelType)))
        .map((id) => `${id} (${campaigns.get(id)?.advertisingChannelType})`);
      const otherForms = [...new Set(existingLinks.map((row) => String(obj(row.campaign).id)))];
      const lines = [
        dryRun
          ? "DRY-RUN (validateOnly): formulário e vínculos validados pela API — nada foi gravado."
          : assetRn ? `Formulário de lead criado: ${assetRn}` : "A API não devolveu o resource name do formulário — confira com list_lead_forms antes de repetir.",
        `Nome: ${name} | ${fields.length} campo(s)${custom.length ? `, ${custom.length} pergunta(s) personalizada(s)` : ""}` +
          `${args.webhook ? ` | webhook: ${args.webhook.url.trim()}` : " | sem webhook (leads na conta por 60 dias)"}.`,
        `Campanhas: ${campaignIds.ids.map((id) => `${campaigns.get(id)?.name ?? ""} (${id})`).join(", ")}.`,
        otherForms.length ? `Aviso: a(s) campanha(s) ${otherForms.join(", ")} já tinha(m) formulário de lead vinculado.` : "",
        channelNotes.length ? `Aviso: formulário de lead é aceito em Pesquisa e Performance Max; confira a elegibilidade de ${channelNotes.join(", ")}.` : "",
      ].filter(Boolean);
      return { content: [text(lines.join("\n"))] };
    }
  );

  // ── link_lead_form_to_campaigns ────────────────────────────────────

  ctx.mcp.registerTool(
    "link_lead_form_to_campaigns",
    {
      description: [
        "Vincula um formulário de lead existente a campanhas (action LINK, padrão) ou desvincula (action UNLINK,",
        "exige confirm: true). WRITE OPERATION. Uma operação por campanha, com relatório por item (partialFailure).",
        "Vínculo já ativo é pulado (sem escrita); vínculo pausado não é reativado automaticamente.",
        "IDs em list_lead_forms.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetId: z.string().describe("ID do asset LEAD_FORM (list_lead_forms)."),
        campaignIds: flexArray(z.string()).describe("Campanhas (IDs numéricos)."),
        action: z.enum(["LINK", "UNLINK"]).optional().describe("LINK (padrão) ou UNLINK."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para UNLINK."),
      },
    },
    async ({ customerId, assetId, campaignIds, action, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const mode = action ?? "LINK";
      if (!NUMERIC_ID.test(assetId)) return fail(`assetId deve ser numérico, recebido "${assetId}". Nada foi enviado.`);
      const ids = normalizeIds(campaignIds, "campaignIds");
      if ("error" in ids) return fail(ids.error);
      if (!ids.ids.length) return fail("Informe ao menos uma campanha em campaignIds. Nada foi enviado.");
      if (mode === "UNLINK" && confirm !== true) {
        return fail("Desvincular tira o formulário das campanhas na hora. Envie confirm: true para prosseguir. Nada foi enviado.");
      }
      const client = ctx.getClient();
      const assetRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.type FROM asset WHERE asset.id = ${assetId}`);
      const asset = obj(assetRows[0]?.asset);
      if (!assetRows.length) return fail(`Asset ${assetId} não encontrado na conta ${cid}. Nada foi enviado.`);
      if (asset.type !== "LEAD_FORM") return fail(`O asset ${assetId} é ${asset.type}, não LEAD_FORM. Nada foi enviado.`);
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id IN (${ids.ids.join(", ")})`);
      const campaigns = new Map(campaignRows.map((row) => [String(obj(row.campaign).id), obj(row.campaign)]));
      const linkRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign_asset.resource_name, campaign_asset.status
         FROM campaign_asset
         WHERE campaign_asset.field_type = 'LEAD_FORM'
           AND campaign_asset.asset = 'customers/${cid}/assets/${assetId}'
           AND campaign.id IN (${ids.ids.join(", ")})`);
      const links = new Map(linkRows.map((row) => [String(obj(row.campaign).id), obj(row.campaignAsset)]));

      const report: Row[] = [];
      const targets: string[] = [];
      const operations: Array<{ create?: Row; remove?: string }> = [];
      for (const id of ids.ids) {
        const camp = campaigns.get(id);
        const link = links.get(id);
        const label = { campaign_id: id, campaign: camp ? String(camp.name ?? "") : null };
        if (!camp || camp.status === "REMOVED") {
          report.push({ ...label, result: "ignorada", reason: "campanha não encontrada ou removida" });
          continue;
        }
        if (mode === "LINK") {
          if (link?.status === "ENABLED") { report.push({ ...label, result: "sem mudança", reason: "já vinculado" }); continue; }
          if (link?.status === "PAUSED") {
            report.push({ ...label, result: "sem mudança", reason: "vínculo pausado — reative de propósito na interface; nada foi reativado" });
            continue;
          }
          operations.push({ create: { asset: `customers/${cid}/assets/${assetId}`, campaign: `customers/${cid}/campaigns/${id}`, fieldType: "LEAD_FORM" } });
        } else {
          if (!link || link.status === "REMOVED") { report.push({ ...label, result: "sem mudança", reason: "não estava vinculado" }); continue; }
          operations.push({ remove: String(link.resourceName) });
        }
        targets.push(id);
      }
      if (!operations.length) {
        return { content: [text(`Nada a fazer para o formulário ${assetId} — nenhuma escrita foi enviada.\n\n${formatJson(report)}`)] };
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignAssets", operations, { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi gravado.\n${explainApiError(err, LEAD_FORM_ERROR_HINTS)}\n\n${formatJson(report)}`);
      }
      const dryRun = client.isDryRun;
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, operations.length);
      const results = list(response.results).map(obj);
      let done = 0;
      targets.forEach((id, index) => {
        const camp = campaigns.get(id);
        const label = { campaign_id: id, campaign: String(camp?.name ?? "") };
        const errors = byIndex.get(index);
        if (errors) report.push({ ...label, result: "erro", reason: errors.join("; ") });
        else if (dryRun) { report.push({ ...label, result: "validado (dry-run)" }); done++; }
        else if (results[index]?.resourceName) { report.push({ ...label, result: mode === "LINK" ? "vinculado" : "desvinculado" }); done++; }
        else report.push({ ...label, result: "erro", reason: "a API não confirmou a operação" });
      });
      const header = dryRun
        ? `DRY-RUN (validateOnly): ${done} de ${operations.length} operação(ões) validada(s) — nada foi gravado.`
        : `Formulário ${asset.name ?? assetId} (${assetId}): ${done} de ${operations.length} campanha(s) ${mode === "LINK" ? "vinculada(s)" : "desvinculada(s)"}.`;
      return {
        content: [text(`${header}${unattributed.length ? `\nErros sem campanha identificada: ${unattributed.join("; ")}` : ""}\n\n${formatJson(report)}`)],
        ...(done === 0 ? { isError: true } : {}),
      };
    }
  );

  // ── get_lead_form_submissions ──────────────────────────────────────

  ctx.mcp.registerTool(
    "get_lead_form_submissions",
    {
      description: [
        "Leads recebidos pelos formulários de lead (lead_form_submission_data): data/hora, campanha, grupo,",
        "formulário, GCLID, respostas dos campos e das perguntas personalizadas.",
        "O Google Ads guarda os leads por 60 dias — exporte com frequência (ou configure webhook).",
        "redact=true mascara e-mails, telefones e demais respostas (útil para análises sem dado pessoal).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe("Intervalo por data de envio (YYYY-MM-DD). Use isto OU days."),
        days: z.number().optional().describe("Dias para trás, 1 a 60. Padrão: 30."),
        campaignId: z.string().optional().describe("Só leads desta campanha."),
        assetId: z.string().optional().describe("Só leads deste formulário (asset LEAD_FORM)."),
        limit: z.number().optional().describe("Máximo de leads (padrão 1000, até 10000)."),
        redact: z.boolean().optional().describe("true = mascara os dados pessoais nas respostas."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, assetId, limit, redact, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      for (const [label, value] of [["campaignId", campaignId], ["assetId", assetId]] as const) {
        if (value !== undefined && !NUMERIC_ID.test(value)) return fail(`${label} deve ser numérico, recebido "${value}". Nada foi consultado.`);
      }
      const max = limit ?? 1000;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) return fail(`limit inválido: ${limit}. Use um inteiro de 1 a 10000.`);
      const date = leadDateClause(dateRange, days);
      if ("error" in date) return fail(date.error);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT lead_form_submission_data.id, lead_form_submission_data.submission_date_time,
                lead_form_submission_data.gclid, lead_form_submission_data.lead_form_submission_fields,
                lead_form_submission_data.custom_lead_form_submission_fields, lead_form_submission_data.campaign,
                lead_form_submission_data.ad_group, lead_form_submission_data.asset,
                campaign.id, campaign.name, ad_group.name, asset.name
         FROM lead_form_submission_data
         WHERE ${date.clause}${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}${assetId ? `
           AND asset.id = ${assetId}` : ""}
         ORDER BY lead_form_submission_data.submission_date_time DESC
         LIMIT ${max}`);
      const leads = rows.map((row) => {
        const lead = obj(row.leadFormSubmissionData);
        const fields: Row = {};
        for (const field of list(lead.leadFormSubmissionFields).map(obj)) {
          const type = String(field.fieldType ?? "UNKNOWN");
          const value = String(field.fieldValue ?? "");
          fields[type] = redact ? maskLeadValue(type, value) : value;
        }
        const answers: Row = {};
        for (const field of list(lead.customLeadFormSubmissionFields).map(obj)) {
          const value = String(field.fieldValue ?? "");
          answers[String(field.questionText ?? "?")] = redact ? maskLeadValue("CUSTOM", value) : value;
        }
        return {
          lead_id: String(lead.id ?? ""),
          submitted_at: String(lead.submissionDateTime ?? ""),
          campaign_id: String(obj(row.campaign).id ?? lastSegment(lead.campaign)),
          campaign: String(obj(row.campaign).name ?? ""),
          ad_group: String(obj(row.adGroup).name ?? ""),
          form: String(obj(row.asset).name ?? lastSegment(lead.asset)),
          gclid: redact && lead.gclid ? "***" : String(lead.gclid ?? ""),
          fields,
          custom_answers: answers,
        };
      });
      const byCampaign = new Map<string, number>();
      for (const lead of leads) byCampaign.set(`${lead.campaign} (${lead.campaign_id})`, (byCampaign.get(`${lead.campaign} (${lead.campaign_id})`) ?? 0) + 1);
      const header = [
        `${leads.length} lead(s) — ${date.label}${campaignId ? `, campanha ${campaignId}` : ""}${assetId ? `, formulário ${assetId}` : ""}` +
          `${leads.length === max ? ` (limite de ${max} atingido — pode haver mais)` : ""}.`,
        byCampaign.size ? `Por campanha: ${[...byCampaign.entries()].map(([k, v]) => `${k}: ${v}`).join("; ")}.` : "",
        `O Google Ads guarda os leads por ${LEAD_RETENTION_DAYS} dias.${redact ? " Dados pessoais mascarados (redact)." : ""}`,
      ].filter(Boolean).join("\n");
      return { content: [text(render(leads as unknown as Row[], format, header))] };
    }
  );
}
