/**
 * Lote conversions-core: Ações e metas de conversão.
 *
 * Tudo que cria ou gerencia conversões passa pela "conta de conversão" da conta
 * (customer.conversion_tracking_setting.google_ads_conversion_customer). Com acompanhamento
 * de conversões entre contas (MCC), as ações, as metas da conta (CustomerConversionGoal) e as
 * metas personalizadas (CustomConversionGoal) vivem na MCC, e a API exige o ID dela como
 * customer_id — gravar na conta cliente cria no lugar errado ou falha (NO_CONVERSION_ACTION_FOUND).
 * As metas por campanha (CampaignConversionGoal, ConversionGoalCampaignConfig) continuam na conta
 * da campanha. Fonte: developers.google.com/google-ads/api/docs/conversions/getting-started e
 * .../conversions/goals/overview; protos v25 de conversion_action, customer e das metas.
 *
 * As tools list_conversion_actions, create_conversion_action, update_conversion_action e
 * set_campaign_conversion_goals (antes em src/tools.ts) são registradas aqui para dividirem o
 * cache da conta de conversão; continuam classificadas nas listas do núcleo em read-only.ts.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  ATTRIBUTION_MODEL_ALIASES,
  CONVERSION_CATEGORIES,
  CONVERSION_CATEGORY_ALIASES,
  CONVERSION_TYPE_ALIASES,
  DATE_RANGE_DESC,
  DAYS_DESC,
  attributionModelSchema,
  buildDateClause,
  checkCustomerAccess,
  conversionTypeSchema,
  dateRangeSchema,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  num,
  resolveEnumAlias,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;

const fail = (message: string) => ({ content: [text(message)], isError: true });
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Enums (v25) ──────────────────────────────────────────────────────

/**
 * ConversionActionCategory da v25 (enums/conversion_action_category.proto), incluindo
 * YOUTUBE_FOLLOW_ON_VIEWS (=24), que o schema compartilhado do tool-kit ainda não traz.
 */
export const CONVERSION_CATEGORIES_V25 = [...CONVERSION_CATEGORIES, "YOUTUBE_FOLLOW_ON_VIEWS"] as const;

/** Categorias aceitas pelas tools deste lote (valores da v25 + apelidos LEAD e SIGN_UP). */
export const conversionCategoryV25Schema = z.enum([
  ...CONVERSION_CATEGORIES,
  "YOUTUBE_FOLLOW_ON_VIEWS",
  "LEAD",
  "SIGN_UP",
]);

/** ConversionOrigin da v25 (enums/conversion_origin.proto), sem UNSPECIFIED/UNKNOWN. */
export const CONVERSION_ORIGINS = [
  "WEBSITE", "GOOGLE_HOSTED", "APP", "CALL_FROM_ADS", "STORE", "YOUTUBE_HOSTED", "LOCAL_SERVICES_ADS",
] as const;
const conversionOriginSchema = z.enum(CONVERSION_ORIGINS);

/** DataDrivenModelStatus: só AVAILABLE aceita a troca para DATA_DRIVEN (ConversionActionError). */
const DDA_STATUS_TEXT: Record<string, string> = {
  STALE: "desatualizado (sem atualização há 7+ dias; vira EXPIRED aos 30)",
  EXPIRED: "expirado (sem atualização há 30+ dias, em geral por falta de volume de conversões)",
  NEVER_GENERATED: "nunca gerado (nunca houve volume suficiente num período de 30 dias)",
  UNKNOWN: "desconhecido",
  "": "não informado pela API",
};

/**
 * Tipos de chamada em que a API exige always_use_default_value=true, proíbe a janela
 * view-through e aceita click-through de 1 a 60 dias (create-conversion-actions, "Validations").
 */
export const CALL_TYPES_FIXED_VALUE = new Set(["WEBSITE_CALL", "AD_CALL"]);

/**
 * Categorias de micro-conversão: criadas como SECUNDÁRIAS por padrão. Uma combinação nova de
 * categoria × origem vira meta da conta com biddable=true (conversions/goals/customer-goals),
 * e uma ação primária de PAGE_VIEW ou ADD_TO_CART passaria a guiar o Smart Bidding de toda
 * campanha que herda as metas da conta.
 */
export const MICRO_CONVERSION_CATEGORIES = new Set(["PAGE_VIEW", "ADD_TO_CART", "BEGIN_CHECKOUT", "ENGAGEMENT"]);

const DATA_DRIVEN = "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN";

// ── Conta de conversão ───────────────────────────────────────────────

export interface ConversionCustomerInfo {
  /** Conta consultada (a do customerId da tool). */
  clientId: string;
  /** Conta onde as conversões são criadas e gerenciadas. */
  conversionCustomerId: string;
  /** true quando a conta de conversão é outra (acompanhamento de conversões entre contas). */
  crossAccount: boolean;
  status: string;
  trackingId: string;
  crossAccountTrackingId: string;
  acceptedCustomerDataTerms: boolean;
  enhancedConversionsForLeadsEnabled: boolean;
  descriptiveName: string;
  manager: boolean;
}

export const CONVERSION_TRACKING_FIELDS = [
  "customer.id",
  "customer.descriptive_name",
  "customer.manager",
  "customer.conversion_tracking_setting.google_ads_conversion_customer",
  "customer.conversion_tracking_setting.conversion_tracking_status",
  "customer.conversion_tracking_setting.conversion_tracking_id",
  "customer.conversion_tracking_setting.cross_account_conversion_tracking_id",
  "customer.conversion_tracking_setting.accepted_customer_data_terms",
  "customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled",
];

export const CONVERSION_TRACKING_QUERY = `SELECT ${CONVERSION_TRACKING_FIELDS.join(", ")} FROM customer LIMIT 1`;

export function parseConversionTracking(clientId: string, row: Row | undefined): ConversionCustomerInfo {
  const customer = (row?.customer ?? {}) as Row;
  const setting = (customer.conversionTrackingSetting ?? {}) as Row;
  const conversionCustomerId = /^customers\/(\d+)$/.exec(String(setting.googleAdsConversionCustomer ?? ""))?.[1] ?? clientId;
  return {
    clientId,
    conversionCustomerId,
    crossAccount: conversionCustomerId !== clientId,
    status: String(setting.conversionTrackingStatus ?? ""),
    trackingId: String(setting.conversionTrackingId ?? ""),
    crossAccountTrackingId: String(setting.crossAccountConversionTrackingId ?? ""),
    // bool não opcional: o JSON omite false
    acceptedCustomerDataTerms: Boolean(setting.acceptedCustomerDataTerms),
    enhancedConversionsForLeadsEnabled: Boolean(setting.enhancedConversionsForLeadsEnabled),
    descriptiveName: String(customer.descriptiveName ?? ""),
    manager: Boolean(customer.manager),
  };
}

/** Lê a conta de conversão sem cache. Outros lotes (upload de conversões) podem reusar. */
export async function resolveConversionCustomer(client: GoogleAdsClient, customerId: string): Promise<ConversionCustomerInfo> {
  const cid = customerId.replace(/-/g, "");
  const rows = await client.searchStream(cid, CONVERSION_TRACKING_QUERY);
  return parseConversionTracking(cid, rows[0]);
}

/** Cache por sessão (uma instância por registro de tools), com validade curta. */
export function createConversionCustomerCache(ttlMs = 10 * 60_000) {
  const entries = new Map<string, { at: number; info: ConversionCustomerInfo }>();
  return {
    async get(client: GoogleAdsClient, customerId: string, fresh = false): Promise<ConversionCustomerInfo> {
      const cid = customerId.replace(/-/g, "");
      const hit = entries.get(cid);
      if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.info;
      const info = await resolveConversionCustomer(client, cid);
      entries.set(cid, { at: Date.now(), info });
      return info;
    },
    remember(info: ConversionCustomerInfo) {
      entries.set(info.clientId, { at: Date.now(), info });
    },
  };
}

/** ID de acompanhamento em uso (o da MCC sobrepõe o da conta, pelo proto). */
export function effectiveTrackingId(info: ConversionCustomerInfo): string {
  return info.crossAccountTrackingId || info.trackingId;
}

export function describeConversionCustomer(info: ConversionCustomerInfo): string {
  if (!info.crossAccount) {
    return `Conta de conversão: ${info.conversionCustomerId} (a própria conta${info.status ? `; ${info.status}` : ""}).`;
  }
  return `Conta de conversão: ${info.conversionCustomerId} — acompanhamento de conversões entre contas ` +
    `(${info.status || "status não informado"}); ações, metas da conta e metas personalizadas de ${info.clientId} ` +
    `são criadas e gerenciadas lá.`;
}

/**
 * Conta onde uma gravação de conversão deve ir. Com acompanhamento entre contas, é a conta de
 * conversão — que também precisa estar liberada em ALLOWED_CUSTOMER_IDS.
 */
export function conversionWriteTarget(
  info: ConversionCustomerInfo,
  allowedIds: string[],
  hosted: boolean,
  what = "a mudança"
): { target: string; notes: string[] } | { error: string } {
  return accountTarget(info.conversionCustomerId, info, allowedIds, hosted, what);
}

function accountTarget(
  target: string,
  info: ConversionCustomerInfo,
  allowedIds: string[],
  hosted: boolean,
  what: string
): { target: string; notes: string[] } | { error: string } {
  if (target === info.clientId) return { target, notes: [] };
  const blocked = checkCustomerAccess(target, allowedIds, hosted);
  if (blocked) {
    return {
      error:
        `Nada foi enviado: ${what} precisa ser feita na conta ${target}, que gerencia as conversões de ${info.clientId} ` +
        `(acompanhamento de conversões entre contas), e ${target} não está em ALLOWED_CUSTOMER_IDS. ` +
        `Inclua ${target} no allowlist (ou use "*") ou faça a mudança pela interface do Google Ads.`,
    };
  }
  const notes = [
    `A gravação vai para a conta ${target}, não para ${info.clientId}: a API exige a conta que gerencia as conversões ` +
      "(acompanhamento de conversões entre contas).",
  ];
  if (info.status === "CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER") {
    notes.push(
      `A conta de conversão ${target} é uma MCC diferente da do login (login-customer-id). Se a API recusar por ` +
        "permissão, a mudança precisa ser feita com o login dessa MCC."
    );
  }
  return { target, notes };
}

/**
 * Ação compartilhada: a dona é outra conta (a conta de conversão, em geral uma MCC) ou a própria
 * conta consultada é uma MCC. Com acompanhamento de conversões entre contas, a ação da MCC é usada
 * por todas as contas cliente que têm essa MCC como conta de conversão — editá-la muda os lances e a
 * coluna "Conversões" de todas elas. Devolve o aviso em PT-BR, ou null se a ação é só da conta.
 */
export function sharedActionScope(target: string, info: ConversionCustomerInfo): string | null {
  if (target !== info.clientId) {
    const role = target === info.conversionCustomerId ? `a conta de conversão de ${info.clientId}` : `não ${info.clientId}`;
    return (
      `Ação compartilhada: pertence à conta ${target} (${role}; acompanhamento de conversões entre contas). ` +
      `A mudança vale para TODAS as contas que usam ${target} como conta de conversão, não só ${info.clientId} — ` +
      "muda os lances e a coluna 'Conversões' de todas elas."
    );
  }
  if (info.manager) {
    return (
      `Ação compartilhada: pertence à MCC ${target}. Com acompanhamento de conversões entre contas, ela é usada ` +
      `por todas as contas cliente que têm ${target} como conta de conversão — a mudança muda os lances e a ` +
      "coluna 'Conversões' de todas elas."
    );
  }
  return null;
}

/**
 * Motivos que exigem confirm: true em update_conversion_action. HIDDEN e REMOVED param de registrar
 * conversões (enums/conversion_action_status.proto); HIDDEN ainda tira a ação da interface.
 * newStatus só vem quando o status de fato muda.
 */
export function confirmReasons(current: ActionView, newStatus: string | undefined, shared: string | null): string[] {
  const reasons: string[] = [];
  if (newStatus === "HIDDEN") {
    reasons.push(
      `status ${current.status || "(vazio)"} → HIDDEN: a ação para de registrar conversões (as que acontecerem enquanto ` +
      "estiver oculta não são registradas) e some da interface do Google Ads — quem abrir a conta não vê a ação nem " +
      "consegue reativá-la por lá."
    );
  } else if (newStatus === "REMOVED") {
    reasons.push(
      `status ${current.status || "(vazio)"} → REMOVED: remove a ação — ela para de registrar conversões e sai das metas.`
    );
  }
  if ((newStatus === "HIDDEN" || newStatus === "REMOVED") && current.status === "ENABLED" && current.primary_for_goal) {
    reasons.push(
      `A ação é PRIMÁRIA (${current.category || "sem categoria"}): as campanhas que otimizam para essa meta perdem esse sinal de lance.`
    );
  }
  if (shared) reasons.push(shared);
  return reasons;
}

// ── Regras por tipo (create-conversion-actions, "Validations") ────────

export interface TypeRuleInput {
  alwaysUseDefaultValue?: boolean;
  viewThroughLookbackWindowDays?: number;
  clickThroughLookbackWindowDays?: number;
  phoneCallDurationSeconds?: number;
}

export function checkConversionTypeRules(type: string, input: TypeRuleInput): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fixedValueCall = CALL_TYPES_FIXED_VALUE.has(type);
  const isInt = (value: number) => Number.isInteger(value);

  if (input.alwaysUseDefaultValue === false && fixedValueCall) {
    errors.push(`${type}: a API exige alwaysUseDefaultValue=true neste tipo (false é recusado com INVALID_VALUE).`);
  }
  const view = input.viewThroughLookbackWindowDays;
  if (view !== undefined) {
    if (fixedValueCall) {
      errors.push(`${type}: viewThroughLookbackWindowDays não pode ser definido em AD_CALL nem WEBSITE_CALL (VALUE_MUST_BE_UNSET).`);
    } else if (!isInt(view) || view < 1 || view > 30) {
      errors.push(`viewThroughLookbackWindowDays=${view}: use um inteiro de 1 a 30.`);
    }
  }
  const click = input.clickThroughLookbackWindowDays;
  if (click !== undefined) {
    const max = fixedValueCall ? 60 : 90;
    if (!isInt(click) || click < 1 || click > max) {
      errors.push(`clickThroughLookbackWindowDays=${click}: para ${type} use um inteiro de 1 a ${max}.`);
    } else if (!fixedValueCall && click > 30) {
      warnings.push(
        `clickThroughLookbackWindowDays=${click}: a documentação da API cita [1,30] para a maioria dos tipos e a ` +
          "Central de Ajuda aceita 30, 60 ou 90 dias conforme a origem. Se a API recusar (RangeError.TOO_HIGH), use até 30."
      );
    }
  }
  const phone = input.phoneCallDurationSeconds;
  if (phone !== undefined) {
    if (!/CALL/.test(type)) {
      errors.push(`phoneCallDurationSeconds só vale para ações de chamada; ${type} não é (a API recusa com VALUE_MUST_BE_UNSET).`);
    } else if (!isInt(phone) || phone < 0 || phone > 10000) {
      errors.push(`phoneCallDurationSeconds=${phone}: use um inteiro de 0 a 10000.`);
    }
  }
  return { errors, warnings };
}

