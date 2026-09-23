/**
 * Lote bidding: simulações de lance, sazonalidade / exclusão de dados, estratégias de
 * portfólio (inclusive de MCC), alvos por grupo, orçamento total e datas de campanha.
 *
 * Todo client falso daqui passa as queries por assertGaqlRules (metadados reais da v25) e
 * registra as escritas. Cada tool tem: payload/query de sucesso, recusa antes de qualquer
 * chamada, no-op, erro da API traduzido, dry-run/validateOnly e os portões de confirm.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { catalog } from "../src/tools/bidding.catalog.js";
import { beforeAccountToday, checkTotalBudgetFlight, clockIn, parseAdsDateTime, scaledMicros } from "../src/tools/bidding.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";
const MCC = "1112223334";
const CAMPAIGN_ID = "24250313718";
const TZ = "America/Sao_Paulo";
const DAY = 86_400_000;

/** Data/hora relativa a hoje no fuso da conta: rel(3) = daqui a 3 dias ao meio-dia. */
function rel(days: number, time = "12:00:00"): string {
  const today = clockIn(TZ).slice(0, 10);
  return `${new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)} ${time}`;
}
const relDay = (days: number) => rel(days).slice(0, 10);

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  rows?: Record<string, Row[]> | ((from: string, query: string) => Row[] | undefined);
  customer?: Row;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
  mutateError?: string;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ method: string; resource?: string; operations: Row[]; options?: Row }>,
    customerReads: 0,
    dryRunClones: 0,
  };
  const rowsFor = (from: string, query: string): Row[] => {
    if (typeof opts.rows === "function") return opts.rows(from, query) ?? [];
    return opts.rows?.[from] ?? [];
  };
  const write = (method: string, operations: Row[], resource?: string, options?: Row) => {
    calls.writes.push({ method, resource, operations, options });
    if (opts.mutateError) throw new Error(`Google Ads API: ${opts.mutateError}`);
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true);
    },
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      return rowsFor(from, query);
    },
    async getCustomer(): Promise<Row> {
      calls.customerReads++;
      return { customer: { id: CID, timeZone: TZ, manager: false, currencyCode: "BRL", ...(opts.customer ?? {}) } };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      write("mutate", operations, resource, options);
      if (opts.mutate) return opts.mutate(resource, operations, options);
      return dryRun ? {} : { results: operations.map((op, i) => ({ resourceName: String(op.remove ?? (op.update as Row)?.resourceName ?? `customers/${CID}/${resource}/${900 + i}`) })) };
    },
    async mutateCampaigns(_customerId: string, operations: Row[]): Promise<Row> {
      write("mutateCampaigns", operations);
      return { results: [{ resourceName: "c" }] };
    },
    async mutateAdGroups(_customerId: string, operations: Row[]): Promise<Row> {
      write("mutateAdGroups", operations);
      return { results: [{ resourceName: "ag" }] };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      write("batchMutate", operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/1` } },
          { campaignResult: { resourceName: `customers/${CID}/campaigns/2` } },
        ],
      };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  registerGoogleAdsTools(
    { registerTool(name: string, config: Row, handler: Handler) { handlers.set(name, handler); configs.set(name, config); } } as never,
    () => client as never,
    [],
    false
  );
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = Math.min(...["{", "["].map((ch) => body.indexOf(ch)).filter((i) => i >= 0));
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as Row;
}
function onlyWrite(calls: ReturnType<typeof fakeClient>["calls"]) {
  assert.equal(calls.writes.length, 1, "exatamente uma escrita");
  return calls.writes[0];
}

// ── Catálogo ──────────────────────────────────────────────────────────

test("catálogo: tools do lote classificadas; nenhuma encadeada; leitura sem validateOnly", () => {
  const { configs } = register(fakeClient().client);
  for (const name of catalog.read) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), name);
    assert.ok(configs.has(name), `${name} registrada`);
    assert.ok(!("validateOnly" in (configs.get(name)!.inputSchema as Row)), `${name} é leitura`);
  }
  for (const name of catalog.write) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), name);
    assert.ok("validateOnly" in (configs.get(name)!.inputSchema as Row), `${name} ganha validateOnly`);
  }
  assert.deepEqual(catalog.chained, []);
});

// ── Datas ─────────────────────────────────────────────────────────────

test("datas: parse no formato da API, data sozinha vira início/fim do dia, datas inválidas recusadas", () => {
  assert.deepEqual(parseAdsDateTime("2026-11-27", "startOfDay"), { value: "2026-11-27 00:00:00", dateOnly: true });
  assert.deepEqual(parseAdsDateTime("2026-11-27", "endOfDay"), { value: "2026-11-27 23:59:59", dateOnly: true });
  assert.deepEqual(parseAdsDateTime("2026-12-31", "nextDayStart"), { value: "2027-01-01 00:00:00", dateOnly: true });
  assert.deepEqual(parseAdsDateTime("2026-11-27T08:30", "startOfDay"), { value: "2026-11-27 08:30:00", dateOnly: false });
  for (const bad of ["2026-02-30", "27/11/2026", "2026-11-27 24:00:00", "2026-11-27' OR '1'='1"]) {
    assert.ok("error" in parseAdsDateTime(bad, "startOfDay"), bad);
  }
});

test("datas: só o dia conta para 'no passado' (hoje 00:00:00 = começa hoje); SCALING arredonda ao centavo", () => {
  const now = "2026-09-23 03:04:32";
  assert.equal(beforeAccountToday("2026-09-23 00:00:00", now), false, "hoje, granularidade diária");
  assert.equal(beforeAccountToday("2026-09-23 23:59:59", now), false);
  assert.equal(beforeAccountToday("2026-09-22 23:59:59", now), true, "ontem");
  assert.equal(beforeAccountToday("2025-12-31 00:00:00", now), true);
  assert.equal(scaledMicros(50_000_000, 0.8), 40_000_000);
  assert.equal(scaledMicros(51_234_567, 0.73), 37_400_000);
});

test("orçamento total: canal, estratégia e duração pelas regras documentadas", () => {
  assert.deepEqual(checkTotalBudgetFlight("SEARCH", "TARGET_CPA", "2026-11-01 00:00:00", "2026-11-30 23:59:59").errors, []);
  assert.match(checkTotalBudgetFlight("DISPLAY", "TARGET_CPA", "2026-11-01 00:00:00", "2026-11-30 23:59:59").errors[0], /não existe para campanhas DISPLAY/);
  assert.match(checkTotalBudgetFlight("PERFORMANCE_MAX", "TARGET_SPEND", "2026-11-01 00:00:00", "2026-11-30 23:59:59").errors[0], /aceitam só/);
  assert.match(checkTotalBudgetFlight("SEARCH", "TARGET_CPA", "2026-11-01 00:00:00", "2027-02-15 23:59:59").errors[0], /DURATION_TOO_LONG/);
  assert.deepEqual(checkTotalBudgetFlight("DEMAND_GEN", "TARGET_CPA", "2026-11-01 00:00:00", "2027-02-15 23:59:59").errors, []);
  assert.match(checkTotalBudgetFlight("SEARCH", "TARGET_CPA", "2026-11-01 00:00:00", undefined).errors[0], /END_DATE_TIME_REQUIRED/);
  assert.match(checkTotalBudgetFlight("SEARCH", "TARGET_CPA", "2026-11-01 00:00:00", "2026-11-01 23:59:59").warnings[0], /mínimo documentado de 3 dias/);
});

// ── get_bid_simulations ───────────────────────────────────────────────

const cpaSimulation = (overrides: Row = {}): Row => ({
  campaignSimulation: {
    campaignId: CAMPAIGN_ID, type: "TARGET_CPA", modificationMethod: "UNIFORM", startDate: "2026-09-10", endDate: "2026-09-16",
    targetCpaPointList: {
      points: [
        { targetCpaMicros: "60000000", costMicros: "900000000", clicks: "300", impressions: "5000", biddableConversions: 15, biddableConversionsValue: 3000, requiredBudgetAmountMicros: "130000000" },
        { targetCpaMicros: "40000000", costMicros: "500000000", clicks: "200", impressions: "4000", biddableConversions: 12, biddableConversionsValue: 2400 },
        { targetCpaMicros: "50000000", costMicros: "700000000", clicks: "250", impressions: "4500", biddableConversions: 14, biddableConversionsValue: 2800 },
      ],
    },
    ...overrides,
  },
});
const searchCampaign = (overrides: Row = {}): Row => ({
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa Genérica", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "TARGET_CPA", targetCpa: { targetCpaMicros: "50000000" }, ...overrides },
  campaignBudget: { resourceName: `customers/${CID}/campaignBudgets/77`, amountMicros: "100000000", period: "DAILY" },
});

test("get_bid_simulations: campanha TARGET_CPA — pontos ordenados, atual marcado, deltas e como aplicar", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [searchCampaign()], campaign_simulation: [cpaSimulation()] } });
  const result = await call(client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID, type: "TARGET_CPA" });
  assert.equal(result.isError, undefined);
  const simQuery = calls.queries.find((q) => /FROM campaign_simulation/.test(q))!;
  assert.match(simQuery, new RegExp(`campaign_simulation\\.campaign_id = ${CAMPAIGN_ID}`));
  assert.match(simQuery, /campaign_simulation\.type = 'TARGET_CPA'/);
  assert.match(simQuery, /campaign_simulation\.budget_point_list\.points/);
  const payload = jsonOf(result);
  const [sim] = payload.simulations as Row[];
  assert.deepEqual(sim.date_range, { start: "2026-09-10", end: "2026-09-16" });
  assert.equal(sim.current_value, "R$ 50.00");
  assert.equal(sim.reference_point, "atual");
  assert.match(String(sim.how_to_apply), /update_campaign \{ campaignId: "24250313718", targetCpaMicros/);
  const points = sim.points as Row[];
  assert.deepEqual(points.map((p) => p.targetCpaMicros), [40_000_000, 50_000_000, 60_000_000]);
  assert.deepEqual(points.map((p) => p.current), ["", "atual", ""]);
  assert.equal(points[2].cost, 900);
  assert.equal(points[2].cpa, 60);
  assert.equal(points[2].roas, 3.33);
  assert.equal(points[2].required_budget, 130);
  assert.equal(points[2].delta_cost, 200);
  assert.equal(points[2].delta_conversions, 1);
  assert.equal(points[0].delta_clicks, -50);
});

test("get_bid_simulations: orçamento com ponto mais próximo, escala em SCALING, formato tabela", async () => {
  const budgetSim: Row = {
    campaignSimulation: {
      campaignId: CAMPAIGN_ID, type: "BUDGET", modificationMethod: "UNIFORM", startDate: "2026-09-10", endDate: "2026-09-16",
      budgetPointList: { points: [
        { budgetAmountMicros: "80000000", costMicros: "400000000", clicks: "100", biddableConversions: 5, biddableConversionsValue: 900 },
        { budgetAmountMicros: "150000000", costMicros: "700000000", clicks: "180", biddableConversions: 8, biddableConversionsValue: 1500 },
      ] },
    },
  };
  const scalingSim: Row = {
    campaignSimulation: {
      campaignId: CAMPAIGN_ID, type: "CPC_BID", modificationMethod: "SCALING", startDate: "2026-09-10", endDate: "2026-09-16",
      cpcBidPointList: { points: [{ cpcBidScalingModifier: 0.5, costMicros: "1" }, { cpcBidScalingModifier: 1, costMicros: "2" }, { cpcBidScalingModifier: 1.5, costMicros: "3" }] },
    },
  };
  const { client } = fakeClient({ rows: { campaign: [searchCampaign()], campaign_simulation: [budgetSim, scalingSim] } });
  const payload = jsonOf(await call(client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID }));
  const [budget, scaling] = payload.simulations as Row[];
  assert.equal(budget.reference_point, "mais próximo do atual");
  assert.deepEqual((budget.points as Row[]).map((p) => p.current), ["mais próximo do atual", ""]);
  assert.match(String(budget.how_to_apply), /update_budget \{ budgetResourceName: "customers\/5820067509\/campaignBudgets\/77"/);
  assert.equal((scaling.points as Row[])[1].current, "atual");
  assert.equal((scaling.points as Row[])[1].scaling_modifier, 1);
  assert.equal(scaling.current_value, "1x (lances atuais)");

  const table = textOf(await call(client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID, format: "table" }));
  assert.match(table, /amountMicros/);
  assert.match(table, /scaling_modifier/);
});

test("get_bid_simulations: palavra-chave (grupo inteiro), portfólio e a query certa por nível", async () => {
  const keywordRows = [
    { adGroup: { id: "777", name: "Tênis" }, adGroupCriterion: { criterionId: "11", keyword: { text: "tenis corrida" }, effectiveCpcBidMicros: "2000000" } },
    { adGroup: { id: "777", name: "Tênis" }, adGroupCriterion: { criterionId: "12", keyword: { text: "tenis barato" }, effectiveCpcBidMicros: "1000000" } },
  ];
  const kwSim = (criterionId: string): Row => ({
    adGroupCriterionSimulation: {
      adGroupId: "777", criterionId, type: "CPC_BID", modificationMethod: "UNIFORM", startDate: "2026-09-10", endDate: "2026-09-16",
      cpcBidPointList: { points: [{ cpcBidMicros: "1000000", costMicros: "10000000" }, { cpcBidMicros: "2000000", costMicros: "30000000" }] },
    },
  });
  const kw = fakeClient({ rows: { ad_group_criterion: keywordRows, ad_group_criterion_simulation: [kwSim("11"), kwSim("12")] } });
  const payload = jsonOf(await call(kw.client, "get_bid_simulations", { level: "KEYWORD", adGroupId: "777" }));
  const sims = payload.simulations as Row[];
  assert.deepEqual(sims.map((s) => [s.criterion_id, s.keyword, s.current_value]), [["11", "tenis corrida", "R$ 2.00"], ["12", "tenis barato", "R$ 1.00"]]);
  assert.match(String(sims[0].how_to_apply), /update_keyword/);
  const kwQuery = kw.calls.queries.find((q) => /FROM ad_group_criterion_simulation/.test(q))!;
  assert.match(kwQuery, /ad_group_criterion_simulation\.ad_group_id = 777/);
  assert.doesNotMatch(kwQuery, /criterion_id =/);

  const portfolio = fakeClient({
    rows: {
      bidding_strategy: [{ biddingStrategy: { id: "55", name: "tROAS Moda", type: "TARGET_ROAS", targetRoas: { targetRoas: 4 } } }],
      bidding_strategy_simulation: [{ biddingStrategySimulation: { biddingStrategyId: "55", type: "TARGET_ROAS", modificationMethod: "UNIFORM", startDate: "2026-09-10", endDate: "2026-09-16", targetRoasPointList: { points: [{ targetRoas: 4, costMicros: "1000000" }] } } }],
    },
  });
  const pPayload = jsonOf(await call(portfolio.client, "get_bid_simulations", { level: "PORTFOLIO", biddingStrategyId: "55", type: "TARGET_ROAS" }));
  const [pSim] = pPayload.simulations as Row[];
  assert.equal(pSim.reference_point, "atual");
  assert.match(String(pSim.how_to_apply), /update_bidding_strategy \{ biddingStrategyId: "55", targetRoas/);
});

test("get_bid_simulations: entrada inválida não consulta nada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ level: "AD_GROUP" }, /exige adGroupId/],
    [{ level: "CAMPAIGN", campaignId: "1 OR 1=1" }, /numérico/],
    [{ level: "AD_GROUP", adGroupId: "777", type: "BUDGET" }, /não tem simulação BUDGET/],
    [{ level: "KEYWORD", adGroupId: "777", criterionId: "x" }, /criterionId deve ser numérico/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_bid_simulations", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
    assert.equal(calls.queries.length, 0);
  }
});

test("get_bid_simulations: entidade inexistente é erro; sem simulação explica os motivos", async () => {
  const missing = fakeClient();
  const r1 = await call(missing.client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /não encontrada/);
  assert.equal(missing.calls.queries.length, 1, "não consulta simulação de entidade que não existe");

  const empty = fakeClient({ rows: { campaign: [searchCampaign()] } });
  const r2 = await call(empty.client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID });
  assert.equal(r2.isError, undefined);
  assert.match(textOf(r2), /conta de teste/);
});

test("get_bid_simulations: TARGET_CPA SCALING — how_to_apply multiplica o alvo atual (e os overrides), nunca cita campo inexistente", async () => {
  const scalingCpa = (): Row => ({
    campaignSimulation: {
      campaignId: CAMPAIGN_ID, type: "TARGET_CPA", modificationMethod: "SCALING", startDate: "2026-09-10", endDate: "2026-09-16",
      targetCpaPointList: {
        points: [
          { targetCpaScalingModifier: 1.2, costMicros: "840000000", biddableConversions: 16 },
          { targetCpaScalingModifier: 0.8, costMicros: "560000000", biddableConversions: 12 },
          { targetCpaScalingModifier: 1.0, costMicros: "700000000", biddableConversions: 14 },
          { targetCpaScalingModifier: 0.73, costMicros: "500000000", biddableConversions: 11 },
        ],
      },
    },
  });
  const { client } = fakeClient({ rows: { campaign: [searchCampaign()], campaign_simulation: [scalingCpa()] } });
  const payload = jsonOf(await call(client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID, type: "TARGET_CPA" }));
  const [sim] = payload.simulations as Row[];
  const points = sim.points as Row[];
  assert.equal(sim.modification_method, "SCALING");
  assert.equal(sim.current_value, "R$ 50.00");
  assert.deepEqual(points.map((p) => p.scaling_modifier), [0.73, 0.8, 1, 1.2]);
  assert.ok(points.every((p) => p.targetCpaMicros === undefined), "ponto SCALING não tem CPA absoluto");
  // 50.000.000 × fator, ao centavo (0.73 → 36.500.000)
  assert.deepEqual(points.map((p) => p.scaled_targetCpaMicros), [36_500_000, 40_000_000, 50_000_000, 60_000_000]);
  assert.equal(points[2].current, "atual");
  const hint = String(sim.how_to_apply);
  assert.doesNotMatch(hint, /<targetCpaMicros do ponto>/, "não manda usar um campo que o ponto não tem");
  assert.match(hint, /update_campaign \{ campaignId: "24250313718", targetCpaMicros: <scaled_targetCpaMicros do ponto> \}/);
  assert.match(hint, /round\(50000000 × scaling_modifier\)/);
  assert.match(hint, /overrides/);
  // Todo campo citado entre <...> no how_to_apply existe nos pontos.
  for (const [, field] of hint.matchAll(/<([a-zA-Z_]+) do ponto>/g)) assert.ok(field in points[0], field);

  // Portfólio: o fator vale sobre o alvo do portfólio (update_bidding_strategy), não update_campaign.
  const portfolio = fakeClient({
    rows: {
      campaign: [searchCampaign({ biddingStrategy: `customers/${CID}/biddingStrategies/55`, targetCpa: undefined })],
      campaign_simulation: [scalingCpa()],
    },
  });
  const pSim = (jsonOf(await call(portfolio.client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID })).simulations as Row[])[0];
  assert.match(String(pSim.how_to_apply), /SCALING[\s\S]*update_bidding_strategy/);
  assert.doesNotMatch(String(pSim.how_to_apply), /update_campaign/);
  assert.ok((pSim.points as Row[]).every((p) => p.scaled_targetCpaMicros === undefined));

  // Sem CPA alvo na campanha: não há valor absoluto — o hint diz isso em vez de inventar um.
  const noTarget = fakeClient({
    rows: { campaign: [searchCampaign({ biddingStrategyType: "MAXIMIZE_CONVERSIONS", targetCpa: undefined })], campaign_simulation: [scalingCpa()] },
  });
  const nSim = (jsonOf(await call(noTarget.client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID })).simulations as Row[])[0];
  assert.equal(nSim.current_value, "1x (lances atuais)");
  assert.match(String(nSim.how_to_apply), /não tem CPA alvo próprio/);
  assert.doesNotMatch(String(nSim.how_to_apply), /do ponto>/);

  // CPC_BID SCALING: multiplicador sobre os lances dos grupos/palavras.
  const cpc = fakeClient({
    rows: {
      campaign: [searchCampaign()],
      campaign_simulation: [{ campaignSimulation: { campaignId: CAMPAIGN_ID, type: "CPC_BID", modificationMethod: "SCALING", startDate: "2026-09-10", endDate: "2026-09-16", cpcBidPointList: { points: [{ cpcBidScalingModifier: 1.5 }] } } }],
    },
  });
  const cSim = (jsonOf(await call(cpc.client, "get_bid_simulations", { level: "CAMPAIGN", campaignId: CAMPAIGN_ID })).simulations as Row[])[0];
  assert.match(String(cSim.how_to_apply), /SCALING: scaling_modifier multiplica os lances de CPC/);
});

// ── Sazonalidade e exclusão de dados ──────────────────────────────────

const smartCampaign = (id: string, strategy = "TARGET_ROAS", status = "ENABLED"): Row => ({
  campaign: { id, name: `Campanha ${id}`, status, advertisingChannelType: "SEARCH", biddingStrategyType: strategy },
});

const seasonalityRow = (overrides: Row = {}): Row => ({
  biddingSeasonalityAdjustment: {
    resourceName: `customers/${CID}/biddingSeasonalityAdjustments/300`, seasonalityAdjustmentId: "300", name: "Black Friday",
    description: "", scope: "CAMPAIGN", status: "ENABLED", startDateTime: rel(10, "00:00:00"), endDateTime: rel(13, "00:00:00"),
    conversionRateModifier: 1.5, devices: [], campaigns: [`customers/${CID}/campaigns/${CAMPAIGN_ID}`], advertisingChannelTypes: [],
    ...overrides,
  },
});

test("create_seasonality_adjustment: escopo CAMPAIGN — payload da v25 e fim exclusivo com a data", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID)] } });
  const result = await call(client, "create_seasonality_adjustment", {
    name: "Black Friday 2026", scope: "CAMPAIGN", campaignIds: [CAMPAIGN_ID], startDateTime: relDay(10), endDateTime: relDay(12),
    conversionRateModifier: 1.4, devices: ["mobile"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = onlyWrite(calls);
  assert.equal(write.resource, "biddingSeasonalityAdjustments");
  assert.deepEqual(write.operations[0].create, {
    name: "Black Friday 2026", scope: "CAMPAIGN", startDateTime: `${relDay(10)} 00:00:00`, endDateTime: `${relDay(13)} 00:00:00`,
    devices: ["MOBILE"], campaigns: [`customers/${CID}/campaigns/${CAMPAIGN_ID}`], conversionRateModifier: 1.4,
  });
  assert.match(textOf(result), /Ajuste de sazonalidade criado/);
  assert.match(calls.queries.find((q) => /FROM bidding_seasonality_adjustment/.test(q))!, /status != 'REMOVED'/);
});

test("create_seasonality_adjustment: escopo CHANNEL, aviso acima de 7 dias e sobreposição", async () => {
  const { client, calls } = fakeClient({
    rows: { bidding_seasonality_adjustment: [seasonalityRow({ scope: "CHANNEL", campaigns: [], advertisingChannelTypes: ["SEARCH"], name: "Semana do Consumidor" })] },
  });
  const result = await call(client, "create_seasonality_adjustment", {
    name: "Esquenta BF", scope: "CHANNEL", channels: ["SEARCH", "SHOPPING"], startDateTime: rel(5, "00:00:00"), endDateTime: rel(15, "00:00:00"),
    conversionRateModifier: 2.5,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const created = onlyWrite(calls).operations[0].create as Row;
  assert.deepEqual(created.advertisingChannelTypes, ["SEARCH", "SHOPPING"]);
  assert.equal(created.campaigns, undefined);
  const warnings = (jsonOf(result).warnings as string[]).join("\n");
  assert.match(warnings, /recomenda 1 a 7 dias/);
  assert.match(warnings, /agressivo/);
  assert.match(warnings, /Sobrepõe "Semana do Consumidor"/);
});

test("create_seasonality_adjustment: regras do proto recusadas antes de qualquer chamada", async () => {
  const base = { name: "BF", scope: "CAMPAIGN", campaignIds: [CAMPAIGN_ID], startDateTime: rel(10), endDateTime: rel(12), conversionRateModifier: 1.5 };
  const cases: Array<[Row, RegExp]> = [
    [{ conversionRateModifier: 12 }, /entre 0.1 e 10.0/],
    [{ conversionRateModifier: 1 }, /1.0 não ajusta nada/],
    [{ endDateTime: rel(26) }, /no máximo 14 dias/],
    [{ endDateTime: rel(9) }, /precisa ser depois/],
    [{ scope: "CHANNEL" }, /scope CHANNEL exige channels/],
    [{ channels: ["SEARCH"] }, /não aceita channels/],
    [{ scope: "CHANNEL", campaignIds: [], channels: ["VIDEO"] }, /channels inválidos: VIDEO/],
    [{ devices: ["SMART_TV"] }, /devices inválidos/],
    [{ campaignIds: ["12a"] }, /numéricos/],
    [{ startDateTime: "amanhã" }, /não é data válida/],
    [{ name: "  " }, /name é obrigatório/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_seasonality_adjustment", { ...base, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), message);
    assert.equal(calls.queries.length + calls.writes.length + calls.customerReads, 0, JSON.stringify(args));
  }
});

test("create_seasonality_adjustment: início no passado, MCC, nome repetido e campanha inexistente são recusados sem gravar", async () => {
  const base = { name: "BF", scope: "CAMPAIGN", campaignIds: [CAMPAIGN_ID], startDateTime: rel(10), endDateTime: rel(12), conversionRateModifier: 1.5 };
  const past = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID)] } });
  const r1 = await call(past.client, "create_seasonality_adjustment", { ...base, startDateTime: rel(-1), endDateTime: rel(2) });
  assert.match(textOf(r1), /já passou[\s\S]*create_data_exclusion/);

  const manager = fakeClient({ customer: { manager: true } });
  assert.match(textOf(await call(manager.client, "create_seasonality_adjustment", base)), /administrador \(MCC\)/);

  const dup = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow({ name: "BF" })], campaign: [smartCampaign(CAMPAIGN_ID)] } });
  assert.match(textOf(await call(dup.client, "create_seasonality_adjustment", base)), /nome precisa ser único/);

  const missing = fakeClient({ rows: { campaign: [] } });
  assert.match(textOf(await call(missing.client, "create_seasonality_adjustment", base)), /não encontradas nesta conta: 24250313718/);

  const removed = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID, "TARGET_ROAS", "REMOVED")] } });
  assert.match(textOf(await call(removed.client, "create_seasonality_adjustment", base)), /removidas: 24250313718/);

  for (const fake of [past, manager, dup, missing, removed]) assert.equal(fake.calls.writes.length, 0);
});

test("create_seasonality_adjustment: campanha sem Smart Bidding avisa; erro da API é traduzido; dry-run não afirma criação", async () => {
  const base = { name: "BF", scope: "CAMPAIGN", campaignIds: [CAMPAIGN_ID], startDateTime: rel(10), endDateTime: rel(12), conversionRateModifier: 1.5 };
  const manual = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID, "MANUAL_CPC")] } });
  const r1 = await call(manual.client, "create_seasonality_adjustment", base);
  assert.match((jsonOf(r1).warnings as string[]).join(" "), /Sem Smart Bidding[\s\S]*MANUAL_CPC/);

  const refused = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID)] }, mutateError: "Resource limit exceeded." });
  const r2 = await call(refused.client, "create_seasonality_adjustment", base);
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /A API recusou[\s\S]*Resource limit exceeded/);

  const dry = fakeClient({ rows: { campaign: [smartCampaign(CAMPAIGN_ID)] } });
  const r3 = await call(dry.client, "create_seasonality_adjustment", { ...base, validateOnly: true });
  assert.equal(dry.calls.dryRunClones, 1);
  assert.match(textOf(r3), /^VALIDATE-ONLY[\s\S]*DRY-RUN \(validateOnly\): ajuste de sazonalidade validado pela API — nada foi criado/);
  assert.doesNotMatch(textOf(r3), /criado: /);
});

test("create_data_exclusion: início no passado, fim pode ser futuro (avisa), sem modificador", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_data_exclusion", {
    name: "GTM quebrado", scope: "CHANNEL", channels: ["SEARCH"], startDateTime: rel(-3, "08:00:00"), endDateTime: rel(1, "08:00:00"),
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = onlyWrite(calls);
  assert.equal(write.resource, "biddingDataExclusions");
  const created = write.operations[0].create as Row;
  assert.equal(created.conversionRateModifier, undefined);
  assert.equal(created.startDateTime, rel(-3, "08:00:00"));
  assert.match((jsonOf(result).warnings as string[]).join(" "), /também serão ignoradas/);
});

test("create_data_exclusion: início no futuro, 15 dias e limite de 500 são recusados", async () => {
  const base = { name: "Pixel", scope: "CHANNEL", channels: ["SEARCH"], startDateTime: rel(-3), endDateTime: rel(-1) };
  const future = fakeClient();
  assert.match(textOf(await call(future.client, "create_data_exclusion", { ...base, startDateTime: rel(1), endDateTime: rel(2) })), /create_seasonality_adjustment/);
  const long = fakeClient();
  assert.match(textOf(await call(long.client, "create_data_exclusion", { ...base, startDateTime: rel(-20), endDateTime: rel(-5) })), /no máximo 14 dias/);
  assert.equal(long.calls.queries.length + long.calls.customerReads, 0);
  const full = Array.from({ length: 500 }, (_, i) => ({
    biddingDataExclusion: { dataExclusionId: String(i), name: `x${i}`, scope: "CHANNEL", status: "ENABLED", startDateTime: rel(-40), endDateTime: rel(-39), advertisingChannelTypes: ["SEARCH"] },
  }));
  const limit = fakeClient({ rows: { bidding_data_exclusion: full } });
  assert.match(textOf(await call(limit.client, "create_data_exclusion", base)), /limite da API: 500/);
  assert.equal(future.calls.writes.length + long.calls.writes.length + limit.calls.writes.length, 0);
});

test("list_bidding_adjustments: os dois tipos, momento pelo relógio da conta e nome das campanhas", async () => {
  const { client, calls } = fakeClient({
    rows: {
      bidding_seasonality_adjustment: [seasonalityRow()],
      bidding_data_exclusion: [{ biddingDataExclusion: { dataExclusionId: "400", name: "GTM", scope: "CHANNEL", status: "ENABLED", startDateTime: rel(-5), endDateTime: rel(-4), advertisingChannelTypes: ["SEARCH"], devices: ["MOBILE"] } }],
      campaign: [smartCampaign(CAMPAIGN_ID)],
    },
  });
  const rows = jsonOf(await call(client, "list_bidding_adjustments", {})) as unknown as Row[];
  assert.deepEqual(rows.map((r) => [r.kind, r.timing]), [["SEASONALITY", "UPCOMING"], ["DATA_EXCLUSION", "PAST"]]);
  assert.equal(rows[0].campaigns, `${CAMPAIGN_ID} (Campanha ${CAMPAIGN_ID})`);
  assert.equal(rows[0].conversion_rate_modifier, 1.5);
  assert.equal(rows[1].devices, "MOBILE");
  assert.ok(calls.queries.some((q) => /FROM bidding_data_exclusion[\s\S]*status != 'REMOVED'/.test(q)));

  const upcoming = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow()], bidding_data_exclusion: [] } });
  const filtered = jsonOf(await call(upcoming.client, "list_bidding_adjustments", { timing: "PAST" })) as unknown as Row[];
  assert.deepEqual(filtered, []);

  const onlyKind = fakeClient();
  await call(onlyKind.client, "list_bidding_adjustments", { kind: "DATA_EXCLUSION", includeRemoved: true, format: "csv" });
  assert.ok(onlyKind.calls.queries.every((q) => !/bidding_seasonality_adjustment/.test(q)));
  assert.ok(onlyKind.calls.queries.every((q) => !/status != 'REMOVED'/.test(q)));
});

test("update_bidding_adjustment: só o que muda vai no updateMask; lista vazia de devices volta a todos", async () => {
  const { client, calls } = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow({ devices: ["MOBILE"] })], campaign: [smartCampaign(CAMPAIGN_ID)] } });
  const result = await call(client, "update_bidding_adjustment", {
    kind: "SEASONALITY", id: "300", conversionRateModifier: 1.8, devices: [], name: "Black Friday",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const op = onlyWrite(calls).operations[0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.updateMask.split(",").sort(), ["conversion_rate_modifier", "devices"]);
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/biddingSeasonalityAdjustments/300`, conversionRateModifier: 1.8, devices: [] });
});

