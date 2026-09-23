/**
 * Lote budgets: orçamentos, ritmo de gasto (pacing) e grupos de campanhas.
 *
 * Tudo aqui foi conferido contra a v25:
 * - resources/campaign_budget.proto: amount_micros (média diária; cobrança mensal limitada a
 *   30,4 × o diário) e total_amount_micros (só em period CUSTOM_PERIOD) são mutuamente
 *   exclusivos; explicitly_shared vai de false → true (no mesmo update, com name), nunca o
 *   contrário; reference_count conta campanhas ENABLED/PAUSED; recommended_budget_* são só leitura.
 * - errors/campaign_error.proto: CANNOT_CHANGE_BUDGET_PERIOD, CANNOT_CHANGE_BUDGET_ON_CAMPAIGN_WITH_TRIALS,
 *   CAMPAIGN_CANNOT_USE_SHARED_BUDGET, CANNOT_USE_SHARED_CAMPAIGN_BUDGET_WHILE_PART_OF_CAMPAIGN_GROUP,
 *   INCOMPATIBLE_BUDGET_TYPE — viram recusas antes de qualquer escrita.
 * - resources/campaign_group.proto + services/campaign_group_service.proto: name e status; REST
 *   customers/{id}/campaignGroups:mutate; campaign.campaign_group liga a campanha ao grupo.
 * - GoogleAdsService.Mutate aceita campaign_budget_operation / campaign_group_operation com
 *   resource name temporário (-1) reusado nas campaign_operation da mesma requisição (atômico).
 *
 * Tools de leitura chamam checkCustomerAccess (o teste de allowlist confere no fonte).
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
  isPositiveMicros,
  localIsoDate,
  metricsView,
  money,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { MetricTotals, ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type TextContent = ReturnType<typeof text>;
export type ToolResult = { content: TextContent[]; isError?: boolean };

// ── Constantes ───────────────────────────────────────────────────────

const NUMERIC_ID = /^\d+$/;
/** Cobrança mensal máxima de um orçamento diário: 30,4 × o valor diário (campaign_budget.proto). */
export const MONTHLY_CAP_FACTOR = 30.4;
/** Menor unidade de qualquer moeda é >= 0,01: valor em micros precisa ser múltiplo de 10000. */
const MIN_UNIT_MICROS = 10_000;
/** Aumento acima disso (mais que dobrar) exige confirm: true — pega erro de digitação em micros. */
const LARGE_INCREASE_FACTOR = 2;
/** Experimentos rodando ou agendados travam troca de orçamento (CANNOT_CHANGE_BUDGET_ON_CAMPAIGN_WITH_TRIALS). */
const BLOCKING_EXPERIMENT_STATUSES = new Set(["ENABLED", "INITIATED"]);
/** Ritmo: abaixo de 90% ou acima de 110% do esperado sai de NO_RITMO. */
const PACE_LOW_PCT = 90;
const PACE_HIGH_PCT = 110;

// ── Helpers pequenos ─────────────────────────────────────────────────

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => String(v)) : []);
const optMicros = (value: unknown): number | null => (value === undefined || value === null || value === "" ? null : num(value));
const units = (micros: number | null | undefined): number | null =>
  micros === null || micros === undefined ? null : round2(micros / 1_000_000);
const pct = (fraction: unknown): number | null =>
  fraction === undefined || fraction === null || fraction === "" ? null : round2(num(fraction) * 100);
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });

function normalizeCid(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "").trim();
  return NUMERIC_ID.test(cid) ? cid : null;
}

/** Aceita o ID numérico ou o resource name completo; resource name de outra conta é recusado. */
export function parseResourceRef(
  kind: "campaignBudgets" | "campaignGroups",
  ref: string,
  cid: string
): { id: string; resourceName: string } | { error: string } {
  const value = String(ref ?? "").trim();
  if (NUMERIC_ID.test(value)) return { id: value, resourceName: `customers/${cid}/${kind}/${value}` };
  const label = kind === "campaignBudgets" ? "orçamento" : "grupo de campanhas";
  const match = new RegExp(`^customers/([\\d-]+)/${kind}/(\\d+)$`).exec(value);
  if (!match) {
    return { error: `"${value}" não é uma referência de ${label} válida (use o ID numérico ou customers/{customerId}/${kind}/{id}).` };
  }
  const owner = match[1].replace(/-/g, "");
  if (owner !== cid) return { error: `${value} pertence à conta ${owner}, não à conta ${cid}.` };
  return { id: match[2], resourceName: `customers/${cid}/${kind}/${match[2]}` };
}

function amountError(label: string, value: unknown): string | null {
  if (!isPositiveMicros(value) || !Number.isSafeInteger(value)) {
    return `${label} deve ser um inteiro positivo em micros (1000000 = R$ 1,00); recebido ${String(value)}.`;
  }
  if ((value as number) % MIN_UNIT_MICROS !== 0) {
    return `${label} precisa ser múltiplo de 10000 micros (R$ 0,01); recebido ${String(value)}.`;
  }
  return null;
}

function nameError(label: string, name: string, maxBytes?: number): string | null {
  const trimmed = name.trim();
  if (!trimmed) return `${label} não pode ser vazio.`;
  if (/[\u0000\n\r]/.test(trimmed)) return `${label} não pode ter quebra de linha nem caractere nulo.`;
  if (maxBytes && Buffer.byteLength(trimmed, "utf8") > maxBytes) return `${label} passa de ${maxBytes} bytes (UTF-8).`;
  return null;
}

function parseIdList(raw: unknown, label: string): { ids: string[] } | { error: string } {
  const ids = [...new Set(ensureArray<unknown>(raw).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return { error: `Informe ao menos um ${label}.` };
  const bad = ids.filter((id) => !NUMERIC_ID.test(id));
  if (bad.length) return { error: `${label} deve ser numérico: ${bad.join(", ")}.` };
  return { ids };
}

// ── Erros da API → explicação em PT-BR ───────────────────────────────

/* A mensagem que o client repassa traz o texto de cada erro da API; os códigos vêm dos
   protos v25 (errors/campaign_budget_error, campaign_error, bidding_error). Casa pelo
   código ou pelo trecho da descrição oficial — o que vier. */
const BUDGET_ERROR_HINTS: Array<[RegExp, string]> = [
  [/BUDGET_BELOW_PER_DAY_MINIMUM|per-day minimum/i, "O valor ficou abaixo do mínimo diário que o Google exige para esta campanha — aumente o valor."],
  [/NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT|multiple of a minimum unit/i, "O valor precisa ser múltiplo da menor unidade da moeda (em BRL, 10000 micros = R$ 0,01)."],
  [/MONEY_AMOUNT_TOO_LARGE|greater than the maximum allowed/i, "Valor acima do máximo aceito pela API — confira se não sobrou zero nos micros."],
  [/MONEY_AMOUNT_LESS_THAN_CURRENCY_MINIMUM_CPC|less than the minimum CPC/i, "Valor abaixo do CPC mínimo da moeda."],
  [/CAMPAIGN_BUDGET_IN_USE|associated with at least one campaign/i, "O orçamento ainda é usado por campanha ativa ou pausada — mova as campanhas com assign_budget antes de remover."],
  [/DUPLICATE_NAME|with this name already exists/i, "Já existe um orçamento com esse nome — escolha outro."],
  [/CANNOT_USE_IMPLICITLY_SHARED_CAMPAIGN_BUDGET_WITH_MULTIPLE_CAMPAIGNS|Only explicitly shared campaign budgets/i, "Orçamento não compartilhado só atende uma campanha. Use create_shared_budget ou update_budget com makeShared."],
  [/CANNOT_MODIFY_FIELD_OF_IMPLICITLY_SHARED_CAMPAIGN_BUDGET|not mutable on implicitly shared/i, "Esse campo não muda em orçamento não compartilhado (o nome acompanha o da campanha)."],
  [/CANNOT_UPDATE_CAMPAIGN_BUDGET_TO_IMPLICITLY_SHARED|back to implicitly shared/i, "Orçamento compartilhado nunca volta a ser individual."],
  [/CANNOT_UPDATE_CAMPAIGN_BUDGET_TO_EXPLICITLY_SHARED_WITHOUT_NAME|explicitly shared campaign budget without a name/i, "Para compartilhar um orçamento é preciso dar um nome a ele na mesma operação."],
  [/CAMPAIGN_BUDGET_REMOVED|no longer exists/i, "O orçamento já foi removido."],
  [/CAMPAIGN_CANNOT_USE_SHARED_BUDGET|Campaigns using experiments cannot use a shared budget/i, "Campanha com experimento não pode usar orçamento compartilhado."],
  [/BUDGET_CANNOT_BE_SHARED|linked to a Campaign that is using experiments/i, "O orçamento é de uma campanha com experimento e não pode ser compartilhado."],
  [/CANNOT_CHANGE_BUDGET_ON_CAMPAIGN_WITH_TRIALS|running or scheduled trials/i, "A campanha tem experimento rodando ou agendado — o orçamento não pode ser trocado agora."],
  [/CANNOT_USE_SHARED_CAMPAIGN_BUDGET_WHILE_PART_OF_CAMPAIGN_GROUP|shared campaign budgets and be part of a campaign group/i, "Campanha em grupo de campanhas não pode usar orçamento compartilhado (e vice-versa)."],
  [/CANNOT_CHANGE_BUDGET_PERIOD|different period cannot be assigned/i, "O período do orçamento (diário × total da campanha) não muda depois de criada a campanha."],
  [/INCOMPATIBLE_BUDGET_TYPE|type of the Budget is not compatible/i, "O tipo do orçamento não é compatível com esta campanha."],
  [/BIDDING_STRATEGY_TYPE_INCOMPATIBLE_WITH_SHARED_BUDGET|incompatible with shared budget/i, "A estratégia de lances da campanha não aceita orçamento compartilhado."],
  [/BIDDING_STRATEGY_AND_BUDGET_MUST_BE_ALIGNED|must be aligned/i, "O orçamento está alinhado a uma estratégia de portfólio: a campanha precisa usar a mesma estratégia."],
  [/BIDDING_STRATEGY_AND_BUDGET_MUST_BE_REMOVED_TOGETHER|removed at the same time/i, "Orçamento alinhado a estratégia de portfólio só sai junto com a estratégia."],
  [/CANNOT_ATTACH_TO_REMOVED_CAMPAIGN_GROUP|deleted campaign group/i, "O grupo de campanhas foi removido."],
  [/TOTAL_BUDGET_AMOUNT_MUST_BE_UNSET_FOR_BUDGET_PERIOD_DAILY|BUDGET_AMOUNT_MUST_BE_UNSET_FOR_CUSTOM_BUDGET_PERIOD/i, "Orçamento diário usa amountMicros; orçamento total da campanha usa totalAmountMicros."],
  [/CAMPAIGN_BUDGET_PERIOD_NOT_AVAILABLE|allow-list for this campaign budget period/i, "A conta não está liberada para esse período de orçamento."],
  [/ACCOUNT_LIMIT|RESOURCE_COUNT_LIMIT|maximum number of/i, "Limite de recursos da conta atingido — remova orçamentos órfãos com remove_budget."],
];

export function explainBudgetError(message: string): string {
  const hints = [...new Set(BUDGET_ERROR_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint))];
  return hints.length ? `${message}\n→ ${hints.join("\n→ ")}` : message;
}

// ── Leitura: orçamentos, campanhas, experimentos ─────────────────────

export interface BudgetInfo {
  resourceName: string;
  id: string;
  name: string;
  status: string;
  period: string;
  amountMicros: number | null;
  totalAmountMicros: number | null;
  explicitlyShared: boolean;
  referenceCount: number;
  deliveryMethod: string;
  type: string;
  hasRecommendedBudget: boolean;
  recommendedAmountMicros: number | null;
  recommendedWeekly: { clicks: number | null; costMicros: number | null; interactions: number | null; views: number | null };
  alignedBiddingStrategyId: string | null;
}

const BUDGET_FIELDS = [
  "campaign_budget.resource_name",
  "campaign_budget.id",
  "campaign_budget.name",
  "campaign_budget.status",
  "campaign_budget.period",
  "campaign_budget.amount_micros",
  "campaign_budget.total_amount_micros",
  "campaign_budget.explicitly_shared",
  "campaign_budget.reference_count",
  "campaign_budget.delivery_method",
  "campaign_budget.type",
  "campaign_budget.has_recommended_budget",
  "campaign_budget.recommended_budget_amount_micros",
  "campaign_budget.recommended_budget_estimated_change_weekly_clicks",
  "campaign_budget.recommended_budget_estimated_change_weekly_cost_micros",
  "campaign_budget.recommended_budget_estimated_change_weekly_interactions",
  "campaign_budget.recommended_budget_estimated_change_weekly_views",
  "campaign_budget.aligned_bidding_strategy_id",
].join(", ");

export function parseBudget(raw: unknown): BudgetInfo {
  const b = obj(raw);
  const aligned = str(b.alignedBiddingStrategyId);
  return {
    resourceName: str(b.resourceName),
    id: str(b.id),
    name: str(b.name),
    status: str(b.status) || "UNSPECIFIED",
    period: str(b.period) || "UNSPECIFIED",
    amountMicros: optMicros(b.amountMicros),
    totalAmountMicros: optMicros(b.totalAmountMicros),
    explicitlyShared: b.explicitlyShared === true,
    referenceCount: num(b.referenceCount),
    deliveryMethod: str(b.deliveryMethod),
    type: str(b.type) || "UNSPECIFIED",
    hasRecommendedBudget: b.hasRecommendedBudget === true,
    recommendedAmountMicros: optMicros(b.recommendedBudgetAmountMicros),
    recommendedWeekly: {
      clicks: optMicros(b.recommendedBudgetEstimatedChangeWeeklyClicks),
      costMicros: optMicros(b.recommendedBudgetEstimatedChangeWeeklyCostMicros),
      interactions: optMicros(b.recommendedBudgetEstimatedChangeWeeklyInteractions),
      views: optMicros(b.recommendedBudgetEstimatedChangeWeeklyViews),
    },
    alignedBiddingStrategyId: aligned && aligned !== "0" ? aligned : null,
  };
}

const isTotalBudget = (budget: Pick<BudgetInfo, "period">) => budget.period === "CUSTOM_PERIOD";

async function fetchBudgets(client: GoogleAdsClient, cid: string, where: string[]): Promise<BudgetInfo[]> {
  const rows = await client.searchStream(cid,
    `SELECT ${BUDGET_FIELDS} FROM campaign_budget${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`);
  return rows.map((row) => parseBudget(row.campaignBudget));
}

export interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  resourceName: string;
  budget: string;
  group: string;
  experimentType: string;
  biddingStrategyType: string;
  biddingStrategy: string;
  channelType: string;
  primaryStatus: string;
  primaryStatusReasons: string[];
  startDate: string | null;
  endDate: string | null;
  /** Só quando a query trouxe os campos de campaign_budget (recurso atribuído de campaign). */
  budgetInfo?: BudgetInfo;
}

