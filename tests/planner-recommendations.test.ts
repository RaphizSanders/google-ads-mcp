/**
 * Lote planner-recommendations: Planejador de palavras-chave, recomendações,
 * auto-aplicação e histórico de alterações.
 *
 * O client falso valida cada GAQL com os metadados reais da v25 (assertGaqlRules) e
 * registra as ações (customerAction / customerWriteAction) com o corpo enviado, para
 * conferir o payload contra os protos v25 (keyword_plan_idea_service, recommendation_service,
 * recommendation_subscription_service).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { CHANGE_CLIENT_TYPES, OVERRIDE_INPUTS, OVERRIDE_SPECS, parseOverride } from "../src/tools/planner-recommendations.js";
import { assertGaqlRules } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Row) => Promise<Result>;

const CID = "5820067509";
const REC = (id: string) => `customers/${CID}/recommendations/${id}`;

interface FakeOptions {
  search?: (query: string, cid: string) => Row[];
  actions?: Record<string, (body: Row) => Row>;
  dryRun?: boolean;
  children?: Row[];
}

interface ActionCall { cid: string; action: string; body: Row; write: boolean; dryRun: boolean }

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], queryCids: [] as string[], actions: [] as ActionCall[], dryRunClones: 0 };
  const run = (cid: string, action: string, body: Row, write: boolean, dryRun: boolean) => {
    calls.actions.push({ cid, action, body, write, dryRun });
    const handler = opts.actions?.[action];
    return handler ? handler(body) : {};
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true);
    },
    async searchStream(cid: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      calls.queryCids.push(cid);
      assertGaqlRules(query);
      return opts.search?.(query, cid) ?? [];
    },
    async customerAction(cid: string, action: string, body: Row) {
      return run(cid, action, body, false, dryRun);
    },
    async customerWriteAction(cid: string, action: string, body: Row) {
      // igual ao client real: fora dos uploads de conversão, dry-run recusa
      if (dryRun) throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      return run(cid, action, body, true, dryRun);
    },
    async listChildAccounts() {
      return opts.children ?? [];
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function handlersFor(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  registerGoogleAdsTools(
    { registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler) } as never,
    () => client as never,
    allowed,
    hosted
  );
  return handlers;
}

const call = (client: unknown, tool: string, args: Row) =>
  handlersFor(client).get(tool)!({ customerId: CID, ...args });

const obj = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const fromOf = (query: string) => /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
const nothingSent = (calls: { queries: string[]; actions: ActionCall[] }) => calls.queries.length + calls.actions.length === 0;

function jsonAfterHeader(result: Result): unknown {
  const body = textOf(result);
  const start = Math.min(...["{", "["].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  return JSON.parse(body.slice(start));
}

const languageRow = (query: string) => (fromOf(query) === "language_constant" ? [{ languageConstant: { id: "1014", code: "pt" } }] : []);

// ── Guarda de conta ──────────────────────────────────────────────────

test("tools novas respeitam a allowlist antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient();
  const handlers = handlersFor(client, ["1111111111"], true);
  for (const tool of ["get_keyword_historical_metrics", "forecast_search_campaign", "suggest_ad_group_themes",
    "generate_recommendations", "list_recommendation_subscriptions", "set_recommendation_subscription"]) {
    const result = await handlers.get(tool)!({ customerId: CID, keywords: ["x"], adGroupIds: ["1"], types: ["KEYWORD"], status: "PAUSED", advertisingChannelType: "SEARCH" });
    assert.match(textOf(result), /Access denied/, tool);
  }
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");
});

// ── generate_keyword_ideas ───────────────────────────────────────────

test("generate_keyword_ideas: site seed, paginação, faixa de meses e volume mensal", async () => {
  const { client, calls } = fakeClient({
    search: languageRow,
    actions: {
      ":generateKeywordIdeas": () => ({
        results: [{
          text: "tenis corrida",
          closeVariants: ["tênis corrida"],
          keywordIdeaMetrics: {
            avgMonthlySearches: "1000", competition: "HIGH", competitionIndex: "80",
            lowTopOfPageBidMicros: "500000", highTopOfPageBidMicros: "2000000", averageCpcMicros: "900000",
            monthlySearchVolumes: [{ year: "2025", month: "JANUARY", monthlySearches: "900" }, { year: "2025", month: "FEBRUARY" }],
          },
        }],
        nextPageToken: "TOKEN2",
        totalSize: "250",
      }),
    },
  });
  const result = await call(client, "generate_keyword_ideas", {
    siteSeed: "https://www.exemplo.com.br/loja", includeMonthly: true, pageToken: "TOKEN1",
    monthRange: { start: "2025-01", end: "2025-12" }, limit: 100,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const body = calls.actions[0].body;
  assert.equal(calls.actions[0].action, ":generateKeywordIdeas");
  assert.equal(calls.actions[0].write, false);
  assert.deepEqual(body.siteSeed, { site: "www.exemplo.com.br" });
  assert.equal(body.keywordSeed, undefined);
  assert.equal(body.pageToken, "TOKEN1");
  assert.equal(body.pageSize, 100);
  assert.equal(body.language, "languageConstants/1014");
  assert.deepEqual(body.geoTargetConstants, ["geoTargetConstants/2076"]);
  assert.deepEqual(body.historicalMetricsOptions, {
    includeAverageCpc: true,
    yearMonthRange: { start: { year: "2025", month: "JANUARY" }, end: { year: "2025", month: "DECEMBER" } },
  });
  const text = textOf(result);
  assert.match(text, /nextPageToken: TOKEN2/);
  assert.match(text, /Total disponível: 250/);
  const ideas = jsonAfterHeader(result) as Row[];
  assert.deepEqual(ideas[0].monthly_searches, [{ month: "2025-01", searches: 900 }, { month: "2025-02", searches: null }]);
  assert.deepEqual(ideas[0].close_variants, ["tênis corrida"]);

  // table: um mês por coluna
  const table = await call(client, "generate_keyword_ideas", { keywords: ["tenis"], includeMonthly: true, format: "table" });
  assert.match(textOf(table), /2025-01/);
});

test("generate_keyword_ideas: keywords + URL viram keywordAndUrlSeed; sementes inválidas não chamam a API", async () => {
  const { client, calls } = fakeClient({ search: languageRow, actions: { ":generateKeywordIdeas": () => ({ results: [] }) } });
  await call(client, "generate_keyword_ideas", { keywords: ["tenis", "tenis", "bota"], pageUrl: "https://loja.com.br/tenis" });
  assert.deepEqual(calls.actions[0].body.keywordAndUrlSeed, { url: "https://loja.com.br/tenis", keywords: ["tenis", "bota"] });
  assert.match(textOf(await call(client, "generate_keyword_ideas", { keywords: ["x"] })), /Última página/);
  await call(client, "generate_keyword_ideas", { keywords: ["x"], limit: 5000 });
  assert.equal(calls.actions[calls.actions.length - 1].body.pageSize, 1000, "acima de 1000 continua virando 1000, como antes");

  const bad = fakeClient();
  const cases: Array<[Row, RegExp]> = [
    [{ siteSeed: "www.a.com", keywords: ["x"] }, /siteSeed não combina/],
    [{ siteSeed: "não é domínio" }, /siteSeed inválido/],
    [{ keywords: Array.from({ length: 21 }, (_, i) => `kw ${i}`) }, /no máximo 20/],
    [{ keywords: ["x"], geoTargetIds: Array.from({ length: 11 }, (_, i) => String(1000 + i)) }, /no máximo 10 localizações/],
    [{ keywords: ["x"], geoTargetIds: ["Brasil"] }, /geoTargetIds inválidos/],
    [{ keywords: ["x"], monthRange: { start: "2025-13", end: "2025-12" } }, /monthRange.start inválido/],
    [{ keywords: ["x"], monthRange: { start: "2025-06", end: "2025-01" } }, /depois de end/],
    [{ pageUrl: "tenis de corrida" }, /pageUrl inválida/],
    [{ pageUrl: "ftp://loja.com.br/tenis" }, /pageUrl inválida/],
    [{ pageUrl: "tenis" }, /pageUrl inválida/],
    [{ keywords: ["x"], limit: 0 }, /limit inválido/],
    [{}, /Informe keywords/],
  ];
  for (const [args, pattern] of cases) {
    const result = await call(bad.client, "generate_keyword_ideas", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
  }
  assert.ok(nothingSent(bad.calls), "nada pode ser enviado à API");
});

test("generate_keyword_ideas: pageUrl sem http(s):// continua aceita e vai para a API como veio (exemplo do proto)", async () => {
  // keyword_plan_idea_service.proto: "A specific url to generate ideas from, for example, www.example.com/cars."
  const { client, calls } = fakeClient({ search: languageRow, actions: { ":generateKeywordIdeas": () => ({ results: [] }) } });
  const alone = await call(client, "generate_keyword_ideas", { pageUrl: "www.example.com/cars" });
  assert.equal(alone.isError, undefined, textOf(alone));
  assert.deepEqual(calls.actions[0].body.urlSeed, { url: "www.example.com/cars" });
  const withKeywords = await call(client, "generate_keyword_ideas", { pageUrl: "loja.com.br/produto?id=1", keywords: ["tenis"] });
  assert.equal(withKeywords.isError, undefined, textOf(withKeywords));
  assert.deepEqual(calls.actions[1].body.keywordAndUrlSeed, { url: "loja.com.br/produto?id=1", keywords: ["tenis"] });
  const accented = await call(client, "generate_keyword_ideas", { pageUrl: "https://www.pão.com.br:8080/p" });
  assert.equal(accented.isError, undefined, textOf(accented));
  assert.equal(calls.actions.length, 3);
});

test("generate_keyword_ideas: erro da API vira mensagem em PT-BR com dica", async () => {
  const { client } = fakeClient({
    search: languageRow,
    actions: { ":generateKeywordIdeas": () => { throw new Error("Google Ads API: Request contains an invalid argument. — URL crawl failed"); } },
  });
  const result = await call(client, "generate_keyword_ideas", { pageUrl: "https://naoexiste.com.br" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Erro da API ao gerar ideias.*\n.*Dica: O Google não conseguiu ler a URL/s);
});

// ── get_keyword_historical_metrics ───────────────────────────────────

test("get_keyword_historical_metrics: payload v25, variantes, keywords sem linha e dispositivos", async () => {
  const { client, calls } = fakeClient({
    search: languageRow,
    actions: {
      ":generateKeywordHistoricalMetrics": () => ({
        results: [
          { text: "carro", closeVariants: ["carros"], keywordMetrics: {
            avgMonthlySearches: "5000", competition: "MEDIUM",
            monthlySearchVolumes: [{ year: "2024", month: "DECEMBER", monthlySearches: "7000" }],
          } },
          { text: "moto eletrica", keywordMetrics: {} },
        ],
        aggregateMetricResults: { deviceSearches: [{ device: "MOBILE", searchCount: "4000" }] },
      }),
    },
  });
  const result = await call(client, "get_keyword_historical_metrics", {
    keywords: ["carro", "carros", "moto eletrica", "bicicleta", "carro"], geoTargetIds: ["1001773"], languageCode: "pt",
    network: "GOOGLE_SEARCH_AND_PARTNERS", includeDeviceBreakdown: true, monthRange: { start: "2023-01", end: "2024-12" },
  });
  assert.equal(result.isError, undefined, textOf(result));
  const body = calls.actions[0].body;
  assert.deepEqual(body.keywords, ["carro", "carros", "moto eletrica", "bicicleta"]);
  assert.deepEqual(body.geoTargetConstants, ["geoTargetConstants/1001773"]);
  assert.equal(body.keywordPlanNetwork, "GOOGLE_SEARCH_AND_PARTNERS");
  assert.deepEqual(body.aggregateMetrics, { aggregateMetricTypes: ["DEVICE"] });
  assert.deepEqual((body.historicalMetricsOptions as Row).yearMonthRange, {
    start: { year: "2023", month: "JANUARY" }, end: { year: "2024", month: "DECEMBER" },
  });
  const out = jsonAfterHeader(result) as { keywords: Row[]; not_returned: string[]; device_searches: Row[] };
  assert.deepEqual(out.not_returned, ["bicicleta"]);
  assert.equal(out.keywords[1].avg_monthly_searches, null, "sem dado é null, não 0");
  assert.deepEqual(out.keywords[0].monthly_searches, [{ month: "2024-12", searches: 7000 }]);
  assert.deepEqual(out.device_searches, [{ device: "MOBILE", searches: 4000 }]);
  assert.match(textOf(result), /Sem linha própria.*bicicleta/);

  const csv = await call(client, "get_keyword_historical_metrics", { keywords: ["carro"], format: "csv" });
  assert.match(textOf(csv).split("\n")[0], /2024-12/);
});

test("get_keyword_historical_metrics: lista vazia ou acima de 10.000 é recusada sem chamar a API", async () => {
  const { client, calls } = fakeClient();
  assert.match(textOf(await call(client, "get_keyword_historical_metrics", { keywords: [] })), /ao menos uma keyword/);
  const many = Array.from({ length: 10_001 }, (_, i) => `kw${i}`);
  assert.match(textOf(await call(client, "get_keyword_historical_metrics", { keywords: many })), /no máximo 10000/);
  assert.match(textOf(await call(client, "get_keyword_historical_metrics", { keywords: ["x"], languageCode: "português!" })), /languageCode inválido/);
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");
});

// ── forecast_search_campaign ─────────────────────────────────────────

const tomorrowPlus = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("forecast_search_campaign: payload v24+ com Maximizar cliques, período e métricas por dia", async () => {
  const { client, calls } = fakeClient({
    search: languageRow,
    actions: {
      ":generateKeywordForecastMetrics": () => ({
        campaignForecastMetrics: { clicks: 300, costMicros: "900000000", averageCpcMicros: "3000000" },
      }),
    },
  });
  const since = tomorrowPlus(1);
  const until = tomorrowPlus(30);
  const result = await call(client, "forecast_search_campaign", {
    keywords: ["advogado trabalhista", { text: "advogado trabalhista sp", matchType: "PHRASE" }],
    dailyBudgetMicros: 30_000_000, maxCpcBidMicros: 5_000_000, period: { since, until }, geoTargetIds: ["1001773"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const body = calls.actions[0].body as { forecastPeriod: Row; campaign: Row };
  assert.equal(calls.actions[0].action, ":generateKeywordForecastMetrics");
  assert.deepEqual(body.forecastPeriod, { startDate: since, endDate: until });
  assert.deepEqual(body.campaign, {
    languageConstants: ["languageConstants/1014"],
    geoTargetConstants: ["geoTargetConstants/1001773"],
    biddingStrategy: { maximizeClicksBiddingStrategy: { dailyTargetSpendMicros: "30000000", maxCpcBidCeilingMicros: "5000000" } },
    adGroups: [{ keywords: [{ text: "advogado trabalhista", matchType: "BROAD" }, { text: "advogado trabalhista sp", matchType: "PHRASE" }] }],
  });
  const [row] = jsonAfterHeader(result) as Row[];
  assert.equal(row.clicks, 300);
  assert.equal(row.cost, 900);
  assert.equal(row.average_cpc, 3);
  assert.equal(row.conversions, null, "Maximizar cliques não prevê conversões");
  assert.equal(row.period_days, 30);
  assert.equal(row.cost_per_day, 30);
});

test("forecast_search_campaign: cenários comparados, CPC manual e Max. conversões; um erro não derruba os outros", async () => {
  let n = 0;
  const { client, calls } = fakeClient({
    search: languageRow,
    actions: {
      ":generateKeywordForecastMetrics": () => {
        n++;
        if (n === 2) throw new Error("Google Ads API: The daily target spend micros is too low. — RESOURCE_EXHAUSTED quota");
        return { campaignForecastMetrics: { conversions: 12.5, costMicros: "1400000000", averageCpaMicros: "112000000" } };
      },
    },
  });
  const result = await call(client, "forecast_search_campaign", {
    adGroups: [{ keywords: ["seguro auto"] }, { keywords: [{ text: "seguro carro", matchType: "EXACT" }] }],
    scenarios: [
      { label: "conv 200", bidding: "MAXIMIZE_CONVERSIONS", dailyBudgetMicros: 200_000_000 },
      { label: "manual", bidding: "MANUAL_CPC", maxCpcBidMicros: 4_000_000 },
    ],
  });
  assert.equal(calls.actions.length, 2);
  assert.deepEqual((calls.actions[0].body.campaign as Row).biddingStrategy, { maximizeConversionsBiddingStrategy: { dailyTargetSpendMicros: "200000000" } });
  assert.deepEqual((calls.actions[1].body.campaign as Row).biddingStrategy, { manualCpcBiddingStrategy: { maxCpcBidMicros: "4000000" } });
  assert.equal(((calls.actions[0].body.campaign as Row).adGroups as Row[]).length, 2);
  assert.equal(calls.actions[0].body.forecastPeriod, undefined, "sem period, vale o default da API");
  assert.equal(result.isError, undefined);
  const rows = jsonAfterHeader(result) as Row[];
  assert.equal(rows[0].conversions, 12.5);
  assert.equal(rows[0].average_cpa, 112);
  assert.equal(rows[0].clicks, null);
  assert.equal(rows[0].period_days, 7);
  assert.match(String(rows[1].error), /too low.*Dica/);
  assert.match(textOf(result), /1 cenário\(s\) com erro/);
});

test("forecast_search_campaign: lances, orçamento, keywords e período inválidos não chamam a API", async () => {
  const { client, calls } = fakeClient();
  const cases: Array<[Row, RegExp]> = [
    [{ keywords: ["x"] }, /dailyBudgetMicros é obrigatório/],
    [{ keywords: ["x"], dailyBudgetMicros: 50 }, /parece estar em reais/],
    [{ keywords: ["x"], bidding: "MANUAL_CPC" }, /maxCpcBidMicros é obrigatório/],
    [{ keywords: ["x"], bidding: "MANUAL_CPC", maxCpcBidMicros: 10_000 }, /parece estar em reais/],
    [{ keywords: ["x"], bidding: "MAXIMIZE_CONVERSIONS", dailyBudgetMicros: 50_000_000, maxCpcBidMicros: 2_000_000 }, /não aceita maxCpcBidMicros/],
    [{ keywords: ["um dois tres quatro cinco seis sete oito nove dez onze"], dailyBudgetMicros: 50_000_000 }, /passa de 10 palavras/],
    [{ keywords: [{ text: "x", matchType: "BROADISH" }], dailyBudgetMicros: 50_000_000 }, /matchType inválido/],
    [{ adGroups: [{ keywords: [] }], dailyBudgetMicros: 50_000_000 }, /precisa de ao menos uma keyword/],
    [{ keywords: ["x"], adGroups: [{ keywords: ["y"] }], dailyBudgetMicros: 50_000_000 }, /adGroups OU keywords/],
    [{ keywords: ["x"], dailyBudgetMicros: 50_000_000, period: { since: "2020-01-01", until: "2020-01-31" } }, /precisa ser uma data futura/],
    [{ keywords: ["x"], dailyBudgetMicros: 50_000_000, period: { since: tomorrowPlus(2), until: tomorrowPlus(400) } }, /passa de 1 ano/],
    [{ keywords: ["x"], dailyBudgetMicros: 50_000_000, scenarios: Array.from({ length: 6 }, () => ({})) }, /No máximo 5 cenários/],
    [{}, /Informe as keywords/],
  ];
  for (const [args, pattern] of cases) {
    const result = await call(client, "forecast_search_campaign", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern, JSON.stringify(args));
  }
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");
});

// ── suggest_ad_group_themes ──────────────────────────────────────────

test("suggest_ad_group_themes: confere os grupos na conta e nomeia as sugestões", async () => {
  const { client, calls } = fakeClient({
    search: (query) => (fromOf(query) === "ad_group"
      ? [
          { adGroup: { id: "11", name: "Trabalhista", resourceName: `customers/${CID}/adGroups/11` }, campaign: { id: "1", name: "Pesquisa" } },
          { adGroup: { id: "12", name: "Família", resourceName: `customers/${CID}/adGroups/12` }, campaign: { id: "1", name: "Pesquisa" } },
        ]
      : []),
    actions: {
      ":generateAdGroupThemes": () => ({
        adGroupKeywordSuggestions: [
          { keywordText: "advogado demissão", suggestedKeywordText: "advogado demissao", suggestedMatchType: "PHRASE",
            suggestedAdGroup: `customers/${CID}/adGroups/11`, suggestedCampaign: `customers/${CID}/campaigns/1` },
          { keywordText: "receita de bolo" },
        ],
        unusableAdGroups: [{ adGroup: `customers/${CID}/adGroups/12`, campaign: `customers/${CID}/campaigns/1` }],
      }),
    },
  });
  const result = await call(client, "suggest_ad_group_themes", { keywords: ["advogado demissão", "receita de bolo"], adGroupIds: ["11", "12"] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(calls.queries[0], /ad_group\.id IN \(11, 12\)/);
  assert.deepEqual(calls.actions[0].body, {
    keywords: ["advogado demissão", "receita de bolo"],
    adGroups: [`customers/${CID}/adGroups/11`, `customers/${CID}/adGroups/12`],
  });
  const out = jsonAfterHeader(result) as { suggestions: Row[]; unusable_ad_groups: Row[] };
  assert.equal(out.suggestions[0].ad_group, "Trabalhista");
  assert.equal(out.suggestions[0].campaign, "Pesquisa");
  assert.equal(out.suggestions[1].ad_group, "(nenhum grupo sugerido)");
  assert.equal(out.unusable_ad_groups[0].ad_group, "Família");

  const missing = fakeClient({ search: () => [] });
  const refused = await call(missing.client, "suggest_ad_group_themes", { keywords: ["x"], adGroupIds: ["99"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /não encontrados nesta conta.*99/);
  assert.equal(missing.calls.actions.length, 0);
  const invalid = await call(missing.client, "suggest_ad_group_themes", { keywords: ["x"], adGroupIds: ["1 OR 1=1"] });
  assert.match(textOf(invalid), /adGroupIds inválidos/);
});

// ── list_recommendations ─────────────────────────────────────────────

const budgetRec = (id: string) => ({
  recommendation: {
    resourceName: REC(id),
    type: "CAMPAIGN_BUDGET",
    campaignBudget: `customers/${CID}/campaignBudgets/77`,
    campaigns: [`customers/${CID}/campaigns/1`, `customers/${CID}/campaigns/2`],
    campaignBudgetRecommendation: {
      currentBudgetAmountMicros: "50000000",
      recommendedBudgetAmountMicros: "90000000",
      budgetOptions: [{ budgetAmountMicros: "70000000", impact: { potentialMetrics: { clicks: 120, costMicros: "480000000" } } }],
    },
    impact: { baseMetrics: { clicks: 100 }, potentialMetrics: { clicks: 150 } },
  },
  campaignBudget: { name: "Orçamento compartilhado" },
});

test("list_recommendations: com campanha, busca também recommendation.campaigns e mostra o valor recomendado", async () => {
  const { client, calls } = fakeClient({
    search: (query) => {
      if (fromOf(query) === "campaign") {
        return [
          { campaign: { resourceName: `customers/${CID}/campaigns/1`, name: "Pesquisa Marca" } },
          { campaign: { resourceName: `customers/${CID}/campaigns/2`, name: "Pesquisa Genérica" } },
        ];
      }
      if (/CONTAINS ANY/.test(query)) return [budgetRec("B1")];
      return [
        { recommendation: { resourceName: REC("K1"), type: "KEYWORD", campaign: `customers/${CID}/campaigns/1`,
          keywordRecommendation: { keyword: { text: "tenis", matchType: "PHRASE" }, recommendedCpcBidMicros: "1500000" } },
          campaign: { name: "Pesquisa Marca" } },
        budgetRec("B1"),
      ];
    },
  });
  const result = await call(client, "list_recommendations", { campaignId: "1", types: ["CAMPAIGN_BUDGET", "KEYWORD"] });
  assert.equal(result.isError, undefined, textOf(result));
  const recQueries = calls.queries.filter((q) => fromOf(q) === "recommendation");
  assert.equal(recQueries.length, 2);
  assert.match(recQueries[0], new RegExp(`recommendation\\.campaign = 'customers/${CID}/campaigns/1'`));
  assert.match(recQueries[1], new RegExp(`recommendation\\.campaigns CONTAINS ANY \\('customers/${CID}/campaigns/1'\\)`));
  for (const q of recQueries) {
    assert.match(q, /recommendation\.type IN \('CAMPAIGN_BUDGET', 'KEYWORD'\)/);
    assert.match(q, /recommendation\.campaign_budget_recommendation/);
  }
  const rows = jsonAfterHeader(result) as Row[];
  assert.equal(rows.length, 2, "a de orçamento veio nas duas consultas e aparece uma vez");
  const budget = rows.find((r) => r.type === "CAMPAIGN_BUDGET")!;
  assert.equal(budget.campaign, "orçamento Orçamento compartilhado — campanhas: Pesquisa Marca, Pesquisa Genérica");
  assert.deepEqual(budget.details, {
    current_budget: 50, recommended_budget: 90,
    options: [{ budget: 70, potential_clicks: 120, potential_conversions: 0, potential_cost: 480 }],
  });
  const keyword = rows.find((r) => r.type === "KEYWORD")!;
  assert.deepEqual(keyword.details, { keyword: "tenis [PHRASE]", recommended_cpc_bid: 1.5, search_terms: [] });

  const table = await call(client, "list_recommendations", { campaignId: "1", format: "table" });
  assert.match(textOf(table), /current_budget=50; recommended_budget=90/);
});

test("list_recommendations: tipo ou campanha inválidos são recusados antes da consulta", async () => {
  const { client, calls } = fakeClient();
  assert.match(textOf(await call(client, "list_recommendations", { types: ["BUDGET"] })), /Tipos de recomendação inválidos: BUDGET/);
  assert.match(textOf(await call(client, "list_recommendations", { campaignId: "1' OR '1'='1" })), /campaignId inválido/);
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");
  await call(client, "list_recommendations", {});
  assert.equal(calls.queries.length, 1, "sem campanha, uma consulta só");
  assert.doesNotMatch(calls.queries[0], /WHERE/);
});

// ── apply_recommendation ─────────────────────────────────────────────

const cpaRec = (id: string) => ({
  recommendation: { resourceName: REC(id), type: "TARGET_CPA_OPT_IN", campaign: `customers/${CID}/campaigns/1`,
    targetCpaOptInRecommendation: { recommendedTargetCpaMicros: "45000000" } },
  campaign: { name: "Pesquisa Marca" },
});

function recommendationSearch(rows: Row[], dismissedRows: Row[] = []) {
  return (query: string) => {
    if (fromOf(query) === "ad_group") return /IN \(55\)/.test(query) ? [{ adGroup: { id: "55", status: "ENABLED" } }] : [];
    if (fromOf(query) !== "recommendation") return [];
    const pool = /dismissed = TRUE/.test(query) ? dismissedRows : rows;
    return pool.filter((r) => query.includes(String((r.recommendation as Row).resourceName)));
  };
}

test("apply_recommendation: override de orçamento vai em apply_parameters e o relatório mostra antes/depois", async () => {
  const { client, calls } = fakeClient({
    search: recommendationSearch([budgetRec("B1"), cpaRec("C1")]),
    actions: { "recommendations:apply": (body) => ({ results: (body.operations as Row[]).map((op) => ({ resourceName: op.resourceName })) }) },
  });
  const result = await call(client, "apply_recommendation", {
    confirm: true,
    applications: [
      { resourceName: REC("B1"), overrides: { campaignBudget: { newBudgetAmountMicros: 80_000_000 } } },
      { resourceName: REC("C1"), overrides: { targetCpaOptIn: { targetCpaMicros: 40_000_000 } } },
    ],
  });
  assert.equal(result.isError, false, textOf(result));
  const write = calls.actions.find((a) => a.write)!;
  assert.equal(write.action, "recommendations:apply");
  assert.deepEqual(write.body, {
    operations: [
      { resourceName: REC("B1"), campaignBudget: { newBudgetAmountMicros: "80000000" } },
      { resourceName: REC("C1"), targetCpaOptIn: { targetCpaMicros: "40000000" } },
    ],
    partialFailure: true,
  });
  const report = jsonAfterHeader(result) as Row[];
  assert.equal(report[0].status, "aplicada");
  assert.equal((report[0].google_recommended as Row).recommended_budget, 90);
  assert.deepEqual(report[0].applied_with, { campaignBudget: { newBudgetAmountMicros: 80_000_000 } });
  assert.equal((report[1].google_recommended as Row).recommended_target_cpa, 45);
  assert.match(textOf(result), /^2\/2 recomendação\(ões\) aplicada\(s\)/);
});

test("apply_recommendation: sem override aplica com os valores do Google (compatível com resourceNames)", async () => {
  const { client, calls } = fakeClient({
    search: recommendationSearch([cpaRec("C1")]),
    actions: { "recommendations:apply": () => ({ results: [{ resourceName: REC("C1") }] }) },
  });
  const result = await call(client, "apply_recommendation", { confirm: true, resourceNames: [REC("C1")] });
  assert.equal(result.isError, false);
  assert.deepEqual(calls.actions[0].body.operations, [{ resourceName: REC("C1") }]);
  assert.equal((jsonAfterHeader(result) as Row[])[0].applied_with, "valores do Google");
});

test("apply_recommendation: override de outro tipo, inexistente ou valor em reais não gravam nada", async () => {
  const setup = () => fakeClient({ search: recommendationSearch([budgetRec("B1"), cpaRec("C1")]) });

  const mismatch = setup();
  const r1 = await call(mismatch.client, "apply_recommendation", {
    confirm: true, applications: [{ resourceName: REC("C1"), overrides: { campaignBudget: { newBudgetAmountMicros: 80_000_000 } } }],
  });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /override "campaignBudget" vale para CAMPAIGN_BUDGET, mas esta recomendação é TARGET_CPA_OPT_IN/);
  assert.equal(mismatch.calls.actions.length, 0);

  const missing = setup();
  const r2 = await call(missing.client, "apply_recommendation", { confirm: true, resourceNames: [REC("SUMIU")] });
  assert.match(textOf(r2), /não encontrada nesta conta/);
  assert.equal(missing.calls.actions.length, 0);
  assert.ok(missing.calls.queries.some((q) => /recommendation\.dismissed = TRUE/.test(q)), "procura também entre as dispensadas");

  const local = setup();
  const localCases: Array<[Row, RegExp]> = [
    [{ applications: [{ resourceName: REC("B1"), overrides: { campaignBudget: { newBudgetAmountMicros: 80 } } }] }, /parece estar em reais/],
    [{ applications: [{ resourceName: REC("B1"), overrides: { campaignBudget: { newBudgetAmountMicros: 80_000_000 }, targetCpaOptIn: { targetCpaMicros: 1_000_000 } } }] }, /um parâmetro por recomendação/],
    [{ applications: [{ resourceName: REC("B1"), overrides: { setTargetRoas: { targetRoas: 4000 } } }] }, /entre 0.01 e 1000/],
    [{ applications: [{ resourceName: REC("B1"), overrides: { raiseTargetCpaBidTooLow: { targetMultiplier: 0.8 } } }] }, /maior que 1.0/],
    [{ applications: [{ resourceName: REC("B1"), overrides: { keyword: { matchType: "EXACT" } } }] }, /adGroupId \(numérico\) é obrigatório/],
    [{ applications: [{ resourceName: REC("B1"), overrides: { textAd: {} } }] }, /override "textAd" não suportado/],
    [{ resourceNames: ["customers/1111111111/recommendations/X"] }, /é da conta 1111111111/],
    [{ resourceNames: [REC("B1"), REC("B1")] }, /repetido/],
    [{ resourceNames: ["recomendacao-1"] }, /não é um resourceName de recomendação/],
    [{ resourceNames: [] }, /Informe ao menos um resourceName/],
    [{ resourceNames: Array.from({ length: 101 }, (_, i) => REC(String(i))) }, /no máximo 100/],
  ];
  for (const [args, pattern] of localCases) {
    const result = await call(local.client, "apply_recommendation", { confirm: true, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
  }
  assert.ok(nothingSent(local.calls), "nada pode ser enviado à API");
});

test("apply_recommendation: confirm, dry-run e override de keyword com grupo inexistente", async () => {
  const { client, calls } = fakeClient({ search: recommendationSearch([budgetRec("B1")]) });
  const noConfirm = await call(client, "apply_recommendation", { confirm: false, resourceNames: [REC("B1")] });
  assert.match(textOf(noConfirm), /Envie confirm: true/);
  const dry = await call(client, "apply_recommendation", {
    confirm: true, validateOnly: true,
    applications: [{ resourceName: REC("B1"), overrides: { campaignBudget: { newBudgetAmountMicros: 80_000_000 } } }],
  });
  assert.equal(dry.isError, true);
  assert.match(textOf(dry), /^VALIDATE-ONLY/);
  assert.match(textOf(dry), /mutação bloqueada em dry-run/);
  assert.match(textOf(dry), /"newBudgetAmountMicros": "80000000"/, "mostra o que seria enviado");
  assert.ok(nothingSent(calls), "dry-run não lê nem grava");

  const kw = fakeClient({
    search: recommendationSearch([{ recommendation: { resourceName: REC("K1"), type: "KEYWORD" } }]),
    actions: { "recommendations:apply": () => ({ results: [{ resourceName: REC("K1") }] }) },
  });
  const noGroup = await call(kw.client, "apply_recommendation", {
    confirm: true, applications: [{ resourceName: REC("K1"), overrides: { keyword: { adGroupId: "56", matchType: "EXACT" } } }],
  });
  assert.match(textOf(noGroup), /grupo de anúncios 56 não encontrado/);
  assert.equal(kw.calls.actions.length, 0);
  const ok = await call(kw.client, "apply_recommendation", {
    confirm: true, applications: [{ resourceName: REC("K1"), overrides: { keyword: { adGroupId: "55", matchType: "EXACT", cpcBidMicros: 2_000_000 } } }],
  });
  assert.equal(ok.isError, false, textOf(ok));
  assert.deepEqual((kw.calls.actions[0].body.operations as Row[])[0], {
    resourceName: REC("K1"), keyword: { adGroup: `customers/${CID}/adGroups/55`, matchType: "EXACT", cpcBidMicros: "2000000" },
  });
});

test("apply_recommendation: dispensada é achada na segunda leitura; falha parcial é relatada por item", async () => {
  const partialFailureError = {
    message: "Multiple errors",
    details: [{ errors: [{
      message: "The recommendation is no longer valid.",
      errorCode: { recommendationError: "RECOMMENDATION_INVALIDATED" },
      location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
    }] }],
  };
  const { client, calls } = fakeClient({
    search: recommendationSearch([budgetRec("B1")], [cpaRec("C1")]),
    actions: { "recommendations:apply": () => ({ results: [{ resourceName: REC("B1") }, {}], partialFailureError }) },
  });
  const result = await call(client, "apply_recommendation", { confirm: true, resourceNames: [REC("B1"), REC("C1")] });
  assert.equal(calls.actions.length, 1);
  assert.equal(result.isError, true);
  const report = jsonAfterHeader(result) as Row[];
  assert.equal(report[0].status, "aplicada");
  assert.equal(report[1].status, "falhou");
  assert.match(String((report[1].errors as string[])[0]), /no longer valid\. \[recommendationError\.RECOMMENDATION_INVALIDATED\]/);
  assert.match(textOf(result), /^1\/2/);
});

/**
 * Chama a tool pelo servidor MCP de verdade (createMcpServer + InMemoryTransport): passa
 * pelo schema zod que o SDK aplica e pelo wrapper de validateOnly, ao contrário de `call`,
 * que chama o handler direto e não vê o que o schema descarta.
 */
