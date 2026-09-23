/**
 * Lote demand-gen: Demand Gen e remarketing dinâmico de varejo em Display.
 *
 * Demand Gen na API v25 é Campaign DEMAND_GEN + ad group SEM type + AdGroupAd com
 * demand_gen_multi_asset_ad, demand_gen_carousel_ad, demand_gen_video_responsive_ad ou
 * demand_gen_product_ad. Asset group é só Performance Max: em Demand Gen a API recusa com
 * AssetGroupError.CANNOT_ADD_ASSET_GROUP_FOR_CAMPAIGN_TYPE.
 *
 * Toda escrita deste módulo sai numa única requisição atômica (googleAds:mutate com IDs
 * temporários, ou um :mutate só do recurso): ou tudo é criado, ou nada — sem orçamento ou
 * asset órfão — e em dry-run/validateOnly a API valida o pacote inteiro.
 *
 * Fontes (conferidas em 23/09/2026): protos v25 (resources/campaign, ad_group, ad_group_ad,
 * common/ad_type_infos, asset_types, ad_asset, user_lists, enums/asset_automation_type,
 * demand_gen_channel_strategy) e developers.google.com/google-ads/api/docs/demand-gen/*,
 * .../remarketing/audience-segments/lookalike-audiences, .../dynamic-remarketing/merchant-center-example,
 * .../assets/asset-automation-settings, .../deprecations (mínimo de 5 USD/dia).
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  EU_POLITICAL_DECLARATION,
  ISO_DATE,
  LOW_BID_MICROS,
  checkCustomerAccess,
  ensureArray,
  explainBiddingError,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  isPositiveMicros,
  localIsoDate,
  parseImageAssetRef,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const NUMERIC = /^\d+$/;
const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });
const done = (message: string): ToolResult => ({ content: [text(message)] });
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cidOf = (customerId: string) => customerId.replace(/-/g, "");
const uniq = <T>(values: T[]): T[] => [...new Set(values)];
const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
const DRY_RUN_NOTE = "DRY-RUN (validateOnly): a API validou a operação inteira — nada foi gravado na conta.";

/** Lista vinda de flexArray (array ou JSON em string): normaliza para strings sem vazios. */
function strings(value: unknown): string[] {
  return ensureArray<unknown>(value)
    .map((item) => (typeof item === "string" ? item.trim() : typeof item === "number" ? String(item) : ""))
    .filter(Boolean);
}

function money(micros: number | string | undefined, currency = "BRL"): string {
  const value = Number(micros ?? 0) / 1_000_000;
  return currency === "BRL" ? `R$ ${value.toFixed(2)}` : `${currency} ${value.toFixed(2)}`;
}

function idProblems(label: string, ids: string[]): string[] {
  const bad = ids.filter((id) => !NUMERIC.test(id));
  return bad.length ? [`${label} deve conter só IDs numéricos (recebido: ${bad.join(", ")}).`] : [];
}

/** Gerador de IDs temporários (negativos) para um googleAds:mutate. */
function tempIds(cid: string) {
  let next = 0;
  return (collection: string) => `customers/${cid}/${collection}/${--next}`;
}

function responsesOf(result: Row): Row[] {
  return (result.mutateOperationResponses as Row[] | undefined) ?? [];
}

function resultNames(responses: Row[], key: string): string[] {
  return responses
    .map((response) => obj(response[key]).resourceName)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

const idFromResource = (resourceName: string | undefined) => resourceName?.split("/").pop();

/** Traduz os erros da API mais comuns deste lote para uma orientação em PT-BR. */
function explainApiError(message: string, strategy?: string): string {
  const hints: string[] = [];
  if (/per[- ]day minimum|BUDGET_BELOW/i.test(message)) {
    hints.push("Orçamento abaixo do mínimo do Demand Gen: 5 USD por dia ou o equivalente na moeda da conta (no orçamento total, vale o total dividido pelos dias).");
  }
  if (/shared/i.test(message) && /budget/i.test(message)) {
    hints.push("Demand Gen não aceita orçamento compartilhado: o orçamento precisa ser exclusivo da campanha.");
  }
  if (/END_DATE_TIME_REQUIRED|end date/i.test(message)) {
    hints.push("Orçamento total (CUSTOM_PERIOD) exige data de término: informe endDate.");
  }
  if (/DURATION_TOO_LONG/i.test(message)) {
    hints.push("Período longo demais para orçamento total: encurte a janela entre startDate e endDate.");
  }
  if (/lookalike/i.test(message) && /duplicat/i.test(message)) {
    hints.push("Já existe um segmento lookalike com as mesmas listas-semente, nível de expansão e países (DUPLICATE_LOOKALIKE).");
  }
  if (/merchant/i.test(message)) {
    hints.push("Confira se o Merchant Center está vinculado a esta conta do Google Ads (Ferramentas > Contas vinculadas) e se o merchantId está certo.");
  }
  if (/asset group/i.test(message)) {
    hints.push("Demand Gen não usa asset groups (só Performance Max). Use create_demand_gen_ad_group e create_demand_gen_ad.");
  }
  const base = explainBiddingError(message, strategy);
  return hints.length ? `${base}\n${hints.map((hint) => `→ ${hint}`).join("\n")}` : base;
}

// ── Canais (channel controls) ────────────────────────────────────────

/** DemandGenSelectedChannels (v25): nome do parâmetro → chave JSON e caminho do updateMask. */
const CHANNELS = {
  YOUTUBE_IN_STREAM: { json: "youtubeInStream", path: "youtube_in_stream" },
  YOUTUBE_IN_FEED: { json: "youtubeInFeed", path: "youtube_in_feed" },
  YOUTUBE_SHORTS: { json: "youtubeShorts", path: "youtube_shorts" },
  DISCOVER: { json: "discover", path: "discover" },
  GMAIL: { json: "gmail", path: "gmail" },
  DISPLAY: { json: "display", path: "display" },
  MAPS: { json: "maps", path: "maps" },
} as const;
type ChannelName = keyof typeof CHANNELS;
const CHANNEL_NAMES = Object.keys(CHANNELS) as [ChannelName, ...ChannelName[]];
const CHANNEL_STRATEGIES = ["ALL_CHANNELS", "ALL_OWNED_AND_OPERATED_CHANNELS"] as const;
const CHANNEL_MASK_PREFIX = "demand_gen_ad_group_settings.channel_controls";
const CHANNEL_FIELDS = [
  `ad_group.${CHANNEL_MASK_PREFIX}.channel_config`,
  `ad_group.${CHANNEL_MASK_PREFIX}.channel_strategy`,
  ...CHANNEL_NAMES.map((name) => `ad_group.${CHANNEL_MASK_PREFIX}.selected_channels.${CHANNELS[name].path}`),
].join(", ");

interface ChannelChoice {
  strategy?: string;
  channels?: ChannelName[];
}

function parseChannelChoice(strategy: unknown, selected: unknown): { choice?: ChannelChoice; error?: string } {
  const list = selected === undefined ? undefined : strings(selected).map((channel) => channel.toUpperCase());
  if (strategy !== undefined && list !== undefined) {
    return { error: "use channelStrategy OU selectedChannels, não os dois (a API aceita só uma das formas)." };
  }
  if (strategy !== undefined) {
    if (!CHANNEL_STRATEGIES.includes(strategy as (typeof CHANNEL_STRATEGIES)[number])) {
      return { error: `channelStrategy inválido: "${String(strategy)}". Válidos: ${CHANNEL_STRATEGIES.join(", ")}.` };
    }
    return { choice: { strategy: String(strategy) } };
  }
  if (list !== undefined) {
    const invalid = list.filter((channel) => !(channel in CHANNELS));
    if (invalid.length) return { error: `canal inválido: ${invalid.join(", ")}. Válidos: ${CHANNEL_NAMES.join(", ")}.` };
    if (list.length === 0) return { error: "selectedChannels vazio — marque ao menos um canal (ou use channelStrategy)." };
    return { choice: { channels: uniq(list) as ChannelName[] } };
  }
  return {};
}

/** channel_controls do grupo. selected_channels vai com os 7 canais explícitos (true/false). */
function channelControlsPayload(choice: ChannelChoice): Row {
  if (choice.strategy) return { channelStrategy: choice.strategy };
  const selected: Row = {};
  for (const name of CHANNEL_NAMES) selected[CHANNELS[name].json] = (choice.channels ?? []).includes(name);
  return { selectedChannels: selected };
}

/** Estado atual dos canais de um grupo, como a API devolve. Sem configuração = ALL_CHANNELS (padrão). */
function currentChannels(adGroup: Row): ChannelChoice & { label: string } {
  const controls = obj(obj(adGroup.demandGenAdGroupSettings).channelControls);
  const selected = obj(controls.selectedChannels);
  if (controls.channelConfig === "SELECTED_CHANNELS" || (!controls.channelStrategy && Object.keys(selected).length > 0)) {
    const channels = CHANNEL_NAMES.filter((name) => selected[CHANNELS[name].json] === true);
    return { channels, label: channels.length ? channels.join(", ") : "(nenhum canal marcado)" };
  }
  const strategy = typeof controls.channelStrategy === "string" ? controls.channelStrategy : "ALL_CHANNELS";
  return { strategy, label: controls.channelStrategy ? strategy : `${strategy} (padrão)` };
}

function sameChannels(a: ChannelChoice, b: ChannelChoice): boolean {
  if (a.strategy || b.strategy) return a.strategy === b.strategy;
  return [...(a.channels ?? [])].sort().join() === [...(b.channels ?? [])].sort().join();
}

const channelLabel = (choice: ChannelChoice) => choice.strategy ?? (choice.channels ?? []).join(", ");

// ── Leituras compartilhadas ──────────────────────────────────────────

interface ConstantsCheck {
  problems: string[];
  warnings: string[];
  names: Map<string, string>;
}

/** Confere se as localizações e idiomas existem (e são segmentáveis) antes de gravar. */
async function checkGeoAndLanguages(
  client: GoogleAdsClient,
  customerId: string,
  locationIds: string[],
  languageIds: string[]
): Promise<ConstantsCheck> {
  const check: ConstantsCheck = { problems: [], warnings: [], names: new Map() };
  if (locationIds.length) {
    const rows = await client.searchStream(customerId,
      `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.status
       FROM geo_target_constant
       WHERE geo_target_constant.id IN (${uniq(locationIds).join(", ")})`);
    const found = new Map(rows.map((row) => {
      const geo = obj(row.geoTargetConstant);
      return [String(geo.id), geo] as const;
    }));
    for (const id of uniq(locationIds)) {
      const geo = found.get(id);
      if (!geo) {
        check.problems.push(`localização ${id} não existe (geo_target_constant) — ache o ID com list_geo_targets.`);
        continue;
      }
      check.names.set(`geo:${id}`, String(geo.name ?? id));
      if (geo.status === "REMOVAL_PLANNED") {
        check.warnings.push(`localização ${id} (${String(geo.name)}) está marcada para remoção pelo Google (REMOVAL_PLANNED).`);
      }
    }
  }
  if (languageIds.length) {
    const rows = await client.searchStream(customerId,
      `SELECT language_constant.id, language_constant.name, language_constant.targetable
       FROM language_constant
       WHERE language_constant.id IN (${uniq(languageIds).join(", ")})`);
    const found = new Map(rows.map((row) => {
      const language = obj(row.languageConstant);
      return [String(language.id), language] as const;
    }));
    for (const id of uniq(languageIds)) {
      const language = found.get(id);
      if (!language) {
        check.problems.push(`idioma ${id} não existe (language_constant). Ex.: português = 1014, inglês = 1000, espanhol = 1003.`);
      } else if (language.targetable === false) {
        check.problems.push(`idioma ${id} (${String(language.name)}) não é segmentável.`);
      } else {
        check.names.set(`lang:${id}`, String(language.name ?? id));
      }
    }
  }
  return check;
}

function parseAudienceRef(ref: string, cid: string): { resourceName?: string; id?: string; error?: string } {
  const value = ref.trim();
  if (NUMERIC.test(value)) return { id: value, resourceName: `customers/${cid}/audiences/${value}` };
  const match = /^customers\/([\d-]+)\/audiences\/(\d+)$/.exec(value);
  if (!match) return { error: `"${ref}" não é um público válido (esperado customers/{customerId}/audiences/{id} ou o ID numérico).` };
  const owner = match[1].replace(/-/g, "");
  if (owner !== cid) return { error: `${value} pertence à conta ${owner}, não à conta ${cid}.` };
  return { id: match[2], resourceName: `customers/${cid}/audiences/${match[2]}` };
}

async function checkAudience(client: GoogleAdsClient, customerId: string, audienceId: string): Promise<string | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT audience.id, audience.name, audience.status FROM audience WHERE audience.id = ${audienceId}`);
  const audience = obj(rows[0]?.audience);
  if (!audience.id) return `público ${audienceId} não encontrado na conta (crie com create_audience_from_lists).`;
  if (audience.status && audience.status !== "ENABLED") return `público ${audienceId} está ${String(audience.status)}.`;
  return undefined;
}

async function loadCampaign(client: GoogleAdsClient, customerId: string, campaignId: string): Promise<Row | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.bidding_strategy_type, campaign.demand_gen_campaign_settings.upgraded_targeting,
            campaign.shopping_setting.merchant_id
     FROM campaign
     WHERE campaign.id = ${campaignId} AND campaign.status != 'REMOVED'`);
  return rows[0] ? obj(rows[0].campaign) : undefined;
}

/** upgraded_targeting é IMMUTABLE e o padrão da API é true (proto da Campaign, v25). */
const usesUpgradedTargeting = (campaign: Row) => obj(campaign.demandGenCampaignSettings).upgradedTargeting !== false;