/**
 * include_in_conversions_metric é imutável na API (FieldError.IMMUTABLE_FIELD em create e
 * update). O parâmetro continua no schema para não ser descartado em silêncio: vira primary.
 */
export function resolvePrimaryFlag(
  primary: boolean | undefined,
  includeInConversionsMetric: boolean | undefined
): { value: boolean | undefined; notices: string[] } | { error: string } {
  if (includeInConversionsMetric === undefined) return { value: primary, notices: [] };
  if (primary !== undefined && primary !== includeInConversionsMetric) {
    return {
      error:
        "Nada foi enviado: includeInConversionsMetric e primary divergem. A API não aceita gravar " +
        "include_in_conversions_metric (campo imutável); quem decide se a ação entra na coluna 'Conversões' e nos " +
        "lances é primary (primary_for_goal). Envie só primary.",
    };
  }
  return {
    value: includeInConversionsMetric,
    notices: [
      `includeInConversionsMetric=${includeInConversionsMetric} foi traduzido para primary=${includeInConversionsMetric}: ` +
        "include_in_conversions_metric é somente leitura na API (IMMUTABLE_FIELD).",
    ],
  };
}

// ── Erros da API em PT-BR ────────────────────────────────────────────

const ERROR_HINTS: Array<[RegExp, string]> = [
  [/include_in_conversions_metric|IMMUTABLE_FIELD|immutable/i,
    "Campo imutável: type e app_id só na criação; include_in_conversions_metric não é gravável — use primary (primary_for_goal)."],
  [/DATA_DRIVEN_MODEL_WAS_NEVER_GENERATED|never been generated/i,
    "O modelo baseado em dados nunca foi gerado para esta ação (falta volume). Use LAST_CLICK até haver volume."],
  [/DATA_DRIVEN_MODEL_EXPIRED|model is expired/i,
    "O modelo baseado em dados expirou (30+ dias sem atualização). Use LAST_CLICK."],
  [/DATA_DRIVEN_MODEL_STALE|model is stale/i,
    "O modelo baseado em dados está desatualizado (STALE). A API só aceita DATA_DRIVEN com status AVAILABLE."],
  [/DATA_DRIVEN_MODEL_UNKNOWN|newly added|model is unavailable/i,
    "O modelo baseado em dados ainda não está disponível (ação nova ou sem modelo). Use LAST_CLICK por enquanto."],
  [/RULE_BASED/i, "Modelos baseados em regras foram desligados; só DATA_DRIVEN e LAST_CLICK são aceitos."],
  [/DUPLICATE_NAME|name already exists/i, "Já existe uma ação com esse nome na conta de conversão. Escolha outro nome."],
  [/CREATION_NOT_SUPPORTED/i, "Este tipo de ação não pode ser criado pela API (crie pela interface ou pelo GA4)."],
  [/UPDATE_NOT_SUPPORTED/i, "Esta ação não pode ser alterada pela API (ações do sistema, GA4/Firebase têm campos fixos)."],
  [/VALUE_MUST_BE_UNSET|must be unset/i,
    "Campo não permitido para este tipo: view-through não vale em AD_CALL/WEBSITE_CALL e a duração da ligação só vale em ações de chamada."],
  [/TOO_HIGH|TOO_LOW|too high|too low/i,
    "Valor fora do intervalo: view-through 1–30 dias; click-through 1–60 em chamadas e, na maioria dos tipos, 1–30."],
  [/INVALID_VALUE/i, "Valor recusado: em WEBSITE_CALL e AD_CALL, alwaysUseDefaultValue precisa ser true."],
  [/NO_CONVERSION_ACTION_FOUND|RESOURCE_NOT_FOUND|not found/i,
    "Recurso não encontrado nesta conta. Com acompanhamento de conversões entre contas, ações e metas vivem na conta de conversão (veja get_conversion_tracking_settings)."],
  [/USER_PERMISSION_DENIED|PERMISSION_DENIED|doesn't have permission|does not have permission/i,
    "Sem permissão na conta usada. Com conversões gerenciadas por uma MCC, o login-customer-id precisa ter acesso a ela."],
  [/CONVERSION_ACTION_NOT_ENABLED|is not enabled/i, "A meta personalizada só aceita ações ENABLED."],
  [/CANNOT_REMOVE_LINKED_CUSTOM_CONVERSION_GOAL|linked to a campaign/i,
    "A meta personalizada está em uso por campanha(s). Troque a meta dessas campanhas (set_campaign_goal_config) antes de remover."],
  [/CUSTOM_GOAL_DUPLICATE_NAME/i, "Já existe uma meta personalizada com esse nome."],
  [/DUPLICATE_CONVERSION_ACTION_LIST|same conversion action list/i, "Já existe uma meta personalizada com exatamente essas ações."],
  [/NON_BIDDABLE_CONVERSION_ACTION_NOT_ELIGIBLE_FOR_CUSTOM_GOAL|cannot be biddable/i,
    "Há ação de um tipo que não pode guiar lances; tire-a da meta personalizada."],
  [/CUSTOM_GOAL_DOES_NOT_BELONG_TO_GOOGLE_ADS_CONVERSION_CUSTOMER|does not belong/i,
    "A meta personalizada precisa ser da conta de conversão da campanha."],
  [/PERFORMANCE_MAX_CAMPAIGN_CANNOT_USE_CUSTOM_GOAL_WITH_STORE_SALES/i,
    "Performance Max não aceita meta personalizada com vendas na loja (STORE_SALE)."],
  [/STORE_SALE_STORE_VISIT_CANNOT_BE_BOTH_INCLUDED/i, "STORE_SALE e STORE_VISIT não podem estar juntas nas metas da campanha."],
  [/CANNOT_USE_STORE_SALE_GOAL_FOR_PERFORMANCE_MAX_CAMPAIGN/i, "Performance Max não aceita meta de campanha STORE_SALE incluída."],
  [/SEARCH_ADS_360/i, "Campanha gerenciada pelo Search Ads 360 com metas unificadas: altere pelo SA360."],
  [/EMPTY_CONVERSION_GOALS/i, "A campanha ficaria sem nenhuma meta de conversão ativa."],
];

export function explainConversionError(message: string): string {
  const hints = ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => `- ${hint}`);
  return hints.length ? `${message}\nO que fazer:\n${hints.join("\n")}` : message;
}

// ── Leitura de ações ─────────────────────────────────────────────────

export const ACTION_FIELDS = [
  "conversion_action.id",
  "conversion_action.name",
  "conversion_action.resource_name",
  "conversion_action.type",
  "conversion_action.category",
  "conversion_action.origin",
  "conversion_action.status",
  "conversion_action.primary_for_goal",
  "conversion_action.include_in_conversions_metric",
  "conversion_action.owner_customer",
  "conversion_action.counting_type",
  "conversion_action.attribution_model_settings.attribution_model",
  "conversion_action.attribution_model_settings.data_driven_model_status",
  "conversion_action.value_settings.default_value",
  "conversion_action.value_settings.default_currency_code",
  "conversion_action.value_settings.always_use_default_value",
  "conversion_action.click_through_lookback_window_days",
  "conversion_action.view_through_lookback_window_days",
  "conversion_action.phone_call_duration_seconds",
  "conversion_action.google_analytics_4_settings.property_id",
  "conversion_action.google_analytics_4_settings.property_name",
  "conversion_action.google_analytics_4_settings.event_name",
].join(", ");

const customerIdOf = (resourceName: unknown) => /^customers\/(\d+)/.exec(String(resourceName ?? ""))?.[1] ?? "";
const optionalNumber = (value: unknown) => (value === undefined || value === null || value === "" ? null : num(value));

export interface ActionView {
  id: string;
  name: string;
  type: string;
  category: string;
  origin: string;
  status: string;
  primary_for_goal: boolean;
  include_in_conversions_metric: boolean | null;
  owner_customer_id: string;
  counting_type: string;
  attribution_model: string;
  data_driven_model_status: string;
  default_value: number | null;
  default_currency_code: string;
  always_use_default_value: boolean;
  click_through_lookback_window_days: number | null;
  view_through_lookback_window_days: number | null;
  phone_call_duration_seconds: number | null;
  ga4_property: string;
  ga4_event_name: string;
}

export function actionView(row: Row): ActionView {
  const action = (row.conversionAction ?? {}) as Row;
  const attribution = (action.attributionModelSettings ?? {}) as Row;
  const value = (action.valueSettings ?? {}) as Row;
  const ga4 = (action.googleAnalytics4Settings ?? {}) as Row;
  return {
    id: String(action.id ?? ""),
    name: String(action.name ?? ""),
    type: String(action.type ?? ""),
    category: String(action.category ?? ""),
    origin: String(action.origin ?? ""),
    status: String(action.status ?? ""),
    // optional bool: sem valor = true (padrão documentado no proto)
    primary_for_goal: action.primaryForGoal === undefined ? true : Boolean(action.primaryForGoal),
    include_in_conversions_metric: action.includeInConversionsMetric === undefined ? null : Boolean(action.includeInConversionsMetric),
    owner_customer_id: customerIdOf(action.ownerCustomer),
    counting_type: String(action.countingType ?? ""),
    attribution_model: String(attribution.attributionModel ?? ""),
    data_driven_model_status: String(attribution.dataDrivenModelStatus ?? ""),
    default_value: optionalNumber(value.defaultValue),
    default_currency_code: String(value.defaultCurrencyCode ?? ""),
    always_use_default_value: Boolean(value.alwaysUseDefaultValue),
    click_through_lookback_window_days: optionalNumber(action.clickThroughLookbackWindowDays),
    view_through_lookback_window_days: optionalNumber(action.viewThroughLookbackWindowDays),
    phone_call_duration_seconds: optionalNumber(action.phoneCallDurationSeconds),
    ga4_property: ga4.propertyId ? `${String(ga4.propertyName ?? "")} (${String(ga4.propertyId)})`.trim() : "",
    ga4_event_name: String(ga4.eventName ?? ""),
  };
}

const idList = (ids: string[]) => ids.join(", ");

function normalizeIds(raw: unknown, label: string): { ids: string[] } | { error: string } {
  // ensureArray: clientes MCP que mandam o array serializado como string JSON
  const ids = [...new Set(ensureArray<unknown>(raw).map((id) => String(id).trim()).filter(Boolean))];
  const bad = ids.filter((id) => !/^\d+$/.test(id));
  if (bad.length) return { error: `${label}: IDs devem ser numéricos — inválidos: ${bad.join(", ")}. Nada foi enviado.` };
  return { ids };
}

// ── Metas ────────────────────────────────────────────────────────────

const ACCOUNT_GOALS_QUERY =
  "SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal";

interface GoalPair { category: string; origin: string; biddable: boolean }

function goalPairs(rows: Row[], key: "customerConversionGoal" | "campaignConversionGoal"): GoalPair[] {
  return rows.map((row) => {
    const goal = (row[key] ?? {}) as Row;
    return { category: String(goal.category ?? ""), origin: String(goal.origin ?? ""), biddable: Boolean(goal.biddable) };
  });
}

const pairKey = (category: string, origin: string) => `${category}~${origin}`;
const goalLabel = (biddable: boolean) => (biddable ? "lance" : "observação");

/** Conta de onde ler metas da conta e metas personalizadas: a de conversão, se liberada. */
function goalsReadAccount(info: ConversionCustomerInfo, allowedIds: string[], hosted: boolean): { account: string; note?: string } {
  if (!info.crossAccount) return { account: info.clientId };
  if (!checkCustomerAccess(info.conversionCustomerId, allowedIds, hosted)) return { account: info.conversionCustomerId };
  return {
    account: info.clientId,
    note:
      `As metas da conta e as metas personalizadas vivem na conta de conversão ${info.conversionCustomerId}, fora de ` +
      `ALLOWED_CUSTOMER_IDS; o que aparece aqui foi lido em ${info.clientId} e pode não refletir a configuração efetiva.`,
  };
}

// ── Tag (tag_snippets) ───────────────────────────────────────────────

interface Snippet { type: string; page_format: string; global_site_tag: string; event_snippet: string }

function snippetsOf(row: Row | undefined): Snippet[] {
  const action = (row?.conversionAction ?? {}) as Row;
  return ((action.tagSnippets as Row[] | undefined) ?? []).map((s) => ({
    type: String(s.type ?? ""),
    page_format: String(s.pageFormat ?? ""),
    global_site_tag: String(s.globalSiteTag ?? ""),
    event_snippet: String(s.eventSnippet ?? ""),
  }));
}

/** send_to 'AW-CONVERSION_ID/CONVERSION_LABEL' (formato da Central de Ajuda do Google Ads). */
export function parseSendTo(snippet: string | undefined): { send_to: string; conversion_id: string; conversion_label: string } | null {
  const match = /AW-(\d+)\/([A-Za-z0-9_-]+)/.exec(snippet ?? "");
  return match ? { send_to: `AW-${match[1]}/${match[2]}`, conversion_id: `AW-${match[1]}`, conversion_label: match[2] } : null;
}

/** Tipo de snippet por tipo de ação e gatilho. */
function snippetTypeFor(actionType: string, trigger: "PAGE_LOAD" | "CLICK"): string | null {
  if (actionType === "WEBPAGE") return trigger === "CLICK" ? "WEBPAGE_ONCLICK" : "WEBPAGE";
  if (actionType === "CLICK_TO_CALL") return "CLICK_TO_CALL";
  if (actionType === "WEBSITE_CALL") return "WEBSITE_CALL";
  return null;
}

