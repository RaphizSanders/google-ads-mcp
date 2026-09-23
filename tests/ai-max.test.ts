/**
 * AI Max (Pesquisa e Shopping): set_ai_max_settings, get_ai_max_report e os
 * ajustes em get_search_terms, get_campaign_performance, create_campaign e
 * update_ad_group.
 *
 * O que estes testes fixam:
 * - a escrita só mexe nos campos de AI Max pedidos (updateMask exato), preserva
 *   os tipos de automação que não foram pedidos e nunca reenvia valor igual;
 * - limites de text_guidelines e campanhas incompatíveis são recusados antes da API;
 * - toda query passa pelas regras de GAQL que a API aplica (tests/gaql-rules.ts);
 * - read-only e dry-run valem de ponta a ponta.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { createReadOnlyToolServer } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "222";

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  campaign?: Row | null;
  /** Linhas por recurso do FROM (search_term_view, expanded_landing_page_view, ...). */
  rows?: Record<string, Row[]>;
  dryRun?: boolean;
  mutateCampaigns?: (operations: Row[]) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    campaignMutations: [] as Row[][],
    budgetMutations: [] as Row[][],
    adGroupMutations: [] as Row[][],
    batchMutations: [] as Row[][],
  };
  const campaign =
    opts.campaign === undefined
      ? {
          id: CAMPAIGN_ID,
          name: "Pesquisa Genérica",
          status: "ENABLED",
          advertisingChannelType: "SEARCH",
          aiMaxSetting: { enableAiMax: false, bundlingRequired: "NOT_REQUIRED" },
          assetAutomationSettings: [],
          textGuidelines: {},
        }
      : opts.campaign;
  const client = {
    isDryRun: opts.dryRun ?? false,
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      if (from === "campaign" && !opts.rows?.campaign) return campaign ? [{ campaign }] : [];
      return opts.rows?.[from] ?? [];
    },
    async mutateCampaigns(_customerId: string, operations: Row[]): Promise<Row> {
      calls.campaignMutations.push(operations);
      if (opts.mutateCampaigns) return opts.mutateCampaigns(operations);
      return { results: [{ resourceName: `customers/${CID}/campaigns/${CAMPAIGN_ID}` }] };
    },
    async mutateCampaignBudgets(_customerId: string, operations: Row[]): Promise<Row> {
      calls.budgetMutations.push(operations);
      return { results: [{ resourceName: `customers/${CID}/campaignBudgets/9` }] };
    },
    async mutateAdGroups(_customerId: string, operations: Row[]): Promise<Row> {
      calls.adGroupMutations.push(operations);
      return { results: [{ resourceName: `customers/${CID}/adGroups/1` }] };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.batchMutations.push(operations);
      return {
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: `customers/${CID}/campaignBudgets/9` } },
          { campaignResult: { resourceName: `customers/${CID}/campaigns/${CAMPAIGN_ID}` } },
        ],
      };
    },
  };
  return { client, calls };
}

function register(client: unknown, opts: { readOnly?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, [], false);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row) =>
  register(client).get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

function onlyOperation(calls: { campaignMutations: Row[][] }): { update: Row; updateMask: string } {
  assert.equal(calls.campaignMutations.length, 1, "exatamente uma escrita");
  assert.equal(calls.campaignMutations[0].length, 1, "uma operação");
  const op = calls.campaignMutations[0][0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  return op;
}

// ── set_ai_max_settings ──────────────────────────────────────────────

test("liga o AI Max: updateMask só com enable_ai_max e nenhum outro campo no update", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true });
  assert.equal(result.isError, undefined);
  const op = onlyOperation(calls);
  assert.equal(op.updateMask, "ai_max_setting.enable_ai_max");
  assert.deepEqual(Object.keys(op.update).sort(), ["aiMaxSetting", "resourceName"]);
  assert.deepEqual(op.update.aiMaxSetting, { enableAiMax: true });
  assert.equal(op.update.resourceName, `customers/${CID}/campaigns/${CAMPAIGN_ID}`);
});

