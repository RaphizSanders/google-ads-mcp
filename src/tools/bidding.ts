/**
 * Lote bidding: estratégias de lance (portfólio e de MCC), simulações de lance, ajustes de
 * sazonalidade, exclusões de dados, alvos por grupo de anúncios e as regras de orçamento
 * total / datas de campanha que create_campaign e update_campaign (src/tools.ts) usam.
 *
 * Fonte de verdade: protos oficiais da v25 (resources/campaign_simulation, ad_group_simulation,
 * ad_group_criterion_simulation, bidding_strategy_simulation, common/simulation,
 * bidding_seasonality_adjustment, bidding_data_exclusion, bidding_strategy,
 * accessible_bidding_strategy, campaign_budget, campaign, ad_group) e as páginas de docs
 * citadas em docs/batches/bidding.md. Toda query daqui é validada nos testes contra os
 * metadados reais da v25 (tests/gaql-validator.ts).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  checkCustomerAccess,
  ensureArray,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  isPositiveMicros,
  money,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const DAY_MS = 86_400_000;
const NUMERIC_ID = /^\d+$/;

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const reply = (message: string, isError = false): ToolResult =>
  isError ? { content: [text(message)], isError: true } : { content: [text(message)] };

function obj(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function list<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function lastSegment(resourceName: unknown): string {
  return String(resourceName ?? "").split("/").pop() ?? "";
}

/** IDs de uma lista (array ou JSON), sem espaços nem repetidos. */
function idList(value: unknown): string[] {
  return [...new Set(ensureArray<unknown>(value).map((id) => String(id).trim()).filter(Boolean))];
}

/** Valor opcional de enum em lista, em maiúsculas e sem repetidos. */
function enumList(value: unknown): string[] {
  return [...new Set(ensureArray<unknown>(value).map((v) => String(v).trim().toUpperCase()).filter(Boolean))];
}

function tabular(rows: Row[], format: string | undefined, header: string, payload: unknown): ToolResult {
  if (format === "table") return reply(`${header}\n\n${formatAsTable(rows)}`);
  if (format === "csv") return reply(formatAsCsv(rows));
  return reply(`${header}\n\n${formatJson(payload)}`);
}

function customerIdOf(customerId: string): string | null {
  const cid = customerId.replace(/-/g, "");
  return NUMERIC_ID.test(cid) ? cid : null;
}

// ── Datas no fuso da conta ────────────────────────────────────────────

const DATE_TIME_INPUT = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Como tratar uma entrada só com a data:
 * - startOfDay: 00:00:00 (início de campanha / de janela)
 * - endOfDay: 23:59:59 (fim de campanha — o proto manda usar 23:59:59 para granularidade diária)
 * - nextDayStart: dia seguinte 00:00:00 (fim EXCLUSIVO de sazonalidade / exclusão de dados)
 */
export type DateOnlyAs = "startOfDay" | "endOfDay" | "nextDayStart";

function isoDayUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Aceita YYYY-MM-DD, YYYY-MM-DD HH:mm ou YYYY-MM-DD HH:mm:ss e devolve "yyyy-MM-dd HH:mm:ss". */
export function parseAdsDateTime(input: string, dateOnlyAs: DateOnlyAs): { value: string; dateOnly: boolean } | { error: string } {
  const raw = String(input ?? "").trim();
  const match = DATE_TIME_INPUT.exec(raw);
  if (!match) {
    return { error: `"${input}" não é data válida — use YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss (fuso da conta).` };
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { error: `"${input}" não é uma data de calendário válida.` };
  }
  if (match[4] === undefined) {
    if (dateOnlyAs === "nextDayStart") {
      return { value: `${isoDayUtc(new Date(probe.getTime() + DAY_MS))} 00:00:00`, dateOnly: true };
    }
    return { value: `${match[1]}-${match[2]}-${match[3]} ${dateOnlyAs === "endOfDay" ? "23:59:59" : "00:00:00"}`, dateOnly: true };
  }
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? "0")];
  if (hour > 23 || minute > 59 || second > 59) {
    return { error: `"${input}" tem horário inválido (use HH:mm:ss entre 00:00:00 e 23:59:59).` };
  }
  return {
    value: `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${String(second).padStart(2, "0")}`,
    dateOnly: false,
  };
}

/** "yyyy-MM-dd HH:mm:ss" (ou só a data) → ms, lendo o horário como ingênuo (sem fuso). */
export function dateTimeMs(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(String(value ?? "").trim());
  if (!match) return NaN;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)
  );
}

/**
 * Data de campanha "no passado" para create_campaign / update_campaign: só o DIA conta.
 * campaign.proto (start_date_time) manda usar 00:00:00 para granularidade diária — e só
 * alguns tipos de campanha aceitam horário —, então "hoje 00:00:00" é o jeito de dizer
 * "começa hoje" e não pode ser recusado por já ter passado da meia-noite. Dia anterior a
 * hoje (no fuso da conta) é recusado antes da API; horário explícito no próprio dia de
 * hoje fica com a API, que tem o relógio de referência e sabe se o tipo aceita horário.
 */
export function beforeAccountToday(value: string, now: string): boolean {
  return value.slice(0, 10) < now.slice(0, 10);
}

/** Relógio da conta: agora no fuso dela, em "yyyy-MM-dd HH:mm:ss". */
export function clockIn(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return at.toISOString().slice(0, 19).replace("T", " ");
  }
}

export interface AccountInfo {
  timeZone: string;
  manager: boolean;
  now: string;
  currency: string;
}

/** Fuso, moeda e se é MCC — as datas de lance/campanha são sempre no fuso da conta. */
export async function readAccountInfo(client: GoogleAdsClient, customerId: string): Promise<AccountInfo> {
  const row = await client.getCustomer(customerId);
  const customer = obj(obj(row).customer);
  const timeZone = String(customer.timeZone ?? "") || "America/Sao_Paulo";
  return {
    timeZone,
    manager: customer.manager === true,
    now: clockIn(timeZone),
    currency: String(customer.currencyCode ?? ""),
  };
}

// ── Orçamento total (CUSTOM_PERIOD) e datas de campanha ──────────────

/**
 * Onde o orçamento total da campanha vale e com quais estratégias (docs "Campaign budgets
 * overview", set/2026), e a duração permitida (Ajuda do Google Ads 15137812: Pesquisa,
 * Shopping e PMax de 3 a 90 dias; Demand Gen de 7 dias a 1 ano). A API recusa duração
 * longa demais com DURATION_TOO_LONG_FOR_TOTAL_BUDGET e orçamento total sem fim com
 * END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET (errors/campaign_error.proto).
 */