function installSteps(snippetType: string, category: string, currency: string): string[] {
  const steps = [
    "1. Google tag (global_site_tag): uma vez por site, no <head> de todas as páginas. Se o site já tem o Google tag " +
      "(gtag.js) do mesmo ID AW-, não duplique.",
  ];
  if (snippetType === "WEBPAGE") {
    steps.push("2. Event snippet: só na página de confirmação (ex.: obrigado/pedido concluído), depois do Google tag.");
  } else if (snippetType === "WEBPAGE_ONCLICK") {
    steps.push("2. Event snippet: define gtag_report_conversion(url); chame-a no onclick do botão/link (ex.: onclick=\"return gtag_report_conversion('https://…')\").");
  } else if (snippetType === "CLICK_TO_CALL") {
    steps.push("2. Event snippet: chame a função no clique do número de telefone (link tel:) na versão mobile.");
  } else if (snippetType === "WEBSITE_CALL") {
    steps.push("2. Snippet de chamada: substitui o número do site por um número de encaminhamento do Google; instale nas páginas que mostram o telefone.");
  }
  steps.push(
    "3. GTM: tag 'Acompanhamento de conversões do Google Ads' com ID de conversão = número após 'AW-' e " +
      "Rótulo de conversão = conversion_label; mais o 'Vinculador de conversões' em todas as páginas."
  );
  if (category === "PURCHASE" || category === "SUBSCRIBE_PAID" || category === "STORE_SALE") {
    steps.push(
      `4. Compra: preencha 'value' (valor do pedido), 'currency' (${currency || "moeda da conta"}) e 'transaction_id' ` +
        "(ID único do pedido — evita contagem duplicada)."
    );
  }
  return steps;
}

// ── Registro ─────────────────────────────────────────────────────────