test("automação de assets: troca só o tipo pedido e reenvia os demais como estão", async () => {
  const { client, calls } = fakeClient({
    campaign: {
      id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH",
      aiMaxSetting: { enableAiMax: true },
      assetAutomationSettings: [
        { assetAutomationType: "GENERATE_ENHANCED_YOUTUBE_VIDEOS", assetAutomationStatus: "OPTED_IN" },
        { assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_IN" },
      ],
    },
  });
  await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, textCustomization: false, finalUrlExpansion: true });
  const op = onlyOperation(calls);
  assert.equal(op.updateMask, "asset_automation_settings");
  const sent = op.update.assetAutomationSettings as Row[];
  const status = (type: string) => sent.find((s) => s.assetAutomationType === type)?.assetAutomationStatus;
  assert.equal(status("GENERATE_ENHANCED_YOUTUBE_VIDEOS"), "OPTED_IN", "tipo não pedido é preservado");
  assert.equal(status("TEXT_ASSET_AUTOMATION"), "OPTED_OUT");
  assert.equal(status("FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION"), "OPTED_IN");
  assert.equal(sent.length, 3);
});

test("text_guidelines: substitui as listas, tipa as restrições e [] limpa", async () => {
  const { client, calls } = fakeClient({
    campaign: {
      id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH",
      aiMaxSetting: { enableAiMax: true },
      textGuidelines: { termExclusions: ["barato"], messagingRestrictions: [{ restrictionText: "antiga" }] },
    },
  });
  await call(client, "set_ai_max_settings", {
    campaignId: CAMPAIGN_ID,
    termExclusions: ["grátis", " grátis ", "promoção"],
    messagingRestrictions: [],
  });
  const op = onlyOperation(calls);
  assert.equal(op.updateMask, "text_guidelines.term_exclusions,text_guidelines.messaging_restrictions");
  const guidelines = op.update.textGuidelines as Row;
  assert.deepEqual(guidelines.termExclusions, ["grátis", "promoção"], "espaços e repetidos saem");
  assert.deepEqual(guidelines.messagingRestrictions, []);

  const typed = fakeClient({ campaign: { id: CAMPAIGN_ID, name: "P", status: "ENABLED", advertisingChannelType: "SEARCH", aiMaxSetting: { enableAiMax: true } } });
  await call(typed.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, messagingRestrictions: ["não citar concorrentes"] });
  const restriction = ((onlyOperation(typed.calls).update.textGuidelines as Row).messagingRestrictions as Row[])[0];
  assert.deepEqual(restriction, { restrictionText: "não citar concorrentes", restrictionType: "RESTRICTION_BASED_EXCLUSION" });
});

test("text_guidelines vindas como string JSON: objeto de restrição vira texto, lixo é recusado", async () => {
  // flexArray não valida os itens da string JSON; antes, um objeto virava "[object Object]"
  const campaign = { id: CAMPAIGN_ID, name: "P", status: "ENABLED", advertisingChannelType: "SEARCH", aiMaxSetting: { enableAiMax: true } };
  const ok = fakeClient({ campaign });
  await call(ok.client, "set_ai_max_settings", {
    campaignId: CAMPAIGN_ID, messagingRestrictions: JSON.stringify([{ restrictionText: "não citar preço" }]),
  });
  const sent = ((onlyOperation(ok.calls).update.textGuidelines as Row).messagingRestrictions as Row[])[0];
  assert.equal(sent.restrictionText, "não citar preço");

  for (const args of [{ termExclusions: JSON.stringify([{ a: 1 }]) }, { messagingRestrictions: JSON.stringify([42]) }]) {
    const bad = fakeClient({ campaign });
    const result = await call(bad.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /item inválido/);
    assert.doesNotMatch(JSON.stringify(bad.calls.campaignMutations), /object Object/);
    assert.equal(bad.calls.queries.length, 0);
  }
});

test("limites de text_guidelines são recusados antes de qualquer chamada", async () => {
  const cases: Row[] = [
    { termExclusions: Array.from({ length: 26 }, (_, i) => `termo${i}`) },
    { termExclusions: ["x".repeat(31)] },
    { messagingRestrictions: Array.from({ length: 41 }, (_, i) => `regra ${i}`) },
    { messagingRestrictions: ["y".repeat(301)] },
  ];
  for (const args of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Nada foi alterado/);
    assert.equal(calls.queries.length, 0);
    assert.equal(calls.campaignMutations.length, 0);
  }
});