const CAMPAIGN_FIELDS = [
  "campaign.id",
  "campaign.name",
  "campaign.status",
  "campaign.resource_name",
  "campaign.campaign_budget",
  "campaign.campaign_group",
  "campaign.experiment_type",
  "campaign.bidding_strategy_type",
  "campaign.bidding_strategy",
  "campaign.advertising_channel_type",
  "campaign.primary_status",
  "campaign.primary_status_reasons",
  "campaign.start_date_time",
  "campaign.end_date_time",
].join(", ");

const isoDay = (value: unknown): string | null => {
  const day = str(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

function parseCampaign(row: Row, withBudget: boolean): CampaignInfo {
  const c = obj(row.campaign);
  return {
    id: str(c.id),
    name: str(c.name),
    status: str(c.status),
    resourceName: str(c.resourceName),
    budget: str(c.campaignBudget),
    group: str(c.campaignGroup),
    experimentType: str(c.experimentType) || "BASE",
    biddingStrategyType: str(c.biddingStrategyType),
    biddingStrategy: str(c.biddingStrategy),
    channelType: str(c.advertisingChannelType),
    primaryStatus: str(c.primaryStatus),
    primaryStatusReasons: list(c.primaryStatusReasons),
    startDate: isoDay(c.startDateTime),
    endDate: isoDay(c.endDateTime),
    ...(withBudget ? { budgetInfo: parseBudget(row.campaignBudget) } : {}),
  };
}

async function fetchCampaigns(client: GoogleAdsClient, cid: string, where: string[], withBudget = false): Promise<CampaignInfo[]> {
  const rows = await client.searchStream(cid,
    `SELECT ${CAMPAIGN_FIELDS}${withBudget ? `, ${BUDGET_FIELDS}` : ""} FROM campaign` +
    `${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`);
  return rows.map((row) => parseCampaign(row, withBudget));
}

/** Campanhas (base e tratamento) de experimentos rodando, agendados ou em montagem. */
async function fetchExperimentCampaigns(client: GoogleAdsClient, cid: string): Promise<Map<string, { experiment: string; status: string }>> {
  const rows = await client.searchStream(cid,
    `SELECT experiment_arm.campaigns, experiment_arm.in_design_campaigns, experiment.name, experiment.status
     FROM experiment_arm
     WHERE experiment.status IN ('ENABLED', 'INITIATED', 'SETUP')`);
  const byCampaign = new Map<string, { experiment: string; status: string }>();
  for (const row of rows) {
    const arm = obj(row.experimentArm);
    const experiment = obj(row.experiment);
    for (const campaign of [...list(arm.campaigns), ...list(arm.inDesignCampaigns)]) {
      byCampaign.set(campaign, { experiment: str(experiment.name), status: str(experiment.status) });
    }
  }
  return byCampaign;
}

async function fetchGroups(client: GoogleAdsClient, cid: string, where: string[]) {
  const rows = await client.searchStream(cid,
    `SELECT campaign_group.id, campaign_group.name, campaign_group.status, campaign_group.resource_name
     FROM campaign_group${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`);
  return rows.map((row) => {
    const g = obj(row.campaignGroup);
    return { id: str(g.id), name: str(g.name), status: str(g.status), resourceName: str(g.resourceName) };
  });
}

const campaignLabel = (c: Pick<CampaignInfo, "id" | "name" | "status">) => `${c.id} "${c.name}" (${c.status})`;

function budgetView(budget: BudgetInfo) {
  return {
    budget_id: budget.id,
    name: budget.name,
    resource_name: budget.resourceName,
    status: budget.status,
    period: budget.period,
    daily_amount: isTotalBudget(budget) ? null : units(budget.amountMicros),
    total_amount: isTotalBudget(budget) ? units(budget.totalAmountMicros) : null,
    explicitly_shared: budget.explicitlyShared,
    reference_count: budget.referenceCount,
    delivery_method: budget.deliveryMethod,
    type: budget.type,
    aligned_bidding_strategy_id: budget.alignedBiddingStrategyId,
  };
}

function recommendationView(budget: BudgetInfo) {
  if (!budget.hasRecommendedBudget) return null;
  return {
    recommended_daily_amount: units(budget.recommendedAmountMicros),
    weekly_change_clicks: budget.recommendedWeekly.clicks,
    weekly_change_cost: units(budget.recommendedWeekly.costMicros),
    weekly_change_interactions: budget.recommendedWeekly.interactions,
    weekly_change_views: budget.recommendedWeekly.views,
  };
}

/** Relatório por item de um mutate com partialFailure (mesma leitura das tools do núcleo). */
function perItemOutcome<T>(response: Row, items: T[], dryRun: boolean) {
  const results = (response.results as Row[] | undefined) ?? [];
  const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, items.length);
  const ok: T[] = [];
  const errors: Array<{ item: T; error: string }> = [];
  items.forEach((item, index) => {
    const opErrors = byIndex.get(index);
    if (opErrors) errors.push({ item, error: opErrors.map(explainBudgetError).join("; ") });
    else if (!dryRun && !str(obj(results[index]).resourceName)) errors.push({ item, error: "a API não confirmou a operação" });
    else ok.push(item);
  });
  return { ok, errors, unattributed: unattributed.map(explainBudgetError) };
}

// ── Ritmo de gasto (funções puras, testadas direto) ──────────────────

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));
/** Data ISO deslocada em `days` dias (calendário UTC, sem fuso). */
export const addDays = (iso: string, days: number) => new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10);
export const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Hoje no fuso da conta (customer.time_zone); sem fuso válido, a data local do servidor. */
export function todayInTimeZone(timeZone: string | undefined, now = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    } catch {
      // fuso desconhecido: cai no local
    }
  }
  return localIsoDate(now);
}

function paceStatus(pacePct: number | null): string {
  if (pacePct === null) return "SEM_DIA_COMPLETO";
  if (pacePct < PACE_LOW_PCT) return "ABAIXO_DO_RITMO";
  if (pacePct > PACE_HIGH_PCT) return "ACIMA_DO_RITMO";
  return "NO_RITMO";
}

export interface DailyPaceInput {
  dailyMicros: number;
  /** Gasto do mês até ontem (dias completos). Em mês passado, o mês inteiro. */
  spendToYesterdayMicros: number;
  /** Gasto de hoje, parcial (0 em mês passado). */
  spendTodayMicros: number;
  monthDays: number;
  /** Dias completos do mês já decorridos (antes de hoje); em mês passado = monthDays. */
  elapsedFullDays: number;
  isPastMonth: boolean;
  targetMicros?: number;
  hasEnabledCampaign: boolean;
}

/**
 * Ritmo de um orçamento diário no mês. Sem meta, a referência é o que o Google tenta gastar
 * (diário × dias do mês), limitada ao teto de cobrança de 30,4 × diário. O esperado até
 * ontem é proporcional aos dias completos; o gasto parcial de hoje fica fora do ritmo.
 */
export function paceDailyBudget(input: DailyPaceInput) {
  const capMicros = input.dailyMicros * MONTHLY_CAP_FACTOR;
  const referenceMicros = input.targetMicros ?? Math.min(input.dailyMicros * input.monthDays, capMicros);
  const expectedMicros = (referenceMicros * input.elapsedFullDays) / input.monthDays;
  const spendMicros = input.spendToYesterdayMicros + input.spendTodayMicros;
  const remainingDays = input.monthDays - input.elapsedFullDays;
  const averageMicros = input.elapsedFullDays > 0 ? input.spendToYesterdayMicros / input.elapsedFullDays : null;
  const projectedRaw = input.isPastMonth
    ? spendMicros
    : averageMicros === null ? null : input.spendToYesterdayMicros + averageMicros * remainingDays;
  const projectedCharged = projectedRaw === null ? null
    : input.isPastMonth || capMicros <= 0 ? projectedRaw : Math.min(projectedRaw, capMicros);
  const pacePct = expectedMicros > 0 ? round2((input.spendToYesterdayMicros / expectedMicros) * 100) : null;
  const dailyNeededMicros = !input.isPastMonth && remainingDays > 0
    ? Math.max(0, (referenceMicros - input.spendToYesterdayMicros) / remainingDays)
    : null;
  return {
    daily_budget: units(input.dailyMicros),
    monthly_charge_cap: units(capMicros),
    month_target: input.targetMicros === undefined ? null : units(input.targetMicros),
    month_reference: units(referenceMicros),
    spend_month_to_date: units(spendMicros),
    spend_to_yesterday: units(input.spendToYesterdayMicros),
    spend_today_partial: units(input.spendTodayMicros),
    expected_to_yesterday: units(expectedMicros),
    pace_pct: pacePct,
    projected_month_end: units(projectedCharged),
    projected_month_end_uncapped: units(projectedRaw),
    projection_capped: projectedRaw !== null && projectedCharged !== null && projectedCharged < projectedRaw,
    daily_needed_to_reach_reference: units(dailyNeededMicros),
    target_above_charge_cap: input.targetMicros !== undefined && input.targetMicros > capMicros,
    status: input.isPastMonth ? "MES_ENCERRADO" : input.hasEnabledCampaign ? paceStatus(pacePct) : "SEM_CAMPANHA_ATIVA",
  };
}

export interface TotalPaceInput {
  totalMicros: number;
  startDate: string | null;
  endDate: string | null;
  /**
   * Primeiro dia ainda não completo da medição: o gasto antes dele é "até ontem". No mês atual,
   * hoje; em mês fechado, o dia seguinte ao fim do mês pedido (a medição congela no fechamento).
   */
  today: string;
  spendToYesterdayMicros: number;
  spendTodayMicros: number;
  hasEnabledCampaign: boolean;
  /** Mês fechado: status é o do fechamento (ENCERRADA / NAO_INICIADA / MES_ENCERRADO), não o de hoje. */
  closedMonth?: boolean;
}