export const TOTAL_BUDGET_RULES: Record<string, { strategies: string[]; minDays: number; maxDays: number }> = {
  SEARCH: {
    strategies: ["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "MAXIMIZE_CONVERSIONS", "TARGET_SPEND", "TARGET_IMPRESSION_SHARE", "MANUAL_CPC"],
    minDays: 3,
    maxDays: 90,
  },
  SHOPPING: { strategies: ["TARGET_ROAS", "TARGET_SPEND", "MANUAL_CPC"], minDays: 3, maxDays: 90 },
  PERFORMANCE_MAX: {
    strategies: ["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "MAXIMIZE_CONVERSIONS"],
    minDays: 3,
    maxDays: 90,
  },
  DEMAND_GEN: {
    strategies: ["MAXIMIZE_CONVERSIONS", "TARGET_CPA", "MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS", "TARGET_SPEND", "MANUAL_CPC"],
    minDays: 7,
    maxDays: 366,
  },
};

/** Duração em dias de uma campanha entre início e fim (fim inclusivo, ex.: 23:59:59). */
export function flightDays(start: string, end: string): number {
  return (dateTimeMs(end) - dateTimeMs(start) + 1000) / DAY_MS;
}

/** Regras de orçamento total: canal, estratégia e duração. */
export function checkTotalBudgetFlight(
  channel: string,
  strategy: string | undefined,
  start: string | undefined,
  end: string | undefined
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rules = TOTAL_BUDGET_RULES[channel];
  if (!rules) {
    errors.push(`orçamento total (CUSTOM_PERIOD) não existe para campanhas ${channel} — só ${Object.keys(TOTAL_BUDGET_RULES).join(", ")}`);
    return { errors, warnings };
  }
  if (strategy && !rules.strategies.includes(strategy)) {
    errors.push(`com orçamento total, campanhas ${channel} aceitam só ${rules.strategies.join(", ")} (recebido ${strategy})`);
  }
  if (!start || !end) {
    errors.push("orçamento total exige startDateTime E endDateTime (a API recusa sem fim: END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET)");
    return { errors, warnings };
  }
  const days = flightDays(start, end);
  if (days > rules.maxDays) {
    errors.push(`duração de ${round2(days)} dias passa do máximo de ${rules.maxDays} para orçamento total em ${channel} (DURATION_TOO_LONG_FOR_TOTAL_BUDGET)`);
  } else if (days < rules.minDays) {
    warnings.push(`duração de ${round2(days)} dias abaixo do mínimo documentado de ${rules.minDays} dias para orçamento total em ${channel} — a API pode recusar`);
  }
  return { errors, warnings };
}

// ── Simulações de lance ───────────────────────────────────────────────

const SIMULATION_TYPES = ["CPC_BID", "TARGET_CPA", "TARGET_ROAS", "TARGET_IMPRESSION_SHARE", "BUDGET", "CPV_BID", "PERCENT_CPC_BID"] as const;
type SimulationType = (typeof SIMULATION_TYPES)[number];
const SIMULATION_LEVELS_LIST = ["CAMPAIGN", "AD_GROUP", "KEYWORD", "PORTFOLIO"] as const;
type SimulationLevel = (typeof SIMULATION_LEVELS_LIST)[number];

/** Campo da lista de pontos por tipo (oneof point_list nos protos *_simulation). */
const POINT_LISTS: Record<SimulationType, { field: string; json: string }> = {
  CPC_BID: { field: "cpc_bid_point_list", json: "cpcBidPointList" },
  CPV_BID: { field: "cpv_bid_point_list", json: "cpvBidPointList" },
  TARGET_CPA: { field: "target_cpa_point_list", json: "targetCpaPointList" },
  TARGET_ROAS: { field: "target_roas_point_list", json: "targetRoasPointList" },
  TARGET_IMPRESSION_SHARE: { field: "target_impression_share_point_list", json: "targetImpressionSharePointList" },
  BUDGET: { field: "budget_point_list", json: "budgetPointList" },
  PERCENT_CPC_BID: { field: "percent_cpc_bid_point_list", json: "percentCpcBidPointList" },
};

/** Recurso e tipos por nível (combinações listadas no comentário de cada proto *_simulation). */
const SIMULATION_LEVELS: Record<SimulationLevel, { resource: string; json: string; types: SimulationType[] }> = {
  CAMPAIGN: { resource: "campaign_simulation", json: "campaignSimulation", types: ["CPC_BID", "TARGET_CPA", "TARGET_ROAS", "TARGET_IMPRESSION_SHARE", "BUDGET"] },
  AD_GROUP: { resource: "ad_group_simulation", json: "adGroupSimulation", types: ["CPC_BID", "CPV_BID", "TARGET_CPA", "TARGET_ROAS"] },
  KEYWORD: { resource: "ad_group_criterion_simulation", json: "adGroupCriterionSimulation", types: ["CPC_BID", "PERCENT_CPC_BID"] },
  PORTFOLIO: { resource: "bidding_strategy_simulation", json: "biddingStrategySimulation", types: ["TARGET_CPA", "TARGET_ROAS"] },
};

interface PointKey {
  /** Parâmetro da tool de escrita que recebe o valor (null quando é modificador de escala). */
  param: string | null;
  value: number;
  label: string;
  scaling: boolean;
}

function pointKey(type: SimulationType, point: Row): PointKey {
  const scaled = (modifier: unknown): PointKey => ({
    param: null, value: Number(modifier), label: `${round2(Number(modifier))}x o valor atual`, scaling: true,
  });
  switch (type) {
    case "CPC_BID":
      return point.cpcBidMicros !== undefined
        ? { param: "cpcBidMicros", value: num(point.cpcBidMicros), label: money(point.cpcBidMicros), scaling: false }
        : scaled(point.cpcBidScalingModifier);
    case "CPV_BID":
      return { param: "cpvBidMicros", value: num(point.cpvBidMicros), label: money(point.cpvBidMicros), scaling: false };
    case "TARGET_CPA":
      return point.targetCpaMicros !== undefined
        ? { param: "targetCpaMicros", value: num(point.targetCpaMicros), label: money(point.targetCpaMicros), scaling: false }
        : scaled(point.targetCpaScalingModifier);
    case "TARGET_ROAS": {
      const roas = Number(point.targetRoas ?? 0);
      return { param: "targetRoas", value: roas, label: `${round2(roas)} (${round2(roas * 100)}%)`, scaling: false };
    }
    case "TARGET_IMPRESSION_SHARE": {
      const micros = num(point.targetImpressionShareMicros);
      return { param: "locationFractionMicros", value: micros, label: `${round2(micros / 10_000)}%`, scaling: false };
    }
    case "BUDGET":
      return { param: "amountMicros", value: num(point.budgetAmountMicros), label: money(point.budgetAmountMicros), scaling: false };
    case "PERCENT_CPC_BID": {
      const micros = num(point.percentCpcBidMicros);
      return { param: "percentCpcBidMicros", value: micros, label: `${round2(micros / 10_000)}%`, scaling: false };
    }
  }
}

/** Valor atual da configuração que a simulação varia, para marcar o ponto de referência. */
function currentSettingFor(level: SimulationLevel, type: SimulationType, entity: Row): number | null {
  const pick = (...values: unknown[]) => {
    for (const value of values) if (value !== undefined && value !== null && num(value) > 0) return num(value);
    return null;
  };
  const campaign = obj(entity.campaign);
  const adGroup = obj(entity.adGroup);
  const criterion = obj(entity.adGroupCriterion);
  const strategy = obj(entity.biddingStrategy);
  if (level === "CAMPAIGN") {
    if (type === "BUDGET") return pick(obj(entity.campaignBudget).amountMicros);
    if (type === "TARGET_CPA") return pick(obj(campaign.targetCpa).targetCpaMicros, obj(campaign.maximizeConversions).targetCpaMicros);
    if (type === "TARGET_ROAS") return pick(obj(campaign.targetRoas).targetRoas, obj(campaign.maximizeConversionValue).targetRoas);
    if (type === "TARGET_IMPRESSION_SHARE") return pick(obj(campaign.targetImpressionShare).locationFractionMicros);
    return null;
  }
  if (level === "AD_GROUP") {
    if (type === "CPC_BID") return pick(adGroup.cpcBidMicros);
    if (type === "CPV_BID") return pick(adGroup.cpvBidMicros);
    if (type === "TARGET_CPA") return pick(adGroup.effectiveTargetCpaMicros);
    if (type === "TARGET_ROAS") return pick(adGroup.effectiveTargetRoas);
    return null;
  }
  if (level === "KEYWORD") {
    if (type === "CPC_BID") return pick(criterion.effectiveCpcBidMicros, criterion.cpcBidMicros);
    if (type === "PERCENT_CPC_BID") return pick(criterion.percentCpcBidMicros);
    return null;
  }
  if (type === "TARGET_CPA") return pick(obj(strategy.targetCpa).targetCpaMicros, obj(strategy.maximizeConversions).targetCpaMicros);
  if (type === "TARGET_ROAS") return pick(obj(strategy.targetRoas).targetRoas, obj(strategy.maximizeConversionValue).targetRoas);
  return null;
}

/**
 * Valor absoluto de um ponto SCALING: o alvo atual × scaling_modifier, arredondado ao
 * centavo (10.000 micros) para não mandar fração de centavo à API.
 */
export function scaledMicros(current: number, modifier: number): number {
  return Math.round((current * modifier) / 10_000) * 10_000;
}

/**
 * SCALING (enums/simulation_modification_method.proto): "the campaign target and all ad group
 * targets were scaled by a factor of X" — os pontos trazem target_cpa_scaling_modifier /
 * cpc_bid_scaling_modifier (common/simulation.proto), nunca um valor absoluto.
 */
function scalingHint(level: SimulationLevel, type: SimulationType, entity: Row, ids: Row, current: number | null): string {
  const campaign = obj(entity.campaign);
  if (type === "CPC_BID") {
    return "Pontos SCALING: scaling_modifier multiplica os lances de CPC atuais de TODOS os grupos e palavras-chave " +
      "(não é um CPC absoluto). Para aplicar um ponto, multiplique o cpcBidMicros de cada grupo/palavra pelo fator " +
      "(update_ad_group / update_keyword).";
  }
  const overrides = "O SCALING multiplica também os CPAs alvo próprios dos grupos (overrides): para reproduzir o ponto, " +
    "multiplique cada override pelo mesmo fator (get_ad_group_bid_targets → update_ad_group targetCpaMicros).";
  if (level === "CAMPAIGN" && typeof campaign.biddingStrategy === "string" && campaign.biddingStrategy) {
    return `Pontos SCALING (multiplicador, não CPA absoluto). A campanha usa portfólio (${campaign.biddingStrategy}): ` +
      "multiplique o CPA alvo do portfólio pelo scaling_modifier em update_bidding_strategy (vale para todas as campanhas " +
      `do portfólio). ${overrides}`;
  }
  if (current === null) {
    return "Pontos SCALING: scaling_modifier multiplica o CPA alvo atual, mas este nível não tem CPA alvo próprio " +
      "definido — não há valor absoluto para aplicar. Defina o CPA alvo primeiro e só então aplique o fator. " + overrides;
  }
  const target = level === "AD_GROUP"
    ? `update_ad_group { adGroupId: "${ids.adGroupId}", targetCpaMicros: <scaled_targetCpaMicros do ponto> }`
    : level === "PORTFOLIO"
      ? `update_bidding_strategy { biddingStrategyId: "${ids.biddingStrategyId}", targetCpaMicros: <scaled_targetCpaMicros do ponto> }`
      : `update_campaign { campaignId: "${ids.campaignId}", targetCpaMicros: <scaled_targetCpaMicros do ponto> }`;
  return `Pontos SCALING: scaling_modifier multiplica o CPA alvo atual (${current} micros = ${money(current)}); ` +
    `scaled_targetCpaMicros = round(${current} × scaling_modifier), ao centavo — ex.: 0.8 → ${scaledMicros(current, 0.8)}. ` +
    `${target}. ${overrides}`;
}

function applyHint(level: SimulationLevel, type: SimulationType, method: string, entity: Row, ids: Row, current: number | null): string {
  const campaign = obj(entity.campaign);
  if (method === "SCALING" && (type === "TARGET_CPA" || type === "CPC_BID")) {
    return scalingHint(level, type, entity, ids, current);
  }
  if (level === "CAMPAIGN") {
    if (typeof campaign.biddingStrategy === "string" && campaign.biddingStrategy && (type === "TARGET_CPA" || type === "TARGET_ROAS")) {
      return `A campanha usa portfólio (${campaign.biddingStrategy}): o alvo muda em update_bidding_strategy (vale para todas as campanhas do portfólio).`;
    }
    if (type === "BUDGET") {
      const budget = obj(entity.campaignBudget);
      return `update_budget { budgetResourceName: "${budget.resourceName ?? "?"}", amountMicros: <amountMicros do ponto> }` +
        (budget.period === "CUSTOM_PERIOD" ? " — atenção: este orçamento é total (CUSTOM_PERIOD), o ponto é diário." : "");
    }
    if (type === "TARGET_CPA") return `update_campaign { campaignId: "${ids.campaignId}", targetCpaMicros: <targetCpaMicros do ponto> }`;
    if (type === "TARGET_ROAS") return `update_campaign { campaignId: "${ids.campaignId}", targetRoas: <targetRoas do ponto> }`;
    if (type === "TARGET_IMPRESSION_SHARE") return `update_campaign { campaignId: "${ids.campaignId}", locationFractionMicros: <locationFractionMicros do ponto> }`;
    return "Simulação de CPC da campanha inteira (lance uniforme ou em escala): aplique nos grupos/palavras com update_ad_group / update_keyword.";
  }
  if (level === "AD_GROUP") {
    if (type === "CPC_BID") return `update_ad_group { adGroupId: "${ids.adGroupId}", cpcBidMicros: <cpcBidMicros do ponto> }`;
    if (type === "TARGET_CPA") return `update_ad_group { adGroupId: "${ids.adGroupId}", targetCpaMicros: <targetCpaMicros do ponto> }`;
    if (type === "TARGET_ROAS") return `update_ad_group { adGroupId: "${ids.adGroupId}", targetRoas: <targetRoas do ponto> }`;
    return "CPV: não há tool de escrita (a API não altera campanhas de vídeo).";
  }
  if (level === "KEYWORD") {
    if (type === "CPC_BID") return `update_keyword { adGroupId: "${ids.adGroupId}", criterionId: <criterion_id>, cpcBidMicros: <cpcBidMicros do ponto> }`;
    return "Percent CPC (Hotel): não há tool de escrita neste servidor.";
  }
  return `update_bidding_strategy { biddingStrategyId: "${ids.biddingStrategyId}", ${type === "TARGET_CPA" ? "targetCpaMicros" : "targetRoas"}: <valor do ponto> }`;
}

function normalizePoints(type: SimulationType, points: Row[], current: number | null) {
  const keyed = points.map((point) => ({ point, key: pointKey(type, point) })).sort((a, b) => a.key.value - b.key.value);
  const scaling = keyed.some((entry) => entry.key.scaling);
  const reference = scaling ? 1 : current;
  let baseline = -1;
  let exact = false;
  if (reference !== null && keyed.length > 0) {
    let best = Infinity;
    keyed.forEach((entry, index) => {
      const distance = Math.abs(entry.key.value - reference);
      if (distance < best) {
        best = distance;
        baseline = index;
      }
    });
    exact = best <= Math.max(1e-9, Math.abs(reference) * 1e-9);
  }
  const metrics = (point: Row) => {
    const cost = num(point.costMicros) / 1_000_000;
    const conversions = num(point.biddableConversions);
    const value = num(point.biddableConversionsValue);
    return { cost, clicks: num(point.clicks), impressions: num(point.impressions), conversions, value };
  };
  const base = baseline >= 0 ? metrics(keyed[baseline].point) : null;
  const rows = keyed.map(({ point, key }, index) => {
    const m = metrics(point);
    const row: Row = { input: key.label };
    if (key.param) row[key.param] = key.value;
    else {
      row.scaling_modifier = key.value;
      // Valor absoluto que reproduz o ponto no alvo desta entidade (alvo atual × fator).
      if (type === "TARGET_CPA" && current !== null && current > 0) row.scaled_targetCpaMicros = scaledMicros(current, key.value);
    }
    row.cost = round2(m.cost);
    row.clicks = m.clicks;
    row.impressions = m.impressions;
    row.conversions = round2(m.conversions);
    row.conversions_value = round2(m.value);
    row.cpa = m.conversions ? round2(m.cost / m.conversions) : null;
    row.roas = m.cost ? round2(m.value / m.cost) : null;
    if (point.topSlotImpressions !== undefined) row.top_slot_impressions = num(point.topSlotImpressions);
    if (point.absoluteTopImpressions !== undefined) row.absolute_top_impressions = num(point.absoluteTopImpressions);
    if (point.views !== undefined) row.views = num(point.views);
    if (point.interactions !== undefined) row.interactions = num(point.interactions);
    if (point.requiredBudgetAmountMicros !== undefined && num(point.requiredBudgetAmountMicros) > 0) {
      row.required_budget = round2(num(point.requiredBudgetAmountMicros) / 1_000_000);
    }
    if (point.requiredCpcBidCeilingMicros !== undefined && num(point.requiredCpcBidCeilingMicros) > 0) {
      row.required_cpc_bid_ceiling = round2(num(point.requiredCpcBidCeilingMicros) / 1_000_000);
    }
    row.current = index === baseline ? (exact ? "atual" : "mais próximo do atual") : "";
    if (base) {
      row.delta_cost = round2(m.cost - base.cost);
      row.delta_clicks = m.clicks - base.clicks;
      row.delta_conversions = round2(m.conversions - base.conversions);
      row.delta_conversions_value = round2(m.value - base.value);
    }
    return row;
  });
  return { rows, baseline: baseline >= 0 ? (exact ? "atual" : "mais próximo do atual") : null };
}

// ── Sazonalidade e exclusão de dados ──────────────────────────────────

type AdjustmentKind = "SEASONALITY" | "DATA_EXCLUSION";

const ADJUSTMENTS: Record<AdjustmentKind, {
  resource: string; json: string; idField: string; idJson: string; service: string; label: string; path: string;
}> = {
  SEASONALITY: {
    resource: "bidding_seasonality_adjustment", json: "biddingSeasonalityAdjustment",
    idField: "seasonality_adjustment_id", idJson: "seasonalityAdjustmentId",
    service: "biddingSeasonalityAdjustments", label: "ajuste de sazonalidade", path: "biddingSeasonalityAdjustments",
  },
  DATA_EXCLUSION: {
    resource: "bidding_data_exclusion", json: "biddingDataExclusion",
    idField: "data_exclusion_id", idJson: "dataExclusionId",
    service: "biddingDataExclusions", label: "exclusão de dados", path: "biddingDataExclusions",
  },
};

/** Canais aceitos no escopo CHANNEL (proto: DISPLAY, SEARCH e SHOPPING). */
const ADJUSTMENT_CHANNELS = ["SEARCH", "SHOPPING", "DISPLAY"];
const ADJUSTMENT_DEVICES = ["MOBILE", "TABLET", "DESKTOP"];
/** Intervalo [start, end) precisa estar em (0, 14 dias] (proto). */
const ADJUSTMENT_MAX_DAYS = 14;
const MAX_CAMPAIGNS_PER_ADJUSTMENT = 2000;
/** Limite de exclusões de dados ativas por conta (proto BiddingDataExclusion). */
const MAX_ACTIVE_DATA_EXCLUSIONS = 500;
/** Estratégias Smart Bidding — as únicas afetadas por sazonalidade/exclusão. */
const SMART_BIDDING = new Set(["TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]);

interface Adjustment {
  kind: AdjustmentKind;
  id: string;
  resource_name: string;
  name: string;
  description: string;
  scope: string;
  status: string;
  start: string;
  end: string;
  conversion_rate_modifier?: number;
  devices: string[];
  campaign_ids: string[];
  channels: string[];
}

function adjustmentFields(kind: AdjustmentKind): string {
  const { resource, idField } = ADJUSTMENTS[kind];
  const fields = [
    "resource_name", idField, "name", "description", "scope", "status", "start_date_time", "end_date_time",
    "devices", "campaigns", "advertising_channel_types",
    ...(kind === "SEASONALITY" ? ["conversion_rate_modifier"] : []),
  ];
  return fields.map((field) => `${resource}.${field}`).join(", ");
}

function normalizeAdjustment(kind: AdjustmentKind, row: Row): Adjustment {
  const spec = ADJUSTMENTS[kind];
  const a = obj(row[spec.json]);
  return {
    kind,
    id: String(a[spec.idJson] ?? lastSegment(a.resourceName)),
    resource_name: String(a.resourceName ?? ""),
    name: String(a.name ?? ""),
    description: String(a.description ?? ""),
    scope: String(a.scope ?? ""),
    status: String(a.status ?? ""),
    start: String(a.startDateTime ?? ""),
    end: String(a.endDateTime ?? ""),
    ...(kind === "SEASONALITY"
      ? { conversion_rate_modifier: a.conversionRateModifier !== undefined ? Number(a.conversionRateModifier) : 1 }
      : {}),
    devices: list<string>(a.devices).map(String),
    campaign_ids: list<string>(a.campaigns).map(lastSegment),
    channels: list<string>(a.advertisingChannelTypes).map(String),
  };
}

async function fetchAdjustments(
  client: GoogleAdsClient, customerId: string, kind: AdjustmentKind, where: string[] = []
): Promise<Adjustment[]> {
  const { resource } = ADJUSTMENTS[kind];
  const rows = await client.searchStream(customerId,
    `SELECT ${adjustmentFields(kind)}
     FROM ${resource}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${resource}.start_date_time DESC`);
  return rows.map((row) => normalizeAdjustment(kind, row));
}

function timingOf(start: string, end: string, now: string): "UPCOMING" | "ACTIVE" | "PAST" {
  const nowMs = dateTimeMs(now);
  if (dateTimeMs(start) > nowMs) return "UPCOMING";
  if (dateTimeMs(end) <= nowMs) return "PAST";
  return "ACTIVE";
}

interface AdjustmentDraft {
  name: string;
  description?: string;
  scope: string;
  campaignIds: string[];
  channels: string[];
  devices: string[];
  start: string;
  end: string;
  modifier?: number;
}

/** Regras do proto e das docs que não dependem do relógio da conta. */
function draftShapeErrors(kind: AdjustmentKind, draft: AdjustmentDraft): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (!name) errors.push("name é obrigatório (nome único por conta)");
  if (name.length > 255) errors.push(`name tem ${name.length} caracteres (máximo 255)`);
  if ((draft.description ?? "").length > 2048) errors.push("description passa de 2048 caracteres");
  if (draft.scope === "CAMPAIGN") {
    if (draft.campaignIds.length === 0) errors.push("scope CAMPAIGN exige campaignIds");
    if (draft.campaignIds.length > MAX_CAMPAIGNS_PER_ADJUSTMENT) errors.push(`no máximo ${MAX_CAMPAIGNS_PER_ADJUSTMENT} campanhas por ${ADJUSTMENTS[kind].label}`);
    if (draft.channels.length > 0) errors.push("scope CAMPAIGN não aceita channels (a API não aceita campanhas e canais juntos)");
  } else if (draft.scope === "CHANNEL") {
    if (draft.channels.length === 0) errors.push(`scope CHANNEL exige channels (${ADJUSTMENT_CHANNELS.join(", ")})`);
    if (draft.campaignIds.length > 0) errors.push("scope CHANNEL não aceita campaignIds (a API não aceita campanhas e canais juntos)");
  } else {
    errors.push(`scope inválido: ${draft.scope} (use CAMPAIGN ou CHANNEL; CUSTOMER é só leitura)`);
  }
  const badIds = draft.campaignIds.filter((id) => !NUMERIC_ID.test(id));
  if (badIds.length) errors.push(`campaignIds devem ser numéricos: ${badIds.join(", ")}`);
  const badChannels = draft.channels.filter((channel) => !ADJUSTMENT_CHANNELS.includes(channel));
  if (badChannels.length) errors.push(`channels inválidos: ${badChannels.join(", ")} (aceitos: ${ADJUSTMENT_CHANNELS.join(", ")})`);
  const badDevices = draft.devices.filter((device) => !ADJUSTMENT_DEVICES.includes(device));
  if (badDevices.length) errors.push(`devices inválidos: ${badDevices.join(", ")} (aceitos: ${ADJUSTMENT_DEVICES.join(", ")}; vazio = todos)`);
  const span = dateTimeMs(draft.end) - dateTimeMs(draft.start);
  if (!(span > 0)) errors.push(`endDateTime (${draft.end}) precisa ser depois de startDateTime (${draft.start})`);
  else if (span > ADJUSTMENT_MAX_DAYS * DAY_MS) {
    errors.push(`janela de ${round2(span / DAY_MS)} dias: a API aceita no máximo ${ADJUSTMENT_MAX_DAYS} dias por ${ADJUSTMENTS[kind].label}`);
  }
  if (kind === "SEASONALITY") {
    const modifier = draft.modifier;
    if (modifier === undefined || !Number.isFinite(modifier)) errors.push("conversionRateModifier é obrigatório (0.1 a 10.0)");
    else if (modifier < 0.1 || modifier > 10) errors.push(`conversionRateModifier deve ficar entre 0.1 e 10.0 (recebido ${modifier})`);
    else if (modifier === 1) errors.push("conversionRateModifier 1.0 não ajusta nada");
  }
  return errors;
}

/** Regras que dependem do relógio da conta (sazonalidade olha para frente; exclusão, para trás). */
function draftTimingErrors(kind: AdjustmentKind, draft: AdjustmentDraft, now: string, startChanged: boolean): string[] {
  const errors: string[] = [];
  const nowMs = dateTimeMs(now);
  if (kind === "SEASONALITY") {
    if (startChanged && dateTimeMs(draft.start) < nowMs) {
      errors.push(`startDateTime ${draft.start} já passou (agora na conta: ${now}). Sazonalidade é para eventos futuros — para dados passados use create_data_exclusion.`);
    }
    if (dateTimeMs(draft.end) <= nowMs) errors.push(`endDateTime ${draft.end} já passou (agora na conta: ${now}).`);
  } else if (dateTimeMs(draft.start) > nowMs) {
    errors.push(`startDateTime ${draft.start} está no futuro (agora na conta: ${now}). Exclusão de dados começa no passado — para eventos futuros use create_seasonality_adjustment.`);
  }
  return errors;
}

function draftWarnings(kind: AdjustmentKind, draft: AdjustmentDraft, now: string): string[] {
  const warnings: string[] = [];
  const days = (dateTimeMs(draft.end) - dateTimeMs(draft.start)) / DAY_MS;
  if (kind === "SEASONALITY") {
    if (days > 7) warnings.push(`Janela de ${round2(days)} dias: o Google recomenda 1 a 7 dias; em períodos longos o ajuste funciona pior.`);
    if (draft.modifier !== undefined && (draft.modifier >= 2 || draft.modifier <= 0.5)) {
      warnings.push(`Modificador ${draft.modifier}: o Smart Bidding vai supor taxa de conversão ${round2(draft.modifier * 100)}% da normal — ajuste agressivo, confira antes do evento.`);
    }
  } else if (dateTimeMs(draft.end) > dateTimeMs(now)) {
    warnings.push(`O fim (${draft.end}) está no futuro: as conversões até lá também serão ignoradas pelo Smart Bidding.`);
  }
  return warnings;
}

function overlaps(draft: AdjustmentDraft, other: Adjustment): boolean {
  if (!(dateTimeMs(other.start) < dateTimeMs(draft.end) && dateTimeMs(draft.start) < dateTimeMs(other.end))) return false;
  if (draft.scope === "CAMPAIGN" && other.scope === "CAMPAIGN") return draft.campaignIds.some((id) => other.campaign_ids.includes(id));
  if (draft.scope === "CHANNEL" && other.scope === "CHANNEL") return draft.channels.some((channel) => other.channels.includes(channel));
  return true;
}

async function readCampaigns(client: GoogleAdsClient, customerId: string, ids: string[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = await client.searchStream(customerId,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
              campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.campaign_budget
       FROM campaign
       WHERE campaign.id IN (${chunk.join(", ")})`);
    for (const row of rows) {
      const campaign = obj(row.campaign);
      found.set(String(campaign.id ?? ""), campaign);
    }
  }
  return found;
}

/** Confere as campanhas do escopo: existem, não estão removidas; avisa as sem Smart Bidding. */
async function checkAdjustmentCampaigns(
  client: GoogleAdsClient, customerId: string, ids: string[]
): Promise<{ errors: string[]; warnings: string[]; names: Array<{ id: string; name: string }> }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const campaigns = await readCampaigns(client, customerId, ids);
  const missing = ids.filter((id) => !campaigns.has(id));
  if (missing.length) errors.push(`campanhas não encontradas nesta conta: ${missing.join(", ")}`);
  const removed = ids.filter((id) => campaigns.get(id)?.status === "REMOVED");
  if (removed.length) errors.push(`campanhas removidas: ${removed.join(", ")}`);
  const notSmart = ids.filter((id) => {
    const campaign = campaigns.get(id);
    return campaign && campaign.status !== "REMOVED" && !SMART_BIDDING.has(String(campaign.biddingStrategyType ?? ""));
  });
  if (notSmart.length) {
    warnings.push(`Sem Smart Bidding (o ajuste não muda nada nelas): ${notSmart.map((id) => `${id} (${campaigns.get(id)?.biddingStrategyType})`).join(", ")}.`);
  }
  return { errors, warnings, names: ids.filter((id) => campaigns.has(id)).map((id) => ({ id, name: String(campaigns.get(id)?.name ?? "") })) };
}

function adjustmentPayload(kind: AdjustmentKind, cid: string, draft: AdjustmentDraft): Row {
  const body: Row = {
    name: draft.name.trim(),
    scope: draft.scope,
    startDateTime: draft.start,
    endDateTime: draft.end,
  };
  if (draft.description) body.description = draft.description;
  if (draft.devices.length) body.devices = draft.devices;
  if (draft.scope === "CAMPAIGN") body.campaigns = draft.campaignIds.map((id) => `customers/${cid}/campaigns/${id}`);
  if (draft.scope === "CHANNEL") body.advertisingChannelTypes = draft.channels;
  if (kind === "SEASONALITY") body.conversionRateModifier = draft.modifier;
  return body;
}

// ── Estratégias de portfólio ──────────────────────────────────────────

const PORTFOLIO_TYPES = [
  "TARGET_SPEND", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS", "TARGET_IMPRESSION_SHARE",
] as const;
type PortfolioType = (typeof PORTFOLIO_TYPES)[number];

type StrategyParam = "targetCpaMicros" | "targetRoas" | "cpcBidCeilingMicros" | "cpcBidFloorMicros" | "targetImpressionShareLocation" | "locationFractionMicros";

const PARAM_LEAVES: Record<StrategyParam, { leaf: string; json: string }> = {
  targetCpaMicros: { leaf: "target_cpa_micros", json: "targetCpaMicros" },
  targetRoas: { leaf: "target_roas", json: "targetRoas" },
  cpcBidCeilingMicros: { leaf: "cpc_bid_ceiling_micros", json: "cpcBidCeilingMicros" },
  cpcBidFloorMicros: { leaf: "cpc_bid_floor_micros", json: "cpcBidFloorMicros" },
  targetImpressionShareLocation: { leaf: "location", json: "location" },
  locationFractionMicros: { leaf: "location_fraction_micros", json: "locationFractionMicros" },
};

/** Esquema de cada tipo (oneof scheme do BiddingStrategy; campos de common/bidding.proto). */
const SCHEMES: Record<PortfolioType, { json: string; path: string; params: StrategyParam[]; required: StrategyParam[]; clearable?: StrategyParam }> = {
  TARGET_SPEND: { json: "targetSpend", path: "target_spend", params: ["cpcBidCeilingMicros"], required: [] },
  MAXIMIZE_CONVERSIONS: {
    json: "maximizeConversions", path: "maximize_conversions",
    params: ["targetCpaMicros", "cpcBidCeilingMicros", "cpcBidFloorMicros"], required: [], clearable: "targetCpaMicros",
  },
  MAXIMIZE_CONVERSION_VALUE: {
    json: "maximizeConversionValue", path: "maximize_conversion_value",
    params: ["targetRoas", "cpcBidCeilingMicros", "cpcBidFloorMicros"], required: [], clearable: "targetRoas",
  },
  TARGET_CPA: { json: "targetCpa", path: "target_cpa", params: ["targetCpaMicros", "cpcBidCeilingMicros", "cpcBidFloorMicros"], required: ["targetCpaMicros"] },
  TARGET_ROAS: { json: "targetRoas", path: "target_roas", params: ["targetRoas", "cpcBidCeilingMicros", "cpcBidFloorMicros"], required: ["targetRoas"] },
  TARGET_IMPRESSION_SHARE: {
    json: "targetImpressionShare", path: "target_impression_share",
    params: ["targetImpressionShareLocation", "locationFractionMicros", "cpcBidCeilingMicros"],
    required: ["targetImpressionShareLocation", "locationFractionMicros", "cpcBidCeilingMicros"],
  },
};

/** Todas as folhas dos esquemas, para ler a estratégia inteira numa query. */
const STRATEGY_SCHEME_FIELDS = (Object.values(SCHEMES) as Array<(typeof SCHEMES)[PortfolioType]>)
  .flatMap((scheme) => scheme.params.map((param) => `bidding_strategy.${scheme.path}.${PARAM_LEAVES[param].leaf}`))
  .join(", ");

const IMPRESSION_SHARE_LOCATIONS = ["ANYWHERE_ON_PAGE", "TOP_OF_PAGE", "ABSOLUTE_TOP_OF_PAGE"] as const;

function paramJsonValue(param: StrategyParam, value: unknown): unknown {
  if (param === "targetRoas" || param === "targetImpressionShareLocation") return value;
  return String(value);
}

function sameValue(param: StrategyParam, before: unknown, after: unknown): boolean {
  if (before === undefined || before === null) return false;
  if (param === "targetRoas") return Math.abs(Number(before) - Number(after)) < 1e-9;
  return String(before) === String(after);
}

function paramErrors(values: Partial<Record<StrategyParam, unknown>>): string[] {
  const errors: string[] = [];
  for (const key of ["targetCpaMicros", "cpcBidCeilingMicros", "cpcBidFloorMicros"] as const) {
    const value = values[key];
    if (value !== undefined && !isPositiveMicros(value)) errors.push(`${key} deve ser inteiro positivo em micros (recebido ${value})`);
  }
  const roas = values.targetRoas;
  if (roas !== undefined && !(typeof roas === "number" && roas >= 0.01 && roas <= 1000)) {
    errors.push(`targetRoas deve ficar entre 0.01 e 1000 (recebido ${roas}; 4.5 = 450%)`);
  }
  const fraction = values.locationFractionMicros;
  if (fraction !== undefined && !(typeof fraction === "number" && Number.isInteger(fraction) && fraction > 0 && fraction <= 1_000_000)) {
    errors.push(`locationFractionMicros deve ficar entre 1 e 1000000 (recebido ${fraction}; 700000 = 70%)`);
  }
  return errors;
}

/** Alvos legíveis de uma estratégia (bidding_strategy, accessible_bidding_strategy ou campaign). */
function strategyTargets(block: Row): Row {
  const out: Row = {};
  const cpa = obj(block.targetCpa).targetCpaMicros ?? obj(block.maximizeConversions).targetCpaMicros;
  if (num(cpa) > 0) out.target_cpa = money(cpa);
  const roas = obj(block.targetRoas).targetRoas ?? obj(block.maximizeConversionValue).targetRoas;
  if (num(roas) > 0) out.target_roas = round2(num(roas));
  for (const scheme of ["targetSpend", "targetCpa", "targetRoas", "maximizeConversions", "maximizeConversionValue", "targetImpressionShare"]) {
    const s = obj(block[scheme]);
    if (num(s.cpcBidCeilingMicros) > 0) out.cpc_bid_ceiling = money(s.cpcBidCeilingMicros);
    if (num(s.cpcBidFloorMicros) > 0) out.cpc_bid_floor = money(s.cpcBidFloorMicros);
  }
  const tis = obj(block.targetImpressionShare);
  if (tis.location || tis.locationFractionMicros) {
    out.impression_share = `${round2(num(tis.locationFractionMicros) / 10_000)}% ${String(tis.location ?? "")}`.trim();
  }
  return out;
}

/** Orientação do Google (jun/2026): em Pesquisa, preferir TARGET_CPA/TARGET_ROAS standalone. */
const STANDALONE_TARGET_NOTE =
  "Orientação do Google (blog de 16/06/2026): 'Maximizar conversões com CPA desejado' passou a se chamar Target CPA e " +
  "'Maximizar valor com ROAS desejado', Target ROAS; em Pesquisa o Google prioriza as estratégias standalone TARGET_CPA / TARGET_ROAS. " +
  "O comportamento do lance não muda.";

async function readStrategy(client: GoogleAdsClient, customerId: string, id: string): Promise<Row | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status,
            bidding_strategy.resource_name, bidding_strategy.campaign_count, bidding_strategy.non_removed_campaign_count,
            bidding_strategy.aligned_campaign_budget_id, bidding_strategy.effective_currency_code,
            ${STRATEGY_SCHEME_FIELDS}
     FROM bidding_strategy
     WHERE bidding_strategy.id = ${id}`);
  return rows[0] ? obj(rows[0].biddingStrategy) : undefined;
}

// ── Registro ──────────────────────────────────────────────────────────

export function registerBiddingTools(ctx: ToolContext): void {
  const { allowedCustomerIds, hosted } = ctx;

  // ── Simulações ─────────────────────────────────────────────────────

  ctx.mcp.registerTool(
    "get_bid_simulations",
    {
      description: [
        "Simulações de lance do Google (what-if): quanto a campanha / grupo / palavra-chave / portfólio teria gasto,",
        "clicado e convertido com outro lance, CPA/ROAS alvo, parcela de impressões ou orçamento. READ-ONLY.",
        "",
        "level + ID: CAMPAIGN (campaignId), AD_GROUP (adGroupId), KEYWORD (adGroupId e, opcional, criterionId),",
        "PORTFOLIO (biddingStrategyId). type filtra: CAMPAIGN aceita CPC_BID, TARGET_CPA, TARGET_ROAS,",
        "TARGET_IMPRESSION_SHARE, BUDGET; AD_GROUP: CPC_BID, CPV_BID, TARGET_CPA, TARGET_ROAS; KEYWORD: CPC_BID,",
        "PERCENT_CPC_BID; PORTFOLIO: TARGET_CPA, TARGET_ROAS. Sem type, traz todas.",
        "",
        "Cada ponto sai normalizado: valor de entrada (já no parâmetro da tool de escrita — targetCpaMicros, targetRoas,",
        "amountMicros, cpcBidMicros, locationFractionMicros), custo, cliques, conversões, valor, CPA e ROAS implícitos",
        "e a diferença para o ponto atual (ou o mais próximo dele). how_to_apply diz qual tool aplica o valor.",
        "SCALING (Pesquisa: CPC_BID e TARGET_CPA da campanha): o ponto é um multiplicador (scaling_modifier) sobre os",
        "valores atuais — alvo da campanha E overrides dos grupos; com CPA alvo atual, scaled_targetCpaMicros traz o valor",
        "absoluto (atual × fator) para a campanha.",
        "O período é sempre no passado (start/end da simulação). Contas de teste e entidades sem histórico não têm simulação.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        level: z.enum(SIMULATION_LEVELS_LIST).describe("CAMPAIGN, AD_GROUP, KEYWORD ou PORTFOLIO."),
        campaignId: z.string().optional().describe("level CAMPAIGN: ID da campanha."),
        adGroupId: z.string().optional().describe("level AD_GROUP ou KEYWORD: ID do grupo de anúncios."),
        criterionId: z.string().optional().describe("level KEYWORD: ID da palavra-chave (sem ele, todas do grupo)."),
        biddingStrategyId: z.string().optional().describe("level PORTFOLIO: ID da estratégia de portfólio."),
        type: z.enum(SIMULATION_TYPES).optional().describe("Tipo de simulação. Sem ele, todas as disponíveis."),
        modificationMethod: z.enum(["UNIFORM", "DEFAULT", "SCALING"]).optional().describe(
          "UNIFORM = mesmo valor para tudo; SCALING = todos os lances multiplicados; DEFAULT = só o valor padrão. Sem ele, todos."
        ),
        format: formatSchema,
      },
    },
    async ({ customerId, level, campaignId, adGroupId, criterionId, biddingStrategyId, type, modificationMethod, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);

      const spec = SIMULATION_LEVELS[level];
      const required: Record<SimulationLevel, Array<[string, string | undefined]>> = {
        CAMPAIGN: [["campaignId", campaignId]],
        AD_GROUP: [["adGroupId", adGroupId]],
        KEYWORD: [["adGroupId", adGroupId]],
        PORTFOLIO: [["biddingStrategyId", biddingStrategyId]],
      };
      const problems: string[] = [];
      for (const [label, value] of required[level]) {
        if (!value) problems.push(`level ${level} exige ${label}`);
        else if (!NUMERIC_ID.test(value)) problems.push(`${label} deve ser numérico (recebido "${value}")`);
      }
      if (level === "KEYWORD" && criterionId !== undefined && !NUMERIC_ID.test(criterionId)) {
        problems.push(`criterionId deve ser numérico (recebido "${criterionId}")`);
      }
      if (type && !spec.types.includes(type)) {
        problems.push(`level ${level} não tem simulação ${type} — tipos: ${spec.types.join(", ")}`);
      }
      if (problems.length) return fail(`Nada foi consultado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const ids: Row = { campaignId, adGroupId, criterionId, biddingStrategyId };

      // Configuração atual da entidade — para marcar o ponto de referência e confirmar que ela existe.
      let entities: Row[] = [];
      if (level === "CAMPAIGN") {
        entities = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                  campaign.bidding_strategy_type, campaign.bidding_strategy,
                  campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros,
                  campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas,
                  campaign.target_impression_share.location, campaign.target_impression_share.location_fraction_micros,
                  campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period
           FROM campaign
           WHERE campaign.id = ${campaignId}`);
      } else if (level === "AD_GROUP") {
        entities = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, ad_group.cpv_bid_micros,
                  ad_group.effective_target_cpa_micros, ad_group.effective_target_roas,
                  campaign.id, campaign.name, campaign.bidding_strategy_type
           FROM ad_group
           WHERE ad_group.id = ${adGroupId}`);
      } else if (level === "KEYWORD") {
        entities = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros,
                  ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.percent_cpc_bid_micros
           FROM ad_group_criterion
           WHERE ad_group.id = ${adGroupId}
             AND ad_group_criterion.status != 'REMOVED'${criterionId ? `\n             AND ad_group_criterion.criterion_id = ${criterionId}` : ""}`);
      } else {
        entities = await client.searchStream(customerId,
          `SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status,
                  bidding_strategy.target_cpa.target_cpa_micros, bidding_strategy.maximize_conversions.target_cpa_micros,
                  bidding_strategy.target_roas.target_roas, bidding_strategy.maximize_conversion_value.target_roas
           FROM bidding_strategy
           WHERE bidding_strategy.id = ${biddingStrategyId}`);
      }
      if (entities.length === 0) {
        const what = { CAMPAIGN: `Campanha ${campaignId}`, AD_GROUP: `Grupo ${adGroupId}`, KEYWORD: `Palavra-chave${criterionId ? ` ${criterionId}` : "s"} do grupo ${adGroupId}`, PORTFOLIO: `Estratégia de portfólio ${biddingStrategyId}` }[level];
        return fail(`${what} não encontrada na conta ${cid}.` + (level === "PORTFOLIO" ? " Estratégia de MCC: consulte com o customerId do MCC dono." : ""));
      }
      const byCriterion = new Map<string, Row>();
      if (level === "KEYWORD") {
        for (const row of entities) byCriterion.set(String(obj(row.adGroupCriterion).criterionId ?? ""), row);
      }

      const r = spec.resource;
      const idFilter: Record<SimulationLevel, string[]> = {
        CAMPAIGN: [`${r}.campaign_id = ${campaignId}`],
        AD_GROUP: [`${r}.ad_group_id = ${adGroupId}`],
        KEYWORD: [`${r}.ad_group_id = ${adGroupId}`, ...(criterionId ? [`${r}.criterion_id = ${criterionId}`] : [])],
        PORTFOLIO: [`${r}.bidding_strategy_id = ${biddingStrategyId}`],
      };
      const where = [
        ...idFilter[level],
        ...(type ? [`${r}.type = '${type}'`] : []),
        ...(modificationMethod ? [`${r}.modification_method = '${modificationMethod}'`] : []),
      ];
      const idColumns: Record<SimulationLevel, string[]> = {
        CAMPAIGN: ["campaign_id"],
        AD_GROUP: ["ad_group_id"],
        KEYWORD: ["ad_group_id", "criterion_id"],
        PORTFOLIO: ["bidding_strategy_id"],
      };
      const pointFields = spec.types.map((t) => `${r}.${POINT_LISTS[t].field}.points`);
      const simulations = await client.searchStream(customerId,
        `SELECT ${[...idColumns[level].map((c) => `${r}.${c}`), `${r}.type`, `${r}.modification_method`, `${r}.start_date`, `${r}.end_date`, ...pointFields].join(", ")}
         FROM ${r}
         WHERE ${where.join(" AND ")}`);

      const entityLabel = (() => {
        const row = entities[0];
        if (level === "CAMPAIGN") return `Campanha ${campaignId} ("${obj(row.campaign).name}")`;
        if (level === "AD_GROUP") return `Grupo ${adGroupId} ("${obj(row.adGroup).name}")`;
        if (level === "KEYWORD") return `Grupo ${adGroupId} ("${obj(row.adGroup).name}")${criterionId ? `, palavra-chave ${criterionId}` : ""}`;
        return `Portfólio ${biddingStrategyId} ("${obj(row.biddingStrategy).name}")`;
      })();

      if (simulations.length === 0) {
        return reply(
          `${entityLabel}: nenhuma simulação${type ? ` ${type}` : ""} disponível.\n` +
          "Motivos comuns: conta de teste (não tem histórico), entidade nova ou com pouco tráfego, combinação canal/tipo sem " +
          `simulação (${level}: ${spec.types.join(", ")}), ou estratégia que não gera esse tipo. ` +
          "Em Pesquisa com expansão para Display, a simulação cobre só a rede de Pesquisa."
        );
      }

      const groups: Row[] = [];
      const flat: Row[] = [];
      for (const row of simulations) {
        const sim = obj(row[spec.json]);
        const simType = String(sim.type ?? "") as SimulationType;
        const listSpec = POINT_LISTS[simType];
        if (!listSpec) continue;
        const points = list<Row>(obj(sim[listSpec.json]).points);
        const entity = level === "KEYWORD" ? byCriterion.get(String(sim.criterionId ?? "")) ?? {} : entities[0];
        const current = currentSettingFor(level, simType, entity);
        const { rows, baseline } = normalizePoints(simType, points, current);
        const method = String(sim.modificationMethod ?? "");
        const keyword = obj(obj(entity).adGroupCriterion);
        const header: Row = {
          type: simType,
          modification_method: method,
          date_range: { start: sim.startDate, end: sim.endDate },
          ...(level === "KEYWORD" ? { criterion_id: String(sim.criterionId ?? ""), keyword: obj(keyword.keyword).text ?? null } : {}),
          current_value: current === null ? (method === "SCALING" ? "1x (lances atuais)" : null) : pointKey(simType, {
            cpcBidMicros: current, cpvBidMicros: current, targetCpaMicros: current, targetRoas: current,
            targetImpressionShareMicros: current, budgetAmountMicros: current, percentCpcBidMicros: current,
          }).label,
          reference_point: baseline,
          how_to_apply: applyHint(level, simType, method, obj(entity), ids, current),
        };
        groups.push({ ...header, points: rows });
        for (const point of rows) {
          flat.push({
            type: simType, method, start: sim.startDate, end: sim.endDate,
            ...(level === "KEYWORD" ? { criterion_id: header.criterion_id } : {}),
            ...point,
          });
        }
      }
      return tabular(flat, format,
        `${entityLabel}: ${groups.length} simulação(ões). Valores em moeda da conta; deltas contra o ponto "atual" (ou o mais próximo).`,
        { level, entity: entityLabel, simulations: groups });
    }
  );

  // ── Sazonalidade e exclusão de dados ───────────────────────────────

  ctx.mcp.registerTool(
    "list_bidding_adjustments",
    {
      description: [
        "Lista ajustes de sazonalidade e exclusões de dados do Smart Bidding, com status no tempo",
        "(UPCOMING / ACTIVE / PAST pelo relógio da conta), escopo, campanhas/canais, dispositivos e modificador. READ-ONLY.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        kind: z.enum(["ALL", "SEASONALITY", "DATA_EXCLUSION"]).optional().describe("Default: ALL."),
        timing: z.enum(["ALL", "UPCOMING", "ACTIVE", "PAST"]).optional().describe("Filtra pelo momento. Default: ALL."),
        includeRemoved: z.boolean().optional().describe("Inclui os removidos. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, kind, timing, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const client = ctx.getClient();
      const account = await readAccountInfo(client, customerId);
      const kinds: AdjustmentKind[] = !kind || kind === "ALL" ? ["SEASONALITY", "DATA_EXCLUSION"] : [kind];
      const items: Adjustment[] = [];
      for (const k of kinds) {
        const where = includeRemoved ? [] : [`${ADJUSTMENTS[k].resource}.status != 'REMOVED'`];
        items.push(...(await fetchAdjustments(client, customerId, k, where)));
      }
      const campaignIds = [...new Set(items.flatMap((item) => item.campaign_ids))].filter((id) => NUMERIC_ID.test(id)).slice(0, 1000);
      const campaigns = campaignIds.length ? await readCampaigns(client, customerId, campaignIds) : new Map<string, Row>();
      const rows = items
        .map((item) => ({
          kind: item.kind,
          id: item.id,
          name: item.name,
          timing: timingOf(item.start, item.end, account.now),
          status: item.status,
          scope: item.scope,
          start: item.start,
          end: item.end,
          days: round2((dateTimeMs(item.end) - dateTimeMs(item.start)) / DAY_MS),
          ...(item.kind === "SEASONALITY" ? { conversion_rate_modifier: item.conversion_rate_modifier } : {}),
          devices: item.devices.length ? item.devices.join(", ") : "todos",
          channels: item.channels.join(", "),
          campaigns: item.campaign_ids.map((id) => `${id}${campaigns.get(id) ? ` (${campaigns.get(id)?.name})` : ""}`).join("; "),
          description: item.description,
          resource_name: item.resource_name,
        }))
        .filter((row) => !timing || timing === "ALL" || row.timing === timing);
      return tabular(rows, format,
        `${rows.length} ajuste(s) — agora na conta: ${account.now} (${account.timeZone}). Início inclusivo, fim exclusivo.`,
        rows);
    }
  );

  const adjustmentCreateSchema = {
    customerId: z.string().describe("Customer ID (conta cliente — MCC não aceita)."),
    name: z.string().describe("Nome único na conta (até 255 caracteres)."),
    description: z.string().optional().describe("Descrição (até 2048 caracteres)."),
    scope: z.enum(["CAMPAIGN", "CHANNEL"]).describe("CAMPAIGN (campaignIds) ou CHANNEL (channels)."),
    campaignIds: flexArray(z.string()).optional().describe("scope CAMPAIGN: IDs das campanhas (até 2000)."),
    channels: flexArray(z.string()).optional().describe("scope CHANNEL: SEARCH, SHOPPING e/ou DISPLAY."),
    devices: flexArray(z.string()).optional().describe("MOBILE, TABLET, DESKTOP. Vazio = todos os dispositivos."),
    startDateTime: z.string().describe("Início (inclusivo) no fuso da conta: YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss."),
    endDateTime: z.string().describe(
      "Fim (EXCLUSIVO na API) no fuso da conta. Só a data (YYYY-MM-DD) inclui o dia inteiro (vira o dia seguinte 00:00:00)."
    ),
  };

  async function createAdjustment(kind: AdjustmentKind, args: Row): Promise<ToolResult> {
    const customerId = String(args.customerId ?? "");
    const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
    if (blocked) return { content: [blocked], isError: true };
    const cid = customerIdOf(customerId);
    if (!cid) return fail(`customerId inválido: "${customerId}".`);
    const label = ADJUSTMENTS[kind].label;
    const start = parseAdsDateTime(String(args.startDateTime ?? ""), "startOfDay");
    const end = parseAdsDateTime(String(args.endDateTime ?? ""), "nextDayStart");
    const parseErrors = [start, end].filter((p): p is { error: string } => "error" in p).map((p) => p.error);
    if (parseErrors.length) return fail(`Nada foi criado:\n- ${parseErrors.join("\n- ")}`);
    const draft: AdjustmentDraft = {
      name: String(args.name ?? ""),
      description: args.description === undefined ? undefined : String(args.description),
      scope: String(args.scope ?? ""),
      campaignIds: idList(args.campaignIds),
      channels: enumList(args.channels),
      devices: enumList(args.devices),
      start: (start as { value: string }).value,
      end: (end as { value: string }).value,
      modifier: kind === "SEASONALITY" ? (args.conversionRateModifier as number | undefined) : undefined,
    };
    const shape = draftShapeErrors(kind, draft);
    if (shape.length) return fail(`Nada foi criado:\n- ${shape.join("\n- ")}`);

    const client = ctx.getClient();
    const account = await readAccountInfo(client, customerId);
    if (account.manager) {
      return fail(`A conta ${cid} é de administrador (MCC): ${label} só existe em conta cliente. Nada foi criado.`);
    }
    const timingErrors = draftTimingErrors(kind, draft, account.now, true);
    if (timingErrors.length) return fail(`Nada foi criado:\n- ${timingErrors.join("\n- ")}`);

    const existing = await fetchAdjustments(client, customerId, kind, [`${ADJUSTMENTS[kind].resource}.status != 'REMOVED'`]);
    const sameName = existing.find((item) => item.name.trim() === draft.name.trim());
    if (sameName) {
      return fail(`Já existe ${label} "${sameName.name}" (id ${sameName.id}, ${sameName.start} → ${sameName.end}). O nome precisa ser único — use update_bidding_adjustment para alterá-lo. Nada foi criado.`);
    }
    if (kind === "DATA_EXCLUSION" && existing.length >= MAX_ACTIVE_DATA_EXCLUSIONS) {
      return fail(`A conta já tem ${existing.length} exclusões de dados ativas (limite da API: ${MAX_ACTIVE_DATA_EXCLUSIONS}). Remova alguma com remove_bidding_adjustments. Nada foi criado.`);
    }
    const warnings = draftWarnings(kind, draft, account.now);
    for (const other of existing.filter((item) => overlaps(draft, item))) {
      warnings.push(`Sobrepõe "${other.name}" (id ${other.id}, ${other.start} → ${other.end}, ${other.scope}).`);
    }
    let campaignNames: Array<{ id: string; name: string }> = [];
    if (draft.scope === "CAMPAIGN") {
      const checked = await checkAdjustmentCampaigns(client, customerId, draft.campaignIds);
      if (checked.errors.length) return fail(`Nada foi criado:\n- ${checked.errors.join("\n- ")}`);
      warnings.push(...checked.warnings);
      campaignNames = checked.names;
    }

    const payload = adjustmentPayload(kind, cid, draft);
    let response: Row;
    try {
      response = await client.mutate(customerId, ADJUSTMENTS[kind].service, [{ create: payload }]);
    } catch (err) {
      return fail(`A API recusou o ${label}. Nada foi criado.\nErro: ${(err as Error).message}\n\n${formatJson({ attempted: payload })}`);
    }
    const dryRun = client.isDryRun;
    const resourceName = String(obj(list<Row>(response.results)[0]).resourceName ?? "");
    if (!dryRun && !resourceName) {
      return fail(`A API não confirmou a criação do ${label} — confira com list_bidding_adjustments antes de repetir.\n\n${formatJson(response)}`);
    }
    return reply(
      (dryRun ? `DRY-RUN (validateOnly): ${label} validado pela API — nada foi criado.` : `${label[0].toUpperCase()}${label.slice(1)} criado: ${resourceName}`) +
      `\n\n${formatJson({
        name: payload.name,
        scope: draft.scope,
        start: draft.start,
        end_exclusive: draft.end,
        days: round2((dateTimeMs(draft.end) - dateTimeMs(draft.start)) / DAY_MS),
        ...(kind === "SEASONALITY" ? { conversion_rate_modifier: draft.modifier } : {}),
        devices: draft.devices.length ? draft.devices : "todos",
        ...(draft.scope === "CAMPAIGN" ? { campaigns: campaignNames } : { channels: draft.channels }),
        account_clock: `${account.now} (${account.timeZone})`,
        warnings,
      })}`
    );
  }

  ctx.mcp.registerTool(
    "create_seasonality_adjustment",
    {
      description: [
        "Cria um ajuste de sazonalidade do Smart Bidding: avisa que a taxa de conversão vai mudar num evento FUTURO",
        "curto (Black Friday, Dia do Consumidor, promoção relâmpago). WRITE OPERATION.",
        "",
        "conversionRateModifier: multiplicador esperado da taxa de conversão (0.1 a 10.0; 1.5 = +50%).",
        "Janela no fuso da conta, de 1 a 7 dias é o ideal; a API aceita no máximo 14 dias. Só afeta campanhas com",
        "Smart Bidding (CPA/ROAS desejado, maximizar conversões/valor). Não existe em conta MCC.",
      ].join("\n"),
      inputSchema: {
        ...adjustmentCreateSchema,
        conversionRateModifier: z.number().describe("Multiplicador da taxa de conversão esperada: 0.1 a 10.0 (1.3 = +30%)."),
      },
    },
    async (args) => createAdjustment("SEASONALITY", args as Row)
  );

  ctx.mcp.registerTool(
    "create_data_exclusion",
    {
      description: [
        "Cria uma exclusão de dados do Smart Bidding: manda ignorar as conversões de um período com problema",
        "(tag/GTM quebrado, pixel duplicado, site fora do ar). WRITE OPERATION.",
        "",
        "O início precisa estar no PASSADO (fuso da conta); o fim pode estar no passado ou no futuro. Janela máxima",
        "de 14 dias. Até 500 exclusões ativas por conta. Não existe em conta MCC.",
      ].join("\n"),
      inputSchema: adjustmentCreateSchema,
    },
    async (args) => createAdjustment("DATA_EXCLUSION", args as Row)
  );

  ctx.mcp.registerTool(
    "update_bidding_adjustment",
    {
      description: [
        "Altera um ajuste de sazonalidade ou uma exclusão de dados existente (ver list_bidding_adjustments).",
        "WRITE OPERATION — só os campos que mudam são enviados (updateMask exato).",
        "",
        "Campos: name, description, startDateTime, endDateTime, conversionRateModifier (só SEASONALITY), devices",
        "(lista vazia = todos), campaignIds (só escopo CAMPAIGN) ou channels (só escopo CHANNEL). O escopo não muda:",
        "para trocar, remova e crie outro. Ajuste de sazonalidade que já terminou não pode ser alterado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        kind: z.enum(["SEASONALITY", "DATA_EXCLUSION"]).describe("Tipo do ajuste."),
        id: z.string().describe("seasonality_adjustment_id ou data_exclusion_id."),
        name: z.string().optional(),
        description: z.string().optional(),
        startDateTime: z.string().optional().describe("YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss (fuso da conta)."),
        endDateTime: z.string().optional().describe("Fim EXCLUSIVO; só a data inclui o dia inteiro."),
        conversionRateModifier: z.number().optional().describe("Só SEASONALITY: 0.1 a 10.0."),
        devices: flexArray(z.string()).optional().describe("MOBILE, TABLET, DESKTOP; [] = todos."),
        campaignIds: flexArray(z.string()).optional().describe("Escopo CAMPAIGN: nova lista completa de campanhas."),
        channels: flexArray(z.string()).optional().describe("Escopo CHANNEL: nova lista completa de canais."),
      },
    },
    async ({ customerId, kind, id, name, description, startDateTime, endDateTime, conversionRateModifier, devices, campaignIds, channels }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!NUMERIC_ID.test(id)) return fail(`id deve ser numérico, recebido "${id}". Nada foi alterado.`);
      const spec = ADJUSTMENTS[kind];
      if (kind === "DATA_EXCLUSION" && conversionRateModifier !== undefined) {
        return fail("conversionRateModifier só existe em ajuste de sazonalidade. Nada foi alterado.");
      }
      if ([name, description, startDateTime, endDateTime, conversionRateModifier, devices, campaignIds, channels].every((v) => v === undefined)) {
        return fail("Informe ao menos um campo para alterar. Nada foi alterado.");
      }
      const start = startDateTime !== undefined ? parseAdsDateTime(startDateTime, "startOfDay") : undefined;
      const end = endDateTime !== undefined ? parseAdsDateTime(endDateTime, "nextDayStart") : undefined;
      const parseErrors = [start, end].filter((p): p is { error: string } => !!p && "error" in p).map((p) => p.error);
      if (parseErrors.length) return fail(`Nada foi alterado:\n- ${parseErrors.join("\n- ")}`);

      const client = ctx.getClient();
      const [current] = await fetchAdjustments(client, customerId, kind, [`${spec.resource}.${spec.idField} = ${id}`]);
      if (!current) return fail(`${spec.label} ${id} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (current.status === "REMOVED") return fail(`${spec.label} ${id} ("${current.name}") está removido. Nada foi alterado.`);
      if (campaignIds !== undefined && current.scope !== "CAMPAIGN") {
        return fail(`${spec.label} ${id} tem escopo ${current.scope}: campaignIds só vale no escopo CAMPAIGN (remova e crie outro para trocar de escopo). Nada foi alterado.`);
      }
      if (channels !== undefined && current.scope !== "CHANNEL") {
        return fail(`${spec.label} ${id} tem escopo ${current.scope}: channels só vale no escopo CHANNEL (remova e crie outro para trocar de escopo). Nada foi alterado.`);
      }
      const account = await readAccountInfo(client, customerId);
      if (kind === "SEASONALITY" && dateTimeMs(current.end) <= dateTimeMs(account.now)) {
        return fail(`Ajuste de sazonalidade ${id} ("${current.name}") já terminou em ${current.end}. Nada foi alterado.`);
      }

      const draft: AdjustmentDraft = {
        name: name ?? current.name,
        description: description ?? current.description,
        scope: current.scope,
        campaignIds: campaignIds !== undefined ? idList(campaignIds) : current.campaign_ids,
        channels: channels !== undefined ? enumList(channels) : current.channels,
        devices: devices !== undefined ? enumList(devices) : current.devices,
        start: start && "value" in start ? start.value : current.start,
        end: end && "value" in end ? end.value : current.end,
        modifier: kind === "SEASONALITY" ? conversionRateModifier ?? current.conversion_rate_modifier : undefined,
      };
      const startChanged = draft.start !== current.start;
      const errors = [...draftShapeErrors(kind, draft), ...draftTimingErrors(kind, draft, account.now, startChanged)];
      if (errors.length) return fail(`Nada foi alterado:\n- ${errors.join("\n- ")}`);

      const update: Row = { resourceName: current.resource_name || `customers/${cid}/${spec.path}/${id}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
      const change = (setting: string, path: string, json: string, before: unknown, after: unknown, sent: unknown = after) => {
        update[json] = sent;
        mask.push(path);
        changes.push({ setting, before, after });
      };
      if (draft.name.trim() !== current.name) change("name", "name", "name", current.name, draft.name.trim());
      if ((draft.description ?? "") !== current.description) change("description", "description", "description", current.description, draft.description);
      if (startChanged) change("startDateTime", "start_date_time", "startDateTime", current.start, draft.start);
      if (draft.end !== current.end) change("endDateTime", "end_date_time", "endDateTime", current.end, draft.end);
      if (kind === "SEASONALITY" && draft.modifier !== current.conversion_rate_modifier) {
        change("conversionRateModifier", "conversion_rate_modifier", "conversionRateModifier", current.conversion_rate_modifier, draft.modifier);
      }
      if (!sameList(draft.devices, current.devices)) change("devices", "devices", "devices", current.devices, draft.devices);
      if (current.scope === "CAMPAIGN" && !sameList(draft.campaignIds, current.campaign_ids)) {
        change("campaignIds", "campaigns", "campaigns", current.campaign_ids, draft.campaignIds,
          draft.campaignIds.map((campaignId) => `customers/${cid}/campaigns/${campaignId}`));
      }
      if (current.scope === "CHANNEL" && !sameList(draft.channels, current.channels)) {
        change("channels", "advertising_channel_types", "advertisingChannelTypes", current.channels, draft.channels);
      }
      const label = `${spec.label[0].toUpperCase()}${spec.label.slice(1)} ${id} ("${current.name}")`;
      if (mask.length === 0) {
        return reply(`${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`);
      }
      const warnings = draftWarnings(kind, draft, account.now);
      if (mask.includes("campaigns")) {
        const checked = await checkAdjustmentCampaigns(client, customerId, draft.campaignIds);
        if (checked.errors.length) return fail(`Nada foi alterado:\n- ${checked.errors.join("\n- ")}`);
        warnings.push(...checked.warnings);
      }
      if (mask.includes("name")) {
        const others = await fetchAdjustments(client, customerId, kind, [`${spec.resource}.status != 'REMOVED'`]);
        const clash = others.find((other) => other.id !== id && other.name.trim() === draft.name.trim());
        if (clash) return fail(`Já existe ${spec.label} com o nome "${clash.name}" (id ${clash.id}). Nada foi alterado.`);
      }

      try {
        await client.mutate(customerId, spec.service, [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`${label}: a API não aceitou a alteração.\nErro: ${(err as Error).message}\n\n${formatJson({ attempted: changes, update_mask: mask })}`);
      }
      const dryRun = client.isDryRun;
      return reply(
        (dryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label} — ${changes.length} alteração(ões) aplicada(s).`) +
        `\n\n${formatJson({ changes, warnings, update_mask: mask })}`
      );
    }
  );

  ctx.mcp.registerTool(
    "remove_bidding_adjustments",
    {
      description: [
        "Remove ajustes de sazonalidade ou exclusões de dados (ver list_bidding_adjustments).",
        "WRITE OPERATION — exige confirm: true. Remover uma exclusão de dados faz o Smart Bidding voltar a",
        "aprender com as conversões daquele período.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        kind: z.enum(["SEASONALITY", "DATA_EXCLUSION"]).describe("Tipo dos ajustes."),
        ids: flexArray(z.string()).describe("IDs (seasonality_adjustment_id ou data_exclusion_id)."),
        confirm: z.boolean().describe("true para confirmar a remoção."),
      },
    },
    async ({ customerId, kind, ids, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (confirm !== true) return fail("Remoção exige confirm: true. Nada foi removido.");
      const spec = ADJUSTMENTS[kind];
      const wanted = idList(ids);
      if (wanted.length === 0) return fail("Informe ids. Nada foi removido.");
      const bad = wanted.filter((id) => !NUMERIC_ID.test(id));
      if (bad.length) return fail(`ids devem ser numéricos: ${bad.join(", ")}. Nada foi removido.`);
      if (wanted.length > 1000) return fail("No máximo 1000 ids por chamada. Nada foi removido.");

      const client = ctx.getClient();
      const found = await fetchAdjustments(client, customerId, kind, [`${spec.resource}.${spec.idField} IN (${wanted.join(", ")})`]);
      const byId = new Map(found.map((item) => [item.id, item]));
      const notFound = wanted.filter((id) => !byId.has(id));
      const alreadyRemoved = wanted.filter((id) => byId.get(id)?.status === "REMOVED");
      const targets = wanted.map((id) => byId.get(id)).filter((item): item is Adjustment => !!item && item.status !== "REMOVED");
      if (targets.length === 0) {
        return fail(`Nada a remover. Não encontrados: ${notFound.join(", ") || "-"} | Já removidos: ${alreadyRemoved.join(", ") || "-"}`);
      }
      const response = await client.mutate(customerId, spec.service,
        targets.map((item) => ({ remove: item.resource_name || `customers/${cid}/${spec.path}/${item.id}` })), { partialFailure: true });
      const dryRun = client.isDryRun;
      const results = list<Row>(response.results);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, targets.length);
      const removed: Row[] = [];
      const errors: Row[] = [];
      targets.forEach((item, index) => {
        const describe = { id: item.id, name: item.name, start: item.start, end: item.end };
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...describe, error: opErrors.join("; ") });
        else if (!dryRun && !obj(results[index]).resourceName) errors.push({ ...describe, error: "a API não confirmou a remoção" });
        else removed.push(describe);
      });
      for (const message of unattributed) errors.push({ error: message });
      return reply(
        (dryRun ? `DRY-RUN (validateOnly): nada foi removido. Validados: ${removed.length}` : `${removed.length} ${spec.label}(s) removido(s)`) +
        ` | Não encontrados: ${notFound.length} | Já removidos: ${alreadyRemoved.length} | Com erro: ${errors.length}\n\n` +
        formatJson({ [dryRun ? "validated" : "removed"]: removed, not_found: notFound, already_removed: alreadyRemoved, errors }),
        errors.length > 0
      );
    }
  );

  // ── Estratégias de portfólio ───────────────────────────────────────

  ctx.mcp.registerTool(
    "list_bidding_strategies",
    {
      description: [
        "Lista as estratégias de lance de portfólio da conta e, com includeManagerOwned (default true), as de MCC",
        "compartilhadas com ela (accessible_bidding_strategy). Para cada uma: tipo, alvos (CPA/ROAS/teto/piso/",
        "parcela de impressões), dono e as campanhas que a usam com o status do lance",
        "(bidding_strategy_system_status: LEARNING_*, LIMITED_*, MISCONFIGURED_*...). READ-ONLY.",
        "includeStandardCampaigns: também lista as campanhas com estratégia própria (padrão), com alvos e status.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeManagerOwned: z.boolean().optional().describe("Inclui estratégias de MCC compartilhadas. Default: true."),
        includeRemoved: z.boolean().optional().describe("Inclui portfólios removidos. Default: false."),
        includeStandardCampaigns: z.boolean().optional().describe("Lista também as campanhas com estratégia padrão. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, includeManagerOwned, includeRemoved, includeStandardCampaigns, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const client = ctx.getClient();

      const owned = await client.searchStream(customerId,
        `SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status,
                bidding_strategy.resource_name, bidding_strategy.campaign_count, bidding_strategy.non_removed_campaign_count,
                bidding_strategy.effective_currency_code, bidding_strategy.aligned_campaign_budget_id,
                ${STRATEGY_SCHEME_FIELDS}
         FROM bidding_strategy
         ${includeRemoved ? "" : "WHERE bidding_strategy.status != 'REMOVED'"}
         ORDER BY bidding_strategy.name`);
      const shared = includeManagerOwned === false ? [] : await client.searchStream(customerId,
        `SELECT accessible_bidding_strategy.id, accessible_bidding_strategy.name, accessible_bidding_strategy.type,
                accessible_bidding_strategy.resource_name, accessible_bidding_strategy.owner_customer_id,
                accessible_bidding_strategy.owner_descriptive_name,
                accessible_bidding_strategy.target_cpa.target_cpa_micros, accessible_bidding_strategy.target_roas.target_roas,
                accessible_bidding_strategy.maximize_conversions.target_cpa_micros,
                accessible_bidding_strategy.maximize_conversion_value.target_roas,
                accessible_bidding_strategy.target_spend.cpc_bid_ceiling_micros,
                accessible_bidding_strategy.target_impression_share.location,
                accessible_bidding_strategy.target_impression_share.location_fraction_micros,
                accessible_bidding_strategy.target_impression_share.cpc_bid_ceiling_micros
         FROM accessible_bidding_strategy
         WHERE accessible_bidding_strategy.owner_customer_id != ${cid}`);
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.accessible_bidding_strategy,
                campaign.bidding_strategy_system_status,
                campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros,
                campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas,
                campaign.target_spend.cpc_bid_ceiling_micros,
                campaign.target_impression_share.location, campaign.target_impression_share.location_fraction_micros
         FROM campaign
         WHERE campaign.status != 'REMOVED'`);

      const campaignsByStrategy = new Map<string, Row[]>();
      const standard: Row[] = [];
      for (const row of campaignRows) {
        const campaign = obj(row.campaign);
        const summary = {
          id: String(campaign.id ?? ""), name: campaign.name, status: campaign.status,
          system_status: campaign.biddingStrategySystemStatus ?? null,
        };
        const portfolio = String(campaign.biddingStrategy ?? "");
        if (portfolio) {
          const key = lastSegment(portfolio);
          campaignsByStrategy.set(key, [...(campaignsByStrategy.get(key) ?? []), summary]);
        } else if (includeStandardCampaigns) {
          standard.push({
            campaign_id: summary.id, name: summary.name, status: summary.status,
            channel: campaign.advertisingChannelType, strategy_type: campaign.biddingStrategyType,
            ...strategyTargets(campaign), system_status: summary.system_status,
          });
        }
      }

      const portfolios: Row[] = [];
      for (const row of owned) {
        const bs = obj(row.biddingStrategy);
        const id = String(bs.id ?? "");
        portfolios.push({
          id, name: bs.name, owner: `esta conta (${cid})`, type: bs.type, status: bs.status,
          ...strategyTargets(bs),
          currency: bs.effectiveCurrencyCode ?? null,
          active_campaigns: num(bs.nonRemovedCampaignCount),
          aligned_budget_id: num(bs.alignedCampaignBudgetId) > 0 ? String(bs.alignedCampaignBudgetId) : null,
          campaigns: campaignsByStrategy.get(id) ?? [],
          resource_name: bs.resourceName,
        });
      }
      for (const row of shared) {
        const abs = obj(row.accessibleBiddingStrategy);
        const id = String(abs.id ?? "");
        const ownerName = String(abs.ownerDescriptiveName ?? "").trim();
        portfolios.push({
          id, name: abs.name, owner: `MCC ${ownerName ? `${ownerName} ` : ""}(${abs.ownerCustomerId ?? "?"})`,
          type: abs.type, status: "ENABLED",
          ...strategyTargets(abs),
          active_campaigns: (campaignsByStrategy.get(id) ?? []).length,
          campaigns: campaignsByStrategy.get(id) ?? [],
          resource_name: `customers/${abs.ownerCustomerId}/biddingStrategies/${id}`,
        });
      }
      const notes: string[] = [];
      const bundled = [...portfolios, ...standard].some((item) =>
        (item.type === "MAXIMIZE_CONVERSIONS" || item.strategy_type === "MAXIMIZE_CONVERSIONS") && item.target_cpa ||
        (item.type === "MAXIMIZE_CONVERSION_VALUE" || item.strategy_type === "MAXIMIZE_CONVERSION_VALUE") && item.target_roas);
      if (bundled) notes.push(STANDALONE_TARGET_NOTE);
      if (shared.length) notes.push("Estratégias de MCC: só o MCC dono (login-customer-id dele) pode alterá-las ou vinculá-las a campanhas.");

      const tableRows = [
        ...portfolios.map((p) => ({ ...p, campaigns: list<Row>(p.campaigns).map((c) => `${c.id} ${c.name} [${c.system_status ?? "-"}]`).join("; ") })),
        ...standard.map((s) => ({ kind: "STANDARD", ...s })),
      ];
      return tabular(tableRows, format,
        `${portfolios.length} estratégia(s) de portfólio` + (includeStandardCampaigns ? ` e ${standard.length} campanha(s) com estratégia padrão.` : "."),
        { portfolios, ...(includeStandardCampaigns ? { standard_campaigns: standard } : {}), notes });
    }
  );

  ctx.mcp.registerTool(
    "create_bidding_strategy",
    {
      description: [
        "Cria uma estratégia de lance de portfólio (compartilhável entre campanhas). WRITE OPERATION — não muda",
        "nenhuma campanha; vincule depois com assign_bidding_strategy.",
        "",
        "type e parâmetros: TARGET_SPEND (Maximizar cliques; cpcBidCeilingMicros), MAXIMIZE_CONVERSIONS (targetCpaMicros",
        "opcional, teto/piso), MAXIMIZE_CONVERSION_VALUE (targetRoas opcional, teto/piso), TARGET_CPA (targetCpaMicros",
        "obrigatório, teto/piso), TARGET_ROAS (targetRoas obrigatório, teto/piso), TARGET_IMPRESSION_SHARE (local,",
        "parcela e teto obrigatórios). Em Pesquisa o Google prioriza TARGET_CPA / TARGET_ROAS standalone (jun/2026).",
        "Com o customerId de um MCC cria uma estratégia de MCC (currencyCode opcional, só em MCC).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (conta cliente, ou o MCC para estratégia de MCC)."),
        name: z.string().describe("Nome único na conta (1 a 255 caracteres)."),
        type: z.enum(PORTFOLIO_TYPES).describe("Tipo da estratégia."),
        targetCpaMicros: z.number().optional().describe("CPA alvo em micros (50000000 = R$50)."),
        targetRoas: z.number().optional().describe("ROAS alvo em decimal (4.5 = 450%), de 0.01 a 1000."),
        cpcBidCeilingMicros: z.number().optional().describe("Teto de CPC em micros."),
        cpcBidFloorMicros: z.number().optional().describe("Piso de CPC em micros (MAXIMIZE_*, TARGET_CPA, TARGET_ROAS)."),
        targetImpressionShareLocation: z.enum(IMPRESSION_SHARE_LOCATIONS).optional(),
        locationFractionMicros: z.number().optional().describe("Parcela de impressões em micros (700000 = 70%)."),
        currencyCode: z.string().optional().describe("Só MCC: moeda ISO 4217 (ex.: BRL). Imutável depois de criada."),
      },
    },
    async (args) => {
      const { customerId, name, type, currencyCode } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const scheme = SCHEMES[type];
      const values: Partial<Record<StrategyParam, unknown>> = {};
      for (const param of Object.keys(PARAM_LEAVES) as StrategyParam[]) {
        if ((args as Row)[param] !== undefined) values[param] = (args as Row)[param];
      }
      const problems: string[] = [];
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 255) problems.push("name deve ter de 1 a 255 caracteres");
      const misplaced = (Object.keys(values) as StrategyParam[]).filter((param) => !scheme.params.includes(param));
      if (misplaced.length) problems.push(`${type} não usa ${misplaced.join(", ")} (aceita ${scheme.params.join(", ") || "nenhum parâmetro"})`);
      const missing = scheme.required.filter((param) => values[param] === undefined);
      if (missing.length) problems.push(`${type} exige ${missing.join(", ")}`);
      problems.push(...paramErrors(values));
      if (values.cpcBidCeilingMicros !== undefined && values.cpcBidFloorMicros !== undefined &&
          num(values.cpcBidFloorMicros) > num(values.cpcBidCeilingMicros)) {
        problems.push("cpcBidFloorMicros não pode passar de cpcBidCeilingMicros");
      }
      if (currencyCode !== undefined && !/^[A-Z]{3}$/.test(currencyCode)) problems.push(`currencyCode deve ser ISO 4217 em maiúsculas (recebido "${currencyCode}")`);
      if (problems.length) return fail(`Nada foi criado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      if (currencyCode !== undefined) {
        const account = await readAccountInfo(client, customerId);
        if (!account.manager) {
          return fail(`currencyCode só pode ser definido em estratégia de MCC; a conta ${cid} é cliente e usa a própria moeda (${account.currency || "da conta"}). Nada foi criado.`);
        }
      }
      const clash = await client.searchStream(customerId,
        `SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.status
         FROM bidding_strategy
         WHERE bidding_strategy.name = '${gaqlLiteral(trimmed)}'`);
      const active = clash.map((row) => obj(row.biddingStrategy)).find((bs) => bs.status !== "REMOVED");
      if (active) return fail(`Já existe a estratégia "${active.name}" (id ${active.id}) nesta conta — o nome precisa ser único. Nada foi criado.`);

      const block: Row = {};
      for (const [param, value] of Object.entries(values) as Array<[StrategyParam, unknown]>) {
        block[PARAM_LEAVES[param].json] = paramJsonValue(param, value);
      }
      const payload: Row = { name: trimmed, [scheme.json]: block, ...(currencyCode ? { currencyCode } : {}) };
      const warnings: string[] = [];
      if ((type === "MAXIMIZE_CONVERSIONS" && values.targetCpaMicros !== undefined) || (type === "MAXIMIZE_CONVERSION_VALUE" && values.targetRoas !== undefined)) {
        warnings.push(STANDALONE_TARGET_NOTE);
      }
      if (type === "TARGET_SPEND" && values.cpcBidCeilingMicros === undefined) {
        warnings.push("Maximizar cliques sem teto: o Google pode pagar CPCs altos.");
      }
      let response: Row;
      try {
        response = await client.mutate(customerId, "biddingStrategies", [{ create: payload }]);
      } catch (err) {
        return fail(`A API recusou a estratégia. Nada foi criado.\nErro: ${(err as Error).message}\n\n${formatJson({ attempted: payload })}`);
      }
      const dryRun = client.isDryRun;
      const resourceName = String(obj(list<Row>(response.results)[0]).resourceName ?? "");
      if (!dryRun && !resourceName) {
        return fail(`A API não confirmou a criação — confira com list_bidding_strategies antes de repetir.\n\n${formatJson(response)}`);
      }
      return reply(
        (dryRun ? "DRY-RUN (validateOnly): estratégia validada pela API — nada foi criado." : `Estratégia de portfólio criada: ${resourceName}`) +
        `\n\n${formatJson({ name: trimmed, type, ...strategyTargets({ [scheme.json]: block }), warnings })}` +
        (dryRun ? "" : `\n\nPróximo passo: assign_bidding_strategy { biddingStrategyId: "${lastSegment(resourceName)}", campaignIds: [...] }.`)
      );
    }
  );

  ctx.mcp.registerTool(
    "update_bidding_strategy",
    {
      description: [
        "Altera nome e parâmetros de uma estratégia de portfólio (vale para TODAS as campanhas dela).",
        "WRITE OPERATION — só os campos que mudam vão no updateMask. O tipo é imutável na API.",
        "Parâmetros por tipo como em create_bidding_strategy. clearTarget (MAXIMIZE_CONVERSIONS /",
        "MAXIMIZE_CONVERSION_VALUE) remove o CPA/ROAS alvo opcional. Portfólio com mais de uma campanha ativa",
        "exige confirm: true (sem ele, mostra a prévia e não grava). Estratégia de MCC: use o customerId do MCC dono.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID dono da estratégia."),
        biddingStrategyId: z.string().describe("ID da estratégia (list_bidding_strategies)."),
        name: z.string().optional(),
        targetCpaMicros: z.number().optional(),
        targetRoas: z.number().optional(),
        cpcBidCeilingMicros: z.number().optional(),
        cpcBidFloorMicros: z.number().optional(),
        targetImpressionShareLocation: z.enum(IMPRESSION_SHARE_LOCATIONS).optional(),
        locationFractionMicros: z.number().optional(),
        clearTarget: z.boolean().optional().describe("MAXIMIZE_CONVERSIONS / MAXIMIZE_CONVERSION_VALUE: remove o alvo opcional."),
        confirm: z.boolean().optional().describe("Obrigatório quando o portfólio tem mais de uma campanha ativa."),
      },
    },
    async (args) => {
      const { customerId, biddingStrategyId, name, clearTarget, confirm } = args;
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!NUMERIC_ID.test(biddingStrategyId)) return fail(`biddingStrategyId deve ser numérico, recebido "${biddingStrategyId}". Nada foi alterado.`);
      const values: Partial<Record<StrategyParam, unknown>> = {};
      for (const param of Object.keys(PARAM_LEAVES) as StrategyParam[]) {
        if ((args as Row)[param] !== undefined) values[param] = (args as Row)[param];
      }
      if (name === undefined && Object.keys(values).length === 0 && !clearTarget) {
        return fail("Informe ao menos um campo para alterar. Nada foi alterado.");
      }
      const problems = paramErrors(values);
      if (name !== undefined && (!name.trim() || name.trim().length > 255)) problems.push("name deve ter de 1 a 255 caracteres");
      if (problems.length) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      const bs = await readStrategy(client, customerId, biddingStrategyId);
      if (!bs) {
        return fail(`Estratégia ${biddingStrategyId} não encontrada na conta ${cid}. Se ela é de MCC, chame com o customerId do MCC dono (owner em list_bidding_strategies). Nada foi alterado.`);
      }
      if (bs.status === "REMOVED") return fail(`Estratégia ${biddingStrategyId} ("${bs.name}") está removida. Nada foi alterado.`);
      const type = String(bs.type ?? "") as PortfolioType;
      const scheme = SCHEMES[type];
      if (!scheme) return fail(`Estratégia ${biddingStrategyId} é do tipo ${type}, que esta tool não altera. Nada foi alterado.`);
      const misplaced = (Object.keys(values) as StrategyParam[]).filter((param) => !scheme.params.includes(param));
      if (misplaced.length) {
        return fail(`Nada foi alterado — ${type} não usa ${misplaced.join(", ")} (aceita ${scheme.params.join(", ")}). O tipo não muda: crie outra estratégia.`);
      }
      if (clearTarget && !scheme.clearable) return fail(`clearTarget só vale para MAXIMIZE_CONVERSIONS e MAXIMIZE_CONVERSION_VALUE (esta é ${type}). Nada foi alterado.`);
      if (clearTarget && scheme.clearable && values[scheme.clearable] !== undefined) {
        return fail(`Use ${scheme.clearable} OU clearTarget, não os dois. Nada foi alterado.`);
      }

      const currentBlock = obj(bs[scheme.json]);
      const update: Row = { resourceName: String(bs.resourceName ?? `customers/${cid}/biddingStrategies/${biddingStrategyId}`) };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      if (name !== undefined && name.trim() !== bs.name) {
        update.name = name.trim();
        mask.push("name");
        changes.push({ setting: "name", before: bs.name, after: name.trim() });
      }
      const block: Row = {};
      for (const [param, value] of Object.entries(values) as Array<[StrategyParam, unknown]>) {
        const before = currentBlock[PARAM_LEAVES[param].json];
        if (sameValue(param, before, value)) continue;
        block[PARAM_LEAVES[param].json] = paramJsonValue(param, value);
        mask.push(`${scheme.path}.${PARAM_LEAVES[param].leaf}`);
        changes.push({ setting: param, before: before ?? null, after: value });
      }
      if (clearTarget && scheme.clearable) {
        const before = currentBlock[PARAM_LEAVES[scheme.clearable].json];
        if (num(before) > 0) {
          // Campo no updateMask sem valor no objeto = a API limpa o alvo.
          mask.push(`${scheme.path}.${PARAM_LEAVES[scheme.clearable].leaf}`);
          changes.push({ setting: scheme.clearable, before, after: null });
        }
      }
      if (Object.keys(block).length || mask.some((path) => path.startsWith(`${scheme.path}.`))) update[scheme.json] = block;
      const ceiling = values.cpcBidCeilingMicros ?? currentBlock.cpcBidCeilingMicros;
      const floor = values.cpcBidFloorMicros ?? currentBlock.cpcBidFloorMicros;
      if (num(ceiling) > 0 && num(floor) > 0 && num(floor) > num(ceiling)) {
        return fail(`Piso (${money(floor)}) maior que o teto (${money(ceiling)}). Nada foi alterado.`);
      }
      const label = `Estratégia ${biddingStrategyId} ("${bs.name}", ${type})`;
      if (mask.length === 0) return reply(`${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`);

      const activeCampaigns = num(bs.nonRemovedCampaignCount);
      const warnings: string[] = [];
      if (activeCampaigns > 0 && mask.some((path) => path !== "name")) {
        warnings.push(`A mudança vale para as ${activeCampaigns} campanha(s) ativas do portfólio e pode reabrir o aprendizado do lance.`);
      }
      if (activeCampaigns > 1 && confirm !== true) {
        return fail(
          `${label}: o portfólio tem ${activeCampaigns} campanhas ativas — a mudança vale para todas. Repita com confirm: true para aplicar. Nada foi gravado.\n\n` +
          formatJson({ preview: changes, update_mask: mask })
        );
      }
      try {
        await client.mutate(customerId, "biddingStrategies", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`${label}: a API não aceitou a alteração.\nErro: ${(err as Error).message}\n\n${formatJson({ attempted: changes, update_mask: mask })}`);
      }
      const dryRun = client.isDryRun;
      return reply(
        (dryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label} — ${changes.length} alteração(ões) aplicada(s).`) +
        `\n\n${formatJson({ changes, warnings, update_mask: mask })}`
      );
    }
  );

  ctx.mcp.registerTool(
    "assign_bidding_strategy",
    {
      description: [
        "Vincula campanhas a uma estratégia de portfólio (da conta ou de MCC compartilhada com ela).",
        "WRITE OPERATION — troca a estratégia de lance das campanhas (reinicia o aprendizado; os alvos próprios da",
        "campanha deixam de valer). Sem confirm: true só mostra a prévia (antes → depois) e não grava.",
        "Para voltar a uma estratégia padrão use update_campaign com biddingStrategy.",
        "Estratégia de MCC: só o MCC dono (login-customer-id) consegue vincular; a moeda precisa ser a mesma.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID das campanhas."),
        campaignIds: flexArray(z.string()).describe("IDs das campanhas (até 100)."),
        biddingStrategyId: z.string().describe("ID da estratégia de portfólio (list_bidding_strategies)."),
        confirm: z.boolean().optional().describe("true para aplicar. Sem ele, só a prévia."),
      },
    },
    async ({ customerId, campaignIds, biddingStrategyId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const ids = idList(campaignIds);
      const problems: string[] = [];
      if (!NUMERIC_ID.test(biddingStrategyId)) problems.push(`biddingStrategyId deve ser numérico (recebido "${biddingStrategyId}")`);
      if (ids.length === 0) problems.push("informe campaignIds");
      if (ids.length > 100) problems.push("no máximo 100 campanhas por chamada");
      const bad = ids.filter((id) => !NUMERIC_ID.test(id));
      if (bad.length) problems.push(`campaignIds devem ser numéricos: ${bad.join(", ")}`);
      if (problems.length) return fail(`Nada foi alterado:\n- ${problems.join("\n- ")}`);

      const client = ctx.getClient();
      // Portfólio da própria conta ou de MCC (accessible_bidding_strategy).
      let strategyResource: string;
      let strategyLabel: string;
      let alignedBudgetId = "";
      const ownedStrategy = await readStrategy(client, customerId, biddingStrategyId);
      if (ownedStrategy) {
        if (ownedStrategy.status === "REMOVED") return fail(`Estratégia ${biddingStrategyId} ("${ownedStrategy.name}") está removida. Nada foi alterado.`);
        strategyResource = String(ownedStrategy.resourceName ?? `customers/${cid}/biddingStrategies/${biddingStrategyId}`);
        strategyLabel = `"${ownedStrategy.name}" (${ownedStrategy.type})`;
        if (num(ownedStrategy.alignedCampaignBudgetId) > 0) alignedBudgetId = String(ownedStrategy.alignedCampaignBudgetId);
      } else {
        const sharedRows = await client.searchStream(customerId,
          `SELECT accessible_bidding_strategy.id, accessible_bidding_strategy.name, accessible_bidding_strategy.type,
                  accessible_bidding_strategy.owner_customer_id, accessible_bidding_strategy.owner_descriptive_name
           FROM accessible_bidding_strategy
           WHERE accessible_bidding_strategy.id = ${biddingStrategyId}`);
        const abs = obj(sharedRows[0]?.accessibleBiddingStrategy);
        if (!abs.id) {
          return fail(`Estratégia ${biddingStrategyId} não existe nesta conta nem foi compartilhada com ela por um MCC. Nada foi alterado.`);
        }
        const owner = String(abs.ownerCustomerId ?? "");
        if (!NUMERIC_ID.test(owner)) return fail(`Não consegui identificar o MCC dono da estratégia ${biddingStrategyId}. Nada foi alterado.`);
        strategyResource = `customers/${owner}/biddingStrategies/${biddingStrategyId}`;
        strategyLabel = `"${abs.name}" (${abs.type}, MCC ${abs.ownerDescriptiveName ?? ""} ${owner})`;
      }

      const campaigns = await readCampaigns(client, customerId, ids);
      const missing = ids.filter((id) => !campaigns.has(id));
      const removed = ids.filter((id) => campaigns.get(id)?.status === "REMOVED");
      if (missing.length || removed.length) {
        return fail(`Nada foi alterado:${missing.length ? `\n- não encontradas: ${missing.join(", ")}` : ""}${removed.length ? `\n- removidas: ${removed.join(", ")}` : ""}`);
      }
      if (alignedBudgetId) {
        const offBudget = ids.filter((id) => lastSegment(campaigns.get(id)?.campaignBudget) !== alignedBudgetId);
        if (offBudget.length) {
          return fail(`A estratégia está alinhada ao orçamento compartilhado ${alignedBudgetId}: só campanhas que usam esse orçamento podem entrar. Fora dele: ${offBudget.join(", ")}. Nada foi alterado.`);
        }
      }
      const already = ids.filter((id) => String(campaigns.get(id)?.biddingStrategy ?? "") === strategyResource);
      const toChange = ids.filter((id) => !already.includes(id));
      const plan = toChange.map((id) => {
        const campaign = campaigns.get(id) ?? {};
        const current = String(campaign.biddingStrategy ?? "");
        return {
          campaign_id: id, name: campaign.name, status: campaign.status,
          before: current ? `PORTFÓLIO ${current}` : `PADRÃO ${campaign.biddingStrategyType}`,
          after: `PORTFÓLIO ${strategyResource}`,
        };
      });
      if (toChange.length === 0) {
        return reply(`Todas as campanhas já usam a estratégia ${strategyLabel}. Nenhuma escrita foi enviada.`);
      }
      const warnings = [
        "Trocar a estratégia reinicia o período de aprendizado do lance automático.",
        "Alvos próprios da campanha (CPA/ROAS) deixam de valer; e o ROAS alvo por grupo não pode ser usado com portfólio.",
      ];
      if (confirm !== true) {
        return fail(
          `Prévia — ${toChange.length} campanha(s) passariam para a estratégia ${strategyLabel}. Repita com confirm: true para aplicar. Nada foi gravado.\n\n` +
          formatJson({ plan, already_assigned: already, warnings })
        );
      }
      const operations = toChange.map((id) => ({
        update: { resourceName: `customers/${cid}/campaigns/${id}`, biddingStrategy: strategyResource },
        updateMask: "bidding_strategy",
      }));
      let response: Row;
      try {
        response = await client.mutate(customerId, "campaigns", operations, { partialFailure: true });
      } catch (err) {
        const message = (err as Error).message;
        const hint = strategyResource.startsWith(`customers/${cid}/`) ? "" :
          "\nEstratégia de MCC: a chamada precisa usar o login-customer-id do MCC dono (ou de um MCC acima dele), e a campanha precisa estar na mesma moeda.";
        return fail(`A API recusou o vínculo. Nada foi alterado.\nErro: ${message}${hint}`);
      }
      const dryRun = client.isDryRun;
      const results = list<Row>(response.results);
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, operations.length);
      const assigned: Row[] = [];
      const errors: Row[] = [];
      plan.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...item, error: opErrors.join("; ") });
        else if (!dryRun && !obj(results[index]).resourceName) errors.push({ ...item, error: "a API não confirmou a alteração" });
        else assigned.push(item);
      });
      for (const message of unattributed) errors.push({ error: message });
      return reply(
        (dryRun ? `DRY-RUN (validateOnly): nada foi alterado. Validadas: ${assigned.length}` : `${assigned.length} campanha(s) agora usam a estratégia ${strategyLabel}`) +
        ` | Já estavam: ${already.length} | Com erro: ${errors.length}\n\n` +
        formatJson({ [dryRun ? "validated" : "assigned"]: assigned, already_assigned: already, errors, warnings }),
        errors.length > 0
      );
    }
  );

  ctx.mcp.registerTool(
    "remove_bidding_strategy",
    {
      description: [
        "Remove uma estratégia de portfólio SEM campanhas vinculadas. WRITE OPERATION — exige confirm: true.",
        "Com campanhas ativas a API recusa (CANNOT_REMOVE_ASSOCIATED_STRATEGY): mova-as antes (update_campaign",
        "com biddingStrategy, ou assign_bidding_strategy para outro portfólio).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID dono da estratégia."),
        biddingStrategyId: z.string().describe("ID da estratégia."),
        confirm: z.boolean().describe("true para confirmar."),
      },
    },
    async ({ customerId, biddingStrategyId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (confirm !== true) return fail("Remoção exige confirm: true. Nada foi removido.");
      if (!NUMERIC_ID.test(biddingStrategyId)) return fail(`biddingStrategyId deve ser numérico, recebido "${biddingStrategyId}". Nada foi removido.`);
      const client = ctx.getClient();
      const bs = await readStrategy(client, customerId, biddingStrategyId);
      if (!bs) return fail(`Estratégia ${biddingStrategyId} não encontrada na conta ${cid}. Nada foi removido.`);
      if (bs.status === "REMOVED") return reply(`Estratégia ${biddingStrategyId} ("${bs.name}") já está removida. Nenhuma escrita foi enviada.`);
      const active = num(bs.nonRemovedCampaignCount);
      if (active > 0) {
        return fail(`Estratégia ${biddingStrategyId} ("${bs.name}") ainda tem ${active} campanha(s) ativa(s) — a API recusa (CANNOT_REMOVE_ASSOCIATED_STRATEGY). Mova as campanhas antes. Nada foi removido.`);
      }
      const resourceName = String(bs.resourceName ?? `customers/${cid}/biddingStrategies/${biddingStrategyId}`);
      try {
        await client.mutate(customerId, "biddingStrategies", [{ remove: resourceName }]);
      } catch (err) {
        return fail(`A API recusou a remoção de ${resourceName}. Nada foi removido.\nErro: ${(err as Error).message}`);
      }
      return reply(client.isDryRun
        ? `DRY-RUN (validateOnly): remoção de ${resourceName} ("${bs.name}") validada — nada foi removido.`
        : `Estratégia ${resourceName} ("${bs.name}", ${bs.type}) removida.`);
    }
  );

  // ── Alvos por grupo de anúncios ────────────────────────────────────

  ctx.mcp.registerTool(
    "get_ad_group_bid_targets",
    {
      description: [
        "Lances e alvos efetivos por grupo de anúncios: CPC, CPA alvo e ROAS alvo do grupo (override) ao lado",
        "do valor efetivo e da origem (effective_*_source: CAMPAIGN_BIDDING_STRATEGY, AD_GROUP...). READ-ONLY.",
        "Mostra quais grupos têm override e qual estratégia a campanha usa. Ajuste com update_ad_group",
        "(targetCpaMicros / targetRoas / clearTargetCpa / clearTargetRoas).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        adGroupIds: flexArray(z.string()).optional().describe("Filtra por grupos."),
        onlyOverrides: z.boolean().optional().describe("Só grupos com CPA/ROAS alvo próprio. Default: false."),
        limit: z.number().optional().describe("Máximo de grupos. Default: 500."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, adGroupIds, onlyOverrides, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const groups = idList(adGroupIds);
      const problems: string[] = [];
      if (campaignId !== undefined && !NUMERIC_ID.test(campaignId)) problems.push(`campaignId deve ser numérico (recebido "${campaignId}")`);
      const bad = groups.filter((id) => !NUMERIC_ID.test(id));
      if (bad.length) problems.push(`adGroupIds devem ser numéricos: ${bad.join(", ")}`);
      const max = limit ?? 500;
      if (!Number.isInteger(max) || max < 1 || max > 10_000) problems.push(`limit deve ser inteiro entre 1 e 10000 (recebido ${limit})`);
      if (problems.length) return fail(`Nada foi consultado:\n- ${problems.join("\n- ")}`);
      const where = ["ad_group.status != 'REMOVED'", "campaign.status != 'REMOVED'"];
      if (campaignId) where.push(`campaign.id = ${campaignId}`);
      if (groups.length) where.push(`ad_group.id IN (${groups.join(", ")})`);
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign.bidding_strategy,
                ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, ad_group.effective_cpc_bid_micros,
                ad_group.target_cpa_micros, ad_group.effective_target_cpa_micros, ad_group.effective_target_cpa_source,
                ad_group.target_roas, ad_group.effective_target_roas, ad_group.effective_target_roas_source
         FROM ad_group
         WHERE ${where.join(" AND ")}
         ORDER BY campaign.id, ad_group.id
         LIMIT ${max}`);
      const out = rows
        .map((row) => {
          const campaign = obj(row.campaign);
          const adGroup = obj(row.adGroup);
          return {
            campaign_id: String(campaign.id ?? ""),
            campaign: campaign.name,
            strategy: campaign.biddingStrategy ? `PORTFÓLIO ${lastSegment(campaign.biddingStrategy)} (${campaign.biddingStrategyType})` : campaign.biddingStrategyType,
            ad_group_id: String(adGroup.id ?? ""),
            ad_group: adGroup.name,
            status: adGroup.status,
            cpc_bid: num(adGroup.cpcBidMicros) > 0 ? money(adGroup.cpcBidMicros) : null,
            effective_cpc_bid: num(adGroup.effectiveCpcBidMicros) > 0 ? money(adGroup.effectiveCpcBidMicros) : null,
            target_cpa_override: num(adGroup.targetCpaMicros) > 0 ? money(adGroup.targetCpaMicros) : null,
            effective_target_cpa: num(adGroup.effectiveTargetCpaMicros) > 0 ? money(adGroup.effectiveTargetCpaMicros) : null,
            effective_target_cpa_source: adGroup.effectiveTargetCpaSource ?? null,
            target_roas_override: num(adGroup.targetRoas) > 0 ? round2(num(adGroup.targetRoas)) : null,
            effective_target_roas: num(adGroup.effectiveTargetRoas) > 0 ? round2(num(adGroup.effectiveTargetRoas)) : null,
            effective_target_roas_source: adGroup.effectiveTargetRoasSource ?? null,
          };
        })
        .filter((row) => !onlyOverrides || row.target_cpa_override !== null || row.target_roas_override !== null);
      const overrides = out.filter((row) => row.target_cpa_override !== null || row.target_roas_override !== null).length;
      return tabular(out, format,
        `${out.length} grupo(s), ${overrides} com CPA/ROAS alvo próprio (override).${rows.length === max ? ` Limite de ${max} atingido — use campaignId ou limit.` : ""}`,
        out);
    }
  );
}