test("valor igual ao atual não é reenviado; sem mudança nenhuma, nenhuma escrita", async () => {
  const { client, calls } = fakeClient({
    campaign: {
      id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH",
      aiMaxSetting: { enableAiMax: true },
      assetAutomationSettings: [{ assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_IN" }],
      textGuidelines: { termExclusions: ["grátis"] },
    },
  });
  const result = await call(client, "set_ai_max_settings", {
    campaignId: CAMPAIGN_ID, enableAiMax: true, textCustomization: true, termExclusions: ["grátis"],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.campaignMutations.length, 0);
  assert.match(textOf(result), /nada a mudar/);
});

test("campanha incompatível, removida ou inexistente é recusada sem escrever", async () => {
  const display = fakeClient({ campaign: { id: CAMPAIGN_ID, name: "Display", status: "ENABLED", advertisingChannelType: "DISPLAY" } });
  const r1 = await call(display.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /só existe em Pesquisa e Shopping/);

  const removed = fakeClient({ campaign: { id: CAMPAIGN_ID, name: "Velha", status: "REMOVED", advertisingChannelType: "SEARCH" } });
  assert.equal((await call(removed.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true })).isError, true);

  const missing = fakeClient({ campaign: null });
  const r3 = await call(missing.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true });
  assert.match(textOf(r3), /não encontrada/);

  for (const { calls } of [display, removed, missing]) assert.equal(calls.campaignMutations.length, 0);
});

test("Shopping: liga o AI Max, mas recusa ajustar a personalização de texto", async () => {
  const shopping = () => fakeClient({
    campaign: { id: CAMPAIGN_ID, name: "Shopping", status: "ENABLED", advertisingChannelType: "SHOPPING", aiMaxSetting: { enableAiMax: false } },
  });
  const ok = shopping();
  await call(ok.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true });
  assert.equal(onlyOperation(ok.calls).updateMask, "ai_max_setting.enable_ai_max");

  const refused = shopping();
  const result = await call(refused.client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, textCustomization: false });
  assert.equal(result.isError, true);
  assert.equal(refused.calls.campaignMutations.length, 0);
});

test("bundling_required = REQUIRED: avisa ao desligar o AI Max", async () => {
  const { client } = fakeClient({
    campaign: {
      id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH",
      aiMaxSetting: { enableAiMax: true, bundlingRequired: "REQUIRED" },
    },
  });
  const result = await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: false });
  assert.match(String((jsonOf(result).warnings as string[])[0]), /bundling_required = REQUIRED/);
});

test("entrada inválida: IDs não numéricos e nenhum ajuste pedido", async () => {
  const { client, calls } = fakeClient();
  assert.equal((await call(client, "set_ai_max_settings", { campaignId: "1 OR 1=1", enableAiMax: true })).isError, true);
  assert.equal((await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID })).isError, true);
  assert.equal(calls.queries.length, 0);
});

test("erro da API: relata a falha e manda conferir o estado", async () => {
  const { client } = fakeClient({
    mutateCampaigns: () => {
      throw new Error("Google Ads API: AI_MAX_MUST_BE_ENABLED");
    },
  });
  const result = await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, termExclusions: ["grátis"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /AI_MAX_MUST_BE_ENABLED/);
  assert.match(textOf(result), /Confira o estado atual/);
});

test("dry-run: relata validação, não gravação", async () => {
  const { client } = fakeClient({ dryRun: true, mutateCampaigns: () => ({}) });
  const result = await call(client, "set_ai_max_settings", { campaignId: CAMPAIGN_ID, enableAiMax: true });
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.doesNotMatch(textOf(result), /aplicado/);
});

test("read-only: o catálogo publica o relatório e omite o ajuste", () => {
  const handlers = register(fakeClient().client, { readOnly: true });
  assert.ok(handlers.has("get_ai_max_report"));
  assert.ok(!handlers.has("set_ai_max_settings"));
});

// ── GoogleAdsClient real com fetch interceptado ──────────────────────

test("dry-run de ponta a ponta: o client real envia validateOnly com o updateMask exato", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Row;
    sent.push({ url, body });
    const payload = url.endsWith(":searchStream")
      ? [{ results: [{ campaign: { id: CAMPAIGN_ID, name: "P", status: "ENABLED", advertisingChannelType: "SEARCH", aiMaxSetting: { enableAiMax: false } } }] }]
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({
      credentials: {
        token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token",
        client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z",
      },
      developerToken: "d",
      loginCustomerId: CID,
      dryRun: true,
    });
    const result = await register(client).get("set_ai_max_settings")!({ customerId: CID, campaignId: CAMPAIGN_ID, enableAiMax: true });
    for (const { url, body } of sent.filter((s) => s.url.endsWith(":searchStream"))) {
      assert.ok(url.includes(`/customers/${CID}/`));
      assertGaqlRules(String(body.query));
    }
    const writes = sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/campaigns:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    const op = (writes[0].body.operations as Row[])[0];
    assert.equal(op.updateMask, "ai_max_setting.enable_ai_max");
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    globalThis.fetch = original;
  }
});

// ── get_ai_max_report ────────────────────────────────────────────────

