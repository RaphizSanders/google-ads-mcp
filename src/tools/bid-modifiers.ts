/**
 * Lote bid-modifiers: ajustes de lance, programação de anúncios (dayparting), segmentação
 * demográfica e de dispositivo, e limite de frequência.
 *
 * Tudo aqui segue "ler antes de gravar": a tool confere o que já existe na conta, envia só o
 * que muda (update com updateMask bid_modifier quando o critério existe, create quando não
 * existe, nada quando o valor já está aplicado) e devolve antes/depois.
 *
 * As seis tools que já existiam em src/tools.ts (set_location_bid_adjustment,
 * set_device_bid_adjustment, set_age_bid_adjustment, set_gender_bid_adjustment,
 * set_ad_schedule e get_device_breakdown) foram reescritas aqui; os nomes continuam
 * classificados em src/read-only.ts. As novas estão em bid-modifiers.catalog.ts.
 *
 * Fontes (v25): resources/campaign_criterion.proto e ad_group_criterion.proto (bid_modifier
 * 0.1–10.0; 0 só para dispositivo; negative é IMMUTABLE), resources/ad_group_bid_modifier.proto,
 * common/criteria.proto (AdScheduleInfo: campos proibidos em UPDATE, no máximo 6 por dia),
 * common/frequency_cap.proto, errors/criterion_error.proto, campaign_error.proto e
 * mutate_error.proto (ID_EXISTS_IN_MULTIPLE_MUTATES: trocar positivo ↔ negativo de um critério de
 * ID fixo é remove + create do mesmo recurso, então vai em duas requisições — ver CriteriaPlan).
 * Limite de frequência só em Display: a API não altera campanhas de Vídeo
 * (developers.google.com/google-ads/api/docs/video/overview).
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
  metricsView,
  microsToMoney,
  num,
  partialFailureByOperation,
  round2,
  text,
} from "../tool-kit.js";
import type { MetricTotals, ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<ReturnType<typeof text>>; isError?: boolean };

// ── Constantes ───────────────────────────────────────────────────────

const ID = /^\d+$/;

/** Faixa de bid_modifier documentada nos protos v25 (campaign_criterion, ad_group_criterion, ad_group_bid_modifier). */
export const MIN_BID_MODIFIER = 0.1;
export const MAX_BID_MODIFIER = 10;

/** common/criteria.proto: "No more than six AdSchedules can be added for the same day." */
export const MAX_SCHEDULES_PER_DAY = 6;

/** Estratégias Smart Bidding: não usam ajustes de lance manuais (exceto -100% em dispositivo). */
export const SMART_BIDDING = new Set(["TARGET_CPA", "TARGET_ROAS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]);

const DEVICES = ["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV"] as const;
type Device = (typeof DEVICES)[number];
/** Pelo menos um destes precisa continuar veiculando. */
const CORE_DEVICES: string[] = ["MOBILE", "DESKTOP", "TABLET"];

const WEEK = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const DAY_PT: Record<string, string> = {
  MONDAY: "segunda", TUESDAY: "terça", WEDNESDAY: "quarta", THURSDAY: "quinta",
  FRIDAY: "sexta", SATURDAY: "sábado", SUNDAY: "domingo",
};
/** Atalhos aceitos em dayOfWeek, expandidos antes de validar. */
const DAY_GROUPS: Record<string, string[]> = {
  WEEKDAYS: WEEK.slice(0, 5),
  WEEKEND: ["SATURDAY", "SUNDAY"],
  ALL_DAYS: [...WEEK],
};
const MINUTES = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 } as const;
type MinuteEnum = keyof typeof MINUTES;
// Fábrica: a mesma instância zod duas vezes numa tool vira "$ref" cruzado no JSON Schema publicado.
const MINUTE_ENUM = () => z.enum(["ZERO", "FIFTEEN", "THIRTY", "FORTY_FIVE"]);
const DAY_ENUM = z.enum([...WEEK, "WEEKDAYS", "WEEKEND", "ALL_DAYS"]);

/** Dimensões demográficas (enums v25: age_range_type, gender_type, parental_status_type, income_range_type). */
export const DEMOGRAPHIC_DIMENSIONS = {
  AGE_RANGE: {
    field: "age_range",
    key: "ageRange",
    prefix: "AGE_RANGE_",
    undetermined: "AGE_RANGE_UNDETERMINED",
    values: [
      "AGE_RANGE_18_24", "AGE_RANGE_25_34", "AGE_RANGE_35_44", "AGE_RANGE_45_54",
      "AGE_RANGE_55_64", "AGE_RANGE_65_UP", "AGE_RANGE_UNDETERMINED",
    ],
  },
  GENDER: {
    field: "gender",
    key: "gender",
    prefix: "",
    undetermined: "UNDETERMINED",
    values: ["MALE", "FEMALE", "UNDETERMINED"],
  },
  PARENTAL_STATUS: {
    field: "parental_status",
    key: "parentalStatus",
    prefix: "",
    undetermined: "UNDETERMINED",
    values: ["PARENT", "NOT_A_PARENT", "UNDETERMINED"],
  },
  INCOME_RANGE: {
    field: "income_range",
    key: "incomeRange",
    prefix: "INCOME_RANGE_",
    undetermined: "INCOME_RANGE_UNDETERMINED",
    values: [
      "INCOME_RANGE_0_50", "INCOME_RANGE_50_60", "INCOME_RANGE_60_70", "INCOME_RANGE_70_80",
      "INCOME_RANGE_80_90", "INCOME_RANGE_90_UP", "INCOME_RANGE_UNDETERMINED",
    ],
  },
} as const;
type Dimension = keyof typeof DEMOGRAPHIC_DIMENSIONS;
const DIMENSION_PT: Record<Dimension, string> = {
  AGE_RANGE: "faixa etária",
  GENDER: "gênero",
  PARENTAL_STATUS: "status parental",
  INCOME_RANGE: "renda familiar",
};

// ── Helpers ──────────────────────────────────────────────────────────

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** customerId sem traços e só com dígitos (entra em resource names). */
function normalizeCid(customerId: string): string | null {
  const cid = String(customerId ?? "").replace(/-/g, "");
  return ID.test(cid) ? cid : null;
}

/** Erro de faixa do bid_modifier, ou null se o valor é aceito. */
export function modifierError(
  value: unknown,
  label: string,
  opts: { allowZero?: boolean; zeroHint?: string } = {}
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${label} precisa ser um número (1.0 = sem ajuste, 1.3 = +30%, 0.7 = -30%).`;
  }
  if (value === 0) {
    if (opts.allowZero) return null;
    return `${label} = 0 não é aceito aqui: a faixa da API é ${MIN_BID_MODIFIER}–${MAX_BID_MODIFIER}. ${opts.zeroHint ?? ""}`.trim();
  }
  if (value < MIN_BID_MODIFIER || value > MAX_BID_MODIFIER) {
    return `${label} fora da faixa: ${value}. Use ${MIN_BID_MODIFIER} a ${MAX_BID_MODIFIER} (1.0 = sem ajuste, 1.3 = +30%, 0.7 = -30%)` +
      `${opts.allowZero ? " ou 0 para excluir (-100%)" : ""}.`;
  }
  return null;
}

/** "+30% (1.3)", "-100% (excluído)", "sem ajuste (1.0)". */
export function describeModifier(value: number | undefined): string {
  if (value === undefined) return "sem ajuste (1.0)";
  if (value === 0) return "excluído (-100%)";
  const pct = Math.round((value - 1) * 1000) / 10;
  if (pct === 0) return "sem ajuste (1.0)";
  return `${pct > 0 ? "+" : ""}${pct}% (${round4(value)})`;
}

function modifierOf(criterion: Row | undefined): number | undefined {
  const raw = criterion?.bidModifier;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** bid_modifier é float na API: 1.2 volta como 1.2000000476837158. Ausente = 1.0. */
const sameModifier = (current: number | undefined, wanted: number) => Math.abs((current ?? 1) - wanted) < 1e-4;

function smartBiddingWarning(bidding: string): string | null {
  return SMART_BIDDING.has(bidding)
    ? `A campanha usa ${bidding} (Smart Bidding): ajustes de lance manuais ficam gravados mas o Smart Bidding não os usa ` +
      "(a única exceção é -100% em dispositivo). Exclusões e a programação em si continuam valendo."
    : null;
}

function writeStatus(client: GoogleAdsClient, subject: string): string {
  return client.isDryRun
    ? `${subject} — DRY-RUN (validateOnly): validado na API, nada foi gravado.`
    : `${subject} — gravado.`;
}

/** Códigos e mensagens da API (errors/*.proto v25) → explicação em PT-BR. */
const API_HINTS: Array<[RegExp, string]> = [
  [/BID_MODIFIER_ALREADY_EXISTS|Bid Modifier already exists/i, "O ajuste já existia (a API pede update, não create); rode list_bid_modifiers e repita."],
  [/CANNOT_ADD_EXISTING_FIELD|can't be updated with CREATE/i, "O critério já existe: ele precisa ser atualizado, não criado de novo."],
  [/CANNOT_EXCLUDE_ALL_TARGETS|exclude all demographic/i, "A API não deixa excluir todos os valores de uma dimensão demográfica."],
  [/CANNOT_TARGET_ONLY_UNDETERMINED|only targeting the "?undetermined"?/i, "A combinação deixaria só o segmento \"desconhecido\" — a API proíbe."],
  [/AD_SCHEDULE_TIME_INTERVALS_OVERLAP|overlaps with another AdSchedule/i, "Dois horários do mesmo dia se sobrepõem."],
  [/AD_SCHEDULE_EXCEEDED_INTERVALS_PER_DAY_LIMIT|entries in a day exceeds/i, `Máximo de ${MAX_SCHEDULES_PER_DAY} horários por dia.`],
  [/AD_SCHEDULE_INVALID_TIME_INTERVAL|endTime cannot be earlier/i, "O fim do horário precisa ser depois do início."],
  [/AD_SCHEDULE_INTERVAL_CANNOT_SPAN_MULTIPLE_DAYS|span multiple days/i, "Um horário não pode atravessar a meia-noite: divida em dois dias."],
  [/CANNOT_BID_MODIFY_NEGATIVE_CRITERION|bid modifier for a negative criterion/i, "Critério excluído (negativo) não aceita ajuste de lance."],
  [/CANNOT_BID_MODIFY_CRITERION_TYPE|Cannot set bid modifier for this criterion type/i, "Este tipo de campanha não aceita ajuste de lance para esse critério."],
  [/CANNOT_BID_MODIFY_CRITERION_CAMPAIGN_OPTED_OUT|opted out of the campaign/i, "A campanha exclui esse critério (-100%): ajuste primeiro no nível da campanha."],
  [/CANNOT_OVERRIDE_OPTED_OUT_CAMPAIGN_CRITERION_BID_MODIFIER/i, "A campanha exclui esse dispositivo (-100%); o grupo não pode sobrepor. Altere na campanha."],
  [/CRITERIA_TYPE_INVALID_FOR_BIDDING_STRATEGY/i, "A estratégia de lance da campanha não aceita esse critério."],
  [/CANNOT_TARGET_AND_EXCLUDE|target and exclude the same/i, "Não dá para segmentar e excluir o mesmo valor ao mesmo tempo."],
  [/CANNOT_REMOVE_CRITERION|not allowed to be removed/i, "Esse critério não pode ser removido (dispositivos: use ajuste 0 ou 1.0)."],
  [/CANNOT_EXCLUDE_CRITERION|not allowed to be excluded/i, "Esse critério não pode ser excluído neste tipo de campanha."],
  [/MAX_IMPRESSIONS_NOT_IN_RANGE/i, "O limite de frequência (cap) precisa ser inteiro maior que 0."],
  [/TIME_UNIT_NOT_SUPPORTED/i, "O limite de frequência só aceita DAY, WEEK e MONTH."],
  [/OPERATION_NOT_PERMITTED_FOR_CONTEXT|not allowed for the given context/i, "A API não permite essa operação neste tipo de campanha."],
  [/ID_EXISTS_IN_MULTIPLE_MUTATES|same resource twice in one request/i,
    "A requisição mexia duas vezes no mesmo critério (ex.: remove + create do mesmo valor). A tool separa essas trocas em duas requisições; repita a chamada."],
];

export function explainApiError(message: string): string {
  const hints = API_HINTS.filter(([pattern]) => pattern.test(message)).map(([, hint]) => hint);
  return hints.length ? `${message}\nO que significa: ${hints.join(" ")}` : message;
}

/** Mutate atômico (sem partialFailure): ou tudo é aplicado, ou nada. */
async function mutateAtomic(
  client: GoogleAdsClient,
  customerId: string,
  resource: string,
  operations: MutateOperation[]
): Promise<{ response?: Row; error?: string }> {
  try {
    return { response: await client.mutate(customerId, resource, operations) };
  } catch (err) {
    return { error: explainApiError((err as Error).message) };
  }
}

/**
 * Plano de escrita de critérios de dispositivo/demografia.
 *
 * Esses critérios têm criterion_id fixo (AGE_RANGE_18_24 = 503001, MOBILE = 30001...), então o
 * resource name é sempre {pai}~{id}. Como `negative` é IMMUTABLE, trocar positivo ↔ negativo é
 * remove + create do MESMO recurso — e a API recusa mutar o mesmo recurso duas vezes numa
 * requisição (errors/mutate_error.proto: ID_EXISTS_IN_MULTIPLE_MUTATES, "Cannot mutate the same
 * resource twice in one request"). Por isso essas trocas vão em duas requisições ordenadas.
 */
interface CriteriaPlan {
  /** Todas as operações, na ordem de envio. */
  operations: MutateOperation[];
  /** remove que libera o recurso para um create da etapa 2 (vai sozinho na etapa 1). */
  replaced: Set<MutateOperation>;
  /** create que recria um recurso removido na etapa 1 (só pode ir depois dela). */
  dependent: Set<MutateOperation>;
}

interface PlanOutcome {
  /** 1 = uma requisição atômica; 2 = remoções primeiro, o resto depois. */
  requests: 1 | 2;
  responses: Row[];
  error?: string;
  failedStep?: 1 | 2;
  /** validateOnly: creates que dependem da remoção da etapa 1 e por isso não foram enviados. */
  notValidated: MutateOperation[];
}

const newPlan = (): CriteriaPlan => ({ operations: [], replaced: new Set(), dependent: new Set() });

async function executePlan(client: GoogleAdsClient, customerId: string, resource: string, plan: CriteriaPlan): Promise<PlanOutcome> {
  if (plan.replaced.size === 0) {
    const { response, error } = await mutateAtomic(client, customerId, resource, plan.operations);
    return error
      ? { requests: 1, responses: [], error, failedStep: 1, notValidated: [] }
      : { requests: 1, responses: [response as Row], notValidated: [] };
  }
  const first = plan.operations.filter((op) => plan.replaced.has(op));
  const rest = plan.operations.filter((op) => !plan.replaced.has(op));
  const one = await mutateAtomic(client, customerId, resource, first);
  if (one.error) return { requests: 2, responses: [], error: one.error, failedStep: 1, notValidated: [] };
  // validateOnly não remove nada: o create que recria o mesmo recurso seria recusado por um
  // motivo falso ("já existe"). Ele não é enviado e a resposta diz que não foi validado.
  const notValidated = client.isDryRun ? rest.filter((op) => plan.dependent.has(op)) : [];
  const second = client.isDryRun ? rest.filter((op) => !plan.dependent.has(op)) : rest;
  if (second.length === 0) return { requests: 2, responses: [one.response as Row], notValidated };
  const two = await mutateAtomic(client, customerId, resource, second);
  if (two.error) return { requests: 2, responses: [one.response as Row], error: two.error, failedStep: 2, notValidated };
  return { requests: 2, responses: [one.response as Row, two.response as Row], notValidated };
}

/**
 * Mensagem de erro de um plano. Etapa 2 recusada fora do dry-run = gravação parcial: diz o que
 * ficou gravado e o estado em que cada item ficou.
 */
function planFailure(
  client: GoogleAdsClient,
  subject: string,
  outcome: PlanOutcome,
  leftBehind: string[]
): ToolResult {
  if (outcome.failedStep === 1) {
    const how = outcome.requests === 1 ? "operação atômica" : "etapa 1 de 2 — nada foi enviado depois dela";
    return fail(`${subject}: a API recusou — nada foi gravado (${how}).\n${outcome.error}`);
  }
  if (client.isDryRun) {
    return fail(`${subject}: DRY-RUN (validateOnly) — a etapa 1 (remoção) foi validada, a etapa 2 foi recusada na validação. ` +
      `Nada foi gravado.\n${outcome.error}`);
  }
  return fail(`${subject}: GRAVAÇÃO PARCIAL. A etapa 1 (remoção) foi gravada e a etapa 2 foi recusada pela API.\n` +
    `Estado atual:\n- ${leftBehind.join("\n- ")}\n` +
    "Repita a mesma chamada para concluir: a tool relê a conta e envia só o que falta.\n" +
    `Erro da etapa 2:\n${outcome.error}`);
}

/** Linha de status do sucesso (inclui os creates que o validateOnly não pôde validar). */
function planStatus(client: GoogleAdsClient, subject: string, outcome: PlanOutcome, describeOp: (op: MutateOperation) => string): string {
  if (client.isDryRun && outcome.notValidated.length) {
    return `${subject} — DRY-RUN (validateOnly): a etapa 1 (remoção) foi validada na API; ` +
      `${outcome.notValidated.map(describeOp).join(", ")} não pôde ser validado — recria o critério removido na etapa 1, ` +
      "e em validateOnly nada é removido de fato. Nada foi gravado.";
  }
  return writeStatus(client, subject);
}

const planResult = (outcome: PlanOutcome) => (outcome.requests === 1 ? outcome.responses[0] : outcome.responses);

// ── Leitura de campanha / grupo ──────────────────────────────────────

interface CampaignInfo {
  id: string;
  name: string;
  status: string;
  channel: string;
  bidding: string;
  resourceName: string;
}

async function fetchCampaign(client: GoogleAdsClient, customerId: string, cid: string, campaignId: string): Promise<CampaignInfo | null> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.bidding_strategy_type
     FROM campaign
     WHERE campaign.id = ${campaignId}`);
  const campaign = rows[0]?.campaign as Row | undefined;
  if (!campaign) return null;
  return {
    id: String(campaign.id ?? campaignId),
    name: String(campaign.name ?? ""),
    status: String(campaign.status ?? ""),
    channel: String(campaign.advertisingChannelType ?? ""),
    bidding: String(campaign.biddingStrategyType ?? ""),
    resourceName: `customers/${cid}/campaigns/${campaignId}`,
  };
}