test("update_bidding_adjustment: no-op, escopo errado, sazonalidade encerrada e modificador em exclusão são recusados", async () => {
  const noop = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow()] } });
  const r1 = await call(noop.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", conversionRateModifier: 1.5 });
  assert.match(textOf(r1), /nada a mudar/);

  const scope = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow()] } });
  assert.match(textOf(await call(scope.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", channels: ["SEARCH"] })), /channels só vale no escopo CHANNEL/);

  const ended = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow({ startDateTime: rel(-5), endDateTime: rel(-2) })] } });
  assert.match(textOf(await call(ended.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", conversionRateModifier: 2 })), /já terminou/);

  const modifier = fakeClient();
  const r4 = await call(modifier.client, "update_bidding_adjustment", { kind: "DATA_EXCLUSION", id: "400", conversionRateModifier: 2 });
  assert.match(textOf(r4), /só existe em ajuste de sazonalidade/);
  assert.equal(modifier.calls.queries.length, 0);

  const missing = fakeClient();
  assert.match(textOf(await call(missing.client, "update_bidding_adjustment", { kind: "DATA_EXCLUSION", id: "400", name: "x" })), /não encontrado/);

  for (const fake of [noop, scope, ended, modifier, missing]) assert.equal(fake.calls.writes.length, 0);
});

test("update_bidding_adjustment: mover a sazonalidade para o passado ou passar de 14 dias é recusado", async () => {
  const past = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow()] } });
  assert.match(textOf(await call(past.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", startDateTime: rel(-1) })), /já passou/);
  const long = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow()] } });
  assert.match(textOf(await call(long.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", endDateTime: rel(30) })), /no máximo 14 dias/);
  assert.equal(past.calls.writes.length + long.calls.writes.length, 0);
});

test("update_bidding_adjustment: renomear para nome de outro ajuste e alterar ajuste removido são recusados sem gravar", async () => {
  const other = seasonalityRow({
    resourceName: `customers/${CID}/biddingSeasonalityAdjustments/301`, seasonalityAdjustmentId: "301", name: "Natal",
    startDateTime: rel(80, "00:00:00"), endDateTime: rel(82, "00:00:00"),
  });
  // O primeiro SELECT (por id) devolve o 300; a checagem de nome lê todos os não removidos.
  const clash = fakeClient({
    rows: (from, query) => from !== "bidding_seasonality_adjustment" ? [] : /seasonality_adjustment_id = 300/.test(query) ? [seasonalityRow()] : [seasonalityRow(), other],
  });
  const r1 = await call(clash.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", name: " Natal " });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Já existe ajuste de sazonalidade com o nome "Natal" \(id 301\)/);
  assert.ok(clash.calls.queries.some((q) => /status != 'REMOVED'/.test(q)), "confere nomes só entre os ativos");
  assert.equal(clash.calls.writes.length, 0);

  // Renomear para o próprio nome atual não é conflito (e é no-op).
  const self = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow(), other] } });
  assert.match(textOf(await call(self.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", name: "Black Friday" })), /nada a mudar/);
  assert.equal(self.calls.writes.length, 0);

  const removed = fakeClient({ rows: { bidding_seasonality_adjustment: [seasonalityRow({ status: "REMOVED" })], campaign: [smartCampaign(CAMPAIGN_ID)] } });
  const r2 = await call(removed.client, "update_bidding_adjustment", { kind: "SEASONALITY", id: "300", name: "Black Friday 2", conversionRateModifier: 2 });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /está removido\. Nada foi alterado/);
  assert.equal(removed.calls.writes.length, 0);
});