const metrics = (costMicros: number, conversions = 0, value = 0, clicks = 10, impressions = 100): Row => ({
  impressions: String(impressions), clicks: String(clicks), costMicros: String(costMicros),
  conversions, conversionsValue: value,
});

test("relatório de termos: lista só AI Max, resume todas as origens e calcula a fatia", async () => {
  const term = (term: string, source: string, cost: number, conv = 0) => ({
    campaign: { id: CAMPAIGN_ID, name: "Pesquisa" }, adGroup: { name: "Grupo" },
    searchTermView: { searchTerm: term }, segments: { searchTermMatchSource: source },
    metrics: metrics(cost, conv, conv * 100),
  });
  const { client, calls } = fakeClient({
    rows: {
      search_term_view: [
        term("tenis corrida", "ADVERTISER_PROVIDED_KEYWORD", 60_000_000, 3),
        term("tenis leve para maratona", "AI_MAX_BROAD_MATCH", 30_000_000, 1),
        term("melhor tenis amortecimento", "AI_MAX_KEYWORDLESS", 10_000_000),
      ],
    },
  });
  const result = await call(client, "get_ai_max_report", { campaignId: CAMPAIGN_ID, limit: 1 });

  const query = calls.queries[0];
  assert.match(query, /FROM search_term_view/);
  assert.match(query, /segments\.search_term_match_source/);
  assert.match(query, new RegExp(`campaign\\.id = ${CAMPAIGN_ID}`));
  assert.doesNotMatch(query, /LIMIT/, "o resumo precisa de todas as linhas; o limit vale só para a listagem");

  const payload = jsonOf(result);
  const rows = payload.rows as Row[];
  assert.equal(rows.length, 1, "limit aplicado à listagem");
  assert.equal(rows[0].match_source, "AI_MAX_BROAD_MATCH", "ordenado por gasto, só origens AI Max");
  const summary = payload.summary_by_source as Record<string, Row>;
  assert.deepEqual(Object.keys(summary).sort(), ["ADVERTISER_PROVIDED_KEYWORD", "AI_MAX_BROAD_MATCH", "AI_MAX_KEYWORDLESS"]);
  assert.equal((payload.ai_max_total as Row).spend, 40);
  assert.match(textOf(result), /AI Max = 40% do gasto/);
  assert.match(textOf(result), /Não some métricas/);
});

test("relatório de combinações: termo × landing page × título, ordenado por gasto", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ai_max_search_term_ad_combination_view: [{
        campaign: { name: "Pesquisa" }, adGroup: { name: "Grupo" },
        aiMaxSearchTermAdCombinationView: {
          searchTerm: "tenis de corrida feminino", landingPage: "https://loja.com/feminino",
          headline: "Tênis de Corrida | Frete Grátis",
        },
        metrics: metrics(12_340_000, 2, 400),
      }],
    },
  });
  const result = await call(client, "get_ai_max_report", { view: "combinations", days: 7 });
  assert.match(calls.queries[0], /FROM ai_max_search_term_ad_combination_view/);
  assert.match(calls.queries[0], /ORDER BY metrics\.cost_micros DESC/);
  assert.match(calls.queries[0], /LAST_7_DAYS/);
  const [row] = jsonOf(result).rows as Row[];
  assert.equal(row.headline, "Tênis de Corrida | Frete Grátis");
  assert.equal(row.landing_page, "https://loja.com/feminino");
  assert.equal(row.spend, 12.34);
  assert.equal(row.roas, 32.41);
});

test("relatório de landing pages: separa URL do anunciante da escolhida pelo AI Max", async () => {
  const page = (url: string, source: string, cost: number) => ({
    campaign: { id: CAMPAIGN_ID, name: "Pesquisa", aiMaxSetting: { enableAiMax: true } },
    expandedLandingPageView: { expandedFinalUrl: url }, segments: { landingPageSource: source },
    metrics: metrics(cost),
  });
  const { client, calls } = fakeClient({
    rows: {
      expanded_landing_page_view: [
        page("https://loja.com/", "ADVERTISER", 50_000_000),
        page("https://loja.com/categoria/tenis", "AUTOMATIC", 20_000_000),
      ],
    },
  });
  const result = await call(client, "get_ai_max_report", { view: "landing_pages" });
  assert.match(calls.queries[0], /FROM expanded_landing_page_view/);
  assert.match(calls.queries[0], /campaign\.ai_max_setting\.enable_ai_max = TRUE/, "sem campanha: só as que têm AI Max");
  const summary = jsonOf(result).summary_by_source as Record<string, Row>;
  assert.equal(summary.AUTOMATIC.spend, 20);
  assert.equal(summary.ADVERTISER.spend, 50);

  const scoped = fakeClient({ rows: { expanded_landing_page_view: [] } });
  await call(scoped.client, "get_ai_max_report", { view: "landing_pages", campaignId: CAMPAIGN_ID });
  assert.match(scoped.calls.queries[0], new RegExp(`campaign\\.id = ${CAMPAIGN_ID}`));
});