function campaignProblem(campaign: CampaignInfo | null, campaignId: string, cid: string): string | null {
  if (!campaign) return `Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi alterado.`;
  if (campaign.status === "REMOVED") return `A campanha ${campaignId} (${campaign.name}) está removida. Nada foi alterado.`;
  return null;
}

interface AdGroupInfo {
  id: string;
  name: string;
  status: string;
  resourceName: string;
  campaign: CampaignInfo;
}

async function fetchAdGroup(client: GoogleAdsClient, customerId: string, cid: string, adGroupId: string): Promise<AdGroupInfo | null> {
  const rows = await client.searchStream(customerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name, campaign.status,
            campaign.advertising_channel_type, campaign.bidding_strategy_type
     FROM ad_group
     WHERE ad_group.id = ${adGroupId}`);
  const adGroup = rows[0]?.adGroup as Row | undefined;
  if (!adGroup) return null;
  const campaign = (rows[0]?.campaign ?? {}) as Row;
  const campaignId = String(campaign.id ?? "");
  return {
    id: String(adGroup.id ?? adGroupId),
    name: String(adGroup.name ?? ""),
    status: String(adGroup.status ?? ""),
    resourceName: `customers/${cid}/adGroups/${adGroupId}`,
    campaign: {
      id: campaignId,
      name: String(campaign.name ?? ""),
      status: String(campaign.status ?? ""),
      channel: String(campaign.advertisingChannelType ?? ""),
      bidding: String(campaign.biddingStrategyType ?? ""),
      resourceName: `customers/${cid}/campaigns/${campaignId}`,
    },
  };
}

function adGroupProblem(adGroup: AdGroupInfo | null, adGroupId: string, cid: string): string | null {
  if (!adGroup) return `Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi alterado.`;
  if (adGroup.status === "REMOVED") return `O grupo ${adGroupId} (${adGroup.name}) está removido. Nada foi alterado.`;
  if (adGroup.campaign.status === "REMOVED") return `A campanha do grupo ${adGroupId} está removida. Nada foi alterado.`;
  return null;
}

const campaignView = (campaign: CampaignInfo) => ({
  id: campaign.id, name: campaign.name, channel: campaign.channel, bidding: campaign.bidding,
});

// ── Dispositivos ─────────────────────────────────────────────────────

interface DeviceCriterion {
  resourceName: string;
  device: string;
  bidModifier?: number;
  negative: boolean;
}

async function fetchCampaignDevices(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<Map<string, DeviceCriterion>> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id, campaign_criterion.device.type,
            campaign_criterion.bid_modifier, campaign_criterion.negative, campaign_criterion.status
     FROM campaign_criterion
     WHERE campaign.id = ${campaignId}
       AND campaign_criterion.type = 'DEVICE'
       AND campaign_criterion.status != 'REMOVED'`);
  const devices = new Map<string, DeviceCriterion>();
  for (const row of rows) {
    const criterion = (row.campaignCriterion ?? {}) as Row;
    const device = String(((criterion.device ?? {}) as Row).type ?? "");
    if (!device) continue;
    devices.set(device, {
      resourceName: String(criterion.resourceName ?? ""),
      device,
      bidModifier: modifierOf(criterion),
      negative: criterion.negative === true,
    });
  }
  return devices;
}

const deviceOff = (criterion: DeviceCriterion | undefined) => !!criterion && (criterion.negative || criterion.bidModifier === 0);

/**
 * Ajuste de lance de dispositivo na campanha (fora de PMax): update quando o critério
 * DEVICE já existe, create quando não existe. target "INCLUDE" = voltar a veicular (1.0)
 * só se estiver em 0.
 */
async function applyCampaignDeviceModifier(
  client: GoogleAdsClient,
  customerId: string,
  campaign: CampaignInfo,
  device: string,
  target: number | "INCLUDE"
): Promise<ToolResult> {
  const devices = await fetchCampaignDevices(client, customerId, campaign.id);
  const current = devices.get(device);
  const before = current?.bidModifier;
  const subject = `Campanha ${campaign.id} (${campaign.name}) — ${device}`;
  if (current?.negative) {
    return fail(`${subject}: o dispositivo está excluído por critério negativo; ajuste de lance não se aplica. ` +
      "Use set_device_targeting com action INCLUDE antes. Nada foi alterado.");
  }
  let wanted: number;
  if (target === "INCLUDE") {
    if (!deviceOff(current)) {
      return { content: [text(`${subject}: já veicula (${describeModifier(before)}). Nenhuma escrita foi enviada.`)] };
    }
    wanted = 1;
  } else {
    wanted = target;
  }
  if (sameModifier(before, wanted)) {
    return { content: [text(`${subject}: nada a mudar — já está em ${describeModifier(before)}. Nenhuma escrita foi enviada.`)] };
  }
  if (wanted === 0 && CORE_DEVICES.includes(device)) {
    const stillOn = CORE_DEVICES.filter((d) => d !== device && !deviceOff(devices.get(d)));
    if (stillOn.length === 0) {
      return fail(`${subject}: excluir este dispositivo deixaria a campanha sem veicular em computador, celular e tablet. ` +
        "Nada foi alterado.");
    }
  }

  const operation: MutateOperation = current
    ? { update: { resourceName: current.resourceName, bidModifier: wanted }, updateMask: "bid_modifier" }
    : { create: { campaign: campaign.resourceName, device: { type: device }, bidModifier: wanted } };
  const { response, error } = await mutateAtomic(client, customerId, "campaignCriteria", [operation]);
  if (error) return fail(`${subject}: a API recusou — nada foi gravado.\n${error}`);
  const warnings: string[] = [];
  const smart = wanted !== 0 ? smartBiddingWarning(campaign.bidding) : null;
  if (smart) warnings.push(smart);
  return {
    content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
      campaign: campaignView(campaign),
      device,
      operation: current ? "update" : "create",
      before: describeModifier(before),
      after: describeModifier(wanted),
      warnings,
      result: response,
    })}`)],
  };
}

/**
 * PMax: dispositivo é critério positivo/negativo da campanha, sem ajuste de lance.
 *
 * Com algum critério DEVICE positivo a campanha é restrita (só veicula nos positivos). O estado
 * "restrita" é lido ANTES da mudança: se a mudança tirasse o último positivo, a campanha deixaria
 * de ser restrita e passaria a veicular em todos os outros dispositivos — o contrário do pedido.
 */
async function applyPmaxDeviceTargeting(
  client: GoogleAdsClient,
  customerId: string,
  campaign: CampaignInfo,
  device: string,
  action: "EXCLUDE" | "INCLUDE"
): Promise<ToolResult> {
  const devices = await fetchCampaignDevices(client, customerId, campaign.id);
  const current = devices.get(device);
  const subject = `Campanha PMax ${campaign.id} (${campaign.name}) — ${device}`;
  const positives = new Set([...devices.values()].filter((c) => !c.negative).map((c) => c.device));
  const negatives = new Set([...devices.values()].filter((c) => c.negative).map((c) => c.device));
  const restricted = positives.size > 0;
  const positivesBefore = [...positives];
  const plan = newPlan();
  const createOp = (negative: boolean): MutateOperation => ({
    create: { campaign: campaign.resourceName, device: { type: device }, ...(negative ? { negative: true } : {}) },
  });
  let leftBehind = "";
  if (action === "EXCLUDE") {
    if (current?.negative) {
      return { content: [text(`${subject}: já está excluído. Nenhuma escrita foi enviada.`)] };
    }
    if (restricted && positives.has(device) && positives.size === 1) {
      return fail(`${subject}: a campanha segmenta SÓ ${device} (critério positivo). Excluí-lo deixaria a campanha sem ` +
        "nenhum dispositivo segmentado — e, sem critério positivo, ela passaria a veicular em todos os outros " +
        `(${DEVICES.filter((d) => d !== device && !negatives.has(d)).join(", ")}), ampliando o alcance. ` +
        "Para trocar de dispositivo, inclua o novo antes (action INCLUDE) e depois exclua este. Nada foi alterado.");
    }
    const create = createOp(true);
    if (current) {
      // positivo → negativo: mesmo recurso ({campanha}~{id fixo}), então duas requisições.
      const remove: MutateOperation = { remove: current.resourceName };
      plan.operations.push(remove);
      plan.replaced.add(remove);
      plan.dependent.add(create);
      leftBehind = `${device}: o critério positivo foi removido e o negativo não foi criado; a campanha continua ` +
        `restrita aos outros positivos (${positivesBefore.filter((d) => d !== device).join(", ")}).`;
    }
    plan.operations.push(create);
    positives.delete(device);
    negatives.add(device);
  } else {
    if (!current?.negative && (!restricted || positives.has(device))) {
      return { content: [text(`${subject}: já veicula. Nenhuma escrita foi enviada.`)] };
    }
    const needsPositive = restricted && !positives.has(device);
    const create = createOp(false);
    if (current?.negative) {
      const remove: MutateOperation = { remove: current.resourceName };
      plan.operations.push(remove);
      if (needsPositive) {
        // negativo → positivo: mesmo recurso, então duas requisições.
        plan.replaced.add(remove);
        plan.dependent.add(create);
        leftBehind = `${device}: a exclusão foi removida e o critério positivo não foi criado; o dispositivo continua ` +
          `fora (a campanha segmenta só ${positivesBefore.join(", ")}).`;
      }
    }
    negatives.delete(device);
    if (needsPositive) {
      plan.operations.push(create);
      positives.add(device);
    }
  }
  const targeted = (restricted ? [...positives] : [...DEVICES]).filter((d) => !negatives.has(d));
  if (restricted && positives.size === 0) {
    return fail(`${subject}: a mudança tiraria o último dispositivo segmentado e a campanha passaria a veicular em todos. Nada foi alterado.`);
  }
  if (!CORE_DEVICES.some((d) => targeted.includes(d))) {
    return fail(`${subject}: a mudança deixaria a campanha sem veicular em computador, celular e tablet. Nada foi alterado.`);
  }
  const outcome = await executePlan(client, customerId, "campaignCriteria", plan);
  if (outcome.error) return planFailure(client, subject, outcome, [leftBehind]);
  return {
    content: [text(`${planStatus(client, subject, outcome, () => `a criação do critério ${device}`)}\n\n${formatJson({
      campaign: campaignView(campaign),
      device,
      action,
      before: current ? (current.negative ? "excluído" : "segmentado (critério positivo)") : restricted ? "fora da segmentação (a campanha é restrita a outros dispositivos)" : "segmentado (padrão)",
      after: action === "EXCLUDE" ? "excluído" : "segmentado",
      targeted_before: (restricted ? positivesBefore : [...DEVICES]).filter((d) => !(devices.get(d)?.negative)),
      targeted_after: targeted,
      operations: plan.operations.map((op) => (op.remove ? "remove" : "create")),
      requests: outcome.requests,
      ...(outcome.notValidated.length ? { not_validated: [`create ${device}`] } : {}),
      ...(outcome.requests === 2 ? { note: "remove e create do mesmo critério vão em requisições separadas (a API não aceita mutar o mesmo recurso duas vezes numa requisição)" } : {}),
      result: planResult(outcome),
    })}`)],
  };
}

interface AdGroupDeviceModifier {
  resourceName: string;
  bidModifier?: number;
}

async function applyAdGroupDevice(
  client: GoogleAdsClient,
  customerId: string,
  adGroup: AdGroupInfo,
  device: string,
  action: "EXCLUDE" | "INCLUDE" | "BID_ADJUST",
  bidModifier?: number
): Promise<ToolResult> {
  const subject = `Grupo ${adGroup.id} (${adGroup.name}) — ${device}`;
  const campaignDevices = await fetchCampaignDevices(client, customerId, adGroup.campaign.id);
  const rows = await client.searchStream(customerId,
    `SELECT ad_group_bid_modifier.resource_name, ad_group_bid_modifier.criterion_id,
            ad_group_bid_modifier.bid_modifier, ad_group_bid_modifier.device.type
     FROM ad_group_bid_modifier
     WHERE ad_group.id = ${adGroup.id}`);
  const modifiers = new Map<string, AdGroupDeviceModifier>();
  for (const row of rows) {
    const modifier = (row.adGroupBidModifier ?? {}) as Row;
    const type = String(((modifier.device ?? {}) as Row).type ?? "");
    if (type) modifiers.set(type, { resourceName: String(modifier.resourceName ?? ""), bidModifier: modifierOf(modifier) });
  }
  const current = modifiers.get(device);
  const campaignOff = deviceOff(campaignDevices.get(device));
  if (campaignOff) {
    if (action === "EXCLUDE") {
      return { content: [text(`${subject}: a campanha já exclui este dispositivo (-100%). Nenhuma escrita foi enviada.`)] };
    }
    return fail(`${subject}: a campanha exclui este dispositivo (-100%) e o grupo não pode sobrepor ` +
      "(CANNOT_OVERRIDE_OPTED_OUT_CAMPAIGN_CRITERION_BID_MODIFIER). Altere na campanha: set_device_targeting com campaignId. " +
      "Nada foi alterado.");
  }

  let operation: MutateOperation | null = null;
  let after: number | undefined;
  if (action === "INCLUDE") {
    if (current?.bidModifier !== 0) {
      return { content: [text(`${subject}: já veicula (${describeModifier(current?.bidModifier)}). Nenhuma escrita foi enviada.`)] };
    }
    // Remove o -100% do grupo: volta a valer o ajuste da campanha.
    operation = { remove: current.resourceName };
    after = campaignDevices.get(device)?.bidModifier;
  } else {
    const wanted = action === "EXCLUDE" ? 0 : (bidModifier as number);
    if (current && sameModifier(current.bidModifier, wanted)) {
      return { content: [text(`${subject}: nada a mudar — já está em ${describeModifier(current.bidModifier)}. Nenhuma escrita foi enviada.`)] };
    }
    operation = current
      ? { update: { resourceName: current.resourceName, bidModifier: wanted }, updateMask: "bid_modifier" }
      : { create: { adGroup: adGroup.resourceName, device: { type: device }, bidModifier: wanted } };
    after = wanted;
  }

  const effective = (d: string) => {
    if (d === device) return action === "INCLUDE" ? campaignDevices.get(d)?.bidModifier : after;
    if (deviceOff(campaignDevices.get(d))) return 0;
    return modifiers.get(d)?.bidModifier ?? campaignDevices.get(d)?.bidModifier;
  };
  if (!CORE_DEVICES.some((d) => effective(d) !== 0)) {
    return fail(`${subject}: a mudança deixaria o grupo sem veicular em computador, celular e tablet. Nada foi alterado.`);
  }

  const { response, error } = await mutateAtomic(client, customerId, "adGroupBidModifiers", [operation]);
  if (error) return fail(`${subject}: a API recusou — nada foi gravado.\n${error}`);
  const warnings: string[] = [];
  const smart = action === "BID_ADJUST" ? smartBiddingWarning(adGroup.campaign.bidding) : null;
  if (smart) warnings.push(smart);
  return {
    content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
      ad_group: { id: adGroup.id, name: adGroup.name },
      campaign: campaignView(adGroup.campaign),
      device,
      action,
      operation: operation.remove ? "remove (volta a valer o ajuste da campanha)" : operation.update ? "update" : "create",
      before: current ? describeModifier(current.bidModifier) : `sem ajuste no grupo (campanha: ${describeModifier(campaignDevices.get(device)?.bidModifier)})`,
      after: describeModifier(after),
      warnings,
      result: response,
    })}`)],
  };
}

