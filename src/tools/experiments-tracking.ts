/**
 * Lote experiments-tracking: experimentos, rastreamento de URL, rótulos e aquisição de clientes.
 *
 * Tudo aqui foi conferido nos protos oficiais da v25 (services/resources/common/enums) e nos
 * guias de developers.google.com — ver docs/tools/experiments-tracking.md para as fontes.
 *
 * Convenções (iguais às do núcleo):
 * - checkCustomerAccess antes de tudo, em toda tool (o teste de allowlist confere no fonte);
 * - IDs e enums validados antes de interpolar; strings em GAQL passam por gaqlLiteral;
 * - lê antes de escrever, mostra antes/depois e não reenvia valor igual;
 * - updateMask só com folhas; várias operações vão com partialFailure e relatório por item,
 *   ou num googleAds:mutate atômico com IDs temporários quando dependem uma da outra;
 * - ação destrutiva ou em escala pede confirm: true; dry-run/validateOnly nunca é relatado
 *   como gravado.
 */
import { z } from "zod";
import type { GoogleAdsClient, MutateOperation } from "../google-ads-client.js";
import {
  DATE_RANGE_DESC,
  DAYS_DESC,
  ISO_DATE,
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
  isPositiveMicros,
  localIsoDate,
  metricsView,
  microsToMoney,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;

// ── Helpers do módulo ────────────────────────────────────────────────

const ID = /^\d+$/;
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const lastId = (resourceName: unknown): string => str(resourceName).split("/").pop() ?? "";
const fail = (message: string) => ({ content: [text(message)], isError: true });
const cleanCid = (customerId: string) => customerId.replace(/-/g, "");

/** Lista de IDs vinda do MCP (array ou string JSON), sem vazios nem repetidos. */
function cleanList(value: unknown): string[] {
  const seen = new Set<string>();
  for (const entry of ensureArray<unknown>(value)) {
    const item = str(entry).trim();
    if (item) seen.add(item);
  }
  return [...seen];
}

/** 'a', 'b' para IN (...) — sempre com gaqlLiteral. */
const quoted = (values: string[]) => values.map((value) => `'${gaqlLiteral(value)}'`).join(", ");

/** Máximo de itens por chamada nas tools em lote (a API aceita até 10 mil operações por request). */
const MAX_ITEMS = 1000;
const CHUNK = 1000;

function render(format: string | undefined, rows: Row[], json: () => string): string {
  if (format === "table") return formatAsTable(rows);
  if (format === "csv") return formatAsCsv(rows);
  return json();
}

/**
 * Ação de escrita que aceita validate_only no corpo (experiments:scheduleExperiment/
 * promoteExperiment/endExperiment/graduateExperiment, campaignDrafts:promote, customers:mutate).
 * customerWriteAction recusa essas ações em dry-run (fail-closed, porque recommendations:apply
 * não tem o campo). Aqui o campo existe no proto, então em dry-run a chamada vai com
 * validateOnly=true e a API só valida; fora do dry-run passa pelo guard de read-only.
 */
async function validatableAction<T = Row>(client: GoogleAdsClient, customerId: string, action: string, body: Row): Promise<T> {
  if (client.isDryRun) return client.customerAction<T>(customerId, action, { ...body, validateOnly: true });
  return client.customerWriteAction<T>(customerId, action, body);
}

/** Dicas em PT-BR para os códigos de erro que estas tools costumam receber da API. */
const ERROR_HINTS: Array<[RegExp, string]> = [
  [/CONFLICTING_CUSTOMER_TYPES/, "categorias conflitantes na mesma lista (ex.: PURCHASERS com CONVERTED_LEADS)."],
  [/USERLIST_NOT_ELIGIBLE/, "essa lista não aceita tipo de cliente — use listas CRM_BASED (Customer Match) ou RULE_BASED."],
  [/CONVERSION_TRACKING_NOT_ENABLED_OR_NOT_MCC_MANAGER_ACCOUNT/, "a conta precisa ter acompanhamento de conversões; com acompanhamento entre contas, o tipo de cliente é definido na conta de administrador (MCC) que faz o acompanhamento."],
  [/TOO_MANY_USER_LISTS_FOR_THE_CUSTOMER_TYPE/, "limite de listas para essa categoria atingido."],
  [/NO_ACCESS_TO_USER_LIST/, "a conta não tem acesso a essa lista."],
  [/NEW_CUSTOMER_ACQUISITION_GOAL_ALREADY_EXISTS/, "a conta já tem a meta de clientes novos — ela é atualizada, não recriada."],
  [/HIGH_LIFETIME_VALUE_PRESENT_BUT_VALUE_ABSENT/, "highLifetimeValue exige também additionalValue."],
  [/HIGH_LIFETIME_VALUE_LESS_THAN_OR_EQUAL_TO_VALUE/, "highLifetimeValue precisa ser maior que additionalValue."],
  [/CUSTOMER_LIFECYCLE_OPTIMIZATION_ACCOUNT_TYPE_NOT_ALLOWED/, "metas de ciclo de vida só existem em conta de anunciante, não em MCC."],
  [/CUSTOMER_LIFECYCLE_OPTIMIZATION_CAMPAIGN_TYPE_NOT_SUPPORTED/, "este tipo de campanha não aceita a meta de clientes novos."],
  [/CAMPAIGN_OVERRIDE_VALUES_SET_FOR_NEW_CUSTOMER_ACQUISITION_TARGET_SPECIFIC_OPTION/, "com NEW_ONLY (só clientes novos) a campanha não pode ter valores próprios."],
  [/CAMPAIGN_OVERRIDE_HIGH_LIFETIME_VALUE_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE/, "highLifetimeValue por campanha não vale para este tipo de campanha."],
  [/CANNOT_USE_INCOMPATIBLE_CLO_GOALS/, "a campanha já usa outra meta de ciclo de vida incompatível (ex.: retenção só de clientes inativos, prospecção)."],
  [/GOAL_NOT_FOUND/, "a meta da conta não existe ou foi removida."],
  [/DUPLICATE_EXPERIMENT_NAME/, "já existe experimento ativo com esse nome."],
  [/CANNOT_SET_START_DATE_IN_PAST/, "startDate não pode ficar no passado."],
  [/END_DATE_BEFORE_START_DATE/, "endDate precisa ser depois de startDate."],
  [/START_DATE_TOO_FAR_IN_FUTURE/, "startDate no máximo 1 ano à frente."],
  [/IN_DESIGN_CAMPAIGNS_NOT_SET/, "a campanha de tratamento (rascunho) não existe ou ainda não foi alterada — mude algo nela antes de agendar."],
  [/SHARED_BUDGET|BUDGET_MUST_NOT_BE_SHARED/, "experimentos não aceitam campanha com orçamento compartilhado."],
  [/CANNOT_ENABLE_SYNC_FOR_UNSUPPORTED_EXPERIMENT_TYPE/, "syncEnabled só vale em SEARCH_CUSTOM e DISPLAY_CUSTOM."],
  [/OVERLAPPING_MEMBERS_AND_DATE_RANGE/, "a campanha já está em outro experimento no mesmo período."],
  [/DUPLICATE_EXPERIMENT_CAMPAIGN_NAME/, "o nome da campanha de tratamento (nome + sufixo) já existe — troque o suffix."],
  [/EXPERIMENT_NOT_YET_STARTED/, "o experimento ainda não começou."],
  [/STATUS_TRANSITION_INVALID|INVALID_STATUS_TRANSITION/, "a ação não vale no status atual."],
  [/MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION/, "a campanha precisa declarar se contém publicidade política da UE."],
  [/ADOPT_AI_MAX_CAMPAIGN_MISSING_PERFORMANCE_SEARCH_ENABLED/, "a campanha não atende aos requisitos do AI Max para o experimento."],
  [/SEARCH_PLUS_CAMPAIGN_NOT_ALLOWED/, "ADOPT_BROAD_MATCH_KEYWORDS não aceita campanha de Pesquisa com expansão para a Rede de Display."],
  [/CANNOT_HAVE_SAME_CAMPAIGN_CROSS_ARMS_IN_ONE_EXPERIMENT/, "a mesma campanha não pode estar em dois braços deste experimento."],
  [/CANNOT_APPLY_INACTIVE_LABEL/, "rótulo removido não pode ser aplicado."],
  [/CANNOT_APPLY_LABEL_TO_(DISABLED|NEGATIVE)_AD_GROUP_CRITERION/, "rótulo não pode ir em palavra-chave negativa ou desativada."],
  [/EXCEEDED_LABEL_LIMIT_PER_TYPE/, "máximo de 50 rótulos por item."],
  [/INVALID_RESOURCE_FOR_MANAGER_LABEL/, "rótulo de MCC só vale para contas (resourceType customer)."],
  [/CANNOT_ATTACH_NON_MANAGER_LABEL_TO_CUSTOMER/, "para rotular contas, o rótulo precisa ser da conta de administrador (MCC)."],
  [/CANNOT_ATTACH_LABEL_TO_DRAFT/, "rascunhos não aceitam rótulo."],
  [/\bDUPLICATE_NAME\b/, "já existe rótulo com esse nome."],
  [/MISSING_TRACKING_URL_TEMPLATE_TAG/, "o modelo de acompanhamento precisa de uma tag de URL, como {lpurl}."],
  [/MISSING_PROTOCOL_IN_TRACKING_URL_TEMPLATE/, "o modelo precisa começar com http(s):// ou com {lpurl}."],
  [/FINAL_URL_SUFFIX_MALFORMED/, "o sufixo não pode começar com ? ou & e precisa ser uma query string válida."],
  [/INVALID_TAG_IN_FINAL_URL_SUFFIX/, "o sufixo não aceita {lpurl} nem {ignore}."],
  [/URL_CUSTOM_PARAMETERS_COUNT_EXCEEDS_LIMIT/, "máximo de 8 parâmetros personalizados por item."],
  [/DUPLICATE_DRAFT_NAME/, "já existe rascunho com esse nome nesta campanha."],
  [/MAX_NUMBER_OF_DRAFTS_PER_CAMPAIGN_REACHED/, "a campanha atingiu o limite de rascunhos (removidos também contam)."],
];

function explainError(message: string): string {
  const hints = ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\nComo resolver: ${hints.join(" ")}` : message;
}

/**
 * Envia operações de um mesmo serviço com partialFailure, em blocos, e devolve o relatório
 * por item. Uma exceção num bloco marca todos os itens daquele bloco como erro.
 */
async function mutateEach(
  client: GoogleAdsClient,
  customerId: string,
  resource: string,
  operations: MutateOperation[],
  describe: Row[]
): Promise<{ applied: Row[]; errors: Row[] }> {
  const applied: Row[] = [];
  const errors: Row[] = [];
  const dryRun = client.isDryRun;
  for (let start = 0; start < operations.length; start += CHUNK) {
    const ops = operations.slice(start, start + CHUNK);
    const items = describe.slice(start, start + CHUNK);
    let response: Row;
    try {
      response = await client.mutate(customerId, resource, ops, { partialFailure: true });
    } catch (err) {
      const message = explainError((err as Error).message);
      for (const item of items) errors.push({ ...item, error: message });
      continue;
    }
    const results = rowsOf(response.results);
    const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, ops.length);
    items.forEach((item, index) => {
      const opErrors = byIndex.get(index);
      if (opErrors) errors.push({ ...item, error: explainError(opErrors.join("; ")) });
      else if (!dryRun && !str(obj(results[index]).resourceName)) errors.push({ ...item, error: "a API não confirmou a operação" });
      else applied.push(item);
    });
    for (const message of unattributed) errors.push({ error: explainError(message) });
  }
  return { applied, errors };
}

const dryRunLine = "DRY-RUN (validateOnly): a API só validou — nada foi gravado.";

// ── Aquisição de clientes (metas de ciclo de vida, v25) ─────────────

const NCA_GOAL = "NEW_CUSTOMER_ACQUISITION";
const NCA_MODE_TO_TARGET: Record<string, string> = { BID_HIGHER: "TARGET_ALL", NEW_ONLY: "TARGET_SPECIFIC" };
const NCA_TARGET_TO_MODE: Record<string, string> = { TARGET_ALL: "BID_HIGHER", TARGET_SPECIFIC: "NEW_ONLY" };
/** Estratégias em que a meta de clientes novos age (lances automáticos por conversão/valor). */
const CONVERSION_BIDDING = new Set([
  "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS",
]);

const GOAL_FIELDS = `goal.resource_name, goal.goal_id, goal.goal_type, goal.owner_customer, goal.optimization_eligibility,
  goal.new_customer_acquisition_goal_settings.value_settings.additional_value,
  goal.new_customer_acquisition_goal_settings.value_settings.additional_high_lifetime_value,
  goal.retention_goal_settings.value_settings.additional_value,
  goal.retention_goal_settings.value_settings.additional_high_lifetime_value,
  goal.loyalty_retention_goal_settings.value_settings.value_multiplier`;

const GOAL_CONFIG_FIELDS = `campaign_goal_config.resource_name, campaign_goal_config.campaign, campaign_goal_config.goal,
  campaign_goal_config.goal_type,
  campaign_goal_config.campaign_new_customer_acquisition_settings.target_option,
  campaign_goal_config.campaign_new_customer_acquisition_settings.value_settings_override.additional_value,
  campaign_goal_config.campaign_new_customer_acquisition_settings.value_settings_override.additional_high_lifetime_value,
  campaign_goal_config.campaign_retention_settings.target_option,
  campaign_goal_config.campaign_retention_settings.value_settings_override.additional_value,
  campaign_goal_config.campaign_retention_settings.value_settings_override.additional_high_lifetime_value,
  campaign_goal_config.campaign_loyalty_retention_settings.value_settings_override.value_multiplier,
  campaign_goal_config.campaign_loyalty_retention_settings.enable_bid_adjustments_for_loyalty_members,
  campaign_goal_config.campaign_loyalty_retention_settings.show_targeted_loyalty_member_benefits_in_pla`;

const optionalNumber = (value: unknown): number | null => (value === undefined || value === null || value === "" ? null : Number(value));

function goalView(row: Row) {
  const goal = obj(row.goal);
  const type = str(goal.goalType);
  const settings = type === NCA_GOAL
    ? obj(goal.newCustomerAcquisitionGoalSettings)
    : type === "CUSTOMER_RETENTION" ? obj(goal.retentionGoalSettings) : obj(goal.loyaltyRetentionGoalSettings);
  const values = obj(settings.valueSettings);
  return {
    goal_id: str(goal.goalId),
    goal_type: type,
    resource_name: str(goal.resourceName),
    owner_customer: str(goal.ownerCustomer),
    optimization_eligibility: str(goal.optimizationEligibility),
    additional_value: optionalNumber(values.additionalValue),
    additional_high_lifetime_value: optionalNumber(values.additionalHighLifetimeValue),
    value_multiplier: optionalNumber(values.valueMultiplier),
  };
}

function goalConfigView(row: Row, campaignsById: Map<string, Row>) {
  const config = obj(row.campaignGoalConfig);
  const campaignId = lastId(config.campaign);
  const campaign = campaignsById.get(campaignId) ?? obj(row.campaign);
  const nca = obj(config.campaignNewCustomerAcquisitionSettings);
  const retention = obj(config.campaignRetentionSettings);
  const loyalty = obj(config.campaignLoyaltyRetentionSettings);
  const type = str(config.goalType);
  const settings = type === NCA_GOAL ? nca : type === "CUSTOMER_RETENTION" ? retention : loyalty;
  const override = obj(settings.valueSettingsOverride);
  return {
    campaign_id: campaignId,
    campaign_name: str(campaign.name),
    campaign_status: str(campaign.status),
    channel: str(campaign.advertisingChannelType),
    bidding_strategy_type: str(campaign.biddingStrategyType),
    goal_type: type,
    target_option: str(settings.targetOption) || null,
    mode: type === NCA_GOAL ? NCA_TARGET_TO_MODE[str(nca.targetOption)] ?? (str(nca.targetOption) || "BID_HIGHER (padrão TARGET_ALL)") : null,
    override_additional_value: optionalNumber(override.additionalValue),
    override_additional_high_lifetime_value: optionalNumber(override.additionalHighLifetimeValue),
    override_value_multiplier: optionalNumber(override.valueMultiplier),
    loyalty_bid_adjustments: type === "LOYALTY_RETENTION" ? Boolean(loyalty.enableBidAdjustmentsForLoyaltyMembers) : undefined,
    loyalty_benefits_in_pla: type === "LOYALTY_RETENTION" ? Boolean(loyalty.showTargetedLoyaltyMemberBenefitsInPla) : undefined,
    goal: str(config.goal),
    resource_name: str(config.resourceName),
  };
}

/** Conta onde as metas da conta ficam: com acompanhamento entre contas, é a conta de conversão (MCC). */
async function conversionCustomerOf(client: GoogleAdsClient, customerId: string): Promise<{ conversionCustomer: string; status: string }> {
  const rows = await client.searchStream(customerId,
    `SELECT customer.id, customer.conversion_tracking_setting.google_ads_conversion_customer,
            customer.conversion_tracking_setting.conversion_tracking_status
     FROM customer`);
  const setting = obj(obj(rows[0]?.customer).conversionTrackingSetting);
  return {
    conversionCustomer: lastId(setting.googleAdsConversionCustomer),
    status: str(setting.conversionTrackingStatus),
  };
}

const USER_LIST_CATEGORIES = [
  "ALL_CUSTOMERS", "PURCHASERS", "HIGH_VALUE_CUSTOMERS", "DISENGAGED_CUSTOMERS", "QUALIFIED_LEADS",
  "CONVERTED_LEADS", "PAID_SUBSCRIBERS", "CART_ABANDONERS",
  "LOYALTY_TIER_1_MEMBERS", "LOYALTY_TIER_2_MEMBERS", "LOYALTY_TIER_3_MEMBERS", "LOYALTY_TIER_4_MEMBERS",
  "LOYALTY_TIER_5_MEMBERS", "LOYALTY_TIER_6_MEMBERS", "LOYALTY_TIER_7_MEMBERS",
] as const;

/** Pares que a API recusa na mesma lista (UserListCustomerTypeError.CONFLICTING_CUSTOMER_TYPES). */
const CONFLICTING_CATEGORIES: Array<[string, string]> = [
  ["PURCHASERS", "CONVERTED_LEADS"],
  ["PURCHASERS", "QUALIFIED_LEADS"],
  ["PURCHASERS", "CART_ABANDONERS"],
  ["CONVERTED_LEADS", "QUALIFIED_LEADS"],
  ["DISENGAGED_CUSTOMERS", "CONVERTED_LEADS"],
  ["DISENGAGED_CUSTOMERS", "QUALIFIED_LEADS"],
  ["DISENGAGED_CUSTOMERS", "CART_ABANDONERS"],
];

function categoriesConflict(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.startsWith("LOYALTY_TIER_") && b.startsWith("LOYALTY_TIER_")) return true;
  return CONFLICTING_CATEGORIES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

// ── Experimentos ─────────────────────────────────────────────────────

/** Tipos com campanha de tratamento gerada pelo sistema (rascunho em in_design_campaigns). */
const SYSTEM_MANAGED_TYPES = ["SEARCH_CUSTOM", "DISPLAY_CUSTOM", "HOTEL_CUSTOM", "PMAX_REPLACEMENT_SHOPPING"] as const;
/** Tipos em que o tráfego é dividido dentro da própria campanha (os dois braços na mesma campanha). */
const INTRA_CAMPAIGN_TYPES = ["ADOPT_AI_MAX", "ADOPT_BROAD_MATCH_KEYWORDS"] as const;
const CREATE_EXPERIMENT_TYPES = [...SYSTEM_MANAGED_TYPES, ...INTRA_CAMPAIGN_TYPES, "COMPARE_CAMPAIGNS", "OPTIMIZE_ASSETS"] as const;
const CONTROL_CHANNEL: Record<string, string> = {
  SEARCH_CUSTOM: "SEARCH",
  DISPLAY_CUSTOM: "DISPLAY",
  HOTEL_CUSTOM: "HOTEL",
  PMAX_REPLACEMENT_SHOPPING: "SHOPPING",
  ADOPT_AI_MAX: "SEARCH",
  ADOPT_BROAD_MATCH_KEYWORDS: "SEARCH",
};
const SYNC_TYPES = new Set(["SEARCH_CUSTOM", "DISPLAY_CUSTOM"]);
/** Promover não existe para estes tipos (guias: system-managed, campaign mix, asset optimization). */
const NO_PROMOTE_TYPES = new Set(["PMAX_REPLACEMENT_SHOPPING", "COMPARE_CAMPAIGNS", "OPTIMIZE_ASSETS"]);
/** Graduar não existe nos experimentos dentro da campanha (guia intra-campaign). */
const NO_GRADUATE_TYPES = new Set(["ADOPT_AI_MAX", "ADOPT_BROAD_MATCH_KEYWORDS", "PMAX_TEXT_CUSTOMIZATION_FINAL_URL_EXPANSION"]);
const OPTIMIZE_ASSET_FIELDS = ["HEADLINE", "LONG_HEADLINE", "DESCRIPTION"] as const;
const OPTIMIZE_ASSET_MAX_CHARS: Record<string, number> = { HEADLINE: 30, LONG_HEADLINE: 90, DESCRIPTION: 90 };

const EXPERIMENT_FIELDS = `experiment.resource_name, experiment.experiment_id, experiment.name, experiment.description,
  experiment.type, experiment.status, experiment.start_date, experiment.end_date, experiment.suffix,
  experiment.sync_enabled, experiment.promote_status, experiment.long_running_operation, experiment.goals`;

const ARM_FIELDS = `experiment_arm.resource_name, experiment_arm.experiment, experiment_arm.name, experiment_arm.control,
  experiment_arm.traffic_split, experiment_arm.campaigns, experiment_arm.in_design_campaigns`;

interface ArmView {
  resource_name: string;
  experiment: string;
  name: string;
  control: boolean;
  traffic_split: number;
  campaign_ids: string[];
  in_design_campaign_ids: string[];
}

function armView(row: Row): ArmView {
  const arm = obj(row.experimentArm);
  return {
    resource_name: str(arm.resourceName),
    experiment: str(arm.experiment),
    name: str(arm.name),
    control: Boolean(arm.control),
    traffic_split: num(arm.trafficSplit),
    campaign_ids: (Array.isArray(arm.campaigns) ? arm.campaigns : []).map(lastId),
    in_design_campaign_ids: (Array.isArray(arm.inDesignCampaigns) ? arm.inDesignCampaigns : []).map(lastId),
  };
}

async function readExperiment(client: GoogleAdsClient, customerId: string, experimentId: string): Promise<Row | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT ${EXPERIMENT_FIELDS} FROM experiment WHERE experiment.experiment_id = ${experimentId}`);
  const experiment = rows[0]?.experiment;
  return experiment ? obj(experiment) : undefined;
}