test("remove_bidding_adjustments: confirm obrigatório, erro por item, não encontrados e já removidos", async () => {
  const gate = fakeClient();
  const r0 = await call(gate.client, "remove_bidding_adjustments", { kind: "SEASONALITY", ids: ["300"], confirm: false });
  assert.equal(r0.isError, true);
  assert.equal(gate.calls.queries.length + gate.calls.writes.length, 0);

  const partial = fakeClient({
    rows: {
      bidding_seasonality_adjustment: [
        seasonalityRow(),
        seasonalityRow({ seasonalityAdjustmentId: "301", resourceName: `customers/${CID}/biddingSeasonalityAdjustments/301`, name: "Natal" }),
        seasonalityRow({ seasonalityAdjustmentId: "302", resourceName: `customers/${CID}/biddingSeasonalityAdjustments/302`, status: "REMOVED" }),
      ],
    },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/biddingSeasonalityAdjustments/300` }, {}],
      partialFailureError: { details: [{ errors: [{ message: "Resource was not found.", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const result = await call(partial.client, "remove_bidding_adjustments", { kind: "SEASONALITY", ids: ["300", "301", "302", "999"], confirm: true });
  assert.equal(result.isError, true);
  const write = onlyWrite(partial.calls);
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations.map((op) => op.remove), [`customers/${CID}/biddingSeasonalityAdjustments/300`, `customers/${CID}/biddingSeasonalityAdjustments/301`]);
  const payload = jsonOf(result);
  assert.deepEqual((payload.removed as Row[]).map((r) => r.id), ["300"]);
  assert.equal((payload.errors as Row[])[0].id, "301");
  assert.deepEqual(payload.not_found, ["999"]);
  assert.deepEqual(payload.already_removed, ["302"]);

  const nothing = fakeClient();
  assert.match(textOf(await call(nothing.client, "remove_bidding_adjustments", { kind: "DATA_EXCLUSION", ids: ["1"], confirm: true })), /Nada a remover/);
  assert.equal(nothing.calls.writes.length, 0);
});

// ── Estratégias de portfólio ──────────────────────────────────────────

const portfolioRow = (overrides: Row = {}): Row => ({
  biddingStrategy: {
    id: "55", name: "tROAS Moda", type: "TARGET_ROAS", status: "ENABLED", resourceName: `customers/${CID}/biddingStrategies/55`,
    nonRemovedCampaignCount: "1", campaignCount: "1", targetRoas: { targetRoas: 4, cpcBidCeilingMicros: "5000000" }, ...overrides,
  },
});

test("list_bidding_strategies: portfólios da conta e de MCC, campanhas com status do lance e nota de jun/2026", async () => {
  const { client, calls } = fakeClient({
    rows: {
      bidding_strategy: [portfolioRow(), portfolioRow({ id: "56", name: "MC com CPA", type: "MAXIMIZE_CONVERSIONS", targetRoas: undefined, maximizeConversions: { targetCpaMicros: "30000000" }, nonRemovedCampaignCount: "0" })],
      accessible_bidding_strategy: [{ accessibleBiddingStrategy: { id: "70", name: "tCPA Agência", type: "TARGET_CPA", ownerCustomerId: MCC, ownerDescriptiveName: "Agência", targetCpa: { targetCpaMicros: "45000000" } } }],
      campaign: [
        { campaign: { id: "1", name: "Moda", status: "ENABLED", biddingStrategy: `customers/${CID}/biddingStrategies/55`, biddingStrategyType: "TARGET_ROAS", biddingStrategySystemStatus: "LEARNING_NEW" } },
        { campaign: { id: "2", name: "Leads", status: "ENABLED", biddingStrategy: `customers/${MCC}/biddingStrategies/70`, biddingStrategyType: "TARGET_CPA", biddingStrategySystemStatus: "ENABLED" } },
        { campaign: { id: "3", name: "Marca", status: "PAUSED", advertisingChannelType: "SEARCH", biddingStrategyType: "TARGET_SPEND", targetSpend: { cpcBidCeilingMicros: "2000000" }, biddingStrategySystemStatus: "ENABLED" } },
      ],
    },
  });
  const payload = jsonOf(await call(client, "list_bidding_strategies", { includeStandardCampaigns: true }));
  const portfolios = payload.portfolios as Row[];
  assert.deepEqual(portfolios.map((p) => [p.id, p.owner]), [["55", `esta conta (${CID})`], ["56", `esta conta (${CID})`], ["70", `MCC Agência (${MCC})`]]);
  assert.equal(portfolios[0].target_roas, 4);
  assert.equal(portfolios[0].cpc_bid_ceiling, "R$ 5.00");
  assert.deepEqual((portfolios[0].campaigns as Row[])[0], { id: "1", name: "Moda", status: "ENABLED", system_status: "LEARNING_NEW" });
  assert.equal((portfolios[2].campaigns as Row[])[0].id, "2");
  assert.equal(portfolios[2].resource_name, `customers/${MCC}/biddingStrategies/70`);
  assert.deepEqual((payload.standard_campaigns as Row[]).map((c) => [c.campaign_id, c.strategy_type, c.cpc_bid_ceiling]), [["3", "TARGET_SPEND", "R$ 2.00"]]);
  assert.match((payload.notes as string[]).join(" "), /16\/06\/2026/);
  assert.match(calls.queries.find((q) => /FROM accessible_bidding_strategy/.test(q))!, new RegExp(`owner_customer_id != ${CID}`));

  const noShared = fakeClient();
  await call(noShared.client, "list_bidding_strategies", { includeManagerOwned: false, format: "table" });
  assert.ok(noShared.calls.queries.every((q) => !/accessible_bidding_strategy\.owner/.test(q)));
});

test("create_bidding_strategy: TARGET_ROAS com teto — payload do oneof scheme", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_bidding_strategy", { name: " tROAS Calçados ", type: "TARGET_ROAS", targetRoas: 4.5, cpcBidCeilingMicros: 3_000_000 });
  assert.equal(result.isError, undefined, textOf(result));
  const write = onlyWrite(calls);
  assert.equal(write.resource, "biddingStrategies");
  assert.deepEqual(write.operations[0].create, { name: "tROAS Calçados", targetRoas: { targetRoas: 4.5, cpcBidCeilingMicros: "3000000" } });
  assert.match(calls.queries[0], /bidding_strategy\.name = 'tROAS Calçados'/);
  assert.match(textOf(result), /assign_bidding_strategy/);
  assert.equal(calls.customerReads, 0, "sem currencyCode não precisa ler a conta");
});

test("create_bidding_strategy: parâmetros por tipo, faixas e piso > teto recusados sem chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ type: "TARGET_CPA" }, /TARGET_CPA exige targetCpaMicros/],
    [{ type: "TARGET_SPEND", targetRoas: 3 }, /não usa targetRoas/],
    [{ type: "TARGET_ROAS", targetRoas: 0 }, /entre 0.01 e 1000/],
    [{ type: "TARGET_IMPRESSION_SHARE", targetImpressionShareLocation: "TOP_OF_PAGE", locationFractionMicros: 700_000 }, /exige cpcBidCeilingMicros/],
    [{ type: "MAXIMIZE_CONVERSIONS", cpcBidCeilingMicros: 1_000_000, cpcBidFloorMicros: 2_000_000 }, /não pode passar de cpcBidCeilingMicros/],
    [{ type: "TARGET_CPA", targetCpaMicros: 1.5 }, /inteiro positivo/],
    [{ type: "TARGET_SPEND", currencyCode: "brl" }, /ISO 4217/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_bidding_strategy", { name: "X", ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), message);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
});

test("create_bidding_strategy: nome repetido, moeda em conta cliente e aviso de alvo embutido", async () => {
  const dup = fakeClient({ rows: { bidding_strategy: [portfolioRow({ name: "X" })] } });
  assert.match(textOf(await call(dup.client, "create_bidding_strategy", { name: "X", type: "TARGET_SPEND" })), /nome precisa ser único/);
  assert.equal(dup.calls.writes.length, 0);

  const client = fakeClient();
  assert.match(textOf(await call(client.client, "create_bidding_strategy", { name: "X", type: "TARGET_SPEND", currencyCode: "USD" })), /só pode ser definido em estratégia de MCC/);
  assert.equal(client.calls.writes.length, 0);

  const manager = fakeClient({ customer: { manager: true } });
  await call(manager.client, "create_bidding_strategy", { name: "X", type: "TARGET_SPEND", cpcBidCeilingMicros: 2_000_000, currencyCode: "USD" });
  assert.equal((onlyWrite(manager.calls).operations[0].create as Row).currencyCode, "USD");

  const bundled = fakeClient();
  const r = await call(bundled.client, "create_bidding_strategy", { name: "MC", type: "MAXIMIZE_CONVERSIONS", targetCpaMicros: 40_000_000 });
  assert.match(textOf(r), /TARGET_CPA \/ TARGET_ROAS/);
});

test("update_bidding_strategy: folha exata no updateMask, no-op e tipo imutável", async () => {
  const { client, calls } = fakeClient({ rows: { bidding_strategy: [portfolioRow()] } });
  const result = await call(client, "update_bidding_strategy", { biddingStrategyId: "55", targetRoas: 5, cpcBidCeilingMicros: 5_000_000 });
  assert.equal(result.isError, undefined, textOf(result));
  const op = onlyWrite(calls).operations[0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  assert.equal(op.updateMask, "target_roas.target_roas");
  assert.deepEqual(op.update.targetRoas, { targetRoas: 5 });

  const noop = fakeClient({ rows: { bidding_strategy: [portfolioRow()] } });
  assert.match(textOf(await call(noop.client, "update_bidding_strategy", { biddingStrategyId: "55", targetRoas: 4 })), /nada a mudar/);

  const wrongType = fakeClient({ rows: { bidding_strategy: [portfolioRow()] } });
  assert.match(textOf(await call(wrongType.client, "update_bidding_strategy", { biddingStrategyId: "55", targetCpaMicros: 30_000_000 })), /não usa targetCpaMicros/);
  assert.equal(noop.calls.writes.length + wrongType.calls.writes.length, 0);
});

test("update_bidding_strategy: clearTarget limpa a folha sem valor; portfólio grande exige confirm", async () => {
  const mc = portfolioRow({ type: "MAXIMIZE_CONVERSIONS", targetRoas: undefined, maximizeConversions: { targetCpaMicros: "30000000" }, nonRemovedCampaignCount: "1" });
  const clear = fakeClient({ rows: { bidding_strategy: [mc] } });
  await call(clear.client, "update_bidding_strategy", { biddingStrategyId: "55", clearTarget: true });
  const op = onlyWrite(clear.calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "maximize_conversions.target_cpa_micros");
  assert.deepEqual(op.update.maximizeConversions, {});

  const big = portfolioRow({ nonRemovedCampaignCount: "12" });
  const gated = fakeClient({ rows: { bidding_strategy: [big] } });
  const preview = await call(gated.client, "update_bidding_strategy", { biddingStrategyId: "55", targetRoas: 3.5 });
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /12 campanhas ativas[\s\S]*confirm: true[\s\S]*"preview"/);
  assert.equal(gated.calls.writes.length, 0);
  const confirmed = fakeClient({ rows: { bidding_strategy: [big] } });
  await call(confirmed.client, "update_bidding_strategy", { biddingStrategyId: "55", targetRoas: 3.5, confirm: true });
  assert.equal(confirmed.calls.writes.length, 1);

  const missing = fakeClient();
  assert.match(textOf(await call(missing.client, "update_bidding_strategy", { biddingStrategyId: "55", targetRoas: 3 })), /customerId do MCC dono/);
});

test("assign_bidding_strategy: prévia sem confirm; com confirm só as que mudam, updateMask bidding_strategy", async () => {
  const rows = {
    bidding_strategy: [portfolioRow()],
    campaign: [
      { campaign: { id: "1", name: "Moda", status: "ENABLED", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE", campaignBudget: `customers/${CID}/campaignBudgets/9` } },
      { campaign: { id: "2", name: "Calçados", status: "ENABLED", biddingStrategy: `customers/${CID}/biddingStrategies/55`, biddingStrategyType: "TARGET_ROAS" } },
    ],
  };
  const preview = fakeClient({ rows });
  const r1 = await call(preview.client, "assign_bidding_strategy", { campaignIds: ["1", "2"], biddingStrategyId: "55" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Prévia — 1 campanha/);
  assert.equal(preview.calls.writes.length, 0);

  const apply = fakeClient({ rows });
  const r2 = await call(apply.client, "assign_bidding_strategy", { campaignIds: "[\"1\",\"2\"]", biddingStrategyId: "55", confirm: true });
  assert.notEqual(r2.isError, true, textOf(r2));
  const write = onlyWrite(apply.calls);
  assert.equal(write.resource, "campaigns");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [{ update: { resourceName: `customers/${CID}/campaigns/1`, biddingStrategy: `customers/${CID}/biddingStrategies/55` }, updateMask: "bidding_strategy" }]);
  assert.deepEqual(jsonOf(r2).already_assigned, ["2"]);
});

test("assign_bidding_strategy: estratégia de MCC pelo accessible_bidding_strategy e erro com dica de login-customer-id", async () => {
  const rows = (from: string): Row[] | undefined => {
    if (from === "accessible_bidding_strategy") return [{ accessibleBiddingStrategy: { id: "70", name: "tCPA Agência", type: "TARGET_CPA", ownerCustomerId: MCC } }];
    if (from === "campaign") return [{ campaign: { id: "1", name: "Leads", status: "ENABLED", biddingStrategyType: "TARGET_CPA" } }];
    return [];
  };
  const ok = fakeClient({ rows });
  await call(ok.client, "assign_bidding_strategy", { campaignIds: ["1"], biddingStrategyId: "70", confirm: true });
  assert.equal((onlyWrite(ok.calls).operations[0].update as Row).biddingStrategy, `customers/${MCC}/biddingStrategies/70`);

  const refused = fakeClient({ rows, mutateError: "The caller does not have permission." });
  const r = await call(refused.client, "assign_bidding_strategy", { campaignIds: ["1"], biddingStrategyId: "70", confirm: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /login-customer-id do MCC dono/);
});

test("assign_bidding_strategy: orçamento alinhado, campanha inexistente e entrada inválida são recusados", async () => {
  const aligned = fakeClient({
    rows: {
      bidding_strategy: [portfolioRow({ alignedCampaignBudgetId: "9" })],
      campaign: [{ campaign: { id: "1", name: "Moda", status: "ENABLED", biddingStrategyType: "TARGET_ROAS", campaignBudget: `customers/${CID}/campaignBudgets/10` } }],
    },
  });
  assert.match(textOf(await call(aligned.client, "assign_bidding_strategy", { campaignIds: ["1"], biddingStrategyId: "55", confirm: true })), /alinhada ao orçamento compartilhado 9/);

  const missing = fakeClient({ rows: { bidding_strategy: [portfolioRow()], campaign: [] } });
  assert.match(textOf(await call(missing.client, "assign_bidding_strategy", { campaignIds: ["1"], biddingStrategyId: "55", confirm: true })), /não encontradas: 1/);

  const invalid = fakeClient();
  assert.match(textOf(await call(invalid.client, "assign_bidding_strategy", { campaignIds: ["1 OR 1=1"], biddingStrategyId: "55", confirm: true })), /numéricos/);
  assert.equal(invalid.calls.queries.length, 0);

  const unknown = fakeClient();
  assert.match(textOf(await call(unknown.client, "assign_bidding_strategy", { campaignIds: ["1"], biddingStrategyId: "55", confirm: true })), /nem foi compartilhada/);
  for (const fake of [aligned, missing, invalid, unknown]) assert.equal(fake.calls.writes.length, 0);
});

test("remove_bidding_strategy: confirm, portfólio em uso, já removido e remoção", async () => {
  const gate = fakeClient();
  assert.equal((await call(gate.client, "remove_bidding_strategy", { biddingStrategyId: "55", confirm: false })).isError, true);
  assert.equal(gate.calls.queries.length, 0);

  const inUse = fakeClient({ rows: { bidding_strategy: [portfolioRow({ nonRemovedCampaignCount: "3" })] } });
  assert.match(textOf(await call(inUse.client, "remove_bidding_strategy", { biddingStrategyId: "55", confirm: true })), /CANNOT_REMOVE_ASSOCIATED_STRATEGY/);

  const gone = fakeClient({ rows: { bidding_strategy: [portfolioRow({ status: "REMOVED" })] } });
  assert.match(textOf(await call(gone.client, "remove_bidding_strategy", { biddingStrategyId: "55", confirm: true })), /já está removida/);

  const free = fakeClient({ rows: { bidding_strategy: [portfolioRow({ nonRemovedCampaignCount: "0" })] } });
  const r = await call(free.client, "remove_bidding_strategy", { biddingStrategyId: "55", confirm: true });
  assert.deepEqual(onlyWrite(free.calls).operations, [{ remove: `customers/${CID}/biddingStrategies/55` }]);
  assert.match(textOf(r), /removida/);
  assert.equal(inUse.calls.writes.length + gone.calls.writes.length, 0);
});

// ── Alvos por grupo ───────────────────────────────────────────────────

test("get_ad_group_bid_targets: override x efetivo com a origem, filtro de overrides", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [
        { campaign: { id: "1", name: "Moda", biddingStrategyType: "TARGET_ROAS" }, adGroup: { id: "10", name: "Vestidos", status: "ENABLED", targetRoas: 3, effectiveTargetRoas: 3, effectiveTargetRoasSource: "AD_GROUP" } },
        { campaign: { id: "1", name: "Moda", biddingStrategyType: "TARGET_ROAS" }, adGroup: { id: "11", name: "Saias", status: "ENABLED", effectiveTargetRoas: 4, effectiveTargetRoasSource: "CAMPAIGN_BIDDING_STRATEGY" } },
      ],
    },
  });
  const rows = jsonOf(await call(client, "get_ad_group_bid_targets", { campaignId: "1", onlyOverrides: true })) as unknown as Row[];
  assert.deepEqual(rows.map((r) => [r.ad_group_id, r.target_roas_override, r.effective_target_roas_source]), [["10", 3, "AD_GROUP"]]);
  assert.match(calls.queries[0], /campaign\.id = 1/);
  assert.match(calls.queries[0], /ad_group\.effective_target_cpa_source/);

  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_ad_group_bid_targets", { adGroupIds: ["x"] })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ── update_ad_group (item 64) ─────────────────────────────────────────

const adGroupRow = (campaign: Row, adGroup: Row = {}): Row => ({
  adGroup: { id: "777", name: "Vestidos", status: "ENABLED", ...adGroup },
  campaign: { id: CAMPAIGN_ID, ...campaign },
});

test("update_ad_group: ROAS alvo do grupo — updateMask target_roas e alvos efetivos na resposta", async () => {
  const { client, calls } = fakeClient({
    rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS" }, { effectiveTargetRoas: 4, effectiveTargetRoasSource: "CAMPAIGN_BIDDING_STRATEGY" })] },
  });
  const result = await call(client, "update_ad_group", { adGroupId: "777", targetRoas: 3 });
  const op = onlyWrite(calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "target_roas");
  assert.equal(op.update.targetRoas, 3);
  const payload = jsonOf(result);
  assert.deepEqual(payload.effective_targets_before, { target_cpa: null, target_cpa_source: null, target_roas: 4, target_roas_source: "CAMPAIGN_BIDDING_STRATEGY" });
  assert.deepEqual(payload.warnings, []);
});

test("update_ad_group: ROAS alvo em campanha de portfólio é recusado antes de gravar", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS", biddingStrategy: `customers/${CID}/biddingStrategies/55` })] } });
  const result = await call(client, "update_ad_group", { adGroupId: "777", targetRoas: 3 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /portfólio[\s\S]*update_bidding_strategy/);
  assert.equal(calls.writes.length, 0);
});

test("update_ad_group: clearTargetCpa / clearTargetRoas limpam pelo updateMask sem valor; sem override é no-op", async () => {
  const { client, calls } = fakeClient({
    rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS" }, { targetRoas: 3, targetCpaMicros: "40000000" })] },
  });
  await call(client, "update_ad_group", { adGroupId: "777", clearTargetRoas: true, clearTargetCpa: true });
  const op = onlyWrite(calls).operations[0] as { update: Row; updateMask: string };
  assert.deepEqual(op.updateMask.split(",").sort(), ["target_cpa_micros", "target_roas"]);
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/adGroups/777` });

  const none = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS" })] } });
  const r = await call(none.client, "update_ad_group", { adGroupId: "777", clearTargetRoas: true });
  assert.match(textOf(r), /nada a mudar/);
  assert.equal(none.calls.writes.length, 0);
});

