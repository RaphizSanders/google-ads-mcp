/**
 * Operar campanhas existentes — os itens levantados em 23/09/2026 na conta
 * 582-006-7509 (lances travados em R$ 0,01, teto de CPC sem como mudar,
 * negativa sem como remover, metas de conversão "not found", GAQL de datas).
 *
 * Cobre: update_campaign (estratégia, parâmetros, redes), update_ad_group
 * (lances), update_keyword, remove_negative_keyword, create_campaign atômico com
 * TARGET_SPEND e sem Enhanced CPC, create_ad_group sem lance placeholder,
 * set_campaign_conversion_goals só com metas existentes, janelas de data e o
 * parâmetro validateOnly por chamada em toda tool de escrita.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";
const CAMPAIGN_ID = "24250313718";

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  rows?: Record<string, Row[]>;
  dryRun?: boolean;
  batchMutate?: (operations: Row[]) => Row;
  mutateCampaigns?: (operations: Row[]) => Row;
  mutate?: (resource: string, operations: Row[]) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ method: string; operations: Row[]; options?: Row }>,
    dryRunClones: 0,
  };
  const record = (method: string, operations: Row[], options?: Row) => calls.writes.push({ method, operations, options });
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
      return opts.rows?.[from] ?? [];
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      record("batchMutate", operations);
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/1` } },
          { campaignResult: { resourceName: `customers/${CID}/campaigns/2` } },
        ],
      };
    },
    async mutateCampaigns(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateCampaigns", operations);
      return opts.mutateCampaigns ? opts.mutateCampaigns(operations) : { results: [{ resourceName: "c" }] };
    },
    async mutateCampaignBudgets(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateCampaignBudgets", operations);
      return { results: [{ resourceName: `customers/${CID}/campaignBudgets/1` }] };
    },
    async mutateAdGroups(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateAdGroups", operations);
      return { results: [{ resourceName: "ag" }] };
    },
    async mutateAdGroupCriteria(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateAdGroupCriteria", operations);
      return { results: [{ resourceName: "agc" }] };
    },
    async mutateCampaignConversionGoals(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateCampaignConversionGoals", operations);
      return { results: operations.map(() => ({ resourceName: "g" })) };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      record(`mutate:${resource}`, operations, options);
      if (opts.mutate) return opts.mutate(resource, operations);
      return dryRun ? {} : { results: operations.map((op) => ({ resourceName: String(op.remove ?? "x") })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, [], false);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) =>
  register(client).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

function onlyUpdate(calls: { writes: Array<{ method: string; operations: Row[] }> }, method: string) {
  const writes = calls.writes.filter((w) => w.method === method);
  assert.equal(writes.length, 1, `exatamente uma escrita em ${method}`);
  assert.equal(writes[0].operations.length, 1);
  const op = writes[0].operations[0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  return op;
}

const searchCampaign = (overrides: Row = {}): Row => ({
  campaign: {
    id: CAMPAIGN_ID, name: "Pesquisa Institucional", status: "ENABLED", advertisingChannelType: "SEARCH",
    biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: {},
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: true },
    ...overrides,
  },
});

// ── Janela de datas (item 11) ─────────────────────────────────────────

test("datas: DURING só para 7/14/30 dias; 90 dias vira BETWEEN terminando ontem", async () => {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (const [days, expected] of [[7, "DURING LAST_7_DAYS"], [14, "DURING LAST_14_DAYS"], [30, "DURING LAST_30_DAYS"]] as const) {
    const { client, calls } = fakeClient();
    await call(client, "get_campaign_performance", { days });
    assert.match(calls.queries[0], new RegExp(`segments\\.date ${expected}`));
  }
  const { client, calls } = fakeClient();
  await call(client, "get_campaign_performance", { days: 90 });
  const since = new Date(); since.setDate(since.getDate() - 90);
  const until = new Date(); until.setDate(until.getDate() - 1);
  assert.match(calls.queries[0], new RegExp(`segments\\.date BETWEEN '${iso(since)}' AND '${iso(until)}'`));
  assert.doesNotMatch(calls.queries[0], /LAST_90_DAYS/);
});

test("datas: dateRange fora do formato ISO não chega ao GAQL", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    call(client, "get_campaign_performance", { dateRange: { since: "2026-01-01' OR '1'='1", until: "2026-01-31" } }),
    /dateRange inválido/
  );
  await assert.rejects(call(client, "get_campaign_performance", { days: 0 }), /days inválido/);
  assert.equal(calls.queries.length, 0);
});

// ── create_campaign (itens 5 e 8) ─────────────────────────────────────

test("create_campaign: orçamento e campanha numa única operação atômica", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_campaign", { name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000 });
  assert.deepEqual(calls.writes.map((w) => w.method), ["batchMutate"], "nada de orçamento separado");
  const [budgetOp, campaignOp] = calls.writes[0].operations as Row[];
  const budget = (budgetOp.campaignBudgetOperation as Row).create as Row;
  const campaign = (campaignOp.campaignOperation as Row).create as Row;
  assert.equal(budget.resourceName, `customers/${CID}/campaignBudgets/-1`);
  assert.equal(campaign.campaignBudget, budget.resourceName, "a campanha aponta para o ID temporário");
  assert.equal(campaign.status, "PAUSED");
  assert.match(textOf(result), /Campaign created \(PAUSED\)/);
});

test("create_campaign: TARGET_SPEND (Maximizar cliques) com e sem teto", async () => {
  const withCeiling = fakeClient();
  await call(withCeiling.client, "create_campaign", {
    name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, biddingStrategy: "TARGET_SPEND", cpcBidCeilingMicros: 17_000_000,
  });
  const created = ((withCeiling.calls.writes[0].operations[1] as Row).campaignOperation as Row).create as Row;
  assert.deepEqual(created.targetSpend, { cpcBidCeilingMicros: "17000000" });

  const noCeiling = fakeClient();
  const result = await call(noCeiling.client, "create_campaign", {
    name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, biddingStrategy: "TARGET_SPEND",
  });
  assert.deepEqual((((noCeiling.calls.writes[0].operations[1] as Row).campaignOperation as Row).create as Row).targetSpend, {});
  assert.match(textOf(result), /sem teto/);
});

test("create_campaign: teto de CPC fora de TARGET_SPEND é recusado antes de enviar", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_campaign", {
    name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, cpcBidCeilingMicros: 5_000_000,
  });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 0);
});

test("create_campaign: CPC manual sai sem Enhanced CPC, e a recusa da API é traduzida", async () => {
  const ok = fakeClient();
  await call(ok.client, "create_campaign", { name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, biddingStrategy: "MANUAL_CPC" });
  assert.deepEqual((((ok.calls.writes[0].operations[1] as Row).campaignOperation as Row).create as Row).manualCpc, {});

  const refused = fakeClient({
    batchMutate: () => {
      throw new Error("Google Ads API: The operation is not allowed for the given context.");
    },
  });
  const result = await call(refused.client, "create_campaign", { name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, biddingStrategy: "MANUAL_CPC" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi criado/);
  assert.match(textOf(result), /Use TARGET_SPEND/);
});

test("Enhanced CPC não é enviado por nenhuma tool (descontinuado em Pesquisa/Display)", () => {
  const source = readFileSync(new URL("../src/tools.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /enhancedCpcEnabled:\s*true/);
});

// ── update_campaign (itens 2 e 4) ─────────────────────────────────────

test("update_campaign: troca para Maximizar cliques com teto — updateMask só do teto", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [searchCampaign()] } });
  const result = await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, biddingStrategy: "TARGET_SPEND", cpcBidCeilingMicros: 17_000_000 });
  const op = onlyUpdate(calls, "mutateCampaigns");
  assert.equal(op.updateMask, "target_spend.cpc_bid_ceiling_micros");
  assert.deepEqual(Object.keys(op.update).sort(), ["resourceName", "targetSpend"]);
  assert.deepEqual(op.update.targetSpend, { cpcBidCeilingMicros: "17000000" });
  assert.match(textOf(result), /aprendizado/);
});

test("update_campaign: trocar de estratégia sem parâmetro nomeia uma folha, nunca a mensagem", async () => {
  // A API recusa "maximize_conversions" no updateMask (FIELD_HAS_SUBFIELDS); a folha
  // vazia troca o oneof. onlyUpdate também passa todo updateMask por assertUpdateMaskLeaves.
  const cases: Array<[Row, string, string, string]> = [
    [searchCampaign({ biddingStrategyType: "TARGET_SPEND", targetSpend: {} }), "MAXIMIZE_CONVERSIONS", "maximize_conversions.target_cpa_micros", "maximizeConversions"],
    [searchCampaign(), "MANUAL_CPC", "manual_cpc.enhanced_cpc_enabled", "manualCpc"],
    [searchCampaign(), "TARGET_SPEND", "target_spend.cpc_bid_ceiling_micros", "targetSpend"],
    [searchCampaign(), "MAXIMIZE_CONVERSION_VALUE", "maximize_conversion_value.target_roas", "maximizeConversionValue"],
  ];
  for (const [row, strategy, path, json] of cases) {
    const { client, calls } = fakeClient({ rows: { campaign: [row] } });
    await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, biddingStrategy: strategy });
    const op = onlyUpdate(calls, "mutateCampaigns");
    assert.equal(op.updateMask, path, strategy);
    assert.deepEqual(op.update[json], {});
  }
});

test("update_campaign: ajusta o alvo das estratégias antigas TARGET_CPA e TARGET_ROAS", async () => {
  const cpa = fakeClient({ rows: { campaign: [searchCampaign({ biddingStrategyType: "TARGET_CPA", targetCpa: { targetCpaMicros: "40000000" } })] } });
  await call(cpa.client, "update_campaign", { campaignId: CAMPAIGN_ID, targetCpaMicros: 50_000_000 });
  const op = onlyUpdate(cpa.calls, "mutateCampaigns");
  assert.equal(op.updateMask, "target_cpa.target_cpa_micros");
  assert.deepEqual(op.update.targetCpa, { targetCpaMicros: "50000000" });

  const roas = fakeClient({ rows: { campaign: [searchCampaign({ biddingStrategyType: "TARGET_ROAS", targetRoas: { targetRoas: 3 } })] } });
  await call(roas.client, "update_campaign", { campaignId: CAMPAIGN_ID, targetRoas: 4.5 });
  assert.equal(onlyUpdate(roas.calls, "mutateCampaigns").updateMask, "target_roas.target_roas");
});

test("update_campaign: sem biddingStrategy o parâmetro ajusta a estratégia atual", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [searchCampaign({ biddingStrategyType: "TARGET_SPEND", targetSpend: { cpcBidCeilingMicros: "15000000" } })] },
  });
  await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, cpcBidCeilingMicros: 25_000_000 });
  const op = onlyUpdate(calls, "mutateCampaigns");
  assert.equal(op.updateMask, "target_spend.cpc_bid_ceiling_micros");
  assert.deepEqual(op.update.targetSpend, { cpcBidCeilingMicros: "25000000" });
});

test("update_campaign: valor igual ao atual não gera escrita", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [searchCampaign({ biddingStrategyType: "TARGET_SPEND", targetSpend: { cpcBidCeilingMicros: "15000000" } })] },
  });
  const result = await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, cpcBidCeilingMicros: 15_000_000, status: "ENABLED" });
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(result), /nada a mudar/);
});

test("update_campaign: parâmetro de outra estratégia, portfólio e TIS incompleto são recusados", async () => {
  const cases: Array<[Row, Row, RegExp]> = [
    [searchCampaign({ biddingStrategyType: "TARGET_SPEND", targetSpend: {} }), { targetRoas: 4 }, /vale para MAXIMIZE_CONVERSION_VALUE/],
    [searchCampaign({ biddingStrategy: "customers/1/biddingStrategies/9" }), { targetCpaMicros: 50_000_000 }, /portfólio/],
    [searchCampaign(), { biddingStrategy: "TARGET_IMPRESSION_SHARE", cpcBidCeilingMicros: 5_000_000 }, /exige targetImpressionShareLocation/],
  ];
  for (const [row, args, message] of cases) {
    const { client, calls } = fakeClient({ rows: { campaign: [row] } });
    const result = await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_campaign: parcela de impressões — três campos, três caminhos no updateMask", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [searchCampaign()] } });
  await call(client, "update_campaign", {
    campaignId: CAMPAIGN_ID, biddingStrategy: "TARGET_IMPRESSION_SHARE",
    targetImpressionShareLocation: "TOP_OF_PAGE", locationFractionMicros: 700_000, cpcBidCeilingMicros: 20_000_000,
  });
  const op = onlyUpdate(calls, "mutateCampaigns");
  assert.deepEqual(op.updateMask.split(",").sort(), [
    "target_impression_share.cpc_bid_ceiling_micros",
    "target_impression_share.location",
    "target_impression_share.location_fraction_micros",
  ]);
  assert.deepEqual(op.update.targetImpressionShare, { cpcBidCeilingMicros: "20000000", location: "TOP_OF_PAGE", locationFractionMicros: "700000" });
});

test("update_campaign: redes — só as chaves que mudam vão no updateMask", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [searchCampaign()] } });
  await call(client, "update_campaign", {
    campaignId: CAMPAIGN_ID,
    networkSettings: { targetGoogleSearch: true, targetContentNetwork: false, targetSearchNetwork: false },
  });
  const op = onlyUpdate(calls, "mutateCampaigns");
  assert.deepEqual(op.updateMask.split(",").sort(), ["network_settings.target_content_network", "network_settings.target_search_network"]);
  assert.deepEqual(op.update.networkSettings, { targetSearchNetwork: false, targetContentNetwork: false });
});

test("update_campaign: entrada inválida não consulta nem grava", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [searchCampaign()] } });
  for (const args of [{ cpcBidCeilingMicros: -1 }, { locationFractionMicros: 2_000_000 }, { targetRoas: 0 }, { campaignId: "1 OR 1=1" }]) {
    const result = await call(client, "update_campaign", { campaignId: CAMPAIGN_ID, ...args });
    assert.equal(result.isError, true);
  }
  assert.equal(calls.queries.length, 0);
});

// ── update_ad_group (item 1) ──────────────────────────────────────────

const adGroupRow = (strategy: string, overrides: Row = {}): Row => ({
  adGroup: { id: "777", name: "Grupo 1", status: "ENABLED", cpcBidMicros: "10000", ...overrides },
  campaign: { id: CAMPAIGN_ID, biddingStrategyType: strategy },
});

test("update_ad_group: corrige o CPC de R$ 0,01 e grava CPM e CPA alvo", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow("MANUAL_CPC")] } });
  const result = await call(client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 2_500_000, cpmBidMicros: 8_000_000, targetCpaMicros: 60_000_000 });
  const op = onlyUpdate(calls, "mutateAdGroups");
  assert.deepEqual(op.updateMask.split(",").sort(), ["cpc_bid_micros", "cpm_bid_micros", "target_cpa_micros"]);
  assert.equal(op.update.cpcBidMicros, "2500000");
  const changes = jsonOf(result).changes as Row[];
  assert.equal(changes.find((c) => c.setting === "cpcBidMicros")?.before, "10000");
});

test("update_ad_group: avisa lance baixo e lance ignorado por estratégia automática", async () => {
  const low = fakeClient({ rows: { ad_group: [adGroupRow("MANUAL_CPC", { cpcBidMicros: "2000000" })] } });
  const r1 = await call(low.client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 10_000 });
  assert.match(textOf(r1), /CPC muito baixo/);

  const auto = fakeClient({ rows: { ad_group: [adGroupRow("TARGET_SPEND")] } });
  const r2 = await call(auto.client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 3_000_000 });
  assert.match(textOf(r2), /ignora o CPC do grupo/);
});

test("update_ad_group: CPA alvo do grupo só vale se a campanha tiver CPA alvo", async () => {
  const withoutTarget = fakeClient({ rows: { ad_group: [adGroupRow("MAXIMIZE_CONVERSIONS")] } });
  const r1 = await call(withoutTarget.client, "update_ad_group", { adGroupId: "777", targetCpaMicros: 60_000_000 });
  assert.match(textOf(r1), /SEM CPA alvo/);

  const withTarget = fakeClient({
    rows: { ad_group: [{ ...adGroupRow("MAXIMIZE_CONVERSIONS"), campaign: { id: CAMPAIGN_ID, biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: { targetCpaMicros: "50000000" } } }] },
  });
  const r2 = await call(withTarget.client, "update_ad_group", { adGroupId: "777", targetCpaMicros: 60_000_000 });
  assert.doesNotMatch(textOf(r2), /CPA alvo do grupo é ignorado|só vale em/);
});

test("update_ad_group: grupo inexistente e lance inválido são recusados sem gravar", async () => {
  const missing = fakeClient();
  assert.match(textOf(await call(missing.client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 2_000_000 })), /não encontrado/);
  const invalid = fakeClient({ rows: { ad_group: [adGroupRow("MANUAL_CPC")] } });
  assert.equal((await call(invalid.client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 1.5 })).isError, true);
  assert.equal(missing.calls.writes.length + invalid.calls.writes.length, 0);
});

// ── update_keyword (item 3) ───────────────────────────────────────────

const keywordRow = (overrides: Row = {}, strategy = "MANUAL_CPC"): Row => ({
  adGroupCriterion: {
    criterionId: "555", status: "ENABLED", negative: false, cpcBidMicros: "10000", effectiveCpcBidMicros: "10000",
    finalUrls: [], keyword: { text: "curso de ingles", matchType: "PHRASE" }, ...overrides,
  },
  adGroup: { id: "777" },
  campaign: { biddingStrategyType: strategy },
});

test("update_keyword: lance, pausa e URL final sem apagar a palavra-chave", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_criterion: [keywordRow()] } });
  await call(client, "update_keyword", { adGroupId: "777", criterionId: "555", cpcBidMicros: 3_000_000, status: "PAUSED", finalUrl: "https://escola.com/ingles" });
  const op = onlyUpdate(calls, "mutateAdGroupCriteria");
  assert.equal(op.update.resourceName, `customers/${CID}/adGroupCriteria/777~555`);
  assert.deepEqual(op.updateMask.split(",").sort(), ["cpc_bid_micros", "final_urls", "status"]);
  assert.deepEqual(op.update.finalUrls, ["https://escola.com/ingles"]);
  assert.equal(calls.writes.some((w) => JSON.stringify(w.operations).includes("remove")), false);
});

test("update_keyword: finalUrl vazia remove a URL própria", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_criterion: [keywordRow({ finalUrls: ["https://escola.com/antiga"] })] } });
  await call(client, "update_keyword", { adGroupId: "777", criterionId: "555", finalUrl: "" });
  const op = onlyUpdate(calls, "mutateAdGroupCriteria");
  assert.equal(op.updateMask, "final_urls");
  assert.deepEqual(op.update.finalUrls, []);
});

test("update_keyword: negativa com lance, removida, inexistente ou URL inválida são recusadas", async () => {
  const cases: Array<[Row[], Row, RegExp]> = [
    [[keywordRow({ negative: true })], { cpcBidMicros: 2_000_000 }, /é negativa/],
    [[keywordRow({ status: "REMOVED" })], { status: "ENABLED" }, /removida/],
    [[], { status: "PAUSED" }, /não encontrada/],
    [[keywordRow()], { finalUrl: "escola.com" }, /finalUrl inválida/],
  ];
  for (const [rows, args, message] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group_criterion: rows } });
    const result = await call(client, "update_keyword", { adGroupId: "777", criterionId: "555", ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length, 0);
  }
});

// ── remove_negative_keyword (item 6) ──────────────────────────────────

const negativeRows = [
  { campaign: { id: CAMPAIGN_ID }, campaignCriterion: { criterionId: "11", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~11`, keyword: { text: "gratis", matchType: "BROAD" } } },
  { campaign: { id: CAMPAIGN_ID }, campaignCriterion: { criterionId: "12", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~12`, keyword: { text: "Vagas", matchType: "PHRASE" } } },
];

test("remove_negative_keyword: por ID e por texto, e relata o que não achou", async () => {
  const { client, calls } = fakeClient({ rows: { campaign_criterion: negativeRows } });
  const result = await call(client, "remove_negative_keyword", {
    campaignId: CAMPAIGN_ID,
    criterionIds: ["11"],
    keywords: [{ text: "vagas", matchType: "PHRASE" }, { text: "emprego", matchType: "EXACT" }],
  });
  const write = calls.writes.find((w) => w.method === "mutate:campaignCriteria")!;
  assert.deepEqual(write.operations.map((op) => op.remove), [negativeRows[0].campaignCriterion.resourceName, negativeRows[1].campaignCriterion.resourceName]);
  assert.deepEqual(write.options, { partialFailure: true });
  const payload = jsonOf(result);
  assert.equal((payload.removed as Row[]).length, 2);
  assert.deepEqual(payload.not_found, ['-[EXACT] "emprego"']);
  assert.match(calls.queries[0], /campaign_criterion\.negative = true/);
});

test("remove_negative_keyword: nada encontrado não envia escrita; erro por operação é mapeado", async () => {
  const none = fakeClient({ rows: { campaign_criterion: negativeRows } });
  const r1 = await call(none.client, "remove_negative_keyword", { campaignId: CAMPAIGN_ID, criterionIds: ["99"] });
  assert.equal(r1.isError, true);
  assert.equal(none.calls.writes.length, 0);

  const partial = fakeClient({
    rows: { campaign_criterion: negativeRows },
    mutate: () => ({
      results: [{ resourceName: "ok" }, {}],
      partialFailureError: { details: [{ errors: [{ message: "Resource was not found.", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const r2 = await call(partial.client, "remove_negative_keyword", { campaignId: CAMPAIGN_ID, criterionIds: ["11", "12"] });
  assert.equal(r2.isError, true);
  const payload = jsonOf(r2);
  assert.deepEqual((payload.removed as Row[]).map((r) => r.criterion_id), ["11"]);
  assert.equal((payload.errors as Row[])[0].criterion_id, "12");
});

test("list_negative_keywords devolve o criterion_id para poder remover", async () => {
  const { client, calls } = fakeClient();
  await call(client, "list_negative_keywords", { campaignId: CAMPAIGN_ID });
  assert.match(calls.queries[0], /campaign_criterion\.criterion_id/);
});

// ── create_ad_group (item 7) ──────────────────────────────────────────

const campaignForAdGroup = (strategy: string): Row => ({
  campaign: { id: CAMPAIGN_ID, advertisingChannelType: "SEARCH", biddingStrategyType: strategy },
});

test("create_ad_group: em CPC manual exige o lance — nunca cria grupo sem lance", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignForAdGroup("MANUAL_CPC")] } });
  const result = await call(client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "Grupo" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /informe cpcBidMicros/);
  assert.equal(calls.writes.length, 0);

  const withBid = fakeClient({ rows: { campaign: [campaignForAdGroup("MANUAL_CPC")] } });
  await call(withBid.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "Grupo", cpcBidMicros: 2_500_000 });
  const created = (withBid.calls.writes[0].operations[0] as Row).create as Row;
  assert.equal(created.cpcBidMicros, "2500000");
});

test("create_ad_group: em estratégia automática cria sem lance e sem placeholder", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignForAdGroup("MAXIMIZE_CONVERSIONS")] } });
  await call(client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "Grupo" });
  const created = (calls.writes[0].operations[0] as Row).create as Row;
  assert.equal(created.cpcBidMicros, undefined);
  assert.doesNotMatch(JSON.stringify(calls.writes), /10000/);
});

test("create_ad_group: CPM manual exige cpmBidMicros", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "DISPLAY", biddingStrategyType: "MANUAL_CPM" } }] } });
  const result = await call(client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "Grupo" });
  assert.match(textOf(result), /informe cpmBidMicros/);
  assert.equal(calls.writes.length, 0);
});

// ── set_campaign_conversion_goals (item 9) ────────────────────────────

const goalRows = [
  { campaign: { id: CAMPAIGN_ID }, campaignConversionGoal: { category: "PURCHASE", origin: "WEBSITE", biddable: false } },
  { campaign: { id: CAMPAIGN_ID }, campaignConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE", biddable: true } },
  { campaign: { id: CAMPAIGN_ID }, campaignConversionGoal: { category: "PAGE_VIEW", origin: "WEBSITE", biddable: true } },
];

test("metas de conversão: par inexistente é recusado com a lista dos pares válidos", async () => {
  const { client, calls } = fakeClient({ rows: { campaign_conversion_goal: goalRows } });
  const result = await call(client, "set_campaign_conversion_goals", {
    campaignId: CAMPAIGN_ID, goals: [{ category: "PURCHASE", biddable: true }, { category: "CONTACT", origin: "CALL_FROM_ADS", biddable: true }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /CONTACT \(CALL_FROM_ADS\)/);
  assert.match(textOf(result), /Pares válidos[\s\S]*PURCHASE \(WEBSITE\)/);
  assert.equal(calls.writes.length, 0);
});

test("metas de conversão: só as que mudam são enviadas; LEAD vira SUBMIT_LEAD_FORM", async () => {
  const { client, calls } = fakeClient({ rows: { campaign_conversion_goal: goalRows } });
  const result = await call(client, "set_campaign_conversion_goals", {
    campaignId: CAMPAIGN_ID,
    goals: [{ category: "PURCHASE", biddable: true }, { category: "LEAD", biddable: true }, { category: "PAGE_VIEW", biddable: false }],
  });
  const write = calls.writes.find((w) => w.method === "mutateCampaignConversionGoals")!;
  assert.deepEqual(write.operations.map((op) => (op.update as Row).resourceName), [
    `customers/${CID}/campaignConversionGoals/${CAMPAIGN_ID}~PURCHASE~WEBSITE`,
    `customers/${CID}/campaignConversionGoals/${CAMPAIGN_ID}~PAGE_VIEW~WEBSITE`,
  ]);
  assert.match(textOf(result), /Sem mudança: SUBMIT_LEAD_FORM \(WEBSITE\)/);
});

// ── validateOnly por chamada (item 10) ────────────────────────────────

test("validateOnly: toda tool de escrita ganha o parâmetro; as de leitura não", () => {
  const { configs } = register(fakeClient().client);
  for (const name of GOOGLE_ADS_WRITE_TOOL_NAMES) {
    const schema = configs.get(name)?.inputSchema as Row | undefined;
    assert.ok(schema && "validateOnly" in schema, `${name} sem validateOnly`);
  }
  for (const name of GOOGLE_ADS_READ_TOOL_NAMES) {
    const schema = configs.get(name)?.inputSchema as Row | undefined;
    assert.ok(!schema || !("validateOnly" in schema), `${name} (leitura) não deveria ter validateOnly`);
  }
});

test("validateOnly: a chamada roda num client em dry-run e a resposta avisa no topo", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow("MANUAL_CPC")] } });
  const result = await call(client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 2_500_000, validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);

  const normal = fakeClient({ rows: { ad_group: [adGroupRow("MANUAL_CPC")] } });
  const r2 = await call(normal.client, "update_ad_group", { adGroupId: "777", cpcBidMicros: 2_500_000 });
  assert.equal(normal.calls.dryRunClones, 0);
  assert.doesNotMatch(textOf(r2), /VALIDATE-ONLY/);
});

// ── GoogleAdsClient real com fetch interceptado ──────────────────────

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

test("validateOnly de ponta a ponta: validate_only só na mutação, e o client original segue gravando", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream") ? [{ results: [searchCampaign()] }] : {}));
  try {
    const client = realClient();
    const handlers = register(client).handlers;
    const result = await handlers.get("update_campaign")!({
      customerId: CID, campaignId: CAMPAIGN_ID, biddingStrategy: "TARGET_SPEND", cpcBidCeilingMicros: 17_000_000, validateOnly: true,
    });
    const reads = net.sent.filter((s) => s.url.endsWith(":searchStream"));
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(reads[0].body.validateOnly, undefined, "leitura não leva validate_only");
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/campaigns:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
    assert.equal(client.isDryRun, false, "o dry-run vale só para aquela chamada");
  } finally {
    net.restore();
  }
});

test("validateOnly em endpoint sem validate_only (aplicar recomendação) é bloqueado, não executado", async () => {
  const net = interceptFetch(() => ({}));
  try {
    const handlers = register(realClient()).handlers;
    const result = await handlers.get("apply_recommendation")!({
      customerId: CID, resourceNames: [`customers/${CID}/recommendations/1`], confirm: true, validateOnly: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/, "o aviso aparece mesmo quando a tool falha");
    assert.match(textOf(result), /mutação bloqueada em dry-run/);
    assert.equal(net.sent.length, 0);
  } finally {
    net.restore();
  }
});

test("validateOnly em tool de passos encadeados é recusado sem enviar nada", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_sitelink_extension", {
    campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com/contato", validateOnly: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /validateOnly não é suportado em create_sitelink_extension/);
  assert.equal(calls.writes.length + calls.queries.length, 0);
  assert.equal(calls.dryRunClones, 0);
});

test("validateOnly de ponta a ponta no create_campaign: uma chamada atômica validada, nada criado", async () => {
  const net = interceptFetch(() => ({}));
  try {
    const handlers = register(realClient()).handlers;
    const result = await handlers.get("create_campaign")!({
      customerId: CID, name: "Busca", channelType: "SEARCH", dailyBudgetMicros: 80_000_000, biddingStrategy: "TARGET_SPEND", validateOnly: true,
    });
    assert.equal(net.sent.length, 1);
    assert.ok(net.sent[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(net.sent[0].body.validateOnly, true);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /nada foi criado/);
  } finally {
    net.restore();
  }
});