export function registerConversionsCoreTools(ctx: ToolContext): void {
  const { mcp, getClient, allowedCustomerIds, hosted } = ctx;
  const tracking = createConversionCustomerCache();

  const badCustomerId = (cid: string) =>
    /^\d+$/.test(cid) ? null : fail(`customerId inválido: "${cid}" (use os 10 dígitos, com ou sem hífens). Nada foi enviado.`);

  // ════════════════════════════════════════════════════════════════════
  // Leitura
  // ════════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "get_conversion_tracking_settings",
    {
      description: [
        "Configuração de acompanhamento de conversões da conta (customer.conversion_tracking_setting).",
        "READ OPERATION.",
        "",
        "Mostra a conta de conversão (google_ads_conversion_customer): com acompanhamento de conversões entre",
        "contas (MCC), ações, metas da conta e metas personalizadas são criadas e gerenciadas nessa conta, não",
        "na conta cliente. Também: status, ID de conversão (AW-) em uso, termos de dados do cliente, conversões",
        "otimizadas para leads e o Google tag da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      const client = getClient();
      const rows = await client.searchStream(
        cid,
        `SELECT ${CONVERSION_TRACKING_FIELDS.join(", ")}, customer.remarketing_setting.google_global_site_tag FROM customer LIMIT 1`
      );
      const info = parseConversionTracking(cid, rows[0]);
      tracking.remember(info);
      const remarketing = (((rows[0]?.customer ?? {}) as Row).remarketingSetting ?? {}) as Row;
      const trackingId = effectiveTrackingId(info);
      const conversionAccountAllowed = !info.crossAccount || !checkCustomerAccess(info.conversionCustomerId, allowedCustomerIds, hosted);
      const view = {
        conta: info.clientId,
        nome: info.descriptiveName,
        mcc: info.manager,
        conta_de_conversao: info.conversionCustomerId,
        acompanhamento_entre_contas: info.crossAccount,
        conta_de_conversao_liberada_no_allowlist: conversionAccountAllowed,
        conversion_tracking_status: info.status,
        conversion_tracking_id: info.trackingId || null,
        cross_account_conversion_tracking_id: info.crossAccountTrackingId || null,
        id_de_conversao_em_uso: trackingId ? `AW-${trackingId}` : null,
        accepted_customer_data_terms: info.acceptedCustomerDataTerms,
        enhanced_conversions_for_leads_enabled: info.enhancedConversionsForLeadsEnabled,
        google_global_site_tag: remarketing.googleGlobalSiteTag ?? null,
      };
      const notes = [describeConversionCustomer(info)];
      if (info.status === "NOT_CONVERSION_TRACKED") notes.push("A conta não usa acompanhamento de conversões.");
      if (!conversionAccountAllowed) {
        notes.push(`A conta de conversão ${info.conversionCustomerId} não está em ALLOWED_CUSTOMER_IDS: criar/editar conversões e metas da conta será recusado.`);
      }
      return { content: [text(`${notes.join("\n")}\n\n${formatJson(view)}`)] };
    }
  );

  mcp.registerTool(
    "list_conversion_actions",
    {
      description: [
        "List conversion actions (ações de conversão) da conta.",
        "READ OPERATION.",
        "",
        "Por ação: tipo, categoria, origem, status, primary_for_goal (PRIMÁRIA = entra na coluna 'Conversões' e",
        "nos lances; SECUNDÁRIA = só observação), include_in_conversions_metric (somente leitura), conta dona",
        "(owner_customer — com acompanhamento entre contas, a MCC), contagem, atribuição e status do modelo",
        "baseado em dados, valor padrão, janelas e propriedade/evento do GA4.",
        "Por padrão omite as REMOVED. Tag de instalação: get_conversion_tag. Auditoria: audit_conversion_tracking.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        status: z.enum(["ENABLED", "HIDDEN", "REMOVED"]).optional()
          .describe("Filtra por status. Default: todas menos REMOVED. HIDDEN = eventos do GA4 vinculados e não importados."),
        format: formatSchema,
      },
    },
    async ({ customerId, status, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      const client = getClient();
      const where = status ? `conversion_action.status = '${status}'` : "conversion_action.status != 'REMOVED'";
      const rows = await client.searchStream(
        cid,
        `SELECT ${ACTION_FIELDS} FROM conversion_action WHERE ${where} ORDER BY conversion_action.name`
      );
      const actions = rows.map(actionView);
      if (format === "table") return { content: [text(formatAsTable(actions as unknown as Row[]))] };
      if (format === "csv") return { content: [text(formatAsCsv(actions as unknown as Row[]))] };
      let accountLine: string;
      try {
        accountLine = describeConversionCustomer(await tracking.get(client, cid));
      } catch (err) {
        accountLine = `Conta de conversão não lida: ${errorMessage(err)}`;
      }
      const managedElsewhere = actions.filter((a) => a.owner_customer_id && a.owner_customer_id !== cid).length;
      return {
        content: [text(
          `${actions.length} conversion action(s).\n${accountLine}` +
          (managedElsewhere ? `\n${managedElsewhere} ação(ões) pertencem a outra conta (owner_customer_id): edições vão para ela.` : "") +
          `\n\n${formatJson(actions)}`
        )],
      };
    }
  );

  mcp.registerTool(
    "get_conversion_tag",
    {
      description: [
        "Tag de instalação de uma ação de conversão: Google tag, event snippet, ID de conversão (AW-) e rótulo.",
        "READ OPERATION.",
        "",
        "Devolve o send_to 'AW-XXXX/rótulo' separado em ID e rótulo (os campos do GTM) e os passos de instalação",
        "(transaction_id, value, currency em compras). trigger: PAGE_LOAD (página de confirmação) ou CLICK",
        "(clique em botão). Ações importadas (UPLOAD_*), de chamada do anúncio (AD_CALL) e do GA4 não têm tag.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionActionId: z.string().describe("ID da ação (list_conversion_actions)."),
        pageFormat: z.enum(["HTML", "AMP"]).optional().describe("Formato da página. Default: HTML."),
        trigger: z.enum(["PAGE_LOAD", "CLICK"]).optional().describe("Quando a conversão dispara. Default: PAGE_LOAD."),
      },
    },
    async ({ customerId, conversionActionId, pageFormat, trigger }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (!/^\d+$/.test(conversionActionId)) return fail(`conversionActionId deve ser numérico, recebido "${conversionActionId}".`);
      const client = getClient();
      const rows = await client.searchStream(
        cid,
        `SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.category,
                conversion_action.status, conversion_action.owner_customer, conversion_action.value_settings.default_currency_code,
                conversion_action.tag_snippets
         FROM conversion_action WHERE conversion_action.id = ${conversionActionId}`
      );
      if (!rows.length) return fail(`A ação ${conversionActionId} não existe na conta ${cid}. Use list_conversion_actions.`);
      const action = actionView(rows[0]);
      const snippets = snippetsOf(rows[0]);
      const wantedType = snippetTypeFor(action.type, trigger ?? "PAGE_LOAD");
      if (!wantedType) {
        return fail(
          `A ação "${action.name}" é do tipo ${action.type}: não usa tag no site ` +
          (action.type.startsWith("UPLOAD") ? "(conversões importadas por API/planilha)." :
            action.type.startsWith("GOOGLE_ANALYTICS_4") ? "(vem do GA4 — o evento é configurado no GA4)." :
              action.type === "AD_CALL" ? "(chamadas pelo anúncio são medidas pelo Google)." : "(sem snippet para este tipo).")
        );
      }
      const format = pageFormat ?? "HTML";
      const chosen = snippets.find((s) => s.type === wantedType && s.page_format === format)
        ?? snippets.find((s) => s.type === wantedType);
      if (!chosen) {
        return fail(
          `A API não devolveu snippet ${wantedType}/${format} para a ação ${conversionActionId}. ` +
          `Disponíveis: ${snippets.map((s) => `${s.type}/${s.page_format}`).join(", ") || "nenhum"}.`
        );
      }
      const parsed = parseSendTo(chosen.event_snippet) ?? parseSendTo(chosen.global_site_tag);
      const notes: string[] = [];
      if (action.status !== "ENABLED") notes.push(`Atenção: a ação está ${action.status} — conversões não são registradas enquanto não estiver ENABLED.`);
      try {
        const info = await tracking.get(client, cid);
        const expected = effectiveTrackingId(info);
        if (parsed && expected && parsed.conversion_id !== `AW-${expected}`) {
          notes.push(`O ID do snippet (${parsed.conversion_id}) difere do ID de conversão em uso na conta (AW-${expected}). Confira a conta de conversão.`);
        }
        if (info.crossAccount) notes.push(describeConversionCustomer(info));
      } catch (err) {
        notes.push(`Não foi possível conferir o ID de conversão da conta: ${errorMessage(err)}`);
      }
      const view = {
        acao: { id: action.id, name: action.name, type: action.type, category: action.category, status: action.status },
        snippet: { type: chosen.type, page_format: chosen.page_format },
        ...(parsed ?? { send_to: null, conversion_id: null, conversion_label: null }),
        gtm: parsed ? { id_de_conversao: parsed.conversion_id.replace(/^AW-/, ""), rotulo_de_conversao: parsed.conversion_label } : null,
        instalacao: installSteps(chosen.type, action.category, action.default_currency_code),
        global_site_tag: chosen.global_site_tag,
        event_snippet: chosen.event_snippet,
        outros_snippets: snippets.filter((s) => s !== chosen).map((s) => `${s.type}/${s.page_format}`),
      };
      return { content: [text((notes.length ? `${notes.join("\n")}\n\n` : "") + formatJson(view))] };
    }
  );

  mcp.registerTool(
    "list_conversion_goals",
    {
      description: [
        "Metas de conversão: o que cada campanha usa para os lances.",
        "READ OPERATION.",
        "",
        "- metas da conta (CustomerConversionGoal, categoria × origem, biddable) com as ações de cada uma;",
        "- metas personalizadas (CustomConversionGoal);",
        "- por campanha: goal_config_level (CUSTOMER = herda as metas da conta; CAMPAIGN = metas próprias),",
        "  meta personalizada em uso, metas da campanha e as ações que de fato guiam o lance.",
        "Com acompanhamento entre contas, as metas da conta e as personalizadas são lidas na conta de conversão.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só esta campanha. Default: todas as não removidas."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const client = getClient();
      const info = await tracking.get(client, cid);
      const source = goalsReadAccount(info, allowedCustomerIds, hosted);
      /* Metas da conta e personalizadas vivem na conta de conversão; se a leitura lá falhar
         (ex.: MCC fora do alcance do login-customer-id), cai para a conta cliente e avisa. */
      const readGoalsSource = async (query: string): Promise<Row[]> => {
        try {
          return await client.searchStream(source.account, query);
        } catch (err) {
          if (source.account === cid) throw err;
          source.note = `Leitura na conta de conversão ${source.account} falhou (${errorMessage(err)}); lido em ${cid}, pode não refletir a configuração efetiva.`;
          source.account = cid;
          return client.searchStream(cid, query);
        }
      };

      const accountGoals = goalPairs(await readGoalsSource(ACCOUNT_GOALS_QUERY), "customerConversionGoal");
      const actions = (await client.searchStream(
        cid,
        `SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.origin,
                conversion_action.status, conversion_action.primary_for_goal
         FROM conversion_action WHERE conversion_action.status = 'ENABLED'`
      )).map(actionView);
      const customGoalRows = await readGoalsSource(
        `SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status,
                custom_conversion_goal.conversion_actions, custom_conversion_goal.resource_name
         FROM custom_conversion_goal WHERE custom_conversion_goal.status = 'ENABLED'`
      );
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const configRows = await client.searchStream(
        cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal
         FROM conversion_goal_campaign_config WHERE campaign.status != 'REMOVED'${campaignFilter}`
      );
      const campaignGoalRows = await client.searchStream(
        cid,
        `SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
         FROM campaign_conversion_goal WHERE campaign.status != 'REMOVED'${campaignFilter}`
      );

      const actionsByPair = new Map<string, ActionView[]>();
      for (const action of actions) {
        const key = pairKey(action.category, action.origin);
        actionsByPair.set(key, [...(actionsByPair.get(key) ?? []), action]);
      }
      const actionName = new Map(actions.map((a) => [a.id, a.name]));
      const customGoals = customGoalRows.map((row) => {
        const goal = (row.customConversionGoal ?? {}) as Row;
        const ids = ((goal.conversionActions as string[] | undefined) ?? []).map((rn) => String(rn).split("/").pop() ?? "");
        return {
          id: String(goal.id ?? ""),
          name: String(goal.name ?? ""),
          resource_name: String(goal.resourceName ?? ""),
          acoes: ids.map((id) => ({ id, name: actionName.get(id) ?? null })),
        };
      });
      const customByRn = new Map(customGoals.map((g) => [g.resource_name, g]));
      const customById = new Map(customGoals.map((g) => [g.id, g]));

      const biddableActions = (pairs: GoalPair[]) =>
        pairs.filter((p) => p.biddable)
          .flatMap((p) => (actionsByPair.get(pairKey(p.category, p.origin)) ?? []).filter((a) => a.primary_for_goal))
          .map((a) => a.name);

      const goalsByCampaign = new Map<string, GoalPair[]>();
      for (const row of campaignGoalRows) {
        const id = String(((row.campaign ?? {}) as Row).id ?? "");
        goalsByCampaign.set(id, [...(goalsByCampaign.get(id) ?? []), ...goalPairs([row], "campaignConversionGoal")]);
      }
      const campaigns = configRows.map((row) => {
        const campaign = (row.campaign ?? {}) as Row;
        const config = (row.conversionGoalCampaignConfig ?? {}) as Row;
        const id = String(campaign.id ?? "");
        const level = String(config.goalConfigLevel ?? "");
        const customRn = String(config.customConversionGoal ?? "");
        const custom = customRn ? customByRn.get(customRn) ?? customById.get(customRn.split("/").pop() ?? "") : undefined;
        const ownGoals = goalsByCampaign.get(id) ?? [];
        const guiding = customRn
          ? (custom?.acoes ?? []).map((a) => a.name ?? a.id)
          : biddableActions(level === "CAMPAIGN" ? ownGoals : accountGoals);
        return {
          campaign_id: id,
          campaign_name: String(campaign.name ?? ""),
          tipo: String(campaign.advertisingChannelType ?? ""),
          goal_config_level: level,
          meta_personalizada: customRn ? { resource_name: customRn, name: custom?.name ?? null } : null,
          metas_da_campanha: ownGoals.map((g) => `${g.category} (${g.origin}): ${goalLabel(g.biddable)}`),
          acoes_que_guiam_o_lance: [...new Set(guiding)],
        };
      });

      if (format === "table" || format === "csv") {
        const flat = campaigns.map((c) => ({
          ...c,
          meta_personalizada: c.meta_personalizada?.name ?? c.meta_personalizada?.resource_name ?? "",
          metas_da_campanha: c.metas_da_campanha.join(" | "),
          acoes_que_guiam_o_lance: c.acoes_que_guiam_o_lance.join(" | "),
        }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }

      const view = {
        conta_de_conversao: info.conversionCustomerId,
        metas_da_conta_lidas_em: source.account,
        metas_da_conta: accountGoals.map((g) => ({
          category: g.category,
          origin: g.origin,
          biddable: g.biddable,
          acoes_primarias: (actionsByPair.get(pairKey(g.category, g.origin)) ?? []).filter((a) => a.primary_for_goal).map((a) => a.name),
          acoes_secundarias: (actionsByPair.get(pairKey(g.category, g.origin)) ?? []).filter((a) => !a.primary_for_goal).map((a) => a.name),
        })),
        metas_personalizadas: customGoals,
        campanhas: campaigns,
      };
      const notes = [describeConversionCustomer(info)];
      if (source.note) notes.push(source.note);
      notes.push(
        "Uma ação guia o lance quando é ENABLED, primária (primary_for_goal) e a meta categoria × origem dela está " +
        "biddable no nível que a campanha usa — ou quando está na meta personalizada da campanha (aí vale mesmo secundária)."
      );
      return { content: [text(`${notes.join("\n")}\n\n${formatJson(view)}`)] };
    }
  );

  mcp.registerTool(
    "audit_conversion_tracking",
    {
      description: [
        "Auditoria do acompanhamento de conversões, com alertas por regra.",
        "READ OPERATION.",
        "",
        "Lê a configuração da conta e cada ação (com conversões do período) e aponta: ações primárias sem",
        "conversões; mais de uma compra primária (contagem dupla, ex.: GA4 + tag); compra com ONE_PER_CLICK;",
        "compra sem valor; modelo baseado em dados STALE/EXPIRED/NEVER_GENERATED; micro-conversões primárias ou",
        "metas da conta biddable de micro-conversão; conversões otimizadas para leads desligadas com importação",
        "de cliques; termos de dados do cliente não aceitos; eventos do GA4 não importados (HIDDEN); tag parada.",
        "Numa MCC (ex.: a conta de conversão no acompanhamento entre contas) a API não devolve métricas: a",
        "auditoria cobre só a configuração e avisa; o volume de conversões se audita em cada conta cliente.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        days: z.number().optional().describe(DAYS_DESC),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, days, dateRange, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail(errorMessage(err));
      }
      const client = getClient();
      const info = await tracking.get(client, cid, true);
      const actions = (await client.searchStream(
        cid,
        `SELECT ${ACTION_FIELDS} FROM conversion_action WHERE conversion_action.status != 'REMOVED' ORDER BY conversion_action.name`
      )).map(actionView);
      const stats = new Map<string, { conversions: number; conversions_value: number; all_conversions: number; all_conversions_value: number }>();
      const lastReceived = new Map<string, string>();
      const warnings: string[] = [];
      /* A API recusa métricas em conta de administrador (QueryError.REQUESTED_METRICS_FOR_MANAGER):
         numa MCC — a conta de conversão no acompanhamento entre contas — a auditoria fica só com a
         configuração, e as regras que dependem de volume não são avaliadas (em vez de virar zero). */
      let metricsAvailable = !info.manager;
      if (info.manager) {
        warnings.push(
          `A conta ${cid} é uma MCC: a API não devolve métricas em conta de administrador (REQUESTED_METRICS_FOR_MANAGER). ` +
          "Esta auditoria cobre só a configuração das ações e da conta; o volume de conversões precisa ser auditado em " +
          "cada conta cliente (audit_conversion_tracking com o customerId da conta cliente)."
        );
      } else {
        try {
          const statsRows = await client.searchStream(
            cid,
            `SELECT segments.conversion_action, metrics.conversions, metrics.conversions_value,
                    metrics.all_conversions, metrics.all_conversions_value
             FROM customer WHERE ${dateClause}`
          );
          for (const row of statsRows) {
            const id = String(((row.segments ?? {}) as Row).conversionAction ?? "").split("/").pop() ?? "";
            const m = (row.metrics ?? {}) as Row;
            const prev = stats.get(id) ?? { conversions: 0, conversions_value: 0, all_conversions: 0, all_conversions_value: 0 };
            stats.set(id, {
              conversions: prev.conversions + num(m.conversions),
              conversions_value: prev.conversions_value + num(m.conversionsValue),
              all_conversions: prev.all_conversions + num(m.allConversions),
              all_conversions_value: prev.all_conversions_value + num(m.allConversionsValue),
            });
          }
        } catch (err) {
          metricsAvailable = false;
          warnings.push(`Conversões do período por ação indisponíveis (${errorMessage(err)}); a auditoria cobre só a configuração.`);
        }
      }
      if (metricsAvailable) {
        try {
          const rows = await client.searchStream(
            cid,
            `SELECT conversion_action.id, metrics.conversion_last_received_request_date_time, metrics.conversion_last_conversion_date
             FROM conversion_action WHERE conversion_action.status = 'ENABLED'`
          );
          for (const row of rows) {
            const id = String(((row.conversionAction ?? {}) as Row).id ?? "");
            const value = String(((row.metrics ?? {}) as Row).conversionLastReceivedRequestDateTime ?? "");
            if (id && value) lastReceived.set(id, value);
          }
        } catch (err) {
          warnings.push(`Última conversão recebida por ação indisponível: ${errorMessage(err)}`);
        }
      } else {
        warnings.push(
          "Regras que dependem de métricas não foram avaliadas: PRIMARIA_SEM_CONVERSOES, TAG_PARADA e a parte de valor " +
          "de COMPRA_SEM_VALOR (conversões com valor 0)."
        );
      }
      const source = goalsReadAccount(info, allowedCustomerIds, hosted);
      let accountGoals: GoalPair[] = [];
      try {
        accountGoals = goalPairs(await client.searchStream(source.account, ACCOUNT_GOALS_QUERY), "customerConversionGoal");
      } catch (err) {
        warnings.push(`Metas da conta indisponíveis: ${errorMessage(err)}`);
      }
      if (source.note) warnings.push(source.note);

      type Flag = { severidade: "alta" | "media" | "info"; codigo: string; mensagem: string; acoes?: string[] };
      const flags: Flag[] = [];
      const label = (a: ActionView) => `${a.name} (${a.id})`;
      const enabled = actions.filter((a) => a.status === "ENABLED");
      const primary = enabled.filter((a) => a.primary_for_goal);
      const statOf = (a: ActionView) => stats.get(a.id) ?? { conversions: 0, conversions_value: 0, all_conversions: 0, all_conversions_value: 0 };

      if (info.status === "NOT_CONVERSION_TRACKED") {
        flags.push({ severidade: "alta", codigo: "SEM_ACOMPANHAMENTO", mensagem: "A conta não usa acompanhamento de conversões (NOT_CONVERSION_TRACKED): Smart Bidding sem sinal." });
      }
      if (info.crossAccount) {
        flags.push({ severidade: "info", codigo: "CONVERSOES_NA_MCC", mensagem: describeConversionCustomer(info) });
      }
      const zero = metricsAvailable ? primary.filter((a) => statOf(a).all_conversions === 0) : [];
      if (zero.length) {
        flags.push({
          severidade: "alta", codigo: "PRIMARIA_SEM_CONVERSOES",
          mensagem: "Ações primárias sem nenhuma conversão no período: tag quebrada, evento que não dispara ou ação obsoleta ainda guiando os lances.",
          acoes: zero.map(label),
        });
      }
      const purchases = primary.filter((a) => a.category === "PURCHASE");
      if (purchases.length > 1) {
        const ga4 = purchases.some((a) => a.type.startsWith("GOOGLE_ANALYTICS_4"));
        const tag = purchases.some((a) => !a.type.startsWith("GOOGLE_ANALYTICS_4"));
        flags.push({
          severidade: "alta", codigo: "COMPRA_PRIMARIA_DUPLICADA",
          mensagem: `${purchases.length} ações de compra primárias: cada venda pode ser contada mais de uma vez nos lances` +
            (ga4 && tag ? " (GA4 e tag do Google Ads ao mesmo tempo — contagem dupla clássica)." : ".") +
            " Deixe uma primária e as outras secundárias (update_conversion_action primary=false).",
          acoes: purchases.map(label),
        });
      }
      const onePerClick = enabled.filter((a) => a.category === "PURCHASE" && a.counting_type === "ONE_PER_CLICK");
      if (onePerClick.length) {
        flags.push({ severidade: "media", codigo: "COMPRA_UMA_POR_CLIQUE", mensagem: "Compra com contagem ONE_PER_CLICK: compras repetidas do mesmo clique somem. Para vendas use MANY_PER_CLICK.", acoes: onePerClick.map(label) });
      }
      const noValue = enabled.filter((a) => a.category === "PURCHASE" && (
        (a.always_use_default_value && !(num(a.default_value) > 0)) ||
        (metricsAvailable && statOf(a).all_conversions > 0 && statOf(a).all_conversions_value === 0)
      ));
      if (noValue.length) {
        flags.push({
          severidade: "media", codigo: "COMPRA_SEM_VALOR",
          mensagem: `Compra sem valor (${metricsAvailable ? "valor fixo zerado ou conversões do período com valor 0" : "valor fixo zerado"}): ROAS e Maximizar valor ficam cegos.`,
          acoes: noValue.map(label),
        });
      }
      const dda = enabled.filter((a) => a.attribution_model === DATA_DRIVEN && ["STALE", "EXPIRED", "NEVER_GENERATED"].includes(a.data_driven_model_status));
      if (dda.length) {
        flags.push({
          severidade: "media", codigo: "MODELO_DADOS_INDISPONIVEL",
          mensagem: "Atribuição baseada em dados com modelo " + [...new Set(dda.map((a) => a.data_driven_model_status))].join("/") +
            ": o modelo não está AVAILABLE (falta volume ou está parado).",
          acoes: dda.map((a) => `${label(a)}: ${a.data_driven_model_status}`),
        });
      }
      const micro = primary.filter((a) => MICRO_CONVERSION_CATEGORIES.has(a.category));
      if (micro.length) {
        flags.push({ severidade: "media", codigo: "MICRO_CONVERSAO_PRIMARIA", mensagem: "Micro-conversões primárias (visualização, carrinho, checkout, engajamento) inflam 'Conversões' e puxam o Smart Bidding para o evento errado.", acoes: micro.map(label) });
      }
      const microGoals = accountGoals.filter((g) => g.biddable && MICRO_CONVERSION_CATEGORIES.has(g.category));
      if (microGoals.length) {
        flags.push({ severidade: "media", codigo: "META_DA_CONTA_MICRO_BIDDABLE", mensagem: "Metas da conta de micro-conversão com biddable=true (set_account_conversion_goals para desligar).", acoes: microGoals.map((g) => `${g.category} (${g.origin})`) });
      }
      const uploads = enabled.filter((a) => a.type === "UPLOAD_CLICKS");
      if (uploads.length && !info.enhancedConversionsForLeadsEnabled) {
        flags.push({ severidade: "media", codigo: "ECL_DESLIGADO", mensagem: "Há importação de cliques (UPLOAD_CLICKS) e as conversões otimizadas para leads estão desligadas: leads sem gclid não são atribuídos.", acoes: uploads.map(label) });
      }
      if (!info.acceptedCustomerDataTerms && info.status !== "NOT_CONVERSION_TRACKED") {
        flags.push({ severidade: uploads.length ? "media" : "info", codigo: "TERMOS_DADOS_CLIENTE", mensagem: "Termos de dados do cliente não aceitos: conversões otimizadas e importações com dados do cliente ficam bloqueadas (aceite na interface)." });
      }
      const hiddenGa4 = actions.filter((a) => a.status === "HIDDEN" && a.type.startsWith("GOOGLE_ANALYTICS_4"));
      if (hiddenGa4.length) {
        flags.push({ severidade: "info", codigo: "GA4_NAO_IMPORTADO", mensagem: "Eventos do GA4 vinculados mas não importados (HIDDEN). Importe só os que devem virar conversão.", acoes: hiddenGa4.map((a) => `${label(a)} — ${a.ga4_event_name || "evento"}`) });
      }
      const staleTag = !metricsAvailable ? [] : primary.filter((a) => {
        const at = lastReceived.get(a.id);
        if (!at) return false;
        const time = Date.parse(at.replace(" ", "T"));
        return Number.isFinite(time) && Date.now() - time > 7 * 86_400_000;
      });
      if (staleTag.length) {
        flags.push({ severidade: "media", codigo: "TAG_PARADA", mensagem: "Ações primárias sem nenhum evento recebido há mais de 7 dias.", acoes: staleTag.map((a) => `${label(a)}: último em ${lastReceived.get(a.id)}`) });
      }

      const order = { alta: 0, media: 1, info: 2 };
      flags.sort((a, b) => order[a.severidade] - order[b.severidade]);
      const table = actions.map((a) => {
        const s = statOf(a);
        return {
          id: a.id, name: a.name, type: a.type, category: a.category, origin: a.origin, status: a.status,
          primaria: a.primary_for_goal, contagem: a.counting_type, atribuicao: a.attribution_model,
          modelo_dados: a.data_driven_model_status, valor_padrao: a.default_value, sempre_valor_padrao: a.always_use_default_value,
          // sem métricas (MCC ou leitura recusada): null, não zero
          conversoes: metricsAvailable ? round2(s.conversions) : null,
          valor_conversoes: metricsAvailable ? round2(s.conversions_value) : null,
          todas_conversoes: metricsAvailable ? round2(s.all_conversions) : null,
          valor_todas: metricsAvailable ? round2(s.all_conversions_value) : null,
          ultimo_evento: lastReceived.get(a.id) ?? null, dona: a.owner_customer_id, ga4: a.ga4_property,
        };
      });
      if (format === "table" || format === "csv") {
        const flagLines = flags.map((f) => `[${f.severidade}] ${f.codigo}: ${f.mensagem}${f.acoes ? ` → ${f.acoes.join("; ")}` : ""}`);
        const warningLines = warnings.map((w) => `[aviso] ${w}`);
        const body = format === "table" ? formatAsTable(table) : formatAsCsv(table);
        return { content: [text(`${[...warningLines, flagLines.join("\n") || "Nenhum alerta."].join("\n")}\n\n${body}`)] };
      }
      const view = {
        conta: {
          id: cid,
          conta_de_conversao: info.conversionCustomerId,
          conversion_tracking_status: info.status,
          id_de_conversao: effectiveTrackingId(info) ? `AW-${effectiveTrackingId(info)}` : null,
          accepted_customer_data_terms: info.acceptedCustomerDataTerms,
          enhanced_conversions_for_leads_enabled: info.enhancedConversionsForLeadsEnabled,
          mcc: info.manager,
          periodo: dateClause,
          metricas_lidas: metricsAvailable,
        },
        resumo: {
          acoes_ativas: enabled.length,
          primarias: primary.length,
          secundarias: enabled.length - primary.length,
          ga4_nao_importadas: hiddenGa4.length,
          alertas: { alta: flags.filter((f) => f.severidade === "alta").length, media: flags.filter((f) => f.severidade === "media").length, info: flags.filter((f) => f.severidade === "info").length },
        },
        alertas: flags,
        avisos: warnings,
        metas_da_conta: accountGoals,
        acoes: table,
      };
      return { content: [text(formatJson(view))] };
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // Escrita — ações de conversão
  // ════════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "create_conversion_action",
    {
      description: [
        "Create a conversion action for tracking.",
        "WRITE OPERATION.",
        "",
        "Criada na CONTA DE CONVERSÃO: com acompanhamento de conversões entre contas (MCC), a ação vai para a",
        "MCC que gerencia as conversões (a API exige). A resposta diz qual conta foi usada.",
        "",
        "Types (aceita apelidos, traduzidos para o enum real da API):",
        "- WEBPAGE: conversões no site (requer Google tag) — a resposta já traz o ID/rótulo da tag",
        "- UPLOAD (= UPLOAD_CLICKS): importação de conversões offline por gclid",
        "- UPLOAD_CALLS: importação de chamadas offline",
        "- PHONE_CALL (= WEBSITE_CALL): chamadas para o número exibido no site",
        "- AD_CALL: chamadas a partir do recurso de chamada do anúncio",
        "- CLICK_TO_CALL: cliques em telefone no site mobile",
        "",
        "Categorias (v25): " + CONVERSION_CATEGORIES_V25.join(", ") + ".",
        "Apelidos aceitos: LEAD → SUBMIT_LEAD_FORM, SIGN_UP → SIGNUP.",
        "",
        "PRIMÁRIA x SECUNDÁRIA (primary): primária entra na coluna 'Conversões' e nos lances das campanhas cuja",
        "meta (categoria × origem) está biddable; secundária é só observação. Micro-conversões (PAGE_VIEW,",
        "ADD_TO_CART, BEGIN_CHECKOUT, ENGAGEMENT) são criadas SECUNDÁRIAS por padrão. Uma categoria × origem nova",
        "vira meta da conta com biddable=true — a resposta informa. Metas: list_conversion_goals.",
        "",
        "Regras da API por tipo: WEBSITE_CALL/AD_CALL exigem valor fixo (alwaysUseDefaultValue=true), não",
        "aceitam view-through e aceitam click-through de 1 a 60 dias; view-through 1–30; duração da ligação só",
        "em tipos de chamada. Attribution: DATA_DRIVEN (padrão) ou LAST_CLICK.",
        "Counting: ONE_PER_CLICK (leads) ou MANY_PER_CLICK (compras). O tipo é IMUTÁVEL depois de criado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta cliente; a gravação vai para a conta de conversão dela)."),
        name: z.string().describe("Conversion action name (e.g. 'Purchase', 'Lead Form Submit')."),
        type: conversionTypeSchema.describe("Conversion type. IMUTÁVEL após a criação."),
        category: conversionCategoryV25Schema.describe("Conversion category."),
        countingType: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional().describe("How to count. Default: ONE_PER_CLICK."),
        attributionModel: attributionModelSchema.optional().describe("Attribution model. Default: DATA_DRIVEN."),
        valueSetting: z.object({
          defaultValue: z.number().optional().describe("Default conversion value."),
          alwaysUseDefaultValue: z.boolean().optional().describe("True = always use default value. False = use dynamic value from tag. WEBSITE_CALL/AD_CALL: sempre true."),
        }).optional().describe("Conversion value settings."),
        viewThroughLookbackWindowDays: z.number().optional().describe("View-through (1-30 dias). Não vale em AD_CALL/WEBSITE_CALL."),
        clickThroughLookbackWindowDays: z.number().optional().describe("Click-through: 1-60 dias em AD_CALL/WEBSITE_CALL; a documentação cita 1-30 para a maioria dos demais tipos. Default da API: 30."),
        primary: z.boolean().optional().describe("True = PRIMÁRIA (lances e coluna 'Conversões'). False = SECUNDÁRIA (observação). Default: true, exceto micro-conversões."),
        includeInConversionsMetric: z.boolean().optional().describe("OBSOLETO — a API não aceita gravar este campo (IMMUTABLE_FIELD). É traduzido para primary."),
        phoneCallDurationSeconds: z.number().optional().describe("Duração mínima da ligação (0-10000 s), só em tipos de chamada."),
      },
    },
    async ({ customerId, name, type, category, countingType, attributionModel, valueSetting, viewThroughLookbackWindowDays, clickThroughLookbackWindowDays, primary, includeInConversionsMetric, phoneCallDurationSeconds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      const cleanName = name.trim();
      if (!cleanName) return fail("name não pode ser vazio. Nada foi enviado.");

      const apiType = resolveEnumAlias(type, CONVERSION_TYPE_ALIASES);
      const apiCategory = resolveEnumAlias(category, CONVERSION_CATEGORY_ALIASES);
      const requestedAttribution = attributionModel ?? "DATA_DRIVEN";
      const apiAttribution = resolveEnumAlias(requestedAttribution, ATTRIBUTION_MODEL_ALIASES);
      const notices: string[] = [];

      const primaryChoice = resolvePrimaryFlag(primary, includeInConversionsMetric);
      if ("error" in primaryChoice) return fail(primaryChoice.error);
      notices.push(...primaryChoice.notices);
      let primaryForGoal = primaryChoice.value;
      if (primaryForGoal === undefined) {
        primaryForGoal = !MICRO_CONVERSION_CATEGORIES.has(apiCategory);
        if (!primaryForGoal) {
          notices.push(
            `${apiCategory} é micro-conversão: criada como SECUNDÁRIA (primary=false, só observação) para não guiar os lances ` +
            "de todas as campanhas. Envie primary: true se ela deve entrar nos lances."
          );
        }
      }
      const rules = checkConversionTypeRules(apiType, {
        alwaysUseDefaultValue: valueSetting?.alwaysUseDefaultValue,
        viewThroughLookbackWindowDays,
        clickThroughLookbackWindowDays,
        phoneCallDurationSeconds,
      });
      if (rules.errors.length) return fail(`Nada foi enviado — a API recusaria:\n- ${rules.errors.join("\n- ")}`);
      notices.push(...rules.warnings);

      const client = getClient();
      let target: string;
      try {
        const info = await tracking.get(client, cid);
        const resolved = conversionWriteTarget(info, allowedCustomerIds, hosted, "a criação da ação de conversão");
        if ("error" in resolved) return fail(resolved.error);
        target = resolved.target;
        notices.push(...resolved.notes);

        const sameName = (await client.searchStream(
          target,
          `SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action
           WHERE conversion_action.name = '${gaqlLiteral(cleanName)}'`
        )).map(actionView).find((a) => a.status !== "REMOVED");
        if (sameName) {
          return fail(
            `Já existe a ação "${cleanName}" (id ${sameName.id}, ${sameName.status}) na conta ${target}. Nada foi criado. ` +
            "Use update_conversion_action para alterá-la ou escolha outro nome."
          );
        }
      } catch (err) {
        return fail(`Erro ao preparar a criação: ${explainConversionError(errorMessage(err))}`);
      }

      // Pares categoria × origem que já existiam: um par novo vira meta da conta biddable=true.
      let pairsBefore: Set<string> | null = null;
      try {
        pairsBefore = new Set(goalPairs(await client.searchStream(target, ACCOUNT_GOALS_QUERY), "customerConversionGoal").map((g) => pairKey(g.category, g.origin)));
      } catch (err) {
        notices.push(`Metas da conta não lidas antes da criação: ${errorMessage(err)}`);
      }

      const fixedValueCall = CALL_TYPES_FIXED_VALUE.has(apiType);
      const convData: Row = {
        name: cleanName,
        type: apiType,
        category: apiCategory,
        countingType: countingType ?? "ONE_PER_CLICK",
        // data_driven_model_status é OUTPUT_ONLY — enviar causa erro na API.
        attributionModelSettings: { attributionModel: apiAttribution },
        status: "ENABLED",
        primaryForGoal,
      };
      let result: Row;
      try {
        if (valueSetting || fixedValueCall) {
          convData.valueSettings = {
            defaultValue: valueSetting?.defaultValue ?? 0,
            alwaysUseDefaultValue: valueSetting?.alwaysUseDefaultValue ?? fixedValueCall,
            defaultCurrencyCode: await client.getAccountCurrency(target),
          };
          if (fixedValueCall && valueSetting?.alwaysUseDefaultValue === undefined) {
            notices.push(`${apiType}: enviado alwaysUseDefaultValue=true (a API exige neste tipo).`);
          }
        }
        if (viewThroughLookbackWindowDays !== undefined) convData.viewThroughLookbackWindowDays = String(viewThroughLookbackWindowDays);
        if (clickThroughLookbackWindowDays !== undefined) convData.clickThroughLookbackWindowDays = String(clickThroughLookbackWindowDays);
        if (phoneCallDurationSeconds !== undefined) convData.phoneCallDurationSeconds = String(phoneCallDurationSeconds);
        result = await client.mutate(target, "conversionActions", [{ create: convData }]);
      } catch (err) {
        return fail(`Erro ao criar a ação na conta ${target}: ${explainConversionError(errorMessage(err))}`);
      }

      const translated: string[] = [];
      if (apiType !== type) translated.push(`type ${type} → ${apiType}`);
      if (apiCategory !== category) translated.push(`category ${category} → ${apiCategory}`);
      if (apiAttribution !== requestedAttribution) translated.push(`attribution ${requestedAttribution} → ${apiAttribution}`);
      const header =
        `Type: ${apiType} | Category: ${apiCategory} | Counting: ${countingType ?? "ONE_PER_CLICK"}\n` +
        `Attribution: ${apiAttribution} | Primary: ${primaryForGoal}\n` +
        `Conta usada: ${target}${target !== cid ? ` (conta de conversão de ${cid})` : ""}\n` +
        (translated.length ? `Traduzido para a API: ${translated.join("; ")}\n` : "");

      if (client.isDryRun) {
        return { content: [text(
          `DRY-RUN (validateOnly): a criação de "${cleanName}" foi validada, nada foi gravado.\n${header}` +
          (notices.length ? `\n${notices.map((n) => `- ${n}`).join("\n")}\n` : "") + `\n${formatJson(result)}`
        )] };
      }

      const resourceName = String(((result.results as Row[] | undefined) ?? [])[0]?.resourceName ?? "");
      const newId = /conversionActions\/(\d+)$/.exec(resourceName)?.[1];
      let tag: Row | null = null;
      if (newId) {
        try {
          const rows = await client.searchStream(
            target,
            `SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.origin,
                    conversion_action.primary_for_goal, conversion_action.tag_snippets
             FROM conversion_action WHERE conversion_action.id = ${newId}`
          );
          const created = rows[0] ? actionView(rows[0]) : undefined;
          const origin = created?.origin ?? "";
          if (/^[A-Z_]+$/.test(origin)) {
            const goal = goalPairs(await client.searchStream(
              target,
              `${ACCOUNT_GOALS_QUERY} WHERE customer_conversion_goal.category = '${apiCategory}' AND customer_conversion_goal.origin = '${origin}'`
            ), "customerConversionGoal")[0];
            const isNew = pairsBefore !== null && !pairsBefore.has(pairKey(apiCategory, origin));
            if (goal?.biddable) {
              notices.push(
                (isNew ? `A API criou a meta da conta ${apiCategory} (${origin}) com biddable=true` : `A meta da conta ${apiCategory} (${origin}) é biddable`) +
                ": campanhas que herdam as metas da conta otimizam para as ações PRIMÁRIAS dessa categoria" +
                (primaryForGoal ? " — esta ação passa a guiar esses lances." : "; esta ação é secundária e não entra.") +
                " Para mudar: set_account_conversion_goals (conta) ou set_campaign_conversion_goals (campanha)."
              );
            } else if (goal) {
              notices.push(`A meta da conta ${apiCategory} (${origin}) não é biddable: a ação não guia os lances das campanhas que herdam as metas da conta.`);
            }
          }
          const snippets = snippetsOf(rows[0]);
          const wanted = snippetTypeFor(apiType, "PAGE_LOAD");
          const snippet = snippets.find((s) => s.type === wanted && s.page_format === "HTML") ?? snippets.find((s) => s.type === wanted);
          if (snippet) {
            tag = {
              ...(parseSendTo(snippet.event_snippet) ?? parseSendTo(snippet.global_site_tag) ?? {}),
              snippet_type: snippet.type,
              event_snippet: snippet.event_snippet,
              instalacao: "get_conversion_tag traz o Google tag completo e os passos (GTM, transaction_id, value, currency).",
            };
          }
        } catch (err) {
          notices.push(`Ação criada; a leitura de conferência (meta/tag) falhou: ${errorMessage(err)}`);
        }
      }
      return { content: [text(
        `Conversion action created: "${cleanName}" (id ${newId ?? "?"})\n${header}` +
        (notices.length ? `\n${notices.map((n) => `- ${n}`).join("\n")}\n` : "") +
        (tag ? `\nTag:\n${formatJson(tag)}\n` : "") +
        `\n${formatJson(result)}`
      )] };
    }
  );

  mcp.registerTool(
    "update_conversion_action",
    {
      description: [
        "Update an existing conversion action.",
        "WRITE OPERATION — só envia os campos que mudam (updateMask); sem mudança, nada é enviado.",
        "",
        "Grava na conta DONA da ação (owner_customer): com acompanhamento de conversões entre contas, a MCC.",
        "Ação COMPARTILHADA (dona = MCC/conta de conversão): exige confirm: true — a mudança vale para todas as",
        "contas que usam essa conta de conversão (lances e coluna 'Conversões' de todas). Sem confirm, só a prévia.",
        "O campo `type` é IMUTÁVEL. Use list_conversion_actions para descobrir o conversionActionId.",
        "",
        "primary: true = PRIMÁRIA (coluna 'Conversões' e lances), false = SECUNDÁRIA (observação).",
        "includeInConversionsMetric é somente leitura na API e é traduzido para primary.",
        "DATA_DRIVEN só é aceito com o modelo baseado em dados AVAILABLE (a tool confere antes).",
        "Status: ENABLED, HIDDEN, REMOVED. HIDDEN e REMOVED exigem confirm: true — os dois param de registrar",
        "conversões; HIDDEN ainda tira a ação da interface do Google Ads. Sem confirm, só a prévia.",
        "Regras por tipo: WEBSITE_CALL/AD_CALL exigem valor fixo e não aceitam view-through; click-through 1-60",
        "em chamadas; duração da ligação só em tipos de chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionActionId: z.string().describe("Conversion action ID (de list_conversion_actions)."),
        name: z.string().optional().describe("Novo nome."),
        status: z.enum(["ENABLED", "REMOVED", "HIDDEN"]).optional()
          .describe("Novo status. HIDDEN e REMOVED param de registrar conversões e exigem confirm: true (HIDDEN também some da interface)."),
        category: conversionCategoryV25Schema.optional().describe("Nova categoria."),
        countingType: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional().describe("Nova contagem."),
        attributionModel: attributionModelSchema.optional().describe("Novo modelo de atribuição."),
        primary: z.boolean().optional().describe("True = PRIMÁRIA (usada para lances). False = SECUNDÁRIA."),
        includeInConversionsMetric: z.boolean().optional().describe("OBSOLETO — somente leitura na API; traduzido para primary."),
        valueSetting: z.object({
          defaultValue: z.number().optional().describe("Valor padrão da conversão."),
          alwaysUseDefaultValue: z.boolean().optional().describe("True = sempre usar o valor padrão."),
        }).optional().describe("Configuração de valor."),
        viewThroughLookbackWindowDays: z.number().optional().describe("Janela view-through (1-30 dias)."),
        clickThroughLookbackWindowDays: z.number().optional().describe("Janela click-through (1-60 em chamadas; 1-30 na maioria dos tipos pela documentação)."),
        phoneCallDurationSeconds: z.number().optional().describe("Duração mínima da ligação (tipos de chamada, 0-10000 s)."),
        confirm: z.boolean().optional()
          .describe("Obrigatório (true) para status HIDDEN ou REMOVED e para editar ação compartilhada (dona = MCC/conta de conversão). Sem ele, só a prévia."),
      },
    },
    async ({ customerId, conversionActionId, name, status, category, countingType, attributionModel, primary, includeInConversionsMetric, valueSetting, viewThroughLookbackWindowDays, clickThroughLookbackWindowDays, phoneCallDurationSeconds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (!/^\d+$/.test(conversionActionId)) {
        return fail(`conversionActionId deve ser numérico, recebido "${conversionActionId}". Nada foi alterado.`);
      }
      if (name !== undefined && !name.trim()) return fail("name não pode ser vazio. Nada foi alterado.");
      const primaryChoice = resolvePrimaryFlag(primary, includeInConversionsMetric);
      if ("error" in primaryChoice) return fail(primaryChoice.error);
      const notices = [...primaryChoice.notices];
      const wantPrimary = primaryChoice.value;
      const requested = [name, status, category, countingType, attributionModel, wantPrimary,
        valueSetting?.defaultValue, valueSetting?.alwaysUseDefaultValue, viewThroughLookbackWindowDays,
        clickThroughLookbackWindowDays, phoneCallDurationSeconds].some((v) => v !== undefined);
      if (!requested) {
        return fail("Nada para atualizar: informe ao menos um campo (name, status, category, ...).");
      }
      // HIDDEN/REMOVED e ação compartilhada exigem confirm — conferido depois da leitura, para a
      // prévia mostrar a ação, o antes → depois e a conta afetada (e não pedir confirm em no-op).

      const client = getClient();
      try {
        const rows = await client.searchStream(cid, `SELECT ${ACTION_FIELDS} FROM conversion_action WHERE conversion_action.id = ${conversionActionId}`);
        if (!rows.length) {
          return fail(`A ação ${conversionActionId} não existe na conta ${cid}. Use list_conversion_actions. Nada foi alterado.`);
        }
        const current = actionView(rows[0]);
        if (!current.owner_customer_id) {
          return fail(`A ação ${conversionActionId} ("${current.name}") é definida pelo sistema (sem owner_customer) e não pode ser alterada pela API.`);
        }
        const info = await tracking.get(client, cid);
        const resolved = accountTarget(current.owner_customer_id, info, allowedCustomerIds, hosted, "a edição da ação de conversão");
        if ("error" in resolved) return fail(resolved.error);
        const target = resolved.target;
        notices.push(...resolved.notes);

        const rules = checkConversionTypeRules(current.type, {
          alwaysUseDefaultValue: valueSetting?.alwaysUseDefaultValue,
          viewThroughLookbackWindowDays,
          clickThroughLookbackWindowDays,
          phoneCallDurationSeconds,
        });
        if (rules.errors.length) return fail(`Nada foi enviado — a API recusaria (tipo ${current.type}):\n- ${rules.errors.join("\n- ")}`);
        notices.push(...rules.warnings);

        const update: Row = { resourceName: `customers/${target}/conversionActions/${conversionActionId}` };
        const mask: string[] = [];
        const changes: string[] = [];
        const unchanged: string[] = [];
        const setField = (path: string, label: string, before: unknown, after: unknown, apply: () => void) => {
          if (after === undefined) return;
          if (before === after) { unchanged.push(label); return; }
          apply();
          mask.push(path);
          changes.push(`${label}: ${before === null || before === "" ? "(vazio)" : String(before)} → ${String(after)}`);
        };

        setField("name", "name", current.name, name?.trim(), () => { update.name = name!.trim(); });
        setField("status", "status", current.status, status, () => { update.status = status; });
        const apiCategory = category !== undefined ? resolveEnumAlias(category, CONVERSION_CATEGORY_ALIASES) : undefined;
        setField("category", "category", current.category, apiCategory, () => { update.category = apiCategory; });
        setField("counting_type", "counting_type", current.counting_type, countingType, () => { update.countingType = countingType; });
        const apiAttribution = attributionModel !== undefined ? resolveEnumAlias(attributionModel, ATTRIBUTION_MODEL_ALIASES) : undefined;
        if (apiAttribution === DATA_DRIVEN && current.attribution_model !== DATA_DRIVEN && current.data_driven_model_status !== "AVAILABLE") {
          return fail(
            `Nada foi enviado: o modelo baseado em dados da ação "${current.name}" está ` +
            `${DDA_STATUS_TEXT[current.data_driven_model_status] ?? current.data_driven_model_status} ` +
            `(data_driven_model_status=${current.data_driven_model_status || "vazio"}). A API só aceita DATA_DRIVEN com AVAILABLE ` +
            "(senão DATA_DRIVEN_MODEL_*). Mantenha LAST_CLICK até o modelo ficar disponível."
          );
        }
        setField("attribution_model_settings.attribution_model", "attribution_model", current.attribution_model, apiAttribution, () => {
          update.attributionModelSettings = { attributionModel: apiAttribution };
        });
        setField("primary_for_goal", "primary_for_goal", current.primary_for_goal, wantPrimary, () => { update.primaryForGoal = wantPrimary; });

        const valueSettings: Row = {};
        setField("value_settings.default_value", "default_value", current.default_value, valueSetting?.defaultValue, () => {
          valueSettings.defaultValue = valueSetting!.defaultValue;
        });
        if (valueSettings.defaultValue !== undefined && !current.default_currency_code) {
          valueSettings.defaultCurrencyCode = await client.getAccountCurrency(target);
          mask.push("value_settings.default_currency_code");
          changes.push(`default_currency_code: (vazio) → ${String(valueSettings.defaultCurrencyCode)}`);
        }
        setField("value_settings.always_use_default_value", "always_use_default_value", current.always_use_default_value, valueSetting?.alwaysUseDefaultValue, () => {
          valueSettings.alwaysUseDefaultValue = valueSetting!.alwaysUseDefaultValue;
        });
        if (Object.keys(valueSettings).length) update.valueSettings = valueSettings;
        setField("view_through_lookback_window_days", "view_through_lookback_window_days", current.view_through_lookback_window_days, viewThroughLookbackWindowDays, () => {
          update.viewThroughLookbackWindowDays = String(viewThroughLookbackWindowDays);
        });
        setField("click_through_lookback_window_days", "click_through_lookback_window_days", current.click_through_lookback_window_days, clickThroughLookbackWindowDays, () => {
          update.clickThroughLookbackWindowDays = String(clickThroughLookbackWindowDays);
        });
        setField("phone_call_duration_seconds", "phone_call_duration_seconds", current.phone_call_duration_seconds, phoneCallDurationSeconds, () => {
          update.phoneCallDurationSeconds = String(phoneCallDurationSeconds);
        });

        if (mask.length === 0) {
          return { content: [text(
            `Ação ${conversionActionId} ("${current.name}"): nada a mudar — os campos já estão assim (${unchanged.join(", ")}). ` +
            "Nenhuma escrita foi enviada." + (notices.length ? `\n${notices.map((n) => `- ${n}`).join("\n")}` : "")
          )] };
        }

        const shared = sharedActionScope(target, info);
        const gates = confirmReasons(current, mask.includes("status") ? status : undefined, shared);
        if (gates.length && confirm !== true) {
          return fail(
            `Prévia — nada foi gravado. Ação ${conversionActionId} ("${current.name}"; ${current.category}; ` +
            `${current.primary_for_goal ? "primária" : "secundária"}; ${current.status}) na conta ${target}:\n` +
            `Mudanças:\n- ${changes.join("\n- ")}\n` +
            `Precisa de confirm: true porque:\n- ${gates.join("\n- ")}\n` +
            (notices.length ? `${notices.map((n) => `- ${n}`).join("\n")}\n` : "") +
            "Envie confirm: true para aplicar."
          );
        }
        if (shared) notices.push(shared);

        let result: Row;
        try {
          result = await client.mutate(target, "conversionActions", [{ update, updateMask: mask.join(",") }]);
        } catch (err) {
          return fail(`Erro ao atualizar a ação ${conversionActionId} na conta ${target}: ${explainConversionError(errorMessage(err))}`);
        }
        if (apiCategory !== undefined && apiCategory !== current.category && !client.isDryRun && /^[A-Z_]+$/.test(current.origin)) {
          try {
            const goal = goalPairs(await client.searchStream(
              target,
              `${ACCOUNT_GOALS_QUERY} WHERE customer_conversion_goal.category = '${apiCategory}' AND customer_conversion_goal.origin = '${current.origin}'`
            ), "customerConversionGoal")[0];
            if (goal) {
              notices.push(`Nova categoria: a meta da conta ${apiCategory} (${current.origin}) está ${goal.biddable ? "biddable (a ação entra nos lances se for primária)" : "sem lance (observação)"}.`);
            }
          } catch (err) {
            notices.push(`Meta da conta da nova categoria não conferida: ${errorMessage(err)}`);
          }
        }
        const dryRun = client.isDryRun;
        return { content: [text(
          (dryRun
            ? `DRY-RUN (validateOnly): atualização da ação ${conversionActionId} validada, nada foi gravado.\n`
            : `Conversion action ${conversionActionId} ("${current.name}") atualizada.\n`) +
          `Conta usada: ${target}${target !== cid ? ` (dona da ação; consultada via ${cid})` : ""}\n` +
          `Mudanças:\n- ${changes.join("\n- ")}\n` +
          (unchanged.length ? `Sem mudança: ${unchanged.join(", ")}\n` : "") +
          `Campos: ${mask.join(", ")}\n` +
          (notices.length ? `${notices.map((n) => `- ${n}`).join("\n")}\n` : "") +
          `\n${formatJson(result)}`
        )] };
      } catch (err) {
        return fail(`Erro: ${explainConversionError(errorMessage(err))}`);
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // Escrita — metas
  // ════════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "set_campaign_conversion_goals",
    {
      description: [
        "Define quais categorias de conversão a campanha usa para lances (metas de conversão da campanha).",
        "WRITE OPERATION.",
        "",
        "É o que resolve o caso 'a campanha está otimizando para a conversão errada':",
        "marque biddable=true só nas categorias que devem guiar o lance (ex: PURCHASE)",
        "e biddable=false nas demais (ex: PAGE_VIEW, CONTACT).",
        "",
        "ATENÇÃO: mudar uma meta da campanha a DESLIGA das metas padrão da conta (goal_config_level passa a",
        "CAMPAIGN) e mudanças futuras nas metas da conta deixam de valer para ela. Para voltar:",
        "set_campaign_goal_config resetToAccountDefaults=true. Ver o estado: list_conversion_goals.",
        "",
        "origin (fonte da conversão): WEBSITE, APP, CALL_FROM_ADS, STORE, GOOGLE_HOSTED, YOUTUBE_HOSTED, LOCAL_SERVICES_ADS.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        goals: z.array(z.object({
          category: conversionCategoryV25Schema.describe("Categoria de conversão."),
          origin: conversionOriginSchema.optional().describe("Origem. Default: WEBSITE."),
          biddable: z.boolean().describe("True = usada para lances (primária). False = só observação."),
        })).describe("Metas a configurar."),
      },
    },
    async ({ customerId, campaignId, goals }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`)], isError: true };
      }
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;

      // Só existem as metas (categoria × origem) que a conta tem: um par inexistente
      // dava "Resource was not found". Lê as da campanha e muta só as que existem.
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin,
                campaign_conversion_goal.biddable
         FROM campaign_conversion_goal
         WHERE campaign.id = ${campaignId}`);
      const existing = new Map<string, boolean>();
      for (const row of rows) {
        const goal = (row.campaignConversionGoal ?? {}) as Record<string, unknown>;
        existing.set(`${goal.category}~${goal.origin}`, Boolean(goal.biddable));
      }
      if (existing.size === 0) {
        return {
          content: [text(`A campanha ${campaignId} não tem metas de conversão na conta ${cid} (ou não existe). Nada foi alterado.`)],
          isError: true,
        };
      }

      const requested = goals.map((g) => ({
        category: resolveEnumAlias(g.category, CONVERSION_CATEGORY_ALIASES),
        origin: g.origin ?? "WEBSITE",
        biddable: g.biddable,
      }));
      const unknown = requested.filter((g) => !existing.has(`${g.category}~${g.origin}`));
      if (unknown.length > 0) {
        const valid = [...existing.entries()].map(([key, biddable]) => {
          const [goalCategory, goalOrigin] = key.split("~");
          return `${goalCategory} (${goalOrigin}): ${biddable ? "lance" : "observação"}`;
        });
        return {
          content: [text(
            `Nada foi alterado — par(es) categoria/origem que não existem nesta campanha:\n` +
            unknown.map((g) => `- ${g.category} (${g.origin})`).join("\n") +
            `\n\nPares válidos da campanha ${campaignId}:\n- ${valid.join("\n- ")}`
          )],
          isError: true,
        };
      }

      const toChange = requested.filter((g) => existing.get(`${g.category}~${g.origin}`) !== g.biddable);
      const unchanged = requested.filter((g) => !toChange.includes(g)).map((g) => `${g.category} (${g.origin})`);
      if (toChange.length === 0) {
        return { content: [text(`Campanha ${campaignId}: nada a mudar — as metas já estão assim. Nenhuma escrita foi enviada.`)] };
      }

      // Estado da campanha antes: herda as metas da conta (CUSTOMER) ou tem as próprias (CAMPAIGN)?
      let levelBefore = "";
      let customGoalBefore = "";
      try {
        const config = (await client.searchStream(cid,
          `SELECT campaign.id, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal
           FROM conversion_goal_campaign_config WHERE campaign.id = ${campaignId}`))[0];
        const cfg = (config?.conversionGoalCampaignConfig ?? {}) as Row;
        levelBefore = String(cfg.goalConfigLevel ?? "");
        customGoalBefore = String(cfg.customConversionGoal ?? "");
      } catch {
        // só informativo: a gravação não depende disso
      }

      const operations = toChange.map((g) => ({
        update: {
          resourceName: `customers/${cid}/campaignConversionGoals/${campaignId}~${g.category}~${g.origin}`,
          biddable: g.biddable,
        },
        updateMask: "biddable",
      }));
      let result: Row;
      try {
        result = await client.mutateCampaignConversionGoals(customerId, operations);
      } catch (err) {
        return fail(`Erro ao atualizar as metas da campanha ${campaignId}: ${explainConversionError(errorMessage(err))}`);
      }
      const dryRun = client.isDryRun;
      const summary = toChange
        .map((g) => `${g.category} (${g.origin}): ${existing.get(`${g.category}~${g.origin}`) ? "lance" : "observação"} → ${g.biddable ? "lance" : "observação"}`)
        .join("\n");
      const warnings: string[] = [];
      if (levelBefore === "CUSTOMER") {
        warnings.push(
          (dryRun ? "Se gravada, esta mudança desliga" : "Esta mudança desligou") +
          " a campanha das metas padrão da conta (goal_config_level CUSTOMER → CAMPAIGN): mudanças futuras nas metas da " +
          "conta não valem mais para ela. Para voltar: set_campaign_goal_config resetToAccountDefaults=true."
        );
      }
      if (customGoalBefore) {
        warnings.push(`A campanha usa a meta personalizada ${customGoalBefore}; ela define o que guia o lance. Veja list_conversion_goals.`);
      }
      return {
        content: [text(
          (dryRun ? `Campanha ${campaignId} — DRY-RUN (validateOnly): validado, nada foi gravado.\n` : `Metas de conversão da campanha ${campaignId} atualizadas:\n`) +
          `${summary}` + (unchanged.length ? `\nSem mudança: ${unchanged.join(", ")}` : "") +
          (warnings.length ? `\n\nAtenção:\n- ${warnings.join("\n- ")}` : "") +
          `\n\n${formatJson(result)}`
        )],
      };
    }
  );

  mcp.registerTool(
    "set_account_conversion_goals",
    {
      description: [
        "Define as metas de conversão PADRÃO DA CONTA (CustomerConversionGoal): quais categoria × origem guiam os",
        "lances das campanhas que herdam as metas da conta (goal_config_level=CUSTOMER).",
        "WRITE OPERATION — exige confirm: true (vale para todas essas campanhas; sem confirm só mostra a prévia).",
        "",
        "Grava na conta de conversão (com acompanhamento entre contas, a MCC — e aí afeta todas as contas que",
        "usam essa MCC para conversões). Só pares que já existem na conta; pares sem mudança não são enviados.",
        "Campanhas com metas próprias (CAMPAIGN) não mudam — use set_campaign_conversion_goals nelas.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta cliente; a gravação vai para a conta de conversão dela)."),
        goals: z.array(z.object({
          category: conversionCategoryV25Schema.describe("Categoria de conversão."),
          origin: conversionOriginSchema.optional().describe("Origem. Default: WEBSITE."),
          biddable: z.boolean().describe("True = guia os lances. False = só observação."),
        })).describe("Metas da conta a configurar."),
        confirm: z.boolean().optional().describe("Precisa ser true para gravar. Sem ele, só a prévia."),
      },
    },
    async ({ customerId, goals, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (!goals.length) return fail("goals vazio: informe ao menos uma meta. Nada foi enviado.");
      const requested = goals.map((g) => ({
        category: resolveEnumAlias(g.category, CONVERSION_CATEGORY_ALIASES),
        origin: g.origin ?? "WEBSITE",
        biddable: g.biddable,
      }));
      const duplicated = requested.filter((g, i) => requested.findIndex((o) => pairKey(o.category, o.origin) === pairKey(g.category, g.origin)) !== i);
      if (duplicated.length) return fail(`Par repetido em goals: ${duplicated.map((g) => `${g.category} (${g.origin})`).join(", ")}. Nada foi enviado.`);

      const client = getClient();
      try {
        const info = await tracking.get(client, cid);
        const resolved = conversionWriteTarget(info, allowedCustomerIds, hosted, "a mudança das metas da conta");
        if ("error" in resolved) return fail(resolved.error);
        const target = resolved.target;
        const existing = new Map(goalPairs(await client.searchStream(target, ACCOUNT_GOALS_QUERY), "customerConversionGoal")
          .map((g) => [pairKey(g.category, g.origin), g.biddable]));
        const unknown = requested.filter((g) => !existing.has(pairKey(g.category, g.origin)));
        if (unknown.length) {
          return fail(
            `Nada foi alterado — par(es) que não existem nas metas da conta ${target}:\n` +
            unknown.map((g) => `- ${g.category} (${g.origin})`).join("\n") +
            `\n\nPares existentes:\n- ${[...existing.entries()].map(([k, b]) => `${k.replace("~", " (")}): ${goalLabel(b)}`).join("\n- ")}`
          );
        }
        const toChange = requested.filter((g) => existing.get(pairKey(g.category, g.origin)) !== g.biddable);
        const unchanged = requested.filter((g) => !toChange.includes(g)).map((g) => `${g.category} (${g.origin})`);
        if (!toChange.length) {
          return { content: [text(`Metas da conta ${target}: nada a mudar — já estão assim. Nenhuma escrita foi enviada.`)] };
        }
        const configRows = await client.searchStream(cid,
          `SELECT campaign.id, campaign.name, conversion_goal_campaign_config.goal_config_level
           FROM conversion_goal_campaign_config WHERE campaign.status != 'REMOVED'`);
        const inheriting = configRows.filter((row) => ((row.conversionGoalCampaignConfig ?? {}) as Row).goalConfigLevel === "CUSTOMER")
          .map((row) => String(((row.campaign ?? {}) as Row).name ?? ((row.campaign ?? {}) as Row).id ?? ""));
        const summary = toChange.map((g) => `${g.category} (${g.origin}): ${goalLabel(Boolean(existing.get(pairKey(g.category, g.origin))))} → ${goalLabel(g.biddable)}`);
        const scope =
          `Afeta ${inheriting.length} campanha(s) de ${cid} que herdam as metas da conta` +
          (inheriting.length ? ` (${inheriting.slice(0, 10).join(", ")}${inheriting.length > 10 ? ", ..." : ""})` : "") +
          (info.crossAccount ? ` — e as das demais contas que usam ${target} como conta de conversão.` : ".");
        if (confirm !== true) {
          return fail(
            `Prévia — nada foi gravado. Metas da conta ${target}:\n- ${summary.join("\n- ")}\n${scope}\n` +
            "Envie confirm: true para aplicar."
          );
        }
        const operations = toChange.map((g) => ({
          update: { resourceName: `customers/${target}/customerConversionGoals/${g.category}~${g.origin}`, biddable: g.biddable },
          updateMask: "biddable",
        }));
        let result: Row;
        try {
          result = await client.mutate(target, "customerConversionGoals", operations);
        } catch (err) {
          return fail(`Erro ao atualizar as metas da conta ${target}: ${explainConversionError(errorMessage(err))}`);
        }
        return { content: [text(
          (client.isDryRun ? `DRY-RUN (validateOnly): metas da conta ${target} validadas, nada foi gravado.\n` : `Metas da conta ${target} atualizadas:\n`) +
          `- ${summary.join("\n- ")}\n` + (unchanged.length ? `Sem mudança: ${unchanged.join(", ")}\n` : "") + `${scope}\n` +
          (resolved.notes.length ? `${resolved.notes.map((n) => `- ${n}`).join("\n")}\n` : "") +
          `\n${formatJson(result)}`
        )] };
      } catch (err) {
        return fail(`Erro: ${explainConversionError(errorMessage(err))}`);
      }
    }
  );

  mcp.registerTool(
    "create_custom_conversion_goal",
    {
      description: [
        "Cria uma meta de conversão personalizada (CustomConversionGoal): um conjunto de ações que a campanha",
        "otimiza — ex.: uma PMax só em 'Compra aprovada' do servidor.",
        "WRITE OPERATION.",
        "",
        "Criada na conta de conversão (a API exige). As ações entram por ID e precisam estar ENABLED; na meta",
        "personalizada elas guiam o lance mesmo se forem secundárias (primary_for_goal é ignorado).",
        "Depois aplique na campanha com set_campaign_goal_config customConversionGoalId.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (a conta cliente; a gravação vai para a conta de conversão dela)."),
        name: z.string().describe("Nome da meta personalizada."),
        conversionActionIds: flexArray(z.string()).describe("IDs das ações de conversão (list_conversion_actions)."),
      },
    },
    async ({ customerId, name, conversionActionIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      const cleanName = name.trim();
      if (!cleanName) return fail("name não pode ser vazio. Nada foi enviado.");
      const normalized = normalizeIds(conversionActionIds, "conversionActionIds");
      if ("error" in normalized) return fail(normalized.error);
      if (!normalized.ids.length) return fail("conversionActionIds vazio: informe ao menos uma ação. Nada foi enviado.");
      const ids = normalized.ids;

      const client = getClient();
      try {
        const info = await tracking.get(client, cid);
        const resolved = conversionWriteTarget(info, allowedCustomerIds, hosted, "a criação da meta personalizada");
        if ("error" in resolved) return fail(resolved.error);
        const target = resolved.target;
        const actions = (await client.searchStream(target,
          `SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category
           FROM conversion_action WHERE conversion_action.id IN (${idList(ids)})`)).map(actionView);
        const found = new Map(actions.map((a) => [a.id, a]));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length) return fail(`Ações que não existem na conta de conversão ${target}: ${missing.join(", ")}. Nada foi criado.`);
        const notEnabled = actions.filter((a) => a.status !== "ENABLED");
        if (notEnabled.length) {
          return fail(`A meta personalizada só aceita ações ENABLED (CONVERSION_ACTION_NOT_ENABLED): ${notEnabled.map((a) => `${a.name} (${a.id}): ${a.status}`).join(", ")}. Nada foi criado.`);
        }
        const existingGoals = (await client.searchStream(target,
          `SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.conversion_actions
           FROM custom_conversion_goal WHERE custom_conversion_goal.status = 'ENABLED'`)).map((row) => {
          const goal = (row.customConversionGoal ?? {}) as Row;
          return {
            id: String(goal.id ?? ""),
            name: String(goal.name ?? ""),
            actionIds: ((goal.conversionActions as string[] | undefined) ?? []).map((rn) => String(rn).split("/").pop() ?? "").sort(),
          };
        });
        const sameName = existingGoals.find((g) => g.name.toLowerCase() === cleanName.toLowerCase());
        if (sameName) return fail(`Já existe a meta personalizada "${sameName.name}" (id ${sameName.id}) na conta ${target}. Nada foi criado.`);
        const sortedIds = [...ids].sort();
        const sameActions = existingGoals.find((g) => g.actionIds.join(",") === sortedIds.join(","));
        if (sameActions) {
          return fail(`A meta personalizada "${sameActions.name}" (id ${sameActions.id}) já tem exatamente essas ações — use-a em set_campaign_goal_config. Nada foi criado.`);
        }
        let result: Row;
        try {
          result = await client.mutate(target, "customConversionGoals", [{
            create: { name: cleanName, conversionActions: ids.map((id) => `customers/${target}/conversionActions/${id}`), status: "ENABLED" },
          }]);
        } catch (err) {
          return fail(`Erro ao criar a meta personalizada na conta ${target}: ${explainConversionError(errorMessage(err))}`);
        }
        const resourceName = String(((result.results as Row[] | undefined) ?? [])[0]?.resourceName ?? "");
        const newId = /customConversionGoals\/(\d+)$/.exec(resourceName)?.[1];
        return { content: [text(
          (client.isDryRun
            ? `DRY-RUN (validateOnly): meta personalizada "${cleanName}" validada, nada foi gravado.\n`
            : `Meta personalizada "${cleanName}" criada (id ${newId ?? "?"}).\n`) +
          `Conta usada: ${target}${target !== cid ? ` (conta de conversão de ${cid})` : ""}\n` +
          `Ações: ${actions.map((a) => `${a.name} (${a.id})`).join(", ")}\n` +
          (resolved.notes.length ? `${resolved.notes.map((n) => `- ${n}`).join("\n")}\n` : "") +
          (client.isDryRun ? "" : `Próximo passo: set_campaign_goal_config campaignId=... customConversionGoalId=${newId ?? "<id>"}.\n`) +
          `\n${formatJson(result)}`
        )] };
      } catch (err) {
        return fail(`Erro: ${explainConversionError(errorMessage(err))}`);
      }
    }
  );

  mcp.registerTool(
    "update_custom_conversion_goal",
    {
      description: [
        "Altera ou remove uma meta de conversão personalizada (CustomConversionGoal).",
        "WRITE OPERATION.",
        "",
        "- name: renomeia;",
        "- conversionActionIds: SUBSTITUI a lista de ações; ou addConversionActionIds / removeConversionActionIds;",
        "- remove: true + confirm: true remove a meta (a API recusa se alguma campanha ainda a usa).",
        "Grava na conta de conversão. Sem mudança, nada é enviado. Mudar as ações muda o lance das campanhas que",
        "usam a meta (listadas na resposta).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        customConversionGoalId: z.string().describe("ID da meta personalizada (list_conversion_goals)."),
        name: z.string().optional().describe("Novo nome."),
        conversionActionIds: flexArray(z.string()).optional().describe("Nova lista COMPLETA de ações (substitui)."),
        addConversionActionIds: flexArray(z.string()).optional().describe("Ações a incluir."),
        removeConversionActionIds: flexArray(z.string()).optional().describe("Ações a tirar."),
        remove: z.boolean().optional().describe("true = remove a meta personalizada (exige confirm)."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para remove."),
      },
    },
    async ({ customerId, customConversionGoalId, name, conversionActionIds, addConversionActionIds, removeConversionActionIds, remove, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (!/^\d+$/.test(customConversionGoalId)) return fail(`customConversionGoalId deve ser numérico, recebido "${customConversionGoalId}".`);
      const replace = conversionActionIds !== undefined ? normalizeIds(conversionActionIds, "conversionActionIds") : undefined;
      const add = addConversionActionIds !== undefined ? normalizeIds(addConversionActionIds, "addConversionActionIds") : undefined;
      const drop = removeConversionActionIds !== undefined ? normalizeIds(removeConversionActionIds, "removeConversionActionIds") : undefined;
      for (const parsed of [replace, add, drop]) if (parsed && "error" in parsed) return fail(parsed.error);
      const replaceIds = replace && "ids" in replace ? replace.ids : undefined;
      const addIds = add && "ids" in add ? add.ids : [];
      const dropIds = drop && "ids" in drop ? drop.ids : [];
      if (replaceIds && (addIds.length || dropIds.length)) {
        return fail("Use conversionActionIds (substitui a lista) OU addConversionActionIds/removeConversionActionIds, não os dois. Nada foi enviado.");
      }
      if (remove && (name !== undefined || replaceIds || addIds.length || dropIds.length)) {
        return fail("remove: true não se combina com outras mudanças. Nada foi enviado.");
      }
      if (!remove && name === undefined && !replaceIds && !addIds.length && !dropIds.length) {
        return fail("Nada para alterar: informe name, conversionActionIds, add/removeConversionActionIds ou remove.");
      }
      if (name !== undefined && !name.trim()) return fail("name não pode ser vazio. Nada foi enviado.");

      const client = getClient();
      try {
        const info = await tracking.get(client, cid);
        const resolved = conversionWriteTarget(info, allowedCustomerIds, hosted, "a mudança da meta personalizada");
        if ("error" in resolved) return fail(resolved.error);
        const target = resolved.target;
        const goalRow = (await client.searchStream(target,
          `SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status,
                  custom_conversion_goal.conversion_actions, custom_conversion_goal.resource_name
           FROM custom_conversion_goal WHERE custom_conversion_goal.id = ${customConversionGoalId}`))[0];
        const goal = (goalRow?.customConversionGoal ?? {}) as Row;
        if (!goalRow) return fail(`A meta personalizada ${customConversionGoalId} não existe na conta ${target}. Nada foi alterado.`);
        if (goal.status === "REMOVED") return fail(`A meta personalizada ${customConversionGoalId} já está removida.`);
        const resourceName = `customers/${target}/customConversionGoals/${customConversionGoalId}`;
        const currentIds = ((goal.conversionActions as string[] | undefined) ?? []).map((rn) => String(rn).split("/").pop() ?? "");
        const linked = (await client.searchStream(cid,
          `SELECT campaign.id, campaign.name, conversion_goal_campaign_config.custom_conversion_goal
           FROM conversion_goal_campaign_config
           WHERE conversion_goal_campaign_config.custom_conversion_goal = '${gaqlLiteral(resourceName)}'`))
          .map((row) => `${String(((row.campaign ?? {}) as Row).name ?? "")} (${String(((row.campaign ?? {}) as Row).id ?? "")})`);

        if (remove) {
          if (linked.length) {
            return fail(
              `Nada foi removido: a meta "${String(goal.name ?? "")}" está em uso por ${linked.join(", ")} ` +
              "(a API recusaria com CANNOT_REMOVE_LINKED_CUSTOM_CONVERSION_GOAL). Troque a meta dessas campanhas antes (set_campaign_goal_config)."
            );
          }
          if (confirm !== true) {
            return fail(`Prévia — nada foi removido: a meta personalizada "${String(goal.name ?? "")}" (${customConversionGoalId}) seria removida da conta ${target}. Envie confirm: true.`);
          }
          let result: Row;
          try {
            result = await client.mutate(target, "customConversionGoals", [{ remove: resourceName }]);
          } catch (err) {
            return fail(`Erro ao remover a meta ${customConversionGoalId}: ${explainConversionError(errorMessage(err))}`);
          }
          return { content: [text(
            (client.isDryRun ? `DRY-RUN (validateOnly): remoção validada, nada foi gravado.\n` : `Meta personalizada "${String(goal.name ?? "")}" (${customConversionGoalId}) removida.\n`) +
            `Conta usada: ${target}\n\n${formatJson(result)}`
          )] };
        }

        let nextIds = replaceIds ?? currentIds;
        nextIds = [...new Set([...nextIds, ...addIds])].filter((id) => !dropIds.includes(id));
        const update: Row = { resourceName };
        const mask: string[] = [];
        const changes: string[] = [];
        if (name !== undefined && name.trim() !== String(goal.name ?? "")) {
          update.name = name.trim();
          mask.push("name");
          changes.push(`name: ${String(goal.name ?? "")} → ${name.trim()}`);
        }
        const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
        if (!sameSet(nextIds, currentIds)) {
          if (!nextIds.length) return fail("A meta ficaria sem nenhuma ação. Para desativá-la use remove: true. Nada foi enviado.");
          const newOnes = nextIds.filter((id) => !currentIds.includes(id));
          if (newOnes.length) {
            const actions = (await client.searchStream(target,
              `SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action
               WHERE conversion_action.id IN (${idList(newOnes)})`)).map(actionView);
            const found = new Map(actions.map((a) => [a.id, a]));
            const missing = newOnes.filter((id) => !found.has(id));
            if (missing.length) return fail(`Ações que não existem na conta de conversão ${target}: ${missing.join(", ")}. Nada foi alterado.`);
            const notEnabled = actions.filter((a) => a.status !== "ENABLED");
            if (notEnabled.length) return fail(`Só ações ENABLED entram na meta: ${notEnabled.map((a) => `${a.name} (${a.id}): ${a.status}`).join(", ")}. Nada foi alterado.`);
          }
          update.conversionActions = nextIds.map((id) => `customers/${target}/conversionActions/${id}`);
          mask.push("conversion_actions");
          changes.push(`ações: [${currentIds.join(", ")}] → [${nextIds.join(", ")}]`);
        }
        if (!mask.length) {
          return { content: [text(`Meta personalizada ${customConversionGoalId}: nada a mudar. Nenhuma escrita foi enviada.`)] };
        }
        let result: Row;
        try {
          result = await client.mutate(target, "customConversionGoals", [{ update, updateMask: mask.join(",") }]);
        } catch (err) {
          return fail(`Erro ao atualizar a meta ${customConversionGoalId}: ${explainConversionError(errorMessage(err))}`);
        }
        return { content: [text(
          (client.isDryRun ? `DRY-RUN (validateOnly): atualização validada, nada foi gravado.\n` : `Meta personalizada ${customConversionGoalId} atualizada.\n`) +
          `Conta usada: ${target}\n- ${changes.join("\n- ")}\n` +
          (linked.length && mask.includes("conversion_actions") ? `Muda o lance de: ${linked.join(", ")}.\n` : "") +
          `\n${formatJson(result)}`
        )] };
      } catch (err) {
        return fail(`Erro: ${explainConversionError(errorMessage(err))}`);
      }
    }
  );

  mcp.registerTool(
    "set_campaign_goal_config",
    {
      description: [
        "Configura a meta de conversão da campanha (ConversionGoalCampaignConfig).",
        "WRITE OPERATION.",
        "",
        "- customConversionGoalId: a campanha passa a otimizar para a meta personalizada (create_custom_conversion_goal);",
        "- resetToAccountDefaults: true + confirm: true: volta a herdar as metas da conta (goal_config_level=CUSTOMER),",
        "  descartando as metas próprias da campanha.",
        "Informe só um dos dois. Grava na conta da campanha; a meta personalizada precisa ser da conta de conversão.",
        "A resposta relê a configuração depois da gravação.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        customConversionGoalId: z.string().optional().describe("ID da meta personalizada a usar."),
        resetToAccountDefaults: z.boolean().optional().describe("true = voltar às metas padrão da conta (exige confirm)."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para resetToAccountDefaults."),
      },
    },
    async ({ customerId, campaignId, customConversionGoalId, resetToAccountDefaults, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const invalid = badCustomerId(cid);
      if (invalid) return invalid;
      if (!/^\d+$/.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`);
      const wantsCustom = customConversionGoalId !== undefined && customConversionGoalId !== "";
      const wantsReset = resetToAccountDefaults === true;
      if (wantsCustom === wantsReset) {
        return fail("Informe exatamente um: customConversionGoalId OU resetToAccountDefaults: true. Nada foi enviado.");
      }
      if (wantsCustom && !/^\d+$/.test(customConversionGoalId!)) {
        return fail(`customConversionGoalId deve ser numérico, recebido "${customConversionGoalId}". Nada foi enviado.`);
      }

      const client = getClient();
      const readConfig = async () => (await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal
         FROM conversion_goal_campaign_config WHERE campaign.id = ${campaignId}`))[0];
      try {
        const row = await readConfig();
        if (!row) return fail(`A campanha ${campaignId} não existe na conta ${cid} (ou não tem configuração de metas). Nada foi alterado.`);
        const campaign = (row.campaign ?? {}) as Row;
        const config = (row.conversionGoalCampaignConfig ?? {}) as Row;
        const levelBefore = String(config.goalConfigLevel ?? "");
        const customBefore = String(config.customConversionGoal ?? "");
        const campaignLabel = `${String(campaign.name ?? "")} (${campaignId})`;
        const resourceName = `customers/${cid}/conversionGoalCampaignConfigs/${campaignId}`;
        const notes: string[] = [];
        let update: Row;
        let updateMask: string;
        let change: string;

        if (wantsCustom) {
          const info = await tracking.get(client, cid);
          const resolved = conversionWriteTarget(info, allowedCustomerIds, hosted, "a leitura da meta personalizada");
          if ("error" in resolved) return fail(resolved.error);
          const goalAccount = resolved.target;
          const goalRow = (await client.searchStream(goalAccount,
            `SELECT custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status
             FROM custom_conversion_goal WHERE custom_conversion_goal.id = ${customConversionGoalId}`))[0];
          const goal = (goalRow?.customConversionGoal ?? {}) as Row;
          if (!goalRow) return fail(`A meta personalizada ${customConversionGoalId} não existe na conta de conversão ${goalAccount}. Nada foi alterado.`);
          if (goal.status !== "ENABLED") return fail(`A meta personalizada ${customConversionGoalId} está ${String(goal.status)}. Nada foi alterado.`);
          const goalRn = `customers/${goalAccount}/customConversionGoals/${customConversionGoalId}`;
          if (customBefore === goalRn) {
            return { content: [text(`Campanha ${campaignLabel}: já usa a meta personalizada "${String(goal.name ?? "")}". Nenhuma escrita foi enviada.`)] };
          }
          update = { resourceName, customConversionGoal: goalRn };
          updateMask = "custom_conversion_goal";
          change = `meta personalizada: ${customBefore || "(nenhuma)"} → ${goalRn} ("${String(goal.name ?? "")}")`;
          if (levelBefore === "CUSTOMER") notes.push("A campanha deixa de herdar as metas da conta (goal_config_level passa a CAMPAIGN).");
        } else {
          if (levelBefore === "CUSTOMER" && !customBefore) {
            return { content: [text(`Campanha ${campaignLabel}: já herda as metas da conta (CUSTOMER). Nenhuma escrita foi enviada.`)] };
          }
          const ownGoals = goalPairs(await client.searchStream(cid,
            `SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
             FROM campaign_conversion_goal WHERE campaign.id = ${campaignId}`), "campaignConversionGoal");
          const discarded = ownGoals.map((g) => `${g.category} (${g.origin}): ${goalLabel(g.biddable)}`);
          if (confirm !== true) {
            return fail(
              `Prévia — nada foi gravado. A campanha ${campaignLabel} voltaria às metas padrão da conta; descarta ` +
              `${customBefore ? `a meta personalizada ${customBefore} e ` : ""}as metas próprias:\n- ${discarded.join("\n- ") || "(nenhuma)"}\n` +
              "Envie confirm: true para aplicar."
            );
          }
          update = { resourceName, goalConfigLevel: "CUSTOMER" };
          updateMask = "goal_config_level";
          change = `goal_config_level: ${levelBefore || "(vazio)"} → CUSTOMER${customBefore ? ` (tinha a meta personalizada ${customBefore})` : ""}`;
        }

        let result: Row;
        try {
          result = await client.mutate(cid, "conversionGoalCampaignConfigs", [{ update, updateMask }]);
        } catch (err) {
          return fail(`Erro ao configurar as metas da campanha ${campaignId}: ${explainConversionError(errorMessage(err))}`);
        }
        let after = "";
        if (!client.isDryRun) {
          try {
            const reread = await readConfig();
            const cfg = (reread?.conversionGoalCampaignConfig ?? {}) as Row;
            after = `Relido na API: goal_config_level=${String(cfg.goalConfigLevel ?? "")}, meta personalizada=${String(cfg.customConversionGoal ?? "") || "(nenhuma)"}.\n`;
          } catch (err) {
            after = `Gravado; a releitura falhou: ${errorMessage(err)}\n`;
          }
        }
        return { content: [text(
          (client.isDryRun ? `DRY-RUN (validateOnly): validado, nada foi gravado.\n` : `Metas da campanha ${campaignLabel} configuradas.\n`) +
          `${change}\n${after}` + (notes.length ? `${notes.map((n) => `- ${n}`).join("\n")}\n` : "") +
          `\n${formatJson(result)}`
        )] };
      } catch (err) {
        return fail(`Erro: ${explainConversionError(errorMessage(err))}`);
      }
    }
  );
}