// ── Demografia ───────────────────────────────────────────────────────

interface DemographicCriterion {
  resourceName: string;
  value: string;
  negative: boolean;
  bidModifier?: number;
}

/** Normaliza valores ("18-24", "65+", "undetermined") para o enum da dimensão. */
export function normalizeDemographicValues(dimension: Dimension, raw: unknown[]): { values: string[] } | { error: string } {
  const spec = DEMOGRAPHIC_DIMENSIONS[dimension];
  const valid = spec.values as readonly string[];
  const values: string[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    let value = String(item ?? "").trim().toUpperCase().replace(/-/g, "_").replace(/\+$/, "_UP");
    if (value === "UNDETERMINED") value = spec.undetermined;
    if (!valid.includes(value) && spec.prefix && valid.includes(`${spec.prefix}${value}`)) value = `${spec.prefix}${value}`;
    if (!valid.includes(value)) invalid.push(String(item));
    else if (!values.includes(value)) values.push(value);
  }
  if (invalid.length) {
    return { error: `Valor(es) inválido(s) para ${dimension}: ${invalid.join(", ")}. Válidos: ${valid.join(", ")}.` };
  }
  if (values.length === 0) return { error: `Informe ao menos um valor de ${dimension}. Válidos: ${valid.join(", ")}.` };
  return { values };
}

async function fetchDemographics(
  client: GoogleAdsClient,
  customerId: string,
  level: "AD_GROUP" | "CAMPAIGN",
  parentId: string,
  dimension: Dimension
): Promise<Map<string, DemographicCriterion>> {
  const spec = DEMOGRAPHIC_DIMENSIONS[dimension];
  const resource = level === "AD_GROUP" ? "ad_group_criterion" : "campaign_criterion";
  const parentField = level === "AD_GROUP" ? "ad_group.id" : "campaign.id";
  // status REMOVED fica de fora: é assim que a API mostra o padrão "todos segmentados"
  // (comentário de AdGroupCriterion.status no proto v25).
  const rows = await client.searchStream(customerId,
    `SELECT ${resource}.resource_name, ${resource}.criterion_id, ${resource}.negative,
            ${resource}.bid_modifier, ${resource}.status, ${resource}.${spec.field}.type
     FROM ${resource}
     WHERE ${parentField} = ${parentId}
       AND ${resource}.type = '${dimension}'
       AND ${resource}.status != 'REMOVED'`);
  const rowKey = level === "AD_GROUP" ? "adGroupCriterion" : "campaignCriterion";
  const found = new Map<string, DemographicCriterion>();
  for (const row of rows) {
    const criterion = (row[rowKey] ?? {}) as Row;
    const value = String(((criterion[spec.key] ?? {}) as Row).type ?? "");
    if (!value) continue;
    found.set(value, {
      resourceName: String(criterion.resourceName ?? ""),
      value,
      negative: criterion.negative === true,
      bidModifier: modifierOf(criterion),
    });
  }
  return found;
}

function describeDemographic(criterion: DemographicCriterion | undefined): string {
  if (!criterion) return "segmentado (padrão, sem critério)";
  if (criterion.negative) return "excluído";
  return `segmentado, ${describeModifier(criterion.bidModifier)}`;
}

interface DemographicRequest {
  client: GoogleAdsClient;
  customerId: string;
  level: "AD_GROUP" | "CAMPAIGN";
  parent: { id: string; name: string; resourceName: string };
  campaign: CampaignInfo;
  dimension: Dimension;
  values: string[];
  action: "EXCLUDE" | "INCLUDE" | "BID_ADJUST";
  bidModifier?: number;
}

/**
 * Exclusão / inclusão / ajuste de lance demográfico. negative é IMMUTABLE: trocar um
 * critério positivo por exclusão (ou uma exclusão por positivo, em campanha restritiva) é
 * remove + create do MESMO recurso ({pai}~{id fixo}) — vai em duas requisições ordenadas
 * (ver CriteriaPlan). O resto segue numa requisição atômica só.
 */
async function applyDemographics(req: DemographicRequest): Promise<ToolResult> {
  const { client, customerId, level, parent, campaign, dimension, values, action, bidModifier } = req;
  const spec = DEMOGRAPHIC_DIMENSIONS[dimension];
  const levelPt = level === "AD_GROUP" ? "Grupo" : "Campanha";
  const subject = `${levelPt} ${parent.id} (${parent.name}) — ${DIMENSION_PT[dimension]}`;
  const parentField = level === "AD_GROUP" ? "adGroup" : "campaign";
  const resource = level === "AD_GROUP" ? "adGroupCriteria" : "campaignCriteria";

  const existing = await fetchDemographics(client, customerId, level, parent.id, dimension);
  const positives = new Set([...existing.values()].filter((c) => !c.negative).map((c) => c.value));
  const negatives = new Set([...existing.values()].filter((c) => c.negative).map((c) => c.value));
  const restrictive = level === "CAMPAIGN" && positives.size > 0;

  const removes: MutateOperation[] = [];
  const creates: MutateOperation[] = [];
  const updates: MutateOperation[] = [];
  const replaced = new Set<MutateOperation>();
  const dependent = new Map<MutateOperation, string>();
  const leftBehind: string[] = [];
  const changes: Array<{ value: string; before: string; after: string; operation: string }> = [];
  const unchanged: Array<{ value: string; state: string }> = [];
  const conflicts: string[] = [];
  const criterionBody = (value: string) => ({ [parentField]: parent.resourceName, [spec.key]: { type: value } });

  for (const value of values) {
    const current = existing.get(value);
    if (action === "EXCLUDE") {
      if (current?.negative) { unchanged.push({ value, state: "já excluído" }); continue; }
      const create: MutateOperation = { create: { ...criterionBody(value), negative: true } };
      if (current) {
        const remove: MutateOperation = { remove: current.resourceName };
        removes.push(remove);
        replaced.add(remove);
        dependent.set(create, value);
        leftBehind.push(restrictive
          ? `${value}: o critério positivo foi removido e a exclusão não foi criada — fica fora da segmentação (a campanha só segmenta os valores positivos).`
          : `${value}: o ajuste positivo (${describeModifier(current.bidModifier)}) foi removido e a exclusão não foi criada — voltou ao padrão (segmentado, sem ajuste).`);
      }
      creates.push(create);
      positives.delete(value);
      negatives.add(value);
      changes.push({ value, before: describeDemographic(current), after: "excluído", operation: current ? "remove (requisição 1) + create negativo (requisição 2)" : "create negativo" });
    } else if (action === "INCLUDE") {
      const needsPositive = restrictive && !positives.has(value);
      if (!current?.negative && !needsPositive) { unchanged.push({ value, state: describeDemographic(current) }); continue; }
      const remove: MutateOperation | null = current?.negative ? { remove: current.resourceName } : null;
      if (remove) removes.push(remove);
      negatives.delete(value);
      if (needsPositive) {
        const create: MutateOperation = { create: criterionBody(value) };
        creates.push(create);
        positives.add(value);
        if (remove) {
          replaced.add(remove);
          dependent.set(create, value);
          leftBehind.push(`${value}: a exclusão foi removida e o critério positivo não foi criado — continua fora da segmentação ` +
            "(a campanha só segmenta os valores positivos).");
        }
      }
      const operation = remove && needsPositive
        ? "remove exclusão (requisição 1) + create positivo (requisição 2)"
        : remove ? "remove exclusão" : "create positivo";
      changes.push({ value, before: describeDemographic(current), after: "segmentado", operation });
    } else {
      const wanted = bidModifier as number;
      if (current?.negative) { conflicts.push(value); continue; }
      if (current && sameModifier(current.bidModifier, wanted)) { unchanged.push({ value, state: describeDemographic(current) }); continue; }
      if (current) updates.push({ update: { resourceName: current.resourceName, bidModifier: wanted }, updateMask: "bid_modifier" });
      else creates.push({ create: { ...criterionBody(value), bidModifier: wanted } });
      changes.push({ value, before: describeDemographic(current), after: `segmentado, ${describeModifier(wanted)}`, operation: current ? "update bid_modifier" : "create com bid_modifier" });
    }
  }

  if (conflicts.length) {
    return fail(`${subject}: ${conflicts.join(", ")} está(ão) excluído(s) — ajuste de lance não se aplica a exclusão ` +
      "(CANNOT_BID_MODIFY_NEGATIVE_CRITERION). Inclua antes com set_demographic_targeting action INCLUDE. Nada foi alterado.");
  }

  // Pré-checagem das recusas CANNOT_EXCLUDE_ALL_TARGETS e CANNOT_TARGET_ONLY_UNDETERMINED.
  const targeted = (spec.values as readonly string[]).filter((v) => (restrictive ? positives.has(v) : true) && !negatives.has(v));
  if (targeted.length === 0) {
    return fail(`${subject}: a mudança excluiria todos os valores de ${dimension} — a API recusa (CANNOT_EXCLUDE_ALL_TARGETS). Nada foi alterado.`);
  }
  if (targeted.length === 1 && targeted[0] === spec.undetermined) {
    return fail(`${subject}: sobraria só ${spec.undetermined} — a API recusa segmentar apenas o "desconhecido" ` +
      "(CANNOT_TARGET_ONLY_UNDETERMINED). Nada foi alterado.");
  }

  if (changes.length === 0) {
    return { content: [text(`${subject}: nada a mudar — ${formatJson(unchanged)}. Nenhuma escrita foi enviada.`)] };
  }

  const plan: CriteriaPlan = { operations: [...removes, ...creates, ...updates], replaced, dependent: new Set(dependent.keys()) };
  const outcome = await executePlan(client, customerId, resource, plan);
  if (outcome.error) return planFailure(client, subject, outcome, leftBehind);

  const warnings: string[] = [];
  if (outcome.requests === 2) {
    warnings.push("Trocar positivo ↔ exclusão remove e recria o mesmo critério: foram duas requisições (a API não aceita " +
      "mutar o mesmo recurso duas vezes numa requisição), remoção primeiro.");
  }
  if (action === "BID_ADJUST") {
    const smart = smartBiddingWarning(campaign.bidding);
    if (smart) warnings.push(smart);
  }
  if (action === "EXCLUDE" && values.includes(spec.undetermined)) {
    warnings.push(`Excluir ${spec.undetermined} corta quem não tem esse dado demográfico — costuma ser uma parte grande do alcance.`);
  }
  if (dimension === "INCOME_RANGE") {
    warnings.push("Renda familiar só existe em alguns países; se a API recusar, confira a disponibilidade para a região da campanha.");
  }
  return {
    content: [text(`${planStatus(client, subject, outcome, (op) => `a criação de ${dependent.get(op) ?? "critério"}`)}\n\n${formatJson({
      level,
      [level === "AD_GROUP" ? "ad_group" : "campaign"]: { id: parent.id, name: parent.name },
      campaign: campaignView(campaign),
      dimension,
      action,
      changes,
      unchanged,
      targeted_after: targeted,
      excluded_after: [...negatives],
      requests: outcome.requests,
      ...(outcome.notValidated.length ? { not_validated: outcome.notValidated.map((op) => dependent.get(op)) } : {}),
      warnings,
      result: planResult(outcome),
    })}`)],
  };
}

// ── Programação de anúncios ──────────────────────────────────────────

interface Slot {
  day: string;
  startHour: number;
  startMinute: MinuteEnum;
  endHour: number;
  endMinute: MinuteEnum;
  start: number;
  end: number;
  bidModifier?: number;
}

interface ScheduleCriterion extends Slot {
  resourceName: string;
  criterionId: string;
}

const slotKey = (slot: Slot) => `${slot.day}|${slot.start}|${slot.end}`;
const hhmm = (hour: number, minute: MinuteEnum) => `${String(hour).padStart(2, "0")}:${String(MINUTES[minute]).padStart(2, "0")}`;
const describeSlot = (slot: Slot) => `${slot.day} (${DAY_PT[slot.day]}) ${hhmm(slot.startHour, slot.startMinute)}–${hhmm(slot.endHour, slot.endMinute)}`;
const dayOrder = (day: string) => WEEK.indexOf(day as (typeof WEEK)[number]);
const sortSlots = <T extends Slot>(slots: T[]) => [...slots].sort((a, b) => dayOrder(a.day) - dayOrder(b.day) || a.start - b.start);
const overlaps = (a: Slot, b: Slot) => a.day === b.day && a.start < b.end && b.start < a.end;

const slotInputSchema = z.object({
  dayOfWeek: DAY_ENUM.describe("Dia (MONDAY..SUNDAY) ou atalho WEEKDAYS (seg–sex), WEEKEND (sáb–dom), ALL_DAYS."),
  startHour: z.number().describe("Hora inicial (0–23)."),
  startMinute: MINUTE_ENUM().optional().describe("ZERO, FIFTEEN, THIRTY ou FORTY_FIVE. Default: ZERO."),
  endHour: z.number().describe("Hora final (1–24; 24 = meia-noite)."),
  endMinute: MINUTE_ENUM().optional().describe("ZERO, FIFTEEN, THIRTY ou FORTY_FIVE. Default: ZERO."),
  bidModifier: z.number().optional().describe("Ajuste de lance no horário (0.1–10; 1.2 = +20%)."),
});
type SlotInput = z.infer<typeof slotInputSchema>;

/** Valida e expande (WEEKDAYS → 5 dias) os horários pedidos. */
export function expandSlots(inputs: SlotInput[]): { slots: Slot[]; errors: string[] } {
  const slots: Slot[] = [];
  const errors: string[] = [];
  inputs.forEach((input, index) => {
    const label = `slots[${index}]`;
    const startMinute = (input.startMinute ?? "ZERO") as MinuteEnum;
    const endMinute = (input.endMinute ?? "ZERO") as MinuteEnum;
    const problems: string[] = [];
    if (!Number.isInteger(input.startHour) || input.startHour < 0 || input.startHour > 23) problems.push(`startHour ${input.startHour} fora de 0–23`);
    if (!Number.isInteger(input.endHour) || input.endHour < 0 || input.endHour > 24) problems.push(`endHour ${input.endHour} fora de 0–24`);
    if (input.endHour === 24 && endMinute !== "ZERO") problems.push("endHour 24 só com endMinute ZERO (meia-noite)");
    const start = input.startHour * 60 + MINUTES[startMinute];
    const end = input.endHour * 60 + MINUTES[endMinute];
    if (problems.length === 0 && end <= start) problems.push("o fim precisa ser depois do início (horário não atravessa a meia-noite: divida em dois dias)");
    if (input.bidModifier !== undefined) {
      const bad = modifierError(input.bidModifier, "bidModifier", { zeroHint: "Para não veicular num horário, simplesmente não o inclua na programação." });
      if (bad) problems.push(bad);
    }
    if (problems.length) {
      errors.push(`${label}: ${problems.join("; ")}`);
      return;
    }
    const days = DAY_GROUPS[input.dayOfWeek] ?? [input.dayOfWeek];
    for (const day of days) {
      slots.push({ day, startHour: input.startHour, startMinute, endHour: input.endHour, endMinute, start, end, bidModifier: input.bidModifier });
    }
  });
  return { slots, errors };
}