test("update_ad_group: ROAS fora da faixa e alvo + clear juntos são recusados; alvo ignorado avisa", async () => {
  for (const args of [{ targetRoas: 0 }, { targetRoas: 1001 }, { targetRoas: 3, clearTargetRoas: true }, { targetCpaMicros: 1_000_000, clearTargetCpa: true }]) {
    const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS" })] } });
    const result = await call(client, "update_ad_group", { adGroupId: "777", ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
  const mcv = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" })] } });
  const r = await call(mcv.client, "update_ad_group", { adGroupId: "777", targetRoas: 3 });
  assert.match(textOf(r), /SEM ROAS alvo/);
  const withTarget = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE", maximizeConversionValue: { targetRoas: 4 } })] } });
  assert.doesNotMatch(textOf(await call(withTarget.client, "update_ad_group", { adGroupId: "777", targetRoas: 3 })), /é ignorado|só vale em/);
});

test("update_ad_group: erro da API vira mensagem com o que foi tentado", async () => {
  const { client } = fakeClient({ rows: { ad_group: [adGroupRow({ biddingStrategyType: "TARGET_ROAS" })] } });
  (client as Row).mutateAdGroups = async () => { throw new Error("Google Ads API: Bidding strategy is not supported."); };
  const result = await call(client, "update_ad_group", { adGroupId: "777", targetRoas: 3 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não aceitou[\s\S]*not supported[\s\S]*"target_roas"/);
});

// ── create_campaign: orçamento total e datas (item 82) ───────────────

test("create_campaign: orçamento total — CUSTOM_PERIOD, total_amount_micros e datas da campanha", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_campaign", {
    name: "Black Friday", channelType: "SEARCH", budgetType: "TOTAL", totalAmountMicros: 3_000_000_000,
    biddingStrategy: "TARGET_ROAS", targetRoas: 5, startDateTime: relDay(5), endDateTime: relDay(20),
  });
  assert.equal(result.isError, undefined, textOf(result));
  const [budgetOp, campaignOp] = onlyWrite(calls).operations;
  const budget = (budgetOp.campaignBudgetOperation as Row).create as Row;
  assert.equal(budget.period, "CUSTOM_PERIOD");
  assert.equal(budget.totalAmountMicros, "3000000000");
  assert.equal(budget.amountMicros, undefined);
  assert.equal(budget.explicitlyShared, false);
  const campaign = (campaignOp.campaignOperation as Row).create as Row;
  assert.equal(campaign.startDateTime, `${relDay(5)} 00:00:00`);
  assert.equal(campaign.endDateTime, `${relDay(20)} 23:59:59`);
  assert.equal(calls.customerReads, 1, "confere as datas no fuso da conta");
  assert.match(textOf(result), /no total \(CUSTOM_PERIOD/);
});

test("create_campaign: orçamento diário com data de fim; sem datas não lê a conta", async () => {
  const flight = fakeClient();
  await call(flight.client, "create_campaign", { name: "Promo", channelType: "SEARCH", dailyBudgetMicros: 50_000_000, endDateTime: relDay(10) });
  const [budgetOp, campaignOp] = onlyWrite(flight.calls).operations;
  assert.equal(((budgetOp.campaignBudgetOperation as Row).create as Row).amountMicros, "50000000");
  assert.equal(((budgetOp.campaignBudgetOperation as Row).create as Row).period, undefined);
  assert.equal(((campaignOp.campaignOperation as Row).create as Row).endDateTime, `${relDay(10)} 23:59:59`);

  const plain = fakeClient();
  await call(plain.client, "create_campaign", { name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 50_000_000 });
  assert.equal(plain.calls.customerReads, 0);
  assert.equal(((plain.calls.writes[0].operations[1].campaignOperation as Row).create as Row).startDateTime, undefined);
});

test("create_campaign: regras de orçamento total e datas recusadas antes de criar qualquer coisa", async () => {
  const base = { name: "BF", channelType: "SEARCH", budgetType: "TOTAL", totalAmountMicros: 3_000_000_000, startDateTime: relDay(5), endDateTime: relDay(20) };
  const cases: Array<[Row, RegExp]> = [
    [{ endDateTime: undefined }, /END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET/],
    [{ channelType: "DISPLAY" }, /não existe para campanhas DISPLAY/],
    [{ channelType: "PERFORMANCE_MAX", biddingStrategy: "TARGET_SPEND" }, /aceitam só/],
    [{ endDateTime: relDay(120) }, /DURATION_TOO_LONG_FOR_TOTAL_BUDGET/],
    [{ totalAmountMicros: undefined }, /exige totalAmountMicros/],
    [{ dailyBudgetMicros: 10_000_000 }, /informe só totalAmountMicros/],
    [{ budgetType: "DAILY", totalAmountMicros: undefined }, /dailyBudgetMicros é obrigatório/],
    [{ endDateTime: relDay(2) }, /precisa ser depois/],
    [{ startDateTime: "05/11/2026" }, /não é data válida/],
  ];
  for (const [args, message] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_campaign", { ...base, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length + calls.customerReads, 0, JSON.stringify(args));
  }
  const past = fakeClient();
  const result = await call(past.client, "create_campaign", { ...base, startDateTime: relDay(-2) });
  assert.match(textOf(result), /já passou/);
  // Com orçamento total o início é obrigatório: a mensagem não sugere omitir startDateTime.
  assert.doesNotMatch(textOf(result), /omit/);
  assert.match(textOf(result), /Orçamento total exige início: use a data de hoje/);
  assert.equal(past.calls.writes.length, 0);

  const pastDaily = fakeClient();
  const daily = await call(pastDaily.client, "create_campaign", { name: "Promo", channelType: "SEARCH", dailyBudgetMicros: 50_000_000, startDateTime: relDay(-1) });
  assert.equal(daily.isError, true);
  assert.match(textOf(daily), /omita startDateTime/);
  assert.equal(pastDaily.calls.writes.length, 0);
});

test("create_campaign: flight com orçamento total começando HOJE (só a data = hoje 00:00:00) é aceito", async () => {
  // campaign.proto: "Set the time component to 00:00:00 for daily granularity" — hoje 00:00:00 é "começa hoje",
  // mesmo que a meia-noite já tenha passado no relógio da conta.
  const today = fakeClient();
  const result = await call(today.client, "create_campaign", {
    name: "Promo relâmpago", channelType: "SEARCH", budgetType: "TOTAL", totalAmountMicros: 3_000_000_000,
    startDateTime: relDay(0), endDateTime: relDay(10),
  });
  assert.equal(result.isError, undefined, textOf(result));
  const [budgetOp, campaignOp] = onlyWrite(today.calls).operations;
  assert.equal(((budgetOp.campaignBudgetOperation as Row).create as Row).period, "CUSTOM_PERIOD");
  assert.equal(((campaignOp.campaignOperation as Row).create as Row).startDateTime, `${relDay(0)} 00:00:00`);

  // Orçamento diário também começa hoje; horário explícito no próprio dia fica com a API.
  const explicit = fakeClient();
  const r2 = await call(explicit.client, "create_campaign", {
    name: "Promo", channelType: "SEARCH", dailyBudgetMicros: 50_000_000, startDateTime: `${relDay(0)} 00:00:01`, endDateTime: relDay(0),
  });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(((onlyWrite(explicit.calls).operations[1].campaignOperation as Row).create as Row).endDateTime, `${relDay(0)} 23:59:59`);

  // Dry-run: valida o flight de hoje sem afirmar criação.
  const dry = fakeClient({ dryRun: true });
  const r3 = await call(dry.client, "create_campaign", {
    name: "Promo", channelType: "SEARCH", budgetType: "TOTAL", totalAmountMicros: 3_000_000_000, startDateTime: relDay(0), endDateTime: relDay(10),
  });
  assert.match(textOf(r3), /DRY-RUN[\s\S]*nada foi criado/);
  assert.equal(dry.calls.writes.length, 1);
});

// ── update_campaign: datas (item 82) ──────────────────────────────────

const campaignWithDates = (start: string, end: string | undefined, period = "DAILY", channel = "SEARCH"): Row => ({
  campaign: {
    id: CAMPAIGN_ID, name: "Promo", status: "ENABLED", advertisingChannelType: channel, biddingStrategyType: "MAXIMIZE_CONVERSIONS",
    maximizeConversions: {}, startDateTime: start, ...(end ? { endDateTime: end } : {}),
  },
  campaignBudget: { period },
});

test("update_campaign: define e limpa a data de fim — updateMask end_date_time", async () => {
  const set = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), undefined)] } });
  const r1 = await call(set.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(15) });
  const op1 = onlyWrite(set.calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op1.updateMask, "end_date_time");
  assert.equal(op1.update.endDateTime, `${relDay(15)} 23:59:59`);
  assert.match(textOf(r1), /1 alteração/);

  const clear = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), rel(15, "23:59:59"))] } });
  await call(clear.client, "update_campaign", { campaignId: CAMPAIGN_ID, clearEndDateTime: true });
  const op2 = onlyWrite(clear.calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op2.updateMask, "end_date_time");
  assert.equal("endDateTime" in op2.update, false, "limpar = caminho no updateMask sem valor");

  const same = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), `${relDay(15)} 23:59:59`)] } });
  assert.match(textOf(await call(same.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(15) })), /nada a mudar/);
  assert.equal(same.calls.writes.length + same.calls.customerReads, 0);
});