/** Ritmo de um orçamento total de campanha (CUSTOM_PERIOD) sobre as datas da campanha. */
export function paceTotalBudget(input: TotalPaceInput) {
  const spendMicros = input.spendToYesterdayMicros + input.spendTodayMicros;
  const base = {
    total_budget: units(input.totalMicros),
    start_date: input.startDate,
    end_date: input.endDate,
    measured_through: input.closedMonth ? addDays(input.today, -1) : input.today,
    spend_since_start: units(spendMicros),
    spend_today_partial: units(input.spendTodayMicros),
    remaining_budget: units(Math.max(0, input.totalMicros - spendMicros)),
  };
  if (!input.startDate || !input.endDate) {
    return { ...base, total_days: null, elapsed_full_days: null, expected_to_yesterday: null, pace_pct: null, projected_end: null, status: "SEM_DATAS" };
  }
  const totalDays = daysBetween(input.startDate, input.endDate) + 1;
  const ended = input.today > input.endDate;
  // Em mês fechado, campanha que só começou no dia seguinte ao fim do mês ainda não tinha começado.
  const notStarted = input.closedMonth ? input.startDate >= input.today : input.today < input.startDate;
  const elapsed = ended ? totalDays : Math.min(Math.max(daysBetween(input.startDate, input.today), 0), totalDays);
  const expectedMicros = totalDays > 0 ? (input.totalMicros * elapsed) / totalDays : 0;
  const pacePct = expectedMicros > 0 ? round2((input.spendToYesterdayMicros / expectedMicros) * 100) : null;
  const projectedMicros = ended
    ? spendMicros
    : elapsed > 0 ? Math.min(input.totalMicros, input.spendToYesterdayMicros + (input.spendToYesterdayMicros / elapsed) * (totalDays - elapsed)) : null;
  let status = paceStatus(pacePct);
  if (ended) status = "ENCERRADA";
  else if (notStarted) status = "NAO_INICIADA";
  else if (input.closedMonth) status = "MES_ENCERRADO";
  else if (!input.hasEnabledCampaign) status = "SEM_CAMPANHA_ATIVA";
  return {
    ...base,
    total_days: totalDays,
    elapsed_full_days: elapsed,
    expected_to_yesterday: units(expectedMicros),
    pace_pct: pacePct,
    projected_end: units(projectedMicros),
    status,
  };
}

// ── update_budget (registrada em src/tools.ts; a lógica mora aqui) ───

export interface UpdateBudgetArgs {
  customerId: string;
  budgetResourceName?: string;
  campaignId?: string;
  amountMicros?: number;
  totalAmountMicros?: number;
  name?: string;
  makeShared?: boolean;
  confirmShared?: boolean;
  confirm?: boolean;
}

export async function runUpdateBudget(
  ctx: Pick<ToolContext, "getClient" | "allowedCustomerIds" | "hosted">,
  args: UpdateBudgetArgs
): Promise<ToolResult> {
  const { customerId, budgetResourceName, campaignId, amountMicros, totalAmountMicros, name, makeShared, confirmShared, confirm } = args;
  const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
  if (blocked) return { content: [blocked], isError: true };
  const cid = normalizeCid(customerId);
  if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);

  const hasBudgetRef = budgetResourceName !== undefined && String(budgetResourceName).trim() !== "";
  const hasCampaign = campaignId !== undefined && String(campaignId).trim() !== "";
  if (hasBudgetRef === hasCampaign) {
    return fail("Informe budgetResourceName (ou o ID do orçamento) OU campaignId — exatamente um dos dois. Nada foi alterado.");
  }
  if (amountMicros === undefined && totalAmountMicros === undefined && name === undefined && !makeShared) {
    return fail("Nada para mudar: informe amountMicros (diário), totalAmountMicros (total da campanha), name ou makeShared.");
  }
  if (amountMicros !== undefined && totalAmountMicros !== undefined) {
    return fail("amountMicros e totalAmountMicros são mutuamente exclusivos (orçamento diário × total da campanha). Nada foi alterado.");
  }
  for (const [label, value] of [["amountMicros", amountMicros], ["totalAmountMicros", totalAmountMicros]] as const) {
    if (value === undefined) continue;
    const error = amountError(label, value);
    if (error) return fail(`${error} Nada foi alterado.`);
  }
  if (name !== undefined) {
    const error = nameError("name", name, 255);
    if (error) return fail(`${error} Nada foi alterado.`);
  }
  if (hasCampaign && !NUMERIC_ID.test(String(campaignId).trim())) {
    return fail(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`);
  }
  let ref: { id: string; resourceName: string } | undefined;
  if (hasBudgetRef) {
    const parsed = parseResourceRef("campaignBudgets", String(budgetResourceName), cid);
    if ("error" in parsed) return fail(`${parsed.error} Nada foi alterado.`);
    ref = parsed;
  }

  const client = ctx.getClient();
  if (!ref) {
    const id = String(campaignId).trim();
    const found = await fetchCampaigns(client, cid, [`campaign.id = ${id}`]);
    const campaign = found[0];
    if (!campaign) return fail(`Campanha ${id} não encontrada na conta ${cid}. Nada foi alterado.`);
    if (campaign.status === "REMOVED") return fail(`Campanha ${id} está removida. Nada foi alterado.`);
    const parsed = parseResourceRef("campaignBudgets", campaign.budget, cid);
    if ("error" in parsed) return fail(`A campanha ${id} não tem orçamento legível (${campaign.budget || "vazio"}). Nada foi alterado.`);
    ref = parsed;
  }

  const budget = (await fetchBudgets(client, cid, [`campaign_budget.id = ${ref.id}`]))[0];
  if (!budget) return fail(`Orçamento ${ref.id} não encontrado na conta ${cid}. Nada foi alterado.`);
  if (budget.status === "REMOVED") return fail(`Orçamento ${ref.id} está removido. Nada foi alterado.`);
  const members = await fetchCampaigns(client, cid, [
    `campaign.campaign_budget = '${gaqlLiteral(budget.resourceName)}'`,
    "campaign.status != 'REMOVED'",
  ]);
  const total = isTotalBudget(budget);
  const label = `Orçamento ${budget.id}${budget.name ? ` ("${budget.name}")` : ""}`;

  if (total && amountMicros !== undefined) {
    return fail(
      `${label} é um orçamento TOTAL da campanha (period CUSTOM_PERIOD, total atual ${money(budget.totalAmountMicros)}): ` +
      "amountMicros (diário) não se aplica. Use totalAmountMicros com o novo total. Nada foi alterado."
    );
  }
  if (!total && totalAmountMicros !== undefined) {
    return fail(
      `${label} é um orçamento DIÁRIO (period ${budget.period}, atual ${money(budget.amountMicros)}/dia): ` +
      "totalAmountMicros só vale para orçamento total da campanha. Use amountMicros. Nada foi alterado."
    );
  }

  const update: Row = { resourceName: budget.resourceName };
  const mask: string[] = [];
  const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const newAmount = total ? totalAmountMicros : amountMicros;
  const currentAmount = total ? budget.totalAmountMicros : budget.amountMicros;
  const amountField = total ? "total_amount_micros" : "amount_micros";

  if (newAmount !== undefined && newAmount !== currentAmount) {
    update[total ? "totalAmountMicros" : "amountMicros"] = String(newAmount);
    mask.push(amountField);
    changes.push({ setting: total ? "total_amount" : "daily_amount", before: units(currentAmount), after: units(newAmount) });
  }

  if (makeShared) {
    if (budget.explicitlyShared) {
      notes.push("O orçamento já é compartilhado — makeShared ignorado.");
    } else {
      if (total) {
        return fail(`${label} é um orçamento total da campanha: orçamento total não pode ser compartilhado. Nada foi alterado.`);
      }
      const experiments = await fetchExperimentCampaigns(client, cid);
      const inExperiment = members.filter((c) => experiments.has(c.resourceName) || c.experimentType !== "BASE");
      if (inExperiment.length) {
        return fail(
          `${label} não pode virar compartilhado: a campanha tem experimento (${inExperiment.map(campaignLabel).join(", ")}). ` +
          "Campanha com experimento precisa de orçamento próprio. Nada foi alterado."
        );
      }
      const grouped = members.filter((c) => c.group);
      if (grouped.length) {
        return fail(
          `${label} não pode virar compartilhado: ${grouped.map(campaignLabel).join(", ")} está em grupo de campanhas, ` +
          "e campanha em grupo não usa orçamento compartilhado. Tire do grupo com assign_campaign_group (campaignGroupId null). Nada foi alterado."
        );
      }
      const sharedName = (name ?? budget.name).trim();
      if (!sharedName) {
        return fail(`${label}: para compartilhar, informe name (a API exige nome na mesma operação). Nada foi alterado.`);
      }
      if (!confirm) {
        return fail(
          `${label}: tornar o orçamento compartilhado é irreversível (compartilhado nunca volta a individual). ` +
          `Repita com confirm: true para aplicar. Nada foi alterado.\n\n${formatJson({ budget: budgetView(budget), shared_name: sharedName })}`
        );
      }
      update.explicitlyShared = true;
      mask.push("explicitly_shared");
      changes.push({ setting: "explicitly_shared", before: false, after: true });
      if (sharedName !== budget.name) {
        update.name = sharedName;
        mask.push("name");
        changes.push({ setting: "name", before: budget.name, after: sharedName });
      } else {
        // a API pede o nome na mesma operação que compartilha
        update.name = sharedName;
        mask.push("name");
      }
    }
  }

  if (name !== undefined && !mask.includes("name")) {
    const trimmed = name.trim();
    if (trimmed !== budget.name) {
      if (!budget.explicitlyShared) {
        return fail(
          `${label} não é compartilhado: o nome acompanha o da campanha e a API não deixa renomear. ` +
          "Para dar nome próprio, use makeShared: true (irreversível). Nada foi alterado."
        );
      }
      update.name = trimmed;
      mask.push("name");
      changes.push({ setting: "name", before: budget.name, after: trimmed });
    }
  }

  if (mask.includes("name")) {
    const newName = String(update.name);
    const sameName = await fetchBudgets(client, cid, [
      `campaign_budget.name = '${gaqlLiteral(newName)}'`,
      "campaign_budget.status = 'ENABLED'",
    ]);
    if (sameName.some((other) => other.id !== budget.id)) {
      return fail(`Já existe outro orçamento chamado "${newName}" na conta. Escolha outro nome. Nada foi alterado.`);
    }
  }

  const campaignsView = members.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  if (mask.length === 0) {
    return {
      content: [text(
        `${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.` +
        `\n\n${formatJson({ budget: budgetView(budget), campaigns: campaignsView, notes })}`
      )],
    };
  }

  const amountChanging = mask.includes(amountField);
  const sharedWith = Math.max(budget.referenceCount, members.length);
  if (amountChanging && sharedWith > 1 && !confirmShared) {
    return fail(
      `${label} é COMPARTILHADO por ${sharedWith} campanhas: mudar o valor muda o gasto de todas elas. ` +
      `Repita com confirmShared: true para aplicar. Nada foi alterado.\n\n` +
      formatJson({ budget: budgetView(budget), affected_campaigns: campaignsView, attempted: changes })
    );
  }
  if (amountChanging && currentAmount && newAmount !== undefined && newAmount > currentAmount * LARGE_INCREASE_FACTOR && !confirm) {
    return fail(
      `${label}: o novo valor (${money(newAmount)}) é mais que o dobro do atual (${money(currentAmount)}). ` +
      `Confira os micros (1000000 = R$ 1,00) e repita com confirm: true para aplicar. Nada foi alterado.\n\n` +
      formatJson({ attempted: changes })
    );
  }
  if (amountChanging && !total) {
    warnings.push("Orçamento diário é média: em dias bons o Google pode gastar até 2× o diário, e no mês a cobrança fica limitada a 30,4 × o diário.");
  }
  if (amountChanging && total) {
    warnings.push("Orçamento total: o Google redistribui o gasto pelos dias que restam até a data de término da campanha.");
  }
  if (budget.type && budget.type !== "STANDARD" && budget.type !== "UNSPECIFIED") {
    warnings.push(`Tipo de orçamento ${budget.type}: confira se a mudança faz sentido para esse tipo.`);
  }
  if (sharedWith > 1 && amountChanging) {
    warnings.push(`Mudança aplicada ao orçamento compartilhado — vale para as ${sharedWith} campanhas listadas.`);
  }

  const dryRun = client.isDryRun;
  let result: Row;
  try {
    result = await client.mutateCampaignBudgets(customerId, [{ update, updateMask: mask.join(",") }]);
  } catch (err) {
    return fail(
      `${label}: a API não aceitou a alteração.\nErro: ${explainBudgetError((err as Error).message)}\n\n` +
      formatJson({ attempted: changes, update_mask: mask })
    );
  }
  return {
    content: [text(
      (dryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label} — ${changes.length} alteração(ões) aplicada(s).`) +
      `\n\n${formatJson({ changes, affected_campaigns: campaignsView, warnings, notes, update_mask: mask, result })}`
    )],
  };
}

// ── Registro das tools do módulo ─────────────────────────────────────