test("relatório: campaignId não numérico é recusado sem consultar", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "get_ai_max_report", { campaignId: "1; DROP" });
  assert.equal(result.isError, true);
  assert.equal(calls.queries.length, 0);
});

// ── Ferramentas existentes que passaram a enxergar o AI Max ───────────

test("get_search_terms: traz a origem do termo e filtra por ela", async () => {
  const { client, calls } = fakeClient({
    rows: {
      search_term_view: [{
        searchTermView: { searchTerm: "tenis", status: "NONE" }, campaign: { name: "P" }, adGroup: { name: "G" },
        segments: { searchTermMatchSource: "AI_MAX_KEYWORDLESS" }, metrics: metrics(1_000_000),
      }],
    },
  });
  const result = await call(client, "get_search_terms", { matchSources: ["AI_MAX_KEYWORDLESS", "AI_MAX_BROAD_MATCH"] });
  assert.match(calls.queries[0], /segments\.search_term_match_source IN \('AI_MAX_KEYWORDLESS', 'AI_MAX_BROAD_MATCH'\)/);
  const body = textOf(result);
  const [row] = JSON.parse(body.slice(body.indexOf("["))) as Row[];
  assert.equal(row.match_source, "AI_MAX_KEYWORDLESS");
});

test("get_search_terms: origem inválida vinda como string JSON não chega ao GAQL", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "get_search_terms", { matchSources: `["AI_MAX_KEYWORDLESS') OR ('1'='1"]` });
  assert.equal(result.isError, true);
  assert.equal(calls.queries.length, 0);
});

test("get_campaign_performance: mostra se a campanha está com AI Max", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "1", name: "Com", aiMaxSetting: { enableAiMax: true } }, metrics: metrics(1_000_000) },
        { campaign: { id: "2", name: "Sem" }, metrics: metrics(1_000_000) },
      ],
    },
  });
  const result = await call(client, "get_campaign_performance", {});
  assert.match(calls.queries[0], /campaign\.ai_max_setting\.enable_ai_max/);
  const body = textOf(result);
  const rows = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as Row[];
  assert.deepEqual(rows.map((row) => row.ai_max), [true, false]);
});

test("create_campaign: enableAiMax liga o AI Max na criação da campanha de Pesquisa", async () => {
  const { client, calls } = fakeClient();
  await call(client, "create_campaign", { name: "Nova", channelType: "SEARCH", dailyBudgetMicros: 50_000_000, enableAiMax: true });
  const create = ((calls.batchMutations[0][1] as Row).campaignOperation as Row).create as Row;
  assert.deepEqual(create.aiMaxSetting, { enableAiMax: true });
  assert.equal(create.status, "PAUSED");
});

test("create_campaign: enableAiMax fora de SEARCH é recusado antes de criar o orçamento", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_campaign", { name: "Nova", channelType: "DISPLAY", dailyBudgetMicros: 50_000_000, enableAiMax: true });
  assert.equal(result.isError, true);
  assert.equal(calls.batchMutations.length, 0, "nada enviado — nem orçamento");
  assert.equal(calls.budgetMutations.length, 0);
});

test("update_ad_group: liga/desliga a correspondência de termos do AI Max no grupo", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [{
        adGroup: { id: "777", name: "Marca", status: "ENABLED", aiMaxAdGroupSetting: { disableSearchTermMatching: false } },
        campaign: { id: CAMPAIGN_ID, biddingStrategyType: "MAXIMIZE_CONVERSIONS" },
      }],
    },
  });
  await call(client, "update_ad_group", { adGroupId: "777", disableSearchTermMatching: true });
  const op = calls.adGroupMutations[0][0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "ai_max_ad_group_setting.disable_search_term_matching");
  assert.deepEqual(op.update.aiMaxAdGroupSetting, { disableSearchTermMatching: true });

  const bad = await call(client, "update_ad_group", { adGroupId: "7a", disableSearchTermMatching: true });
  assert.equal(bad.isError, true);
  assert.equal(calls.adGroupMutations.length, 1);
});