test("update_campaign: início de campanha que já começou, fim no passado e fim removido com orçamento total são recusados", async () => {
  const started = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), undefined)] } });
  assert.match(textOf(await call(started.client, "update_campaign", { campaignId: CAMPAIGN_ID, startDateTime: relDay(3) })), /CANNOT_MODIFY_START_DATE_IF_ALREADY_STARTED/);

  const pastEnd = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), undefined)] } });
  assert.match(textOf(await call(pastEnd.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(-2) })), /CANNOT_SET_DATE_TO_PAST/);

  const total = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), rel(15, "23:59:59"), "CUSTOM_PERIOD")] } });
  assert.match(textOf(await call(total.client, "update_campaign", { campaignId: CAMPAIGN_ID, clearEndDateTime: true })), /END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET/);

  const tooLong = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), rel(15, "23:59:59"), "CUSTOM_PERIOD")] } });
  assert.match(textOf(await call(tooLong.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(100) })), /DURATION_TOO_LONG_FOR_TOTAL_BUDGET/);

  const future = fakeClient({ rows: { campaign: [campaignWithDates(rel(5, "00:00:00"), undefined)] } });
  await call(future.client, "update_campaign", { campaignId: CAMPAIGN_ID, startDateTime: relDay(7) });
  assert.equal((onlyWrite(future.calls).operations[0] as { updateMask: string }).updateMask, "start_date_time");

  for (const fake of [started, pastEnd, total, tooLong]) assert.equal(fake.calls.writes.length, 0);

  const both = fakeClient();
  const r = await call(both.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(3), clearEndDateTime: true });
  assert.equal(r.isError, true);
  assert.equal(both.calls.queries.length, 0);
});