export function registerBudgetsTools(ctx: ToolContext): void {
  const { mcp, allowedCustomerIds, hosted } = ctx;

  // ── list_budgets ───────────────────────────────────────────────────

  mcp.registerTool(
    "list_budgets",
    {
      description: [
        "Inventário de orçamentos da conta (campaign_budget): valor diário ou total, período, se é compartilhado,",
        "quantas e quais campanhas usam cada um, orçamento recomendado pelo Google e orçamentos órfãos.",
        "READ-ONLY. Use antes de update_budget / assign_budget / remove_budget.",
        "",
        "sharedOnly: só os compartilhados (biblioteca compartilhada). unusedOnly: só os sem campanha (órfãos,",
        "reaproveitáveis com assign_budget ou removíveis com remove_budget). Valores na moeda da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        budgetId: z.string().optional().describe("Filtra um orçamento (ID numérico ou resource name)."),
        sharedOnly: z.boolean().optional().describe("true = só orçamentos compartilhados (explicitly_shared)."),
        unusedOnly: z.boolean().optional().describe("true = só orçamentos ativos sem nenhuma campanha (órfãos)."),
        includeRemoved: z.boolean().optional().describe("true = inclui orçamentos removidos. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, budgetId, sharedOnly, unusedOnly, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const where: string[] = [];
      if (budgetId !== undefined && budgetId.trim() !== "") {
        const parsed = parseResourceRef("campaignBudgets", budgetId, cid);
        if ("error" in parsed) return fail(parsed.error);
        where.push(`campaign_budget.id = ${parsed.id}`);
      }
      if (!includeRemoved) where.push("campaign_budget.status = 'ENABLED'");
      if (sharedOnly) where.push("campaign_budget.explicitly_shared = true");

      const client = ctx.getClient();
      const budgets = await fetchBudgets(client, cid, where);
      const campaigns = await fetchCampaigns(client, cid, ["campaign.status != 'REMOVED'"]);
      const byBudget = new Map<string, CampaignInfo[]>();
      for (const campaign of campaigns) {
        byBudget.set(campaign.budget, [...(byBudget.get(campaign.budget) ?? []), campaign]);
      }

      const rows = budgets
        .map((budget) => {
          const members = byBudget.get(budget.resourceName) ?? [];
          const notes: string[] = [];
          const orphan = budget.status === "ENABLED" && budget.referenceCount === 0 && members.length === 0;
          if (orphan) notes.push("Sem campanha: reaproveite com assign_budget ou remova com remove_budget.");
          if (budget.hasRecommendedBudget && budget.recommendedAmountMicros !== null && budget.amountMicros !== null &&
              budget.recommendedAmountMicros > budget.amountMicros) {
            notes.push(`Google recomenda ${money(budget.recommendedAmountMicros)}/dia (atual ${money(budget.amountMicros)}).`);
          }
          return {
            ...budgetView(budget),
            campaigns: members.map((c) => ({ id: c.id, name: c.name, status: c.status, primary_status: c.primaryStatus })),
            enabled_campaigns: members.filter((c) => c.status === "ENABLED").length,
            orphan,
            recommendation: recommendationView(budget),
            notes,
          };
        })
        .filter((row) => !unusedOnly || row.orphan)
        .sort((a, b) => Number(b.explicitly_shared) - Number(a.explicitly_shared) || b.campaigns.length - a.campaigns.length || a.name.localeCompare(b.name));

      if (format === "table" || format === "csv") {
        const flat = rows.map((row) => ({
          budget_id: row.budget_id,
          name: row.name,
          status: row.status,
          period: row.period,
          daily_amount: row.daily_amount ?? "",
          total_amount: row.total_amount ?? "",
          shared: row.explicitly_shared,
          reference_count: row.reference_count,
          campaigns: row.campaigns.map((c) => `${c.id}:${c.name} (${c.status})`).join("; "),
          recommended_daily: row.recommendation?.recommended_daily_amount ?? "",
          orphan: row.orphan,
        }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      const summary = {
        budgets: rows.length,
        shared: rows.filter((r) => r.explicitly_shared).length,
        individual: rows.filter((r) => !r.explicitly_shared).length,
        orphans: rows.filter((r) => r.orphan).length,
        with_recommendation: rows.filter((r) => r.recommendation).length,
      };
      return {
        content: [text(
          `${rows.length} orçamento(s) — ${summary.shared} compartilhado(s), ${summary.orphans} sem campanha.\n\n` +
          formatJson({ summary, budgets: rows })
        )],
      };
    }
  );

  // ── get_budget_pacing ──────────────────────────────────────────────

  mcp.registerTool(
    "get_budget_pacing",
    {
      description: [
        "Ritmo de gasto do mês por orçamento (pacing): gasto até ontem × esperado, % do ritmo, projeção de fim de mês,",
        "quanto por dia falta para chegar na referência, campanhas que dividem o orçamento, parcela de impressões",
        "perdida por orçamento (Pesquisa/Display), campanhas BUDGET_CONSTRAINED e o orçamento recomendado pelo Google",
        "com as estimativas semanais. READ-ONLY.",
        "",
        "Referência do mês: monthlyTargets (a verba combinada com o cliente, por orçamento ou por campanha) ou, sem",
        "meta, diário × dias do mês limitado a 30,4 × diário (teto de cobrança mensal do Google).",
        "O gasto parcial de hoje aparece à parte e fica fora do ritmo. Hoje = data no fuso da conta.",
        "Orçamento total de campanha (CUSTOM_PERIOD) é medido contra o total e as datas de início/fim da campanha;",
        "em mês fechado, a medição para no último dia do mês pedido (gasto posterior não entra).",
        "accountMonthlyTargetMicros (verba da conta inteira) não combina com campaignId/budgetId.",
        "Os valores de orçamento usados são os atuais: mudanças feitas no meio do mês não entram no esperado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Só o orçamento desta campanha (se compartilhado, mostra todas as que o usam)."),
        budgetId: z.string().optional().describe("Só este orçamento (ID numérico ou resource name)."),
        month: z.string().optional().describe("Mês YYYY-MM. Default: mês atual (no fuso da conta). Mês passado = fechamento."),
        monthlyTargets: flexArray(z.object({
          budgetId: z.string().optional().describe("Orçamento da meta (ID ou resource name)."),
          campaignId: z.string().optional().describe("Ou a campanha — a meta vale para o orçamento dela."),
          monthlyTargetMicros: z.number().describe("Verba do mês em MICROS (15000000000 = R$ 15.000)."),
        })).optional().describe("Metas mensais por orçamento/campanha (verba combinada com o cliente)."),
        accountMonthlyTargetMicros: z.number().optional().describe("Verba mensal da conta inteira em MICROS, para o resumo. Não combina com campaignId/budgetId."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, budgetId, month, monthlyTargets, accountMonthlyTargetMicros, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId.trim())) return fail(`campaignId deve ser numérico, recebido "${campaignId}".`);
      let budgetFilter: { id: string; resourceName: string } | undefined;
      if (budgetId !== undefined && budgetId.trim() !== "") {
        const parsed = parseResourceRef("campaignBudgets", budgetId, cid);
        if ("error" in parsed) return fail(parsed.error);
        budgetFilter = parsed;
      }
      if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(`month inválido: "${month}". Use YYYY-MM.`);
      const rawTargets = ensureArray<Row>(monthlyTargets).map(obj);
      const targetSpecs: Array<{ budgetId?: string; campaignId?: string; micros: number }> = [];
      for (const target of rawTargets) {
        const byBudget = str(target.budgetId).trim();
        const byCampaign = str(target.campaignId).trim();
        if (Boolean(byBudget) === Boolean(byCampaign)) return fail("Cada item de monthlyTargets precisa de budgetId OU campaignId (um dos dois).");
        const micros = target.monthlyTargetMicros;
        if (!isPositiveMicros(micros)) return fail(`monthlyTargetMicros deve ser inteiro positivo em micros; recebido ${String(micros)}.`);
        if (byCampaign && !NUMERIC_ID.test(byCampaign)) return fail(`campaignId da meta deve ser numérico: "${byCampaign}".`);
        let resolvedBudget: string | undefined;
        if (byBudget) {
          const parsed = parseResourceRef("campaignBudgets", byBudget, cid);
          if ("error" in parsed) return fail(parsed.error);
          resolvedBudget = parsed.id;
        }
        targetSpecs.push({ budgetId: resolvedBudget, campaignId: byCampaign || undefined, micros: micros as number });
      }
      if (accountMonthlyTargetMicros !== undefined && !isPositiveMicros(accountMonthlyTargetMicros)) {
        return fail(`accountMonthlyTargetMicros deve ser inteiro positivo em micros; recebido ${accountMonthlyTargetMicros}.`);
      }
      // A verba da conta só se compara com o gasto da conta inteira: com filtro, o resumo soma só
      // o orçamento filtrado e o ritmo / diário necessário da conta sairiam errados.
      if (accountMonthlyTargetMicros !== undefined && (campaignId !== undefined || budgetFilter !== undefined)) {
        return fail(
          "accountMonthlyTargetMicros é a verba da conta inteira e precisa do gasto da conta inteira: não combine com " +
          "campaignId/budgetId. Chame sem filtro para o ritmo da conta, ou use monthlyTargets para a meta de um orçamento/campanha."
        );
      }

      const client = ctx.getClient();
      let timeZone: string | undefined;
      let currency: string | undefined;
      try {
        const customer = obj((await client.getCustomer(customerId)).customer);
        timeZone = str(customer.timeZone) || undefined;
        currency = str(customer.currencyCode) || undefined;
      } catch {
        // sem fuso da conta: usa a data local do servidor (avisado abaixo)
      }
      const today = todayInTimeZone(timeZone);
      const currentMonth = today.slice(0, 7);
      const targetMonth = month ?? currentMonth;
      if (targetMonth > currentMonth) return fail(`month ${targetMonth} está no futuro (hoje é ${today} no fuso da conta).`);
      const isPastMonth = targetMonth < currentMonth;
      const monthDays = daysInMonth(targetMonth);
      const first = `${targetMonth}-01`;
      const last = isPastMonth ? `${targetMonth}-${String(monthDays).padStart(2, "0")}` : today;
      const elapsedFullDays = isPastMonth ? monthDays : Number(today.slice(8, 10)) - 1;

      const campaigns = await fetchCampaigns(client, cid, ["campaign.status != 'REMOVED'"]);
      let scope: Set<string> | undefined;
      if (campaignId !== undefined) {
        const campaign = campaigns.find((c) => c.id === campaignId.trim());
        if (!campaign) return fail(`Campanha ${campaignId} não encontrada (ou removida) na conta ${cid}.`);
        const parsed = parseResourceRef("campaignBudgets", campaign.budget, cid);
        if ("error" in parsed) return fail(`A campanha ${campaignId} não tem orçamento legível.`);
        scope = new Set([parsed.id]);
      }
      if (budgetFilter) {
        if (scope && !scope.has(budgetFilter.id)) return fail(`A campanha ${campaignId} não usa o orçamento ${budgetFilter.id}.`);
        scope = new Set([budgetFilter.id]);
      }
      const budgetIdFilter = scope ? [`campaign_budget.id IN (${[...scope].join(", ")})`] : [];

      const inventory = await fetchBudgets(client, cid, ["campaign_budget.status = 'ENABLED'", ...budgetIdFilter]);
      const spendRows = await client.searchStream(cid,
        `SELECT ${BUDGET_FIELDS}, segments.date, metrics.cost_micros FROM campaign_budget
         WHERE segments.date BETWEEN '${first}' AND '${last}'${budgetIdFilter.map((f) => ` AND ${f}`).join("")}`);
      const budgets = new Map<string, BudgetInfo>(inventory.map((b) => [b.id, b]));
      const monthSpend = new Map<string, { toYesterday: number; today: number }>();
      for (const row of spendRows) {
        const budget = parseBudget(row.campaignBudget);
        if (!budgets.has(budget.id)) budgets.set(budget.id, budget);
        const date = str(obj(row.segments).date);
        const cost = num(obj(row.metrics).costMicros);
        const entry = monthSpend.get(budget.id) ?? { toYesterday: 0, today: 0 };
        if (!isPastMonth && date === today) entry.today += cost;
        else entry.toYesterday += cost;
        monthSpend.set(budget.id, entry);
      }

      const inScopeBudgetNames = scope ? [...budgets.values()].filter((b) => scope!.has(b.id)).map((b) => b.resourceName) : [];
      const campaignMetricRows = await client.searchStream(cid,
        `SELECT campaign.id, campaign.campaign_budget, metrics.cost_micros, metrics.search_budget_lost_impression_share,
                metrics.content_budget_lost_impression_share, metrics.search_impression_share
         FROM campaign
         WHERE segments.date BETWEEN '${first}' AND '${last}'` +
        (inScopeBudgetNames.length ? ` AND campaign.campaign_budget IN (${inScopeBudgetNames.map((n) => `'${gaqlLiteral(n)}'`).join(", ")})` : ""));
      const campaignMetrics = new Map<string, Row>();
      for (const row of campaignMetricRows) campaignMetrics.set(str(obj(row.campaign).id), obj(row.metrics));

      const membersByBudget = new Map<string, CampaignInfo[]>();
      for (const campaign of campaigns) {
        membersByBudget.set(campaign.budget, [...(membersByBudget.get(campaign.budget) ?? []), campaign]);
      }

      // Metas: por campanha vira meta do orçamento dela
      const targets = new Map<string, number>();
      const warnings: string[] = [];
      for (const spec of targetSpecs) {
        let id = spec.budgetId;
        if (spec.campaignId) {
          const campaign = campaigns.find((c) => c.id === spec.campaignId);
          if (!campaign) return fail(`monthlyTargets: campanha ${spec.campaignId} não encontrada (ou removida).`);
          const parsed = parseResourceRef("campaignBudgets", campaign.budget, cid);
          if ("error" in parsed) return fail(`monthlyTargets: a campanha ${spec.campaignId} não tem orçamento legível.`);
          id = parsed.id;
          const shared = (membersByBudget.get(campaign.budget) ?? []).length > 1;
          if (shared) warnings.push(`Meta da campanha ${spec.campaignId} aplicada ao orçamento compartilhado ${id} (vale para todas as campanhas dele).`);
        }
        if (!id) continue;
        if (targets.has(id)) return fail(`monthlyTargets: duas metas para o mesmo orçamento ${id}.`);
        targets.set(id, spec.micros);
      }

      const selected = [...budgets.values()].filter((budget) => {
        if (scope && !scope.has(budget.id)) return false;
        const spend = monthSpend.get(budget.id);
        const members = membersByBudget.get(budget.resourceName) ?? [];
        return budget.referenceCount > 0 || members.length > 0 || (spend && spend.toYesterday + spend.today > 0) || targets.has(budget.id);
      });
      for (const id of targets.keys()) {
        if (!selected.some((b) => b.id === id)) warnings.push(`Meta para o orçamento ${id} ignorada: orçamento não encontrado no escopo.`);
      }

      // Orçamentos totais: gasto desde o início da campanha até o fim da medição — hoje no mês
      // atual; no mês fechado, o último dia do mês pedido (`last`). `asOf` é o primeiro dia ainda
      // não completo: hoje, ou o dia seguinte ao fechamento.
      const totalBudgets = selected.filter(isTotalBudget);
      const asOf = isPastMonth ? addDays(last, 1) : today;
      const lifetimeSpend = new Map<string, { toYesterday: number; today: number }>();
      const startOf = (budget: BudgetInfo) => {
        const members = membersByBudget.get(budget.resourceName) ?? [];
        const withDates = members.find((c) => c.startDate) ?? members[0];
        return { start: withDates?.startDate ?? null, end: withDates?.endDate ?? null };
      };
      const starts = totalBudgets.map((b) => startOf(b).start).filter((d): d is string => Boolean(d) && d! <= last);
      if (starts.length) {
        const minStart = starts.sort()[0];
        const rows = await client.searchStream(cid,
          `SELECT campaign_budget.id, segments.date, metrics.cost_micros FROM campaign_budget
           WHERE campaign_budget.id IN (${totalBudgets.map((b) => b.id).join(", ")})
             AND segments.date BETWEEN '${minStart}' AND '${last}'`);
        for (const row of rows) {
          const id = str(obj(row.campaignBudget).id);
          const date = str(obj(row.segments).date);
          const budget = totalBudgets.find((b) => b.id === id);
          const start = budget ? startOf(budget).start : null;
          if (!start || date < start || date > last) continue;
          const entry = lifetimeSpend.get(id) ?? { toYesterday: 0, today: 0 };
          if (!isPastMonth && date === today) entry.today += num(obj(row.metrics).costMicros);
          else entry.toYesterday += num(obj(row.metrics).costMicros);
          lifetimeSpend.set(id, entry);
        }
      }

      const results = selected.map((budget) => {
        const members = membersByBudget.get(budget.resourceName) ?? [];
        const hasEnabledCampaign = members.some((c) => c.status === "ENABLED");
        const spend = monthSpend.get(budget.id) ?? { toYesterday: 0, today: 0 };
        const campaignRows = members.map((c) => {
          const metrics = campaignMetrics.get(c.id) ?? {};
          return {
            id: c.id,
            name: c.name,
            status: c.status,
            primary_status: c.primaryStatus,
            budget_constrained: c.primaryStatusReasons.includes("BUDGET_CONSTRAINED"),
            spend_month: units(num(metrics.costMicros)),
            search_budget_lost_is_pct: pct(metrics.searchBudgetLostImpressionShare),
            content_budget_lost_is_pct: pct(metrics.contentBudgetLostImpressionShare),
            search_is_pct: pct(metrics.searchImpressionShare),
          };
        });
        const flags: string[] = [];
        const constrained = campaignRows.filter((c) => c.budget_constrained);
        if (constrained.length) flags.push(`BUDGET_CONSTRAINED: ${constrained.map((c) => c.id).join(", ")}`);
        const misconfigured = members.filter((c) => c.primaryStatusReasons.includes("BUDGET_MISCONFIGURED"));
        if (misconfigured.length) flags.push(`BUDGET_MISCONFIGURED: ${misconfigured.map((c) => c.id).join(", ")}`);
        const lostValues = campaignRows.flatMap((c) => [c.search_budget_lost_is_pct, c.content_budget_lost_is_pct]).filter((v): v is number => v !== null);
        const maxLost = lostValues.length ? Math.max(...lostValues) : null;
        if (maxLost !== null && maxLost >= 10) flags.push(`Perde até ${maxLost}% das impressões por orçamento.`);
        if (budget.hasRecommendedBudget && budget.recommendedAmountMicros !== null && budget.amountMicros !== null &&
            budget.recommendedAmountMicros > budget.amountMicros) {
          flags.push(`Google recomenda ${money(budget.recommendedAmountMicros)}/dia.`);
        }
        const common = {
          budget_id: budget.id,
          name: budget.name,
          period: budget.period,
          explicitly_shared: budget.explicitlyShared,
          status: budget.status,
          campaigns: campaignRows,
          max_budget_lost_is_pct: maxLost,
          recommendation: recommendationView(budget),
          flags,
        };
        if (isTotalBudget(budget)) {
          const dates = startOf(budget);
          const lifetime = lifetimeSpend.get(budget.id) ?? { toYesterday: 0, today: 0 };
          if (targets.has(budget.id)) warnings.push(`Meta mensal ignorada no orçamento ${budget.id}: é orçamento total da campanha.`);
          return {
            ...common,
            spend_month_to_date: units(spend.toYesterday + spend.today),
            pacing: paceTotalBudget({
              totalMicros: budget.totalAmountMicros ?? 0,
              startDate: dates.start,
              endDate: dates.end,
              today: asOf,
              spendToYesterdayMicros: lifetime.toYesterday,
              spendTodayMicros: lifetime.today,
              hasEnabledCampaign,
              closedMonth: isPastMonth,
            }),
          };
        }
        const pacing = paceDailyBudget({
          dailyMicros: budget.amountMicros ?? 0,
          spendToYesterdayMicros: spend.toYesterday,
          spendTodayMicros: spend.today,
          monthDays,
          elapsedFullDays,
          isPastMonth,
          targetMicros: targets.get(budget.id),
          hasEnabledCampaign,
        });
        if (pacing.target_above_charge_cap) {
          flags.push(`Meta acima do teto de cobrança do orçamento (30,4 × diário = ${pacing.monthly_charge_cap}): o diário atual não comporta a meta.`);
        }
        return { ...common, spend_month_to_date: pacing.spend_month_to_date, pacing };
      });
      results.sort((a, b) => num(b.spend_month_to_date) - num(a.spend_month_to_date));

      // Resumo da conta (linear sobre o gasto até ontem)
      let spendToYesterday = 0;
      let spendToday = 0;
      for (const [id, entry] of monthSpend) {
        if (scope && !scope.has(id)) continue;
        spendToYesterday += entry.toYesterday;
        spendToday += entry.today;
      }
      const activeDaily = selected
        .filter((b) => !isTotalBudget(b) && (membersByBudget.get(b.resourceName) ?? []).some((c) => c.status === "ENABLED"))
        .reduce((sum, b) => sum + (b.amountMicros ?? 0), 0);
      const projected = isPastMonth
        ? spendToYesterday + spendToday
        : elapsedFullDays > 0 ? spendToYesterday + (spendToYesterday / elapsedFullDays) * (monthDays - elapsedFullDays) : null;
      const summary: Row = {
        month: targetMonth,
        today,
        time_zone: timeZone ?? "desconhecido (data local do servidor)",
        currency: currency ?? null,
        month_days: monthDays,
        elapsed_full_days: elapsedFullDays,
        budgets: results.length,
        active_daily_budget_total: units(activeDaily),
        active_daily_budget_month_cap: units(activeDaily * MONTHLY_CAP_FACTOR),
        spend_month_to_date: units(spendToYesterday + spendToday),
        spend_to_yesterday: units(spendToYesterday),
        spend_today_partial: units(spendToday),
        projected_month_end_linear: units(projected),
        budget_constrained_campaigns: results.reduce((n, r) => n + r.campaigns.filter((c) => c.budget_constrained).length, 0),
        off_pace: results.filter((r) => ["ABAIXO_DO_RITMO", "ACIMA_DO_RITMO"].includes(String(r.pacing.status))).map((r) => r.budget_id),
      };
      if (accountMonthlyTargetMicros !== undefined) {
        const expected = (accountMonthlyTargetMicros * elapsedFullDays) / monthDays;
        const remaining = monthDays - elapsedFullDays;
        summary.account_target = units(accountMonthlyTargetMicros);
        summary.account_expected_to_yesterday = units(expected);
        summary.account_pace_pct = expected > 0 ? round2((spendToYesterday / expected) * 100) : null;
        summary.account_daily_needed = !isPastMonth && remaining > 0 ? units(Math.max(0, (accountMonthlyTargetMicros - spendToYesterday) / remaining)) : null;
        // (sem filtro garantido: accountMonthlyTargetMicros com campaignId/budgetId é recusado acima)
        if (activeDaily * MONTHLY_CAP_FACTOR < accountMonthlyTargetMicros) {
          warnings.push("A soma dos orçamentos diários ativos × 30,4 fica abaixo da verba mensal da conta: sem aumentar orçamento, a meta não é atingida.");
        }
      }
      if (!timeZone) warnings.push("Fuso da conta indisponível: 'hoje' usa a data local do servidor.");
      if (!isPastMonth) warnings.push("O gasto de hoje é parcial e fica fora do % de ritmo; o esperado usa só dias completos.");
      if (isPastMonth && totalBudgets.length) {
        warnings.push(
          `Mês fechado: orçamentos totais (CUSTOM_PERIOD) medidos do início da campanha até ${last}; o gasto depois do mês não entra ` +
          "(spend_since_start). spend_month_to_date é só o gasto dentro do mês."
        );
      }
      warnings.push("O esperado usa o valor ATUAL de cada orçamento; mudanças feitas durante o mês não são reconstruídas.");

      if (format === "table" || format === "csv") {
        const flat = results.map((r) => {
          const p = r.pacing as Row;
          return {
            budget_id: r.budget_id,
            name: r.name,
            period: r.period,
            shared: r.explicitly_shared,
            campaigns: r.campaigns.length,
            daily_budget: p.daily_budget ?? "",
            total_budget: p.total_budget ?? "",
            reference: p.month_reference ?? p.total_budget ?? "",
            // spend = gasto dentro do mês pedido em TODA linha; o acumulado do orçamento total
            // (base do expected / pace_pct dele) vai em spend_since_start.
            spend: r.spend_month_to_date ?? "",
            spend_since_start: p.spend_since_start ?? "",
            expected: p.expected_to_yesterday ?? "",
            pace_pct: p.pace_pct ?? "",
            projected: p.projected_month_end ?? p.projected_end ?? "",
            status: p.status,
            max_lost_is_pct: r.max_budget_lost_is_pct ?? "",
            budget_constrained: r.campaigns.some((c) => c.budget_constrained),
            recommended_daily: r.recommendation?.recommended_daily_amount ?? "",
          };
        });
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      return {
        content: [text(
          `Ritmo de ${targetMonth} (${isPastMonth ? "mês encerrado" : `${elapsedFullDays} de ${monthDays} dias completos`}) — ` +
          `${results.length} orçamento(s), ${(summary.off_pace as string[]).length} fora do ritmo.\n\n` +
          formatJson({ summary, budgets: results, warnings })
        )],
      };
    }
  );

  // ── create_shared_budget ───────────────────────────────────────────

  mcp.registerTool(
    "create_shared_budget",
    {
      description: [
        "Cria um orçamento diário COMPARTILHADO (explicitly_shared) e, opcionalmente, já move campanhas para ele.",
        "WRITE OPERATION. Com campaignIds, orçamento e campanhas vão num único googleAds:mutate atômico",
        "(ID temporário): ou tudo entra, ou nada. Mover campanhas exige confirm: true.",
        "",
        "Recusa antes de gravar: nome já usado, campanha removida, de rascunho/experimento, com experimento ativo,",
        "em grupo de campanhas (a API não deixa campanha em grupo usar orçamento compartilhado) ou com orçamento",
        "total (CUSTOM_PERIOD — o período não muda depois de criada a campanha).",
        "Os orçamentos individuais antigos das campanhas movidas ficam órfãos: remova com remove_budget.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do orçamento compartilhado (único na conta, até 255 bytes)."),
        amountMicros: z.number().describe("Valor diário médio em MICROS (100000000 = R$ 100/dia)."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas para já usar este orçamento."),
        confirm: z.boolean().optional().describe("Obrigatório (true) quando há campaignIds: troca o orçamento de campanhas existentes."),
      },
    },
    async ({ customerId, name, amountMicros, campaignIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi criado.`);
      const badName = nameError("name", name, 255);
      if (badName) return fail(`${badName} Nada foi criado.`);
      const badAmount = amountError("amountMicros", amountMicros);
      if (badAmount) return fail(`${badAmount} Nada foi criado.`);
      let ids: string[] = [];
      if (campaignIds !== undefined && ensureArray(campaignIds).length > 0) {
        const parsed = parseIdList(campaignIds, "campaignId");
        if ("error" in parsed) return fail(`${parsed.error} Nada foi criado.`);
        ids = parsed.ids;
      }
      const budgetName = name.trim();
      const client = ctx.getClient();
      const duplicate = await fetchBudgets(client, cid, [
        `campaign_budget.name = '${gaqlLiteral(budgetName)}'`,
        "campaign_budget.status = 'ENABLED'",
      ]);
      if (duplicate.length) {
        return fail(`Já existe orçamento chamado "${budgetName}" (ID ${duplicate[0].id}). Escolha outro nome ou reaproveite com assign_budget. Nada foi criado.`);
      }

      const moves: Array<{ campaign: CampaignInfo; previous: BudgetInfo }> = [];
      if (ids.length) {
        const found = await fetchCampaigns(client, cid, [`campaign.id IN (${ids.join(", ")})`], true);
        const experiments = await fetchExperimentCampaigns(client, cid);
        const problems: string[] = [];
        for (const id of ids) {
          const campaign = found.find((c) => c.id === id);
          if (!campaign) { problems.push(`${id}: não encontrada na conta`); continue; }
          const reason = assignRefusal(campaign, experiments, { period: "DAILY", type: "STANDARD", explicitlyShared: true, alignedBiddingStrategyId: null }, cid);
          if (reason) { problems.push(`${campaignLabel(campaign)}: ${reason}`); continue; }
          moves.push({ campaign, previous: campaign.budgetInfo! });
        }
        if (problems.length) {
          return fail(`Nada foi criado — campanha(s) que não podem usar orçamento compartilhado:\n- ${problems.join("\n- ")}`);
        }
      }
      const plan = {
        budget: { name: budgetName, daily_amount: units(amountMicros), explicitly_shared: true, period: "DAILY", delivery_method: "STANDARD" },
        campaigns: moves.map((m) => ({
          id: m.campaign.id,
          name: m.campaign.name,
          status: m.campaign.status,
          previous_budget_id: m.previous.id,
          previous_daily_amount: units(m.previous.amountMicros),
          previous_budget_shared: m.previous.explicitlyShared,
        })),
      };
      if (moves.length && !confirm) {
        return fail(
          "PRÉVIA — nada foi gravado. Mover campanhas troca o orçamento que paga cada uma; repita com confirm: true para aplicar.\n\n" +
          formatJson(plan)
        );
      }

      const budgetBody: Row = {
        name: budgetName,
        amountMicros: String(amountMicros),
        deliveryMethod: "STANDARD",
        period: "DAILY",
        explicitlyShared: true,
      };
      const dryRun = client.isDryRun;
      let resourceName = "";
      try {
        if (moves.length) {
          const temp = `customers/${cid}/campaignBudgets/-1`;
          const response = await client.batchMutate(customerId, [
            { campaignBudgetOperation: { create: { resourceName: temp, ...budgetBody } } },
            ...moves.map((m) => ({
              campaignOperation: {
                update: { resourceName: m.campaign.resourceName || `customers/${cid}/campaigns/${m.campaign.id}`, campaignBudget: temp },
                updateMask: "campaign_budget",
              },
            })),
          ]);
          const responses = (response.mutateOperationResponses as Row[] | undefined) ?? [];
          resourceName = str(obj(responses.find((r) => r.campaignBudgetResult)?.campaignBudgetResult).resourceName);
        } else {
          const response = await client.mutateCampaignBudgets(customerId, [{ create: budgetBody }]);
          resourceName = str(obj(((response.results as Row[] | undefined) ?? [])[0]).resourceName);
        }
      } catch (err) {
        return fail(`Nada foi criado${moves.length ? " (orçamento e campanhas vão na mesma operação atômica)" : ""}.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      if (!dryRun && !resourceName) {
        return fail("A API não confirmou a criação do orçamento — confira com list_budgets antes de repetir.");
      }
      const orphans = moves.filter((m) => !m.previous.explicitlyShared).map((m) => m.previous.id);
      const warnings: string[] = [];
      if (moves.length) {
        warnings.push(
          "Trocar o orçamento de uma campanha no meio do mês zera a referência de gasto do orçamento antigo: " +
          "no mês, a campanha pode gastar além do que gastaria só ajustando o valor (documentação do Google Ads API)."
        );
      }
      if (orphans.length) warnings.push(`Orçamentos individuais que ficaram sem campanha: ${orphans.join(", ")} — remova com remove_budget.`);
      return {
        content: [text(
          (dryRun ? "DRY-RUN (validateOnly): validado, nada foi gravado." : `Orçamento compartilhado criado: ${resourceName}.`) +
          `\n\n${formatJson({ ...plan, resource_name: resourceName || null, warnings })}`
        )],
      };
    }
  );

  // ── assign_budget ──────────────────────────────────────────────────

  mcp.registerTool(
    "assign_budget",
    {
      description: [
        "Troca o orçamento de campanhas existentes para um orçamento que já existe (em geral, um compartilhado).",
        "WRITE OPERATION — exige confirm: true; sem ele devolve a PRÉVIA (antes/depois) e não grava nada.",
        "",
        "Recusa por campanha, antes de gravar: removida, rascunho/experimento, com experimento rodando ou agendado,",
        "período diferente (diário × total — não muda depois de criada), tipo de orçamento diferente, orçamento",
        "compartilhado em campanha de grupo de campanhas, orçamento individual já usado por outra campanha, e",
        "estratégia de lances diferente da alinhada ao orçamento. Campanha que já usa o orçamento é pulada.",
        "Aviso: o Google recomenda ajustar o valor do orçamento atual em vez de trocar — trocar no meio do mês pode",
        "fazer a campanha gastar mais no mês. Orçamentos individuais que ficarem órfãos saem com remove_budget.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignIds: flexArray(z.string()).describe("Campanhas que passam a usar o orçamento."),
        budgetId: z.string().describe("Orçamento de destino (ID numérico ou resource name). Veja list_budgets."),
        confirm: z.boolean().optional().describe("true = aplica. Sem isso, só mostra a prévia."),
      },
    },
    async ({ customerId, campaignIds, budgetId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const parsedIds = parseIdList(campaignIds, "campaignId");
      if ("error" in parsedIds) return fail(`${parsedIds.error} Nada foi alterado.`);
      const ref = parseResourceRef("campaignBudgets", budgetId, cid);
      if ("error" in ref) return fail(`${ref.error} Nada foi alterado.`);

      const client = ctx.getClient();
      const target = (await fetchBudgets(client, cid, [`campaign_budget.id = ${ref.id}`]))[0];
      if (!target) return fail(`Orçamento ${ref.id} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (target.status === "REMOVED") return fail(`Orçamento ${ref.id} está removido. Nada foi alterado.`);
      if (isTotalBudget(target)) {
        return fail(`Orçamento ${ref.id} é total de campanha (CUSTOM_PERIOD): não é compartilhável nem reatribuível por aqui. Nada foi alterado.`);
      }
      const found = await fetchCampaigns(client, cid, [`campaign.id IN (${parsedIds.ids.join(", ")})`], true);
      const currentMembers = await fetchCampaigns(client, cid, [
        `campaign.campaign_budget = '${gaqlLiteral(target.resourceName)}'`,
        "campaign.status != 'REMOVED'",
      ]);
      const experiments = await fetchExperimentCampaigns(client, cid);

      const toMove: Array<{ campaign: CampaignInfo; previous: BudgetInfo }> = [];
      const skipped: Array<Record<string, unknown>> = [];
      const refused: Array<Record<string, unknown>> = [];
      for (const id of parsedIds.ids) {
        const campaign = found.find((c) => c.id === id);
        if (!campaign) { refused.push({ campaign_id: id, reason: "não encontrada na conta" }); continue; }
        if (campaign.budget === target.resourceName) {
          skipped.push({ campaign_id: id, name: campaign.name, reason: "já usa este orçamento" });
          continue;
        }
        const reason = assignRefusal(campaign, experiments, target, cid);
        if (reason) { refused.push({ campaign_id: id, name: campaign.name, reason }); continue; }
        toMove.push({ campaign, previous: campaign.budgetInfo! });
      }
      const finalUsers = currentMembers.length + toMove.length;
      if (!target.explicitlyShared && finalUsers > 1 && toMove.length) {
        return fail(
          `Orçamento ${target.id} não é compartilhado e ficaria com ${finalUsers} campanhas — a API recusa ` +
          "(CANNOT_USE_IMPLICITLY_SHARED_CAMPAIGN_BUDGET_WITH_MULTIPLE_CAMPAIGNS). Use create_shared_budget ou " +
          "update_budget com makeShared: true antes. Nada foi alterado.\n\n" +
          formatJson({ current_campaigns: currentMembers.map((c) => ({ id: c.id, name: c.name, status: c.status })), requested: toMove.map((m) => m.campaign.id) })
        );
      }
      const plan = {
        target_budget: { ...budgetView(target), current_campaigns: currentMembers.map((c) => ({ id: c.id, name: c.name, status: c.status })) },
        to_move: toMove.map((m) => ({
          campaign_id: m.campaign.id,
          name: m.campaign.name,
          status: m.campaign.status,
          before: { budget_id: m.previous.id, daily_amount: units(m.previous.amountMicros), shared: m.previous.explicitlyShared },
          after: { budget_id: target.id, daily_amount: units(target.amountMicros), shared: target.explicitlyShared },
        })),
        skipped,
        refused,
      };
      if (toMove.length === 0) {
        return {
          content: [text(`Nada a gravar: nenhuma campanha precisa (ou pode) ser movida para o orçamento ${target.id}.\n\n${formatJson(plan)}`)],
          isError: refused.length > 0,
        };
      }
      if (!confirm) {
        return fail(
          `PRÉVIA — nada foi gravado. ${toMove.length} campanha(s) passariam para o orçamento ${target.id}` +
          ` (${money(target.amountMicros)}/dia). Repita com confirm: true para aplicar.\n\n${formatJson(plan)}`
        );
      }

      const operations: MutateOperation[] = toMove.map((m) => ({
        update: { resourceName: m.campaign.resourceName || `customers/${cid}/campaigns/${m.campaign.id}`, campaignBudget: target.resourceName },
        updateMask: "campaign_budget",
      }));
      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaigns", operations, { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi alterado.\nErro: ${explainBudgetError((err as Error).message)}\n\n${formatJson(plan)}`);
      }
      const outcome = perItemOutcome(response, toMove, dryRun);
      const moved = outcome.ok.map((m) => ({ campaign_id: m.campaign.id, name: m.campaign.name, previous_budget_id: m.previous.id }));
      const errors = [
        ...outcome.errors.map((e) => ({ campaign_id: e.item.campaign.id, name: e.item.campaign.name, error: e.error })),
        ...outcome.unattributed.map((error) => ({ error })),
      ];
      const orphanIds = [...new Set(outcome.ok.filter((m) => !m.previous.explicitlyShared || m.previous.referenceCount <= 1).map((m) => m.previous.id))];
      const warnings = [
        "Trocar o orçamento no meio do mês zera a referência de gasto do orçamento antigo: no mês, a campanha pode gastar mais do que gastaria só ajustando o valor.",
      ];
      if (orphanIds.length && !dryRun) warnings.push(`Orçamentos que podem ter ficado sem campanha: ${orphanIds.join(", ")} — confira com list_budgets (unusedOnly) e remova com remove_budget.`);
      return {
        content: [text(
          (dryRun
            ? `DRY-RUN (validateOnly): nada foi gravado. Validadas: ${moved.length}`
            : `${moved.length} campanha(s) movida(s) para o orçamento ${target.id}`) +
          ` | Puladas: ${skipped.length} | Recusadas: ${refused.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "moved"]: moved, skipped, refused, errors, warnings })
        )],
        isError: errors.length > 0,
      };
    }
  );

  // ── remove_budget ──────────────────────────────────────────────────

  mcp.registerTool(
    "remove_budget",
    {
      description: [
        "Remove orçamentos SEM campanha (órfãos) — por exemplo, os individuais que sobraram depois de assign_budget.",
        "WRITE OPERATION — irreversível; exige confirm: true.",
        "Recusa orçamento com campanha ativa ou pausada (reference_count > 0 → CAMPAIGN_BUDGET_IN_USE) e orçamento",
        "alinhado a estratégia de portfólio. Já removido é pulado. Várias remoções: cada uma é relatada à parte.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        budgetIds: flexArray(z.string()).describe("Orçamentos a remover (IDs numéricos ou resource names)."),
        confirm: z.boolean().describe("Precisa ser true — remoção não tem volta."),
      },
    },
    async ({ customerId, budgetIds, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      const refs = ensureArray<unknown>(budgetIds).map((raw) => String(raw).trim()).filter(Boolean);
      if (refs.length === 0) return fail("Informe budgetIds. Nada foi removido.");
      const ids: string[] = [];
      for (const raw of refs) {
        const parsed = parseResourceRef("campaignBudgets", raw, cid);
        if ("error" in parsed) return fail(`${parsed.error} Nada foi removido.`);
        if (!ids.includes(parsed.id)) ids.push(parsed.id);
      }
      if (!confirm) return fail("Remover orçamento é irreversível. Repita com confirm: true. Nada foi removido.");

      const client = ctx.getClient();
      const budgets = await fetchBudgets(client, cid, [`campaign_budget.id IN (${ids.join(", ")})`]);
      const users = budgets.length
        ? await fetchCampaigns(client, cid, [
          `campaign.campaign_budget IN (${budgets.map((b) => `'${gaqlLiteral(b.resourceName)}'`).join(", ")})`,
          "campaign.status != 'REMOVED'",
        ])
        : [];
      const toRemove: BudgetInfo[] = [];
      const skipped: Array<Record<string, unknown>> = [];
      const refused: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const budget = budgets.find((b) => b.id === id);
        if (!budget) { refused.push({ budget_id: id, reason: "não encontrado na conta" }); continue; }
        if (budget.status === "REMOVED") { skipped.push({ budget_id: id, reason: "já removido" }); continue; }
        const members = users.filter((c) => c.budget === budget.resourceName);
        if (budget.referenceCount > 0 || members.length) {
          refused.push({
            budget_id: id,
            name: budget.name,
            reason: `em uso por ${Math.max(budget.referenceCount, members.length)} campanha(s) — mova antes com assign_budget`,
            campaigns: members.map((c) => ({ id: c.id, name: c.name, status: c.status })),
          });
          continue;
        }
        if (budget.alignedBiddingStrategyId) {
          refused.push({ budget_id: id, name: budget.name, reason: `alinhado à estratégia de portfólio ${budget.alignedBiddingStrategyId} (só sai junto com ela)` });
          continue;
        }
        toRemove.push(budget);
      }
      if (toRemove.length === 0) {
        return {
          content: [text(`Nada a remover.\n\n${formatJson({ skipped, refused })}`)],
          isError: refused.length > 0,
        };
      }
      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignBudgets", toRemove.map((b) => ({ remove: b.resourceName })), { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi removido.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      const outcome = perItemOutcome(response, toRemove, dryRun);
      const removed = outcome.ok.map((b) => ({ budget_id: b.id, name: b.name, daily_amount: units(b.amountMicros) }));
      const errors = [
        ...outcome.errors.map((e) => ({ budget_id: e.item.id, error: e.error })),
        ...outcome.unattributed.map((error) => ({ error })),
      ];
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): nada foi removido. Validados: ${removed.length}` : `${removed.length} orçamento(s) removido(s)`) +
          ` | Pulados: ${skipped.length} | Recusados: ${refused.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "removed"]: removed, skipped, refused, errors })
        )],
        isError: errors.length > 0 || refused.length > 0,
      };
    }
  );

  // ── Grupos de campanhas ────────────────────────────────────────────

  mcp.registerTool(
    "get_campaign_group_performance",
    {
      description: [
        "Grupos de campanhas (campaign_group): quais campanhas estão em cada grupo e o desempenho somado no período",
        "(impressões, cliques, CTR, gasto, CPC, conversões, CPA, valor, ROAS). READ-ONLY.",
        "Sem campaignGroupId, lista todos os grupos ativos e soma à parte as campanhas sem grupo e as que ainda",
        "apontam para grupo removido (cada campanha cai em um balde só: os baldes somam o total da conta no período).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignGroupId: z.string().optional().describe("Só este grupo (ID numérico ou resource name)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        includeCampaigns: z.boolean().optional().describe("true (default) = detalha cada campanha do grupo."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignGroupId, dateRange, days, includeCampaigns, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      let groupRef: { id: string; resourceName: string } | undefined;
      if (campaignGroupId !== undefined && campaignGroupId.trim() !== "") {
        const parsed = parseResourceRef("campaignGroups", campaignGroupId, cid);
        if ("error" in parsed) return fail(parsed.error);
        groupRef = parsed;
      }
      let dateClause: string;
      try {
        dateClause = buildDateClause(dateRange, days);
      } catch (err) {
        return fail((err as Error).message);
      }
      const client = ctx.getClient();
      // Sem filtro, lê TODOS os grupos (inclusive removidos): campanha que ainda aponta para um grupo
      // removido (remove_campaign_group deixa as campanhas REMOVED ligadas a ele) precisa cair num
      // balde próprio, senão o gasto dela some do relatório e os baldes não fecham com a conta.
      const groups = await fetchGroups(client, cid, groupRef ? [`campaign_group.id = ${groupRef.id}`] : []);
      if (groupRef && groups.length === 0) return fail(`Grupo de campanhas ${groupRef.id} não encontrado na conta ${cid}.`);
      const groupFilter = groupRef ? [`campaign.campaign_group = '${gaqlLiteral(groupRef.resourceName)}'`] : [];
      const memberRows = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_group FROM campaign
         WHERE campaign.status != 'REMOVED'${groupFilter.map((f) => ` AND ${f}`).join("")}`);
      const metricRows = await client.searchStream(cid,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_group, metrics.impressions, metrics.clicks,
                metrics.cost_micros, metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${dateClause}${groupFilter.map((f) => ` AND ${f}`).join("")}`);

      const metricsByCampaign = new Map<string, MetricTotals>();
      const groupOfCampaign = new Map<string, string>();
      const infoOfCampaign = new Map<string, { name: string; status: string }>();
      for (const row of metricRows) {
        const campaign = obj(row.campaign);
        const id = str(campaign.id);
        groupOfCampaign.set(id, str(campaign.campaignGroup));
        infoOfCampaign.set(id, { name: str(campaign.name), status: str(campaign.status) });
        metricsByCampaign.set(id, addMetrics(metricsByCampaign.get(id) ?? emptyTotals(), obj(row.metrics)));
      }
      const members = memberRows.map((row) => {
        const c = obj(row.campaign);
        return { id: str(c.id), name: str(c.name), status: str(c.status), group: str(c.campaignGroup) };
      });
      for (const m of members) {
        groupOfCampaign.set(m.id, m.group);
        infoOfCampaign.set(m.id, { name: m.name, status: m.status });
      }

      // Baldes: grupos ativos (mesmo vazios); grupos não ativos ou não listados só quando ainda têm
      // campanha (com gasto no período ou não removida); e as campanhas sem grupo. Toda campanha
      // cai em exatamente um balde, então a soma dos baldes é o total da conta no período.
      const knownGroups = new Map(groups.map((g) => [g.resourceName, g]));
      const buckets = groups
        .filter((g) => groupRef || g.status === "ENABLED")
        .map((g) => ({ key: g.resourceName, group_id: g.id, name: g.name, status: g.status }));
      for (const id of new Set([...members.map((m) => m.id), ...metricsByCampaign.keys()])) {
        const key = groupOfCampaign.get(id) ?? "";
        if (!key || buckets.some((b) => b.key === key)) continue;
        const known = knownGroups.get(key);
        buckets.push(known
          ? { key, group_id: known.id, name: known.name, status: known.status }
          : { key, group_id: /\/campaignGroups\/(\d+)$/.exec(key)?.[1] ?? key, name: "(grupo não encontrado)", status: "DESCONHECIDO" });
      }
      if (!groupRef) buckets.push({ key: "", group_id: "", name: "(sem grupo)", status: "" });
      const results = buckets.map((bucket) => {
        const campaignIds = new Set([
          ...members.filter((m) => m.group === bucket.key).map((m) => m.id),
          ...[...metricsByCampaign.keys()].filter((id) => groupOfCampaign.get(id) === bucket.key),
        ]);
        const totals = emptyTotals();
        const campaignsOut = [...campaignIds].map((id) => {
          const m = metricsByCampaign.get(id) ?? emptyTotals();
          totals.impressions += m.impressions; totals.clicks += m.clicks; totals.costMicros += m.costMicros;
          totals.conversions += m.conversions; totals.conversionsValue += m.conversionsValue;
          const info = infoOfCampaign.get(id);
          return { id, name: info?.name || "(sem nome)", status: info?.status || "REMOVED", ...metricsView(m) };
        }).sort((a, b) => b.spend - a.spend);
        return {
          group_id: bucket.group_id || null,
          name: bucket.name,
          status: bucket.status || null,
          campaigns_count: campaignsOut.length,
          enabled_campaigns: campaignsOut.filter((c) => c.status === "ENABLED").length,
          ...metricsView(totals),
          ...(includeCampaigns === false ? {} : { campaigns: campaignsOut }),
        };
      }).filter((row) => row.group_id !== null || row.campaigns_count > 0);

      if (format === "table" || format === "csv") {
        const flat = results.map(({ campaigns: _campaigns, ...row }) => row as Record<string, unknown>);
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }
      const activeGroups = results.filter((r) => r.group_id !== null && r.status === "ENABLED").length;
      const inactiveGroups = results.filter((r) => r.group_id !== null && r.status !== "ENABLED").length;
      const totalSpendMicros = [...metricsByCampaign.values()].reduce((sum, m) => sum + m.costMicros, 0);
      const header = groupRef
        ? `Grupo de campanhas ${groupRef.id} ("${groups[0].name}", ${groups[0].status}).`
        : `${activeGroups} grupo(s) de campanhas ativo(s)` +
          (inactiveGroups ? `, mais ${inactiveGroups} grupo(s) removido(s) ou não encontrado(s) que ainda têm campanhas (somados à parte)` : "") +
          `. Gasto total no período (todos os baldes somados): ${money(totalSpendMicros)}.`;
      return {
        content: [text(`${header}\n\n${formatJson(results)}`)],
      };
    }
  );

  mcp.registerTool(
    "create_campaign_group",
    {
      description: [
        "Cria um grupo de campanhas (campaign_group) para relatório por linha de produto / etapa de funil e,",
        "opcionalmente, já coloca campanhas nele (googleAds:mutate atômico com ID temporário).",
        "WRITE OPERATION. Campanha com orçamento compartilhado não pode ficar em grupo (regra da API) — é recusada",
        "antes de gravar. Campanha que estava em outro grupo muda de grupo (o antes/depois aparece no resultado).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do grupo (único entre os grupos ativos, sem quebra de linha)."),
        campaignIds: flexArray(z.string()).optional().describe("Campanhas para colocar no grupo."),
      },
    },
    async ({ customerId, name, campaignIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi criado.`);
      const badName = nameError("name", name);
      if (badName) return fail(`${badName} Nada foi criado.`);
      let ids: string[] = [];
      if (campaignIds !== undefined && ensureArray(campaignIds).length > 0) {
        const parsed = parseIdList(campaignIds, "campaignId");
        if ("error" in parsed) return fail(`${parsed.error} Nada foi criado.`);
        ids = parsed.ids;
      }
      const groupName = name.trim();
      const client = ctx.getClient();
      const duplicate = await fetchGroups(client, cid, [`campaign_group.name = '${gaqlLiteral(groupName)}'`, "campaign_group.status = 'ENABLED'"]);
      if (duplicate.length) return fail(`Já existe grupo chamado "${groupName}" (ID ${duplicate[0].id}). Use assign_campaign_group. Nada foi criado.`);

      const campaigns: CampaignInfo[] = [];
      if (ids.length) {
        const found = await fetchCampaigns(client, cid, [`campaign.id IN (${ids.join(", ")})`], true);
        const problems: string[] = [];
        for (const id of ids) {
          const campaign = found.find((c) => c.id === id);
          const reason = !campaign ? "não encontrada na conta" : groupRefusal(campaign);
          if (reason) problems.push(`${campaign ? campaignLabel(campaign) : id}: ${reason}`);
          else campaigns.push(campaign!);
        }
        if (problems.length) return fail(`Nada foi criado — campanha(s) que não podem entrar no grupo:\n- ${problems.join("\n- ")}`);
      }
      const dryRun = client.isDryRun;
      let resourceName = "";
      try {
        if (campaigns.length) {
          const temp = `customers/${cid}/campaignGroups/-1`;
          const response = await client.batchMutate(customerId, [
            { campaignGroupOperation: { create: { resourceName: temp, name: groupName, status: "ENABLED" } } },
            ...campaigns.map((c) => ({
              campaignOperation: {
                update: { resourceName: c.resourceName || `customers/${cid}/campaigns/${c.id}`, campaignGroup: temp },
                updateMask: "campaign_group",
              },
            })),
          ]);
          const responses = (response.mutateOperationResponses as Row[] | undefined) ?? [];
          resourceName = str(obj(responses.find((r) => r.campaignGroupResult)?.campaignGroupResult).resourceName);
        } else {
          const response = await client.mutate(customerId, "campaignGroups", [{ create: { name: groupName, status: "ENABLED" } }]);
          resourceName = str(obj(((response.results as Row[] | undefined) ?? [])[0]).resourceName);
        }
      } catch (err) {
        return fail(`Nada foi criado${campaigns.length ? " (grupo e campanhas vão na mesma operação atômica)" : ""}.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      if (!dryRun && !resourceName) return fail("A API não confirmou a criação do grupo — confira com get_campaign_group_performance antes de repetir.");
      return {
        content: [text(
          (dryRun ? "DRY-RUN (validateOnly): validado, nada foi gravado." : `Grupo de campanhas criado: ${resourceName}.`) +
          `\n\n${formatJson({
            name: groupName,
            resource_name: resourceName || null,
            campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, previous_group: c.group || null })),
          })}`
        )],
      };
    }
  );

  mcp.registerTool(
    "update_campaign_group",
    {
      description: "Renomeia um grupo de campanhas. WRITE OPERATION. Sem mudança (mesmo nome) não grava nada.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignGroupId: z.string().describe("Grupo (ID numérico ou resource name)."),
        name: z.string().describe("Novo nome (único entre os grupos ativos, sem quebra de linha)."),
      },
    },
    async ({ customerId, campaignGroupId, name }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const ref = parseResourceRef("campaignGroups", campaignGroupId, cid);
      if ("error" in ref) return fail(`${ref.error} Nada foi alterado.`);
      const badName = nameError("name", name);
      if (badName) return fail(`${badName} Nada foi alterado.`);
      const newName = name.trim();
      const client = ctx.getClient();
      const group = (await fetchGroups(client, cid, [`campaign_group.id = ${ref.id}`]))[0];
      if (!group) return fail(`Grupo de campanhas ${ref.id} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (group.status === "REMOVED") return fail(`Grupo de campanhas ${ref.id} está removido. Nada foi alterado.`);
      if (group.name === newName) return { content: [text(`Grupo ${ref.id} já se chama "${newName}". Nenhuma escrita foi enviada.`)] };
      const duplicate = await fetchGroups(client, cid, [`campaign_group.name = '${gaqlLiteral(newName)}'`, "campaign_group.status = 'ENABLED'"]);
      if (duplicate.some((g) => g.id !== ref.id)) return fail(`Já existe grupo chamado "${newName}". Nada foi alterado.`);
      const dryRun = client.isDryRun;
      try {
        await client.mutate(customerId, "campaignGroups", [{ update: { resourceName: group.resourceName || ref.resourceName, name: newName }, updateMask: "name" }]);
      } catch (err) {
        return fail(`Grupo ${ref.id}: a API não aceitou.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      return {
        content: [text(
          (dryRun ? `Grupo ${ref.id} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `Grupo ${ref.id} renomeado.`) +
          `\n\n${formatJson({ before: group.name, after: newName, update_mask: ["name"] })}`
        )],
      };
    }
  );

  mcp.registerTool(
    "remove_campaign_group",
    {
      description: [
        "Remove um grupo de campanhas VAZIO. WRITE OPERATION — exige confirm: true.",
        "Se ainda houver campanhas no grupo, recusa e lista quais: tire antes com assign_campaign_group",
        "(campaignGroupId null). Remover o grupo não mexe em campanha nenhuma.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignGroupId: z.string().describe("Grupo (ID numérico ou resource name)."),
        confirm: z.boolean().describe("Precisa ser true."),
      },
    },
    async ({ customerId, campaignGroupId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      const ref = parseResourceRef("campaignGroups", campaignGroupId, cid);
      if ("error" in ref) return fail(`${ref.error} Nada foi removido.`);
      if (!confirm) return fail("Remover o grupo é irreversível. Repita com confirm: true. Nada foi removido.");
      const client = ctx.getClient();
      const group = (await fetchGroups(client, cid, [`campaign_group.id = ${ref.id}`]))[0];
      if (!group) return fail(`Grupo de campanhas ${ref.id} não encontrado na conta ${cid}. Nada foi removido.`);
      if (group.status === "REMOVED") return { content: [text(`Grupo ${ref.id} já está removido. Nenhuma escrita foi enviada.`)] };
      const inGroup = await fetchCampaigns(client, cid, [`campaign.campaign_group = '${gaqlLiteral(group.resourceName || ref.resourceName)}'`, "campaign.status != 'REMOVED'"]);
      if (inGroup.length) {
        return fail(
          `Grupo ${ref.id} ("${group.name}") ainda tem ${inGroup.length} campanha(s). Tire-as com assign_campaign_group ` +
          `(campaignGroupId null) antes de remover. Nada foi removido.\n\n${formatJson(inGroup.map((c) => ({ id: c.id, name: c.name, status: c.status })))}`
        );
      }
      const dryRun = client.isDryRun;
      try {
        await client.mutate(customerId, "campaignGroups", [{ remove: group.resourceName || ref.resourceName }]);
      } catch (err) {
        return fail(`Grupo ${ref.id}: a API não aceitou a remoção.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      return {
        content: [text(dryRun ? `Grupo ${ref.id} — DRY-RUN (validateOnly): validado, nada foi removido.` : `Grupo ${ref.id} ("${group.name}") removido.`)],
      };
    }
  );

  mcp.registerTool(
    "assign_campaign_group",
    {
      description: [
        "Coloca campanhas num grupo de campanhas, ou tira do grupo (campaignGroupId null).",
        "WRITE OPERATION — só mexe em campaign.campaign_group; cada campanha é relatada à parte (partialFailure).",
        "Campanha que já está no grupo pedido é pulada. Campanha com orçamento compartilhado não pode entrar em",
        "grupo (regra da API) e é recusada antes de gravar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignIds: flexArray(z.string()).describe("Campanhas."),
        campaignGroupId: z.string().nullable().describe("Grupo de destino (ID ou resource name); null = tirar do grupo."),
      },
    },
    async ({ customerId, campaignIds, campaignGroupId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      const parsedIds = parseIdList(campaignIds, "campaignId");
      if ("error" in parsedIds) return fail(`${parsedIds.error} Nada foi alterado.`);
      const unassign = campaignGroupId === null || String(campaignGroupId).trim() === "";
      let ref: { id: string; resourceName: string } | undefined;
      if (!unassign) {
        const parsed = parseResourceRef("campaignGroups", String(campaignGroupId), cid);
        if ("error" in parsed) return fail(`${parsed.error} Nada foi alterado.`);
        ref = parsed;
      }
      const client = ctx.getClient();
      let groupName = "";
      if (ref) {
        const group = (await fetchGroups(client, cid, [`campaign_group.id = ${ref.id}`]))[0];
        if (!group) return fail(`Grupo de campanhas ${ref.id} não encontrado na conta ${cid}. Nada foi alterado.`);
        if (group.status !== "ENABLED") return fail(`Grupo de campanhas ${ref.id} está ${group.status}. Nada foi alterado.`);
        groupName = group.name;
        ref = { id: ref.id, resourceName: group.resourceName || ref.resourceName };
      }
      const found = await fetchCampaigns(client, cid, [`campaign.id IN (${parsedIds.ids.join(", ")})`], true);
      const toChange: CampaignInfo[] = [];
      const skipped: Array<Record<string, unknown>> = [];
      const refused: Array<Record<string, unknown>> = [];
      for (const id of parsedIds.ids) {
        const campaign = found.find((c) => c.id === id);
        if (!campaign) { refused.push({ campaign_id: id, reason: "não encontrada na conta" }); continue; }
        const target = ref?.resourceName ?? "";
        if (campaign.group === target) {
          skipped.push({ campaign_id: id, name: campaign.name, reason: unassign ? "já está sem grupo" : "já está neste grupo" });
          continue;
        }
        const reason = campaign.status === "REMOVED" ? "campanha removida" : unassign ? null : groupRefusal(campaign);
        if (reason) { refused.push({ campaign_id: id, name: campaign.name, reason }); continue; }
        toChange.push(campaign);
      }
      if (toChange.length === 0) {
        return {
          content: [text(`Nada a gravar.\n\n${formatJson({ skipped, refused })}`)],
          isError: refused.length > 0,
        };
      }
      const operations: MutateOperation[] = toChange.map((c) => ({
        // Sem valor + campo na máscara = limpa o campo (tira do grupo)
        update: { resourceName: c.resourceName || `customers/${cid}/campaigns/${c.id}`, ...(ref ? { campaignGroup: ref.resourceName } : {}) },
        updateMask: "campaign_group",
      }));
      const dryRun = client.isDryRun;
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaigns", operations, { partialFailure: true });
      } catch (err) {
        return fail(`Nada foi alterado.\nErro: ${explainBudgetError((err as Error).message)}`);
      }
      const outcome = perItemOutcome(response, toChange, dryRun);
      const changed = outcome.ok.map((c) => ({ campaign_id: c.id, name: c.name, before: c.group || null, after: ref?.resourceName ?? null }));
      const errors = [
        ...outcome.errors.map((e) => ({ campaign_id: e.item.id, error: e.error })),
        ...outcome.unattributed.map((error) => ({ error })),
      ];
      const destination = ref ? `grupo ${ref.id} ("${groupName}")` : "sem grupo";
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): nada foi gravado. Validadas: ${changed.length}` : `${changed.length} campanha(s) → ${destination}`) +
          ` | Puladas: ${skipped.length} | Recusadas: ${refused.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "changed"]: changed, skipped, refused, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );
}

// ── Regras de elegibilidade (compartilhadas pelas tools de escrita) ──

/**
 * Por que a campanha não pode passar a usar o orçamento `target` (null = pode).
 * Precisa de campaign.budgetInfo (query com os campos de campaign_budget).
 */
function assignRefusal(
  campaign: CampaignInfo,
  experiments: Map<string, { experiment: string; status: string }>,
  target: Pick<BudgetInfo, "period" | "type" | "explicitlyShared" | "alignedBiddingStrategyId">,
  cid: string
): string | null {
  if (campaign.status === "REMOVED") return "campanha removida";
  if (campaign.experimentType !== "BASE") return `campanha de ${campaign.experimentType === "EXPERIMENT" ? "experimento" : "rascunho"} — o orçamento segue o da campanha base`;
  const experiment = experiments.get(campaign.resourceName) ?? experiments.get(`customers/${cid}/campaigns/${campaign.id}`);
  if (experiment && BLOCKING_EXPERIMENT_STATUSES.has(experiment.status)) {
    return `experimento "${experiment.experiment}" (${experiment.status}) — a API não troca orçamento de campanha com experimento rodando ou agendado`;
  }
  if (experiment && target.explicitlyShared) {
    return `experimento "${experiment.experiment}" (${experiment.status}) — campanha com experimento precisa de orçamento próprio, não compartilhado`;
  }
  const current = campaign.budgetInfo;
  const currentPeriod = current?.period ?? "UNSPECIFIED";
  const normalizedPeriod = (p: string) => (p === "CUSTOM_PERIOD" ? "CUSTOM_PERIOD" : "DAILY");
  if (normalizedPeriod(currentPeriod) !== normalizedPeriod(target.period)) {
    return `período do orçamento atual (${currentPeriod}) diferente do destino (${target.period}) — não muda depois de criada a campanha`;
  }
  const currentType = current?.type && current.type !== "UNSPECIFIED" ? current.type : "STANDARD";
  const targetType = target.type && target.type !== "UNSPECIFIED" ? target.type : "STANDARD";
  if (currentType !== targetType) return `tipo de orçamento atual (${currentType}) diferente do destino (${targetType})`;
  if (target.explicitlyShared && campaign.group) {
    return "campanha em grupo de campanhas não pode usar orçamento compartilhado — tire do grupo com assign_campaign_group (campaignGroupId null)";
  }
  if (target.alignedBiddingStrategyId) {
    const expected = `customers/${cid}/biddingStrategies/${target.alignedBiddingStrategyId}`;
    if (campaign.biddingStrategy !== expected) {
      return `o orçamento está alinhado à estratégia de portfólio ${target.alignedBiddingStrategyId}; a campanha precisa usá-la`;
    }
  }
  return null;
}

/** Por que a campanha não pode entrar num grupo de campanhas (null = pode). */
function groupRefusal(campaign: CampaignInfo): string | null {
  if (campaign.status === "REMOVED") return "campanha removida";
  if (campaign.budgetInfo?.explicitlyShared) {
    return `usa o orçamento compartilhado ${campaign.budgetInfo.id} — campanha em grupo não pode usar orçamento compartilhado (mova para um orçamento próprio antes)`;
  }
  return null;
}