/** Campanhas com critério de localização/idioma no nível da campanha (Demand Gen: campanha OU grupo, nunca os dois). */
async function campaignsWithGeoLanguage(client: GoogleAdsClient, customerId: string, campaignIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!campaignIds.length) return counts;
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign_criterion.type
     FROM campaign_criterion
     WHERE campaign.id IN (${uniq(campaignIds).join(", ")})
       AND campaign_criterion.type IN ('LOCATION', 'LANGUAGE')
       AND campaign_criterion.status != 'REMOVED'`);
  for (const row of rows) {
    const id = String(obj(row.campaign).id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

async function findCampaignByName(client: GoogleAdsClient, customerId: string, name: string): Promise<string | undefined> {
  const rows = await client.searchStream(customerId,
    `SELECT campaign.id, campaign.name FROM campaign
     WHERE campaign.name = '${gaqlLiteral(name)}' AND campaign.status != 'REMOVED'`);
  const id = obj(rows[0]?.campaign).id;
  return id === undefined ? undefined : String(id);
}

/** "Budget — {nome}"; se já existir (ex.: órfão de uma tentativa antiga), acrescenta data e hora. */
async function freeBudgetName(client: GoogleAdsClient, customerId: string, name: string): Promise<string> {
  const base = `Budget — ${name}`;
  const rows = await client.searchStream(customerId,
    `SELECT campaign_budget.id, campaign_budget.name FROM campaign_budget
     WHERE campaign_budget.name = '${gaqlLiteral(base)}' AND campaign_budget.status != 'REMOVED'`);
  return rows.length ? `${base} (${new Date().toISOString().replace("T", " ").slice(0, 19)})` : base;
}

/** O Merchant Center está vinculado a esta conta? (product_link, v25). */
async function merchantLinked(client: GoogleAdsClient, customerId: string, merchantId: string): Promise<boolean> {
  const rows = await client.searchStream(customerId,
    `SELECT product_link.product_link_id, product_link.merchant_center.merchant_center_id
     FROM product_link
     WHERE product_link.type = 'MERCHANT_CENTER'
       AND product_link.merchant_center.merchant_center_id = ${merchantId}`);
  return rows.length > 0;
}

function validateShopping(merchantId: unknown, feedLabel: unknown): { payload?: Row; problems: string[] } {
  const problems: string[] = [];
  if (merchantId === undefined || merchantId === null || merchantId === "") {
    if (feedLabel) problems.push("feedLabel só vale junto com merchantId.");
    return { problems };
  }
  const id = String(merchantId).trim();
  if (!NUMERIC.test(id)) problems.push(`merchantId deve ser o ID numérico do Merchant Center (recebido "${String(merchantId)}").`);
  const payload: Row = { merchantId: id };
  if (feedLabel !== undefined && feedLabel !== "") {
    const label = String(feedLabel).trim().toUpperCase();
    // ShoppingSetting.feed_label (v25): até 20 caracteres — maiúsculas, números, hífen e sublinhado
    if (!/^[A-Z0-9_-]{1,20}$/.test(label)) problems.push(`feedLabel inválido: "${String(feedLabel)}" (até 20 caracteres: letras maiúsculas, números, - e _).`);
    payload.feedLabel = label;
  }
  return { payload, problems };
}

// ── Orçamento ────────────────────────────────────────────────────────

interface BudgetPlan {
  payload: Row;
  perDayMicros: number;
  kind: "DAILY" | "TOTAL";
  amountMicros: number;
  days?: number;
  startDateTime?: string;
  endDateTime?: string;
}

function parseIsoDate(value: unknown, label: string): { date?: string; error?: string } {
  const raw = String(value ?? "").trim();
  if (!ISO_DATE.test(raw)) return { error: `${label} deve estar em YYYY-MM-DD (recebido "${raw}").` };
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return { error: `${label} não é uma data válida: ${raw}.` };
  return { date: raw };
}

const daysInclusive = (since: string, until: string) => Math.round((Date.parse(until) - Date.parse(since)) / 86_400_000) + 1;

/** Moeda: micros precisam ser múltiplos de 10.000 (um centavo) — NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT. */
function microsProblem(label: string, value: unknown): string | undefined {
  if (!isPositiveMicros(value)) return `${label} deve ser inteiro positivo em micros (recebido ${String(value)}).`;
  if ((value as number) % 10_000 !== 0) return `${label} deve ser múltiplo de 10000 micros (um centavo) — recebido ${String(value)}.`;
  return undefined;
}

function validateBudget(input: {
  dailyBudgetMicros?: number;
  totalBudgetMicros?: number;
  startDate?: string;
  endDate?: string;
}): { plan?: BudgetPlan; problems: string[] } {
  const problems: string[] = [];
  const { dailyBudgetMicros: daily, totalBudgetMicros: total } = input;
  if ((daily === undefined) === (total === undefined)) {
    problems.push("informe dailyBudgetMicros (orçamento diário) OU totalBudgetMicros (orçamento total do período) — exatamente um.");
    return { problems };
  }
  const today = localIsoDate(new Date());
  let start: string | undefined;
  let end: string | undefined;
  if (input.startDate !== undefined && input.startDate !== "") {
    const parsed = parseIsoDate(input.startDate, "startDate");
    if (parsed.error) problems.push(parsed.error);
    else if (parsed.date! < today) problems.push(`startDate ${parsed.date} já passou (hoje é ${today}).`);
    else start = parsed.date;
  }
  if (input.endDate !== undefined && input.endDate !== "") {
    const parsed = parseIsoDate(input.endDate, "endDate");
    if (parsed.error) problems.push(parsed.error);
    else if (parsed.date! < today) problems.push(`endDate ${parsed.date} já passou (hoje é ${today}).`);
    else end = parsed.date;
  }
  if (start && end && end < start) problems.push(`endDate (${end}) é anterior a startDate (${start}).`);
  const dates = {
    ...(start ? { startDateTime: `${start} 00:00:00` } : {}),
    ...(end ? { endDateTime: `${end} 23:59:59` } : {}),
  };
  if (daily !== undefined) {
    const problem = microsProblem("dailyBudgetMicros", daily);
    if (problem) problems.push(problem);
    if (problems.length) return { problems };
    return { problems, plan: { kind: "DAILY", amountMicros: daily, perDayMicros: daily, payload: { amountMicros: String(daily) }, ...dates } };
  }
  const problem = microsProblem("totalBudgetMicros", total);
  if (problem) problems.push(problem);
  if (!input.endDate) problems.push("orçamento total (totalBudgetMicros) exige endDate — a API recusa sem data de término (END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET).");
  if (problems.length) return { problems };
  const days = daysInclusive(start ?? today, end!);
  return {
    problems,
    plan: {
      kind: "TOTAL",
      amountMicros: total!,
      perDayMicros: Math.floor(total! / days),
      days,
      // CampaignBudget (v25): total_amount_micros só com period CUSTOM_PERIOD, e amount_micros fica vazio
      payload: { period: "CUSTOM_PERIOD", totalAmountMicros: String(total) },
      ...dates,
    },
  };
}

/** Mínimo do Demand Gen: 5 USD/dia (deprecations, 01/04/2026). Só dá para conferir de antemão em conta USD. */
const DEMAND_GEN_MIN_USD_MICROS = 5_000_000;

function budgetLabel(plan: BudgetPlan, currency: string): string {
  return plan.kind === "DAILY"
    ? `${money(plan.amountMicros, currency)}/dia`
    : `${money(plan.amountMicros, currency)} no total (${plan.days} dia(s), ~${money(plan.perDayMicros, currency)}/dia)`;
}

// ── Lances ───────────────────────────────────────────────────────────

const DEMAND_GEN_STRATEGIES = [
  "MAXIMIZE_CONVERSIONS",
  "TARGET_CPA",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_ROAS",
  "MAXIMIZE_CLICKS",
  "TARGET_CPC",
] as const;

interface BiddingPlan {
  strategy: string;
  fields: Row;
  label: string;
  warnings: string[];
}

function roasProblem(targetRoas: unknown): string | undefined {
  return typeof targetRoas === "number" && Number.isFinite(targetRoas) && targetRoas > 0
    ? undefined
    : `targetRoas deve ser um número positivo (5.0 = 500%) — recebido ${String(targetRoas)}.`;
}

/**
 * Estratégias do Demand Gen (docs demand-gen/create-campaign + release notes v22):
 * TARGET_CPA como no exemplo oficial (campaign.target_cpa), Maximizar cliques = target_spend
 * sem teto (Demand Gen não aceita limite de CPC), CPC alvo = campaign.target_cpc.
 */
function demandGenBidding(
  requested: string | undefined,
  targets: { targetCpaMicros?: number; targetRoas?: number; targetCpcMicros?: number }
): { plan?: BiddingPlan; error?: string } {
  let strategy = requested ?? "MAXIMIZE_CONVERSIONS";
  if (!DEMAND_GEN_STRATEGIES.includes(strategy as (typeof DEMAND_GEN_STRATEGIES)[number])) {
    return {
      error: `biddingStrategy "${strategy}" não existe em Demand Gen. Use ${DEMAND_GEN_STRATEGIES.join(", ")}` +
        " (CPC manual é recusado pela API com OPERATION_NOT_PERMITTED_FOR_CONTEXT).",
    };
  }
  const { targetCpaMicros, targetRoas, targetCpcMicros } = targets;
  if (strategy === "MAXIMIZE_CONVERSIONS" && targetCpaMicros !== undefined) strategy = "TARGET_CPA";
  if (strategy === "MAXIMIZE_CONVERSION_VALUE" && targetRoas !== undefined) strategy = "TARGET_ROAS";
  if (targetCpaMicros !== undefined && strategy !== "TARGET_CPA") return { error: `targetCpaMicros só vale com TARGET_CPA (ou MAXIMIZE_CONVERSIONS), não com ${strategy}.` };
  if (targetRoas !== undefined && strategy !== "TARGET_ROAS") return { error: `targetRoas só vale com TARGET_ROAS (ou MAXIMIZE_CONVERSION_VALUE), não com ${strategy}.` };
  if (targetCpcMicros !== undefined && strategy !== "TARGET_CPC") return { error: `targetCpcMicros só vale com TARGET_CPC, não com ${strategy}.` };
  const warnings: string[] = [];
  switch (strategy) {
    case "TARGET_CPA": {
      if (targetCpaMicros === undefined) return { error: "TARGET_CPA exige targetCpaMicros (ex.: 50000000 = R$ 50 por conversão)." };
      if (!isPositiveMicros(targetCpaMicros)) return { error: `targetCpaMicros deve ser inteiro positivo em micros (recebido ${targetCpaMicros}).` };
      return { plan: { strategy, fields: { targetCpa: { targetCpaMicros: String(targetCpaMicros) } }, label: `CPA desejado (${money(targetCpaMicros)})`, warnings } };
    }
    case "TARGET_ROAS": {
      if (targetRoas === undefined) return { error: "TARGET_ROAS exige targetRoas (ex.: 5.0 = 500%)." };
      const problem = roasProblem(targetRoas);
      if (problem) return { error: problem };
      if (targetRoas > 50) warnings.push(`targetRoas ${targetRoas} = ${targetRoas * 100}%: confira se não quis dizer ${targetRoas / 100} (o valor é multiplicador, 5.0 = 500%).`);
      return { plan: { strategy, fields: { maximizeConversionValue: { targetRoas } }, label: `ROAS desejado (${targetRoas}x)`, warnings } };
    }
    case "TARGET_CPC": {
      if (targetCpcMicros === undefined) return { error: "TARGET_CPC exige targetCpcMicros (ex.: 1500000 = R$ 1,50 por clique)." };
      if (!isPositiveMicros(targetCpcMicros)) return { error: `targetCpcMicros deve ser inteiro positivo em micros (recebido ${targetCpcMicros}).` };
      if (targetCpcMicros < LOW_BID_MICROS) warnings.push(`CPC alvo muito baixo (${money(targetCpcMicros)}): a campanha pode não entregar.`);
      return { plan: { strategy, fields: { targetCpc: { targetCpcMicros: String(targetCpcMicros) } }, label: `Maximizar cliques com CPC alvo (${money(targetCpcMicros)})`, warnings } };
    }
    case "MAXIMIZE_CLICKS":
      return { plan: { strategy, fields: { targetSpend: {} }, label: "Maximizar cliques (sem teto de CPC — Demand Gen não aceita limite)", warnings } };
    case "MAXIMIZE_CONVERSION_VALUE":
      return { plan: { strategy, fields: { maximizeConversionValue: {} }, label: "Maximizar valor de conversão", warnings } };
    default:
      return { plan: { strategy: "MAXIMIZE_CONVERSIONS", fields: { maximizeConversions: {} }, label: "Maximizar conversões", warnings } };
  }
}

const DISPLAY_STRATEGIES = [
  "MAXIMIZE_CONVERSIONS",
  "MAXIMIZE_CONVERSION_VALUE",
  "TARGET_CPA",
  "TARGET_ROAS",
  "MAXIMIZE_CLICKS",
  "TARGET_SPEND",
  "MANUAL_CPC",
  "MANUAL_CPM",
] as const;

/**
 * Estratégias de Display (help 2454058 + docs bidding/strategy-types): CPA/ROAS desejados no
 * formato padrão (maximize_conversions.target_cpa_micros / maximize_conversion_value.target_roas),
 * Maximizar cliques = target_spend (com teto opcional), CPC manual e CPM visível (manual_cpm, só
 * Display). Enhanced CPC não é enviado (descontinuado).
 */
function displayBidding(
  requested: string | undefined,
  targets: { targetCpaMicros?: number; targetRoas?: number; cpcBidCeilingMicros?: number }
): { plan?: BiddingPlan; error?: string } {
  let strategy = requested ?? "MAXIMIZE_CONVERSIONS";
  if (strategy === "TARGET_SPEND") strategy = "MAXIMIZE_CLICKS";
  if (!DISPLAY_STRATEGIES.includes(strategy as (typeof DISPLAY_STRATEGIES)[number])) {
    return { error: `biddingStrategy "${strategy}" não é aceita aqui. Use ${DISPLAY_STRATEGIES.join(", ")}.` };
  }
  const { targetCpaMicros, targetRoas, cpcBidCeilingMicros } = targets;
  if (strategy === "MAXIMIZE_CONVERSIONS" && targetCpaMicros !== undefined) strategy = "TARGET_CPA";
  if (strategy === "MAXIMIZE_CONVERSION_VALUE" && targetRoas !== undefined) strategy = "TARGET_ROAS";
  if (targetCpaMicros !== undefined && strategy !== "TARGET_CPA") return { error: `targetCpaMicros só vale com TARGET_CPA, não com ${strategy}.` };
  if (targetRoas !== undefined && strategy !== "TARGET_ROAS") return { error: `targetRoas só vale com TARGET_ROAS, não com ${strategy}.` };
  if (cpcBidCeilingMicros !== undefined && strategy !== "MAXIMIZE_CLICKS") return { error: `cpcBidCeilingMicros só vale com MAXIMIZE_CLICKS (Maximizar cliques), não com ${strategy}.` };
  const warnings: string[] = [];
  switch (strategy) {
    case "TARGET_CPA":
      if (targetCpaMicros === undefined) return { error: "TARGET_CPA exige targetCpaMicros (ex.: 50000000 = R$ 50 por conversão)." };
      if (!isPositiveMicros(targetCpaMicros)) return { error: `targetCpaMicros deve ser inteiro positivo em micros (recebido ${targetCpaMicros}).` };
      return { plan: { strategy, fields: { maximizeConversions: { targetCpaMicros: String(targetCpaMicros) } }, label: `CPA desejado (${money(targetCpaMicros)})`, warnings } };
    case "TARGET_ROAS": {
      if (targetRoas === undefined) return { error: "TARGET_ROAS exige targetRoas (ex.: 5.0 = 500%)." };
      const problem = roasProblem(targetRoas);
      if (problem) return { error: problem };
      return { plan: { strategy, fields: { maximizeConversionValue: { targetRoas } }, label: `ROAS desejado (${targetRoas}x)`, warnings } };
    }
    case "MAXIMIZE_CLICKS":
      if (cpcBidCeilingMicros !== undefined && !isPositiveMicros(cpcBidCeilingMicros)) {
        return { error: `cpcBidCeilingMicros deve ser inteiro positivo em micros (recebido ${cpcBidCeilingMicros}).` };
      }
      if (cpcBidCeilingMicros === undefined) warnings.push("Maximizar cliques sem teto: o Google pode pagar CPCs altos. Informe cpcBidCeilingMicros se precisar de limite.");
      return {
        plan: {
          strategy,
          fields: { targetSpend: cpcBidCeilingMicros ? { cpcBidCeilingMicros: String(cpcBidCeilingMicros) } : {} },
          label: `Maximizar cliques${cpcBidCeilingMicros ? ` (teto ${money(cpcBidCeilingMicros)})` : ""}`,
          warnings,
        },
      };
    case "MANUAL_CPC":
      return { plan: { strategy, fields: { manualCpc: {} }, label: "CPC manual (lance no grupo)", warnings } };
    case "MANUAL_CPM":
      return { plan: { strategy, fields: { manualCpm: {} }, label: "CPM visível manual (lance no grupo)", warnings } };
    case "MAXIMIZE_CONVERSION_VALUE":
      return { plan: { strategy, fields: { maximizeConversionValue: {} }, label: "Maximizar valor de conversão", warnings } };
    default:
      return { plan: { strategy: "MAXIMIZE_CONVERSIONS", fields: { maximizeConversions: {} }, label: "Maximizar conversões", warnings } };
  }
}

/** Lances do grupo Demand Gen só valem com a estratégia correspondente na campanha (proto AdGroup v25). */
function adGroupBidWarnings(strategy: string, bids: { targetCpcMicros?: number; targetCpaMicros?: number; targetRoas?: number }): string[] {
  const warnings: string[] = [];
  if (bids.targetCpcMicros !== undefined) {
    if (strategy && strategy !== "TARGET_CPC") warnings.push(`A campanha usa ${strategy}: o CPC alvo do grupo só vale com TARGET_CPC e será ignorado.`);
    if (bids.targetCpcMicros < LOW_BID_MICROS) warnings.push(`CPC alvo muito baixo (${money(bids.targetCpcMicros)}): o grupo pode não entregar.`);
  }
  if (bids.targetCpaMicros !== undefined && strategy && strategy !== "TARGET_CPA") {
    warnings.push(strategy === "MAXIMIZE_CONVERSIONS"
      ? "A campanha usa Maximizar conversões: o CPA alvo do grupo só vale se a campanha também tiver CPA alvo."
      : `A campanha usa ${strategy}: o CPA alvo do grupo será ignorado.`);
  }
  if (bids.targetRoas !== undefined && strategy && strategy !== "TARGET_ROAS") {
    warnings.push(strategy === "MAXIMIZE_CONVERSION_VALUE"
      ? "A campanha usa Maximizar valor de conversão: o ROAS alvo do grupo só vale se a campanha também tiver ROAS alvo."
      : `A campanha usa ${strategy}: o ROAS alvo do grupo será ignorado.`);
  }
  return warnings;
}

// ── Critérios de grupo ───────────────────────────────────────────────

function geoLanguageCriteria(
  adGroup: string,
  targeting: { locations: string[]; excluded: string[]; languages: string[]; audience?: string }
): Row[] {
  return [
    ...targeting.locations.map((id) => ({ adGroup, location: { geoTargetConstant: `geoTargetConstants/${id}` } })),
    ...targeting.excluded.map((id) => ({ adGroup, negative: true, location: { geoTargetConstant: `geoTargetConstants/${id}` } })),
    ...targeting.languages.map((id) => ({ adGroup, language: { languageConstant: `languageConstants/${id}` } })),
    ...(targeting.audience ? [{ adGroup, audience: { audience: targeting.audience } }] : []),
  ];
}

// ── Anúncios Demand Gen ──────────────────────────────────────────────

const AD_TYPES = ["MULTI_ASSET", "CAROUSEL", "VIDEO_RESPONSIVE", "PRODUCT"] as const;
type AdType = (typeof AD_TYPES)[number];

/** Automações por anúncio (docs assets/asset-automation-settings, tabela "Ad-level"). */
const AD_AUTOMATION_TYPES: Record<AdType, string[]> = {
  MULTI_ASSET: ["GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS", "GENERATE_DESIGN_VERSIONS_FOR_IMAGES", "GENERATE_VIDEOS_FROM_OTHER_ASSETS"],
  VIDEO_RESPONSIVE: ["GENERATE_LANDING_PAGE_PREVIEW", "GENERATE_LANDING_PAGE_TEXT", "GENERATE_SHORTER_YOUTUBE_VIDEOS", "GENERATE_VERTICAL_YOUTUBE_VIDEOS"],
  CAROUSEL: [],
  PRODUCT: [],
};
const ALL_AD_AUTOMATION_TYPES = uniq(Object.values(AD_AUTOMATION_TYPES).flat()) as [string, ...string[]];

/** CallToActionTypeEnum (v25). */
const CALL_TO_ACTIONS = [
  "LEARN_MORE", "GET_QUOTE", "APPLY_NOW", "SIGN_UP", "CONTACT_US", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW",
  "SHOP_NOW", "BUY_NOW", "DONATE_NOW", "ORDER_NOW", "PLAY_NOW", "SEE_MORE", "START_NOW", "VISIT_SITE", "WATCH_NOW",
] as const;

/** Proporção (±1%) e tamanho mínimo de cada papel de imagem — DemandGen*AdInfo e DemandGenCarouselCardAsset (v25). */
const IMAGE_SPECS = {
  marketing: { label: "paisagem 1.91:1", ratio: 1.91, minWidth: 600, minHeight: 314 },
  square: { label: "quadrada 1:1", ratio: 1, minWidth: 300, minHeight: 300 },
  portrait: { label: "retrato 4:5", ratio: 0.8, minWidth: 480, minHeight: 600 },
  tall: { label: "vertical 9:16", ratio: 9 / 16, minWidth: 600, minHeight: 1067 },
  logo: { label: "logo 1:1", ratio: 1, minWidth: 128, minHeight: 128 },
  any: undefined,
} as const;
type ImageRole = keyof typeof IMAGE_SPECS;

interface ImageUse {
  role: ImageRole;
  field: string;
  ref: string;
  assetId?: string;
  resourceName?: string;
}

function youtubeId(value: string): string | undefined {
  const raw = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  const match = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(raw);
  return match?.[1];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Confere existência, tipo IMAGE, proporção e tamanho mínimo de cada imagem numa só consulta. */
async function checkImages(client: GoogleAdsClient, customerId: string, uses: ImageUse[]): Promise<string[]> {
  const ids = uniq(uses.map((use) => use.assetId).filter((id): id is string => !!id));
  if (!ids.length) return [];
  const rows = await client.searchStream(customerId,
    `SELECT asset.id, asset.name, asset.type, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
     FROM asset
     WHERE asset.id IN (${ids.join(", ")})`);
  const found = new Map(rows.map((row) => {
    const asset = obj(row.asset);
    return [String(asset.id), asset] as const;
  }));
  const problems: string[] = [];
  for (const use of uses) {
    const asset = found.get(use.assetId ?? "");
    if (!asset) {
      problems.push(`${use.field}: asset ${use.assetId} não existe nesta conta (suba com upload_image_asset; veja get_image_assets).`);
      continue;
    }
    if (asset.type !== "IMAGE") {
      problems.push(`${use.field}: asset ${use.assetId} é ${String(asset.type)}, não IMAGE.`);
      continue;
    }
    const spec = IMAGE_SPECS[use.role];
    if (!spec) continue;
    const size = obj(obj(asset.imageAsset).fullSize);
    const width = Number(size.widthPixels ?? 0);
    const height = Number(size.heightPixels ?? 0);
    if (!width || !height) continue; // sem dimensão na resposta: a API confere na gravação
    if (Math.abs(width / height - spec.ratio) > spec.ratio * 0.01) {
      problems.push(`${use.field}: asset ${use.assetId} tem ${width}x${height} (${(width / height).toFixed(2)}:1), mas o campo exige ${spec.label} (±1%).`);
    } else if (width < spec.minWidth || height < spec.minHeight) {
      problems.push(`${use.field}: asset ${use.assetId} tem ${width}x${height}; o mínimo para ${spec.label} é ${spec.minWidth}x${spec.minHeight}.`);
    }
  }
  return problems;
}

function textLimits(label: string, items: string[], limits: { min: number; max: number; chars: number }): string[] {
  const problems: string[] = [];
  if (items.length < limits.min || items.length > limits.max) {
    problems.push(limits.min === limits.max
      ? `${label}: exatamente ${limits.min} (recebido ${items.length}).`
      : `${label}: de ${limits.min} a ${limits.max} (recebido ${items.length}).`);
  }
  for (const item of items) {
    if (item.length > limits.chars) problems.push(`${label}: "${item}" tem ${item.length} caracteres (máximo ${limits.chars}).`);
  }
  return problems;
}

// ── Registro ─────────────────────────────────────────────────────────

export function registerDemandGenTools(ctx: ToolContext): void {
  const { mcp } = ctx;

  // ════════════════════════════════════════════════════════════════════
  // create_demand_gen_campaign (tool já existente, reescrita neste lote)
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "create_demand_gen_campaign",
    {
      description: [
        "Cria uma campanha Demand Gen (YouTube in-stream, in-feed e Shorts, Discover, Gmail, Display e Maps).",
        "WRITE OPERATION — a campanha nasce PAUSED.",
        "",
        "Orçamento, campanha e (opcional) o primeiro grupo de anúncios — com canais, localização, idioma e",
        "público — vão num único googleAds:mutate: ou tudo é criado, ou nada (sem orçamento órfão).",
        "Demand Gen NÃO usa asset groups (isso é Performance Max; a API recusa com",
        "CANNOT_ADD_ASSET_GROUP_FOR_CAMPAIGN_TYPE). Fluxo: esta tool com adGroup → create_demand_gen_ad",
        "(multi-asset, carrossel, vídeo ou produto). Mais grupos: create_demand_gen_ad_group.",
        "",
        "Lances: MAXIMIZE_CONVERSIONS, TARGET_CPA (targetCpaMicros), MAXIMIZE_CONVERSION_VALUE, TARGET_ROAS",
        "(targetRoas), MAXIMIZE_CLICKS (sem teto de CPC) e TARGET_CPC (targetCpcMicros). CPC manual não existe em Demand Gen.",
        "Orçamento: dailyBudgetMicros (diário) OU totalBudgetMicros + endDate (total do período, CUSTOM_PERIOD).",
        "Demand Gen não aceita orçamento compartilhado e exige no mínimo 5 USD/dia (ou o equivalente na moeda da conta).",
        "Com upgraded targeting (padrão da API), localização e idioma ficam no GRUPO: informe adGroup junto.",
        "merchantId liga o feed do Merchant Center (anúncios de produto).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da campanha (único na conta)."),
        dailyBudgetMicros: z.number().optional().describe("Orçamento DIÁRIO em micros (100000000 = R$ 100/dia). Use este OU totalBudgetMicros."),
        totalBudgetMicros: z.number().optional().describe("Orçamento TOTAL do período em micros (CUSTOM_PERIOD). Exige endDate."),
        startDate: z.string().optional().describe("Início YYYY-MM-DD (opcional; padrão: começa quando ativada)."),
        endDate: z.string().optional().describe("Término YYYY-MM-DD (obrigatório com totalBudgetMicros)."),
        biddingStrategy: z.enum(DEMAND_GEN_STRATEGIES).optional().describe("Estratégia de lances. Padrão: MAXIMIZE_CONVERSIONS."),
        targetCpaMicros: z.number().optional().describe("CPA desejado em micros (TARGET_CPA)."),
        targetRoas: z.number().optional().describe("ROAS desejado como multiplicador (TARGET_ROAS; 5.0 = 500%)."),
        targetCpcMicros: z.number().optional().describe("CPC alvo em micros (TARGET_CPC)."),
        viewThroughConversionOptimization: z.boolean().optional().describe("Liga a otimização para conversões view-through (VTC). Padrão da API: desligado."),
        merchantId: z.string().optional().describe("ID do Merchant Center para anúncios de produto (precisa estar vinculado à conta)."),
        feedLabel: z.string().optional().describe("Feed label dos produtos (ex.: BR). Opcional, só com merchantId."),
        upgradedTargeting: z.boolean().optional().describe("IMUTÁVEL. true (padrão da API) = localização/idioma no grupo; false = na campanha."),
        locationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a segmentar (Brasil = 2076)."),
        excludedLocationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a excluir."),
        languageIds: flexArray(z.string()).optional().describe("language_constant IDs (português = 1014)."),
        adGroup: z
          .object({
            name: z.string().describe("Nome do grupo."),
            channelStrategy: z.enum(CHANNEL_STRATEGIES).optional().describe("ALL_CHANNELS (padrão) ou ALL_OWNED_AND_OPERATED_CHANNELS (sem Display de terceiros)."),
            selectedChannels: flexArray(z.enum(CHANNEL_NAMES)).optional().describe(`Canais escolhidos um a um: ${CHANNEL_NAMES.join(", ")}. Use isto OU channelStrategy.`),
            optimizedTargeting: z.boolean().optional().describe("Segmentação otimizada (expansão de público)."),
            excludeDemographicExpansion: z.boolean().optional().describe("Com segmentação otimizada: não expandir dados demográficos."),
            audienceResourceName: z.string().optional().describe("Público (customers/{id}/audiences/{id}) — ex.: criado com create_audience_from_lists a partir de um lookalike."),
          })
          .optional()
          .describe("Primeiro grupo de anúncios, criado na mesma operação (nasce ENABLED dentro da campanha PAUSED, como no exemplo oficial)."),
      },
    },
    async ({
      customerId, name, dailyBudgetMicros, totalBudgetMicros, startDate, endDate, biddingStrategy, targetCpaMicros,
      targetRoas, targetCpcMicros, viewThroughConversionOptimization, merchantId, feedLabel, upgradedTargeting,
      locationIds, excludedLocationIds, languageIds, adGroup,
    }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      // ── Validação (nada sai para a API antes disto passar)
      const problems: string[] = [];
      if (!name?.trim()) problems.push("name vazio.");
      const budget = validateBudget({ dailyBudgetMicros, totalBudgetMicros, startDate, endDate });
      problems.push(...budget.problems);
      const bidding = demandGenBidding(biddingStrategy, { targetCpaMicros, targetRoas, targetCpcMicros });
      if (bidding.error) problems.push(bidding.error);
      const shopping = validateShopping(merchantId, feedLabel);
      problems.push(...shopping.problems);
      const locations = uniq(strings(locationIds));
      const excluded = uniq(strings(excludedLocationIds));
      const languages = uniq(strings(languageIds));
      problems.push(...idProblems("locationIds", locations), ...idProblems("excludedLocationIds", excluded), ...idProblems("languageIds", languages));
      const upgraded = upgradedTargeting !== false;
      let channels: ChannelChoice | undefined;
      let audience: { resourceName?: string; id?: string } | undefined;
      if (adGroup) {
        if (!adGroup.name?.trim()) problems.push("adGroup.name vazio.");
        const parsed = parseChannelChoice(adGroup.channelStrategy, adGroup.selectedChannels);
        if (parsed.error) problems.push(`adGroup: ${parsed.error}`);
        channels = parsed.choice;
        if (adGroup.audienceResourceName) {
          const ref = parseAudienceRef(adGroup.audienceResourceName, cid);
          if (ref.error) problems.push(`adGroup.audienceResourceName: ${ref.error}`);
          else audience = ref;
        }
      }
      const hasGeo = locations.length + excluded.length + languages.length > 0;
      if (hasGeo && upgraded && !adGroup) {
        problems.push(
          "com upgraded targeting (padrão), localização e idioma ficam no grupo de anúncios: informe adGroup " +
            "(ou crie sem eles e use create_demand_gen_ad_group / set_demand_gen_ad_group_targeting)."
        );
      }
      if (problems.length) return fail(`Nada foi criado:\n${bullets(problems)}`);
      const budgetPlan = budget.plan!;
      const biddingPlan = bidding.plan!;

      // ── Leituras: nome livre, moeda (mínimo em USD), constantes, público, Merchant Center
      const client = ctx.getClient();
      const clash = await findCampaignByName(client, customerId, name);
      if (clash) return fail(`Já existe a campanha "${name}" (ID ${clash}) nesta conta — a API recusa nome duplicado. Nada foi criado.`);
      const currency = await client.getAccountCurrency(customerId);
      if (currency === "USD" && budgetPlan.perDayMicros < DEMAND_GEN_MIN_USD_MICROS) {
        return fail(
          `Nada foi criado: Demand Gen exige no mínimo USD 5.00 por dia e o orçamento dá ${money(budgetPlan.perDayMicros, "USD")}/dia` +
            (budgetPlan.kind === "TOTAL" ? ` (${money(budgetPlan.amountMicros, "USD")} em ${budgetPlan.days} dia(s)).` : ".")
        );
      }
      const constants = await checkGeoAndLanguages(client, customerId, [...locations, ...excluded], languages);
      if (audience?.id) {
        const problem = await checkAudience(client, customerId, audience.id);
        if (problem) constants.problems.push(problem);
      }
      if (constants.problems.length) return fail(`Nada foi criado:\n${bullets(constants.problems)}`);
      const warnings = [...biddingPlan.warnings, ...constants.warnings];
      if (shopping.payload && !(await merchantLinked(client, customerId, String(shopping.payload.merchantId)))) {
        warnings.push(`Merchant Center ${String(shopping.payload.merchantId)} não aparece vinculado a esta conta (product_link). Se a API recusar, vincule em Ferramentas > Contas vinculadas.`);
      }
      if (biddingPlan.strategy === "TARGET_CPA" && targetCpaMicros && budgetPlan.perDayMicros < 15 * targetCpaMicros) {
        warnings.push(`O Google recomenda orçamento diário de pelo menos 15x o CPA desejado (${money(15 * targetCpaMicros, currency)}/dia).`);
      }
      if (!hasGeo) warnings.push("Sem localização/idioma: a campanha entrega em todos os países e idiomas. Defina com set_demand_gen_ad_group_targeting.");
      const budgetName = await freeBudgetName(client, customerId, name);

      // ── Operações: orçamento → campanha → grupo → critérios, com IDs temporários
      const temp = tempIds(cid);
      const budgetTmp = temp("campaignBudgets");
      const campaignTmp = temp("campaigns");
      const adGroupTmp = adGroup ? temp("adGroups") : undefined;
      const campaign: Row = {
        resourceName: campaignTmp,
        name,
        status: "PAUSED",
        advertisingChannelType: "DEMAND_GEN",
        campaignBudget: budgetTmp,
        containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        ...biddingPlan.fields,
        ...(budgetPlan.startDateTime ? { startDateTime: budgetPlan.startDateTime } : {}),
        ...(budgetPlan.endDateTime ? { endDateTime: budgetPlan.endDateTime } : {}),
        ...(viewThroughConversionOptimization !== undefined ? { viewThroughConversionOptimizationEnabled: viewThroughConversionOptimization } : {}),
        ...(shopping.payload ? { shoppingSetting: shopping.payload } : {}),
        ...(upgradedTargeting !== undefined ? { demandGenCampaignSettings: { upgradedTargeting } } : {}),
      };
      const operations: Row[] = [
        {
          campaignBudgetOperation: {
            create: { resourceName: budgetTmp, name: budgetName, deliveryMethod: "STANDARD", explicitlyShared: false, ...budgetPlan.payload },
          },
        },
        { campaignOperation: { create: campaign } },
      ];
      if (adGroup && adGroupTmp) {
        operations.push({
          adGroupOperation: {
            create: {
              resourceName: adGroupTmp,
              name: adGroup.name,
              campaign: campaignTmp,
              status: "ENABLED",
              ...(channels ? { demandGenAdGroupSettings: { channelControls: channelControlsPayload(channels) } } : {}),
              ...(adGroup.optimizedTargeting !== undefined ? { optimizedTargetingEnabled: adGroup.optimizedTargeting } : {}),
              ...(adGroup.excludeDemographicExpansion !== undefined ? { excludeDemographicExpansion: adGroup.excludeDemographicExpansion } : {}),
            },
          },
        });
      }
      if (upgraded && adGroupTmp) {
        for (const create of geoLanguageCriteria(adGroupTmp, { locations, excluded, languages, audience: audience?.resourceName })) {
          operations.push({ adGroupCriterionOperation: { create } });
        }
      } else {
        for (const id of locations) operations.push({ campaignCriterionOperation: { create: { campaign: campaignTmp, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } });
        for (const id of excluded) operations.push({ campaignCriterionOperation: { create: { campaign: campaignTmp, negative: true, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } });
        for (const id of languages) operations.push({ campaignCriterionOperation: { create: { campaign: campaignTmp, language: { languageConstant: `languageConstants/${id}` } } } });
        if (audience?.resourceName && adGroupTmp) operations.push({ adGroupCriterionOperation: { create: { adGroup: adGroupTmp, audience: { audience: audience.resourceName } } } });
      }

      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi criado (orçamento, campanha e grupo vão numa única operação atômica).\nErro: ${explainApiError(errorText(err), biddingPlan.strategy)}`);
      }
      const dryRun = client.isDryRun;
      const responses = responsesOf(result);
      const campaignResource = resultNames(responses, "campaignResult")[0];
      const adGroupResource = resultNames(responses, "adGroupResult")[0];
      if (!dryRun && !campaignResource) {
        return fail(`A API não confirmou a criação da campanha — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      }
      const lines = [
        dryRun ? DRY_RUN_NOTE : "Campanha Demand Gen criada (PAUSED).",
        `- Nome: ${name}`,
        `- Orçamento: ${budgetLabel(budgetPlan, currency)} (exclusivo da campanha)${budgetName !== `Budget — ${name}` ? ` — nome "${budgetName}"` : ""}`,
        `- Lances: ${biddingPlan.label}`,
        ...(budgetPlan.startDateTime || budgetPlan.endDateTime ? [`- Período: ${budgetPlan.startDateTime ?? "ao ativar"} → ${budgetPlan.endDateTime ?? "sem término"}`] : []),
        ...(viewThroughConversionOptimization !== undefined ? [`- Otimização view-through: ${viewThroughConversionOptimization ? "ligada" : "desligada"}`] : []),
        ...(shopping.payload ? [`- Merchant Center: ${String(shopping.payload.merchantId)}${shopping.payload.feedLabel ? ` (feed ${String(shopping.payload.feedLabel)})` : ""}`] : []),
        `- Segmentação de localização/idioma: ${upgraded ? "no grupo (upgraded targeting)" : "na campanha"}`,
        ...(campaignResource ? [`- Campanha: ${campaignResource}`] : []),
        ...(adGroup
          ? [
              `- Grupo "${adGroup.name}"${adGroupResource ? `: ${adGroupResource}` : ""} (ENABLED; nada entrega enquanto a campanha estiver PAUSED)`,
              `  canais: ${channels ? channelLabel(channels) : "ALL_CHANNELS (padrão)"}` +
                (locations.length ? ` · locais: ${locations.map((id) => constants.names.get(`geo:${id}`) ?? id).join(", ")}` : "") +
                (excluded.length ? ` · excluídos: ${excluded.join(", ")}` : "") +
                (languages.length ? ` · idiomas: ${languages.map((id) => constants.names.get(`lang:${id}`) ?? id).join(", ")}` : "") +
                (audience?.resourceName ? ` · público: ${audience.resourceName}` : ""),
            ]
          : []),
        ...(currency !== "USD" ? [`- Mínimo do Demand Gen: 5 USD/dia no equivalente em ${currency} (a API confere na criação).`] : []),
        ...(warnings.length ? ["", "Avisos:", bullets(warnings)] : []),
      ];
      if (!dryRun) {
        lines.push(
          "",
          "Próximos passos:",
          adGroupResource
            ? `1) create_demand_gen_ad com adGroupId=${idFromResource(adGroupResource)} (multi-asset, carrossel, vídeo ou produto).`
            : `1) create_demand_gen_ad_group com campaignId=${idFromResource(campaignResource)} (canais, localização, idioma, público).`,
          "2) Quando tudo estiver pronto, ative a campanha com update_campaign. Não use create_asset_group: é só Performance Max."
        );
      }
      return done(lines.join("\n"));
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // create_display_campaign (tool já existente, reescrita neste lote)
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "create_display_campaign",
    {
      description: [
        "Cria uma campanha de Display (Rede de Display do Google).",
        "WRITE OPERATION — a campanha nasce PAUSED.",
        "",
        "Orçamento, campanha, localização/idioma e (opcional) o primeiro grupo com listas de remarketing vão num",
        "único googleAds:mutate: ou tudo é criado, ou nada (sem orçamento órfão).",
        "Lances: MAXIMIZE_CONVERSIONS, TARGET_CPA, MAXIMIZE_CONVERSION_VALUE, TARGET_ROAS, MAXIMIZE_CLICKS",
        "(= TARGET_SPEND, teto opcional cpcBidCeilingMicros), MANUAL_CPC e MANUAL_CPM (CPM visível; lance no grupo).",
        "",
        "Remarketing dinâmico de varejo: merchantId (Merchant Center vinculado) + adGroup.userListIds (listas de",
        "remarketing) e depois create_responsive_display_ad no grupo — o anúncio responsivo puxa os produtos do feed.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da campanha (único na conta)."),
        dailyBudgetMicros: z.number().describe("Orçamento diário em micros (100000000 = R$ 100/dia)."),
        biddingStrategy: z.enum(DISPLAY_STRATEGIES).optional().describe("Padrão: MAXIMIZE_CONVERSIONS. TARGET_SPEND = MAXIMIZE_CLICKS."),
        targetCpaMicros: z.number().optional().describe("CPA desejado em micros (TARGET_CPA)."),
        targetRoas: z.number().optional().describe("ROAS desejado (TARGET_ROAS; 5.0 = 500%)."),
        cpcBidCeilingMicros: z.number().optional().describe("Teto de CPC em micros (só MAXIMIZE_CLICKS)."),
        merchantId: z.string().optional().describe("Merchant Center para remarketing dinâmico de varejo (shopping_setting.merchant_id)."),
        feedLabel: z.string().optional().describe("Feed label dos produtos (ex.: BR). Opcional, só com merchantId."),
        enableLocal: z.boolean().optional().describe("Inclui produtos de inventário local (shopping_setting.enable_local). Só com merchantId."),
        campaignPriority: z.number().optional().describe("Prioridade do feed 0, 1 ou 2 (só com merchantId). Padrão: 0, como no exemplo oficial."),
        locationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs (Brasil = 2076), na campanha."),
        languageIds: flexArray(z.string()).optional().describe("language_constant IDs (português = 1014), na campanha."),
        adGroup: z
          .object({
            name: z.string().describe("Nome do grupo."),
            cpcBidMicros: z.number().optional().describe("CPC do grupo em micros — obrigatório com MANUAL_CPC."),
            cpmBidMicros: z.number().optional().describe("CPM do grupo em micros — obrigatório com MANUAL_CPM."),
            userListIds: flexArray(z.string()).optional().describe("IDs das listas de remarketing a segmentar (list_remarketing_lists)."),
          })
          .optional()
          .describe("Primeiro grupo (DISPLAY_STANDARD), criado na mesma operação (ENABLED dentro da campanha PAUSED)."),
      },
    },
    async ({
      customerId, name, dailyBudgetMicros, biddingStrategy, targetCpaMicros, targetRoas, cpcBidCeilingMicros,
      merchantId, feedLabel, enableLocal, campaignPriority, locationIds, languageIds, adGroup,
    }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      const problems: string[] = [];
      if (!name?.trim()) problems.push("name vazio.");
      const budgetProblem = microsProblem("dailyBudgetMicros", dailyBudgetMicros);
      if (budgetProblem) problems.push(budgetProblem);
      const bidding = displayBidding(biddingStrategy, { targetCpaMicros, targetRoas, cpcBidCeilingMicros });
      if (bidding.error) problems.push(bidding.error);
      const shopping = validateShopping(merchantId, feedLabel);
      problems.push(...shopping.problems);
      if (!shopping.payload && (enableLocal !== undefined || campaignPriority !== undefined)) {
        problems.push("enableLocal e campaignPriority só valem junto com merchantId.");
      }
      if (campaignPriority !== undefined && ![0, 1, 2].includes(campaignPriority)) {
        problems.push(`campaignPriority deve ser 0, 1 ou 2 (recebido ${campaignPriority}).`);
      }
      const locations = uniq(strings(locationIds));
      const languages = uniq(strings(languageIds));
      problems.push(...idProblems("locationIds", locations), ...idProblems("languageIds", languages));
      const userLists = adGroup ? uniq(strings(adGroup.userListIds)) : [];
      if (adGroup) {
        if (!adGroup.name?.trim()) problems.push("adGroup.name vazio.");
        problems.push(...idProblems("adGroup.userListIds", userLists));
        for (const [label, value] of [["adGroup.cpcBidMicros", adGroup.cpcBidMicros], ["adGroup.cpmBidMicros", adGroup.cpmBidMicros]] as const) {
          if (value !== undefined && !isPositiveMicros(value)) problems.push(`${label} deve ser inteiro positivo em micros (recebido ${value}).`);
        }
        if (bidding.plan?.strategy === "MANUAL_CPC" && adGroup.cpcBidMicros === undefined) problems.push("MANUAL_CPC: informe adGroup.cpcBidMicros (o lance real do grupo).");
        if (bidding.plan?.strategy === "MANUAL_CPM" && adGroup.cpmBidMicros === undefined) problems.push("MANUAL_CPM: informe adGroup.cpmBidMicros (o lance real do grupo).");
      }
      if (problems.length) return fail(`Nada foi criado:\n${bullets(problems)}`);
      const biddingPlan = bidding.plan!;

      const client = ctx.getClient();
      const clash = await findCampaignByName(client, customerId, name);
      if (clash) return fail(`Já existe a campanha "${name}" (ID ${clash}) nesta conta — a API recusa nome duplicado. Nada foi criado.`);
      const constants = await checkGeoAndLanguages(client, customerId, locations, languages);
      const warnings = [...biddingPlan.warnings, ...constants.warnings];
      if (userLists.length) {
        const rows = await client.searchStream(customerId,
          `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status,
                  user_list.eligible_for_display, user_list.size_for_display
           FROM user_list
           WHERE user_list.id IN (${userLists.join(", ")})`);
        const found = new Map(rows.map((row) => [String(obj(row.userList).id), obj(row.userList)] as const));
        for (const id of userLists) {
          const list = found.get(id);
          if (!list) constants.problems.push(`lista de remarketing ${id} não encontrada (list_remarketing_lists).`);
          else if (list.eligibleForDisplay === false) constants.problems.push(`lista ${id} ("${String(list.name)}") não é elegível para Display.`);
          else if (list.membershipStatus === "CLOSED") warnings.push(`lista ${id} ("${String(list.name)}") está CLOSED: não recebe novos membros.`);
        }
      }
      if (constants.problems.length) return fail(`Nada foi criado:\n${bullets(constants.problems)}`);
      if (shopping.payload && !(await merchantLinked(client, customerId, String(shopping.payload.merchantId)))) {
        warnings.push(`Merchant Center ${String(shopping.payload.merchantId)} não aparece vinculado a esta conta (product_link). Se a API recusar, vincule em Ferramentas > Contas vinculadas.`);
      }
      if (shopping.payload && !userLists.length) {
        warnings.push("Remarketing dinâmico precisa de uma lista de remarketing no grupo: informe adGroup.userListIds (ou adicione depois).");
      }
      if (!adGroup && (biddingPlan.strategy === "MANUAL_CPC" || biddingPlan.strategy === "MANUAL_CPM")) {
        warnings.push(`${biddingPlan.strategy}: cada grupo criado depois precisa do lance (${biddingPlan.strategy === "MANUAL_CPC" ? "cpcBidMicros" : "cpmBidMicros"} no create_ad_group).`);
      }
      const budgetName = await freeBudgetName(client, customerId, name);

      const temp = tempIds(cid);
      const budgetTmp = temp("campaignBudgets");
      const campaignTmp = temp("campaigns");
      const adGroupTmp = adGroup ? temp("adGroups") : undefined;
      const shoppingSetting: Row | undefined = shopping.payload
        ? { ...shopping.payload, campaignPriority: campaignPriority ?? 0, ...(enableLocal !== undefined ? { enableLocal } : {}) }
        : undefined;
      const operations: Row[] = [
        {
          campaignBudgetOperation: {
            create: { resourceName: budgetTmp, name: budgetName, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false },
          },
        },
        {
          campaignOperation: {
            create: {
              resourceName: campaignTmp,
              name,
              status: "PAUSED",
              advertisingChannelType: "DISPLAY",
              campaignBudget: budgetTmp,
              containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
              networkSettings: { targetContentNetwork: true, targetGoogleSearch: false, targetSearchNetwork: false },
              ...biddingPlan.fields,
              ...(shoppingSetting ? { shoppingSetting } : {}),
            },
          },
        },
        ...locations.map((id) => ({ campaignCriterionOperation: { create: { campaign: campaignTmp, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } })),
        ...languages.map((id) => ({ campaignCriterionOperation: { create: { campaign: campaignTmp, language: { languageConstant: `languageConstants/${id}` } } } })),
      ];
      if (adGroup && adGroupTmp) {
        operations.push({
          adGroupOperation: {
            create: {
              resourceName: adGroupTmp,
              name: adGroup.name,
              campaign: campaignTmp,
              status: "ENABLED",
              type: "DISPLAY_STANDARD",
              ...(adGroup.cpcBidMicros !== undefined ? { cpcBidMicros: String(adGroup.cpcBidMicros) } : {}),
              ...(adGroup.cpmBidMicros !== undefined ? { cpmBidMicros: String(adGroup.cpmBidMicros) } : {}),
            },
          },
        });
        for (const id of userLists) {
          operations.push({ adGroupCriterionOperation: { create: { adGroup: adGroupTmp, userList: { userList: `customers/${cid}/userLists/${id}` } } } });
        }
      }

      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi criado (orçamento, campanha e grupo vão numa única operação atômica).\nErro: ${explainApiError(errorText(err), biddingPlan.strategy)}`);
      }
      const dryRun = client.isDryRun;
      const responses = responsesOf(result);
      const campaignResource = resultNames(responses, "campaignResult")[0];
      const adGroupResource = resultNames(responses, "adGroupResult")[0];
      if (!dryRun && !campaignResource) {
        return fail(`A API não confirmou a criação da campanha — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      }
      const lines = [
        dryRun ? DRY_RUN_NOTE : "Campanha de Display criada (PAUSED).",
        `- Nome: ${name}`,
        `- Orçamento: ${money(dailyBudgetMicros)}/dia`,
        `- Lances: ${biddingPlan.label}`,
        ...(shoppingSetting ? [`- Merchant Center: ${String(shoppingSetting.merchantId)} (prioridade ${String(shoppingSetting.campaignPriority)}${shoppingSetting.feedLabel ? `, feed ${String(shoppingSetting.feedLabel)}` : ""}${enableLocal ? ", com inventário local" : ""})`] : []),
        ...(locations.length ? [`- Locais: ${locations.map((id) => constants.names.get(`geo:${id}`) ?? id).join(", ")}`] : []),
        ...(languages.length ? [`- Idiomas: ${languages.map((id) => constants.names.get(`lang:${id}`) ?? id).join(", ")}`] : []),
        ...(campaignResource ? [`- Campanha: ${campaignResource}`] : []),
        ...(adGroup ? [`- Grupo "${adGroup.name}"${adGroupResource ? `: ${adGroupResource}` : ""} (DISPLAY_STANDARD, ENABLED)${userLists.length ? ` · listas: ${userLists.join(", ")}` : ""}`] : []),
        ...(warnings.length ? ["", "Avisos:", bullets(warnings)] : []),
      ];
      if (!dryRun) {
        lines.push(
          "",
          adGroupResource
            ? `Próximo passo: create_responsive_display_ad com adGroupId=${idFromResource(adGroupResource)}${shoppingSetting ? " (o anúncio responsivo puxa os produtos do feed)" : ""}; depois update_campaign para ativar.`
            : "Próximo passo: create_ad_group e create_responsive_display_ad; depois update_campaign para ativar."
        );
      }
      return done(lines.join("\n"));
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // create_demand_gen_ad_group
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "create_demand_gen_ad_group",
    {
      description: [
        "Cria um grupo de anúncios Demand Gen (sem type, como a API exige) numa campanha DEMAND_GEN existente.",
        "WRITE OPERATION — nasce PAUSED por padrão.",
        "",
        "Na mesma operação atômica: canais (channelStrategy ou selectedChannels: YouTube in-stream, in-feed,",
        "Shorts, Discover, Gmail, Display, Maps), segmentação otimizada, lances do grupo (CPC/CPA/ROAS alvo),",
        "localização, idioma e público. Localização/idioma no grupo exigem campanha com upgraded targeting",
        "(padrão) e sem critérios de localização/idioma na campanha.",
        "Depois: create_demand_gen_ad.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha DEMAND_GEN."),
        name: z.string().describe("Nome do grupo (único na campanha)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Padrão: PAUSED."),
        channelStrategy: z.enum(CHANNEL_STRATEGIES).optional().describe("ALL_CHANNELS (padrão) ou ALL_OWNED_AND_OPERATED_CHANNELS."),
        selectedChannels: flexArray(z.enum(CHANNEL_NAMES)).optional().describe(`Canais um a um: ${CHANNEL_NAMES.join(", ")}.`),
        optimizedTargeting: z.boolean().optional().describe("Segmentação otimizada."),
        excludeDemographicExpansion: z.boolean().optional().describe("Com segmentação otimizada: não expandir demografia."),
        targetCpcMicros: z.number().optional().describe("CPC alvo do grupo em micros (campanha em TARGET_CPC)."),
        targetCpaMicros: z.number().optional().describe("CPA alvo do grupo em micros (campanha com CPA alvo)."),
        targetRoas: z.number().optional().describe("ROAS alvo do grupo (campanha com ROAS alvo)."),
        locationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a segmentar."),
        excludedLocationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a excluir."),
        languageIds: flexArray(z.string()).optional().describe("language_constant IDs."),
        audienceResourceName: z.string().optional().describe("Público (customers/{id}/audiences/{id})."),
      },
    },
    async ({
      customerId, campaignId, name, status, channelStrategy, selectedChannels, optimizedTargeting,
      excludeDemographicExpansion, targetCpcMicros, targetCpaMicros, targetRoas, locationIds, excludedLocationIds,
      languageIds, audienceResourceName,
    }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      const problems: string[] = [];
      if (!NUMERIC.test(campaignId ?? "")) problems.push("campaignId deve ser o ID numérico da campanha.");
      if (!name?.trim()) problems.push("name vazio.");
      const parsed = parseChannelChoice(channelStrategy, selectedChannels);
      if (parsed.error) problems.push(parsed.error);
      for (const [label, value] of [["targetCpcMicros", targetCpcMicros], ["targetCpaMicros", targetCpaMicros]] as const) {
        if (value !== undefined && !isPositiveMicros(value)) problems.push(`${label} deve ser inteiro positivo em micros (recebido ${value}).`);
      }
      if (targetRoas !== undefined) {
        const problem = roasProblem(targetRoas);
        if (problem) problems.push(problem);
      }
      const locations = uniq(strings(locationIds));
      const excluded = uniq(strings(excludedLocationIds));
      const languages = uniq(strings(languageIds));
      problems.push(...idProblems("locationIds", locations), ...idProblems("excludedLocationIds", excluded), ...idProblems("languageIds", languages));
      const audience = audienceResourceName ? parseAudienceRef(audienceResourceName, cid) : undefined;
      if (audience?.error) problems.push(`audienceResourceName: ${audience.error}`);
      if (problems.length) return fail(`Nada foi criado:\n${bullets(problems)}`);

      const client = ctx.getClient();
      const campaign = await loadCampaign(client, customerId, campaignId);
      if (!campaign) return fail(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi criado.`);
      if (campaign.advertisingChannelType !== "DEMAND_GEN") {
        return fail(`A campanha ${campaignId} é ${String(campaign.advertisingChannelType)}, não DEMAND_GEN — use create_ad_group. Nada foi criado.`);
      }
      const hasGeo = locations.length + excluded.length + languages.length > 0;
      if (hasGeo && !usesUpgradedTargeting(campaign)) {
        return fail(`A campanha ${campaignId} não usa upgraded targeting: localização e idioma ficam na campanha (set_campaign_locations / set_campaign_languages). Nada foi criado.`);
      }
      if (hasGeo) {
        const atCampaign = (await campaignsWithGeoLanguage(client, customerId, [campaignId])).get(String(campaignId)) ?? 0;
        if (atCampaign > 0) {
          return fail(`A campanha ${campaignId} já tem ${atCampaign} critério(s) de localização/idioma no nível da campanha. Em Demand Gen é campanha OU grupo, nunca os dois. Nada foi criado.`);
        }
      }
      const duplicate = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name FROM ad_group
         WHERE campaign.id = ${campaignId} AND ad_group.name = '${gaqlLiteral(name)}' AND ad_group.status != 'REMOVED'`);
      if (duplicate.length) {
        return fail(`Já existe o grupo "${name}" (ID ${String(obj(duplicate[0].adGroup).id)}) nesta campanha. Para mudar canais/lances use update_demand_gen_ad_group. Nada foi criado.`);
      }
      const constants = await checkGeoAndLanguages(client, customerId, [...locations, ...excluded], languages);
      if (audience?.id) {
        const problem = await checkAudience(client, customerId, audience.id);
        if (problem) constants.problems.push(problem);
      }
      if (constants.problems.length) return fail(`Nada foi criado:\n${bullets(constants.problems)}`);
      const warnings = [
        ...constants.warnings,
        ...adGroupBidWarnings(String(campaign.biddingStrategyType ?? ""), { targetCpcMicros, targetCpaMicros, targetRoas }),
      ];
      if (excludeDemographicExpansion && !optimizedTargeting) warnings.push("excludeDemographicExpansion só tem efeito com optimizedTargeting ligado.");

      const temp = tempIds(cid);
      const adGroupTmp = temp("adGroups");
      const operations: Row[] = [
        {
          adGroupOperation: {
            create: {
              resourceName: adGroupTmp,
              name,
              campaign: `customers/${cid}/campaigns/${campaignId}`,
              status: status ?? "PAUSED",
              ...(parsed.choice ? { demandGenAdGroupSettings: { channelControls: channelControlsPayload(parsed.choice) } } : {}),
              ...(optimizedTargeting !== undefined ? { optimizedTargetingEnabled: optimizedTargeting } : {}),
              ...(excludeDemographicExpansion !== undefined ? { excludeDemographicExpansion } : {}),
              ...(targetCpcMicros !== undefined ? { targetCpcMicros: String(targetCpcMicros) } : {}),
              ...(targetCpaMicros !== undefined ? { targetCpaMicros: String(targetCpaMicros) } : {}),
              ...(targetRoas !== undefined ? { targetRoas } : {}),
            },
          },
        },
        ...geoLanguageCriteria(adGroupTmp, { locations, excluded, languages, audience: audience?.resourceName })
          .map((create) => ({ adGroupCriterionOperation: { create } })),
      ];
      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi criado (grupo e critérios vão numa única operação atômica).\nErro: ${explainApiError(errorText(err))}`);
      }
      const dryRun = client.isDryRun;
      const adGroupResource = resultNames(responsesOf(result), "adGroupResult")[0];
      if (!dryRun && !adGroupResource) return fail(`A API não confirmou a criação do grupo — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      const lines = [
        dryRun ? DRY_RUN_NOTE : `Grupo Demand Gen criado (${status ?? "PAUSED"}).`,
        `- Campanha: ${String(campaign.name)} (${campaignId})`,
        `- Grupo: ${name}${adGroupResource ? ` — ${adGroupResource}` : ""}`,
        `- Canais: ${parsed.choice ? channelLabel(parsed.choice) : "ALL_CHANNELS (padrão)"}`,
        ...(optimizedTargeting !== undefined ? [`- Segmentação otimizada: ${optimizedTargeting ? "ligada" : "desligada"}`] : []),
        ...(locations.length ? [`- Locais: ${locations.map((id) => constants.names.get(`geo:${id}`) ?? id).join(", ")}`] : []),
        ...(excluded.length ? [`- Locais excluídos: ${excluded.map((id) => constants.names.get(`geo:${id}`) ?? id).join(", ")}`] : []),
        ...(languages.length ? [`- Idiomas: ${languages.map((id) => constants.names.get(`lang:${id}`) ?? id).join(", ")}`] : []),
        ...(audience?.resourceName ? [`- Público: ${audience.resourceName}`] : []),
        ...(warnings.length ? ["", "Avisos:", bullets(warnings)] : []),
        ...(!dryRun && adGroupResource ? ["", `Próximo passo: create_demand_gen_ad com adGroupId=${idFromResource(adGroupResource)}.`] : []),
      ];
      return done(lines.join("\n"));
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // update_demand_gen_ad_group
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "update_demand_gen_ad_group",
    {
      description: [
        "Altera canais, segmentação otimizada e lances (CPC/CPA/ROAS alvo) de um grupo Demand Gen.",
        "WRITE OPERATION — lê o grupo antes, envia só o que muda (updateMask com caminhos-folha) e mostra antes/depois.",
        "Nome e status: update_ad_group. Localização, idioma e público: set_demand_gen_ad_group_targeting.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID numérico do grupo."),
        channelStrategy: z.enum(CHANNEL_STRATEGIES).optional().describe("ALL_CHANNELS ou ALL_OWNED_AND_OPERATED_CHANNELS."),
        selectedChannels: flexArray(z.enum(CHANNEL_NAMES)).optional().describe(`Canais um a um: ${CHANNEL_NAMES.join(", ")} (os não listados ficam desligados).`),
        optimizedTargeting: z.boolean().optional().describe("Segmentação otimizada."),
        excludeDemographicExpansion: z.boolean().optional().describe("Não expandir demografia na segmentação otimizada."),
        targetCpcMicros: z.number().optional().describe("CPC alvo do grupo em micros."),
        targetCpaMicros: z.number().optional().describe("CPA alvo do grupo em micros."),
        targetRoas: z.number().optional().describe("ROAS alvo do grupo."),
      },
    },
    async ({ customerId, adGroupId, channelStrategy, selectedChannels, optimizedTargeting, excludeDemographicExpansion, targetCpcMicros, targetCpaMicros, targetRoas }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      const problems: string[] = [];
      if (!NUMERIC.test(adGroupId ?? "")) problems.push("adGroupId deve ser o ID numérico do grupo.");
      const parsed = parseChannelChoice(channelStrategy, selectedChannels);
      if (parsed.error) problems.push(parsed.error);
      for (const [label, value] of [["targetCpcMicros", targetCpcMicros], ["targetCpaMicros", targetCpaMicros]] as const) {
        if (value !== undefined && !isPositiveMicros(value)) problems.push(`${label} deve ser inteiro positivo em micros (recebido ${value}).`);
      }
      if (targetRoas !== undefined) {
        const problem = roasProblem(targetRoas);
        if (problem) problems.push(problem);
      }
      if ([channelStrategy, selectedChannels, optimizedTargeting, excludeDemographicExpansion, targetCpcMicros, targetCpaMicros, targetRoas].every((value) => value === undefined)) {
        problems.push("informe ao menos um campo para alterar.");
      }
      if (problems.length) return fail(`Nada foi alterado:\n${bullets(problems)}`);

      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.optimized_targeting_enabled,
                ad_group.exclude_demographic_expansion, ad_group.target_cpc_micros, ad_group.target_cpa_micros,
                ad_group.target_roas, ${CHANNEL_FIELDS},
                campaign.id, campaign.advertising_channel_type, campaign.bidding_strategy_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId} AND ad_group.status != 'REMOVED'`);
      const adGroup = rows[0] ? obj(rows[0].adGroup) : undefined;
      const campaign = obj(rows[0]?.campaign);
      if (!adGroup) return fail(`Grupo ${adGroupId} não encontrado na conta ${cid}. Nada foi alterado.`);
      if (campaign.advertisingChannelType !== "DEMAND_GEN") {
        return fail(`O grupo ${adGroupId} é de campanha ${String(campaign.advertisingChannelType)}, não DEMAND_GEN — use update_ad_group. Nada foi alterado.`);
      }

      const update: Row = { resourceName: `customers/${cid}/adGroups/${adGroupId}` };
      const mask: string[] = [];
      const changes: Array<{ campo: string; antes: unknown; depois: unknown }> = [];
      if (parsed.choice) {
        const current = currentChannels(adGroup);
        if (!sameChannels(current, parsed.choice)) {
          update.demandGenAdGroupSettings = { channelControls: channelControlsPayload(parsed.choice) };
          if (parsed.choice.strategy) mask.push(`${CHANNEL_MASK_PREFIX}.channel_strategy`);
          else for (const channel of CHANNEL_NAMES) mask.push(`${CHANNEL_MASK_PREFIX}.selected_channels.${CHANNELS[channel].path}`);
          changes.push({ campo: "canais", antes: current.label, depois: channelLabel(parsed.choice) });
        }
      }
      const setBool = (key: string, path: string, value: boolean | undefined) => {
        const before = adGroup[key] === true;
        if (value === undefined || value === before) return;
        update[key] = value;
        mask.push(path);
        changes.push({ campo: key, antes: before, depois: value });
      };
      setBool("optimizedTargetingEnabled", "optimized_targeting_enabled", optimizedTargeting);
      setBool("excludeDemographicExpansion", "exclude_demographic_expansion", excludeDemographicExpansion);
      const setNumber = (key: string, path: string, value: number | undefined, micros: boolean) => {
        if (value === undefined || String(adGroup[key] ?? "") === String(value)) return;
        update[key] = micros ? String(value) : value;
        mask.push(path);
        changes.push({ campo: key, antes: adGroup[key] ?? null, depois: value });
      };
      setNumber("targetCpcMicros", "target_cpc_micros", targetCpcMicros, true);
      setNumber("targetCpaMicros", "target_cpa_micros", targetCpaMicros, true);
      setNumber("targetRoas", "target_roas", targetRoas, false);

      if (mask.length === 0) {
        return done(`Grupo ${adGroupId}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`);
      }
      const warnings = adGroupBidWarnings(String(campaign.biddingStrategyType ?? ""), { targetCpcMicros, targetCpaMicros, targetRoas });
      const optimizedAfter = optimizedTargeting ?? adGroup.optimizedTargetingEnabled === true;
      if (excludeDemographicExpansion && !optimizedAfter) warnings.push("excludeDemographicExpansion só tem efeito com a segmentação otimizada ligada.");

      let result: Row;
      try {
        result = await client.mutate(customerId, "adGroups", [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return fail(`Nada foi alterado.\nErro: ${explainApiError(errorText(err))}`);
      }
      const dryRun = client.isDryRun;
      return done(
        (dryRun ? `Grupo ${adGroupId} — ${DRY_RUN_NOTE}` : `Grupo Demand Gen ${adGroupId} ("${String(adGroup.name)}") atualizado.`) +
          `\n\n${formatJson({ mudancas: changes, avisos: warnings, update_mask: mask, resultado: result })}`
      );
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // set_demand_gen_ad_group_targeting
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "set_demand_gen_ad_group_targeting",
    {
      description: [
        "Define localização, idioma e público de grupos Demand Gen (critérios de GRUPO, como exige o upgraded targeting).",
        "WRITE OPERATION. Por padrão ADICIONA o que falta (o que já existe é ignorado).",
        "replace=true substitui a dimensão informada (remove o que não está na lista nova) e exige confirm=true;",
        "sem confirm, mostra a prévia do que seria removido e não grava nada.",
        "Alvo: adGroupIds OU campaignId (todos os grupos ativos/pausados da campanha).",
        "Campanhas sem upgraded targeting usam set_campaign_locations / set_campaign_languages.",
        "Tudo vai numa única requisição atômica: se um critério for recusado, nada muda.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupIds: flexArray(z.string()).optional().describe("IDs dos grupos Demand Gen."),
        campaignId: z.string().optional().describe("Ou: aplica em todos os grupos (não removidos) desta campanha Demand Gen."),
        locationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a segmentar."),
        excludedLocationIds: flexArray(z.string()).optional().describe("geo_target_constant IDs a excluir."),
        languageIds: flexArray(z.string()).optional().describe("language_constant IDs."),
        audienceResourceName: z.string().optional().describe("Público (customers/{id}/audiences/{id}); o grupo aceita um."),
        replace: z.boolean().optional().describe("true = substitui as dimensões informadas. Exige confirm=true."),
        confirm: z.boolean().optional().describe("Confirma a remoção de critérios quando replace=true."),
      },
    },
    async ({ customerId, adGroupIds, campaignId, locationIds, excludedLocationIds, languageIds, audienceResourceName, replace, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      const problems: string[] = [];
      const groups = uniq(strings(adGroupIds));
      if ((groups.length > 0) === Boolean(campaignId)) problems.push("informe adGroupIds OU campaignId (um dos dois).");
      problems.push(...idProblems("adGroupIds", groups));
      if (campaignId && !NUMERIC.test(campaignId)) problems.push("campaignId deve ser numérico.");
      const locations = uniq(strings(locationIds));
      const excluded = uniq(strings(excludedLocationIds));
      const languages = uniq(strings(languageIds));
      problems.push(...idProblems("locationIds", locations), ...idProblems("excludedLocationIds", excluded), ...idProblems("languageIds", languages));
      const audience = audienceResourceName ? parseAudienceRef(audienceResourceName, cid) : undefined;
      if (audience?.error) problems.push(`audienceResourceName: ${audience.error}`);
      if (!locations.length && !excluded.length && !languages.length && !audience) {
        problems.push("informe ao menos uma dimensão: locationIds, excludedLocationIds, languageIds ou audienceResourceName (listas vazias são ignoradas — remover toda a localização não é feito por aqui).");
      }
      const overlap = locations.filter((id) => excluded.includes(id));
      if (overlap.length) problems.push(`localização segmentada e excluída ao mesmo tempo: ${overlap.join(", ")}.`);
      if (problems.length) return fail(`Nada foi alterado:\n${bullets(problems)}`);

      const client = ctx.getClient();
      const where = campaignId ? `campaign.id = ${campaignId}` : `ad_group.id IN (${groups.join(", ")})`;
      const adGroupRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name,
                campaign.advertising_channel_type, campaign.demand_gen_campaign_settings.upgraded_targeting
         FROM ad_group
         WHERE ${where} AND ad_group.status != 'REMOVED'`);
      const found = adGroupRows.map((row) => ({ adGroup: obj(row.adGroup), campaign: obj(row.campaign) }));
      if (!found.length) return fail(`Nenhum grupo encontrado (${campaignId ? `campanha ${campaignId}` : `grupos ${groups.join(", ")}`}) na conta ${cid}. Nada foi alterado.`);
      const missing = groups.filter((id) => !found.some((item) => String(item.adGroup.id) === id));
      if (missing.length) return fail(`Grupo(s) não encontrado(s) na conta ${cid}: ${missing.join(", ")}. Nada foi alterado.`);
      const notDemandGen = found.filter((item) => item.campaign.advertisingChannelType !== "DEMAND_GEN");
      if (notDemandGen.length) {
        return fail(`Só grupos de campanhas DEMAND_GEN: ${notDemandGen.map((item) => `${String(item.adGroup.id)} (${String(item.campaign.advertisingChannelType)})`).join(", ")}. Nada foi alterado.`);
      }
      const legacy = found.filter((item) => !usesUpgradedTargeting(item.campaign));
      if (legacy.length && (locations.length || excluded.length || languages.length)) {
        return fail(`A(s) campanha(s) ${uniq(legacy.map((item) => String(item.campaign.id))).join(", ")} não usa(m) upgraded targeting: localização/idioma ficam na campanha (set_campaign_locations / set_campaign_languages). Nada foi alterado.`);
      }
      if (locations.length || excluded.length || languages.length) {
        const atCampaign = await campaignsWithGeoLanguage(client, customerId, found.map((item) => String(item.campaign.id)));
        if (atCampaign.size) {
          return fail(`Campanha(s) com localização/idioma no nível da campanha: ${[...atCampaign.keys()].join(", ")}. Em Demand Gen é campanha OU grupo, nunca os dois. Nada foi alterado.`);
        }
      }
      const constants = await checkGeoAndLanguages(client, customerId, [...locations, ...excluded], languages);
      if (audience?.id) {
        const problem = await checkAudience(client, customerId, audience.id);
        if (problem) constants.problems.push(problem);
      }
      if (constants.problems.length) return fail(`Nada foi alterado:\n${bullets(constants.problems)}`);

      const ids = found.map((item) => String(item.adGroup.id));
      const criteriaRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.negative,
                ad_group_criterion.location.geo_target_constant, ad_group_criterion.language.language_constant,
                ad_group_criterion.audience.audience
         FROM ad_group_criterion
         WHERE ad_group.id IN (${ids.join(", ")})
           AND ad_group_criterion.type IN ('LOCATION', 'LANGUAGE', 'AUDIENCE')
           AND ad_group_criterion.status != 'REMOVED'`);
      type Existing = { resourceName: string; key: string };
      const existingByGroup = new Map<string, { loc: Existing[]; neg: Existing[]; lang: Existing[]; aud: Existing[] }>();
      for (const id of ids) existingByGroup.set(id, { loc: [], neg: [], lang: [], aud: [] });
      for (const row of criteriaRows) {
        const bucket = existingByGroup.get(String(obj(row.adGroup).id));
        const criterion = obj(row.adGroupCriterion);
        if (!bucket) continue;
        const resourceName = String(criterion.resourceName ?? "");
        if (criterion.type === "LOCATION") {
          const key = String(obj(criterion.location).geoTargetConstant ?? "").split("/").pop() ?? "";
          (criterion.negative === true ? bucket.neg : bucket.loc).push({ resourceName, key });
        } else if (criterion.type === "LANGUAGE") {
          bucket.lang.push({ resourceName, key: String(obj(criterion.language).languageConstant ?? "").split("/").pop() ?? "" });
        } else if (criterion.type === "AUDIENCE") {
          bucket.aud.push({ resourceName, key: String(obj(criterion.audience).audience ?? "") });
        }
      }

      const removes: string[] = [];
      const creates: Row[] = [];
      const plan: Row[] = [];
      const conflicts: string[] = [];
      for (const { adGroup } of found) {
        const id = String(adGroup.id);
        const resource = `customers/${cid}/adGroups/${id}`;
        const existing = existingByGroup.get(id)!;
        const add = { locations: [] as string[], excluded: [] as string[], languages: [] as string[], audience: undefined as string | undefined };
        const removed: string[] = [];
        const diff = (wanted: string[], current: Existing[], into: string[], label: string) => {
          if (!wanted.length) return;
          for (const value of wanted) if (!current.some((item) => item.key === value)) into.push(value);
          if (replace) {
            for (const item of current) {
              if (!wanted.includes(item.key)) {
                removes.push(item.resourceName);
                removed.push(`${label} ${item.key}`);
              }
            }
          }
        };
        diff(locations, existing.loc, add.locations, "local");
        diff(excluded, existing.neg, add.excluded, "exclusão");
        diff(languages, existing.lang, add.languages, "idioma");
        if (audience?.resourceName) {
          const current = existing.aud;
          if (!current.some((item) => item.key === audience.resourceName)) {
            if (current.length && !replace) {
              conflicts.push(`grupo ${id} já tem o público ${current.map((item) => item.key).join(", ")} — use replace=true (com confirm=true) para trocar.`);
            } else {
              for (const item of current) {
                removes.push(item.resourceName);
                removed.push(`público ${item.key}`);
              }
              add.audience = audience.resourceName;
            }
          }
        }
        creates.push(...geoLanguageCriteria(resource, add));
        plan.push({
          grupo: `${id} (${String(adGroup.name)})`,
          adicionar: [
            ...add.locations.map((value) => `local ${value} ${constants.names.get(`geo:${value}`) ?? ""}`.trim()),
            ...add.excluded.map((value) => `exclusão ${value} ${constants.names.get(`geo:${value}`) ?? ""}`.trim()),
            ...add.languages.map((value) => `idioma ${value} ${constants.names.get(`lang:${value}`) ?? ""}`.trim()),
            ...(add.audience ? [`público ${add.audience}`] : []),
          ],
          remover: removed,
        });
      }
      if (conflicts.length) return fail(`Nada foi alterado:\n${bullets(conflicts)}`);
      if (!removes.length && !creates.length) {
        return done(`Nada a mudar: os grupos já têm exatamente essa segmentação. Nenhuma escrita foi enviada.\n\n${formatJson(plan)}`);
      }
      if (removes.length && confirm !== true) {
        return fail(
          `Prévia — nada foi alterado. replace=true removeria ${removes.length} critério(s). ` +
            `Repita com confirm=true para aplicar.\n\n${formatJson(plan)}`
        );
      }
      const operations = [...removes.map((remove) => ({ remove })), ...creates.map((create) => ({ create }))];
      let result: Row;
      try {
        // Uma requisição sem partialFailure: remoções e criações são aplicadas juntas ou nenhuma.
        result = await client.mutate(customerId, "adGroupCriteria", operations);
      } catch (err) {
        return fail(`Nada foi alterado (remoções e criações vão numa única operação atômica).\nErro: ${explainApiError(errorText(err))}`);
      }
      const dryRun = client.isDryRun;
      return done(
        (dryRun ? DRY_RUN_NOTE : `Segmentação aplicada: ${creates.length} critério(s) criado(s), ${removes.length} removido(s).`) +
          `\n\n${formatJson({ plano: plan, resultado: result })}`
      );
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // create_demand_gen_ad
  // ════════════════════════════════════════════════════════════════════
  const carouselCardSchema = z.object({
    headline: z.string().describe("Título do card (obrigatório)."),
    marketingImage: z.string().optional().describe("Imagem 1.91:1 (ID ou resource name). Esta e/ou squareMarketingImage."),
    squareMarketingImage: z.string().optional().describe("Imagem 1:1 (ID ou resource name)."),
    portraitMarketingImage: z.string().optional().describe("Imagem 4:5 (ID ou resource name), opcional."),
    callToActionText: z.string().optional().describe("Texto do botão do card, opcional."),
    finalUrl: z.string().optional().describe("URL do card. Padrão: a finalUrl do anúncio."),
  });

  mcp.registerTool(
    "create_demand_gen_ad",
    {
      description: [
        "Cria um anúncio Demand Gen num grupo de campanha DEMAND_GEN.",
        "WRITE OPERATION — nasce PAUSED por padrão.",
        "",
        "adType:",
        "- MULTI_ASSET: imagens 1.91:1 / 1:1 / 4:5 / 9:16 (até 20 no total; 1.91:1 ou 1:1 obrigatória), 1–5 logos 1:1,",
        "  1–5 títulos (até 40 caracteres, ao menos um com até 30), 1–5 descrições (até 90), businessName (até 25).",
        "- CAROUSEL: 2–10 cards (título + imagem 1.91:1 e/ou 1:1), 1 logo, 1 título, 1 descrição, businessName.",
        "- VIDEO_RESPONSIVE: vídeos do YouTube (IDs ou URLs), logo(s), businessName; títulos, títulos longos, descrições, CTA.",
        "- PRODUCT: exige campanha com Merchant Center; 1 título, 1 descrição, 1 logo, businessName, CTA opcional.",
        "",
        "Imagens: ID ou resource name de assets IMAGE da conta (upload_image_asset / get_image_assets); proporção e",
        "tamanho mínimo são conferidos antes. Vídeos e cards do carrossel são criados com IDs temporários na mesma",
        "requisição atômica do anúncio (googleAds:mutate) — nada fica órfão. assetAutomation liga/desliga as",
        "automações do Google por anúncio (ex.: GENERATE_DESIGN_VERSIONS_FOR_IMAGES, GENERATE_VERTICAL_YOUTUBE_VIDEOS).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID numérico do grupo Demand Gen."),
        adType: z.enum(AD_TYPES).describe("MULTI_ASSET, CAROUSEL, VIDEO_RESPONSIVE ou PRODUCT."),
        finalUrl: z.string().describe("URL final (https://...)."),
        businessName: z.string().describe("Nome da empresa/marca (até 25 caracteres)."),
        logoImages: flexArray(z.string()).describe("Logo(s) 1:1 (ID ou resource name)."),
        headlines: flexArray(z.string()).optional().describe("Títulos (CAROUSEL/PRODUCT: exatamente 1)."),
        longHeadlines: flexArray(z.string()).optional().describe("Títulos longos, até 90 caracteres (só VIDEO_RESPONSIVE)."),
        descriptions: flexArray(z.string()).optional().describe("Descrições, até 90 caracteres (CAROUSEL/PRODUCT: exatamente 1)."),
        marketingImages: flexArray(z.string()).optional().describe("MULTI_ASSET: imagens 1.91:1."),
        squareMarketingImages: flexArray(z.string()).optional().describe("MULTI_ASSET: imagens 1:1."),
        portraitMarketingImages: flexArray(z.string()).optional().describe("MULTI_ASSET: imagens 4:5."),
        tallPortraitMarketingImages: flexArray(z.string()).optional().describe("MULTI_ASSET: imagens 9:16."),
        youtubeVideoIds: flexArray(z.string()).optional().describe("VIDEO_RESPONSIVE: IDs ou URLs de vídeos do YouTube."),
        companionBannerImage: z.string().optional().describe("VIDEO_RESPONSIVE: banner complementar (asset IMAGE), opcional."),
        carouselCards: flexArray(carouselCardSchema).optional().describe("CAROUSEL: 2 a 10 cards."),
        callToActionText: z.string().optional().describe("MULTI_ASSET/CAROUSEL: texto do botão (opcional)."),
        callToAction: z.enum(CALL_TO_ACTIONS).optional().describe("VIDEO_RESPONSIVE/PRODUCT: botão (asset CALL_TO_ACTION, reaproveitado se já existir)."),
        breadcrumb1: z.string().optional().describe("VIDEO_RESPONSIVE/PRODUCT: 1ª parte do caminho exibido na URL."),
        breadcrumb2: z.string().optional().describe("VIDEO_RESPONSIVE/PRODUCT: 2ª parte do caminho exibido na URL."),
        assetAutomation: flexArray(z.object({
          type: z.enum(ALL_AD_AUTOMATION_TYPES).describe("Tipo de automação do anúncio."),
          status: z.enum(["OPTED_IN", "OPTED_OUT"]).describe("OPTED_IN liga, OPTED_OUT desliga."),
        })).optional().describe("Automações por anúncio. MULTI_ASSET: GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS, GENERATE_DESIGN_VERSIONS_FOR_IMAGES, GENERATE_VIDEOS_FROM_OTHER_ASSETS. VIDEO_RESPONSIVE: GENERATE_LANDING_PAGE_PREVIEW, GENERATE_LANDING_PAGE_TEXT, GENERATE_SHORTER_YOUTUBE_VIDEOS, GENERATE_VERTICAL_YOUTUBE_VIDEOS."),
        name: z.string().optional().describe("Nome interno do anúncio (padrão: tipo + primeiro título)."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Padrão: PAUSED."),
        confirm: z.boolean().optional().describe("Obrigatório ao ligar GENERATE_LANDING_PAGE_PREVIEW (declara direito de uso das imagens da página)."),
      },
    },
    async (args) => {
      const { customerId, adGroupId, adType, finalUrl, businessName } = args;
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);
      const type = adType as AdType;

      // ── Validação local, por tipo
      const problems: string[] = [];
      if (!NUMERIC.test(adGroupId ?? "")) problems.push("adGroupId deve ser o ID numérico do grupo.");
      if (!AD_TYPES.includes(type)) problems.push(`adType inválido: ${String(adType)}.`);
      if (!isHttpUrl(finalUrl ?? "")) problems.push(`finalUrl inválida: "${String(finalUrl)}" (use https://...).`);
      const brand = String(businessName ?? "").trim();
      if (!brand) problems.push("businessName é obrigatório.");
      else if (brand.length > 25) problems.push(`businessName "${brand}" tem ${brand.length} caracteres (máximo 25).`);
      const headlines = strings(args.headlines);
      const longHeadlines = strings(args.longHeadlines);
      const descriptions = strings(args.descriptions);
      const logos = strings(args.logoImages);
      const images = {
        marketing: strings(args.marketingImages),
        square: strings(args.squareMarketingImages),
        portrait: strings(args.portraitMarketingImages),
        tall: strings(args.tallPortraitMarketingImages),
      };
      const videoInputs = strings(args.youtubeVideoIds);
      const cards = ensureArray<unknown>(args.carouselCards).map(obj);
      const automation = ensureArray<unknown>(args.assetAutomation).map(obj);

      // Campos que não pertencem ao tipo são recusados — nunca ignorados em silêncio.
      const allowed: Record<AdType, string[]> = {
        MULTI_ASSET: ["marketingImages", "squareMarketingImages", "portraitMarketingImages", "tallPortraitMarketingImages", "callToActionText", "assetAutomation"],
        CAROUSEL: ["carouselCards", "callToActionText"],
        VIDEO_RESPONSIVE: ["longHeadlines", "youtubeVideoIds", "companionBannerImage", "callToAction", "breadcrumb1", "breadcrumb2", "assetAutomation"],
        PRODUCT: ["callToAction", "breadcrumb1", "breadcrumb2"],
      };
      const optionalFields = ["longHeadlines", "marketingImages", "squareMarketingImages", "portraitMarketingImages", "tallPortraitMarketingImages", "youtubeVideoIds", "companionBannerImage", "carouselCards", "callToActionText", "callToAction", "breadcrumb1", "breadcrumb2", "assetAutomation"];
      const raw = args as Row;
      if (AD_TYPES.includes(type)) {
        const misplaced = optionalFields.filter((field) => {
          const value = raw[field];
          const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "";
          return present && !allowed[type].includes(field);
        });
        if (misplaced.length) problems.push(`${misplaced.join(", ")} não se aplica(m) a ${type}.`);
      }
      // O CTA entra na GAQL de reaproveitamento: só valores do enum CallToActionType passam.
      if (args.callToAction !== undefined && !CALL_TO_ACTIONS.includes(args.callToAction)) {
        problems.push(`callToAction inválido: "${String(args.callToAction)}". Válidos: ${CALL_TO_ACTIONS.join(", ")}.`);
      }

      const imageUses: ImageUse[] = [];
      const addImage = (role: ImageRole, field: string, ref: string) => {
        const parsed = parseImageAssetRef(ref, cid);
        if ("error" in parsed) problems.push(`${field}: ${parsed.error}`);
        else imageUses.push({ role, field, ref, assetId: parsed.assetId, resourceName: parsed.resourceName });
      };
      logos.forEach((ref) => addImage("logo", "logoImages", ref));

      const videos: string[] = [];
      if (type === "MULTI_ASSET") {
        problems.push(...textLimits("headlines", headlines, { min: 1, max: 5, chars: 40 }));
        if (headlines.length && !headlines.some((headline) => headline.length <= 30)) problems.push("headlines: ao menos um título precisa ter até 30 caracteres.");
        problems.push(...textLimits("descriptions", descriptions, { min: 1, max: 5, chars: 90 }));
        if (logos.length < 1 || logos.length > 5) problems.push(`logoImages: de 1 a 5 (recebido ${logos.length}).`);
        if (!images.marketing.length && !images.square.length) problems.push("MULTI_ASSET exige ao menos uma imagem 1.91:1 (marketingImages) ou 1:1 (squareMarketingImages).");
        const total = images.marketing.length + images.square.length + images.portrait.length + images.tall.length;
        if (total > 20) problems.push(`no máximo 20 imagens somando os quatro formatos (recebido ${total}).`);
        images.marketing.forEach((ref) => addImage("marketing", "marketingImages", ref));
        images.square.forEach((ref) => addImage("square", "squareMarketingImages", ref));
        images.portrait.forEach((ref) => addImage("portrait", "portraitMarketingImages", ref));
        images.tall.forEach((ref) => addImage("tall", "tallPortraitMarketingImages", ref));
      } else if (type === "CAROUSEL") {
        problems.push(...textLimits("headlines", headlines, { min: 1, max: 1, chars: 40 }));
        problems.push(...textLimits("descriptions", descriptions, { min: 1, max: 1, chars: 90 }));
        if (logos.length !== 1) problems.push(`logoImages: exatamente 1 no carrossel (recebido ${logos.length}).`);
        if (cards.length < 2 || cards.length > 10) problems.push(`carouselCards: de 2 a 10 cards (recebido ${cards.length}).`);
        cards.forEach((card, index) => {
          const label = `carouselCards[${index}]`;
          if (typeof card.headline !== "string" || !card.headline.trim()) problems.push(`${label}: headline obrigatório.`);
          if (!card.marketingImage && !card.squareMarketingImage) problems.push(`${label}: informe marketingImage (1.91:1) e/ou squareMarketingImage (1:1).`);
          if (card.marketingImage) addImage("marketing", `${label}.marketingImage`, String(card.marketingImage));
          if (card.squareMarketingImage) addImage("square", `${label}.squareMarketingImage`, String(card.squareMarketingImage));
          if (card.portraitMarketingImage) addImage("portrait", `${label}.portraitMarketingImage`, String(card.portraitMarketingImage));
          if (card.finalUrl !== undefined && !isHttpUrl(String(card.finalUrl))) problems.push(`${label}: finalUrl inválida.`);
        });
      } else if (type === "VIDEO_RESPONSIVE") {
        if (!videoInputs.length) problems.push("VIDEO_RESPONSIVE exige ao menos um vídeo (youtubeVideoIds).");
        for (const input of videoInputs) {
          const id = youtubeId(input);
          if (id) videos.push(id);
          else problems.push(`youtubeVideoIds: "${input}" não é um ID (11 caracteres) nem URL do YouTube.`);
        }
        if (!logos.length) problems.push("VIDEO_RESPONSIVE exige ao menos um logo (logoImages).");
        problems.push(...textLimits("headlines", headlines, { min: 0, max: 5, chars: 40 }));
        problems.push(...textLimits("longHeadlines", longHeadlines, { min: 0, max: 5, chars: 90 }));
        problems.push(...textLimits("descriptions", descriptions, { min: 0, max: 5, chars: 90 }));
        if (args.companionBannerImage) addImage("any", "companionBannerImage", args.companionBannerImage);
      } else if (type === "PRODUCT") {
        problems.push(...textLimits("headlines", headlines, { min: 1, max: 1, chars: 40 }));
        problems.push(...textLimits("descriptions", descriptions, { min: 1, max: 1, chars: 90 }));
        if (logos.length !== 1) problems.push(`logoImages: exatamente 1 no anúncio de produto (recebido ${logos.length}).`);
      }

      const automationSettings: Row[] = [];
      if (AD_TYPES.includes(type)) {
        const seen = new Set<string>();
        for (const item of automation) {
          const automationType = String(item.type ?? "");
          const automationStatus = String(item.status ?? "");
          if (!AD_AUTOMATION_TYPES[type].includes(automationType)) {
            problems.push(`assetAutomation: ${automationType || "(vazio)"} não vale para ${type}` +
              (AD_AUTOMATION_TYPES[type].length ? ` (válidos: ${AD_AUTOMATION_TYPES[type].join(", ")}).` : " (este tipo não tem automação por anúncio)."));
            continue;
          }
          if (automationStatus !== "OPTED_IN" && automationStatus !== "OPTED_OUT") {
            problems.push(`assetAutomation ${automationType}: status deve ser OPTED_IN ou OPTED_OUT.`);
            continue;
          }
          if (seen.has(automationType)) {
            problems.push(`assetAutomation: ${automationType} repetido.`);
            continue;
          }
          seen.add(automationType);
          automationSettings.push({ assetAutomationType: automationType, assetAutomationStatus: automationStatus });
        }
        const preview = automationSettings.find((setting) => setting.assetAutomationType === "GENERATE_LANDING_PAGE_PREVIEW" && setting.assetAutomationStatus === "OPTED_IN");
        if (preview && args.confirm !== true) {
          problems.push(
            "GENERATE_LANDING_PAGE_PREVIEW publica imagens da landing page: ao ligar, o anunciante declara ter os direitos sobre elas " +
              "(proto AssetAutomationType, v25). Repita com confirm=true se o cliente autorizou."
          );
        }
      }
      if (problems.length) return fail(`Nada foi criado:\n${bullets(uniq(problems))}`);

      // ── Leituras: grupo/campanha, imagens, vídeos e CTA existentes
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name,
                campaign.advertising_channel_type, campaign.shopping_setting.merchant_id
         FROM ad_group
         WHERE ad_group.id = ${adGroupId} AND ad_group.status != 'REMOVED'`);
      const adGroup = rows[0] ? obj(rows[0].adGroup) : undefined;
      const campaign = obj(rows[0]?.campaign);
      if (!adGroup) return fail(`Grupo ${adGroupId} não encontrado na conta ${cid}. Nada foi criado.`);
      if (campaign.advertisingChannelType !== "DEMAND_GEN") {
        const hint: Record<string, string> = {
          SEARCH: "create_ad (RSA)",
          DISPLAY: "create_responsive_display_ad",
          VIDEO: "create_video_ad",
          PERFORMANCE_MAX: "create_asset_group",
        };
        return fail(`O grupo ${adGroupId} é de campanha ${String(campaign.advertisingChannelType)}, não DEMAND_GEN` +
          `${hint[String(campaign.advertisingChannelType)] ? ` — use ${hint[String(campaign.advertisingChannelType)]}` : ""}. Nada foi criado.`);
      }
      if (type === "PRODUCT" && !Number(obj(campaign.shoppingSetting).merchantId ?? 0)) {
        return fail(`Anúncio de produto exige campanha com Merchant Center (shopping_setting.merchant_id), e a campanha ${String(campaign.id)} não tem. Crie a campanha com merchantId em create_demand_gen_campaign. Nada foi criado.`);
      }
      const imageProblems = await checkImages(client, customerId, imageUses);
      if (imageProblems.length) return fail(`Nada foi criado:\n${bullets(imageProblems)}`);

      const temp = tempIds(cid);
      const assetOperations: Row[] = [];
      const createdAssets: string[] = [];
      const videoAssets: string[] = [];
      if (videos.length) {
        const unique = uniq(videos);
        const found = await client.searchStream(customerId,
          `SELECT asset.resource_name, asset.youtube_video_asset.youtube_video_id
           FROM asset
           WHERE asset.type = 'YOUTUBE_VIDEO'
             AND asset.youtube_video_asset.youtube_video_id IN (${unique.map((id) => `'${gaqlLiteral(id)}'`).join(", ")})`);
        const byVideo = new Map<string, string>();
        for (const row of found) {
          const asset = obj(row.asset);
          const videoId = String(obj(asset.youtubeVideoAsset).youtubeVideoId ?? "");
          if (videoId && !byVideo.has(videoId)) byVideo.set(videoId, String(asset.resourceName));
        }
        for (const id of unique) {
          let resource = byVideo.get(id);
          if (!resource) {
            // Asset novo com ID temporário, referenciado pelo anúncio na mesma requisição (exemplo oficial add_demand_gen_campaign)
            resource = temp("assets");
            assetOperations.push({ assetOperation: { create: { resourceName: resource, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: id } } } });
            createdAssets.push(`vídeo ${id}`);
          }
          videoAssets.push(resource);
        }
      }
      let callToActionAsset: string | undefined;
      if (args.callToAction) {
        const found = await client.searchStream(customerId,
          `SELECT asset.resource_name, asset.call_to_action_asset.call_to_action
           FROM asset
           WHERE asset.type = 'CALL_TO_ACTION' AND asset.call_to_action_asset.call_to_action = '${args.callToAction}'
           LIMIT 1`);
        callToActionAsset = obj(found[0]?.asset).resourceName as string | undefined;
        if (!callToActionAsset) {
          callToActionAsset = temp("assets");
          assetOperations.push({ assetOperation: { create: { resourceName: callToActionAsset, type: "CALL_TO_ACTION", callToActionAsset: { callToAction: args.callToAction } } } });
          createdAssets.push(`CTA ${args.callToAction}`);
        }
      }
      const imageOf = (field: string, ref: unknown) => imageUses.find((use) => use.field === field && use.ref === String(ref))?.resourceName;
      const cardAssets: string[] = [];
      if (type === "CAROUSEL") {
        cards.forEach((card, index) => {
          const label = `carouselCards[${index}]`;
          const resource = temp("assets");
          cardAssets.push(resource);
          assetOperations.push({
            assetOperation: {
              create: {
                resourceName: resource,
                type: "DEMAND_GEN_CAROUSEL_CARD",
                finalUrls: [String(card.finalUrl ?? finalUrl)],
                demandGenCarouselCardAsset: {
                  headline: String(card.headline).trim(),
                  ...(card.marketingImage ? { marketingImageAsset: imageOf(`${label}.marketingImage`, card.marketingImage) } : {}),
                  ...(card.squareMarketingImage ? { squareMarketingImageAsset: imageOf(`${label}.squareMarketingImage`, card.squareMarketingImage) } : {}),
                  ...(card.portraitMarketingImage ? { portraitMarketingImageAsset: imageOf(`${label}.portraitMarketingImage`, card.portraitMarketingImage) } : {}),
                  ...(card.callToActionText ? { callToActionText: String(card.callToActionText) } : {}),
                },
              },
            },
          });
          createdAssets.push(`card ${index + 1} "${String(card.headline).trim()}"`);
        });
      }

      const links = (field: string) => imageUses.filter((use) => use.field === field).map((use) => ({ asset: use.resourceName }));
      const texts = (items: string[]) => items.map((item) => ({ text: item }));
      let info: Row;
      let infoKey: string;
      switch (type) {
        case "MULTI_ASSET":
          infoKey = "demandGenMultiAssetAd";
          info = {
            ...(images.marketing.length ? { marketingImages: links("marketingImages") } : {}),
            ...(images.square.length ? { squareMarketingImages: links("squareMarketingImages") } : {}),
            ...(images.portrait.length ? { portraitMarketingImages: links("portraitMarketingImages") } : {}),
            ...(images.tall.length ? { tallPortraitMarketingImages: links("tallPortraitMarketingImages") } : {}),
            logoImages: links("logoImages"),
            headlines: texts(headlines),
            descriptions: texts(descriptions),
            businessName: brand,
            ...(args.callToActionText ? { callToActionText: args.callToActionText } : {}),
          };
          break;
        case "CAROUSEL":
          infoKey = "demandGenCarouselAd";
          info = {
            businessName: brand,
            logoImage: links("logoImages")[0],
            headline: { text: headlines[0] },
            description: { text: descriptions[0] },
            ...(args.callToActionText ? { callToActionText: args.callToActionText } : {}),
            carouselCards: cardAssets.map((asset) => ({ asset })),
          };
          break;
        case "VIDEO_RESPONSIVE":
          infoKey = "demandGenVideoResponsiveAd";
          info = {
            ...(headlines.length ? { headlines: texts(headlines) } : {}),
            ...(longHeadlines.length ? { longHeadlines: texts(longHeadlines) } : {}),
            ...(descriptions.length ? { descriptions: texts(descriptions) } : {}),
            videos: videoAssets.map((asset) => ({ asset })),
            logoImages: links("logoImages"),
            ...(args.companionBannerImage ? { companionBanners: links("companionBannerImage") } : {}),
            ...(args.breadcrumb1 ? { breadcrumb1: args.breadcrumb1 } : {}),
            ...(args.breadcrumb2 ? { breadcrumb2: args.breadcrumb2 } : {}),
            businessName: { text: brand },
            ...(callToActionAsset ? { callToActions: [{ asset: callToActionAsset }] } : {}),
          };
          break;
        default:
          infoKey = "demandGenProductAd";
          info = {
            headline: { text: headlines[0] },
            description: { text: descriptions[0] },
            logoImage: links("logoImages")[0],
            ...(args.breadcrumb1 ? { breadcrumb1: args.breadcrumb1 } : {}),
            ...(args.breadcrumb2 ? { breadcrumb2: args.breadcrumb2 } : {}),
            businessName: { text: brand },
            ...(callToActionAsset ? { callToAction: { asset: callToActionAsset } } : {}),
          };
      }
      const status = args.status ?? "PAUSED";
      const adName = (args.name?.trim() || `Demand Gen ${type} — ${headlines[0] ?? brand}`).slice(0, 255);
      const operations: Row[] = [
        ...assetOperations,
        {
          adGroupAdOperation: {
            create: {
              adGroup: `customers/${cid}/adGroups/${adGroupId}`,
              status,
              ad: { name: adName, finalUrls: [finalUrl], [infoKey]: info },
              ...(automationSettings.length ? { adGroupAdAssetAutomationSettings: automationSettings } : {}),
            },
          },
        },
      ];

      let result: Row;
      try {
        result = await client.batchMutate(customerId, operations);
      } catch (err) {
        return fail(`Nada foi criado (assets novos e anúncio vão numa única operação atômica).\nErro: ${explainApiError(errorText(err))}`);
      }
      const dryRun = client.isDryRun;
      const responses = responsesOf(result);
      const adResource = resultNames(responses, "adGroupAdResult")[0];
      if (!dryRun && !adResource) return fail(`A API não confirmou a criação do anúncio — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      const warnings: string[] = [];
      if (type === "VIDEO_RESPONSIVE" && (!headlines.length || !descriptions.length)) {
        warnings.push("Anúncio de vídeo sem título ou descrição: o Google exibe menos formatos. Recomenda-se ao menos 1 de cada.");
      }
      if (type === "MULTI_ASSET" && !images.portrait.length && !images.tall.length) {
        warnings.push("Sem imagens 4:5 ou 9:16: o anúncio perde espaço em Shorts e Discover (formatos verticais).");
      }
      const lines = [
        dryRun ? DRY_RUN_NOTE : `Anúncio Demand Gen ${type} criado (${status}).`,
        `- Grupo: ${String(adGroup.name)} (${adGroupId}) · campanha ${String(campaign.name)}`,
        `- Nome: ${adName}`,
        ...(adResource ? [`- Anúncio: ${adResource}`] : []),
        // Em dry-run/validateOnly nada foi gravado: os assets novos são só plano (IDs temporários não existem na conta).
        ...(createdAssets.length
          ? [dryRun
              ? `- Assets que seriam criados na mesma operação (nada foi gravado): ${createdAssets.join("; ")}`
              : `- Assets criados na mesma operação: ${createdAssets.join("; ")}`]
          : []),
        ...(automationSettings.length ? [`- Automação: ${automationSettings.map((s) => `${String(s.assetAutomationType)}=${String(s.assetAutomationStatus)}`).join(", ")}`] : []),
        ...(warnings.length ? ["", "Avisos:", bullets(warnings)] : []),
        ...(!dryRun && status === "PAUSED" ? ["", "Para veicular: update_ad_status (ENABLED) e ative grupo e campanha."] : []),
      ];
      return done(lines.join("\n"));
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // create_lookalike_segment
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "create_lookalike_segment",
    {
      description: [
        "Cria um segmento lookalike (semelhante) a partir de listas-semente (compradores, CRM, visitantes).",
        "WRITE OPERATION.",
        "",
        "Só funciona em campanhas Demand Gen (em outros tipos aparece como 'Qualificado - Limitado').",
        "Requisitos: soma das listas-semente com ao menos 100 pessoas ativas; expansionLevel NARROW, BALANCED ou",
        "BROAD; países em ISO-3166 (padrão BR). O segmento é imutável e não pode repetir sementes+nível+países",
        "de outro lookalike (DUPLICATE_LOOKALIKE) — se já existir, a tool devolve o existente sem gravar.",
        "Crie 2–3 dias antes do lançamento. Uso: create_audience_from_lists com o resource devolvido →",
        "set_demand_gen_ad_group_targeting (audienceResourceName).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do segmento (único na conta)."),
        seedUserListIds: flexArray(z.string()).describe("IDs (ou resource names) das listas-semente."),
        expansionLevel: z.enum(["NARROW", "BALANCED", "BROAD"]).describe("NARROW (mais parecido, menor), BALANCED ou BROAD (maior alcance)."),
        countryCodes: flexArray(z.string()).optional().describe("Países ISO-3166 de 2 letras. Padrão: [\"BR\"]."),
        description: z.string().optional().describe("Descrição opcional."),
      },
    },
    async ({ customerId, name, seedUserListIds, expansionLevel, countryCodes, description }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = cidOf(customerId);

      const problems: string[] = [];
      if (!name?.trim()) problems.push("name vazio.");
      const seeds: string[] = [];
      for (const ref of strings(seedUserListIds)) {
        const match = /^customers\/([\d-]+)\/userLists\/(\d+)$/.exec(ref);
        if (NUMERIC.test(ref)) seeds.push(ref);
        else if (match && match[1].replace(/-/g, "") === cid) seeds.push(match[2]);
        else problems.push(`seedUserListIds: "${ref}" não é um ID de lista desta conta.`);
      }
      const seedIds = uniq(seeds);
      if (!seedIds.length && !problems.length) problems.push("informe ao menos uma lista-semente (seedUserListIds).");
      if (!["NARROW", "BALANCED", "BROAD"].includes(String(expansionLevel))) problems.push("expansionLevel deve ser NARROW, BALANCED ou BROAD.");
      const countries = uniq((countryCodes === undefined ? ["BR"] : strings(countryCodes)).map((code) => code.toUpperCase()));
      const badCountries = countries.filter((code) => !/^[A-Z]{2}$/.test(code));
      if (badCountries.length) problems.push(`countryCodes inválidos: ${badCountries.join(", ")} (use ISO-3166 de 2 letras, ex.: BR).`);
      if (!countries.length) problems.push("countryCodes vazio — informe ao menos um país.");
      if (problems.length) return fail(`Nada foi criado:\n${bullets(problems)}`);

      const client = ctx.getClient();
      const seedRows = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status,
                user_list.size_for_display, user_list.size_for_search
         FROM user_list
         WHERE user_list.id IN (${seedIds.join(", ")})`);
      const found = new Map(seedRows.map((row) => [String(obj(row.userList).id), obj(row.userList)] as const));
      const missing = seedIds.filter((id) => !found.has(id));
      if (missing.length) return fail(`Lista(s)-semente não encontrada(s) na conta ${cid}: ${missing.join(", ")} (veja list_remarketing_lists). Nada foi criado.`);
      const sizes = seedIds.map((id) => {
        const list = found.get(id)!;
        const display = list.sizeForDisplay === undefined ? undefined : Number(list.sizeForDisplay);
        const search = list.sizeForSearch === undefined ? undefined : Number(list.sizeForSearch);
        return { id, name: String(list.name ?? id), type: String(list.type ?? ""), size: display === undefined && search === undefined ? undefined : Math.max(display ?? 0, search ?? 0) };
      });
      const warnings: string[] = [];
      const unknown = sizes.filter((seed) => seed.size === undefined);
      const total = sizes.reduce((sum, seed) => sum + (seed.size ?? 0), 0);
      if (!unknown.length && total < 100) {
        return fail(
          `Nada foi criado: as listas-semente somam ~${total} pessoa(s) e o lookalike exige ao menos 100 ativas ` +
            `(${sizes.map((seed) => `${seed.id} "${seed.name}": ${seed.size}`).join("; ")}).`
        );
      }
      if (unknown.length) warnings.push(`Tamanho ainda não calculado pelo Google para: ${unknown.map((seed) => seed.id).join(", ")}. Se a soma ficar abaixo de 100 pessoas, o segmento fica inelegível.`);
      for (const seed of sizes) {
        if (found.get(seed.id)?.membershipStatus === "CLOSED") warnings.push(`lista ${seed.id} ("${seed.name}") está CLOSED — o segmento envelhece sem novos membros.`);
      }

      const lookalikeQuery =
        `SELECT user_list.id, user_list.name, user_list.resource_name, user_list.lookalike_user_list.seed_user_list_ids,
                user_list.lookalike_user_list.expansion_level, user_list.lookalike_user_list.country_codes
         FROM user_list
         WHERE user_list.type = 'LOOKALIKE'`;
      const sameConfig = (list: Row) => {
        const info = obj(list.lookalikeUserList);
        const seedSet = strings(info.seedUserListIds).sort().join();
        const countrySet = strings(info.countryCodes).map((code) => code.toUpperCase()).sort().join();
        return seedSet === [...seedIds].sort().join() && countrySet === [...countries].sort().join() && info.expansionLevel === expansionLevel;
      };
      const existing = (await client.searchStream(customerId, lookalikeQuery)).map((row) => obj(row.userList)).find(sameConfig);
      if (existing) {
        return done(
          `Já existe um lookalike com as mesmas sementes, nível ${expansionLevel} e países ${countries.join(", ")}: ` +
            `"${String(existing.name)}" — ${String(existing.resourceName)}. Nada foi criado (a API recusaria como DUPLICATE_LOOKALIKE).`
        );
      }
      const nameTaken = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name FROM user_list WHERE user_list.name = '${gaqlLiteral(name)}'`);
      if (nameTaken.length) return fail(`Já existe uma lista chamada "${name}" (ID ${String(obj(nameTaken[0].userList).id)}). Escolha outro nome. Nada foi criado.`);

      const create: Row = {
        name,
        ...(description ? { description } : {}),
        lookalikeUserList: { seedUserListIds: seedIds, expansionLevel, countryCodes: countries },
      };
      let result: Row;
      try {
        result = await client.mutate(customerId, "userLists", [{ create }]);
      } catch (err) {
        const message = errorText(err);
        if (/lookalike/i.test(message) && /duplicat/i.test(message)) {
          const twin = (await client.searchStream(customerId, lookalikeQuery)).map((row) => obj(row.userList)).find(sameConfig);
          return fail(`Já existe um lookalike igual (DUPLICATE_LOOKALIKE)${twin ? `: "${String(twin.name)}" — ${String(twin.resourceName)}` : ""}. Nada foi criado.\nErro da API: ${message}`);
        }
        return fail(`Nada foi criado.\nErro: ${explainApiError(message)}`);
      }
      const dryRun = client.isDryRun;
      const resource = ((result.results as Row[] | undefined) ?? [])[0]?.resourceName as string | undefined;
      if (!dryRun && !resource) return fail(`A API não confirmou a criação — confira na conta antes de repetir.\n\n${formatJson(result)}`);
      const lines = [
        dryRun ? DRY_RUN_NOTE : `Segmento lookalike criado: "${name}".`,
        ...(resource ? [`- Resource: ${resource}`] : []),
        `- Sementes: ${sizes.map((seed) => `${seed.id} "${seed.name}"${seed.size !== undefined ? ` (~${seed.size})` : ""}`).join("; ")}`,
        `- Expansão: ${expansionLevel} · países: ${countries.join(", ")}`,
        "- Só entrega em campanhas Demand Gen; o Google atualiza o segmento a cada 1–2 dias — crie 2–3 dias antes do lançamento.",
        ...(warnings.length ? ["", "Avisos:", bullets(warnings)] : []),
        ...(!dryRun && resource
          ? ["", `Próximo passo: create_audience_from_lists com userListResourceNames=["${resource}"] e depois set_demand_gen_ad_group_targeting com o público.`]
          : []),
      ];
      return done(lines.join("\n"));
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // list_demand_gen_ad_groups (leitura)
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "list_demand_gen_ad_groups",
    {
      description: [
        "Lista os grupos Demand Gen com canais (channel controls), segmentação otimizada, lances do grupo e",
        "localização/idioma/público no nível do grupo. READ OPERATION.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra uma campanha Demand Gen."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !NUMERIC.test(campaignId)) return fail("campaignId deve ser numérico.");
      const client = ctx.getClient();
      const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : "";
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type,
                campaign.demand_gen_campaign_settings.upgraded_targeting,
                ad_group.id, ad_group.name, ad_group.status, ad_group.optimized_targeting_enabled,
                ad_group.exclude_demographic_expansion, ad_group.target_cpc_micros, ad_group.target_cpa_micros,
                ad_group.target_roas, ${CHANNEL_FIELDS}
         FROM ad_group
         WHERE campaign.advertising_channel_type = 'DEMAND_GEN' AND ad_group.status != 'REMOVED'${campaignFilter}
         ORDER BY campaign.id, ad_group.id`);
      const criteria = rows.length
        ? await client.searchStream(customerId,
          `SELECT ad_group.id, ad_group_criterion.type, ad_group_criterion.negative,
                  ad_group_criterion.location.geo_target_constant, ad_group_criterion.language.language_constant,
                  ad_group_criterion.audience.audience
           FROM ad_group_criterion
           WHERE campaign.advertising_channel_type = 'DEMAND_GEN'
             AND ad_group_criterion.type IN ('LOCATION', 'LANGUAGE', 'AUDIENCE')
             AND ad_group_criterion.status != 'REMOVED'${campaignFilter}`)
        : [];
      const targeting = new Map<string, { locations: string[]; excluded: string[]; languages: string[]; audiences: string[] }>();
      for (const row of criteria) {
        const id = String(obj(row.adGroup).id);
        const criterion = obj(row.adGroupCriterion);
        const entry = targeting.get(id) ?? { locations: [], excluded: [], languages: [], audiences: [] };
        if (criterion.type === "LOCATION") {
          const geo = String(obj(criterion.location).geoTargetConstant ?? "").split("/").pop() ?? "";
          (criterion.negative === true ? entry.excluded : entry.locations).push(geo);
        } else if (criterion.type === "LANGUAGE") {
          entry.languages.push(String(obj(criterion.language).languageConstant ?? "").split("/").pop() ?? "");
        } else if (criterion.type === "AUDIENCE") {
          entry.audiences.push(String(obj(criterion.audience).audience ?? ""));
        }
        targeting.set(id, entry);
      }
      const result = rows.map((row) => {
        const campaign = obj(row.campaign);
        const adGroup = obj(row.adGroup);
        const entry = targeting.get(String(adGroup.id)) ?? { locations: [], excluded: [], languages: [], audiences: [] };
        return {
          campaign_id: String(campaign.id ?? ""),
          campaign: String(campaign.name ?? ""),
          campaign_status: String(campaign.status ?? ""),
          bidding: String(campaign.biddingStrategyType ?? ""),
          upgraded_targeting: usesUpgradedTargeting(campaign),
          ad_group_id: String(adGroup.id ?? ""),
          ad_group: String(adGroup.name ?? ""),
          status: String(adGroup.status ?? ""),
          channels: currentChannels(adGroup).label,
          optimized_targeting: adGroup.optimizedTargetingEnabled === true,
          exclude_demographic_expansion: adGroup.excludeDemographicExpansion === true,
          target_cpc: adGroup.targetCpcMicros !== undefined ? money(adGroup.targetCpcMicros as string) : "",
          target_cpa: adGroup.targetCpaMicros !== undefined ? money(adGroup.targetCpaMicros as string) : "",
          target_roas: adGroup.targetRoas !== undefined ? Number(adGroup.targetRoas) : "",
          locations: entry.locations.join(" "),
          excluded_locations: entry.excluded.join(" "),
          languages: entry.languages.join(" "),
          audience: entry.audiences.join(" "),
        };
      });
      if (format === "table") return done(formatAsTable(result));
      if (format === "csv") return done(formatAsCsv(result));
      return done(`${result.length} grupo(s) Demand Gen.\n\n${formatJson(result)}`);
    }
  );

  // ════════════════════════════════════════════════════════════════════
  // list_lookalike_segments (leitura)
  // ════════════════════════════════════════════════════════════════════
  mcp.registerTool(
    "list_lookalike_segments",
    {
      description: "Lista os segmentos lookalike da conta (sementes, nível de expansão, países, tamanho estimado). READ OPERATION.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        format: formatSchema,
      },
    },
    async ({ customerId, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = ctx.getClient();
      const rows = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name, user_list.resource_name, user_list.membership_status,
                user_list.size_range_for_display, user_list.eligible_for_display,
                user_list.lookalike_user_list.seed_user_list_ids, user_list.lookalike_user_list.expansion_level,
                user_list.lookalike_user_list.country_codes
         FROM user_list
         WHERE user_list.type = 'LOOKALIKE'
         ORDER BY user_list.name`);
      const result = rows.map((row) => {
        const list = obj(row.userList);
        const info = obj(list.lookalikeUserList);
        return {
          id: String(list.id ?? ""),
          name: String(list.name ?? ""),
          resource_name: String(list.resourceName ?? ""),
          expansion_level: String(info.expansionLevel ?? ""),
          seed_user_list_ids: strings(info.seedUserListIds).join(" "),
          country_codes: strings(info.countryCodes).join(" "),
          size_range: String(list.sizeRangeForDisplay ?? ""),
          eligible_for_display: list.eligibleForDisplay === true,
          membership_status: String(list.membershipStatus ?? ""),
        };
      });
      if (format === "table") return done(formatAsTable(result));
      if (format === "csv") return done(formatAsCsv(result));
      return done(`${result.length} segmento(s) lookalike.${result.length ? "" : " Crie com create_lookalike_segment."}\n\n${formatJson(result)}`);
    }
  );
}