test("update_campaign: campanha que ainda não começou — início no passado e fim antes do início atual são recusados; hoje vale", async () => {
  const notStarted = () => fakeClient({ rows: { campaign: [campaignWithDates(rel(5, "00:00:00"), undefined)] } });

  const pastStart = notStarted();
  const r1 = await call(pastStart.client, "update_campaign", { campaignId: CAMPAIGN_ID, startDateTime: relDay(-2) });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /startDateTime .* já passou[\s\S]*CANNOT_SET_DATE_TO_PAST/);
  assert.doesNotMatch(textOf(r1), /já começou/);
  assert.equal(pastStart.calls.writes.length, 0);

  // Fim antes do início ATUAL (o início não muda nesta chamada).
  const endBeforeStart = notStarted();
  const r2 = await call(endBeforeStart.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(3) });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), new RegExp(`o fim \\(${relDay(3)} 23:59:59\\) precisa ser depois do início \\(${relDay(5)} 00:00:00\\)`));
  assert.equal(endBeforeStart.calls.writes.length, 0);

  // Antecipar o início para HOJE (só a data = hoje 00:00:00) é aceito.
  const today = notStarted();
  const r3 = await call(today.client, "update_campaign", { campaignId: CAMPAIGN_ID, startDateTime: relDay(0) });
  assert.equal(r3.isError, undefined, textOf(r3));
  const op = onlyWrite(today.calls).operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "start_date_time");
  assert.equal(op.update.startDateTime, `${relDay(0)} 00:00:00`);

  // Fim com a data de hoje (= 23:59:59) também vale.
  const endToday = fakeClient({ rows: { campaign: [campaignWithDates(rel(-10, "00:00:00"), undefined)] } });
  await call(endToday.client, "update_campaign", { campaignId: CAMPAIGN_ID, endDateTime: relDay(0) });
  assert.equal((onlyWrite(endToday.calls).operations[0] as { update: Row }).update.endDateTime, `${relDay(0)} 23:59:59`);
});