async function fetchSchedules(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<ScheduleCriterion[]> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id,
            campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
            campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
            campaign_criterion.ad_schedule.end_minute, campaign_criterion.bid_modifier,
            campaign_criterion.status
     FROM campaign_criterion
     WHERE campaign.id = ${campaignId}
       AND campaign_criterion.type = 'AD_SCHEDULE'
       AND campaign_criterion.status != 'REMOVED'`);
  return sortSlots(rows.map((row) => scheduleFromCriterion((row.campaignCriterion ?? {}) as Row)));
}

function scheduleFromCriterion(criterion: Row): ScheduleCriterion {
  const schedule = (criterion.adSchedule ?? {}) as Row;
  const startMinute = (String(schedule.startMinute ?? "ZERO") in MINUTES ? String(schedule.startMinute ?? "ZERO") : "ZERO") as MinuteEnum;
  const endMinute = (String(schedule.endMinute ?? "ZERO") in MINUTES ? String(schedule.endMinute ?? "ZERO") : "ZERO") as MinuteEnum;
  const startHour = num(schedule.startHour);
  const endHour = num(schedule.endHour);
  return {
    resourceName: String(criterion.resourceName ?? ""),
    criterionId: String(criterion.criterionId ?? ""),
    day: String(schedule.dayOfWeek ?? ""),
    startHour,
    startMinute,
    endHour,
    endMinute,
    start: startHour * 60 + MINUTES[startMinute],
    end: endHour * 60 + MINUTES[endMinute],
    bidModifier: modifierOf(criterion),
  };
}

const scheduleView = (slot: Slot & { criterionId?: string }) => ({
  ...(slot.criterionId ? { criterion_id: slot.criterionId } : {}),
  day: slot.day,
  window: `${hhmm(slot.startHour, slot.startMinute)}–${hhmm(slot.endHour, slot.endMinute)}`,
  bid_modifier: describeModifier(slot.bidModifier),
});

function perDayOverflow(slots: Slot[]): string[] {
  const counts = new Map<string, number>();
  for (const slot of slots) counts.set(slot.day, (counts.get(slot.day) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > MAX_SCHEDULES_PER_DAY).map(([day, count]) => `${day}: ${count}`);
}

// ── Limite de frequência ─────────────────────────────────────────────

interface FrequencyCap {
  level: string;
  eventType: string;
  timeUnit: string;
  timeLength: number;
  cap: number;
}

const capKey = (cap: Omit<FrequencyCap, "cap">) => `${cap.level}|${cap.eventType}|${cap.timeUnit}|${cap.timeLength}`;
const UNIT_PT: Record<string, string> = { DAY: "dia", WEEK: "semana", MONTH: "mês" };
const LEVEL_PT: Record<string, string> = { CAMPAIGN: "por campanha", AD_GROUP: "por grupo de anúncios", AD_GROUP_AD: "por anúncio" };

function describeCap(cap: FrequencyCap): string {
  const event = cap.eventType === "VIDEO_VIEW" ? "visualização(ões)" : "impressão(ões)";
  const period = cap.timeLength > 1 ? `${cap.timeLength} ${UNIT_PT[cap.timeUnit] ?? cap.timeUnit}(s)` : UNIT_PT[cap.timeUnit] ?? cap.timeUnit;
  return `${cap.cap} ${event} por ${period}, ${LEVEL_PT[cap.level] ?? cap.level}`;
}

function parseCaps(raw: unknown): FrequencyCap[] {
  return ensureArray<Row>(raw).map((entry) => {
    const key = (entry.key ?? {}) as Row;
    return {
      level: String(key.level ?? "CAMPAIGN"),
      eventType: String(key.eventType ?? "IMPRESSION"),
      timeUnit: String(key.timeUnit ?? ""),
      timeLength: num(key.timeLength) || 1,
      cap: num(entry.cap),
    };
  });
}

const sortCaps = (caps: FrequencyCap[]) => [...caps].sort((a, b) => capKey(a).localeCompare(capKey(b)));
const capToApi = (cap: FrequencyCap) => ({
  key: { level: cap.level, eventType: cap.eventType, timeUnit: cap.timeUnit, timeLength: cap.timeLength },
  cap: cap.cap,
});

/** Janela em dias de dateRange/days (buildDateClause já validou o formato). */
function windowDays(dateRange?: { since: string; until: string }, days?: number): number {
  if (dateRange?.since && dateRange?.until) {
    return Math.round((Date.parse(dateRange.until) - Date.parse(dateRange.since)) / 86_400_000) + 1;
  }
  return days ?? 30;
}

// ── Desempenho por horário ───────────────────────────────────────────

interface TimeCell {
  day?: string;
  hour?: number;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversions_value: number;
  ctr_pct: number;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
  conv_rate_pct: number;
  search_is_pct: number | null;
  flags: string[];
}

const TIME_METRICS = {
  CPA: "cpa",
  ROAS: "roas",
  CONVERSIONS: "conversions",
  COST: "spend",
  CLICKS: "clicks",
  IMPRESSIONS: "impressions",
  CTR: "ctr_pct",
  CONV_RATE: "conv_rate_pct",
  IMPRESSION_SHARE: "search_is_pct",
} as const;

// ── Registro das tools ───────────────────────────────────────────────

export function registerBidModifiersTools(ctx: ToolContext): void {
  const { getClient, allowedCustomerIds, hosted } = ctx;
  const mcp = ctx.mcp;

  // ── Ajuste por local (reescrita) ─────────────────────────────────

  mcp.registerTool(
    "set_location_bid_adjustment",
    {
      description: [
        "Ajuste de lance por local numa campanha (upsert). WRITE OPERATION.",
        "",
        "- Local já segmentado: atualiza só o bid_modifier (updateMask bid_modifier).",
        "- Local novo DENTRO de um local já segmentado (ex.: campanha no Brasil, ajuste em São Paulo):",
        "  cria o critério com o ajuste; o alcance não muda.",
        "- Local novo FORA da segmentação atual: amplia o alcance — exige confirm: true.",
        "- Campanha sem segmentação geográfica (veicula em todo lugar) ou local excluído: recusa.",
        "",
        "bidModifier: 0.1–10.0 (1.0 = sem ajuste, 1.3 = +30%, 0.7 = -30%). Para excluir um local use",
        "set_campaign_locations com negative=true. Performance Max não usa ajuste por local.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        locationId: z.string().describe("ID do geo_target_constant (ex.: Brasil=2076, estado de SP=20106, cidade de SP=1001773)."),
        bidModifier: z.number().describe("0.1–10.0. 1.0 = sem ajuste, 1.3 = +30%, 0.7 = -30%."),
        confirm: z.boolean().optional().describe("true para criar um local FORA da segmentação atual (amplia o alcance)."),
      },
    },
    async ({ customerId, campaignId, locationId, bidModifier, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!ID.test(campaignId) || !ID.test(locationId)) {
        return fail("campaignId e locationId devem ser numéricos. Nada foi alterado.");
      }
      const badModifier = modifierError(bidModifier, "bidModifier", {
        zeroHint: "Ajuste 0 não exclui local: para excluir use set_campaign_locations com negative=true.",
      });
      if (badModifier) return fail(`${badModifier} Nada foi alterado.`);

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      const problem = campaignProblem(campaign, campaignId, cid);
      if (problem || !campaign) return fail(problem as string);
      if (campaign.channel === "PERFORMANCE_MAX") {
        return fail(`A campanha ${campaignId} é Performance Max: ela não usa ajuste de lance por local (o lance é sempre Smart Bidding). Nada foi alterado.`);
      }

      const rows = await client.searchStream(customerId,
        `SELECT campaign_criterion.resource_name, campaign_criterion.criterion_id, campaign_criterion.type,
                campaign_criterion.negative, campaign_criterion.bid_modifier, campaign_criterion.status,
                campaign_criterion.location.geo_target_constant, campaign_criterion.display_name
         FROM campaign_criterion
         WHERE campaign.id = ${campaignId}
           AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LOCATION_GROUP')
           AND campaign_criterion.status != 'REMOVED'`);
      const criteria = rows.map((row) => (row.campaignCriterion ?? {}) as Row);
      const geoOf = (criterion: Row) => String(((criterion.location ?? {}) as Row).geoTargetConstant ?? "");
      const target = `geoTargetConstants/${locationId}`;
      const existing = criteria.find((criterion) => criterion.type === "LOCATION" && geoOf(criterion) === target);
      const subject = `Campanha ${campaignId} (${campaign.name}) — local ${locationId}`;
      const warnings: string[] = [];
      const smart = smartBiddingWarning(campaign.bidding);
      if (smart) warnings.push(smart);

      if (existing?.negative === true) {
        return fail(`${subject}: o local está EXCLUÍDO nesta campanha — ajuste de lance não se aplica a exclusão ` +
          "(CANNOT_BID_MODIFY_NEGATIVE_CRITERION). Nada foi alterado.");
      }

      if (existing) {
        const before = modifierOf(existing);
        if (sameModifier(before, bidModifier)) {
          return { content: [text(`${subject}: nada a mudar — já está em ${describeModifier(before)}. Nenhuma escrita foi enviada.`)] };
        }
        const { response, error } = await mutateAtomic(client, customerId, "campaignCriteria", [
          { update: { resourceName: String(existing.resourceName), bidModifier }, updateMask: "bid_modifier" },
        ]);
        if (error) return fail(`${subject}: a API recusou — nada foi gravado.\n${error}`);
        return {
          content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
            campaign: campaignView(campaign),
            location: { id: locationId, name: existing.displayName ?? null },
            operation: "update",
            before: describeModifier(before),
            after: describeModifier(bidModifier),
            reach: "inalterado (o local já era segmentado)",
            warnings,
            result: response,
          })}`)],
        };
      }

      // Local ainda não é critério da campanha: criar um positivo muda a segmentação.
      const positives = criteria.filter((criterion) => criterion.negative !== true);
      const positiveGeos = new Set(positives.filter((c) => c.type === "LOCATION").map(geoOf));
      const excludedGeos = new Set(criteria.filter((c) => c.negative === true && c.type === "LOCATION").map(geoOf));
      if (positives.length === 0) {
        return fail(`${subject}: a campanha não tem segmentação geográfica positiva (veicula em todos os locais). ` +
          "Criar este local restringiria a campanha só a ele — isso é segmentação, não ajuste de lance. " +
          "Defina os locais com set_campaign_locations e depois ajuste o lance. Nada foi alterado.");
      }

      // Sobe a hierarquia (parent_geo_target) para saber se o local fica dentro de um já segmentado.
      const chain: Array<{ id: string; name: string; canonicalName: string; resource: string }> = [];
      let cursor: string | undefined = locationId;
      const seen = new Set<string>();
      while (cursor && chain.length < 8 && !seen.has(cursor)) {
        seen.add(cursor);
        const geoRows = await client.searchStream(customerId,
          `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name,
                  geo_target_constant.parent_geo_target, geo_target_constant.target_type, geo_target_constant.status
           FROM geo_target_constant
           WHERE geo_target_constant.id = ${cursor}`);
        const geo = geoRows[0]?.geoTargetConstant as Row | undefined;
        if (!geo) break;
        chain.push({ id: cursor, name: String(geo.name ?? ""), canonicalName: String(geo.canonicalName ?? ""), resource: `geoTargetConstants/${cursor}` });
        const parent = String(geo.parentGeoTarget ?? "").split("/").pop() ?? "";
        cursor = ID.test(parent) ? parent : undefined;
      }
      if (chain.length === 0) {
        return fail(`${subject}: geo_target_constant ${locationId} não existe. Nada foi alterado.`);
      }
      const location = chain[0];
      const ancestors = chain.slice(1);
      const excludedBy = chain.find((geo) => excludedGeos.has(geo.resource));
      if (excludedBy) {
        return fail(`${subject}: ${location.canonicalName || location.name} fica dentro de um local EXCLUÍDO (${excludedBy.canonicalName || excludedBy.name}); ` +
          "a exclusão prevalece e o ajuste não teria efeito. Nada foi alterado.");
      }
      const container = ancestors.find((geo) => positiveGeos.has(geo.resource));
      let reach: string;
      if (container) {
        reach = `sub-região de ${container.canonicalName || container.name} (já segmentado) — o alcance não muda`;
      } else {
        const hasRadius = positives.some((criterion) => criterion.type !== "LOCATION");
        reach = `AMPLIA o alcance: ${location.canonicalName || location.name} não está dentro de nenhum local segmentado` +
          `${hasRadius ? " (a campanha tem raio/grupo de locais, que não dá para comparar)" : ""} — a campanha passa a veicular também lá`;
        if (confirm !== true && !client.isDryRun) {
          return fail(`${subject}: ${reach}.\nLocais segmentados hoje: ${[...positiveGeos].join(", ") || "(só raio/grupo de locais)"}.\n` +
            "Se é isso mesmo, reenvie com confirm: true. Nada foi enviado.");
        }
      }

      const { response, error } = await mutateAtomic(client, customerId, "campaignCriteria", [
        { create: { campaign: campaign.resourceName, location: { geoTargetConstant: target }, bidModifier } },
      ]);
      if (error) return fail(`${subject}: a API recusou — nada foi gravado.\n${error}`);
      return {
        content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
          campaign: campaignView(campaign),
          location: { id: locationId, name: location.name, canonical_name: location.canonicalName },
          operation: "create",
          before: "não segmentado",
          after: describeModifier(bidModifier),
          reach,
          warnings,
          result: response,
        })}`)],
      };
    }
  );

  // ── Ajuste por dispositivo (reescrita) ───────────────────────────

  mcp.registerTool(
    "set_device_bid_adjustment",
    {
      description: [
        "Ajuste de lance por dispositivo numa campanha (upsert). WRITE OPERATION.",
        "Atualiza o critério DEVICE se já existe; cria se não existe; nada é enviado se o valor já está aplicado.",
        "",
        "bidModifier: 0.1–10.0 (1.0 = sem ajuste, 1.5 = +50%, 0.5 = -50%) ou 0 = excluir o dispositivo (-100%).",
        "Smart Bidding ignora ajustes, exceto o -100%. Não deixa excluir computador, celular e tablet ao mesmo tempo.",
        "Performance Max: use set_device_targeting (PMax só aceita incluir/excluir dispositivo).",
        "Nível de grupo de anúncios: set_device_targeting com adGroupId.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        deviceType: z.enum(DEVICES).describe("MOBILE, DESKTOP, TABLET ou CONNECTED_TV."),
        bidModifier: z.number().describe("0.1–10.0 (1.0 = sem ajuste) ou 0 = excluir."),
      },
    },
    async ({ customerId, campaignId, deviceType, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico. Nada foi alterado.");
      if (!(DEVICES as readonly string[]).includes(deviceType)) return fail(`deviceType inválido: ${deviceType}. Use ${DEVICES.join(", ")}.`);
      const badModifier = modifierError(bidModifier, "bidModifier", { allowZero: true });
      if (badModifier) return fail(`${badModifier} Nada foi alterado.`);

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      const problem = campaignProblem(campaign, campaignId, cid);
      if (problem || !campaign) return fail(problem as string);
      if (campaign.channel === "PERFORMANCE_MAX") {
        return fail(`A campanha ${campaignId} é Performance Max: ela não usa ajuste de lance por dispositivo. ` +
          "Para excluir/incluir um dispositivo use set_device_targeting. Nada foi alterado.");
      }
      return applyCampaignDeviceModifier(client, customerId, campaign, deviceType, bidModifier);
    }
  );

  // ── Ajustes demográficos por grupo (reescritas) ──────────────────

  const demographicBidDescription = (dimension: "AGE_RANGE" | "GENDER") => [
    `Ajuste de lance por ${DIMENSION_PT[dimension]} num grupo de anúncios (upsert). WRITE OPERATION.`,
    "Atualiza o bid_modifier do critério se já existe; cria se não existe; nada é enviado se o valor já está aplicado.",
    "",
    "bidModifier: 0.1–10.0 (1.0 = sem ajuste, 1.2 = +20%, 0.8 = -20%). 0 NÃO exclui (a API recusa):",
    `para excluir use set_demographic_targeting com dimension ${dimension} e action EXCLUDE.`,
    "Smart Bidding ignora ajustes de lance.",
  ].join("\n");

  /** Corpo comum de set_age_bid_adjustment / set_gender_bid_adjustment (depois do checkCustomerAccess). */
  const demographicBidAdjust = async (
    customerId: string,
    adGroupId: string,
    dimension: "AGE_RANGE" | "GENDER",
    value: string,
    bidModifier: number
  ): Promise<ToolResult> => {
    const cid = normalizeCid(customerId);
    if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
    if (!ID.test(adGroupId)) return fail("adGroupId deve ser numérico. Nada foi alterado.");
    const normalized = normalizeDemographicValues(dimension, [value]);
    if ("error" in normalized) return fail(`${normalized.error} Nada foi alterado.`);
    const badModifier = modifierError(bidModifier, "bidModifier", {
      zeroHint: `0 não exclui: para excluir use set_demographic_targeting (dimension ${dimension}, action EXCLUDE).`,
    });
    if (badModifier) return fail(`${badModifier} Nada foi alterado.`);

    const client = getClient();
    const adGroup = await fetchAdGroup(client, customerId, cid, adGroupId);
    const problem = adGroupProblem(adGroup, adGroupId, cid);
    if (problem || !adGroup) return fail(problem as string);
    return applyDemographics({
      client, customerId, level: "AD_GROUP",
      parent: { id: adGroup.id, name: adGroup.name, resourceName: adGroup.resourceName },
      campaign: adGroup.campaign, dimension, values: normalized.values,
      action: "BID_ADJUST", bidModifier,
    });
  };

  mcp.registerTool(
    "set_age_bid_adjustment",
    {
      description: demographicBidDescription("AGE_RANGE"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        ageRange: z.enum([
          "AGE_RANGE_18_24", "AGE_RANGE_25_34", "AGE_RANGE_35_44", "AGE_RANGE_45_54",
          "AGE_RANGE_55_64", "AGE_RANGE_65_UP", "AGE_RANGE_UNDETERMINED",
        ]).describe("Faixa etária."),
        bidModifier: z.number().describe("0.1–10.0 (1.0 = sem ajuste). Para excluir use set_demographic_targeting."),
      },
    },
    async ({ customerId, adGroupId, ageRange, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return demographicBidAdjust(customerId, adGroupId, "AGE_RANGE", ageRange, bidModifier);
    }
  );

  mcp.registerTool(
    "set_gender_bid_adjustment",
    {
      description: demographicBidDescription("GENDER"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        gender: z.enum(["MALE", "FEMALE", "UNDETERMINED"]).describe("Gênero."),
        bidModifier: z.number().describe("0.1–10.0 (1.0 = sem ajuste). Para excluir use set_demographic_targeting."),
      },
    },
    async ({ customerId, adGroupId, gender, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      return demographicBidAdjust(customerId, adGroupId, "GENDER", gender, bidModifier);
    }
  );

  // ── Segmentação demográfica (nova) ───────────────────────────────

  mcp.registerTool(
    "set_demographic_targeting",
    {
      description: [
        "Exclui, reinclui ou ajusta o lance de valores demográficos (idade, gênero, status parental, renda). WRITE OPERATION.",
        "",
        "Nível: informe adGroupId (grupo de anúncios) OU campaignId (campanha).",
        "- EXCLUDE: cria critério negativo. Se havia critério positivo (ajuste), troca por exclusão em DUAS requisições",
        "  (remove, depois create negativo — é o mesmo recurso, e a API não aceita mutá-lo duas vezes numa requisição);",
        "  se a segunda falhar, a resposta diz o estado em que ficou (repetir a chamada conclui).",
        "- INCLUDE: remove a exclusão (volta ao padrão: segmentado). Em campanha restritiva (com positivos), também cria o positivo.",
        "- BID_ADJUST: ajuste de lance 0.1–10.0 (só em grupo de anúncios).",
        "Recusa antes da API: excluir todos os valores (CANNOT_EXCLUDE_ALL_TARGETS) ou deixar só o",
        "\"desconhecido\" (CANNOT_TARGET_ONLY_UNDETERMINED).",
        "",
        "Performance Max (campanha): AGE_RANGE (excluir/incluir) e GENDER (exclusão, desde a v24).",
        "Status parental na campanha: só exclusão. Renda familiar só existe em alguns países.",
        "Valores: AGE_RANGE_18_24..AGE_RANGE_65_UP, AGE_RANGE_UNDETERMINED (aceita \"18-24\", \"65+\");",
        "MALE, FEMALE, UNDETERMINED; PARENT, NOT_A_PARENT, UNDETERMINED; INCOME_RANGE_0_50..INCOME_RANGE_90_UP, INCOME_RANGE_UNDETERMINED.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().optional().describe("Grupo de anúncios (nível de grupo)."),
        campaignId: z.string().optional().describe("Campanha (nível de campanha, ex.: Performance Max)."),
        dimension: z.enum(["AGE_RANGE", "GENDER", "PARENTAL_STATUS", "INCOME_RANGE"]).describe("Dimensão demográfica."),
        values: flexArray(z.string()).describe("Valores da dimensão (ex.: [\"AGE_RANGE_18_24\", \"AGE_RANGE_65_UP\"])."),
        action: z.enum(["EXCLUDE", "INCLUDE", "BID_ADJUST"]).describe("EXCLUDE, INCLUDE ou BID_ADJUST."),
        bidModifier: z.number().optional().describe("Só com BID_ADJUST: 0.1–10.0 (1.2 = +20%)."),
      },
    },
    async ({ customerId, adGroupId, campaignId, dimension, values, action, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if ((adGroupId === undefined) === (campaignId === undefined)) {
        return fail("Informe adGroupId (nível de grupo) OU campaignId (nível de campanha), não os dois. Nada foi alterado.");
      }
      const parentId = String(adGroupId ?? campaignId);
      if (!ID.test(parentId)) return fail(`${adGroupId !== undefined ? "adGroupId" : "campaignId"} deve ser numérico. Nada foi alterado.`);
      const normalized = normalizeDemographicValues(dimension, ensureArray<string>(values));
      if ("error" in normalized) return fail(`${normalized.error} Nada foi alterado.`);
      if (action === "BID_ADJUST") {
        const badModifier = modifierError(bidModifier, "bidModifier", { zeroHint: "Para excluir use action EXCLUDE." });
        if (badModifier) return fail(`${badModifier} Nada foi alterado.`);
      } else if (bidModifier !== undefined) {
        return fail(`bidModifier só vale com action BID_ADJUST (recebido com ${action}). Nada foi alterado.`);
      }

      const client = getClient();
      if (adGroupId !== undefined) {
        const adGroup = await fetchAdGroup(client, customerId, cid, parentId);
        const problem = adGroupProblem(adGroup, parentId, cid);
        if (problem || !adGroup) return fail(problem as string);
        return applyDemographics({
          client, customerId, level: "AD_GROUP",
          parent: { id: adGroup.id, name: adGroup.name, resourceName: adGroup.resourceName },
          campaign: adGroup.campaign, dimension, values: normalized.values, action, bidModifier,
        });
      }

      const campaign = await fetchCampaign(client, customerId, cid, parentId);
      const problem = campaignProblem(campaign, parentId, cid);
      if (problem || !campaign) return fail(problem as string);
      if (action === "BID_ADJUST") {
        return fail("Ajuste de lance demográfico é feito por grupo de anúncios (adGroupId). No nível de campanha esta tool só " +
          "exclui/reinclui. Nada foi alterado.");
      }
      if (campaign.channel === "PERFORMANCE_MAX" && dimension !== "AGE_RANGE" && dimension !== "GENDER") {
        return fail(`Performance Max aceita, na campanha, só AGE_RANGE e GENDER — não ${dimension}. Nada foi alterado.`);
      }
      return applyDemographics({
        client, customerId, level: "CAMPAIGN",
        parent: { id: campaign.id, name: campaign.name, resourceName: campaign.resourceName },
        campaign, dimension, values: normalized.values, action,
      });
    }
  );

  // ── Segmentação por dispositivo (nova) ───────────────────────────

  mcp.registerTool(
    "set_device_targeting",
    {
      description: [
        "Exclui, reinclui ou ajusta o lance de um dispositivo, no caminho certo para cada tipo de campanha. WRITE OPERATION.",
        "",
        "- campaignId em Performance Max: critério DEVICE positivo/negativo (EXCLUDE / INCLUDE; PMax não tem ajuste de lance).",
        "  Campanha restrita a um só dispositivo (critério positivo): excluir esse dispositivo é recusado (ampliaria o",
        "  alcance para todos os outros) — inclua o novo antes. Trocar positivo ↔ negativo usa duas requisições.",
        "- campaignId nas demais: ajuste de lance da campanha (EXCLUDE = 0/-100%, INCLUDE = volta a 1.0, BID_ADJUST = 0.1–10).",
        "- adGroupId: ajuste do grupo (AdGroupBidModifier), que sobrepõe o da campanha. INCLUDE remove o -100% do grupo",
        "  (volta a valer o da campanha). Se a campanha exclui o dispositivo, o grupo não pode sobrepor.",
        "Não deixa excluir computador, celular e tablet ao mesmo tempo. Smart Bidding só respeita o -100%.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha (nível de campanha)."),
        adGroupId: z.string().optional().describe("Grupo de anúncios (nível de grupo)."),
        device: z.enum(DEVICES).describe("MOBILE, DESKTOP, TABLET ou CONNECTED_TV."),
        action: z.enum(["EXCLUDE", "INCLUDE", "BID_ADJUST"]).describe("EXCLUDE, INCLUDE ou BID_ADJUST."),
        bidModifier: z.number().optional().describe("Só com BID_ADJUST: 0.1–10.0 (1.2 = +20%)."),
      },
    },
    async ({ customerId, campaignId, adGroupId, device, action, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if ((adGroupId === undefined) === (campaignId === undefined)) {
        return fail("Informe campaignId OU adGroupId, não os dois. Nada foi alterado.");
      }
      const parentId = String(adGroupId ?? campaignId);
      if (!ID.test(parentId)) return fail(`${adGroupId !== undefined ? "adGroupId" : "campaignId"} deve ser numérico. Nada foi alterado.`);
      if (!(DEVICES as readonly string[]).includes(device)) return fail(`device inválido: ${device}. Use ${DEVICES.join(", ")}.`);
      if (action === "BID_ADJUST") {
        const badModifier = modifierError(bidModifier, "bidModifier", { zeroHint: "Para excluir use action EXCLUDE." });
        if (badModifier) return fail(`${badModifier} Nada foi alterado.`);
      } else if (bidModifier !== undefined) {
        return fail(`bidModifier só vale com action BID_ADJUST (recebido com ${action}). Nada foi alterado.`);
      }

      const client = getClient();
      if (adGroupId !== undefined) {
        const adGroup = await fetchAdGroup(client, customerId, cid, parentId);
        const problem = adGroupProblem(adGroup, parentId, cid);
        if (problem || !adGroup) return fail(problem as string);
        return applyAdGroupDevice(client, customerId, adGroup, device, action, bidModifier);
      }
      const campaign = await fetchCampaign(client, customerId, cid, parentId);
      const problem = campaignProblem(campaign, parentId, cid);
      if (problem || !campaign) return fail(problem as string);
      if (campaign.channel === "PERFORMANCE_MAX") {
        if (action === "BID_ADJUST") {
          return fail("Performance Max não tem ajuste de lance por dispositivo — só EXCLUDE ou INCLUDE. Nada foi alterado.");
        }
        return applyPmaxDeviceTargeting(client, customerId, campaign, device, action);
      }
      const target = action === "EXCLUDE" ? 0 : action === "INCLUDE" ? "INCLUDE" : (bidModifier as number);
      return applyCampaignDeviceModifier(client, customerId, campaign, device, target);
    }
  );

  // ── Programação: gravar (reescrita) ──────────────────────────────

  mcp.registerTool(
    "set_ad_schedule",
    {
      description: [
        "Programação de anúncios (dia/horário) de uma campanha. WRITE OPERATION.",
        "",
        "Informe slots[] (vários horários de uma vez) ou os campos avulsos de um único horário.",
        "dayOfWeek aceita MONDAY..SUNDAY e os atalhos WEEKDAYS (seg–sex), WEEKEND e ALL_DAYS.",
        "Minutos em passos de 15 (ZERO, FIFTEEN, THIRTY, FORTY_FIVE); endHour 24 = meia-noite; o horário não",
        "atravessa a meia-noite. Máximo de 6 horários por dia, sem sobreposição. Horas no fuso da conta.",
        "",
        "- replace=false (padrão): ADICIONA à programação atual. Horário idêntico a um existente só atualiza",
        "  o ajuste (se bidModifier vier diferente); sobreposto a um existente é recusado.",
        "- replace=true: a programação passa a ser EXATAMENTE slots[] — mantém os idênticos, remove os demais e",
        "  cria os novos numa única operação atômica. Se remover algum, exige confirm: true. Em replace, horário sem",
        "  bidModifier fica sem ajuste (1.0).",
        "Primeiro horário numa campanha 24/7 faz ela veicular SÓ nos horários programados.",
        "Consultar: list_ad_schedules. Mudar só o ajuste: update_ad_schedule_bid. Remover: remove_ad_schedule.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        slots: flexArray(slotInputSchema).optional().describe("Horários: [{dayOfWeek, startHour, startMinute?, endHour, endMinute?, bidModifier?}]."),
        dayOfWeek: DAY_ENUM.optional().describe("Horário avulso: dia ou atalho (WEEKDAYS, WEEKEND, ALL_DAYS)."),
        startHour: z.number().optional().describe("Horário avulso: hora inicial (0–23)."),
        startMinute: MINUTE_ENUM().optional().describe("Horário avulso: minuto inicial. Default: ZERO."),
        endHour: z.number().optional().describe("Horário avulso: hora final (1–24)."),
        endMinute: MINUTE_ENUM().optional().describe("Horário avulso: minuto final. Default: ZERO."),
        bidModifier: z.number().optional().describe("Horário avulso: ajuste de lance (0.1–10)."),
        replace: z.boolean().optional().describe("true = substitui a programação inteira por slots[]. Default: false (adiciona)."),
        confirm: z.boolean().optional().describe("Obrigatório (true) quando replace remove horários existentes."),
      },
    },
    async ({ customerId, campaignId, slots, dayOfWeek, startHour, startMinute, endHour, endMinute, bidModifier, replace, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico. Nada foi alterado.");

      const single = dayOfWeek !== undefined || startHour !== undefined || endHour !== undefined;
      const rawSlots = ensureArray<unknown>(slots);
      if (single && rawSlots.length) return fail("Use slots[] OU os campos avulsos (dayOfWeek/startHour/endHour), não os dois. Nada foi alterado.");
      let inputs: SlotInput[];
      if (single) {
        if (dayOfWeek === undefined || startHour === undefined || endHour === undefined) {
          return fail("Horário avulso precisa de dayOfWeek, startHour e endHour. Nada foi alterado.");
        }
        inputs = [{ dayOfWeek, startHour, startMinute, endHour, endMinute, bidModifier }];
      } else {
        const parsed = z.array(slotInputSchema).safeParse(rawSlots);
        if (!parsed.success) {
          return fail(`slots inválido: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Nada foi alterado.`);
        }
        inputs = parsed.data;
      }
      if (inputs.length === 0) {
        return fail("Informe ao menos um horário (slots[] ou dayOfWeek/startHour/endHour). Para apagar a programação use remove_ad_schedule. Nada foi alterado.");
      }
      const { slots: requestedRaw, errors } = expandSlots(inputs);
      if (errors.length) return fail(`Horário(s) inválido(s):\n- ${errors.join("\n- ")}\nNada foi alterado.`);

      // Mesmo horário repetido: só aceita se o ajuste for o mesmo.
      const requestedByKey = new Map<string, Slot>();
      for (const slot of requestedRaw) {
        const previous = requestedByKey.get(slotKey(slot));
        if (previous && previous.bidModifier !== slot.bidModifier) {
          return fail(`${describeSlot(slot)} aparece duas vezes com ajustes diferentes. Nada foi alterado.`);
        }
        requestedByKey.set(slotKey(slot), slot);
      }
      const requested = sortSlots([...requestedByKey.values()]);
      for (let i = 0; i < requested.length; i++) {
        for (let j = i + 1; j < requested.length; j++) {
          if (overlaps(requested[i], requested[j])) {
            return fail(`Os horários pedidos se sobrepõem: ${describeSlot(requested[i])} e ${describeSlot(requested[j])}. Nada foi alterado.`);
          }
        }
      }

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      const problem = campaignProblem(campaign, campaignId, cid);
      if (problem || !campaign) return fail(problem as string);
      const existing = await fetchSchedules(client, customerId, campaignId);
      const existingByKey = new Map(existing.map((slot) => [slotKey(slot), slot]));

      const creates: Slot[] = [];
      const updates: Array<{ slot: ScheduleCriterion; to: number }> = [];
      const removes: ScheduleCriterion[] = [];
      const unchanged: ScheduleCriterion[] = [];
      let final: Slot[];

      if (replace === true) {
        const wantedKeys = new Set(requested.map(slotKey));
        for (const slot of existing) if (!wantedKeys.has(slotKey(slot))) removes.push(slot);
        for (const slot of requested) {
          const match = existingByKey.get(slotKey(slot));
          if (!match) { creates.push(slot); continue; }
          const to = slot.bidModifier ?? 1;
          if (sameModifier(match.bidModifier, to)) unchanged.push(match);
          else updates.push({ slot: match, to });
        }
        final = requested;
      } else {
        const conflicts: string[] = [];
        for (const slot of requested) {
          const match = existingByKey.get(slotKey(slot));
          if (match) {
            if (slot.bidModifier !== undefined && !sameModifier(match.bidModifier, slot.bidModifier)) updates.push({ slot: match, to: slot.bidModifier });
            else unchanged.push(match);
            continue;
          }
          const clash = existing.find((current) => overlaps(current, slot));
          if (clash) conflicts.push(`${describeSlot(slot)} sobrepõe o existente ${describeSlot(clash)} (criterionId ${clash.criterionId})`);
          else creates.push(slot);
        }
        if (conflicts.length) {
          return fail(`Horário(s) em conflito com a programação atual:\n- ${conflicts.join("\n- ")}\n` +
            "Use replace=true para redefinir a programação, ou remove_ad_schedule antes. Nada foi alterado.");
        }
        final = [...existing, ...creates];
      }

      const overflow = perDayOverflow(final);
      if (overflow.length) {
        return fail(`Mais de ${MAX_SCHEDULES_PER_DAY} horários no mesmo dia (limite da API): ${overflow.join(", ")}. Nada foi alterado.`);
      }
      if (creates.length === 0 && updates.length === 0 && removes.length === 0) {
        return { content: [text(`Campanha ${campaignId}: nada a mudar — a programação pedida já está aplicada. Nenhuma escrita foi enviada.\n\n${formatJson({ schedules: existing.map(scheduleView) })}`)] };
      }
      if (removes.length > 0 && confirm !== true && !client.isDryRun) {
        return fail(`Campanha ${campaignId}: replace removeria ${removes.length} horário(s) — ${removes.map(describeSlot).join("; ")}.\n` +
          "Reenvie com confirm: true para aplicar. Nada foi enviado.");
      }

      // Remoções primeiro (liberam o limite diário e evitam sobreposição), tudo numa requisição atômica:
      // se um create for recusado, nenhum horário é removido e a campanha não vira 24/7 sem querer.
      const operations: MutateOperation[] = [
        ...removes.map((slot) => ({ remove: slot.resourceName })),
        ...creates.map((slot) => ({
          create: {
            campaign: campaign.resourceName,
            adSchedule: { dayOfWeek: slot.day, startHour: slot.startHour, startMinute: slot.startMinute, endHour: slot.endHour, endMinute: slot.endMinute },
            ...(slot.bidModifier !== undefined ? { bidModifier: slot.bidModifier } : {}),
          },
        })),
        ...updates.map(({ slot, to }) => ({ update: { resourceName: slot.resourceName, bidModifier: to }, updateMask: "bid_modifier" })),
      ];
      const subject = `Campanha ${campaignId} (${campaign.name}) — programação`;
      const { response, error } = await mutateAtomic(client, customerId, "campaignCriteria", operations);
      if (error) return fail(`${subject}: a API recusou — nada foi gravado (operação atômica).\n${error}`);

      const warnings: string[] = ["Horas no fuso horário da conta."];
      if (existing.length === 0) {
        warnings.push("A campanha veiculava 24/7; agora veicula SÓ nos horários programados.");
      }
      if (final.some((slot) => slot.bidModifier !== undefined && !sameModifier(slot.bidModifier, 1))) {
        const smart = smartBiddingWarning(campaign.bidding);
        if (smart) warnings.push(smart);
      }
      return {
        content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
          campaign: campaignView(campaign),
          mode: replace === true ? "replace" : "add",
          before: existing.map(scheduleView),
          after: sortSlots(final).map((slot) => {
            const match = existingByKey.get(slotKey(slot));
            const update = updates.find((u) => slotKey(u.slot) === slotKey(slot));
            return scheduleView({ ...slot, criterionId: match?.criterionId, bidModifier: update ? update.to : match ? match.bidModifier : slot.bidModifier });
          }),
          created: creates.map(scheduleView),
          updated: updates.map(({ slot, to }) => ({ ...scheduleView(slot), bid_modifier: `${describeModifier(slot.bidModifier)} → ${describeModifier(to)}` })),
          removed: removes.map(scheduleView),
          unchanged: unchanged.map(scheduleView),
          warnings,
          result: response,
        })}`)],
      };
    }
  );

  // ── Programação: listar (nova) ───────────────────────────────────

  mcp.registerTool(
    "list_ad_schedules",
    {
      description: [
        "Lista a programação de anúncios (dia/horário + ajuste de lance) de uma campanha ou da conta.",
        "Campanha sem programação veicula 24/7. withMetrics=true inclui desempenho de cada horário",
        "(ad_schedule_view) no período. Horas no fuso da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha. Sem ele, todas as campanhas com programação."),
        withMetrics: z.boolean().optional().describe("true = inclui impressões, cliques, custo, conversões, CPA e ROAS de cada horário."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, withMetrics, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail("campaignId deve ser numérico.");
      const client = getClient();
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign_criterion.criterion_id,
                campaign_criterion.resource_name, campaign_criterion.ad_schedule.day_of_week,
                campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute,
                campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute,
                campaign_criterion.bid_modifier, campaign_criterion.status
         FROM campaign_criterion
         WHERE campaign_criterion.type = 'AD_SCHEDULE'
           AND campaign_criterion.status != 'REMOVED'
           AND campaign.status != 'REMOVED'${campaignFilter}`);

      const metricsByKey = new Map<string, MetricTotals>();
      if (withMetrics) {
        const dateClause = buildDateClause(dateRange, days);
        const metricRows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign_criterion.criterion_id, metrics.impressions, metrics.clicks,
                  metrics.cost_micros, metrics.conversions, metrics.conversions_value
           FROM ad_schedule_view
           WHERE ${dateClause}${campaignFilter}`);
        for (const row of metricRows) {
          const key = `${((row.campaign ?? {}) as Row).id}~${((row.campaignCriterion ?? {}) as Row).criterionId}`;
          metricsByKey.set(key, addMetrics(metricsByKey.get(key) ?? emptyTotals(), row.metrics as Row));
        }
      }

      const schedules = rows.map((row) => {
        const campaign = (row.campaign ?? {}) as Row;
        const slot = scheduleFromCriterion((row.campaignCriterion ?? {}) as Row);
        const view: Row = {
          campaign_id: String(campaign.id ?? ""),
          campaign_name: String(campaign.name ?? ""),
          ...scheduleView(slot),
        };
        if (withMetrics) Object.assign(view, metricsView(metricsByKey.get(`${campaign.id}~${slot.criterionId}`) ?? emptyTotals()));
        return { view, slot, bidding: String(campaign.biddingStrategyType ?? "") };
      }).sort((a, b) => a.view.campaign_id !== b.view.campaign_id
        ? String(a.view.campaign_id).localeCompare(String(b.view.campaign_id))
        : dayOrder(a.slot.day) - dayOrder(b.slot.day) || a.slot.start - b.slot.start);

      const views = schedules.map((s) => s.view);
      if (format === "table") return { content: [text(formatAsTable(views))] };
      if (format === "csv") return { content: [text(formatAsCsv(views))] };
      const notes = ["Horas no fuso horário da conta.", "Campanha sem programação veicula 24/7."];
      if (schedules.some((s) => SMART_BIDDING.has(s.bidding) && s.slot.bidModifier !== undefined && !sameModifier(s.slot.bidModifier, 1))) {
        notes.push("Há ajustes de lance em campanhas com Smart Bidding: eles ficam gravados mas não são usados.");
      }
      const header = campaignId
        ? (views.length ? `Campanha ${campaignId}: ${views.length} horário(s) programado(s).` : `Campanha ${campaignId}: sem programação (veicula 24/7).`)
        : `${views.length} horário(s) programado(s) em ${new Set(views.map((v) => v.campaign_id)).size} campanha(s).`;
      return { content: [text(`${header}\n\n${formatJson({ schedules: views, notes })}`)] };
    }
  );

  // ── Programação: ajuste de lance (nova) ──────────────────────────

  mcp.registerTool(
    "update_ad_schedule_bid",
    {
      description: [
        "Muda só o ajuste de lance de horários já programados (o dia/horário não muda). WRITE OPERATION.",
        "Informe updates [{criterionId, bidModifier}] ou criterionIds + bidModifier (mesmo valor para todos).",
        "bidModifier 0.1–10.0 (1.0 = sem ajuste). IDs em list_ad_schedules. Valores iguais ao atual não são enviados.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        updates: flexArray(z.object({ criterionId: z.string(), bidModifier: z.number() })).optional()
          .describe("[{criterionId, bidModifier}]."),
        criterionIds: flexArray(z.string()).optional().describe("IDs dos horários (com bidModifier único)."),
        bidModifier: z.number().optional().describe("Ajuste aplicado a todos os criterionIds."),
      },
    },
    async ({ customerId, campaignId, updates, criterionIds, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico. Nada foi alterado.");
      const parsedUpdates = z.array(z.object({ criterionId: z.string(), bidModifier: z.number() })).safeParse(ensureArray(updates));
      if (!parsedUpdates.success) return fail("updates inválido: use [{criterionId, bidModifier}]. Nada foi alterado.");
      const ids = ensureArray<string>(criterionIds).map((id) => String(id).trim()).filter(Boolean);
      if (ids.length && bidModifier === undefined) return fail("criterionIds precisa de bidModifier. Nada foi alterado.");
      if (!ids.length && bidModifier !== undefined) return fail("bidModifier avulso precisa de criterionIds. Nada foi alterado.");
      const wanted = new Map<string, number>();
      for (const item of [...parsedUpdates.data, ...ids.map((criterionId) => ({ criterionId, bidModifier: bidModifier as number }))]) {
        const id = item.criterionId.trim();
        if (!ID.test(id)) return fail(`criterionId inválido: "${item.criterionId}". Nada foi alterado.`);
        const bad = modifierError(item.bidModifier, `bidModifier de ${id}`, { zeroHint: "Para parar de veicular num horário use remove_ad_schedule." });
        if (bad) return fail(`${bad} Nada foi alterado.`);
        if (wanted.has(id) && wanted.get(id) !== item.bidModifier) return fail(`criterionId ${id} veio com dois ajustes diferentes. Nada foi alterado.`);
        wanted.set(id, item.bidModifier);
      }
      if (wanted.size === 0) return fail("Informe updates ou criterionIds + bidModifier. Nada foi alterado.");

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      const problem = campaignProblem(campaign, campaignId, cid);
      if (problem || !campaign) return fail(problem as string);
      const existing = await fetchSchedules(client, customerId, campaignId);
      const byId = new Map(existing.map((slot) => [slot.criterionId, slot]));
      const notFound = [...wanted.keys()].filter((id) => !byId.has(id));
      const unchanged: Row[] = [];
      const targets: Array<{ slot: ScheduleCriterion; to: number }> = [];
      for (const [id, to] of wanted) {
        const slot = byId.get(id);
        if (!slot) continue;
        if (sameModifier(slot.bidModifier, to)) unchanged.push(scheduleView(slot));
        else targets.push({ slot, to });
      }
      if (targets.length === 0) {
        return {
          content: [text(`Campanha ${campaignId}: nada a mudar. Nenhuma escrita foi enviada.\n\n${formatJson({ unchanged, not_found: notFound })}`)],
          isError: notFound.length > 0 && unchanged.length === 0,
        };
      }

      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignCriteria",
          targets.map(({ slot, to }) => ({ update: { resourceName: slot.resourceName, bidModifier: to }, updateMask: "bid_modifier" })),
          { partialFailure: true });
      } catch (err) {
        return fail(`Campanha ${campaignId}: a API recusou — nada foi gravado.\n${explainApiError((err as Error).message)}`);
      }
      const dryRun = client.isDryRun;
      const results = (response.results as Row[] | undefined) ?? [];
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, targets.length);
      const done: Row[] = [];
      const errors: Row[] = [];
      targets.forEach(({ slot, to }, index) => {
        const item = { ...scheduleView(slot), bid_modifier: `${describeModifier(slot.bidModifier)} → ${describeModifier(to)}` };
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...item, error: explainApiError(opErrors.join("; ")) });
        else if (!dryRun && !(results[index] as Row | undefined)?.resourceName) errors.push({ ...item, error: "a API não confirmou a alteração" });
        else done.push(item);
      });
      for (const message of unattributed) errors.push({ error: explainApiError(message) });
      const warnings: string[] = [];
      const smart = smartBiddingWarning(campaign.bidding);
      if (smart) warnings.push(smart);
      return {
        content: [text(
          (dryRun ? `Campanha ${campaignId} — DRY-RUN (validateOnly): nada foi gravado. Validados: ${done.length}` : `Campanha ${campaignId}: ${done.length} horário(s) atualizado(s)`) +
          ` | Sem mudança: ${unchanged.length} | Não encontrados: ${notFound.length} | Com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : "updated"]: done, unchanged, not_found: notFound, errors, warnings })
        )],
        isError: errors.length > 0,
      };
    }
  );

  // ── Programação: remover (nova) ──────────────────────────────────

  mcp.registerTool(
    "remove_ad_schedule",
    {
      description: [
        "Remove horários da programação de uma campanha. WRITE OPERATION — exige confirm: true.",
        "Informe criterionIds (ver list_ad_schedules) ou all: true. Sem nenhum horário, a campanha volta a",
        "veicular 24/7. Reversível: é só programar de novo com set_ad_schedule.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        criterionIds: flexArray(z.string()).optional().describe("IDs dos horários a remover."),
        all: z.boolean().optional().describe("true = remove toda a programação (a campanha volta a 24/7)."),
        confirm: z.boolean().optional().describe("Obrigatório: true para remover."),
      },
    },
    async ({ customerId, campaignId, criterionIds, all, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi removido.`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico. Nada foi removido.");
      const ids = ensureArray<string>(criterionIds).map((id) => String(id).trim()).filter(Boolean);
      if ((ids.length > 0) === (all === true)) return fail("Informe criterionIds OU all: true. Nada foi removido.");
      const badIds = ids.filter((id) => !ID.test(id));
      if (badIds.length) return fail(`criterionIds devem ser numéricos: ${badIds.join(", ")}. Nada foi removido.`);

      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      const problem = campaignProblem(campaign, campaignId, cid);
      if (problem || !campaign) return fail((problem as string).replace("alterado", "removido"));
      const existing = await fetchSchedules(client, customerId, campaignId);
      const targets = all === true ? existing : existing.filter((slot) => ids.includes(slot.criterionId));
      const notFound = all === true ? [] : ids.filter((id) => !existing.some((slot) => slot.criterionId === id));
      if (targets.length === 0) {
        return fail(`Campanha ${campaignId}: nenhum horário a remover${notFound.length ? ` (não encontrados: ${notFound.join(", ")})` : " (a campanha não tem programação)"}. Nada foi removido.`);
      }
      const becomes247 = targets.length === existing.length;
      const effect = becomes247 ? "Sem nenhum horário, a campanha passa a veicular 24/7." : `Restam ${existing.length - targets.length} horário(s).`;
      if (confirm !== true && !client.isDryRun) {
        return fail(`Campanha ${campaignId}: removeria ${targets.length} horário(s) — ${targets.map(describeSlot).join("; ")}. ${effect}\n` +
          "Reenvie com confirm: true para remover. Nada foi enviado.");
      }

      let response: Row;
      try {
        response = await client.mutate(customerId, "campaignCriteria", targets.map((slot) => ({ remove: slot.resourceName })), { partialFailure: true });
      } catch (err) {
        return fail(`Campanha ${campaignId}: a API recusou — nada foi removido.\n${explainApiError((err as Error).message)}`);
      }
      const dryRun = client.isDryRun;
      const results = (response.results as Row[] | undefined) ?? [];
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, targets.length);
      const removed: Row[] = [];
      const errors: Row[] = [];
      targets.forEach((slot, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) errors.push({ ...scheduleView(slot), error: explainApiError(opErrors.join("; ")) });
        else if (!dryRun && !(results[index] as Row | undefined)?.resourceName) errors.push({ ...scheduleView(slot), error: "a API não confirmou a remoção" });
        else removed.push(scheduleView(slot));
      });
      for (const message of unattributed) errors.push({ error: explainApiError(message) });
      return {
        content: [text(
          (dryRun ? `Campanha ${campaignId} — DRY-RUN (validateOnly): nada foi removido. Validados: ${removed.length}` : `Campanha ${campaignId}: ${removed.length} horário(s) removido(s)`) +
          ` | Não encontrados: ${notFound.length} | Com erro: ${errors.length}\n${errors.length === 0 ? effect : ""}\n\n` +
          formatJson({ [dryRun ? "validated" : "removed"]: removed, not_found: notFound, errors })
        )],
        isError: errors.length > 0,
      };
    }
  );

  // ── Desempenho por hora / dia da semana (nova) ───────────────────

  mcp.registerTool(
    "get_time_performance",
    {
      description: [
        "Desempenho por hora do dia, dia da semana ou hora × dia (dayparting), com CPA, ROAS e parcela de impressões",
        "(Search IS), e marca os horários fracos e fortes em relação à média do período.",
        "",
        "dimension: HOUR (24 linhas), DAY_OF_WEEK (7) ou HOUR_X_DAY (grade 7×24; em json vem a grade da métrica",
        "escolhida + os horários marcados; table/csv trazem todas as células).",
        "Critérios: fraco = gastou ≥ 1 CPA médio sem converter, CPA ≥ 1,5× a média ou ROAS ≤ metade da média;",
        "forte = ≥ 2 conversões com CPA ≤ 0,7× a média ou ROAS ≥ 1,5× a média. Horas no fuso da conta.",
        "Para agir: set_ad_schedule (horários e ajustes) / update_ad_schedule_bid.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha. Sem ele, a conta inteira."),
        dimension: z.enum(["HOUR", "DAY_OF_WEEK", "HOUR_X_DAY"]).optional().describe("Default: HOUR_X_DAY."),
        metric: z.enum(Object.keys(TIME_METRICS) as [keyof typeof TIME_METRICS, ...Array<keyof typeof TIME_METRICS>]).optional()
          .describe("Métrica da grade HOUR_X_DAY: CPA (default), ROAS, CONVERSIONS, COST, CLICKS, IMPRESSIONS, CTR, CONV_RATE, IMPRESSION_SHARE."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, dimension, metric, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail("campaignId deve ser numérico.");
      const dim = dimension ?? "HOUR_X_DAY";
      const gridMetric = metric ?? "CPA";
      const dateClause = buildDateClause(dateRange, days);
      const segments = dim === "HOUR" ? ["segments.hour"] : dim === "DAY_OF_WEEK" ? ["segments.day_of_week"] : ["segments.day_of_week", "segments.hour"];
      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ${segments.join(", ")}, metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value, metrics.search_impression_share
         FROM ${campaignId ? "campaign" : "customer"}
         WHERE ${dateClause}${campaignId ? ` AND campaign.id = ${campaignId}` : ""}`);

      // Cada linha já é uma célula (a query não segmenta por data). O agregado por chave cobre
      // o caso de a API devolver a mesma célula em mais de uma linha.
      const cells = new Map<string, { day?: string; hour?: number; totals: MetricTotals; isImpr: number; isEligible: number }>();
      for (const row of rows) {
        const seg = (row.segments ?? {}) as Row;
        const day = dim === "HOUR" ? undefined : String(seg.dayOfWeek ?? "");
        const hour = dim === "DAY_OF_WEEK" ? undefined : num(seg.hour);
        const key = `${day ?? ""}|${hour ?? ""}`;
        const cell = cells.get(key) ?? { day, hour, totals: emptyTotals(), isImpr: 0, isEligible: 0 };
        const metrics = (row.metrics ?? {}) as Row;
        addMetrics(cell.totals, metrics);
        const share = num(metrics.searchImpressionShare);
        if (share > 0) {
          cell.isImpr += num(metrics.impressions);
          cell.isEligible += num(metrics.impressions) / share;
        }
        cells.set(key, cell);
      }
      if (cells.size === 0) {
        return { content: [text(`Sem dados no período (${dateClause})${campaignId ? ` para a campanha ${campaignId}` : ""}.`)] };
      }

      const overallTotals = emptyTotals();
      for (const cell of cells.values()) {
        overallTotals.impressions += cell.totals.impressions;
        overallTotals.clicks += cell.totals.clicks;
        overallTotals.costMicros += cell.totals.costMicros;
        overallTotals.conversions += cell.totals.conversions;
        overallTotals.conversionsValue += cell.totals.conversionsValue;
      }
      const overall = metricsView(overallTotals);
      const avgCpa = overall.cpa;
      const hasValue = overallTotals.conversionsValue > 0;
      const avgRoas = hasValue ? overall.roas : null;
      const minSpend = avgCpa ? avgCpa * 0.5 : 0;

      const list: TimeCell[] = [...cells.values()].map((cell) => {
        const view = metricsView(cell.totals);
        const out: TimeCell = {
          ...(cell.day !== undefined ? { day: cell.day } : {}),
          ...(cell.hour !== undefined ? { hour: cell.hour } : {}),
          impressions: view.impressions,
          clicks: view.clicks,
          spend: view.spend,
          conversions: view.conversions,
          conversions_value: view.conversions_value,
          ctr_pct: view.ctr_pct,
          cpc: view.cpc,
          cpa: view.cpa,
          roas: hasValue ? view.roas : null,
          conv_rate_pct: view.clicks ? round2((view.conversions / view.clicks) * 100) : 0,
          search_is_pct: cell.isEligible > 0 ? round2((cell.isImpr / cell.isEligible) * 100) : null,
          flags: [],
        };
        if (avgCpa) {
          if (out.conversions === 0 && out.spend >= avgCpa) out.flags.push(`fraco: gastou ${out.spend} (≥ 1 CPA médio) sem conversão`);
          else if (out.cpa !== null && out.cpa >= 1.5 * avgCpa && out.spend >= minSpend) out.flags.push(`fraco: CPA ${out.cpa} ≥ 1,5× a média (${avgCpa})`);
        }
        if (avgRoas && out.roas !== null && out.spend >= minSpend && out.spend > 0 && out.roas <= 0.5 * avgRoas && out.conversions > 0) {
          out.flags.push(`fraco: ROAS ${out.roas} ≤ metade da média (${avgRoas})`);
        }
        if (out.conversions >= 2 && ((avgCpa && out.cpa !== null && out.cpa <= 0.7 * avgCpa) || (avgRoas && out.roas !== null && out.roas >= 1.5 * avgRoas))) {
          out.flags.push("forte: CPA/ROAS bem melhor que a média");
        }
        return out;
      }).sort((a, b) => dayOrder(a.day ?? "MONDAY") - dayOrder(b.day ?? "MONDAY") || (a.hour ?? 0) - (b.hour ?? 0));

      if (format === "table" || format === "csv") {
        const flat = list.map(({ flags, ...rest }) => ({ ...rest, flags: flags.join(" | ") }));
        return { content: [text(format === "table" ? formatAsTable(flat) : formatAsCsv(flat))] };
      }

      const label = (cell: TimeCell) => [cell.day, cell.hour !== undefined ? `${String(cell.hour).padStart(2, "0")}h` : undefined].filter(Boolean).join(" ");
      const weak = list.filter((cell) => cell.flags.some((f) => f.startsWith("fraco")))
        .sort((a, b) => b.spend - a.spend).slice(0, 20)
        .map((cell) => ({ when: label(cell), spend: cell.spend, conversions: cell.conversions, cpa: cell.cpa, roas: cell.roas, why: cell.flags.filter((f) => f.startsWith("fraco")) }));
      const strong = list.filter((cell) => cell.flags.some((f) => f.startsWith("forte")))
        .sort((a, b) => b.conversions - a.conversions).slice(0, 20)
        .map((cell) => ({ when: label(cell), spend: cell.spend, conversions: cell.conversions, cpa: cell.cpa, roas: cell.roas }));
      const notes = ["Horas no fuso horário da conta."];
      if (!avgCpa) notes.push("Sem conversões no período: não dá para marcar horários fracos/fortes por CPA.");
      if (list.every((cell) => cell.search_is_pct === null)) notes.push("Sem parcela de impressões (só existe para campanhas de Pesquisa).");

      const body: Row = {
        scope: campaignId ? `campanha ${campaignId}` : "conta inteira",
        period: dateClause,
        dimension: dim,
        totals: overall,
        criteria: {
          weak: "gastou ≥ 1 CPA médio sem converter; ou CPA ≥ 1,5× a média; ou ROAS ≤ metade da média (com gasto ≥ 0,5 CPA médio)",
          strong: "≥ 2 conversões e CPA ≤ 0,7× a média ou ROAS ≥ 1,5× a média",
        },
        weak,
        strong,
        notes,
      };
      if (dim === "HOUR_X_DAY") {
        const field = TIME_METRICS[gridMetric];
        const grid: Record<string, Array<number | null>> = {};
        for (const day of WEEK) grid[day] = Array.from({ length: 24 }, () => null);
        for (const cell of list) {
          if (cell.day && grid[cell.day] && cell.hour !== undefined && cell.hour >= 0 && cell.hour < 24) {
            grid[cell.day][cell.hour] = cell[field] as number | null;
          }
        }
        body.grid = { metric: gridMetric, hours: "índice 0–23 = hora do dia; null = sem dados", rows: grid };
      } else {
        body.cells = list;
      }
      return { content: [text(formatJson(body))] };
    }
  );

  // ── Ajustes e exclusões: listar (nova) ───────────────────────────

  mcp.registerTool(
    "list_bid_modifiers",
    {
      description: [
        "Lista, para uma campanha, todos os ajustes de lance e exclusões de segmentação: dispositivo, local,",
        "raio, programação, demografia (campanha) e, por grupo de anúncios, dispositivo (AdGroupBidModifier) e",
        "demografia (idade, gênero, status parental, renda). Use antes de ajustar para ver o estado atual.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        includeAdGroups: z.boolean().optional().describe("Inclui os ajustes por grupo de anúncios. Default: true."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, includeAdGroups, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico.");
      const client = getClient();
      const campaign = await fetchCampaign(client, customerId, cid, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}.`);

      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative,
                campaign_criterion.bid_modifier, campaign_criterion.status, campaign_criterion.display_name,
                campaign_criterion.device.type, campaign_criterion.location.geo_target_constant,
                campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
                campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
                campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
                campaign_criterion.ad_schedule.end_minute, campaign_criterion.age_range.type,
                campaign_criterion.gender.type, campaign_criterion.parental_status.type,
                campaign_criterion.income_range.type
         FROM campaign_criterion
         WHERE campaign.id = ${campaignId}
           AND campaign_criterion.type IN ('DEVICE', 'LOCATION', 'PROXIMITY', 'AD_SCHEDULE', 'AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE')
           AND campaign_criterion.status != 'REMOVED'`);

      type Entry = { level: string; ad_group_id?: string; ad_group_name?: string; type: string; value: string; negative: boolean; bid_modifier: string; criterion_id: string };
      const entries: Entry[] = [];
      const demographicValue = (criterion: Row) => {
        for (const spec of Object.values(DEMOGRAPHIC_DIMENSIONS)) {
          const value = ((criterion[spec.key] ?? {}) as Row).type;
          if (value) return String(value);
        }
        return "";
      };
      for (const row of campaignRows) {
        const criterion = (row.campaignCriterion ?? {}) as Row;
        const type = String(criterion.type ?? "");
        let value = "";
        if (type === "DEVICE") value = String(((criterion.device ?? {}) as Row).type ?? "");
        else if (type === "LOCATION") value = `${criterion.displayName ?? ""} (${((criterion.location ?? {}) as Row).geoTargetConstant ?? ""})`.trim();
        else if (type === "PROXIMITY") value = `${criterion.displayName ?? "raio"} — ${((criterion.proximity ?? {}) as Row).radius ?? "?"} ${((criterion.proximity ?? {}) as Row).radiusUnits ?? ""}`.trim();
        else if (type === "AD_SCHEDULE") value = describeSlot(scheduleFromCriterion(criterion));
        else value = demographicValue(criterion);
        entries.push({
          level: "campaign",
          type,
          value,
          negative: criterion.negative === true,
          bid_modifier: criterion.negative === true ? "excluído" : describeModifier(modifierOf(criterion)),
          criterion_id: String(criterion.criterionId ?? ""),
        });
      }

      if (includeAdGroups !== false) {
        const adGroupRows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.type,
                  ad_group_criterion.negative, ad_group_criterion.bid_modifier, ad_group_criterion.status,
                  ad_group_criterion.age_range.type, ad_group_criterion.gender.type,
                  ad_group_criterion.parental_status.type, ad_group_criterion.income_range.type
           FROM ad_group_criterion
           WHERE campaign.id = ${campaignId}
             AND ad_group.status != 'REMOVED'
             AND ad_group_criterion.type IN ('AGE_RANGE', 'GENDER', 'PARENTAL_STATUS', 'INCOME_RANGE')
             AND ad_group_criterion.status != 'REMOVED'`);
        for (const row of adGroupRows) {
          const adGroup = (row.adGroup ?? {}) as Row;
          const criterion = (row.adGroupCriterion ?? {}) as Row;
          entries.push({
            level: "ad_group",
            ad_group_id: String(adGroup.id ?? ""),
            ad_group_name: String(adGroup.name ?? ""),
            type: String(criterion.type ?? ""),
            value: demographicValue(criterion),
            negative: criterion.negative === true,
            bid_modifier: criterion.negative === true ? "excluído" : describeModifier(modifierOf(criterion)),
            criterion_id: String(criterion.criterionId ?? ""),
          });
        }
        const deviceRows = await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group.name, ad_group_bid_modifier.criterion_id, ad_group_bid_modifier.bid_modifier,
                  ad_group_bid_modifier.device.type
           FROM ad_group_bid_modifier
           WHERE campaign.id = ${campaignId}
             AND ad_group.status != 'REMOVED'`);
        for (const row of deviceRows) {
          const adGroup = (row.adGroup ?? {}) as Row;
          const modifier = (row.adGroupBidModifier ?? {}) as Row;
          const device = String(((modifier.device ?? {}) as Row).type ?? "");
          if (!device) continue;
          entries.push({
            level: "ad_group",
            ad_group_id: String(adGroup.id ?? ""),
            ad_group_name: String(adGroup.name ?? ""),
            type: "DEVICE",
            value: device,
            negative: false,
            bid_modifier: describeModifier(modifierOf(modifier)),
            criterion_id: String(modifier.criterionId ?? ""),
          });
        }
      }

      if (format === "table") return { content: [text(formatAsTable(entries))] };
      if (format === "csv") return { content: [text(formatAsCsv(entries))] };
      const notes: string[] = [];
      const smart = smartBiddingWarning(campaign.bidding);
      if (smart) notes.push(smart);
      notes.push("Valores demográficos sem critério estão segmentados (padrão). Dispositivo sem critério = sem ajuste.");
      if (!entries.some((e) => e.type === "AD_SCHEDULE")) notes.push("Sem programação: a campanha veicula 24/7.");
      const byType = (level: string, type: string) => entries.filter((e) => e.level === level && e.type === type).map(({ level: _l, ad_group_id: _a, ad_group_name: _n, ...rest }) => rest);
      const adGroups = new Map<string, { ad_group_id: string; name: string; entries: Row[] }>();
      for (const entry of entries.filter((e) => e.level === "ad_group")) {
        const group = adGroups.get(entry.ad_group_id as string) ?? { ad_group_id: entry.ad_group_id as string, name: entry.ad_group_name as string, entries: [] };
        group.entries.push({ type: entry.type, value: entry.value, negative: entry.negative, bid_modifier: entry.bid_modifier, criterion_id: entry.criterion_id });
        adGroups.set(entry.ad_group_id as string, group);
      }
      return {
        content: [text(formatJson({
          campaign: campaignView(campaign),
          campaign_level: {
            devices: byType("campaign", "DEVICE"),
            locations: byType("campaign", "LOCATION"),
            proximity: byType("campaign", "PROXIMITY"),
            ad_schedules: byType("campaign", "AD_SCHEDULE"),
            demographics: entries.filter((e) => e.level === "campaign" && Object.keys(DEMOGRAPHIC_DIMENSIONS).includes(e.type))
              .map(({ level: _l, ad_group_id: _a, ad_group_name: _n, ...rest }) => rest),
          },
          ad_groups: [...adGroups.values()],
          notes,
        }))],
      };
    }
  );

  // ── Desempenho por dispositivo (reescrita) ───────────────────────

  mcp.registerTool(
    "get_device_breakdown",
    {
      description: [
        "Desempenho por dispositivo (MOBILE, DESKTOP, TABLET, CONNECTED_TV...) com CPC, CPA, taxa de conversão e",
        "participação no gasto. Sem campaignId: conta inteira. Com campaignId: só a campanha, e cada linha traz o",
        "ajuste de lance atual do dispositivo (ou a exclusão, em PMax).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Campanha (opcional)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail("campaignId deve ser numérico.");
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      // campaign.id só filtra em FROM campaign (em FROM customer a API recusa).
      const results = await client.searchStream(customerId,
        `SELECT segments.device, metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM ${campaignId ? "campaign" : "customer"}
         WHERE ${dateClause}${campaignId ? ` AND campaign.id = ${campaignId}` : ""}`);

      const byDevice = new Map<string, MetricTotals>();
      for (const row of results) {
        const device = String(((row.segments ?? {}) as Row).device ?? "UNKNOWN");
        byDevice.set(device, addMetrics(byDevice.get(device) ?? emptyTotals(), row.metrics as Row));
      }
      const totalSpend = [...byDevice.values()].reduce((sum, t) => sum + microsToMoney(t.costMicros), 0);
      const modifiers = campaignId ? await fetchCampaignDevices(client, customerId, campaignId) : null;

      const devices = [...byDevice.entries()].map(([device, totals]) => {
        const view = metricsView(totals);
        const out: Row = {
          device,
          impressions: view.impressions,
          clicks: view.clicks,
          spend: view.spend,
          conversions: view.conversions,
          revenue: view.conversions_value,
          ctr: view.ctr_pct,
          roas: view.roas ?? 0,
          cpc: view.cpc,
          cpa: view.cpa,
          conv_rate_pct: view.clicks ? round2((view.conversions / view.clicks) * 100) : 0,
          spend_share_pct: totalSpend ? round2((view.spend / totalSpend) * 100) : 0,
        };
        if (modifiers) {
          const criterion = modifiers.get(device);
          out.bid_adjustment = criterion?.negative ? "excluído" : describeModifier(criterion?.bidModifier);
        }
        return out;
      }).sort((a, b) => num(b.spend) - num(a.spend));

      if (format === "table") return { content: [text(formatAsTable(devices))] };
      if (format === "csv") return { content: [text(formatAsCsv(devices))] };
      return { content: [text(formatJson(devices))] };
    }
  );

  // ── Limite de frequência (nova) ──────────────────────────────────

  // Só IMPRESSION: VIDEO_VIEW existe apenas em campanhas de Vídeo, e a API do Google Ads não altera
  // campanhas de Vídeo ("You cannot create new Video campaigns or update existing Video campaigns
  // using the Google Ads API" — developers.google.com/google-ads/api/docs/video/overview).
  const capInputSchema = z.object({
    eventType: z.enum(["IMPRESSION"]).optional().describe("IMPRESSION (padrão e único aceito: limite de impressões)."),
    timeUnit: z.enum(["DAY", "WEEK", "MONTH"]).describe("DAY, WEEK ou MONTH."),
    cap: z.number().describe("Máximo de impressões por usuário no período (inteiro ≥ 1). Em MERGE, 0 remove esse limite."),
    level: z.enum(["CAMPAIGN", "AD_GROUP", "AD_GROUP_AD"]).optional().describe("Nível do limite: CAMPAIGN (padrão), AD_GROUP ou AD_GROUP_AD."),
    timeLength: z.number().optional().describe("Quantas unidades de tempo (inteiro ≥ 1). Default: 1."),
  });

  const VIDEO_NOT_WRITABLE = "a API do Google Ads não cria nem altera campanhas de Vídeo " +
    "(developers.google.com/google-ads/api/docs/video/overview), então o limite de frequência delas só muda na interface " +
    "do Google Ads. Os limites atuais aparecem em get_frequency_report (leitura).";

  mcp.registerTool(
    "set_frequency_cap",
    {
      description: [
        "Define o limite de frequência (quantas vezes a mesma pessoa vê os anúncios) de uma campanha DISPLAY.",
        "WRITE OPERATION. Lê os limites atuais antes; nada é enviado se o resultado for igual.",
        "",
        "- mode MERGE (padrão): altera/adiciona os limites informados e mantém os demais; cap 0 remove aquele limite.",
        "- mode REPLACE: a lista passa a ser exatamente caps[]; caps [] remove todos (exige confirm: true).",
        "Chave de cada limite: level + timeUnit + timeLength (só um por chave). Evento: IMPRESSION;",
        "nível campanha, grupo de anúncios ou anúncio.",
        "Vídeo: recusado — a API do Google Ads não altera campanhas de Vídeo (mude na interface; leia com",
        "get_frequency_report). Demand Gen, Pesquisa, Shopping e PMax não têm limite de frequência.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        caps: flexArray(capInputSchema).describe("[{eventType, timeUnit, cap, level?, timeLength?}]."),
        mode: z.enum(["MERGE", "REPLACE"]).optional().describe("MERGE (padrão) ou REPLACE."),
        confirm: z.boolean().optional().describe("Obrigatório (true) para remover todos os limites."),
      },
    },
    async ({ customerId, campaignId, caps, mode, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = normalizeCid(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi alterado.`);
      if (!ID.test(campaignId)) return fail("campaignId deve ser numérico. Nada foi alterado.");
      const merge = (mode ?? "MERGE") === "MERGE";
      const rawCaps = ensureArray<unknown>(caps);
      if (rawCaps.some((item) => (item as Row | null)?.eventType === "VIDEO_VIEW")) {
        return fail(`eventType VIDEO_VIEW só existe em campanhas de Vídeo, e ${VIDEO_NOT_WRITABLE} Nada foi alterado.`);
      }
      const parsed = z.array(capInputSchema).safeParse(rawCaps);
      if (!parsed.success) {
        return fail(`caps inválido: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Nada foi alterado.`);
      }
      if (merge && parsed.data.length === 0) return fail("Em MERGE informe ao menos um limite. Para remover todos use mode REPLACE com caps []. Nada foi alterado.");
      const requested: FrequencyCap[] = [];
      const problems: string[] = [];
      for (const [index, item] of parsed.data.entries()) {
        const timeLength = item.timeLength ?? 1;
        if (!Number.isInteger(item.cap) || item.cap < 0 || (item.cap === 0 && !merge)) {
          problems.push(`caps[${index}].cap ${item.cap}: use inteiro ≥ 1${merge ? " (ou 0 para remover este limite)" : ""}`);
        }
        if (!Number.isInteger(timeLength) || timeLength < 1) problems.push(`caps[${index}].timeLength ${timeLength}: use inteiro ≥ 1`);
        const cap: FrequencyCap = { level: item.level ?? "CAMPAIGN", eventType: item.eventType ?? "IMPRESSION", timeUnit: item.timeUnit, timeLength, cap: item.cap };
        if (requested.some((other) => capKey(other) === capKey(cap))) problems.push(`caps[${index}]: limite repetido para ${capKey(cap)}`);
        requested.push(cap);
      }
      if (problems.length) return fail(`Limite(s) inválido(s):\n- ${problems.join("\n- ")}\nNada foi alterado.`);

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.frequency_caps
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaignRow = rows[0]?.campaign as Row | undefined;
      if (!campaignRow) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi alterado.`);
      if (campaignRow.status === "REMOVED") return fail(`A campanha ${campaignId} está removida. Nada foi alterado.`);
      const channel = String(campaignRow.advertisingChannelType ?? "");
      if (channel === "VIDEO") {
        return fail(`A campanha ${campaignId} é de Vídeo: ${VIDEO_NOT_WRITABLE} Nada foi alterado.`);
      }
      if (channel !== "DISPLAY") {
        const why = channel === "DEMAND_GEN" ? " (o Google não oferece limite de frequência em Demand Gen)" : "";
        return fail(`A campanha ${campaignId} é ${channel}: esta tool só grava limite de frequência em campanhas Display${why}. Nada foi alterado.`);
      }

      const current = parseCaps(campaignRow.frequencyCaps);
      let final: FrequencyCap[];
      if (merge) {
        const byKey = new Map(current.map((cap) => [capKey(cap), cap]));
        for (const cap of requested) {
          if (cap.cap === 0) byKey.delete(capKey(cap));
          else byKey.set(capKey(cap), cap);
        }
        final = [...byKey.values()];
      } else {
        final = requested;
      }
      const subject = `Campanha ${campaignId} (${String(campaignRow.name ?? "")}) — limite de frequência`;
      const same = JSON.stringify(sortCaps(current)) === JSON.stringify(sortCaps(final));
      if (same) {
        return { content: [text(`${subject}: nada a mudar — ${current.length ? current.map(describeCap).join("; ") : "sem limite"}. Nenhuma escrita foi enviada.`)] };
      }
      if (final.length === 0 && confirm !== true && !client.isDryRun) {
        return fail(`${subject}: removeria todos os limites (${current.map(describeCap).join("; ")}) — os anúncios passam a não ter teto de frequência.\n` +
          "Reenvie com confirm: true para aplicar. Nada foi enviado.");
      }

      // frequency_caps é campo repetido: o updateMask troca a lista inteira.
      const { response, error } = await mutateAtomic(client, customerId, "campaigns", [
        { update: { resourceName: `customers/${cid}/campaigns/${campaignId}`, frequencyCaps: sortCaps(final).map(capToApi) }, updateMask: "frequency_caps" },
      ]);
      if (error) return fail(`${subject}: a API recusou — nada foi gravado.\n${error}`);
      return {
        content: [text(`${writeStatus(client, subject)}\n\n${formatJson({
          campaign: { id: campaignId, name: campaignRow.name ?? null, channel },
          mode: merge ? "MERGE" : "REPLACE",
          before: current.map(describeCap),
          after: sortCaps(final).map(describeCap),
          result: response,
        })}`)],
      };
    }
  );

  mcp.registerTool(
    "get_frequency_report",
    {
      description: [
        "Limites de frequência atuais e alcance/frequência reais das campanhas Display, Vídeo e Demand Gen:",
        "usuários únicos, frequência média por usuário e, em janelas de até 31 dias, quantos viram 2+, 3+, 4+, 5+ e 10+ vezes.",
        "Usuários únicos e frequência média só existem para janelas de até 92 dias (limite da API).",
        "Vídeo aparece só para leitura: a API não altera campanhas de Vídeo (set_frequency_cap grava só em Display).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campanha (opcional)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !ID.test(campaignId)) return fail("campaignId deve ser numérico.");
      const dateClause = buildDateClause(dateRange, days);
      const span = windowDays(dateRange, days);
      const client = getClient();
      const filter = campaignId
        ? ` AND campaign.id = ${campaignId}`
        : " AND campaign.advertising_channel_type IN ('DISPLAY', 'VIDEO', 'DEMAND_GEN')";
      const capRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.frequency_caps
         FROM campaign
         WHERE campaign.status != 'REMOVED'${filter}`);

      const notes: string[] = [];
      const reach = new Map<string, Row>();
      if (span > 92) {
        notes.push(`Janela de ${span} dias: usuários únicos e frequência só existem para até 92 dias — reduza o período.`);
      } else {
        const plus = span <= 31;
        if (!plus) notes.push(`Janela de ${span} dias: 2+/3+/4+/5+/10+ só existem para até 31 dias.`);
        const reachRows = await client.searchStream(customerId,
          `SELECT campaign.id, metrics.impressions, metrics.unique_users, metrics.average_impression_frequency_per_user${plus
            ? ", metrics.unique_users_two_plus, metrics.unique_users_three_plus, metrics.unique_users_four_plus, metrics.unique_users_five_plus, metrics.unique_users_ten_plus"
            : ""}
           FROM campaign
           WHERE ${dateClause} AND campaign.status != 'REMOVED'${filter}`);
        for (const row of reachRows) {
          const metrics = (row.metrics ?? {}) as Row;
          const id = String(((row.campaign ?? {}) as Row).id ?? "");
          reach.set(id, {
            impressions: num(metrics.impressions),
            unique_users: num(metrics.uniqueUsers),
            avg_frequency_per_user: round2(num(metrics.averageImpressionFrequencyPerUser)),
            ...(plus ? {
              users_2_plus: num(metrics.uniqueUsersTwoPlus),
              users_3_plus: num(metrics.uniqueUsersThreePlus),
              users_4_plus: num(metrics.uniqueUsersFourPlus),
              users_5_plus: num(metrics.uniqueUsersFivePlus),
              users_10_plus: num(metrics.uniqueUsersTenPlus),
            } : {}),
          });
        }
      }

      const campaigns = capRows.map((row) => {
        const campaign = (row.campaign ?? {}) as Row;
        const id = String(campaign.id ?? "");
        const channel = String(campaign.advertisingChannelType ?? "");
        const caps = parseCaps(campaign.frequencyCaps);
        return {
          campaign_id: id,
          campaign_name: String(campaign.name ?? ""),
          channel,
          frequency_caps: channel === "DISPLAY" || channel === "VIDEO"
            ? (caps.length ? caps.map(describeCap).join("; ") : "sem limite")
            : "não se aplica",
          ...(reach.get(id) ?? {}),
        };
      });
      if (format === "table") return { content: [text(formatAsTable(campaigns))] };
      if (format === "csv") return { content: [text(formatAsCsv(campaigns))] };
      notes.push("Usuários únicos não somam entre campanhas (a mesma pessoa pode estar em várias).");
      if (campaigns.some((campaign) => campaign.channel === "VIDEO")) {
        notes.push("Campanhas de Vídeo: os limites são só leitura aqui — a API do Google Ads não altera campanhas de Vídeo; mude na interface do Google Ads.");
      }
      return { content: [text(`${campaigns.length} campanha(s) — ${dateClause}\n\n${formatJson({ campaigns, notes })}`)] };
    }
  );
}