/** Braços do experimento, com as campanhas em rascunho (só aparecem com include_drafts=true). */
async function readArms(client: GoogleAdsClient, customerId: string, experimentResources: string[]): Promise<ArmView[]> {
  if (experimentResources.length === 0) return [];
  const rows = await client.searchStream(customerId,
    `SELECT ${ARM_FIELDS} FROM experiment_arm
     WHERE experiment_arm.experiment IN (${quoted(experimentResources)})
     PARAMETERS include_drafts=true`);
  return rows.map(armView);
}

/** Nome, status e tipo (BASE/DRAFT/EXPERIMENT) das campanhas, incluindo rascunhos. */
async function readCampaignNames(client: GoogleAdsClient, customerId: string, ids: string[]): Promise<Map<string, Row>> {
  const valid = [...new Set(ids.filter((id) => ID.test(id)))];
  const byId = new Map<string, Row>();
  if (valid.length === 0) return byId;
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.experiment_type, campaign.advertising_channel_type
     FROM campaign WHERE campaign.id IN (${valid.join(", ")})
     PARAMETERS include_drafts=true`);
  for (const row of rows) {
    const campaign = obj(row.campaign);
    byId.set(str(campaign.id), campaign);
  }
  return byId;
}

function describeCampaigns(ids: string[], names: Map<string, Row>) {
  return ids.map((id) => {
    const campaign = names.get(id);
    return campaign
      ? { id, name: str(campaign.name), status: str(campaign.status), experiment_type: str(campaign.experimentType) }
      : { id };
  });
}

/** Erros assíncronos do último agendamento/promoção (GET :listExperimentAsyncErrors). */
async function experimentAsyncErrors(client: GoogleAdsClient, customerId: string, experimentId: string): Promise<unknown> {
  try {
    const response = await client.customerGet<Row>(customerId, `experiments/${experimentId}:listExperimentAsyncErrors`, { pageSize: "1000" });
    return rowsOf(response.errors).map((error) => ({ code: error.code, message: error.message, details: error.details }));
  } catch (err) {
    return { unavailable: (err as Error).message };
  }
}

interface ExperimentMetricDef {
  key: string;
  label: string;
  select: string[];
  treatment: string;
  control: string;
  estimate: string;
  margin: string;
  pValue: string;
  kind: "relative" | "absolute";
  better: "up" | "down" | "neutral";
  micros?: boolean;
}

/**
 * Métricas de experimento da v25 (common/metrics.proto). point_estimate e margin_of_error são
 * (tratamento / controle − 1), exceto conversões, que vêm em diferença absoluta
 * (tratamento − controle). O intervalo de confiança é point_estimate ± margin_of_error.
 */
const EXPERIMENT_METRICS: ExperimentMetricDef[] = [
  { key: "clicks", label: "Cliques", treatment: "clicks", control: "controlClicks", estimate: "clicksPointEstimate", margin: "clicksMarginOfError", pValue: "clicksPValue", kind: "relative", better: "up",
    select: ["metrics.clicks", "metrics.control_clicks", "metrics.clicks_point_estimate", "metrics.clicks_margin_of_error", "metrics.clicks_p_value"] },
  { key: "impressions", label: "Impressões", treatment: "impressions", control: "controlImpressions", estimate: "impressionsPointEstimate", margin: "impressionsMarginOfError", pValue: "impressionsPValue", kind: "relative", better: "up",
    select: ["metrics.impressions", "metrics.control_impressions", "metrics.impressions_point_estimate", "metrics.impressions_margin_of_error", "metrics.impressions_p_value"] },
  { key: "cost", label: "Custo", treatment: "costMicros", control: "controlCostMicros", estimate: "costMicrosChangePointEstimate", margin: "costMicrosMarginOfError", pValue: "costMicrosPValue", kind: "relative", better: "neutral", micros: true,
    select: ["metrics.cost_micros", "metrics.control_cost_micros", "metrics.cost_micros_change_point_estimate", "metrics.cost_micros_margin_of_error", "metrics.cost_micros_p_value"] },
  { key: "conversions", label: "Conversões", treatment: "conversions", control: "controlConversions", estimate: "conversionsAbsoluteChangePointEstimate", margin: "conversionsAbsoluteChangeMarginOfError", pValue: "conversionsAbsoluteChangePValue", kind: "absolute", better: "up",
    select: ["metrics.conversions", "metrics.control_conversions", "metrics.conversions_absolute_change_point_estimate", "metrics.conversions_absolute_change_margin_of_error", "metrics.conversions_absolute_change_p_value"] },
  { key: "cost_per_conversion", label: "Custo por conversão (CPA)", treatment: "costPerConversion", control: "controlCostPerConversion", estimate: "costPerConversionChangePointEstimate", margin: "costPerConversionMarginOfError", pValue: "costPerConversionPValue", kind: "relative", better: "down", micros: true,
    select: ["metrics.cost_per_conversion", "metrics.control_cost_per_conversion", "metrics.cost_per_conversion_change_point_estimate", "metrics.cost_per_conversion_margin_of_error", "metrics.cost_per_conversion_p_value"] },
  { key: "conversion_value", label: "Valor de conversão", treatment: "conversionsValue", control: "controlConversionValue", estimate: "conversionValueChangePointEstimate", margin: "conversionValueMarginOfError", pValue: "conversionValuePValue", kind: "relative", better: "up",
    select: ["metrics.conversions_value", "metrics.control_conversion_value", "metrics.conversion_value_change_point_estimate", "metrics.conversion_value_margin_of_error", "metrics.conversion_value_p_value"] },
  { key: "conversion_value_per_cost", label: "Valor de conversão / custo (ROAS)", treatment: "conversionsValuePerCost", control: "controlConversionValuePerCost", estimate: "conversionValuePerCostChangePointEstimate", margin: "conversionValuePerCostMarginOfError", pValue: "conversionValuePerCostPValue", kind: "relative", better: "up",
    select: ["metrics.conversions_value_per_cost", "metrics.control_conversion_value_per_cost", "metrics.conversion_value_per_cost_change_point_estimate", "metrics.conversion_value_per_cost_margin_of_error", "metrics.conversion_value_per_cost_p_value"] },
];

const present = (value: unknown) => value !== undefined && value !== null && value !== "";

function evaluateMetric(def: ExperimentMetricDef, metrics: Row, threshold: number): Row {
  const scale = (value: unknown) => (present(value) ? (def.micros ? round2(microsToMoney(value)) : round2(Number(value))) : null);
  const base = { metric: def.key, label: def.label, treatment: scale(metrics[def.treatment]), control: scale(metrics[def.control]) };
  if (!present(metrics[def.estimate]) || !present(metrics[def.margin]) || !present(metrics[def.pValue])) {
    return { ...base, verdict: "SEM_DADOS", reading: "A API ainda não devolveu estimativa, margem e p-valor para esta métrica." };
  }
  const estimate = Number(metrics[def.estimate]);
  const margin = Number(metrics[def.margin]);
  const pValue = Number(metrics[def.pValue]);
  const low = estimate - margin;
  const high = estimate + margin;
  const significant = pValue <= threshold && (low > 0 || high < 0);
  const verdict = !significant ? "INCONCLUSIVO" : low > 0 ? "AUMENTO_SIGNIFICATIVO" : "QUEDA_SIGNIFICATIVA";
  const favorable = !significant || def.better === "neutral" ? null : (verdict === "AUMENTO_SIGNIFICATIVO") === (def.better === "up");
  const show = (value: number) => (def.kind === "relative" ? round2(value * 100) : round2(value));
  const unit = def.kind === "relative" ? "%" : " conv.";
  return {
    ...base,
    lift: show(estimate),
    lift_unit: def.kind === "relative" ? "% (tratamento / controle − 1)" : "diferença absoluta (tratamento − controle)",
    confidence_interval: [show(low), show(high)],
    p_value: Math.round(pValue * 10000) / 10000,
    verdict,
    favorable,
    reading: !significant
      ? `Inconclusivo: p=${pValue.toFixed(3)}${pValue <= threshold ? " (mas o intervalo cruza zero)" : ""}; intervalo ${show(low)}${unit} a ${show(high)}${unit}.`
      : `${verdict === "AUMENTO_SIGNIFICATIVO" ? "Aumento" : "Queda"} significativa de ${show(estimate)}${unit} (intervalo ${show(low)}${unit} a ${show(high)}${unit}, p=${pValue.toFixed(3)})` +
        (favorable === null ? "." : favorable ? " — favorável ao tratamento." : " — desfavorável ao tratamento."),
  };
}

const BIDDING_FIELDS: Record<string, { json: string; path: string; emptySwitch?: string }> = {
  MAXIMIZE_CONVERSIONS: { json: "maximizeConversions", path: "maximize_conversions", emptySwitch: "maximize_conversions.target_cpa_micros" },
  MAXIMIZE_CONVERSION_VALUE: { json: "maximizeConversionValue", path: "maximize_conversion_value", emptySwitch: "maximize_conversion_value.target_roas" },
  TARGET_SPEND: { json: "targetSpend", path: "target_spend", emptySwitch: "target_spend.cpc_bid_ceiling_micros" },
  TARGET_CPA: { json: "targetCpa", path: "target_cpa" },
  TARGET_ROAS: { json: "targetRoas", path: "target_roas" },
};

// ── URL tracking ─────────────────────────────────────────────────────

const TRACKING_LEVELS = ["account", "campaign", "adGroup", "ad", "keyword"] as const;
const TRACKING_FIELDS = ["trackingUrlTemplate", "finalUrlSuffix", "customParameters"] as const;
const LPURL_TAG = /\{(?:lpurl|unescapedlpurl|escapedlpurl)(?:\+\d)?\}/i;
const MAX_CUSTOM_PARAMETERS = 8;

function paramsOf(value: unknown): Array<{ key: string; value: string }> {
  return (Array.isArray(value) ? value : []).map((entry) => ({ key: str(obj(entry).key), value: str(obj(entry).value) }));
}

const paramsKey = (params: Array<{ key: string; value: string }>) =>
  params.map((param) => `${param.key}=${param.value}`).sort().join("&");

/** {_chave} usados num texto (modelo de acompanhamento ou sufixo). */
function customTagsIn(value: string): string[] {
  return [...value.matchAll(/\{_([A-Za-z0-9]+)\}/g)].map((match) => match[1].toLowerCase());
}

function validateTrackingTemplate(value: string): string | undefined {
  if (!/^(https?:\/\/|\{)/i.test(value)) return "trackingUrlTemplate precisa começar com http://, https:// ou com uma tag como {lpurl}";
  if (/\s/.test(value)) return "trackingUrlTemplate não pode ter espaços";
  return undefined;
}

function validateSuffix(value: string): string | undefined {
  if (/^[?&]/.test(value)) return "finalUrlSuffix não pode começar com ? ou & (ex.: utm_source=google&utm_medium=cpc)";
  if (/\{(?:lpurl|unescapedlpurl|escapedlpurl|ignore)/i.test(value)) return "finalUrlSuffix não aceita {lpurl} nem {ignore}";
  if (/\s/.test(value)) return "finalUrlSuffix não pode ter espaços";
  return undefined;
}

// ── Rótulos ─────────────────────────────────────────────────────────

const LABEL_LEVELS = ["campaign", "adGroup", "ad", "keyword"] as const;

/** Onde cada nível guarda os rótulos (campo repetido e filtrável com CONTAINS ANY/ALL). */
const LABEL_FIELD: Record<string, string> = {
  campaign: "campaign.labels",
  adGroup: "ad_group.labels",
  ad: "ad_group_ad.labels",
  keyword: "ad_group_criterion.labels",
};

function labelClause(level: string, cid: string, labelIds: string[], match: string): string {
  const resources = labelIds.map((id) => `customers/${cid}/labels/${id}`);
  return `${LABEL_FIELD[level]} CONTAINS ${match === "ALL" ? "ALL" : "ANY"} (${quoted(resources)})`;
}

// ═════════════════════════════════════════════════════════════════════

export function registerExperimentsTrackingTools(ctx: ToolContext): void {
  const { allowedCustomerIds, hosted } = ctx;

  // ══ AQUISIÇÃO DE CLIENTES (item 54) ════════════════════════════════

  ctx.mcp.registerTool(
    "get_lifecycle_goals",
    {
      description: [
        "Metas de ciclo de vida da conta (v25: Goal + CampaignGoalConfig). READ OPERATION.",
        "",
        "Mostra: a meta de aquisição de clientes novos (NEW_CUSTOMER_ACQUISITION), retenção e fidelidade",
        "da conta, com os valores adicionais; a configuração por campanha (BID_HIGHER = lances maiores para",
        "clientes novos / TARGET_ALL; NEW_ONLY = só clientes novos / TARGET_SPECIFIC) com os valores próprios;",
        "a conta de conversão (com acompanhamento entre contas as metas da conta ficam nela) e as listas",
        "marcadas com tipo de cliente (PURCHASERS, HIGH_VALUE_CUSTOMERS...), que definem quem é cliente existente.",
        "Para mudar: set_new_customer_acquisition e tag_user_list_customer_type.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra as configurações de uma campanha."),
        format: formatSchema.describe("json (padrão, tudo) | table/csv (configurações por campanha)."),
      },
    },
    async ({ customerId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (campaignId !== undefined && !ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);

      const client = ctx.getClient();
      const { conversionCustomer, status: trackingStatus } = await conversionCustomerOf(client, customerId);
      const goals = (await client.searchStream(customerId, `SELECT ${GOAL_FIELDS} FROM goal`)).map(goalView);

      // Com acompanhamento entre contas as metas da conta ficam na conta de conversão.
      let conversionAccountGoals: unknown = undefined;
      const crossAccount = Boolean(conversionCustomer) && conversionCustomer !== cid;
      if (crossAccount) {
        if (checkCustomerAccess(conversionCustomer, allowedCustomerIds, hosted)) {
          conversionAccountGoals = `conta de conversão ${conversionCustomer} fora da allowlist — metas dela não consultadas`;
        } else {
          try {
            conversionAccountGoals = (await client.searchStream(conversionCustomer, `SELECT ${GOAL_FIELDS} FROM goal`)).map(goalView);
          } catch (err) {
            conversionAccountGoals = { unavailable: (err as Error).message };
          }
        }
      }

      const configRows = await client.searchStream(customerId,
        `SELECT ${GOAL_CONFIG_FIELDS}, campaign.id, campaign.name, campaign.status,
                campaign.advertising_channel_type, campaign.bidding_strategy_type
         FROM campaign_goal_config${campaignId ? `\n         WHERE campaign.id = ${campaignId}` : ""}`);
      const configs = configRows.map((row) => goalConfigView(row, new Map()));

      const typeRows = await client.searchStream(customerId,
        `SELECT user_list_customer_type.resource_name, user_list_customer_type.user_list,
                user_list_customer_type.customer_type_category
         FROM user_list_customer_type`);
      const listIds = [...new Set(typeRows.map((row) => lastId(obj(row.userListCustomerType).userList)).filter((id) => ID.test(id)))];
      const listNames = new Map<string, Row>();
      if (listIds.length > 0) {
        const lists = await client.searchStream(customerId,
          `SELECT user_list.id, user_list.name, user_list.type FROM user_list WHERE user_list.id IN (${listIds.join(", ")})`);
        for (const row of lists) listNames.set(str(obj(row.userList).id), obj(row.userList));
      }
      const customerTypes = typeRows.map((row) => {
        const type = obj(row.userListCustomerType);
        const listId = lastId(type.userList);
        return {
          user_list_id: listId,
          user_list_name: str(listNames.get(listId)?.name),
          user_list_type: str(listNames.get(listId)?.type),
          category: str(type.customerTypeCategory),
        };
      });

      const nca = [...goals, ...(Array.isArray(conversionAccountGoals) ? conversionAccountGoals as ReturnType<typeof goalView>[] : [])]
        .find((goal) => goal.goal_type === NCA_GOAL);
      const notes: string[] = [];
      if (!nca) notes.push("A conta não tem meta de aquisição de clientes novos. Crie com set_new_customer_acquisition (sem campaignId, com additionalValue).");
      if (crossAccount) notes.push(`Acompanhamento entre contas: as metas da conta ficam na conta de conversão ${conversionCustomer}; as configurações por campanha ficam nesta conta.`);
      if (customerTypes.length === 0) notes.push("Nenhuma lista marcada com tipo de cliente: o Google define clientes existentes pelas conversões. Marque listas com tag_user_list_customer_type (ex.: PURCHASERS).");

      const body = {
        account: { customer_id: cid, conversion_customer: conversionCustomer || cid, cross_account_conversion_tracking: crossAccount, conversion_tracking_status: trackingStatus },
        goals,
        ...(crossAccount ? { conversion_account_goals: conversionAccountGoals } : {}),
        campaign_configs: configs,
        user_list_customer_types: customerTypes,
        notes,
      };
      return {
        content: [text(render(format, configs as unknown as Row[], () =>
          `Metas de ciclo de vida — conta ${cid}: ${goals.length} meta(s) da conta, ${configs.length} configuração(ões) por campanha, ` +
          `${customerTypes.length} lista(s) com tipo de cliente.\n\n${formatJson(body)}`))],
      };
    }
  );

  ctx.mcp.registerTool(
    "set_new_customer_acquisition",
    {
      description: [
        "Aquisição de clientes novos (v25: Goal NEW_CUSTOMER_ACQUISITION + CampaignGoalConfig). WRITE OPERATION.",
        "",
        "Sem campaignId: cria/atualiza a meta da CONTA — additionalValue = valor extra (na moeda da conta) somado",
        "à primeira compra de um cliente novo; highLifetimeValue = valor extra para cliente novo de alto valor",
        "(precisa ser maior que additionalValue). Com acompanhamento entre contas, a meta vai para a conta de",
        "conversão (MCC) automaticamente.",
        "Com campaignId + mode:",
        "- BID_HIGHER: lances maiores para clientes novos (TARGET_ALL); additionalValue/highLifetimeValue",
        "  aqui viram valores próprios da campanha.",
        "- NEW_ONLY: só clientes novos (TARGET_SPECIFIC); sem valores próprios (a API recusa).",
        "- OFF: tira a campanha da meta (remove a configuração; pede confirm: true).",
        "Se a conta ainda não tem a meta e vier additionalValue com mode BID_HIGHER, a meta da conta é criada",
        "com esses valores e depois a campanha é vinculada.",
        "A meta só age em lances automáticos por conversão/valor. Não mexe em orçamento, lance nem segmentação.",
        "Quem é cliente existente: listas marcadas com tag_user_list_customer_type + dados de conversão.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta das campanhas)."),
        campaignId: z.string().optional().describe("Campanha a configurar. Sem ela, ajusta a meta da conta."),
        mode: z.enum(["BID_HIGHER", "NEW_ONLY", "OFF"]).optional().describe("Obrigatório com campaignId."),
        additionalValue: z.number().optional().describe("Valor extra por conversão de cliente novo, na moeda da conta (ex.: 50 = R$ 50)."),
        highLifetimeValue: z.number().optional().describe("Valor extra para cliente novo de alto valor; maior que additionalValue."),
        confirm: z.boolean().optional().describe("true para mode OFF (remove a configuração da campanha) e para criar a meta na conta de conversão quando só a conta cliente tem meta."),
      },
    },
    async ({ customerId, campaignId, mode, additionalValue, highLifetimeValue, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const problems: string[] = [];
      if (campaignId !== undefined && !ID.test(campaignId)) problems.push(`campaignId deve ser numérico, recebido "${campaignId}"`);
      for (const [label, value] of [["additionalValue", additionalValue], ["highLifetimeValue", highLifetimeValue]] as const) {
        if (value !== undefined && !(Number.isFinite(value) && value > 0)) problems.push(`${label} deve ser maior que zero (recebido ${value})`);
      }
      if (additionalValue !== undefined && highLifetimeValue !== undefined && !(highLifetimeValue > additionalValue)) {
        problems.push("highLifetimeValue precisa ser maior que additionalValue");
      }
      if (campaignId === undefined) {
        if (mode !== undefined) problems.push("mode só vale com campaignId (sem campaignId a tool ajusta a meta da conta)");
        if (additionalValue === undefined && highLifetimeValue === undefined) problems.push("informe additionalValue (e, se quiser, highLifetimeValue) para a meta da conta");
      } else {
        if (mode === undefined) problems.push("com campaignId, informe mode: BID_HIGHER, NEW_ONLY ou OFF");
        if (mode && mode !== "BID_HIGHER" && (additionalValue !== undefined || highLifetimeValue !== undefined)) {
          problems.push(`mode ${mode} não aceita additionalValue/highLifetimeValue (só BID_HIGHER tem valores próprios)`);
        }
      }
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const dryRun = client.isDryRun;
      const { conversionCustomer } = await conversionCustomerOf(client, customerId);
      const goalCid = conversionCustomer && ID.test(conversionCustomer) ? conversionCustomer : cid;
      const crossAccount = goalCid !== cid;
      // A conta de conversão também passa pela allowlist: fora dela não é lida nem gravada.
      const goalBlocked = crossAccount ? checkCustomerAccess(goalCid, allowedCustomerIds, hosted) : null;
      if (goalBlocked && campaignId === undefined) {
        return fail(`A conta ${cid} usa acompanhamento entre contas: a meta da conta fica na conta de conversão ${goalCid}, que está fora da allowlist. Nada foi alterado.`);
      }
      const goalQuery = `SELECT ${GOAL_FIELDS} FROM goal WHERE goal.goal_type = '${NCA_GOAL}'`;
      // Meta da conta: lida na conta onde ela precisa ficar (a de conversão, no acompanhamento entre contas).
      const conversionGoal = goalBlocked ? undefined : (await client.searchStream(goalCid, goalQuery)).map(goalView)[0];
      // Sem meta na conta de conversão, a conta cliente pode ter uma meta própria. Ela só serve para o vínculo
      // da campanha (CampaignGoalConfig na própria conta cliente); nunca é escrita pela rota da meta da conta,
      // que grava na conta de conversão — URL e resource name têm de ser da mesma conta.
      const clientGoal = !conversionGoal && crossAccount ? (await client.searchStream(customerId, goalQuery)).map(goalView)[0] : undefined;
      const goal = conversionGoal ?? clientGoal;

      const goalValues = (value: number | undefined, high: number | undefined) => ({
        ...(value !== undefined ? { additionalValue: value } : {}),
        ...(high !== undefined ? { additionalHighLifetimeValue: high } : {}),
      });
      const accountLine = crossAccount ? `conta de conversão ${goalCid} (acompanhamento entre contas de ${cid})` : `conta ${cid}`;

      // ── Meta da conta ──
      if (campaignId === undefined) {
        const accountGoal = conversionGoal;
        const sharedNote = crossAccount
          ? `\n\nA meta da conta de conversão ${goalCid} vale para todas as contas que usam ${goalCid} como conta de conversão.`
          : "";
        if (accountGoal) {
          const goal = accountGoal;
          const ownerCid = /^customers\/(\d+)\//.exec(goal.resource_name)?.[1];
          if (ownerCid !== goalCid) {
            return fail(`A meta ${goal.resource_name || "(sem resource name)"} não pertence à ${accountLine}; a atualização iria para uma conta diferente da dona da meta. Nada foi alterado.`);
          }
          const before = { additional_value: goal.additional_value, additional_high_lifetime_value: goal.additional_high_lifetime_value };
          const valueAfter = additionalValue ?? goal.additional_value ?? undefined;
          const highAfter = highLifetimeValue ?? goal.additional_high_lifetime_value ?? undefined;
          if (highAfter !== undefined && valueAfter === undefined) {
            return fail("highLifetimeValue exige additionalValue — a meta atual não tem valor base. Informe os dois. Nada foi alterado.");
          }
          if (highAfter !== undefined && valueAfter !== undefined && !(highAfter > valueAfter)) {
            return fail(`Depois da mudança highLifetimeValue (${highAfter}) ficaria menor ou igual a additionalValue (${valueAfter}); a API recusa. Informe os dois. Nada foi alterado.`);
          }
          const mask: string[] = [];
          const valueChanges = additionalValue !== undefined && additionalValue !== goal.additional_value;
          const highChanges = highLifetimeValue !== undefined && highLifetimeValue !== goal.additional_high_lifetime_value;
          if (valueChanges) mask.push("new_customer_acquisition_goal_settings.value_settings.additional_value");
          if (highChanges) mask.push("new_customer_acquisition_goal_settings.value_settings.additional_high_lifetime_value");
          if (mask.length === 0) {
            return { content: [text(`Meta de clientes novos da ${accountLine}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n${formatJson({ current: before })}`)] };
          }
          const update = {
            resourceName: goal.resource_name,
            newCustomerAcquisitionGoalSettings: {
              valueSettings: goalValues(valueChanges ? additionalValue : undefined, highChanges ? highLifetimeValue : undefined),
            },
          };
          try {
            await client.mutate(goalCid, "Goals", [{ update, updateMask: mask.join(",") }]);
          } catch (err) {
            return fail(`A API recusou a atualização da meta da ${accountLine}.\nErro: ${explainError((err as Error).message)}`);
          }
          const after = { additional_value: valueAfter ?? null, additional_high_lifetime_value: highAfter ?? null };
          return {
            content: [text(
              `${dryRun ? dryRunLine : `Meta de clientes novos da ${accountLine} atualizada.`}\n\n` +
              formatJson({ goal: goal.resource_name, before, after, update_mask: mask }) + sharedNote
            )],
          };
        }
        if (additionalValue === undefined) {
          return fail(`A ${accountLine} ainda não tem meta de clientes novos; para criar, informe additionalValue. Nada foi alterado.`);
        }
        if (clientGoal && confirm !== true) {
          // Só a conta cliente tem meta: não atualiza essa (não é a que vale no acompanhamento entre contas)
          // nem cria outra na conta de conversão sem o usuário ver a diferença.
          return fail(
            `A conta ${cid} usa acompanhamento entre contas: a meta da conta precisa ficar na conta de conversão ${goalCid} ` +
            `(guia de metas de ciclo de vida), que ainda não tem meta de clientes novos. A única meta visível é da própria conta ${cid} ` +
            `(${clientGoal.resource_name}) — ela não é alterada por esta tool. Para criar a meta na conta de conversão ${goalCid}, ` +
            `que vale para todas as contas que a usam, repita com confirm: true. Nada foi alterado.\n\n` +
            formatJson({
              client_account_goal: clientGoal,
              would_create_in: goalCid,
              values: { additional_value: additionalValue, additional_high_lifetime_value: highLifetimeValue ?? null },
            })
          );
        }
        const create = { goalType: NCA_GOAL, newCustomerAcquisitionGoalSettings: { valueSettings: goalValues(additionalValue, highLifetimeValue) } };
        let response: Row;
        try {
          response = await client.mutate(goalCid, "Goals", [{ create }]);
        } catch (err) {
          return fail(`A API recusou a criação da meta na ${accountLine}.\nErro: ${explainError((err as Error).message)}`);
        }
        const created = str(obj(rowsOf(response.results)[0]).resourceName);
        return {
          content: [text(
            `${dryRun ? dryRunLine : `Meta de clientes novos criada na ${accountLine}${created ? `: ${created}` : ""}.`}\n\n` +
            formatJson({
              created: { additional_value: additionalValue, additional_high_lifetime_value: highLifetimeValue ?? null },
              ...(clientGoal ? { client_account_goal_unchanged: clientGoal.resource_name } : {}),
            }) + sharedNote +
            (dryRun ? "" : "\n\nVincule campanhas com set_new_customer_acquisition (campaignId + mode).")
          )],
        };
      }

      // ── Configuração da campanha ──
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type
         FROM campaign WHERE campaign.id = ${campaignId}`);
      const campaign = campaignRows[0]?.campaign ? obj(campaignRows[0].campaign) : undefined;
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi alterado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi alterado.`);
      const campaignResource = `customers/${cid}/campaigns/${campaignId}`;
      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${campaign.advertisingChannelType})`;
      const configRows = await client.searchStream(customerId,
        `SELECT ${GOAL_CONFIG_FIELDS} FROM campaign_goal_config
         WHERE campaign_goal_config.campaign = '${campaignResource}'
           AND campaign_goal_config.goal_type = '${NCA_GOAL}'`);
      const config = configRows[0] ? goalConfigView(configRows[0], new Map([[campaignId, campaign]])) : undefined;

      const warnings: string[] = [];
      const bidding = str(campaign.biddingStrategyType);
      if (mode !== "OFF" && bidding && !CONVERSION_BIDDING.has(bidding)) {
        warnings.push(`A campanha usa ${bidding}: a meta de clientes novos só age em lances automáticos por conversão ou valor.`);
      }
      if (mode !== "OFF" && !["PERFORMANCE_MAX", "SEARCH", "SHOPPING"].includes(str(campaign.advertisingChannelType))) {
        warnings.push(`Tipo ${campaign.advertisingChannelType}: a API pode recusar (CUSTOMER_LIFECYCLE_OPTIMIZATION_CAMPAIGN_TYPE_NOT_SUPPORTED).`);
      }
      if (mode !== "OFF" && !config && clientGoal) {
        warnings.push(
          `Acompanhamento entre contas: a conta de conversão ${goalCid} ${goalBlocked ? "está fora da allowlist" : "não tem meta de clientes novos"}; ` +
          `o vínculo usa a meta da própria conta ${cid} (${clientGoal.resource_name}). O guia manda a meta da conta ficar na conta de conversão.`
        );
      }

      if (mode === "OFF") {
        if (!config) return { content: [text(`${campaignLine}: já está fora da meta de clientes novos. Nenhuma escrita foi enviada.`)] };
        if (confirm !== true) {
          return fail(`${campaignLine}: vai sair da meta de clientes novos (modo atual ${config.mode}). Nada foi alterado — repita com confirm: true.\n\n${formatJson({ current: config })}`);
        }
        try {
          await client.mutate(customerId, "CampaignGoalConfigs", [{ remove: config.resource_name }]);
        } catch (err) {
          return fail(`${campaignLine}: a API recusou a remoção.\nErro: ${explainError((err as Error).message)}`);
        }
        return { content: [text(`${campaignLine}: ${dryRun ? dryRunLine : "removida da meta de clientes novos (volta a otimizar para todos os clientes sem ajuste)."}\n\n${formatJson({ before: config, removed: config.resource_name })}`)] };
      }

      const targetOption = NCA_MODE_TO_TARGET[mode as string];
      if (config) {
        const mask: string[] = [];
        const settings: Row = {};
        const override: Row = {};
        const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
        if (config.target_option !== targetOption) {
          settings.targetOption = targetOption;
          mask.push("campaign_new_customer_acquisition_settings.target_option");
          changes.push({ setting: "mode", before: config.mode, after: mode });
        }
        const overridePath = "campaign_new_customer_acquisition_settings.value_settings_override";
        if (mode === "NEW_ONLY") {
          // Só clientes novos não aceita valor próprio: limpa o que houver (máscara sem valor = limpa)
          if (config.override_additional_value !== null) {
            mask.push(`${overridePath}.additional_value`);
            changes.push({ setting: "additionalValue (campanha)", before: config.override_additional_value, after: null });
          }
          if (config.override_additional_high_lifetime_value !== null) {
            mask.push(`${overridePath}.additional_high_lifetime_value`);
            changes.push({ setting: "highLifetimeValue (campanha)", before: config.override_additional_high_lifetime_value, after: null });
          }
        } else {
          const valueAfter = additionalValue ?? config.override_additional_value ?? undefined;
          const highAfter = highLifetimeValue ?? config.override_additional_high_lifetime_value ?? undefined;
          if (highAfter !== undefined && valueAfter === undefined) return fail("highLifetimeValue exige additionalValue na campanha. Nada foi alterado.");
          if (highAfter !== undefined && valueAfter !== undefined && !(highAfter > valueAfter)) {
            return fail(`highLifetimeValue (${highAfter}) ficaria menor ou igual a additionalValue (${valueAfter}). Informe os dois. Nada foi alterado.`);
          }
          if (additionalValue !== undefined && additionalValue !== config.override_additional_value) {
            override.additionalValue = additionalValue;
            mask.push(`${overridePath}.additional_value`);
            changes.push({ setting: "additionalValue (campanha)", before: config.override_additional_value, after: additionalValue });
          }
          if (highLifetimeValue !== undefined && highLifetimeValue !== config.override_additional_high_lifetime_value) {
            override.additionalHighLifetimeValue = highLifetimeValue;
            mask.push(`${overridePath}.additional_high_lifetime_value`);
            changes.push({ setting: "highLifetimeValue (campanha)", before: config.override_additional_high_lifetime_value, after: highLifetimeValue });
          }
        }
        if (mask.length === 0) {
          return { content: [text(`${campaignLine}: nada a mudar — já está em ${mode} com os valores pedidos. Nenhuma escrita foi enviada.\n\n${formatJson({ current: config, warnings })}`)] };
        }
        if (Object.keys(override).length > 0) settings.valueSettingsOverride = override;
        try {
          await client.mutate(customerId, "CampaignGoalConfigs", [{
            update: { resourceName: config.resource_name, campaignNewCustomerAcquisitionSettings: settings },
            updateMask: mask.join(","),
          }]);
        } catch (err) {
          return fail(`${campaignLine}: a API recusou a alteração.\nErro: ${explainError((err as Error).message)}\n\n${formatJson({ attempted: changes, update_mask: mask })}`);
        }
        return { content: [text(`${campaignLine}: ${dryRun ? dryRunLine : `meta de clientes novos em ${mode}.`}\n\n${formatJson({ changes, update_mask: mask, warnings })}`)] };
      }

      // Sem configuração: vincula a campanha à meta da conta (criando a meta se precisar)
      let goalResource = goal?.resource_name;
      let createdGoal: string | undefined;
      if (!goalResource) {
        if (mode !== "BID_HIGHER" || additionalValue === undefined) {
          return fail(`A ${accountLine} não tem meta de clientes novos. Crie antes: set_new_customer_acquisition sem campaignId, com additionalValue (ou use mode BID_HIGHER com additionalValue aqui). Nada foi alterado.`);
        }
        if (checkCustomerAccess(goalCid, allowedCustomerIds, hosted)) {
          return fail(`A meta da conta ficaria na conta de conversão ${goalCid}, fora da allowlist. Nada foi alterado.`);
        }
        let response: Row;
        try {
          response = await client.mutate(goalCid, "Goals", [{ create: { goalType: NCA_GOAL, newCustomerAcquisitionGoalSettings: { valueSettings: goalValues(additionalValue, highLifetimeValue) } } }]);
        } catch (err) {
          return fail(`A API recusou a criação da meta na ${accountLine}; a campanha não foi vinculada.\nErro: ${explainError((err as Error).message)}`);
        }
        if (dryRun) {
          return {
            content: [text(
              `${dryRunLine}\nValidada a criação da meta da ${accountLine} (additionalValue ${additionalValue}${highLifetimeValue !== undefined ? `, highLifetimeValue ${highLifetimeValue}` : ""}). ` +
              `O vínculo da ${campaignLine} depende do ID da meta, que só existe depois de gravar — ele não foi validado.\n\n${formatJson({ warnings })}`
            )],
          };
        }
        createdGoal = str(obj(rowsOf(response.results)[0]).resourceName);
        if (!createdGoal) return fail(`A API não devolveu a meta criada na ${accountLine}; confira com get_lifecycle_goals antes de repetir.`);
        goalResource = createdGoal;
      }
      const settings: Row = { targetOption };
      // Quando a meta acabou de ser criada, os valores foram para a conta — a campanha segue a conta.
      if (!createdGoal && mode === "BID_HIGHER" && (additionalValue !== undefined || highLifetimeValue !== undefined)) {
        settings.valueSettingsOverride = goalValues(additionalValue, highLifetimeValue);
      }
      try {
        await client.mutate(customerId, "CampaignGoalConfigs", [{
          create: { campaign: campaignResource, goal: goalResource, campaignNewCustomerAcquisitionSettings: settings },
        }]);
      } catch (err) {
        return fail(
          `${campaignLine}: a API recusou o vínculo com a meta de clientes novos.\nErro: ${explainError((err as Error).message)}` +
          (createdGoal ? `\nA meta da conta FOI criada (${createdGoal}); repita só o vínculo.` : "")
        );
      }
      return {
        content: [text(
          `${campaignLine}: ${dryRun ? dryRunLine : `meta de clientes novos em ${mode}.`}\n\n` +
          formatJson({ created_goal: createdGoal ?? null, goal: goalResource, mode, target_option: targetOption, value_override: settings.valueSettingsOverride ?? null, warnings })
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "tag_user_list_customer_type",
    {
      description: [
        "Marca (ou desmarca) listas de público com o tipo de cliente usado pelas metas de ciclo de vida",
        "(UserListCustomerTypeService). WRITE OPERATION.",
        "",
        "Categorias: PURCHASERS (compradores), HIGH_VALUE_CUSTOMERS, DISENGAGED_CUSTOMERS, QUALIFIED_LEADS,",
        "CONVERTED_LEADS, PAID_SUBSCRIBERS, CART_ABANDONERS, ALL_CUSTOMERS, LOYALTY_TIER_1..7_MEMBERS.",
        "Pares que a API recusa na mesma lista (conferidos antes de enviar): PURCHASERS × CONVERTED_LEADS,",
        "QUALIFIED_LEADS ou CART_ABANDONERS; CONVERTED_LEADS × QUALIFIED_LEADS; DISENGAGED_CUSTOMERS ×",
        "CONVERTED_LEADS, QUALIFIED_LEADS ou CART_ABANDONERS; dois níveis de fidelidade diferentes.",
        "Listas elegíveis: CRM_BASED (Customer Match) e RULE_BASED. action remove pede confirm: true.",
        "Categorias já marcadas são ignoradas (sem escrita repetida).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userListId: z.string().describe("ID numérico da lista (list_remarketing_lists)."),
        categories: flexArray(z.enum(USER_LIST_CATEGORIES)).describe("Categorias a marcar/desmarcar."),
        action: z.enum(["add", "remove"]).optional().describe("add (padrão) ou remove."),
        confirm: z.boolean().optional().describe("true para action remove."),
      },
    },
    async ({ customerId, userListId, categories, action, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(userListId)) return fail(`userListId deve ser numérico, recebido "${userListId}". Nada foi alterado.`);
      const wanted = cleanList(categories).map((category) => category.toUpperCase());
      const invalid = wanted.filter((category) => !(USER_LIST_CATEGORIES as readonly string[]).includes(category));
      if (wanted.length === 0) return fail("Informe ao menos uma categoria. Nada foi alterado.");
      if (invalid.length > 0) return fail(`Categorias inválidas: ${invalid.join(", ")}. Válidas: ${USER_LIST_CATEGORIES.join(", ")}. Nada foi alterado.`);
      const op = action ?? "add";

      const client = ctx.getClient();
      const lists = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name, user_list.type, user_list.account_user_list_status
         FROM user_list WHERE user_list.id = ${userListId}`);
      const userList = lists[0]?.userList ? obj(lists[0].userList) : undefined;
      if (!userList) return fail(`Lista ${userListId} não encontrada na conta ${cid}. Nada foi alterado.`);
      const listResource = `customers/${cid}/userLists/${userListId}`;
      const existingRows = await client.searchStream(customerId,
        `SELECT user_list_customer_type.resource_name, user_list_customer_type.customer_type_category
         FROM user_list_customer_type
         WHERE user_list_customer_type.user_list = '${listResource}'`);
      const existing = new Map(existingRows.map((row) => {
        const type = obj(row.userListCustomerType);
        return [str(type.customerTypeCategory), str(type.resourceName)] as const;
      }));
      const listLine = `Lista ${userListId} ("${userList.name}", ${userList.type})`;
      const warnings: string[] = [];
      if (!["CRM_BASED", "RULE_BASED"].includes(str(userList.type))) {
        warnings.push(`Tipo ${userList.type}: a API costuma aceitar só listas CRM_BASED e RULE_BASED (USERLIST_NOT_ELIGIBLE).`);
      }

      if (op === "add") {
        const toCreate = wanted.filter((category) => !existing.has(category));
        const already = wanted.filter((category) => existing.has(category));
        const conflicts: string[] = [];
        const finalSet = [...existing.keys(), ...toCreate];
        for (const category of toCreate) {
          for (const other of finalSet) {
            if (other !== category && categoriesConflict(category, other) && !conflicts.includes(`${other} × ${category}`)) {
              conflicts.push(`${category} × ${other}`);
            }
          }
        }
        if (conflicts.length > 0) {
          return fail(`${listLine}: categorias conflitantes (a API recusa com CONFLICTING_CUSTOMER_TYPES): ${conflicts.join("; ")}. ` +
            `Já marcadas: ${[...existing.keys()].join(", ") || "nenhuma"}. Nada foi alterado.`);
        }
        if (toCreate.length === 0) {
          return { content: [text(`${listLine}: nada a mudar — ${already.join(", ")} já marcada(s). Nenhuma escrita foi enviada.`)] };
        }
        const { applied, errors } = await mutateEach(client, customerId, "userListCustomerTypes",
          toCreate.map((category) => ({ create: { userList: listResource, customerTypeCategory: category } })),
          toCreate.map((category) => ({ category })));
        const dryRun = client.isDryRun;
        return {
          content: [text(
            `${listLine}: ${dryRun ? `${dryRunLine} Validadas: ${applied.length}` : `${applied.length} categoria(s) marcada(s)`} | já marcadas: ${already.length} | com erro: ${errors.length}\n\n` +
            formatJson({ [dryRun ? "validated" : "added"]: applied, already_tagged: already, errors, warnings })
          )],
          isError: errors.length > 0,
        };
      }

      const toRemove = wanted.filter((category) => existing.has(category));
      const notTagged = wanted.filter((category) => !existing.has(category));
      if (toRemove.length === 0) {
        return { content: [text(`${listLine}: nada a desmarcar — ${notTagged.join(", ")} não está(ão) marcada(s). Nenhuma escrita foi enviada.`)] };
      }
      if (confirm !== true) {
        return fail(`${listLine}: vai desmarcar ${toRemove.join(", ")} (as metas de ciclo de vida deixam de usar a lista para essa categoria). Nada foi alterado — repita com confirm: true.`);
      }
      const { applied, errors } = await mutateEach(client, customerId, "userListCustomerTypes",
        toRemove.map((category) => ({ remove: existing.get(category) as string })),
        toRemove.map((category) => ({ category })));
      const dryRun = client.isDryRun;
      return {
        content: [text(
          `${listLine}: ${dryRun ? `${dryRunLine} Validadas: ${applied.length}` : `${applied.length} categoria(s) desmarcada(s)`} | não marcadas: ${notTagged.length} | com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "removed"]: applied, not_tagged: notTagged, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "get_new_vs_returning_performance",
    {
      description: [
        "Conversões de clientes novos × recorrentes por campanha (segments.new_versus_returning_customers).",
        "READ OPERATION.",
        "",
        "O segmento só combina com métricas de conversão (conversões, valor, valor de vida útil de cliente novo);",
        "custo vem de uma segunda consulta sem o segmento, então o custo por conversão de cliente novo é",
        "aproximado (custo total ÷ conversões de clientes novos). Categorias: NEW, NEW_AND_HIGH_LTV, RETURNING,",
        "UNKNOWN. Use para medir a meta de aquisição de clientes novos (get_lifecycle_goals).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra uma campanha."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const dateClause = buildDateClause(dateRange, days);
      const filters = [dateClause, "campaign.status != 'REMOVED'"];
      if (campaignId) filters.push(`campaign.id = ${campaignId}`);

      const client = ctx.getClient();
      const segmented = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
                segments.new_versus_returning_customers,
                metrics.conversions, metrics.conversions_value, metrics.all_conversions,
                metrics.new_customer_lifetime_value
         FROM campaign
         WHERE ${filters.join(" AND ")}`);
      const costs = await client.searchStream(customerId,
        `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE ${filters.join(" AND ")}`);
      const costById = new Map<string, number>();
      for (const row of costs) {
        const id = str(obj(row.campaign).id);
        costById.set(id, (costById.get(id) ?? 0) + num(obj(row.metrics).costMicros));
      }

      const byCampaign = new Map<string, Row>();
      for (const row of segmented) {
        const campaign = obj(row.campaign);
        const id = str(campaign.id);
        const bucket = str(obj(row.segments).newVersusReturningCustomers) || "UNKNOWN";
        const metrics = obj(row.metrics);
        const entry = byCampaign.get(id) ?? {
          campaign_id: id, campaign_name: str(campaign.name), channel: str(campaign.advertisingChannelType),
          new_conversions: 0, new_high_ltv_conversions: 0, returning_conversions: 0, unknown_conversions: 0,
          new_conversions_value: 0, returning_conversions_value: 0, new_customer_lifetime_value: 0,
        };
        const conversions = num(metrics.conversions);
        const value = num(metrics.conversionsValue);
        if (bucket === "NEW") { entry.new_conversions = num(entry.new_conversions) + conversions; entry.new_conversions_value = num(entry.new_conversions_value) + value; }
        else if (bucket === "NEW_AND_HIGH_LTV") { entry.new_high_ltv_conversions = num(entry.new_high_ltv_conversions) + conversions; entry.new_conversions_value = num(entry.new_conversions_value) + value; }
        else if (bucket === "RETURNING") { entry.returning_conversions = num(entry.returning_conversions) + conversions; entry.returning_conversions_value = num(entry.returning_conversions_value) + value; }
        else entry.unknown_conversions = num(entry.unknown_conversions) + conversions;
        entry.new_customer_lifetime_value = num(entry.new_customer_lifetime_value) + num(metrics.newCustomerLifetimeValue);
        byCampaign.set(id, entry);
      }
      const rows = [...byCampaign.values()].map((entry) => {
        const newTotal = num(entry.new_conversions) + num(entry.new_high_ltv_conversions);
        const known = newTotal + num(entry.returning_conversions);
        const spend = (costById.get(str(entry.campaign_id)) ?? 0) / 1_000_000;
        return {
          ...entry,
          new_conversions: round2(num(entry.new_conversions)),
          new_high_ltv_conversions: round2(num(entry.new_high_ltv_conversions)),
          returning_conversions: round2(num(entry.returning_conversions)),
          unknown_conversions: round2(num(entry.unknown_conversions)),
          new_conversions_value: round2(num(entry.new_conversions_value)),
          returning_conversions_value: round2(num(entry.returning_conversions_value)),
          new_customer_lifetime_value: round2(num(entry.new_customer_lifetime_value)),
          new_share_pct: known ? round2((newTotal / known) * 100) : null,
          spend: round2(spend),
          approx_cost_per_new_customer_conversion: newTotal ? round2(spend / newTotal) : null,
        } as Row;
      }).sort((a, b) => num(b.spend) - num(a.spend));

      return {
        content: [text(render(format, rows, () =>
          `${rows.length} campanha(s) com conversões segmentadas por cliente novo × recorrente (${dateClause}).\n` +
          "Custo por conversão de cliente novo é aproximado: o custo não se divide por esse segmento.\n\n" +
          formatJson(rows)))],
      };
    }
  );

  // ══ EXPERIMENTOS (item 58) ═════════════════════════════════════════

  ctx.mcp.registerTool(
    "create_experiment",
    {
      description: [
        "Cria um experimento com os dois braços numa única operação atômica (googleAds:mutate). WRITE OPERATION.",
        "",
        "type:",
        "- SEARCH_CUSTOM / DISPLAY_CUSTOM / HOTEL_CUSTOM: A/B de campanha. controlCampaignId + suffix; o Google cria",
        "  a campanha de tratamento em RASCUNHO (in_design_campaigns). Altere-a com update_experiment_campaign",
        "  (ou set_tracking) — pelo menos uma mudança é obrigatória — e depois schedule_experiment.",
        "- PMAX_REPLACEMENT_SHOPPING: Shopping (controle) × Performance Max. treatmentCampaignId = PMax existente,",
        "  ou vazio para o Google criar a PMax em rascunho. Não pode ser promovido.",
        "- ADOPT_AI_MAX / ADOPT_BROAD_MATCH_KEYWORDS: teste dentro da campanha de Pesquisa (50/50 fixo). No",
        "  ADOPT_AI_MAX a mesma operação liga o AI Max (e, como no exemplo oficial, personalização de texto e",
        "  expansão de URL final — desligue com aiMaxTextCustomization/aiMaxFinalUrlExpansion=false).",
        "- COMPARE_CAMPAIGNS: compara campanhas existentes. arms = [{name, campaignIds, trafficSplit, control?}]",
        "  (2 a 5 braços, soma 100, mínimo 1%).",
        "- OPTIMIZE_ASSETS (PMax): assetGroupId + treatmentTextAssets [{fieldType, text}] — cria os textos novos",
        "  e os testa no braço de tratamento.",
        "trafficSplit = % do tratamento (padrão 50). startDate/endDate YYYY-MM-DD (fuso da conta).",
        "Guia: descarte os 7 primeiros dias de PMAX_REPLACEMENT_SHOPPING (aprendizado).",
        "Depois: list_experiments, get_experiment_results, end/promote/graduate_experiment.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        type: z.enum(CREATE_EXPERIMENT_TYPES).describe("Tipo do experimento."),
        name: z.string().describe("Nome único do experimento (1 a 1024 caracteres)."),
        description: z.string().optional().describe("Descrição (até 2048 caracteres)."),
        suffix: z.string().optional().describe("Sufixo do nome da campanha de tratamento (obrigatório nos tipos com rascunho). Ex.: \" [teste tCPA]\"."),
        controlCampaignId: z.string().optional().describe("Campanha base / controle."),
        trafficSplit: z.number().optional().describe("% do tráfego no tratamento (1 a 99). Padrão 50."),
        startDate: z.string().optional().describe("Início YYYY-MM-DD (não pode ser no passado)."),
        endDate: z.string().optional().describe("Fim YYYY-MM-DD."),
        syncEnabled: z.boolean().optional().describe("Copia mudanças da campanha base para o tratamento (só SEARCH_CUSTOM/DISPLAY_CUSTOM)."),
        treatmentCampaignId: z.string().optional().describe("PMAX_REPLACEMENT_SHOPPING: PMax existente para o tratamento."),
        arms: z
          .array(z.object({
            name: z.string(),
            campaignIds: flexArray(z.string()),
            trafficSplit: z.number(),
            control: z.boolean().optional(),
          }))
          .optional()
          .describe("COMPARE_CAMPAIGNS: braços. Sem control, o primeiro é o controle."),
        assetGroupId: z.string().optional().describe("OPTIMIZE_ASSETS: grupo de recursos (PMax) base."),
        treatmentTextAssets: z
          .array(z.object({ fieldType: z.enum(OPTIMIZE_ASSET_FIELDS), text: z.string() }))
          .optional()
          .describe("OPTIMIZE_ASSETS: textos novos testados no tratamento."),
        aiMaxTextCustomization: z.boolean().optional().describe("ADOPT_AI_MAX: personalização de texto (padrão true, como no exemplo oficial)."),
        aiMaxFinalUrlExpansion: z.boolean().optional().describe("ADOPT_AI_MAX: expansão de URL final (padrão true)."),
        controlArmName: z.string().optional().describe("Nome do braço de controle (padrão \"Controle\")."),
        treatmentArmName: z.string().optional().describe("Nome do braço de tratamento (padrão \"Tratamento\")."),
      },
    },
    async (args) => {
      const {
        customerId, type, name, description, suffix, controlCampaignId, trafficSplit, startDate, endDate, syncEnabled,
        treatmentCampaignId, arms, assetGroupId, treatmentTextAssets, aiMaxTextCustomization, aiMaxFinalUrlExpansion,
        controlArmName, treatmentArmName,
      } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi criado.`);
      const systemManaged = (SYSTEM_MANAGED_TYPES as readonly string[]).includes(type);
      const intra = (INTRA_CAMPAIGN_TYPES as readonly string[]).includes(type);
      const problems: string[] = [];
      const cleanName = name.trim();
      if (!cleanName || cleanName.length > 1024) problems.push("name precisa ter de 1 a 1024 caracteres");
      if (description !== undefined && description.length > 2048) problems.push("description passa de 2048 caracteres");
      for (const [label, value] of [["startDate", startDate], ["endDate", endDate]] as const) {
        if (value !== undefined && !ISO_DATE.test(value)) problems.push(`${label} deve ser YYYY-MM-DD (recebido ${value})`);
      }
      if (startDate && ISO_DATE.test(startDate) && startDate < localIsoDate(new Date())) problems.push(`startDate ${startDate} está no passado`);
      if (startDate && endDate && ISO_DATE.test(startDate) && ISO_DATE.test(endDate) && endDate < startDate) problems.push("endDate antes de startDate");
      if (syncEnabled !== undefined && !SYNC_TYPES.has(type)) problems.push("syncEnabled só vale em SEARCH_CUSTOM e DISPLAY_CUSTOM");
      if (controlCampaignId !== undefined && !ID.test(controlCampaignId)) problems.push(`controlCampaignId deve ser numérico (recebido "${controlCampaignId}")`);
      if (treatmentCampaignId !== undefined && !ID.test(treatmentCampaignId)) problems.push(`treatmentCampaignId deve ser numérico (recebido "${treatmentCampaignId}")`);
      if (treatmentCampaignId !== undefined && type !== "PMAX_REPLACEMENT_SHOPPING") problems.push("treatmentCampaignId só vale em PMAX_REPLACEMENT_SHOPPING");
      const split = trafficSplit ?? 50;
      if (!Number.isInteger(split) || split < 1 || split > 99) problems.push(`trafficSplit deve ser inteiro de 1 a 99 (recebido ${trafficSplit})`);
      if (intra && split !== 50) problems.push(`${type} divide o tráfego 50/50 dentro da campanha — trafficSplit não pode mudar`);
      if (type !== "COMPARE_CAMPAIGNS" && arms !== undefined) problems.push("arms só vale em COMPARE_CAMPAIGNS");
      if (type !== "OPTIMIZE_ASSETS" && (assetGroupId !== undefined || treatmentTextAssets !== undefined)) problems.push("assetGroupId/treatmentTextAssets só valem em OPTIMIZE_ASSETS");
      if (type !== "ADOPT_AI_MAX" && (aiMaxTextCustomization !== undefined || aiMaxFinalUrlExpansion !== undefined)) problems.push("aiMaxTextCustomization/aiMaxFinalUrlExpansion só valem em ADOPT_AI_MAX");
      if (systemManaged && !suffix?.trim()) problems.push(`${type} exige suffix (vai no nome da campanha de tratamento)`);
      if ((systemManaged || intra) && !controlCampaignId) problems.push(`${type} exige controlCampaignId`);

      // COMPARE_CAMPAIGNS: braços informados pelo usuário
      const compareArms: Array<{ name: string; campaignIds: string[]; trafficSplit: number; control: boolean }> = [];
      if (type === "COMPARE_CAMPAIGNS") {
        const list = arms ?? [];
        if (list.length < 2 || list.length > 5) problems.push("COMPARE_CAMPAIGNS precisa de 2 a 5 braços em arms");
        const controls = list.filter((arm) => arm.control === true).length;
        if (controls > 1) problems.push("só um braço pode ser o controle");
        list.forEach((arm, index) => {
          const ids = cleanList(arm.campaignIds);
          const bad = ids.filter((id) => !ID.test(id));
          if (!arm.name.trim()) problems.push(`arms[${index}]: name vazio`);
          if (ids.length === 0) problems.push(`arms[${index}]: informe campaignIds`);
          if (bad.length > 0) problems.push(`arms[${index}]: IDs não numéricos ${bad.join(", ")}`);
          if (!Number.isInteger(arm.trafficSplit) || arm.trafficSplit < 1) problems.push(`arms[${index}]: trafficSplit deve ser inteiro ≥ 1`);
          compareArms.push({ name: arm.name.trim(), campaignIds: ids, trafficSplit: arm.trafficSplit, control: controls === 0 ? index === 0 : arm.control === true });
        });
        const total = list.reduce((sum, arm) => sum + arm.trafficSplit, 0);
        if (list.length >= 2 && total !== 100) problems.push(`a soma de trafficSplit dos braços deve ser 100 (recebido ${total})`);
        const signatures = compareArms.map((arm) => [...arm.campaignIds].sort().join(","));
        if (new Set(signatures).size !== signatures.length) problems.push("dois braços com exatamente as mesmas campanhas");
        if (controlCampaignId !== undefined || trafficSplit !== undefined) problems.push("em COMPARE_CAMPAIGNS use arms (controlCampaignId/trafficSplit não valem)");
      }

      const assets = (treatmentTextAssets ?? []).map((asset) => ({ fieldType: asset.fieldType, text: asset.text.trim() }));
      if (type === "OPTIMIZE_ASSETS") {
        if (!assetGroupId || !ID.test(assetGroupId)) problems.push("OPTIMIZE_ASSETS exige assetGroupId numérico");
        if (assets.length === 0) problems.push("OPTIMIZE_ASSETS exige treatmentTextAssets (os textos novos a testar)");
        for (const asset of assets) {
          const max = OPTIMIZE_ASSET_MAX_CHARS[asset.fieldType];
          if (!asset.text) problems.push(`${asset.fieldType}: texto vazio`);
          else if (asset.text.length > max) problems.push(`${asset.fieldType} "${asset.text}" tem ${asset.text.length} caracteres (máx. ${max})`);
        }
      }
      if (problems.length > 0) return fail(`Nada foi criado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const dryRun = client.isDryRun;
      const duplicate = await client.searchStream(customerId,
        `SELECT experiment.experiment_id, experiment.name, experiment.status FROM experiment
         WHERE experiment.name = '${gaqlLiteral(cleanName)}'`);
      const active = duplicate.find((row) => obj(row.experiment).status !== "REMOVED");
      if (active) return fail(`Já existe o experimento "${cleanName}" (ID ${obj(active.experiment).experimentId}, ${obj(active.experiment).status}). Use outro nome. Nada foi criado.`);

      // Campanhas envolvidas: existem, não estão removidas, são BASE e do tipo certo
      let assetGroup: Row | undefined;
      if (type === "OPTIMIZE_ASSETS") {
        const groups = await client.searchStream(customerId,
          `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.campaign, campaign.id,
                  campaign.advertising_channel_type
           FROM asset_group WHERE asset_group.id = ${assetGroupId}`);
        assetGroup = groups[0];
        if (!assetGroup) return fail(`Grupo de recursos ${assetGroupId} não encontrado na conta ${cid}. Nada foi criado.`);
        if (obj(assetGroup.assetGroup).status === "REMOVED") return fail(`Grupo de recursos ${assetGroupId} está removido. Nada foi criado.`);
      }
      const campaignIds = [
        ...(controlCampaignId ? [controlCampaignId] : []),
        ...(treatmentCampaignId ? [treatmentCampaignId] : []),
        ...compareArms.flatMap((arm) => arm.campaignIds),
        ...(assetGroup ? [str(obj(assetGroup.campaign).id)] : []),
      ].filter((id) => ID.test(id));
      if (campaignIds.length === 0) return fail("Nenhuma campanha identificada para o experimento. Nada foi criado.");
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.experiment_type, campaign.bidding_strategy_type, campaign.campaign_budget,
                campaign_budget.explicitly_shared, campaign.ai_max_setting.enable_ai_max,
                campaign.asset_automation_settings
         FROM campaign WHERE campaign.id IN (${[...new Set(campaignIds)].join(", ")})`);
      const campaigns = new Map(campaignRows.map((row) => [str(obj(row.campaign).id), row] as const));
      const missing = [...new Set(campaignIds)].filter((id) => !campaigns.has(id));
      if (missing.length > 0) return fail(`Campanha(s) não encontrada(s) na conta ${cid}: ${missing.join(", ")}. Nada foi criado.`);
      const warnings: string[] = [];
      for (const id of new Set(campaignIds)) {
        const campaign = obj(campaigns.get(id)?.campaign);
        if (campaign.status === "REMOVED") problems.push(`campanha ${id} ("${campaign.name}") está removida`);
        if (campaign.experimentType && campaign.experimentType !== "BASE") problems.push(`campanha ${id} é ${campaign.experimentType} — use a campanha original (BASE)`);
      }
      const control = controlCampaignId ? obj(campaigns.get(controlCampaignId)?.campaign) : {};
      const expectedChannel = CONTROL_CHANNEL[type];
      if (controlCampaignId && expectedChannel && control.advertisingChannelType !== expectedChannel) {
        problems.push(`${type} exige campanha de controle ${expectedChannel}; a ${controlCampaignId} é ${control.advertisingChannelType}`);
      }
      if (treatmentCampaignId && obj(campaigns.get(treatmentCampaignId)?.campaign).advertisingChannelType !== "PERFORMANCE_MAX") {
        problems.push(`treatmentCampaignId ${treatmentCampaignId} precisa ser Performance Max`);
      }
      if (type === "COMPARE_CAMPAIGNS") {
        for (const id of compareArms.flatMap((arm) => arm.campaignIds)) {
          if (obj(campaigns.get(id)?.campaign).advertisingChannelType === "HOTEL") problems.push(`COMPARE_CAMPAIGNS não aceita campanha de Hotel (${id})`);
        }
      }
      if (assetGroup && obj(assetGroup.campaign).advertisingChannelType !== "PERFORMANCE_MAX") {
        problems.push(`OPTIMIZE_ASSETS é só para Performance Max; o grupo ${assetGroupId} é de ${obj(assetGroup.campaign).advertisingChannelType}`);
      }
      if (controlCampaignId && (systemManaged || intra) && obj(campaigns.get(controlCampaignId)?.campaignBudget).explicitlyShared === true) {
        problems.push(`a campanha ${controlCampaignId} usa orçamento compartilhado — experimentos não aceitam (CANNOT_ADD_CAMPAIGN_WITH_SHARED_BUDGET)`);
      }
      if (type === "ADOPT_AI_MAX" && obj(control.aiMaxSetting).enableAiMax === true) {
        problems.push(`a campanha ${controlCampaignId} já está com AI Max ligado — não há o que testar com ADOPT_AI_MAX`);
      }
      if (problems.length > 0) return fail(`Nada foi criado:\n- ${problems.join("\n- ")}`);

      // ── Operações atômicas (IDs temporários) ──
      const experimentResource = `customers/${cid}/experiments/-1`;
      const campaignResource = (id: string) => `customers/${cid}/campaigns/${id}`;
      const experiment: Row = { resourceName: experimentResource, name: cleanName, type };
      if (description?.trim()) experiment.description = description.trim();
      if (suffix?.trim()) experiment.suffix = suffix;
      if (systemManaged) experiment.status = "SETUP";
      if (startDate) experiment.startDate = startDate;
      if (endDate) experiment.endDate = endDate;
      if (syncEnabled !== undefined) experiment.syncEnabled = syncEnabled;
      if (type === "OPTIMIZE_ASSETS") experiment.optimizeAssetsExperiment = { optimizeAssetsExperimentSubtype: "COMPARE_ASSETS" };

      const operations: Row[] = [];
      const arm = (fields: Row) => ({ experimentArmOperation: { create: { experiment: experimentResource, ...fields } } });
      const controlName = controlArmName?.trim() || "Controle";
      const treatmentName = treatmentArmName?.trim() || "Tratamento";
      if (type === "OPTIMIZE_ASSETS") {
        const groupResource = `customers/${cid}/assetGroups/${assetGroupId}`;
        const baseCampaign = str(obj(assetGroup?.assetGroup).campaign);
        const assetResources = assets.map((_, index) => `customers/${cid}/assets/-${index + 2}`);
        // Ordem do exemplo oficial (create_asset_optimization_experiment.py):
        // assets → experimento → braços → vínculos asset group asset
        assets.forEach((asset, index) => operations.push({ assetOperation: { create: { resourceName: assetResources[index], textAsset: { text: asset.text } } } }));
        operations.push({ experimentOperation: { create: experiment } });
        operations.push(arm({ name: controlName, control: true, trafficSplit: 100 - split, campaigns: [baseCampaign], assetGroups: [{ assetGroup: groupResource }] }));
        operations.push(arm({
          name: treatmentName, control: false, trafficSplit: split, campaigns: [baseCampaign],
          assetGroups: [{ assetGroup: groupResource, assetGroupAssets: assets.map((asset, index) => ({ asset: assetResources[index], fieldType: asset.fieldType })) }],
        }));
        assets.forEach((asset, index) => operations.push({ assetGroupAssetOperation: { create: { assetGroup: groupResource, asset: assetResources[index], fieldType: asset.fieldType } } }));
      } else {
        operations.push({ experimentOperation: { create: experiment } });
        if (type === "COMPARE_CAMPAIGNS") {
          for (const entry of compareArms) {
            operations.push(arm({ name: entry.name, control: entry.control, trafficSplit: entry.trafficSplit, campaigns: entry.campaignIds.map(campaignResource) }));
          }
        } else if (intra) {
          operations.push(arm({ name: controlName, control: true, trafficSplit: 50, campaigns: [campaignResource(controlCampaignId as string)] }));
          operations.push(arm({ name: treatmentName, control: false, trafficSplit: 50, campaigns: [campaignResource(controlCampaignId as string)] }));
        } else {
          operations.push(arm({ name: controlName, control: true, trafficSplit: 100 - split, campaigns: [campaignResource(controlCampaignId as string)] }));
          operations.push(arm({
            name: treatmentName, control: false, trafficSplit: split,
            ...(treatmentCampaignId ? { campaigns: [campaignResource(treatmentCampaignId)] } : {}),
          }));
        }
      }

      // ADOPT_AI_MAX: o feature é ligado na mesma operação (guia intra-campaign / exemplo oficial)
      const campaignChanges: Array<{ setting: string; before: unknown; after: unknown }> = [];
      if (type === "ADOPT_AI_MAX") {
        const update: Row = { resourceName: campaignResource(controlCampaignId as string), aiMaxSetting: { enableAiMax: true } };
        const mask = ["ai_max_setting.enable_ai_max"];
        campaignChanges.push({ setting: "AI Max", before: false, after: true });
        // asset_automation_settings é repetido: reenviamos os tipos que não mexemos como estão
        const current = rowsOf(control.assetAutomationSettings).map((setting) => ({
          assetAutomationType: str(setting.assetAutomationType), assetAutomationStatus: str(setting.assetAutomationStatus),
        }));
        let automation = [...current];
        let changed = false;
        for (const [automationType, wantedOn, label] of [
          ["TEXT_ASSET_AUTOMATION", aiMaxTextCustomization ?? true, "Personalização de texto"],
          ["FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", aiMaxFinalUrlExpansion ?? true, "Expansão de URL final"],
        ] as const) {
          const status = wantedOn ? "OPTED_IN" : "OPTED_OUT";
          const before = current.find((setting) => setting.assetAutomationType === automationType)?.assetAutomationStatus;
          if (before === status) continue;
          automation = automation.filter((setting) => setting.assetAutomationType !== automationType).concat([{ assetAutomationType: automationType, assetAutomationStatus: status }]);
          changed = true;
          campaignChanges.push({ setting: label, before: before ?? "padrão da API", after: status });
        }
        if (changed) {
          update.assetAutomationSettings = automation;
          mask.push("asset_automation_settings");
        }
        operations.push({ campaignOperation: { update, updateMask: mask.join(",") } });
      }

      let response: Row;
      try {
        response = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`A API recusou o experimento — nada foi criado (a operação é atômica).\nErro: ${explainError((err as Error).message)}`);
      }
      if (dryRun) {
        return {
          content: [text(
            `Experimento "${cleanName}" (${type}) — ${dryRunLine}\n\n` +
            formatJson({ operations: operations.length, campaign_changes: campaignChanges, warnings })
          )],
        };
      }
      const responses = rowsOf(response.mutateOperationResponses);
      const experimentCreated = str(responses.map((entry) => obj(entry.experimentResult).resourceName).find(Boolean));
      if (!experimentCreated) {
        return fail(`A API não confirmou a criação do experimento — confira com list_experiments antes de repetir.\n\n${formatJson(response)}`);
      }
      const experimentId = lastId(experimentCreated);
      let armViews: ArmView[] = [];
      try {
        armViews = await readArms(client, customerId, [experimentCreated]);
      } catch (err) {
        warnings.push(`Experimento criado, mas a leitura dos braços falhou: ${(err as Error).message}`);
      }
      const names = await readCampaignNames(client, customerId, armViews.flatMap((view) => [...view.campaign_ids, ...view.in_design_campaign_ids])).catch(() => new Map<string, Row>());
      const inDesign = armViews.flatMap((view) => view.in_design_campaign_ids);
      const next = systemManaged && !treatmentCampaignId
        ? `Próximo passo: altere a campanha de tratamento em rascunho (${inDesign.join(", ") || "ver list_experiments"}) com update_experiment_campaign ou set_tracking — pelo menos uma mudança é obrigatória — e depois schedule_experiment.`
        : systemManaged
          ? "Próximo passo: schedule_experiment."
          : "Próximo passo: confira o status com list_experiments; se continuar em SETUP, agende com schedule_experiment.";
      return {
        content: [text(
          `Experimento criado: "${cleanName}" (${type}), ID ${experimentId}.\n${next}\n\n` +
          formatJson({
            experiment: experimentCreated,
            arms: armViews.map((view) => ({
              name: view.name, control: view.control, traffic_split: view.traffic_split,
              campaigns: describeCampaigns(view.campaign_ids, names),
              in_design_campaigns: describeCampaigns(view.in_design_campaign_ids, names),
            })),
            campaign_changes: campaignChanges,
            warnings,
          })
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "list_experiments",
    {
      description: [
        "Lista os experimentos da conta com os braços (controle/tratamento, divisão de tráfego, campanhas e",
        "campanhas em rascunho) e, se pedido, os erros assíncronos do último agendamento/promoção. READ OPERATION.",
        "",
        "status: SETUP (em montagem), INITIATED (agendado, criando campanhas), ENABLED (rodando), HALTED",
        "(encerrado), PROMOTED, GRADUATED, REMOVED. promote_status acompanha a promoção assíncrona.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().optional().describe("Um experimento só."),
        includeRemoved: z.boolean().optional().describe("Inclui removidos. Padrão false."),
        includeAsyncErrors: z.boolean().optional().describe("Busca os erros assíncronos (padrão: true com experimentId, false sem)."),
        format: formatSchema,
      },
    },
    async ({ customerId, experimentId, includeRemoved, includeAsyncErrors, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (experimentId !== undefined && !ID.test(experimentId)) return fail(`experimentId deve ser numérico, recebido "${experimentId}".`);
      const filters: string[] = [];
      if (!includeRemoved) filters.push("experiment.status != 'REMOVED'");
      if (experimentId) filters.push(`experiment.experiment_id = ${experimentId}`);

      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${EXPERIMENT_FIELDS} FROM experiment${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}
         ORDER BY experiment.experiment_id DESC`);
      if (experimentId && rows.length === 0) return fail(`Experimento ${experimentId} não encontrado na conta ${cleanCid(customerId)}.`);
      const experiments = rows.map((row) => obj(row.experiment));
      const arms = await readArms(client, customerId, experiments.map((experiment) => str(experiment.resourceName)));
      const names = await readCampaignNames(client, customerId, arms.flatMap((arm) => [...arm.campaign_ids, ...arm.in_design_campaign_ids]));
      const wantErrors = includeAsyncErrors ?? Boolean(experimentId);

      const views: Row[] = [];
      for (const experiment of experiments) {
        const id = str(experiment.experimentId);
        const view: Row = {
          experiment_id: id,
          name: str(experiment.name),
          type: str(experiment.type),
          status: str(experiment.status),
          start_date: str(experiment.startDate) || null,
          end_date: str(experiment.endDate) || null,
          suffix: str(experiment.suffix) || null,
          sync_enabled: experiment.syncEnabled ?? null,
          promote_status: str(experiment.promoteStatus) || null,
          long_running_operation: str(experiment.longRunningOperation) || null,
          goals: experiment.goals ?? [],
          description: str(experiment.description) || null,
          arms: arms.filter((arm) => arm.experiment === str(experiment.resourceName)).map((arm) => ({
            name: arm.name,
            control: arm.control,
            traffic_split: arm.traffic_split,
            campaigns: describeCampaigns(arm.campaign_ids, names),
            in_design_campaigns: describeCampaigns(arm.in_design_campaign_ids, names),
          })),
        };
        if (wantErrors) view.async_errors = await experimentAsyncErrors(client, customerId, id);
        views.push(view);
      }
      const flat = views.map((view) => ({
        experiment_id: view.experiment_id, name: view.name, type: view.type, status: view.status,
        start_date: view.start_date, end_date: view.end_date, promote_status: view.promote_status,
        arms: (view.arms as Row[]).map((arm) => `${arm.control ? "controle" : "tratamento"} ${arm.traffic_split}%: ${
          [...rowsOf(arm.campaigns), ...rowsOf(arm.in_design_campaigns)].map((campaign) => campaign.id).join("+")}`).join(" | "),
      }));
      return { content: [text(render(format, flat, () => `${views.length} experimento(s).\n\n${formatJson(views)}`))] };
    }
  );

  ctx.mcp.registerTool(
    "get_experiment_results",
    {
      description: [
        "Resultado de um experimento: tratamento × controle com lift, intervalo de confiança e p-valor, e se a",
        "diferença é estatisticamente significativa. READ OPERATION.",
        "",
        "Métricas: cliques, impressões, custo, conversões (diferença absoluta), CPA, valor de conversão e",
        "valor/custo (ROAS). Lift relativo = tratamento/controle − 1; intervalo = estimativa ± margem de erro",
        "(nível de confiança definido pelo Google conforme o tipo). Significativo = p ≤ pValueThreshold (padrão",
        "0,05) e intervalo sem cruzar zero. Os números cobrem o experimento inteiro.",
        "PMAX_REPLACEMENT_SHOPPING: o Google recomenda descartar os 7 primeiros dias (aprendizado).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().describe("ID do experimento (list_experiments)."),
        pValueThreshold: z.number().optional().describe("Limite do p-valor (0 a 1, exclusivo). Padrão 0.05 (95%)."),
        format: formatSchema,
      },
    },
    async ({ customerId, experimentId, pValueThreshold, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!ID.test(experimentId)) return fail(`experimentId deve ser numérico, recebido "${experimentId}".`);
      const threshold = pValueThreshold ?? 0.05;
      if (!(threshold > 0 && threshold < 1)) return fail(`pValueThreshold deve ficar entre 0 e 1 (recebido ${pValueThreshold}).`);

      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT experiment.experiment_id, experiment.name, experiment.type, experiment.status,
                experiment.start_date, experiment.end_date,
                ${EXPERIMENT_METRICS.flatMap((def) => def.select).join(", ")}
         FROM experiment
         WHERE experiment.experiment_id = ${experimentId}`);
      let experiment = rows[0]?.experiment ? obj(rows[0].experiment) : undefined;
      if (!experiment) {
        experiment = await readExperiment(client, customerId, experimentId);
        if (!experiment) return fail(`Experimento ${experimentId} não encontrado na conta ${cleanCid(customerId)}.`);
      }
      const metrics = obj(rows[0]?.metrics);
      const results = EXPERIMENT_METRICS.map((def) => evaluateMetric(def, metrics, threshold));
      const significant = results.filter((result) => str(result.verdict).endsWith("SIGNIFICATIVO") || str(result.verdict).endsWith("SIGNIFICATIVA"));
      const summary = significant.length === 0
        ? results.every((result) => result.verdict === "SEM_DADOS")
          ? "Ainda sem métricas de comparação (o experimento pode não ter começado ou não ter volume)."
          : "Nenhuma diferença significativa ainda — deixe rodar mais (ou o efeito é pequeno demais para o volume)."
        : significant.map((result) => `${result.label}: ${result.reading}`).join("\n");
      const notes: string[] = [];
      if (experiment.type === "PMAX_REPLACEMENT_SHOPPING") notes.push("PMAX_REPLACEMENT_SHOPPING: o Google recomenda descartar os 7 primeiros dias (aprendizado da PMax).");
      if (NO_GRADUATE_TYPES.has(str(experiment.type))) notes.push("Experimento dentro da campanha: dá para encerrar ou promover, não graduar.");
      if (NO_PROMOTE_TYPES.has(str(experiment.type))) notes.push("Este tipo não pode ser promovido: encerre ou gradue.");
      const tableRows = results.map((result) => {
        const interval = Array.isArray(result.confidence_interval) ? (result.confidence_interval as number[]) : [];
        return {
          metric: result.label, treatment: result.treatment, control: result.control, lift: result.lift ?? null,
          ci_low: interval[0] ?? null, ci_high: interval[1] ?? null, p_value: result.p_value ?? null, verdict: result.verdict,
        };
      });
      return {
        content: [text(render(format, tableRows as Row[], () =>
          `Experimento ${experimentId} — "${experiment?.name}" (${experiment?.type}, ${experiment?.status}), p ≤ ${threshold}.\n${summary}\n\n` +
          formatJson({
            experiment: {
              experiment_id: experimentId, name: experiment?.name, type: experiment?.type, status: experiment?.status,
              start_date: experiment?.startDate ?? null, end_date: experiment?.endDate ?? null,
            },
            p_value_threshold: threshold,
            metrics: results,
            notes,
          })))],
      };
    }
  );

  /** Lê o experimento e devolve erro pronto quando não existe. */
  async function loadExperiment(client: GoogleAdsClient, customerId: string, experimentId: string) {
    const experiment = await readExperiment(client, customerId, experimentId);
    if (!experiment) return { error: fail(`Experimento ${experimentId} não encontrado na conta ${cleanCid(customerId)}. Nada foi alterado.`) };
    const arms = await readArms(client, customerId, [str(experiment.resourceName)]);
    return { experiment, arms };
  }

  ctx.mcp.registerTool(
    "schedule_experiment",
    {
      description: [
        "Agenda um experimento em SETUP (experiments:scheduleExperiment). WRITE OPERATION — assíncrono.",
        "",
        "Transforma a campanha de tratamento em rascunho numa campanha real, que começa a veicular na startDate",
        "(ou já). Antes, altere o rascunho (update_experiment_campaign) — o Google exige pelo menos uma mudança.",
        "Acompanhe com list_experiments (status INITIATED → ENABLED; erros em async_errors).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().describe("ID do experimento."),
      },
    },
    async ({ customerId, experimentId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!ID.test(experimentId)) return fail(`experimentId deve ser numérico, recebido "${experimentId}". Nada foi alterado.`);
      const client = ctx.getClient();
      const loaded = await loadExperiment(client, customerId, experimentId);
      if (loaded.error) return loaded.error;
      const { experiment, arms } = loaded;
      const line = `Experimento ${experimentId} ("${experiment.name}", ${experiment.type})`;
      if (experiment.status === "INITIATED" || experiment.status === "ENABLED") {
        return { content: [text(`${line}: já está agendado (${experiment.status}). Nenhuma escrita foi enviada.`)] };
      }
      if (experiment.status !== "SETUP") return fail(`${line} está em ${experiment.status}; só dá para agendar experimento em SETUP. Nada foi alterado.`);
      const treatments = arms.filter((arm) => !arm.control);
      if ((SYSTEM_MANAGED_TYPES as readonly string[]).includes(str(experiment.type)) &&
          treatments.some((arm) => arm.in_design_campaign_ids.length === 0 && arm.campaign_ids.length === 0)) {
        return fail(`${line}: o braço de tratamento não tem campanha em rascunho (IN_DESIGN_CAMPAIGNS_NOT_SET). Nada foi alterado.`);
      }
      let operation: Row;
      try {
        operation = await validatableAction<Row>(client, customerId, `experiments/${experimentId}:scheduleExperiment`, {});
      } catch (err) {
        return fail(`${line}: a API recusou o agendamento.\nErro: ${explainError((err as Error).message)}`);
      }
      if (client.isDryRun) return { content: [text(`${line}: ${dryRunLine}`)] };
      return {
        content: [text(
          `${line}: agendamento iniciado (assíncrono). O Google cria a campanha de tratamento a partir do rascunho; ` +
          `acompanhe com list_experiments (status e async_errors).\n\n${formatJson({ operation: str(operation.name) || operation, start_date: experiment.startDate ?? "assim que possível" })}`
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "end_experiment",
    {
      description: [
        "Encerra um experimento agora (experiments:endExperiment), sem aplicar as mudanças. WRITE OPERATION.",
        "O tratamento para de veicular (não é removido); no ADOPT_* o recurso testado é desligado. Pede confirm: true.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().describe("ID do experimento."),
        confirm: z.boolean().optional().describe("true para encerrar."),
      },
    },
    async ({ customerId, experimentId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!ID.test(experimentId)) return fail(`experimentId deve ser numérico, recebido "${experimentId}". Nada foi alterado.`);
      const client = ctx.getClient();
      const loaded = await loadExperiment(client, customerId, experimentId);
      if (loaded.error) return loaded.error;
      const { experiment } = loaded;
      const line = `Experimento ${experimentId} ("${experiment.name}", ${experiment.type})`;
      if (["HALTED", "PROMOTED", "GRADUATED", "REMOVED"].includes(str(experiment.status))) {
        return { content: [text(`${line}: já está encerrado (${experiment.status}). Nenhuma escrita foi enviada.`)] };
      }
      if (experiment.status === "SETUP") return fail(`${line} ainda está em SETUP (não começou); não há o que encerrar. Nada foi alterado.`);
      if (confirm !== true) return fail(`${line} (${experiment.status}) vai ser encerrado agora, sem aplicar as mudanças. Nada foi alterado — repita com confirm: true.`);
      try {
        await validatableAction(client, customerId, `experiments/${experimentId}:endExperiment`, {});
      } catch (err) {
        return fail(`${line}: a API recusou o encerramento.\nErro: ${explainError((err as Error).message)}`);
      }
      return { content: [text(`${line}: ${client.isDryRun ? dryRunLine : "encerrado. O tratamento parou de veicular; a campanha original segue como estava."}`)] };
    }
  );

  ctx.mcp.registerTool(
    "promote_experiment",
    {
      description: [
        "Promove o experimento (experiments:promoteExperiment): copia as mudanças do tratamento para a campanha",
        "original e para o tratamento. WRITE OPERATION — assíncrono e permanente. Pede confirm: true.",
        "Não existe para PMAX_REPLACEMENT_SHOPPING, COMPARE_CAMPAIGNS e OPTIMIZE_ASSETS (use graduate/end).",
        "Confira antes com get_experiment_results; acompanhe com list_experiments (promote_status, async_errors).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().describe("ID do experimento."),
        confirm: z.boolean().optional().describe("true para promover."),
      },
    },
    async ({ customerId, experimentId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!ID.test(experimentId)) return fail(`experimentId deve ser numérico, recebido "${experimentId}". Nada foi alterado.`);
      const client = ctx.getClient();
      const loaded = await loadExperiment(client, customerId, experimentId);
      if (loaded.error) return loaded.error;
      const { experiment } = loaded;
      const line = `Experimento ${experimentId} ("${experiment.name}", ${experiment.type})`;
      if (NO_PROMOTE_TYPES.has(str(experiment.type))) return fail(`${line}: este tipo não pode ser promovido — use graduate_experiment ou end_experiment. Nada foi alterado.`);
      if (experiment.status === "PROMOTED" || experiment.promoteStatus === "IN_PROGRESS" || experiment.promoteStatus === "COMPLETED") {
        return { content: [text(`${line}: promoção já feita ou em andamento (${experiment.status}, promote_status ${experiment.promoteStatus}). Nenhuma escrita foi enviada.`)] };
      }
      if (experiment.status !== "ENABLED") return fail(`${line} está em ${experiment.status}; só dá para promover experimento rodando (ENABLED). Nada foi alterado.`);
      if (confirm !== true) return fail(`${line}: as mudanças do tratamento vão ser aplicadas na campanha original (permanente). Nada foi alterado — repita com confirm: true.`);
      let operation: Row;
      try {
        operation = await validatableAction<Row>(client, customerId, `experiments/${experimentId}:promoteExperiment`, {});
      } catch (err) {
        return fail(`${line}: a API recusou a promoção.\nErro: ${explainError((err as Error).message)}`);
      }
      if (client.isDryRun) return { content: [text(`${line}: ${dryRunLine}`)] };
      return { content: [text(`${line}: promoção iniciada (assíncrona). Acompanhe com list_experiments (promote_status e async_errors).\n\n${formatJson({ operation: str(operation.name) || operation })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "graduate_experiment",
    {
      description: [
        "Gradua o experimento (experiments:graduateExperiment): a campanha de tratamento vira campanha",
        "independente, com orçamento próprio. WRITE OPERATION. Pede confirm: true.",
        "O que acontece com as outras campanhas depende do tipo:",
        "- SEARCH/DISPLAY/HOTEL_CUSTOM e PMAX_REPLACEMENT_SHOPPING: a campanha original (controle) não muda;",
        "- COMPARE_CAMPAIGNS: o Google PAUSA as campanhas de todos os outros braços, INCLUSIVE a do controle —",
        "  a prévia (sem confirm) lista quais serão pausadas;",
        "- OPTIMIZE_ASSETS: a campanha base é pausada e o tratamento vira campanha nova.",
        "",
        "Orçamento: campaignBudgetId (existente, de preferência não compartilhado) ou dailyBudgetMicros (cria um",
        "orçamento novo e depois gradua — em validateOnly/dry-run só vale com campaignBudgetId, porque o ID do",
        "orçamento novo só existe depois de gravar). experimentCampaignId: qual campanha graduar, quando há mais",
        "de uma. Não existe para ADOPT_AI_MAX/ADOPT_BROAD_MATCH_KEYWORDS (dentro da campanha).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        experimentId: z.string().describe("ID do experimento."),
        experimentCampaignId: z.string().optional().describe("Campanha do braço de tratamento a graduar."),
        campaignBudgetId: z.string().optional().describe("Orçamento existente para a campanha graduada."),
        dailyBudgetMicros: z.number().optional().describe("Ou: valor diário de um orçamento novo, em micros (50000000 = R$ 50)."),
        budgetName: z.string().optional().describe("Nome do orçamento novo."),
        confirm: z.boolean().optional().describe("true para graduar."),
      },
    },
    async ({ customerId, experimentId, experimentCampaignId, campaignBudgetId, dailyBudgetMicros, budgetName, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const problems: string[] = [];
      if (!ID.test(experimentId)) problems.push(`experimentId deve ser numérico (recebido "${experimentId}")`);
      if (experimentCampaignId !== undefined && !ID.test(experimentCampaignId)) problems.push(`experimentCampaignId deve ser numérico (recebido "${experimentCampaignId}")`);
      if (campaignBudgetId !== undefined && !ID.test(campaignBudgetId)) problems.push(`campaignBudgetId deve ser numérico (recebido "${campaignBudgetId}")`);
      if ((campaignBudgetId === undefined) === (dailyBudgetMicros === undefined)) problems.push("informe campaignBudgetId OU dailyBudgetMicros");
      if (dailyBudgetMicros !== undefined && !isPositiveMicros(dailyBudgetMicros)) problems.push(`dailyBudgetMicros deve ser inteiro positivo em micros (recebido ${dailyBudgetMicros})`);
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const dryRun = client.isDryRun;
      if (dryRun && dailyBudgetMicros !== undefined) {
        return fail("validateOnly/dry-run não valida a graduação com orçamento novo: o ID do orçamento só existe depois de gravar. Use campaignBudgetId para validar. Nada foi enviado.");
      }
      const loaded = await loadExperiment(client, customerId, experimentId);
      if (loaded.error) return loaded.error;
      const { experiment, arms } = loaded;
      const line = `Experimento ${experimentId} ("${experiment.name}", ${experiment.type})`;
      if (NO_GRADUATE_TYPES.has(str(experiment.type))) return fail(`${line}: experimento dentro da campanha não pode ser graduado — use promote_experiment ou end_experiment. Nada foi alterado.`);
      if (experiment.status === "GRADUATED") return { content: [text(`${line}: já foi graduado. Nenhuma escrita foi enviada.`)] };
      if (!["ENABLED", "HALTED"].includes(str(experiment.status))) return fail(`${line} está em ${experiment.status}; só dá para graduar experimento que já rodou (ENABLED ou HALTED). Nada foi alterado.`);
      const candidates = [...new Set(arms.filter((arm) => !arm.control).flatMap((arm) => arm.campaign_ids))];
      let target = experimentCampaignId;
      if (target && !candidates.includes(target)) return fail(`${line}: a campanha ${target} não está num braço de tratamento. Candidatas: ${candidates.join(", ") || "nenhuma"}. Nada foi alterado.`);
      if (!target) {
        if (candidates.length !== 1) return fail(`${line}: ${candidates.length === 0 ? "nenhuma campanha de tratamento encontrada" : `há ${candidates.length} campanhas de tratamento (${candidates.join(", ")}) — informe experimentCampaignId`}. Nada foi alterado.`);
        target = candidates[0];
      }
      const warnings: string[] = [];
      if (experiment.type === "OPTIMIZE_ASSETS") {
        warnings.push("OPTIMIZE_ASSETS: o braço de tratamento aponta para a mesma campanha PMax do controle; o guia diz que a campanha base é pausada e o tratamento vira campanha nova. Confira o resultado em list_experiments.");
      }
      // Campaign mix (guia "Graduate or end"): graduar um braço PAUSA as campanhas dos outros braços,
      // inclusive o controle. Quem confirma precisa ver exatamente o que vai parar de veicular.
      let campaignsToPause: Row[] = [];
      if (experiment.type === "COMPARE_CAMPAIGNS") {
        const graduatedArm = arms.find((arm) => !arm.control && arm.campaign_ids.includes(target as string));
        const otherArms = arms.filter((arm) => arm !== graduatedArm);
        const pauseIds = [...new Set(otherArms.flatMap((arm) => arm.campaign_ids))].filter((id) => id !== target);
        const names = await readCampaignNames(client, customerId, pauseIds);
        campaignsToPause = describeCampaigns(pauseIds, names).map((campaign) => {
          const arm = otherArms.find((entry) => entry.campaign_ids.includes(str(campaign.id)));
          return { ...campaign, arm: arm?.name ?? null, control: Boolean(arm?.control) };
        });
        if (campaignsToPause.length > 0) {
          const list = campaignsToPause.map((campaign) =>
            `${campaign.id}${campaign.name ? ` ("${campaign.name}")` : ""}${campaign.control ? " [CONTROLE]" : ""}`).join(", ");
          warnings.push(
            `COMPARE_CAMPAIGNS: ao graduar, o Google PAUSA as campanhas dos outros braços, inclusive a do controle — ` +
            `${campaignsToPause.length} campanha(s) vão parar de veicular: ${list}. Só a campanha ${target} segue veiculando, agora independente. ` +
            `Para voltar a veicular alguma delas, reative manualmente depois.`
          );
        }
      }
      let budgetResource: string | undefined;
      if (campaignBudgetId) {
        const budgets = await client.searchStream(customerId,
          `SELECT campaign_budget.id, campaign_budget.name, campaign_budget.status, campaign_budget.amount_micros,
                  campaign_budget.explicitly_shared, campaign_budget.reference_count
           FROM campaign_budget WHERE campaign_budget.id = ${campaignBudgetId}`);
        const budget = budgets[0]?.campaignBudget ? obj(budgets[0].campaignBudget) : undefined;
        if (!budget) return fail(`Orçamento ${campaignBudgetId} não encontrado na conta ${cid}. Nada foi alterado.`);
        if (budget.status === "REMOVED") return fail(`Orçamento ${campaignBudgetId} está removido. Nada foi alterado.`);
        if (budget.explicitlyShared === true || num(budget.referenceCount) > 0) {
          warnings.push(`O orçamento ${campaignBudgetId} ("${budget.name}") já é usado por ${num(budget.referenceCount)} campanha(s)${budget.explicitlyShared ? " e é compartilhado" : ""}: a campanha graduada vai dividir esse valor.`);
        }
        budgetResource = `customers/${cid}/campaignBudgets/${campaignBudgetId}`;
      }
      const pauseLine = campaignsToPause.length > 0
        ? ` ATENÇÃO: ${campaignsToPause.length} campanha(s) dos outros braços, inclusive o controle, vão ser PAUSADAS pelo Google (${campaignsToPause.map((campaign) => campaign.id).join(", ")}).`
        : "";
      if (confirm !== true) {
        return fail(
          `${line}: a campanha ${target} vai virar campanha independente com o orçamento ${campaignBudgetId ?? `novo de R$ ${microsToMoney(dailyBudgetMicros).toFixed(2)}/dia`}.${pauseLine} ` +
          `Nada foi alterado — repita com confirm: true.\n\n${formatJson({ campaigns_to_pause: campaignsToPause, warnings })}`
        );
      }
      let createdBudget: string | undefined;
      if (!budgetResource) {
        try {
          const response = await client.mutate(customerId, "campaignBudgets", [{
            create: {
              name: budgetName?.trim() || `Graduação ${experiment.name} ${localIsoDate(new Date())}`,
              amountMicros: String(dailyBudgetMicros),
              deliveryMethod: "STANDARD",
              explicitlyShared: false,
            },
          }]);
          createdBudget = str(obj(rowsOf(response.results)[0]).resourceName);
        } catch (err) {
          return fail(`${line}: a API recusou o orçamento novo; nada foi graduado.\nErro: ${explainError((err as Error).message)}`);
        }
        if (!createdBudget) return fail(`${line}: a API não devolveu o orçamento criado; nada foi graduado. Confira os orçamentos antes de repetir.`);
        budgetResource = createdBudget;
      }
      try {
        await validatableAction(client, customerId, `experiments/${experimentId}:graduateExperiment`, {
          campaignBudgetMappings: [{ experimentCampaign: `customers/${cid}/campaigns/${target}`, campaignBudget: budgetResource }],
        });
      } catch (err) {
        return fail(
          `${line}: a API recusou a graduação.\nErro: ${explainError((err as Error).message)}` +
          (createdBudget ? `\nO orçamento novo FOI criado (${createdBudget}) e ficou sem campanha — reutilize com campaignBudgetId ou remova.` : "")
        );
      }
      return {
        content: [text(
          `${line}: ${dryRun
            ? `${dryRunLine}${campaignsToPause.length > 0 ? ` Se gravar, ${campaignsToPause.length} campanha(s) dos outros braços, inclusive o controle, serão pausadas.` : ""}`
            : `campanha ${target} graduada — agora é independente.${campaignsToPause.length > 0 ? ` Com a graduação, o Google pausa ${campaignsToPause.length} campanha(s) dos outros braços, inclusive o controle (${campaignsToPause.map((campaign) => campaign.id).join(", ")}) — confira em list_experiments.` : ""}`}\n\n` +
          formatJson({
            experiment_campaign: target, campaign_budget: budgetResource, created_budget: createdBudget ?? null,
            ...(experiment.type === "COMPARE_CAMPAIGNS" ? { [dryRun ? "campaigns_to_pause" : "paused_campaigns"]: campaignsToPause } : {}),
            warnings,
          })
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "update_experiment_campaign",
    {
      description: [
        "Altera uma campanha em RASCUNHO — o tratamento de um experimento (in_design_campaigns) ou o de um",
        "rascunho (create_campaign_draft). WRITE OPERATION.",
        "",
        "As tools comuns não enxergam rascunhos (o GAQL só os devolve com include_drafts=true); esta enxerga.",
        "Informe campaignId (ID do rascunho) ou experimentId (usa o rascunho do braço de tratamento).",
        "Ajustes: name; biddingStrategy MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE / TARGET_SPEND;",
        "targetCpaMicros (MAXIMIZE_CONVERSIONS/TARGET_CPA), targetRoas (MAXIMIZE_CONVERSION_VALUE/TARGET_ROAS),",
        "cpcBidCeilingMicros (TARGET_SPEND). Rastreamento: set_tracking com level campaign.",
        "Só mexe em campanha DRAFT — para campanha real use update_campaign.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("ID da campanha em rascunho."),
        experimentId: z.string().optional().describe("Ou: experimento cujo rascunho de tratamento será alterado."),
        name: z.string().optional().describe("Novo nome."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_SPEND"]).optional().describe("Nova estratégia de lance."),
        targetCpaMicros: z.number().optional().describe("CPA alvo em micros."),
        targetRoas: z.number().optional().describe("ROAS alvo em decimal (5.0 = 500%)."),
        cpcBidCeilingMicros: z.number().optional().describe("Teto de CPC em micros (TARGET_SPEND)."),
      },
    },
    async ({ customerId, campaignId, experimentId, name, biddingStrategy, targetCpaMicros, targetRoas, cpcBidCeilingMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const problems: string[] = [];
      if ((campaignId === undefined) === (experimentId === undefined)) problems.push("informe campaignId OU experimentId");
      if (campaignId !== undefined && !ID.test(campaignId)) problems.push(`campaignId deve ser numérico (recebido "${campaignId}")`);
      if (experimentId !== undefined && !ID.test(experimentId)) problems.push(`experimentId deve ser numérico (recebido "${experimentId}")`);
      for (const [label, value] of [["targetCpaMicros", targetCpaMicros], ["cpcBidCeilingMicros", cpcBidCeilingMicros]] as const) {
        if (value !== undefined && !isPositiveMicros(value)) problems.push(`${label} deve ser inteiro positivo em micros (recebido ${value})`);
      }
      if (targetRoas !== undefined && !(targetRoas > 0)) problems.push(`targetRoas deve ser maior que zero (recebido ${targetRoas})`);
      if (name !== undefined && !name.trim()) problems.push("name vazio");
      if ([name, biddingStrategy, targetCpaMicros, targetRoas, cpcBidCeilingMicros].every((value) => value === undefined)) problems.push("informe ao menos um ajuste");
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      let target = campaignId;
      if (experimentId) {
        const loaded = await loadExperiment(client, customerId, experimentId);
        if (loaded.error) return loaded.error;
        const drafts = [...new Set(loaded.arms.filter((arm) => !arm.control).flatMap((arm) => arm.in_design_campaign_ids))];
        if (drafts.length !== 1) {
          return fail(`Experimento ${experimentId}: ${drafts.length === 0 ? "sem campanha em rascunho (já agendado, ou tipo sem rascunho)" : `${drafts.length} rascunhos (${drafts.join(", ")}) — informe campaignId`}. Nada foi alterado.`);
        }
        target = drafts[0];
      }
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.experiment_type, campaign.base_campaign,
                campaign.bidding_strategy_type, campaign.bidding_strategy,
                campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
                campaign.target_spend.cpc_bid_ceiling_micros, campaign.target_cpa.target_cpa_micros,
                campaign.target_roas.target_roas
         FROM campaign WHERE campaign.id = ${target}
         PARAMETERS include_drafts=true`);
      const campaign = rows[0]?.campaign ? obj(rows[0].campaign) : undefined;
      if (!campaign) return fail(`Campanha ${target} não encontrada na conta ${cid}. Nada foi alterado.`);
      if (campaign.experimentType !== "DRAFT") {
        return fail(`Campanha ${target} ("${campaign.name}") é ${campaign.experimentType || "BASE"}, não rascunho — para campanha real use update_campaign. Nada foi alterado.`);
      }
      const current = str(campaign.biddingStrategyType);
      const portfolio = str(campaign.biddingStrategy) !== "";
      const strategyAfter = biddingStrategy ?? current;
      const switching = biddingStrategy !== undefined && (biddingStrategy !== current || portfolio);
      const update: Row = { resourceName: `customers/${cid}/campaigns/${target}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      if (name !== undefined && name.trim() !== campaign.name) {
        update.name = name.trim();
        mask.push("name");
        changes.push({ setting: "name", before: campaign.name, after: name.trim() });
      }
      const params: Array<{ key: string; value: unknown; json: unknown; field: string; strategies: string[] }> = [];
      if (targetCpaMicros !== undefined) params.push({ key: "targetCpaMicros", value: targetCpaMicros, json: String(targetCpaMicros), field: "target_cpa_micros", strategies: ["MAXIMIZE_CONVERSIONS", "TARGET_CPA"] });
      if (targetRoas !== undefined) params.push({ key: "targetRoas", value: targetRoas, json: targetRoas, field: "target_roas", strategies: ["MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS"] });
      if (cpcBidCeilingMicros !== undefined) params.push({ key: "cpcBidCeilingMicros", value: cpcBidCeilingMicros, json: String(cpcBidCeilingMicros), field: "cpc_bid_ceiling_micros", strategies: ["TARGET_SPEND"] });
      const misplaced = params.filter((param) => !param.strategies.includes(strategyAfter));
      if (misplaced.length > 0) {
        return fail(`${misplaced.map((param) => param.key).join(", ")} não vale(m) para ${strategyAfter || "a estratégia atual"} (válidos: ${misplaced.map((param) => `${param.key} → ${param.strategies.join("/")}`).join("; ")}). Nada foi alterado.`);
      }
      if (portfolio && !switching && params.length > 0) {
        return fail(`A campanha usa estratégia de portfólio (${campaign.biddingStrategy}); para mudar o alvo aqui, troque para uma estratégia padrão com biddingStrategy. Nada foi alterado.`);
      }
      const spec = BIDDING_FIELDS[strategyAfter];
      if (params.length > 0 || switching) {
        if (!spec) return fail(`Estratégia ${strategyAfter} não é ajustável por esta tool. Nada foi alterado.`);
        const strategyBody: Row = {};
        const currentStrategy = obj(campaign[spec.json]);
        for (const param of params) {
          const jsonKey = param.key === "targetCpaMicros" ? "targetCpaMicros" : param.key === "targetRoas" ? "targetRoas" : "cpcBidCeilingMicros";
          if (!switching && str(currentStrategy[jsonKey]) === str(param.value)) continue;
          strategyBody[jsonKey] = param.json;
          mask.push(`${spec.path}.${param.field}`);
          changes.push({ setting: param.key, before: currentStrategy[jsonKey] ?? null, after: param.value });
        }
        if (switching && Object.keys(strategyBody).length === 0) {
          if (!spec.emptySwitch) return fail(`Para trocar para ${strategyAfter}, informe o alvo. Nada foi alterado.`);
          mask.push(spec.emptySwitch);
        }
        if (switching) changes.push({ setting: "biddingStrategy", before: portfolio ? `portfólio ${campaign.biddingStrategy}` : current, after: strategyAfter });
        if (Object.keys(strategyBody).length > 0 || switching) update[spec.json] = strategyBody;
      }
      const line = `Rascunho ${target} ("${campaign.name}")`;
      if (mask.length === 0) return { content: [text(`${line}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`)] };
      try {
        await client.mutate(customerId, "campaigns", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`${line}: a API recusou a alteração.\nErro: ${explainError((err as Error).message)}\n\n${formatJson({ attempted: changes, update_mask: mask })}`);
      }
      return {
        content: [text(
          `${line}: ${client.isDryRun ? dryRunLine : `${changes.length} ajuste(s) aplicado(s) no rascunho (a campanha original não muda).`}\n\n` +
          formatJson({ changes, update_mask: mask }) +
          (client.isDryRun ? "" : `\n\nPróximo passo: ${experimentId ? `schedule_experiment (experimentId ${experimentId})` : "schedule_experiment ou promote_campaign_draft"}.`)
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "create_campaign_draft",
    {
      description: [
        "Cria um rascunho de campanha (CampaignDraftService) para preparar mudanças sem afetar a campanha real.",
        "WRITE OPERATION. Devolve o ID da campanha em rascunho: altere-a com update_experiment_campaign ou",
        "set_tracking e aplique na original com promote_campaign_draft. O rascunho não veicula.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        baseCampaignId: z.string().describe("Campanha original."),
        name: z.string().describe("Nome do rascunho (único por campanha)."),
      },
    },
    async ({ customerId, baseCampaignId, name }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(baseCampaignId)) return fail(`baseCampaignId deve ser numérico, recebido "${baseCampaignId}". Nada foi criado.`);
      const cleanName = name.trim();
      if (!cleanName || /[\n\r\0]/.test(cleanName)) return fail("name não pode ser vazio nem ter quebra de linha. Nada foi criado.");
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.experiment_type FROM campaign WHERE campaign.id = ${baseCampaignId}`);
      const campaign = rows[0]?.campaign ? obj(rows[0].campaign) : undefined;
      if (!campaign) return fail(`Campanha ${baseCampaignId} não encontrada na conta ${cid}. Nada foi criado.`);
      if (campaign.status === "REMOVED") return fail(`Campanha ${baseCampaignId} está removida. Nada foi criado.`);
      if (campaign.experimentType && campaign.experimentType !== "BASE") return fail(`Campanha ${baseCampaignId} é ${campaign.experimentType}; rascunho só de campanha original (BASE). Nada foi criado.`);
      const baseResource = `customers/${cid}/campaigns/${baseCampaignId}`;
      const drafts = await client.searchStream(customerId,
        `SELECT campaign_draft.resource_name, campaign_draft.draft_id, campaign_draft.name, campaign_draft.status
         FROM campaign_draft WHERE campaign_draft.base_campaign = '${baseResource}'`);
      const same = drafts.find((row) => str(obj(row.campaignDraft).name) === cleanName && obj(row.campaignDraft).status !== "REMOVED");
      if (same) return fail(`Já existe o rascunho "${cleanName}" (ID ${obj(same.campaignDraft).draftId}) nesta campanha. Nada foi criado.`);
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignDrafts", [{ create: { baseCampaign: baseResource, name: cleanName } }]);
      } catch (err) {
        return fail(`A API recusou o rascunho.\nErro: ${explainError((err as Error).message)}`);
      }
      if (client.isDryRun) return { content: [text(`Rascunho "${cleanName}" da campanha ${baseCampaignId}: ${dryRunLine}`)] };
      const draftResource = str(obj(rowsOf(response.results)[0]).resourceName);
      if (!draftResource) return fail(`A API não confirmou o rascunho — confira com list_campaign_drafts antes de repetir.\n\n${formatJson(response)}`);
      const created = await client.searchStream(customerId,
        `SELECT campaign_draft.draft_id, campaign_draft.draft_campaign, campaign_draft.status
         FROM campaign_draft WHERE campaign_draft.resource_name = '${gaqlLiteral(draftResource)}'`);
      const draft = obj(created[0]?.campaignDraft);
      const draftCampaignId = lastId(draft.draftCampaign);
      return {
        content: [text(
          `Rascunho criado: "${cleanName}" da campanha ${baseCampaignId} ("${campaign.name}").\n` +
          `Campanha em rascunho: ${draftCampaignId || "(ver list_campaign_drafts)"} — altere com update_experiment_campaign (campaignId ${draftCampaignId || "?"}) e aplique com promote_campaign_draft.\n\n` +
          formatJson({ draft: draftResource, draft_id: str(draft.draftId) || lastId(draftResource).split("~")[1], draft_campaign_id: draftCampaignId || null, status: draft.status ?? "PROPOSED" })
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "list_campaign_drafts",
    {
      description: [
        "Lista rascunhos de campanha (status PROPOSED, PROMOTING, PROMOTED, PROMOTE_FAILED, REMOVED) com a",
        "campanha original e a campanha em rascunho. READ OPERATION. Rascunhos com PROMOTE_FAILED trazem os",
        "erros assíncronos da promoção (campaignDrafts:listAsyncErrors).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        baseCampaignId: z.string().optional().describe("Filtra por campanha original."),
        includeRemoved: z.boolean().optional().describe("Inclui removidos. Padrão false."),
        format: formatSchema,
      },
    },
    async ({ customerId, baseCampaignId, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (baseCampaignId !== undefined && !ID.test(baseCampaignId)) return fail(`baseCampaignId deve ser numérico, recebido "${baseCampaignId}".`);
      const filters: string[] = [];
      if (!includeRemoved) filters.push("campaign_draft.status != 'REMOVED'");
      if (baseCampaignId) filters.push(`campaign_draft.base_campaign = 'customers/${cid}/campaigns/${baseCampaignId}'`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign_draft.resource_name, campaign_draft.draft_id, campaign_draft.name, campaign_draft.status,
                campaign_draft.base_campaign, campaign_draft.draft_campaign, campaign_draft.has_experiment_running,
                campaign_draft.long_running_operation
         FROM campaign_draft${filters.length ? ` WHERE ${filters.join(" AND ")}` : ""}`);
      const drafts = rows.map((row) => obj(row.campaignDraft));
      const names = await readCampaignNames(client, customerId, drafts.flatMap((draft) => [lastId(draft.baseCampaign), lastId(draft.draftCampaign)]));
      const views: Row[] = [];
      for (const draft of drafts) {
        const baseId = lastId(draft.baseCampaign);
        const view: Row = {
          draft_id: str(draft.draftId),
          name: str(draft.name),
          status: str(draft.status),
          base_campaign_id: baseId,
          base_campaign_name: str(names.get(baseId)?.name),
          draft_campaign_id: lastId(draft.draftCampaign),
          has_experiment_running: Boolean(draft.hasExperimentRunning),
          long_running_operation: str(draft.longRunningOperation) || null,
        };
        if (draft.status === "PROMOTE_FAILED") {
          try {
            const response = await client.customerGet<Row>(customerId, `campaignDrafts/${baseId}~${str(draft.draftId)}:listAsyncErrors`, { pageSize: "1000" });
            view.async_errors = rowsOf(response.errors).map((error) => ({ code: error.code, message: error.message }));
          } catch (err) {
            view.async_errors = { unavailable: (err as Error).message };
          }
        }
        views.push(view);
      }
      return { content: [text(render(format, views, () => `${views.length} rascunho(s).\n\n${formatJson(views)}`))] };
    }
  );

  ctx.mcp.registerTool(
    "promote_campaign_draft",
    {
      description: [
        "Aplica um rascunho na campanha original (campaignDrafts:promote). WRITE OPERATION — assíncrono e",
        "permanente. Pede confirm: true. Acompanhe com list_campaign_drafts (PROMOTING → PROMOTED; se falhar,",
        "PROMOTE_FAILED traz os erros — a promoção pode ter sido parcial e não pode ser repetida).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        baseCampaignId: z.string().describe("Campanha original."),
        draftId: z.string().describe("ID do rascunho (list_campaign_drafts)."),
        confirm: z.boolean().optional().describe("true para aplicar."),
      },
    },
    async ({ customerId, baseCampaignId, draftId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(baseCampaignId) || !ID.test(draftId)) return fail("baseCampaignId e draftId devem ser numéricos. Nada foi alterado.");
      const client = ctx.getClient();
      const resource = `customers/${cid}/campaignDrafts/${baseCampaignId}~${draftId}`;
      const rows = await client.searchStream(customerId,
        `SELECT campaign_draft.resource_name, campaign_draft.name, campaign_draft.status, campaign_draft.draft_campaign,
                campaign_draft.has_experiment_running
         FROM campaign_draft WHERE campaign_draft.resource_name = '${resource}'`);
      const draft = rows[0]?.campaignDraft ? obj(rows[0].campaignDraft) : undefined;
      if (!draft) return fail(`Rascunho ${draftId} da campanha ${baseCampaignId} não encontrado. Nada foi alterado.`);
      const line = `Rascunho ${draftId} ("${draft.name}") da campanha ${baseCampaignId}`;
      if (draft.status === "PROMOTING" || draft.status === "PROMOTED") return { content: [text(`${line}: já ${draft.status === "PROMOTED" ? "aplicado" : "em aplicação"} (${draft.status}). Nenhuma escrita foi enviada.`)] };
      if (draft.status !== "PROPOSED") return fail(`${line} está em ${draft.status}; só rascunho PROPOSED pode ser aplicado. Nada foi alterado.`);
      if (confirm !== true) return fail(`${line}: as mudanças do rascunho vão ser aplicadas na campanha original (permanente). Nada foi alterado — repita com confirm: true.`);
      let operation: Row;
      try {
        operation = await validatableAction<Row>(client, customerId, `campaignDrafts/${baseCampaignId}~${draftId}:promote`, {});
      } catch (err) {
        return fail(`${line}: a API recusou a aplicação.\nErro: ${explainError((err as Error).message)}`);
      }
      if (client.isDryRun) return { content: [text(`${line}: ${dryRunLine}`)] };
      return { content: [text(`${line}: aplicação iniciada (assíncrona). Acompanhe com list_campaign_drafts.\n\n${formatJson({ operation: str(operation.name) || operation })}`)] };
    }
  );

  // ══ RASTREAMENTO DE URL (item 77) ══════════════════════════════════

  ctx.mcp.registerTool(
    "get_tracking_settings",
    {
      description: [
        "Rastreamento de URL em todos os níveis: modelo de acompanhamento (tracking template), sufixo de URL",
        "final e parâmetros personalizados ({_chave}). READ OPERATION.",
        "",
        "Prioridade do Google (mais específico vence): palavra-chave > anúncio > grupo > campanha > conta.",
        "Devolve o valor explícito de cada nível, o efetivo por grupo de anúncios (grupo > campanha > conta),",
        "os anúncios/palavras-chave que sobrepõem o grupo e os problemas: sobreposição conflitante, {_chave} usado",
        "sem parâmetro definido, modelo sem {lpurl}, sufixo começando com ?/&.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Restringe a uma campanha (recomendado em contas grandes)."),
        levels: flexArray(z.enum(TRACKING_LEVELS)).optional().describe("Níveis a ler. Padrão: todos."),
        format: formatSchema.describe("json (padrão, completo) | table/csv (efetivo por grupo)."),
      },
    },
    async ({ customerId, campaignId, levels, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      const wanted = new Set<string>(cleanList(levels).length ? cleanList(levels) : TRACKING_LEVELS);
      const bad = [...wanted].filter((level) => !(TRACKING_LEVELS as readonly string[]).includes(level));
      if (bad.length > 0) return fail(`levels inválidos: ${bad.join(", ")}. Válidos: ${TRACKING_LEVELS.join(", ")}.`);
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const client = ctx.getClient();

      const customerRows = await client.searchStream(customerId,
        "SELECT customer.id, customer.descriptive_name, customer.tracking_url_template, customer.final_url_suffix FROM customer");
      const customer = obj(customerRows[0]?.customer);
      const account = { tracking_url_template: str(customer.trackingUrlTemplate), final_url_suffix: str(customer.finalUrlSuffix) };

      const campaigns = new Map<string, Row>();
      if (wanted.has("campaign") || wanted.has("adGroup") || wanted.has("ad") || wanted.has("keyword")) {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.tracking_url_template, campaign.final_url_suffix,
                  campaign.url_custom_parameters
           FROM campaign WHERE campaign.status != 'REMOVED'${campaignFilter}`);
        for (const row of rows) {
          const campaign = obj(row.campaign);
          campaigns.set(str(campaign.id), {
            campaign_id: str(campaign.id), name: str(campaign.name), status: str(campaign.status),
            tracking_url_template: str(campaign.trackingUrlTemplate), final_url_suffix: str(campaign.finalUrlSuffix),
            custom_parameters: paramsOf(campaign.urlCustomParameters),
          });
        }
      }
      const adGroups = new Map<string, Row>();
      if (wanted.has("adGroup") || wanted.has("ad") || wanted.has("keyword")) {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, ad_group.tracking_url_template,
                  ad_group.final_url_suffix, ad_group.url_custom_parameters
           FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'${campaignFilter}`);
        for (const row of rows) {
          const group = obj(row.adGroup);
          adGroups.set(str(group.id), {
            ad_group_id: str(group.id), name: str(group.name), status: str(group.status), campaign_id: str(obj(row.campaign).id),
            tracking_url_template: str(group.trackingUrlTemplate), final_url_suffix: str(group.finalUrlSuffix),
            custom_parameters: paramsOf(group.urlCustomParameters),
          });
        }
      }

      const issues: Row[] = [];
      const effectiveFor = (groupId: string) => {
        const group = adGroups.get(groupId) ?? {};
        const campaign = campaigns.get(str(group.campaign_id)) ?? {};
        const pick = (field: string) =>
          str(group[field]) ? { value: str(group[field]), source: "adGroup" }
            : str(campaign[field]) ? { value: str(campaign[field]), source: "campaign" }
              : (account as Row)[field] ? { value: str((account as Row)[field]), source: "account" } : { value: "", source: "none" };
        const params = new Map<string, { key: string; value: string; source: string }>();
        for (const param of rowsOf(campaign.custom_parameters)) params.set(str(param.key).toLowerCase(), { key: str(param.key), value: str(param.value), source: "campaign" });
        for (const param of rowsOf(group.custom_parameters)) params.set(str(param.key).toLowerCase(), { key: str(param.key), value: str(param.value), source: "adGroup" });
        return { template: pick("tracking_url_template"), suffix: pick("final_url_suffix"), params };
      };
      const checkTags = (where: Row, template: string, suffix: string, params: Set<string>) => {
        for (const tag of new Set([...customTagsIn(template), ...customTagsIn(suffix)])) {
          if (!params.has(tag)) issues.push({ ...where, issue: "PARAMETRO_NAO_DEFINIDO", detail: `{_${tag}} é usado mas não há parâmetro personalizado "${tag}" definido neste nível nem acima.` });
        }
        if (template && !LPURL_TAG.test(template)) issues.push({ ...where, issue: "MODELO_SEM_LPURL", detail: `O modelo "${template}" não tem {lpurl}: em anúncios de site a API exige uma tag de URL (MISSING_TRACKING_URL_TEMPLATE_TAG).` });
        if (/^[?&]/.test(suffix)) issues.push({ ...where, issue: "SUFIXO_INVALIDO", detail: `O sufixo "${suffix}" começa com ? ou &.` });
      };

      const effective: Row[] = [];
      for (const [groupId, group] of adGroups) {
        const eff = effectiveFor(groupId);
        const where = { level: "adGroup", campaign_id: group.campaign_id, ad_group_id: groupId };
        checkTags(where, eff.template.value, eff.suffix.value, new Set(eff.params.keys()));
        effective.push({
          campaign_id: group.campaign_id,
          campaign_name: str(campaigns.get(str(group.campaign_id))?.name),
          ad_group_id: groupId,
          ad_group_name: group.name,
          tracking_url_template: eff.template.value, template_source: eff.template.source,
          final_url_suffix: eff.suffix.value, suffix_source: eff.suffix.source,
          custom_parameters: [...eff.params.values()].map((param) => `${param.key}=${param.value} (${param.source})`).join("; "),
        });
      }
      if (!wanted.has("adGroup")) effective.length = 0;
      if (wanted.has("campaign")) {
        for (const campaign of campaigns.values()) {
          const template = str(campaign.tracking_url_template) || account.tracking_url_template;
          const suffix = str(campaign.final_url_suffix) || account.final_url_suffix;
          checkTags({ level: "campaign", campaign_id: campaign.campaign_id }, template, suffix,
            new Set(rowsOf(campaign.custom_parameters).map((param) => str(param.key).toLowerCase())));
        }
      }

      // Sobreposições em anúncio e palavra-chave (só os que definem algo)
      const overrides: Row = {};
      const lowerOverride = (kind: string, groupId: string, id: string, label: string, entity: Row) => {
        const template = str(entity.trackingUrlTemplate);
        const suffix = str(entity.finalUrlSuffix);
        const params = paramsOf(entity.urlCustomParameters);
        if (!template && !suffix && params.length === 0) return undefined;
        const eff = effectiveFor(groupId);
        const merged = new Set([...eff.params.keys(), ...params.map((param) => param.key.toLowerCase())]);
        const where = { level: kind, ad_group_id: groupId, id };
        if (template && eff.template.value && template !== eff.template.value) {
          issues.push({ ...where, issue: "SOBREPOSICAO", detail: `${label} usa modelo próprio, diferente do efetivo do grupo (${eff.template.source}).` });
        }
        if (suffix && eff.suffix.value && suffix !== eff.suffix.value) {
          issues.push({ ...where, issue: "SOBREPOSICAO", detail: `${label} usa sufixo próprio, diferente do efetivo do grupo (${eff.suffix.source}).` });
        }
        checkTags(where, template || eff.template.value, suffix || eff.suffix.value, merged);
        return {
          id, ad_group_id: groupId, label, tracking_url_template: template || null, final_url_suffix: suffix || null,
          custom_parameters: params, final_urls: entity.finalUrls ?? [],
        };
      };
      if (wanted.has("ad")) {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, ad_group.id, campaign.id,
                  ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.url_custom_parameters,
                  ad_group_ad.ad.final_urls
           FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'${campaignFilter}`);
        overrides.ads = rows
          .map((row) => {
            const ad = obj(obj(row.adGroupAd).ad);
            return lowerOverride("ad", str(obj(row.adGroup).id), `${str(obj(row.adGroup).id)}~${str(ad.id)}`, `Anúncio ${str(ad.id)} (${str(ad.type)})`, ad);
          })
          .filter(Boolean);
      }
      if (wanted.has("keyword")) {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                  ad_group_criterion.status, ad_group.id, campaign.id, ad_group_criterion.tracking_url_template,
                  ad_group_criterion.final_url_suffix, ad_group_criterion.url_custom_parameters, ad_group_criterion.final_urls
           FROM ad_group_criterion
           WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = false
             AND ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED'${campaignFilter}`);
        overrides.keywords = rows
          .map((row) => {
            const criterion = obj(row.adGroupCriterion);
            const keyword = obj(criterion.keyword);
            return lowerOverride("keyword", str(obj(row.adGroup).id), `${str(obj(row.adGroup).id)}~${str(criterion.criterionId)}`,
              `Palavra-chave "${str(keyword.text)}" [${str(keyword.matchType)}]`, criterion);
          })
          .filter(Boolean);
      }

      const body = {
        precedence: "palavra-chave > anúncio > grupo de anúncios > campanha > conta",
        account: wanted.has("account") ? account : undefined,
        campaigns: wanted.has("campaign") ? [...campaigns.values()] : undefined,
        effective_by_ad_group: wanted.has("adGroup") ? effective : undefined,
        overrides,
        issues,
      };
      return {
        content: [text(render(format, effective, () =>
          `Rastreamento — ${campaigns.size} campanha(s), ${adGroups.size} grupo(s), ${issues.length} problema(s).\n\n${formatJson(body)}`))],
      };
    }
  );

  ctx.mcp.registerTool(
    "set_tracking",
    {
      description: [
        "Define modelo de acompanhamento, sufixo de URL final e parâmetros personalizados em conta, campanhas,",
        "grupos, anúncios ou palavras-chave. WRITE OPERATION — várias entidades por chamada (partial failure).",
        "",
        "- trackingUrlTemplate: começa com http(s):// ou {lpurl}; ex.: {lpurl}?utm_source=google&kw={keyword}",
        "- finalUrlSuffix: sem ? ou & no começo; ex.: utm_source=google&utm_medium=cpc&utm_campaign={_campanha}",
        "- customParameters [{key, value}]: cria/atualiza só as chaves informadas (as outras ficam). Chave",
        "  alfanumérica até 16 caracteres, valor até 200 bytes, máx. 8 por entidade. Não existe na conta.",
        "- removeCustomParameterKeys: tira chaves; clear: [trackingUrlTemplate|finalUrlSuffix|customParameters].",
        "ids: campaign/adGroup = ID; ad = adGroupId~adId (ou adId); keyword = adGroupId~criterionId.",
        "IMPACTO: em campanha e grupo o anúncio continua veiculando. Em ANÚNCIO e PALAVRA-CHAVE a mudança manda o",
        "item para revisão e ele para de veicular até ser aprovado — por isso ad/keyword pedem confirm: true.",
        "Conta (level account) também pede confirm: vale para todas as campanhas sem modelo próprio.",
        "Valores iguais aos atuais não são reenviados. Rascunhos (experimentos) também podem ser alterados.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(TRACKING_LEVELS).describe("Nível."),
        ids: flexArray(z.string()).optional().describe("IDs das entidades (não usar com account)."),
        trackingUrlTemplate: z.string().optional().describe("Novo modelo de acompanhamento."),
        finalUrlSuffix: z.string().optional().describe("Novo sufixo de URL final."),
        customParameters: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe("Parâmetros a criar/atualizar."),
        removeCustomParameterKeys: flexArray(z.string()).optional().describe("Chaves a remover."),
        clear: flexArray(z.enum(TRACKING_FIELDS)).optional().describe("Campos a limpar."),
        confirm: z.boolean().optional().describe("true para account, ad e keyword."),
      },
    },
    async ({ customerId, level, ids, trackingUrlTemplate, finalUrlSuffix, customParameters, removeCustomParameterKeys, clear, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const problems: string[] = [];
      const clears = new Set(cleanList(clear));
      for (const field of clears) if (!(TRACKING_FIELDS as readonly string[]).includes(field)) problems.push(`clear: campo inválido "${field}"`);
      const template = trackingUrlTemplate?.trim();
      const suffix = finalUrlSuffix?.trim();
      if (template !== undefined) {
        if (!template) problems.push("trackingUrlTemplate vazio — para limpar use clear: [\"trackingUrlTemplate\"]");
        else { const error = validateTrackingTemplate(template); if (error) problems.push(error); }
        if (clears.has("trackingUrlTemplate")) problems.push("trackingUrlTemplate informado e em clear ao mesmo tempo");
      }
      if (suffix !== undefined) {
        if (!suffix) problems.push("finalUrlSuffix vazio — para limpar use clear: [\"finalUrlSuffix\"]");
        else { const error = validateSuffix(suffix); if (error) problems.push(error); }
        if (clears.has("finalUrlSuffix")) problems.push("finalUrlSuffix informado e em clear ao mesmo tempo");
      }
      const setParams = (customParameters ?? []).map((param) => ({ key: param.key.trim(), value: param.value }));
      const removeKeys = cleanList(removeCustomParameterKeys).map((key) => key.replace(/^_/, "").toLowerCase());
      const seenKeys = new Set<string>();
      for (const param of setParams) {
        if (!/^[A-Za-z0-9]{1,16}$/.test(param.key)) problems.push(`parâmetro "${param.key}": chave deve ser alfanumérica, 1 a 16 caracteres (sem _ — no modelo ela vira {_${param.key.replace(/^_/, "")}})`);
        if (!param.value) problems.push(`parâmetro "${param.key}": valor vazio (para tirar a chave use removeCustomParameterKeys)`);
        else if (Buffer.byteLength(param.value, "utf8") > 200) problems.push(`parâmetro "${param.key}": valor passa de 200 bytes`);
        if (/\s/.test(param.value)) problems.push(`parâmetro "${param.key}": valor não pode ter espaços`);
        if (seenKeys.has(param.key.toLowerCase())) problems.push(`parâmetro "${param.key}" repetido (chaves não diferenciam maiúsculas)`);
        seenKeys.add(param.key.toLowerCase());
        if (removeKeys.includes(param.key.toLowerCase())) problems.push(`parâmetro "${param.key}" em customParameters e em removeCustomParameterKeys`);
      }
      const touchesParams = setParams.length > 0 || removeKeys.length > 0 || clears.has("customParameters");
      if (clears.has("customParameters") && (setParams.length > 0 || removeKeys.length > 0)) problems.push("clear customParameters não combina com customParameters/removeCustomParameterKeys");
      if (template === undefined && suffix === undefined && !touchesParams && clears.size === 0) problems.push("informe ao menos um ajuste (trackingUrlTemplate, finalUrlSuffix, customParameters, removeCustomParameterKeys ou clear)");
      if (level === "account" && touchesParams) problems.push("a conta não tem parâmetros personalizados — use campanha ou grupo");
      const idList = cleanList(ids);
      if (level === "account" && idList.length > 0) problems.push("level account não usa ids (é a própria conta)");
      if (level !== "account" && idList.length === 0) problems.push(`informe ids para level ${level}`);
      if (idList.length > MAX_ITEMS) problems.push(`máximo de ${MAX_ITEMS} ids por chamada (recebido ${idList.length})`);
      const parsed = idList.map((raw) => {
        if (level === "campaign" || level === "adGroup") return ID.test(raw) ? { raw, id: raw } : { raw, error: true };
        if (level === "ad") {
          const match = /^(?:(\d+)~)?(\d+)$/.exec(raw);
          return match ? { raw, groupId: match[1], id: match[2] } : { raw, error: true };
        }
        const match = /^(\d+)~(\d+)$/.exec(raw);
        return match ? { raw, groupId: match[1], id: match[2] } : { raw, error: true };
      });
      const badIds = parsed.filter((entry) => entry.error).map((entry) => entry.raw);
      if (badIds.length > 0) problems.push(`ids inválidos para ${level}: ${badIds.join(", ")} (${level === "keyword" ? "use adGroupId~criterionId" : level === "ad" ? "use adGroupId~adId ou adId" : "use o ID numérico"})`);
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const dryRun = client.isDryRun;
      const reviewWarning = level === "ad" || level === "keyword"
        ? "Mudança em anúncio/palavra-chave manda o item para revisão: ele para de veicular até ser aprovado."
        : undefined;

      /** Calcula a mudança de uma entidade a partir do estado atual. */
      const plan = (current: { template: string; suffix: string; params: Array<{ key: string; value: string }> }) => {
        const change: Row = {};
        const mask: string[] = [];
        const before: Row = {};
        const after: Row = {};
        if (clears.has("trackingUrlTemplate") && current.template) { mask.push("tracking_url_template"); before.tracking_url_template = current.template; after.tracking_url_template = null; }
        if (template !== undefined && template !== current.template) {
          change.trackingUrlTemplate = template; mask.push("tracking_url_template");
          before.tracking_url_template = current.template || null; after.tracking_url_template = template;
        }
        if (clears.has("finalUrlSuffix") && current.suffix) { mask.push("final_url_suffix"); before.final_url_suffix = current.suffix; after.final_url_suffix = null; }
        if (suffix !== undefined && suffix !== current.suffix) {
          change.finalUrlSuffix = suffix; mask.push("final_url_suffix");
          before.final_url_suffix = current.suffix || null; after.final_url_suffix = suffix;
        }
        if (touchesParams) {
          let next = clears.has("customParameters") ? [] : current.params.filter((param) => !removeKeys.includes(param.key.toLowerCase()));
          for (const param of setParams) {
            next = next.filter((existing) => existing.key.toLowerCase() !== param.key.toLowerCase()).concat([param]);
          }
          if (paramsKey(next) !== paramsKey(current.params)) {
            if (next.length > MAX_CUSTOM_PARAMETERS) return { error: `ficaria com ${next.length} parâmetros personalizados (máx. ${MAX_CUSTOM_PARAMETERS})` };
            change.urlCustomParameters = next;
            mask.push("url_custom_parameters");
            before.custom_parameters = current.params; after.custom_parameters = next;
          }
        }
        return { change, mask, before, after };
      };

      // ── Conta ──
      if (level === "account") {
        const rows = await client.searchStream(customerId,
          "SELECT customer.id, customer.descriptive_name, customer.manager, customer.tracking_url_template, customer.final_url_suffix FROM customer");
        const customer = obj(rows[0]?.customer);
        if (!customer.id) return fail(`Conta ${cid} não encontrada. Nada foi alterado.`);
        const planned = plan({ template: str(customer.trackingUrlTemplate), suffix: str(customer.finalUrlSuffix), params: [] });
        if ("error" in planned) return fail(`Nada foi alterado: ${planned.error}.`);
        if (planned.mask.length === 0) return { content: [text(`Conta ${cid}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`)] };
        if (confirm !== true) {
          return fail(`Conta ${cid} ("${customer.descriptiveName}"): a mudança vale para todas as campanhas sem modelo/sufixo próprio. Nada foi alterado — repita com confirm: true.\n\n${formatJson({ before: planned.before, after: planned.after })}`);
        }
        try {
          await validatableAction(client, customerId, ":mutate", {
            operation: { update: { resourceName: `customers/${cid}`, ...planned.change }, updateMask: [...new Set(planned.mask)].join(",") },
          });
        } catch (err) {
          return fail(`Conta ${cid}: a API recusou a alteração.\nErro: ${explainError((err as Error).message)}`);
        }
        return { content: [text(`Conta ${cid}: ${dryRun ? dryRunLine : "rastreamento atualizado (anúncios seguem veiculando)."}\n\n${formatJson({ before: planned.before, after: planned.after, update_mask: [...new Set(planned.mask)] })}`)] };
      }

      // ── Entidades ──
      type Current = { key: string; label: string; resourceName: string; status: string; template: string; suffix: string; params: Array<{ key: string; value: string }>; finalUrls: string[] };
      const found = new Map<string, Current>();
      const entries = parsed as Array<{ raw: string; id: string; groupId?: string }>;
      if (level === "campaign") {
        const rows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.tracking_url_template, campaign.final_url_suffix,
                  campaign.url_custom_parameters
           FROM campaign WHERE campaign.id IN (${entries.map((entry) => entry.id).join(", ")})
           PARAMETERS include_drafts=true`);
        for (const row of rows) {
          const campaign = obj(row.campaign);
          found.set(str(campaign.id), {
            key: str(campaign.id), label: `Campanha ${campaign.id} ("${campaign.name}")`, resourceName: `customers/${cid}/campaigns/${campaign.id}`,
            status: str(campaign.status), template: str(campaign.trackingUrlTemplate), suffix: str(campaign.finalUrlSuffix),
            params: paramsOf(campaign.urlCustomParameters), finalUrls: [],
          });
        }
      } else if (level === "adGroup") {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.tracking_url_template, ad_group.final_url_suffix,
                  ad_group.url_custom_parameters
           FROM ad_group WHERE ad_group.id IN (${entries.map((entry) => entry.id).join(", ")})
           PARAMETERS include_drafts=true`);
        for (const row of rows) {
          const group = obj(row.adGroup);
          found.set(str(group.id), {
            key: str(group.id), label: `Grupo ${group.id} ("${group.name}")`, resourceName: `customers/${cid}/adGroups/${group.id}`,
            status: str(group.status), template: str(group.trackingUrlTemplate), suffix: str(group.finalUrlSuffix),
            params: paramsOf(group.urlCustomParameters), finalUrls: [],
          });
        }
      } else if (level === "ad") {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                  ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.url_custom_parameters,
                  ad_group_ad.ad.final_urls
           FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${[...new Set(entries.map((entry) => entry.id))].join(", ")})`);
        for (const row of rows) {
          const ad = obj(obj(row.adGroupAd).ad);
          const groupId = str(obj(row.adGroup).id);
          const current: Current = {
            key: `${groupId}~${ad.id}`, label: `Anúncio ${ad.id} (${ad.type}) do grupo ${groupId}`, resourceName: `customers/${cid}/ads/${ad.id}`,
            status: str(obj(row.adGroupAd).status), template: str(ad.trackingUrlTemplate), suffix: str(ad.finalUrlSuffix),
            params: paramsOf(ad.urlCustomParameters), finalUrls: (Array.isArray(ad.finalUrls) ? ad.finalUrls : []).map(String),
          };
          found.set(`${groupId}~${ad.id}`, current);
          if (!found.has(str(ad.id))) found.set(str(ad.id), current);
        }
      } else {
        const rows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
                  ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.tracking_url_template,
                  ad_group_criterion.final_url_suffix, ad_group_criterion.url_custom_parameters, ad_group_criterion.final_urls
           FROM ad_group_criterion
           WHERE ad_group_criterion.criterion_id IN (${[...new Set(entries.map((entry) => entry.id))].join(", ")})
             AND ad_group.id IN (${[...new Set(entries.map((entry) => entry.groupId as string))].join(", ")})
             AND ad_group_criterion.type = 'KEYWORD'`);
        for (const row of rows) {
          const criterion = obj(row.adGroupCriterion);
          const keyword = obj(criterion.keyword);
          const groupId = str(obj(row.adGroup).id);
          found.set(`${groupId}~${criterion.criterionId}`, {
            key: `${groupId}~${criterion.criterionId}`, label: `Palavra-chave "${keyword.text}" [${keyword.matchType}]${criterion.negative ? " (negativa)" : ""}`,
            resourceName: `customers/${cid}/adGroupCriteria/${groupId}~${criterion.criterionId}`,
            status: criterion.negative ? "NEGATIVE" : str(criterion.status), template: str(criterion.trackingUrlTemplate), suffix: str(criterion.finalUrlSuffix),
            params: paramsOf(criterion.urlCustomParameters), finalUrls: (Array.isArray(criterion.finalUrls) ? criterion.finalUrls : []).map(String),
          });
        }
      }

      const notFound: string[] = [];
      const unchanged: string[] = [];
      const skipped: Row[] = [];
      const warnings: string[] = reviewWarning ? [reviewWarning] : [];
      const operations: MutateOperation[] = [];
      const describe: Row[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const key = level === "ad" ? (entry.groupId ? `${entry.groupId}~${entry.id}` : entry.id) : level === "keyword" ? `${entry.groupId}~${entry.id}` : entry.id;
        const current = found.get(key);
        if (!current) { notFound.push(entry.raw); continue; }
        if (seen.has(current.resourceName)) continue;
        seen.add(current.resourceName);
        if (current.status === "REMOVED") { skipped.push({ id: entry.raw, label: current.label, reason: "removido" }); continue; }
        if (current.status === "NEGATIVE") { skipped.push({ id: entry.raw, label: current.label, reason: "palavra-chave negativa não tem URL" }); continue; }
        const planned = plan(current);
        if ("error" in planned) { skipped.push({ id: entry.raw, label: current.label, reason: planned.error }); continue; }
        if (planned.mask.length === 0) { unchanged.push(current.label); continue; }
        if ((level === "ad" || level === "keyword") && planned.change.trackingUrlTemplate && current.finalUrls.length === 0) {
          warnings.push(`${current.label}: sem URL final própria — a API pode exigir URL final junto com o modelo nesse nível.`);
        }
        operations.push({ update: { resourceName: current.resourceName, ...planned.change }, updateMask: [...new Set(planned.mask)].join(",") });
        describe.push({ id: entry.raw, label: current.label, before: planned.before, after: planned.after });
      }
      if (operations.length === 0) {
        return {
          content: [text(`Nada a alterar em ${level}: ${unchanged.length} já com os valores pedidos, ${notFound.length} não encontrado(s), ${skipped.length} ignorado(s). Nenhuma escrita foi enviada.\n\n` +
            formatJson({ unchanged, not_found: notFound, skipped }))],
          isError: notFound.length > 0 || skipped.length > 0,
        };
      }
      if ((level === "ad" || level === "keyword") && confirm !== true) {
        return fail(`${operations.length} ${level === "ad" ? "anúncio(s)" : "palavra(s)-chave"} vão para revisão e param de veicular até a aprovação. Nada foi alterado — repita com confirm: true.\n\n${formatJson({ planned: describe, not_found: notFound, skipped })}`);
      }
      const resource = ({ campaign: "campaigns", adGroup: "adGroups", ad: "ads", keyword: "adGroupCriteria" } as Record<string, string>)[level];
      const { applied, errors } = await mutateEach(client, customerId, resource, operations, describe);
      return {
        content: [text(
          `${level}: ${dryRun ? `${dryRunLine} Validados: ${applied.length}` : `${applied.length} atualizado(s)`} | sem mudança: ${unchanged.length} | ` +
          `não encontrados: ${notFound.length} | ignorados: ${skipped.length} | com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "updated"]: applied, unchanged, not_found: notFound, skipped, errors, warnings })
        )],
        isError: errors.length > 0 || notFound.length > 0,
      };
    }
  );

  // ══ RÓTULOS (item 81) ══════════════════════════════════════════════

  ctx.mcp.registerTool(
    "update_label",
    {
      description: [
        "Altera nome, cor ou descrição de um rótulo. WRITE OPERATION — só o que muda é enviado.",
        "backgroundColor em hex (#RRGGBB ou #RGB; \"\" limpa). description até 200 caracteres (\"\" limpa).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        labelId: z.string().describe("ID do rótulo (list_labels)."),
        name: z.string().optional().describe("Novo nome (1 a 80 caracteres, único na conta)."),
        backgroundColor: z.string().optional().describe("Cor de fundo em hex, ex.: #FF9900."),
        description: z.string().optional().describe("Descrição (até 200 caracteres)."),
      },
    },
    async ({ customerId, labelId, name, backgroundColor, description }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const problems: string[] = [];
      if (!ID.test(labelId)) problems.push(`labelId deve ser numérico (recebido "${labelId}")`);
      const newName = name?.trim();
      if (newName !== undefined && (newName.length < 1 || newName.length > 80)) problems.push("name precisa ter de 1 a 80 caracteres");
      const color = backgroundColor?.trim();
      if (color && !/^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(color)) problems.push(`backgroundColor inválida: "${backgroundColor}" (use #RRGGBB ou #RGB)`);
      if (description !== undefined && description.length > 200) problems.push("description passa de 200 caracteres");
      if (name === undefined && backgroundColor === undefined && description === undefined) problems.push("informe name, backgroundColor ou description");
      if (problems.length > 0) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT label.id, label.name, label.status, label.text_label.background_color, label.text_label.description
         FROM label WHERE label.id = ${labelId}`);
      const label = rows[0]?.label ? obj(rows[0].label) : undefined;
      if (!label) return fail(`Rótulo ${labelId} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (label.status === "REMOVED") return fail(`Rótulo ${labelId} ("${label.name}") está removido. Nada foi alterado.`);
      const textLabel = obj(label.textLabel);
      const update: Row = { resourceName: `customers/${cid}/labels/${labelId}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      if (newName !== undefined && newName !== label.name) {
        const clash = await client.searchStream(customerId,
          `SELECT label.id, label.name, label.status FROM label WHERE label.name = '${gaqlLiteral(newName)}'`);
        const other = clash.find((row) => str(obj(row.label).id) !== labelId && obj(row.label).status !== "REMOVED");
        if (other) return fail(`Já existe o rótulo "${newName}" (ID ${obj(other.label).id}). Nada foi alterado.`);
        update.name = newName; mask.push("name");
        changes.push({ setting: "name", before: label.name, after: newName });
      }
      const textUpdate: Row = {};
      if (color !== undefined && color.toUpperCase() !== str(textLabel.backgroundColor).toUpperCase()) {
        if (color) textUpdate.backgroundColor = color;
        mask.push("text_label.background_color");
        changes.push({ setting: "backgroundColor", before: textLabel.backgroundColor ?? null, after: color || null });
      }
      if (description !== undefined && description !== str(textLabel.description)) {
        if (description) textUpdate.description = description;
        mask.push("text_label.description");
        changes.push({ setting: "description", before: textLabel.description ?? null, after: description || null });
      }
      if (Object.keys(textUpdate).length > 0) update.textLabel = textUpdate;
      if (mask.length === 0) return { content: [text(`Rótulo ${labelId} ("${label.name}"): nada a mudar. Nenhuma escrita foi enviada.`)] };
      try {
        await client.mutate(customerId, "labels", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`Rótulo ${labelId}: a API recusou a alteração.\nErro: ${explainError((err as Error).message)}`);
      }
      return { content: [text(`Rótulo ${labelId}: ${client.isDryRun ? dryRunLine : "atualizado."}\n\n${formatJson({ changes, update_mask: mask })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "remove_label",
    {
      description: [
        "Remove um rótulo da conta (e, com ele, os vínculos com campanhas, grupos, anúncios, palavras-chave e",
        "contas). WRITE OPERATION — irreversível: rótulo removido não volta (crie outro). Pede confirm: true;",
        "sem confirm devolve quantos itens usam o rótulo.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        labelId: z.string().describe("ID do rótulo."),
        confirm: z.boolean().optional().describe("true para remover."),
      },
    },
    async ({ customerId, labelId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      if (!ID.test(labelId)) return fail(`labelId deve ser numérico, recebido "${labelId}". Nada foi alterado.`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.id = ${labelId}`);
      const label = rows[0]?.label ? obj(rows[0].label) : undefined;
      if (!label) return fail(`Rótulo ${labelId} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (label.status === "REMOVED") return { content: [text(`Rótulo ${labelId} ("${label.name}") já está removido. Nenhuma escrita foi enviada.`)] };
      const resource = `customers/${cid}/labels/${labelId}`;
      const usage: Row = {};
      for (const [key, from] of [["campaigns", "campaign_label"], ["ad_groups", "ad_group_label"], ["ads", "ad_group_ad_label"], ["keywords", "ad_group_criterion_label"]] as const) {
        usage[key] = (await client.searchStream(customerId, `SELECT ${from}.resource_name FROM ${from} WHERE label.id = ${labelId}`)).length;
      }
      // O vínculo CustomerLabel fica na conta rotulada, não no MCC dono do rótulo; do MCC, as contas com o
      // rótulo aparecem em customer_client.applied_labels (só rótulos da conta que consulta).
      try {
        const clients = await client.searchStream(customerId,
          `SELECT customer_client.id, customer_client.applied_labels FROM customer_client
           WHERE customer_client.applied_labels CONTAINS ANY ('${resource}')`);
        const labeled = clients.filter((row) => {
          const applied = obj(row.customerClient).appliedLabels;
          return Array.isArray(applied) && applied.map(String).includes(resource);
        });
        usage.accounts = new Set(labeled.map((row) => str(obj(row.customerClient).id))).size;
      } catch (err) {
        usage.accounts = `indisponível: ${(err as Error).message}`;
      }
      if (confirm !== true) {
        return fail(`Rótulo ${labelId} ("${label.name}") vai ser removido (irreversível). Em uso por: ${formatJson(usage)}\nNada foi alterado — repita com confirm: true.`);
      }
      try {
        await client.mutate(customerId, "labels", [{ remove: resource }]);
      } catch (err) {
        return fail(`Rótulo ${labelId}: a API recusou a remoção.\nErro: ${explainError((err as Error).message)}`);
      }
      return { content: [text(`Rótulo ${labelId} ("${label.name}"): ${client.isDryRun ? dryRunLine : "removido."}\n\n${formatJson({ usage_before: usage })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "get_label_performance",
    {
      description: [
        "Desempenho só dos itens com certos rótulos — campanhas, grupos, anúncios ou palavras-chave. READ OPERATION.",
        "O filtro é por ID de rótulo (a API não filtra por nome; ache o ID em list_labels). match ANY (padrão) =",
        "qualquer um dos rótulos; ALL = todos. Traz o total do conjunto e o detalhe por item.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        labelIds: flexArray(z.string()).describe("IDs dos rótulos."),
        level: z.enum(LABEL_LEVELS).optional().describe("campaign (padrão), adGroup, ad ou keyword."),
        match: z.enum(["ANY", "ALL"]).optional().describe("ANY (padrão) ou ALL."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, labelIds, level, match, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const ids = cleanList(labelIds);
      if (ids.length === 0) return fail("Informe labelIds.");
      const bad = ids.filter((id) => !ID.test(id));
      if (bad.length > 0) return fail(`labelIds devem ser numéricos: ${bad.join(", ")}.`);
      const dateClause = buildDateClause(dateRange, days);
      const lvl = level ?? "campaign";
      const client = ctx.getClient();
      const labels = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.id IN (${ids.join(", ")})`);
      const known = new Map(labels.map((row) => [str(obj(row.label).id), str(obj(row.label).name)] as const));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) return fail(`Rótulo(s) não encontrado(s) na conta ${cid}: ${unknown.join(", ")}.`);
      const clause = labelClause(lvl, cid, ids, match ?? "ANY");
      const metrics = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
      const query = {
        campaign: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.labels, ${metrics}
                   FROM campaign WHERE ${clause} AND ${dateClause} AND campaign.status != 'REMOVED'`,
        adGroup: `SELECT campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.labels, ${metrics}
                  FROM ad_group WHERE ${clause} AND ${dateClause} AND ad_group.status != 'REMOVED'`,
        ad: `SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                    ad_group_ad.labels, ${metrics}
             FROM ad_group_ad WHERE ${clause} AND ${dateClause} AND ad_group_ad.status != 'REMOVED'`,
        keyword: `SELECT campaign.name, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                         ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.labels, ${metrics}
                  FROM keyword_view WHERE ${clause} AND ${dateClause} AND ad_group_criterion.status != 'REMOVED'`,
      }[lvl];
      const rows = await client.searchStream(customerId, query);
      const totals = emptyTotals();
      const byItem = new Map<string, { item: Row; totals: ReturnType<typeof emptyTotals> }>();
      for (const row of rows) {
        const campaign = obj(row.campaign);
        const group = obj(row.adGroup);
        const ad = obj(obj(row.adGroupAd).ad);
        const criterion = obj(row.adGroupCriterion);
        const labelsOf = (value: unknown) => (Array.isArray(value) ? value : []).map((resource) => known.get(lastId(resource)) ?? lastId(resource)).join(", ");
        const item: Row = lvl === "campaign"
          ? { id: str(campaign.id), name: str(campaign.name), status: str(campaign.status), channel: str(campaign.advertisingChannelType), labels: labelsOf(campaign.labels) }
          : lvl === "adGroup"
            ? { id: str(group.id), name: str(group.name), campaign: str(campaign.name), status: str(group.status), labels: labelsOf(group.labels) }
            : lvl === "ad"
              ? { id: str(ad.id), name: str(ad.name) || str(ad.type), ad_group: str(group.name), campaign: str(campaign.name), status: str(obj(row.adGroupAd).status), labels: labelsOf(obj(row.adGroupAd).labels) }
              : { id: str(criterion.criterionId), keyword: `${str(obj(criterion.keyword).text)} [${str(obj(criterion.keyword).matchType)}]`, ad_group: str(group.name), campaign: str(campaign.name), status: str(criterion.status), labels: labelsOf(criterion.labels) };
        const key = `${item.id}|${item.ad_group ?? ""}`;
        const entry = byItem.get(key) ?? { item, totals: emptyTotals() };
        addMetrics(entry.totals, obj(row.metrics));
        addMetrics(totals, obj(row.metrics));
        byItem.set(key, entry);
      }
      const items = [...byItem.values()].map((entry) => ({ ...entry.item, ...metricsView(entry.totals) })).sort((a, b) => num(b.spend) - num(a.spend));
      return {
        content: [text(render(format, items as Row[], () =>
          `${items.length} ${lvl} com rótulo ${[...known.values()].join(match === "ALL" ? " E " : " OU ")} (${dateClause}).\n\n` +
          formatJson({ labels: ids.map((id) => ({ id, name: known.get(id) })), match: match ?? "ANY", total: metricsView(totals), items })))],
      };
    }
  );

  ctx.mcp.registerTool(
    "update_status_by_label",
    {
      description: [
        "Pausa ou ativa tudo que tem certos rótulos (campanhas, grupos, anúncios ou palavras-chave). WRITE",
        "OPERATION em escala — pede confirm: true; sem confirm devolve a prévia do que mudaria.",
        "Itens já no status pedido não são reenviados; removidos são ignorados. Ativar uma campanha não ativa",
        "grupos/anúncios pausados dentro dela. match ANY (padrão) = qualquer rótulo; ALL = todos.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        labelIds: flexArray(z.string()).describe("IDs dos rótulos."),
        resourceType: z.enum(LABEL_LEVELS).describe("campaign, adGroup, ad ou keyword."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("Novo status."),
        match: z.enum(["ANY", "ALL"]).optional().describe("ANY (padrão) ou ALL."),
        confirm: z.boolean().optional().describe("true para aplicar."),
      },
    },
    async ({ customerId, labelIds, resourceType, status, match, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cleanCid(customerId);
      const ids = cleanList(labelIds);
      if (ids.length === 0) return fail("Informe labelIds. Nada foi alterado.");
      const bad = ids.filter((id) => !ID.test(id));
      if (bad.length > 0) return fail(`labelIds devem ser numéricos: ${bad.join(", ")}. Nada foi alterado.`);
      const client = ctx.getClient();
      const labels = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.id IN (${ids.join(", ")})`);
      const known = new Map(labels.map((row) => [str(obj(row.label).id), str(obj(row.label).name)] as const));
      const unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) return fail(`Rótulo(s) não encontrado(s) na conta ${cid}: ${unknown.join(", ")}. Nada foi alterado.`);
      const clause = labelClause(resourceType, cid, ids, match ?? "ANY");
      const query = {
        campaign: `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE ${clause} AND campaign.status != 'REMOVED'`,
        adGroup: `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ${clause} AND ad_group.status != 'REMOVED'`,
        ad: `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status
             FROM ad_group_ad WHERE ${clause} AND ad_group_ad.status != 'REMOVED'`,
        keyword: `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.status
                  FROM ad_group_criterion
                  WHERE ${clause} AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.negative = false`,
      }[resourceType];
      const rows = await client.searchStream(customerId, query);
      const items = rows.map((row) => {
        if (resourceType === "campaign") {
          const campaign = obj(row.campaign);
          return { id: str(campaign.id), name: str(campaign.name), status: str(campaign.status), resourceName: `customers/${cid}/campaigns/${campaign.id}` };
        }
        if (resourceType === "adGroup") {
          const group = obj(row.adGroup);
          return { id: str(group.id), name: str(group.name), status: str(group.status), resourceName: `customers/${cid}/adGroups/${group.id}` };
        }
        const groupId = str(obj(row.adGroup).id);
        if (resourceType === "ad") {
          const adGroupAd = obj(row.adGroupAd);
          const ad = obj(adGroupAd.ad);
          return { id: `${groupId}~${ad.id}`, name: str(ad.name) || str(ad.type), status: str(adGroupAd.status), resourceName: `customers/${cid}/adGroupAds/${groupId}~${ad.id}` };
        }
        const criterion = obj(row.adGroupCriterion);
        return { id: `${groupId}~${criterion.criterionId}`, name: str(obj(criterion.keyword).text), status: str(criterion.status), resourceName: `customers/${cid}/adGroupCriteria/${groupId}~${criterion.criterionId}` };
      });
      const toChange = items.filter((item) => item.status !== status);
      const already = items.filter((item) => item.status === status);
      const header = `${resourceType} com rótulo ${[...known.values()].join(match === "ALL" ? " E " : " OU ")}`;
      if (items.length === 0) return { content: [text(`Nenhum ${header}. Nenhuma escrita foi enviada.`)] };
      if (toChange.length === 0) return { content: [text(`${items.length} ${header}: todos já estão ${status}. Nenhuma escrita foi enviada.`)] };
      const preview = toChange.map((item) => ({ id: item.id, name: item.name, before: item.status, after: status }));
      if (confirm !== true) {
        return fail(`${toChange.length} ${header} vão de status para ${status} (${already.length} já estão). Nada foi alterado — repita com confirm: true.\n\n${formatJson({ planned: preview })}`);
      }
      const resource = { campaign: "campaigns", adGroup: "adGroups", ad: "adGroupAds", keyword: "adGroupCriteria" }[resourceType];
      const { applied, errors } = await mutateEach(client, customerId, resource,
        toChange.map((item) => ({ update: { resourceName: item.resourceName, status }, updateMask: "status" })),
        preview);
      const dryRun = client.isDryRun;
      return {
        content: [text(
          `${header}: ${dryRun ? `${dryRunLine} Validados: ${applied.length}` : `${applied.length} → ${status}`} | já estavam: ${already.length} | com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "changed"]: applied, already: already.map((item) => item.id), errors })
        )],
        isError: errors.length > 0,
      };
    }
  );
}