async function viaMcp(fake: unknown, tool: string, args: Row): Promise<{ isError: boolean; text: string }> {
  const server = createMcpServer({ getClient: () => fake as never, readOnly: false });
  const client = new Client({ name: "planner-recommendations-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = (await client.callTool({ name: tool, arguments: { customerId: CID, ...args } })) as Result;
    return { isError: result.isError === true, text: textOf(result) };
  } catch (err) {
    // versão do SDK que rejeita o input com exceção em vez de isError: também é recusa
    return { isError: true, text: (err as Error).message };
  } finally {
    await client.close();
    await server.close();
  }
}

test("apply_recommendation pelo servidor MCP: chave desconhecida em applications/overrides recusa sem gravar", async () => {
  const setup = () => fakeClient({
    search: recommendationSearch([budgetRec("B1"), { recommendation: { resourceName: REC("K1"), type: "KEYWORD" } }]),
    actions: { "recommendations:apply": (body) => ({ results: (body.operations as Row[]).map((op) => ({ resourceName: op.resourceName })) }) },
  });
  const budget = { campaignBudget: { newBudgetAmountMicros: 50_000_000 } };
  const cases: Array<[string, Row, RegExp]> = [
    ["snake_case do proto", { applications: [{ resourceName: REC("B1"), overrides: { campaign_budget: { new_budget_amount_micros: 50_000_000 } } }] },
      /overrides: campo\(s\) não reconhecido\(s\): campaign_budget/],
    ["parâmetro de anúncio/asset", { applications: [{ resourceName: REC("B1"), overrides: { textAd: {} } }] }, /não reconhecido\(s\): textAd/],
    ["override no singular", { applications: [{ resourceName: REC("B1"), override: budget }] }, /não reconhecido\(s\): override\b/],
    ["campo desconhecido dentro do override", {
      applications: [{ resourceName: REC("K1"), overrides: { keyword: { adGroupId: "55", matchType: "EXACT", cpc_bid_micros: 2_000_000 } } }],
    }, /overrides\.keyword: campo\(s\) não reconhecido\(s\): cpc_bid_micros/],
    ["overrides no nível de cima", { resourceNames: [REC("B1")], overrides: budget }, /overrides vai dentro de cada item de applications/],
    ["applications em texto JSON (flexArray não valida os itens)", {
      applications: JSON.stringify([{ resourceName: REC("B1"), overrides: { campaign_budget: { new_budget_amount_micros: 50_000_000 } } }]),
    }, /override "campaign_budget" não suportado/],
    ["texto JSON com override no singular", { applications: JSON.stringify([{ resourceName: REC("B1"), override: budget }]) },
      /applications\[0\] \(customers\/\d+\/recommendations\/B1\): campo\(s\) não reconhecido\(s\): override/],
    ["texto JSON com campo desconhecido dentro do override", {
      applications: JSON.stringify([{ resourceName: REC("B1"), overrides: { campaignBudget: { new_budget_amount_micros: 50_000_000 } } }]),
    }, /campaignBudget: campo\(s\) não reconhecido\(s\): new_budget_amount_micros/],
    ["overrides vazio", { applications: [{ resourceName: REC("B1"), overrides: {} }] }, /overrides vazio/],
  ];
  for (const [label, args, pattern] of cases) {
    const { client, calls } = setup();
    const result = await viaMcp(client, "apply_recommendation", { confirm: true, ...args });
    assert.equal(result.isError, true, `${label}: ${result.text}`);
    assert.match(result.text, pattern, label);
    assert.equal(calls.actions.length, 0, `${label}: nada pode ser gravado`);
  }

  // controle: pelo mesmo caminho, com o nome certo, grava o valor do usuário (não o do Google)
  const { client, calls } = setup();
  const ok = await viaMcp(client, "apply_recommendation", { confirm: true, applications: [{ resourceName: REC("B1"), overrides: budget }] });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(calls.actions[0].body, {
    operations: [{ resourceName: REC("B1"), campaignBudget: { newBudgetAmountMicros: "50000000" } }],
    partialFailure: true,
  });
  assert.doesNotMatch(ok.text, /valores do Google/);
  const plain = setup();
  const google = await viaMcp(plain.client, "apply_recommendation", { confirm: true, resourceNames: [REC("B1")] });
  assert.equal(google.isError, false, google.text);
  assert.deepEqual(plain.calls.actions[0].body.operations, [{ resourceName: REC("B1") }], "sem overrides continua valendo o do Google");
});

test("apply_recommendation: parseOverride confere cada campo e os overrides batem com os parâmetros suportados", () => {
  assert.deepEqual(Object.keys(OVERRIDE_INPUTS).sort(), Object.keys(OVERRIDE_SPECS).sort());
  assert.deepEqual(parseOverride(undefined), {});
  assert.deepEqual(parseOverride(null), {});
  assert.match(String(parseOverride({}).error), /overrides vazio/);
  assert.match(String(parseOverride("campaignBudget").error), /precisa ser um objeto/);
  assert.match(String(parseOverride({ campaignBudget: 50_000_000 }).error), /campaignBudget: precisa ser um objeto/);
  assert.match(String(parseOverride({ setTargetRoas: { targetRoas: 4, target_roas: 5 } }).error), /setTargetRoas: campo\(s\) não reconhecido\(s\): target_roas/);
  assert.deepEqual(parseOverride({ setTargetRoas: { targetRoas: 4 } }), { key: "setTargetRoas", params: { targetRoas: 4 } });
});

test("apply_recommendation: erro da API inteiro vira mensagem com dica", async () => {
  const { client } = fakeClient({
    search: recommendationSearch([budgetRec("B1")]),
    actions: { "recommendations:apply": () => { throw new Error("Google Ads API: Budget amount too small."); } },
  });
  const result = await call(client, "apply_recommendation", {
    confirm: true, applications: [{ resourceName: REC("B1"), overrides: { campaignBudget: { newBudgetAmountMicros: 2_000_000 } } }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Erro da API ao aplicar recomendações.*\nDica: O orçamento ficou abaixo do mínimo/s);
});

// ── dismiss_recommendation ───────────────────────────────────────────

test("dismiss_recommendation: pula as já dispensadas, recusa as inexistentes e relata por item", async () => {
  const dismissed = { recommendation: { resourceName: REC("D1"), type: "KEYWORD", dismissed: true } };
  const { client, calls } = fakeClient({
    search: recommendationSearch([budgetRec("B1"), dismissed]),
    actions: { "recommendations:dismiss": (body) => ({ results: (body.operations as Row[]).map((op) => ({ resourceName: op.resourceName })) }) },
  });
  const result = await call(client, "dismiss_recommendation", { resourceNames: [REC("B1"), REC("D1"), REC("X9")] });
  const write = calls.actions.find((a) => a.write)!;
  assert.deepEqual(write.body, { operations: [{ resourceName: REC("B1") }], partialFailure: true });
  assert.equal(result.isError, true, "uma não existia");
  assert.match(textOf(result), /1\/1 recomendação\(ões\) dispensada\(s\)/);
  assert.match(textOf(result), /Já dispensadas \(nada a fazer\): .*D1/);
  assert.match(textOf(result), /Não encontradas nesta conta.*X9/);

  const noop = fakeClient({ search: recommendationSearch([dismissed]) });
  const r2 = await call(noop.client, "dismiss_recommendation", { resourceNames: [REC("D1")] });
  assert.equal(r2.isError, false);
  assert.match(textOf(r2), /Nenhuma recomendação dispensada/);
  assert.equal(noop.calls.actions.length, 0);
});

test("dismiss_recommendation: dry-run recusa sem ler nem gravar; falha parcial mapeada", async () => {
  const { client, calls } = fakeClient({ search: recommendationSearch([budgetRec("B1")]) });
  const dry = await call(client, "dismiss_recommendation", { resourceNames: [REC("B1")], validateOnly: true });
  assert.equal(dry.isError, true);
  assert.match(textOf(dry), /mutação bloqueada em dry-run/);
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");

  const partial = fakeClient({
    search: recommendationSearch([budgetRec("B1"), cpaRec("C1")]),
    actions: { "recommendations:dismiss": () => ({
      results: [{}, { resourceName: REC("C1") }],
      partialFailureError: { details: [{ errors: [{ message: "Already dismissed", location: { fieldPathElements: [{ fieldName: "operations", index: 0 }] } }] }] },
    }) },
  });
  const result = await call(partial.client, "dismiss_recommendation", { resourceNames: [REC("B1"), REC("C1")] });
  const report = jsonAfterHeader(result) as Row[];
  assert.equal(report[0].status, "falhou");
  assert.equal(report[1].status, "dispensada");
  assert.equal(result.isError, true);
});

// ── generate_recommendations ─────────────────────────────────────────

test("generate_recommendations: exige os dados de cada tipo antes de chamar a API", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "generate_recommendations", {
    advertisingChannelType: "SEARCH", types: ["CAMPAIGN_BUDGET", "KEYWORD", "SITELINK_ASSET", "SET_TARGET_CPA"],
  });
  assert.equal(result.isError, true);
  const message = textOf(result);
  for (const expected of [/biddingStrategyType é obrigatório/, /finalUrl é obrigatório/, /countryCodes é obrigatório/,
    /languageCodes é obrigatório/, /positiveLocationIds ou negativeLocationIds/, /adGroupKeywords é obrigatório/,
    /KEYWORD: informe keywordSeeds/, /sitelinkCount é obrigatório/]) {
    assert.match(message, expected);
  }
  const cases: Array<[Row, RegExp]> = [
    [{ advertisingChannelType: "SEARCH", types: ["KEYWORD"], keywordSeeds: ["x"], merchantCenterAccountId: "123" }, /só vale para PERFORMANCE_MAX/],
    [{ advertisingChannelType: "SEARCH", types: ["SET_TARGET_CPA"], biddingStrategyType: "MANUAL_CPC", targetCpaMicros: 30_000_000 }, /targetCpaMicros só vale/],
    [{ advertisingChannelType: "SEARCH", types: ["SET_TARGET_CPA"], biddingStrategyType: "TARGET_CPA", targetCpaMicros: 30_000_000, targetRoas: 3 }, /use só um de/],
    [{ advertisingChannelType: "SEARCH", types: ["TEXT_AD"] }, /não suportados na geração: TEXT_AD/],
    [{ advertisingChannelType: "PERFORMANCE_MAX", types: ["CAMPAIGN_BUDGET"], biddingStrategyType: "MAXIMIZE_CONVERSIONS", finalUrl: "exemplo.com" }, /finalUrl inválida/],
  ];
  for (const [args, pattern] of cases) assert.match(textOf(await call(client, "generate_recommendations", args)), pattern);
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");
});

test("generate_recommendations: seedUrl aceita URL sem esquema (exemplo do proto); lixo continua recusado", async () => {
  // recommendation_service.proto, SeedInfo.url_seed: "for example: www.example.com/cars"
  const { client, calls } = fakeClient({ actions: { "recommendations:generate": () => ({ recommendations: [] }) } });
  const ok = await call(client, "generate_recommendations", {
    advertisingChannelType: "SEARCH", types: ["KEYWORD"], seedUrl: "www.example.com/cars",
  });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.deepEqual(calls.actions[0].body.seedInfo, { urlSeed: "www.example.com/cars", keywordSeeds: [] });

  const bad = fakeClient();
  const refused = await call(bad.client, "generate_recommendations", {
    advertisingChannelType: "SEARCH", types: ["KEYWORD"], seedUrl: "tenis de corrida",
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /seedUrl inválida/);
  assert.ok(nothingSent(bad.calls), "nada pode ser enviado à API");
});

test("generate_recommendations: payload v25, status de conversão lido da conta e tipos sem retorno", async () => {
  const { client, calls } = fakeClient({
    search: (query) => (fromOf(query) === "customer"
      ? [{ customer: { conversionTrackingSetting: { conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF" } } }]
      : []),
    actions: {
      "recommendations:generate": () => ({
        recommendations: [{ type: "CAMPAIGN_BUDGET", campaignBudgetRecommendation: { recommendedBudgetAmountMicros: "120000000" } }],
      }),
    },
  });
  const result = await call(client, "generate_recommendations", {
    advertisingChannelType: "PERFORMANCE_MAX", types: ["CAMPAIGN_BUDGET", "TARGET_CPA_OPT_IN"],
    biddingStrategyType: "MAXIMIZE_CONVERSIONS", targetCpaMicros: 50_000_000,
    finalUrl: "https://loja.com.br", headlines: ["Tênis em promoção"], currentBudgetMicros: 60_000_000,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(fromOf(calls.queries[0]), "customer");
  const action = calls.actions[0];
  assert.equal(action.action, "recommendations:generate");
  assert.equal(action.write, false);
  assert.deepEqual(action.body, {
    recommendationTypes: ["CAMPAIGN_BUDGET", "TARGET_CPA_OPT_IN"],
    advertisingChannelType: "PERFORMANCE_MAX",
    conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF",
    biddingInfo: { biddingStrategyType: "MAXIMIZE_CONVERSIONS", targetCpaMicros: "50000000" },
    budgetInfo: { currentBudget: "60000000" },
    assetGroupInfo: [{ finalUrl: "https://loja.com.br", headline: ["Tênis em promoção"], description: [] }],
  });
  const text = textOf(result);
  assert.match(text, /Sem recomendação para: TARGET_CPA_OPT_IN/);
  assert.match(text, /Status de conversão lido da conta/);
  assert.equal(((jsonAfterHeader(result) as Row[])[0].details as Row).recommended_budget, 120);

  const search = fakeClient({ actions: { "recommendations:generate": () => ({ recommendations: [] }) } });
  await call(search.client, "generate_recommendations", {
    advertisingChannelType: "SEARCH", types: ["CAMPAIGN_BUDGET"], biddingStrategyType: "TARGET_SPEND", finalUrl: "https://a.com.br",
    countryCodes: ["br"], languageCodes: ["pt"], positiveLocationIds: ["2076"], adGroupKeywords: ["tenis", { text: "tenis corrida", matchType: "EXACT" }],
  });
  const body = search.calls.actions[0].body;
  assert.deepEqual(body.countryCodes, ["BR"]);
  assert.deepEqual(body.positiveLocationsIds, ["2076"]);
  assert.deepEqual(body.adGroupInfo, [{ keywords: [{ text: "tenis", matchType: "BROAD" }, { text: "tenis corrida", matchType: "EXACT" }] }]);
  assert.equal(search.calls.queries.length, 0, "CAMPAIGN_BUDGET não precisa do status de conversão");
});

// ── Assinaturas de auto-aplicação ────────────────────────────────────

test("list_recommendation_subscriptions: uma conta ou todas as da allowlist", async () => {
  const { client, calls } = fakeClient({
    search: (_q, cid) => [{ recommendationSubscription: {
      resourceName: `customers/${cid}/recommendationSubscriptions/USE_BROAD_MATCH_KEYWORD`, type: "USE_BROAD_MATCH_KEYWORD", status: "ENABLED",
    } }],
    children: [
      { customerClient: { id: "1111111111", descriptiveName: "Cliente A" } },
      { customerClient: { id: "2222222222", descriptiveName: "Cliente B" } },
    ],
  });
  const one = await call(client, "list_recommendation_subscriptions", { status: "ENABLED" });
  assert.match(calls.queries[0], /FROM recommendation_subscription/);
  assert.match(calls.queries[0], /recommendation_subscription\.status = 'ENABLED'/);
  assert.match(textOf(one), /1 com auto-aplicação ATIVA/);

  const scoped = handlersFor(client, ["1111111111"], true);
  const all = await scoped.get("list_recommendation_subscriptions")!({ allAccounts: true });
  assert.deepEqual(calls.queryCids.slice(1), ["1111111111"], "conta fora da allowlist não é consultada");
  assert.equal(((jsonAfterHeader(all) as Row[])[0]).account, "Cliente A");

  const neither = await call(client, "list_recommendation_subscriptions", { customerId: undefined });
  assert.match(textOf(neither), /Informe customerId ou allAccounts/);
});

const subscriptionSearch = (existing: Array<{ type: string; status: string }>) => (query: string) =>
  existing
    .filter((s) => query.includes(`'${s.type}'`))
    .map((s) => ({ recommendationSubscription: { resourceName: `customers/${CID}/recommendationSubscriptions/${s.type}`, type: s.type, status: s.status } }));

const SUB_ACTION = "recommendationSubscriptions:mutateRecommendationSubscription";

test("set_recommendation_subscription: cria, atualiza, pula no-op e exige confirm para ligar", async () => {
  const { client, calls } = fakeClient({
    search: subscriptionSearch([{ type: "SET_TARGET_CPA", status: "PAUSED" }, { type: "KEYWORD", status: "ENABLED" }]),
    actions: { [SUB_ACTION]: (body) => ({ results: (body.operations as Row[]).map(() => ({ resourceName: "x" })) }) },
  });
  const noConfirm = await call(client, "set_recommendation_subscription", { types: ["USE_BROAD_MATCH_KEYWORD"], status: "ENABLED" });
  assert.equal(noConfirm.isError, true);
  assert.match(textOf(noConfirm), /confirm: true/);
  assert.ok(nothingSent(calls), "nada pode ser enviado à API");

  const result = await call(client, "set_recommendation_subscription", {
    types: ["USE_BROAD_MATCH_KEYWORD", "SET_TARGET_CPA", "KEYWORD"], status: "ENABLED", confirm: true,
  });
  assert.equal(result.isError, false, textOf(result));
  assert.match(calls.queries[0], /recommendation_subscription\.type IN \('USE_BROAD_MATCH_KEYWORD', 'SET_TARGET_CPA', 'KEYWORD'\)/);
  const write = calls.actions[0];
  assert.equal(write.action, SUB_ACTION);
  assert.equal(write.write, true);
  assert.deepEqual(write.body, {
    operations: [
      { create: { type: "USE_BROAD_MATCH_KEYWORD", status: "ENABLED" } },
      { update: { resourceName: `customers/${CID}/recommendationSubscriptions/SET_TARGET_CPA`, status: "ENABLED" }, updateMask: "status" },
    ],
    partialFailure: true,
  });
  assert.match(textOf(result), /Puladas: KEYWORD \(já ENABLED\)/);

  // pausar não pede confirm; tipo sem assinatura já está desligado
  const pause = fakeClient({ search: subscriptionSearch([]) });
  const r2 = await call(pause.client, "set_recommendation_subscription", { types: ["KEYWORD"], status: "PAUSED" });
  assert.equal(r2.isError, undefined);
  assert.match(textOf(r2), /Nada a alterar.*sem assinatura/s);
  assert.equal(pause.calls.actions.length, 0);

  const bad = await call(pause.client, "set_recommendation_subscription", { types: ["CAMPAIGN_BUDGET"], status: "PAUSED" });
  assert.match(textOf(bad), /Tipos sem suporte a auto-aplicação: CAMPAIGN_BUDGET/);
});

test("set_recommendation_subscription: validateOnly usa o validate_only da API; falha parcial por item", async () => {
  const { client, calls } = fakeClient({
    search: subscriptionSearch([{ type: "RAISE_TARGET_CPA", status: "ENABLED" }]),
    actions: { [SUB_ACTION]: () => ({}) },
  });
  const dry = await call(client, "set_recommendation_subscription", { types: ["RAISE_TARGET_CPA"], status: "PAUSED", validateOnly: true });
  assert.equal(dry.isError, false, textOf(dry));
  assert.equal(calls.dryRunClones, 1);
  assert.equal(calls.actions.length, 1);
  assert.equal(calls.actions[0].write, false, "em dry-run não passa por customerWriteAction");
  assert.equal(calls.actions[0].body.validateOnly, true);
  assert.match(textOf(dry), /^VALIDATE-ONLY/);
  assert.match(textOf(dry), /DRY-RUN \(validateOnly\).*nada foi gravado/);

  const partial = fakeClient({
    search: subscriptionSearch([]),
    actions: { [SUB_ACTION]: () => ({
      results: [{ resourceName: "ok" }, {}],
      partialFailureError: { details: [{ errors: [{ message: "Not allowed", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }) },
  });
  const r = await call(partial.client, "set_recommendation_subscription", { types: ["KEYWORD", "SET_TARGET_ROAS"], status: "ENABLED", confirm: true });
  assert.equal(r.isError, true);
  const report = jsonAfterHeader(r) as Row[];
  assert.equal(report[0].status, "gravado");
  assert.equal(report[1].status, "falhou");
});

// ── get_change_history ───────────────────────────────────────────────

const changeEvent = (i: number, dateTime: string, extra: Row = {}) => ({
  changeEvent: {
    resourceName: `customers/${CID}/changeEvents/${i}`,
    changeDateTime: dateTime,
    changeResourceType: "CAMPAIGN_BUDGET",
    changeResourceName: `customers/${CID}/campaignBudgets/77`,
    resourceChangeOperation: "UPDATE",
    clientType: "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION",
    changedFields: "amountMicros",
    oldResource: { campaignBudget: { amountMicros: "50000000" } },
    newResource: { campaignBudget: { amountMicros: "80000000" } },
    ...extra,
  },
  campaign: { name: "Pesquisa Marca" },
});

test("get_change_history: filtros no WHERE e diff antigo → novo por campo", async () => {
  const { client, calls } = fakeClient({
    search: () => [
      changeEvent(1, "2026-09-20 10:00:00.123456"),
      changeEvent(2, "2026-09-19 09:00:00", {
        changeResourceType: "CAMPAIGN", clientType: "GOOGLE_ADS_WEB_CLIENT", userEmail: "ana@agencia.com",
        changedFields: "status,target_cpa.target_cpa_micros",
        oldResource: { campaign: { status: "ENABLED", targetCpa: { targetCpaMicros: "40000000" } } },
        newResource: { campaign: { status: "PAUSED", targetCpa: { targetCpaMicros: "45000000" } } },
      }),
    ],
  });
  const result = await call(client, "get_change_history", {
    days: 10, clientTypes: ["GOOGLE_ADS_WEB_CLIENT", "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION"], resourceTypes: ["CAMPAIGN", "CAMPAIGN_BUDGET"],
    operations: ["UPDATE"], userEmail: "o'brien@agencia.com", campaignId: "123", adGroupId: "456", limit: 100,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const q = calls.queries[0];
  assert.match(q, /change_event\.client_type IN \('GOOGLE_ADS_WEB_CLIENT', 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION'\)/);
  assert.match(q, /change_event\.change_resource_type IN \('CAMPAIGN', 'CAMPAIGN_BUDGET'\)/);
  assert.match(q, /change_event\.resource_change_operation IN \('UPDATE'\)/);
  assert.match(q, /change_event\.user_email = 'o\\'brien@agencia\.com'/);
  assert.match(q, new RegExp(`change_event\\.campaign = 'customers/${CID}/campaigns/123'`));
  assert.match(q, new RegExp(`change_event\\.ad_group = 'customers/${CID}/adGroups/456'`));
  assert.match(q, /LIMIT 100/);
  const out = jsonAfterHeader(result) as { summary: Row; changes: Row[] };
  assert.deepEqual(out.changes[0].changes, [{ field: "amountMicros", old: "50000000 (= 50)", new: "80000000 (= 80)" }]);
  assert.deepEqual(out.changes[1].changes, [
    { field: "status", old: "ENABLED", new: "PAUSED" },
    { field: "target_cpa.target_cpa_micros", old: "40000000 (= 40)", new: "45000000 (= 45)" },
  ]);
  assert.deepEqual(out.summary.by_client_type, { GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: 1, GOOGLE_ADS_WEB_CLIENT: 1 });
  assert.equal(out.changes[0].old_resource, undefined, "payload cru só com includeRawResources");

  const table = await call(client, "get_change_history", { format: "csv" });
  const lines = textOf(table).split("\n");
  assert.match(lines[0], /field,old,new/);
  assert.equal(lines.length, 1 + 3, "uma linha por campo alterado");
});

test("get_change_history: autoAppliedOnly, summaryOnly e filtros inválidos", async () => {
  const { client, calls } = fakeClient({ search: () => [changeEvent(1, "2026-09-20 10:00:00")] });
  const auto = await call(client, "get_change_history", { autoAppliedOnly: true, summaryOnly: true });
  assert.match(calls.queries[0], /change_event\.client_type IN \('GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION'\)/);
  assert.doesNotMatch(calls.queries[0], /old_resource/, "summaryOnly não traz os payloads");
  assert.deepEqual((jsonAfterHeader(auto) as Row).by_client_type, { GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: 1 });

  const bad = fakeClient();
  const cases: Array<[Row, RegExp]> = [
    [{ autoAppliedOnly: true, clientTypes: ["GOOGLE_ADS_API"] }, /clientTypes OU autoAppliedOnly/],
    [{ clientTypes: ["ROBO"] }, /clientTypes: ROBO/],
    [{ campaignId: "12 OR 1=1" }, /campaignId: 12 OR 1=1/],
    [{ limit: 60_000 }, /limit inválido/],
    [{ dateRange: { since: "2020-01-01", until: "2020-01-02" } }, /últimos 29 dias/],
    [{ userEmail: "   " }, /userEmail/],
  ];
  for (const [args, pattern] of cases) {
    const result = await call(bad.client, "get_change_history", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
  }
  assert.ok(nothingSent(bad.calls), "nada pode ser enviado à API");
});

test("get_change_history: acima de 10.000 pagina pelo horário da última linha, sem duplicar", async () => {
  const firstPage = Array.from({ length: 10_000 }, (_, i) => changeEvent(i, i === 9_999 ? "2026-09-20 10:00:00.500000" : "2026-09-21 08:00:00"));
  const { client, calls } = fakeClient({
    search: (query) => (/change_date_time < '2026-09-20 10:00:01'/.test(query)
      ? [changeEvent(9_999, "2026-09-20 10:00:00.500000"), changeEvent(20_000, "2026-09-20 10:00:00.100000"), changeEvent(20_001, "2026-09-19 07:00:00")]
      : firstPage),
  });
  const result = await call(client, "get_change_history", { limit: 15_000, summaryOnly: true });
  assert.equal(calls.queries.length, 2);
  assert.match(calls.queries[0], /LIMIT 10000/);
  assert.match(calls.queries[1], /change_event\.change_date_time < '2026-09-20 10:00:01'/);
  assert.match(calls.queries[1], /LIMIT 5001/, "faltam 5.000 + 1 já lida no segundo da fronteira, que volta repetida");
  assert.equal((jsonAfterHeader(result) as Row).total, 10_002, "a repetida do mesmo segundo sai pelo resource_name");
});

/**
 * Store de change_event que respeita o que a API faz com a consulta: filtro
 * change_date_time < cursor, ORDER BY change_date_time DESC (empate mantém a ordem do
 * store) e LIMIT.
 */
function changeEventStore(events: Row[]) {
  const sorted = [...events].sort((a, b) =>
    String(obj(b.changeEvent).changeDateTime).localeCompare(String(obj(a.changeEvent).changeDateTime)));
  return (query: string) => {
    const cursor = /change_event\.change_date_time < '([^']+)'/.exec(query)?.[1];
    const limit = Number(/LIMIT (\d+)/.exec(query)?.[1] ?? Infinity);
    return sorted.filter((row) => !cursor || String(obj(row.changeEvent).changeDateTime) < cursor).slice(0, limit);
  };
}
const secondsBefore = (base: number, i: number) => {
  const d = new Date(base - i * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.000000`;
};

test("get_change_history: edição em massa no segundo da fronteira não trava a paginação nem inventa motivo", async () => {
  // 9.970 alterações um segundo apart + 60 no MESMO segundo (edição em massa) = 10.030
  const base = Date.UTC(2026, 8, 21, 12, 0, 0);
  const events = [
    ...Array.from({ length: 9_970 }, (_, i) => changeEvent(i, secondsBefore(base, i))),
    ...Array.from({ length: 60 }, (_, i) => changeEvent(50_000 + i, `2026-09-20 10:00:00.${String(900_000 - i * 1000).padStart(6, "0")}`)),
  ];
  for (const [limit, expected] of [[10_010, 10_010], [10_040, 10_030], [50_000, 10_030]] as const) {
    const { client, calls } = fakeClient({ search: changeEventStore(events) });
    const result = await call(client, "get_change_history", { limit, summaryOnly: true });
    const text = textOf(result);
    assert.equal((jsonAfterHeader(result) as Row).total, expected, `limit ${limit}: ${text.split("\n")[0]}`);
    assert.doesNotMatch(text, /Paginação interrompida/, `limit ${limit}`);
    assert.match(calls.queries[0], /LIMIT 10000/);
    // a 2ª página pede o que falta + as 30 já lidas do segundo 10:00:00, que voltam repetidas
    assert.match(calls.queries[1], /change_date_time < '2026-09-20 10:00:01'/);
    assert.match(calls.queries[1], new RegExp(`LIMIT ${Math.min(limit - 10_000 + 30, 10_000)}\\b`));
    if (limit === 10_010) assert.match(text, /Pode haver mais: limite de 10010 atingido/);
  }
});

test("get_change_history: só avisa de paginação travada quando 10.000+ alterações caem no mesmo segundo", async () => {
  const same = Array.from({ length: 10_005 }, (_, i) => changeEvent(i, "2026-09-20 10:00:00.000000"));
  const older = Array.from({ length: 5 }, (_, i) => changeEvent(20_000 + i, `2026-09-19 0${i}:00:00`));
  const { client, calls } = fakeClient({ search: changeEventStore([...same, ...older]) });
  const result = await call(client, "get_change_history", { limit: 20_000, summaryOnly: true });
  assert.equal((jsonAfterHeader(result) as Row).total, 10_000);
  assert.match(textOf(result), /Paginação interrompida: 10\.000 ou mais alterações no mesmo segundo/);
  assert.equal(calls.queries.length, 2, "para na primeira página que só trouxe repetidas");

  // horário ilegível: para e diz isso, sem culpar "10.000 no mesmo segundo"
  const odd = fakeClient({ search: () => Array.from({ length: 10_000 }, (_, i) => changeEvent(i, "20/09/2026 10:00")) });
  const stopped = await call(odd.client, "get_change_history", { limit: 10_001, summaryOnly: true });
  assert.match(textOf(stopped), /Paginação interrompida: horário da última alteração em formato inesperado/);
  assert.doesNotMatch(textOf(stopped), /mesmo segundo/);
  assert.equal(odd.calls.queries.length, 1);
});

test("get_change_history: clientTypes aceita SEARCH_ADS_360_SYNC (enums/change_client_type.proto = 10)", async () => {
  assert.ok((CHANGE_CLIENT_TYPES as readonly string[]).includes("SEARCH_ADS_360_SYNC"), "SEARCH_ADS_360_SYNC faltando");
  assert.equal(CHANGE_CLIENT_TYPES.length, 13, "valores 2–14 do proto");
  const { client, calls } = fakeClient({ search: () => [] });
  for (const clientTypes of [["SEARCH_ADS_360_SYNC"], '["SEARCH_ADS_360_SYNC"]']) {
    const result = await call(client, "get_change_history", { clientTypes });
    assert.equal(result.isError, undefined, textOf(result));
    assert.match(calls.queries[calls.queries.length - 1], /change_event\.client_type IN \('SEARCH_ADS_360_SYNC'\)/);
  }
});