// ── delete_campaign / delete_ad_group ─────────────────────────────────

test("delete_campaign / delete_ad_group: lê antes, não repete remoção e respeita o dry-run", async () => {
  const campaignRow = { campaign: { id: CAMPAIGN_ID, name: "Antiga", status: "PAUSED", advertisingChannelType: "SEARCH" } };
  const ok = fakeClient({ rows: { campaign: [campaignRow] } });
  const r1 = await call(ok.client, "delete_campaign", { campaignId: CAMPAIGN_ID, confirm: true });
  assert.deepEqual(onlyWrite(ok.calls).operations, [{ remove: `customers/${CID}/campaigns/${CAMPAIGN_ID}` }]);
  assert.match(textOf(r1), /"Antiga"[\s\S]*REMOVED \(status antes: PAUSED\)/);

  const already = fakeClient({ rows: { campaign: [{ campaign: { ...campaignRow.campaign, status: "REMOVED" } }] } });
  assert.match(textOf(await call(already.client, "delete_campaign", { campaignId: CAMPAIGN_ID, confirm: true })), /já está removida/);
  assert.equal(already.calls.writes.length, 0);

  const missing = fakeClient();
  assert.equal((await call(missing.client, "delete_campaign", { campaignId: CAMPAIGN_ID, confirm: true })).isError, true);
  assert.equal(missing.calls.writes.length, 0);

  const injected = fakeClient();
  assert.equal((await call(injected.client, "delete_ad_group", { adGroupId: "1 OR 1=1", confirm: true })).isError, true);
  assert.equal(injected.calls.queries.length, 0);

  const unconfirmed = fakeClient({ rows: { campaign: [campaignRow] } });
  assert.equal((await call(unconfirmed.client, "delete_campaign", { campaignId: CAMPAIGN_ID, confirm: false })).isError, true);
  assert.equal(unconfirmed.calls.queries.length + unconfirmed.calls.writes.length, 0);

  const dry = fakeClient({ rows: { ad_group: [{ adGroup: { id: "777", name: "Grupo", status: "ENABLED" }, campaign: { id: CAMPAIGN_ID, name: "C" } }] } });
  const r2 = await call(dry.client, "delete_ad_group", { adGroupId: "777", confirm: true, validateOnly: true });
  assert.match(textOf(r2), /^VALIDATE-ONLY[\s\S]*nada foi removido/);
  assert.doesNotMatch(textOf(r2), /REMOVED \(/);
});

// ── Client real com fetch interceptado: caminhos REST e validate_only ─

function interceptFetch(respond: (url: string, body: Row) => unknown) {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Row;
    sent.push({ url, body });
    return new Response(JSON.stringify(respond(url, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const realClient = () => new GoogleAdsClient({
  credentials: {
    token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token",
    client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z",
  },
  developerToken: "d",
  loginCustomerId: CID,
});

test("de ponta a ponta: sazonalidade vai para biddingSeasonalityAdjustments:mutate com validateOnly", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return {};
    const query = String(body.query);
    if (/FROM customer\b/.test(query)) return [{ results: [{ customer: { id: CID, timeZone: TZ, manager: false } }] }];
    if (/FROM campaign\b/.test(query)) return [{ results: [smartCampaign(CAMPAIGN_ID)] }];
    return [{ results: [] }];
  });
  try {
    const result = await register(realClient()).handlers.get("create_seasonality_adjustment")!({
      customerId: CID, name: "BF", scope: "CAMPAIGN", campaignIds: [CAMPAIGN_ID], startDateTime: rel(10), endDateTime: rel(12),
      conversionRateModifier: 1.5, validateOnly: true,
    });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/biddingSeasonalityAdjustments:mutate`), writes[0].url);
    assert.equal(writes[0].body.validateOnly, true);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
    for (const read of net.sent.filter((s) => s.url.endsWith(":searchStream"))) assertGaqlRules(String(read.body.query));
  } finally {
    net.restore();
  }
});

test("de ponta a ponta: portfólio vai para biddingStrategies:mutate e o vínculo para campaigns:mutate", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return { results: [{ resourceName: `customers/${CID}/biddingStrategies/55` }] };
    const query = String(body.query);
    if (/FROM bidding_strategy\b/.test(query) && /bidding_strategy\.id = 55/.test(query)) return [{ results: [portfolioRow()] }];
    if (/FROM campaign\b/.test(query)) return [{ results: [{ campaign: { id: "1", name: "Moda", status: "ENABLED", biddingStrategyType: "TARGET_ROAS" } }] }];
    return [{ results: [] }];
  });
  try {
    const handlers = register(realClient()).handlers;
    await handlers.get("create_bidding_strategy")!({ customerId: CID, name: "Novo", type: "TARGET_CPA", targetCpaMicros: 40_000_000 });
    await handlers.get("assign_bidding_strategy")!({ customerId: CID, campaignIds: ["1"], biddingStrategyId: "55", confirm: true });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.deepEqual(writes.map((w) => w.url.split("/").pop()), ["biddingStrategies:mutate", "campaigns:mutate"]);
    assert.equal(writes[1].body.partialFailure, true);
    assert.equal(writes[0].body.validateOnly, undefined);
  } finally {
    net.restore();
  }
});
