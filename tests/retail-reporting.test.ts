/**
 * Lote retail-reporting: PMax por canal, status de produtos, relatórios de varejo
 * (get_shopping_products ampliada, grupos de produtos, vendas com dados do carrinho) e listas de
 * marcas (suggest/list/create/update/attach/detach).
 *
 * O que estes testes fixam:
 * - toda query passa pelas regras de GAQL da API (tests/gaql-rules.ts, metadados reais da v25);
 * - entradas inválidas e regras por canal são recusadas antes de qualquer chamada;
 * - escritas: payload exato, pulam o que já está igual, pedem confirm para remover, mapeiam o erro
 *   da API e respeitam o dry-run/validateOnly (nada é dito como gravado);
 * - get_shopping_products continua devolvendo o mesmo formato por padrão.
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

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  /** Linhas por recurso do FROM; função recebe a query. */
  rows?: Record<string, Row[] | ((query: string) => Row[])>;
  dryRun?: boolean;
  batchMutate?: (operations: Row[]) => Row;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
  customerAction?: (action: string, body: Row) => Row;
}

interface Write {
  method: string;
  resource?: string;
  operations: Row[];
  options?: Row;
  dryRun: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Write[],
    actions: [] as Array<{ action: string; body: Row }>,
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const rows = opts.rows?.[from];
      return typeof rows === "function" ? rows(query) : rows ?? [];
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((_op, index) =>
          index === 0 ? { sharedSetResult: { resourceName: `customers/${CID}/sharedSets/555` } } : {}),
      };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations, options);
      return dryRun ? {} : { results: operations.map((_op, index) => ({ resourceName: `customers/${CID}/${resource}/${index}` })) };
    },
    async customerAction(_customerId: string, action: string, body: Row): Promise<Row> {
      calls.actions.push({ action, body });
      return opts.customerAction ? opts.customerAction(action, body) : {};
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, opts: { readOnly?: boolean; allowed?: string[]; hosted?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, opts.allowed ?? [], opts.hosted ?? false);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row) => register(client).get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

/** O JSON vem depois do cabeçalho, separado por uma linha em branco, no último bloco de texto. */
function jsonOf<T = Row>(result: Result): T {
  const body = result.content[result.content.length - 1].text ?? "";
  return JSON.parse(body.slice(body.indexOf("\n\n") + 2)) as T;
}

const metrics = (cost: number, extra: Row = {}) => ({
  impressions: "1000", clicks: "50", costMicros: String(Math.round(cost * 1_000_000)), conversions: 2, conversionsValue: 300, ...extra,
});

// ══ get_pmax_channel_performance ══════════════════════════════════════

const pmaxRow = (network: string, cost: number, extra: Row = {}, segments: Row = {}) => ({
  campaign: { id: "10", name: "PMax Loja" },
  segments: { adNetworkType: network, ...segments },
  metrics: metrics(cost, extra),
});

test("pmax por canal: query em FROM campaign só de PMax, com gasto e % por canal", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [pmaxRow("YOUTUBE", 60), pmaxRow("SEARCH", 30), pmaxRow("MIXED", 10)] },
  });
  const result = await call(client, "get_pmax_channel_performance", { campaignId: "10", days: 30 });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 1);
  const query = calls.queries[0].replace(/\s+/g, " ");
  assert.match(query, /FROM campaign WHERE campaign\.advertising_channel_type = 'PERFORMANCE_MAX'/);
  assert.match(query, /segments\.ad_network_type/);
  assert.match(query, /campaign\.id = 10/);
  assert.doesNotMatch(query, /ad_using_product_data|ad_using_video/);
  assert.match(textOf(result), /Canal com mais gasto: YouTube \(60%\)/);
  assert.match(textOf(result), /10% do gasto veio como MIXED/);
  const body = jsonOf<{ por_canal: Row[]; itens: Array<{ canais: Row[] }> }>(result);
  assert.deepEqual(body.por_canal.map((c) => [c.rede, c.share_of_spend_pct, c.spend]), [["YOUTUBE", 60, 60], ["SEARCH", 30, 30], ["MIXED", 10, 10]]);
  assert.equal(body.por_canal[0].roas, 5);
  assert.equal(body.itens[0].canais.length, 3);
});

test("pmax por canal: splitByProductData/splitByVideo separam as linhas pelos segmentos v22", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        pmaxRow("YOUTUBE", 40, {}, { adUsingProductData: true, adUsingVideo: true }),
        pmaxRow("YOUTUBE", 20, {}, { adUsingProductData: false, adUsingVideo: true }),
        pmaxRow("SEARCH", 40, {}, { adUsingProductData: true, adUsingVideo: false }),
      ],
    },
  });
  const result = await call(client, "get_pmax_channel_performance", { splitByProductData: true, splitByVideo: true });
  const query = calls.queries[0];
  assert.match(query, /segments\.ad_using_product_data/);
  assert.match(query, /segments\.ad_using_video/);
  const body = jsonOf<{ por_canal: Row[] }>(result);
  assert.equal(body.por_canal.length, 3);
  const youtubeSemFeed = body.por_canal.find((c) => c.rede === "YOUTUBE" && c.usa_dados_de_produto === false);
  assert.deepEqual(youtubeSemFeed, { ...youtubeSemFeed, usa_video: true, share_of_spend_pct: 20, spend: 20 });
  assert.equal(body.por_canal[body.por_canal.length - 1], youtubeSemFeed, "ordenado por gasto");
});

test("pmax por canal: nível asset_group e asset montam queries válidas e agrupam por item", async () => {
  const agRow = (id: string, network: string, cost: number) => ({
    campaign: { id: "10", name: "PMax" }, assetGroup: { id, name: `AG ${id}`, status: "ENABLED" },
    segments: { adNetworkType: network }, metrics: metrics(cost),
  });
  const { client, calls } = fakeClient({ rows: { asset_group: [agRow("1", "YOUTUBE", 10), agRow("1", "SEARCH", 30), agRow("2", "CONTENT", 5)] } });
  const result = await call(client, "get_pmax_channel_performance", { level: "asset_group", campaignId: "10", assetGroupId: "1", format: "csv" });
  assert.match(calls.queries[0], /FROM asset_group/);
  assert.match(calls.queries[0], /asset_group\.id = 1/);
  const csv = textOf(result).split("\n");
  assert.match(csv[0], /asset_group_id/);
  assert.equal(csv.length, 4, "uma linha por grupo × canal");

  const assetRow = {
    campaign: { id: "10", name: "PMax" }, assetGroup: { id: "1", name: "AG" },
    assetGroupAsset: { fieldType: "HEADLINE" }, asset: { id: "99", type: "TEXT", textAsset: { text: "Frete grátis" } },
    segments: { adNetworkType: "SEARCH" }, metrics: metrics(3),
  };
  const asset = fakeClient({ rows: { asset_group_asset: [assetRow] } });
  const assetResult = await call(asset.client, "get_pmax_channel_performance", { level: "asset", assetGroupId: "1" });
  assert.match(asset.calls.queries[0], /FROM asset_group_asset/);
  assert.equal(jsonOf<{ itens: Row[] }>(assetResult).itens[0].asset, "Frete grátis");
});

test("pmax por canal: level asset não soma os assets — total e % por canal vêm do grupo de recursos", async () => {
  // Uma impressão de Pesquisa (custo 100) que mostrou título + descrição: a API registra a impressão
  // e o custo nos DOIS assets. Uma impressão de YouTube (custo 100) com um só vídeo. No grupo de
  // recursos: Pesquisa 100 e YouTube 100 (50% / 50%). Somar os assets daria 300 e Pesquisa 66,67%.
  const m = (cost: number) => ({ impressions: "1", clicks: "1", costMicros: String(cost * 1_000_000), conversions: 1, conversionsValue: 500 });
  const assetRow = (id: string, fieldType: string, network: string) => ({
    campaign: { id: "10", name: "PMax" }, assetGroup: { id: "1", name: "AG" },
    assetGroupAsset: { fieldType }, asset: { id, type: "TEXT", textAsset: { text: `asset ${id}` } },
    segments: { adNetworkType: network }, metrics: m(100),
  });
  const groupRow = (network: string) => ({ campaign: { id: "10" }, assetGroup: { id: "1" }, segments: { adNetworkType: network }, metrics: m(100) });
  const rows = {
    asset_group_asset: [assetRow("91", "HEADLINE", "SEARCH"), assetRow("92", "DESCRIPTION", "SEARCH"), assetRow("93", "YOUTUBE_VIDEO", "YOUTUBE")],
    asset_group: [groupRow("SEARCH"), groupRow("YOUTUBE")],
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "get_pmax_channel_performance", { level: "asset", campaignId: "10", assetGroupId: "1", days: 7 });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 2, "linhas por asset + totais do grupo de recursos");
  const assetQuery = calls.queries.find((q) => /FROM asset_group_asset\b/.test(q)) ?? "";
  const totalsQuery = calls.queries.find((q) => /FROM asset_group\b/.test(q)) ?? "";
  assert.match(totalsQuery, /segments\.ad_network_type/);
  const whereOf = (q: string) => q.slice(q.indexOf("WHERE")).replace(/\s+/g, " ");
  assert.equal(whereOf(totalsQuery), whereOf(assetQuery), "mesmos filtros (PMax, campanha, grupo e período)");
  assert.match(whereOf(totalsQuery), /campaign\.advertising_channel_type = 'PERFORMANCE_MAX'.*campaign\.id = 10.*asset_group\.id = 1/);

  const body = jsonOf<{ total: Row; por_canal: Row[]; itens: Array<{ total: Row }>; origem_do_total: string }>(result);
  const sumOfAssets = body.itens.reduce((sum, item) => sum + Number(item.total.spend), 0);
  assert.equal(sumOfAssets, 300);
  assert.equal(body.total.spend, 200, "gasto do grupo de recursos, não a soma dos assets");
  assert.notEqual(body.total.spend, sumOfAssets);
  assert.equal(body.total.conversions, 2);
  assert.equal(body.total.conversions_value, 1000);
  assert.deepEqual(
    body.por_canal.map((c) => [c.rede, c.spend, c.share_of_spend_pct]).sort(),
    [["SEARCH", 100, 50], ["YOUTUBE", 100, 50]]
  );
  assert.match(body.origem_do_total, /asset_group/);
  assert.equal(body.itens.length, 3, "cada asset continua com os próprios números");
  assert.ok(body.itens.every((item) => item.total.spend === 100));
  const out = textOf(result);
  assert.match(out, /3 asset\(s\) PMax — gasto total 200 \(dos grupos de recursos no filtro, não a soma dos assets\), conversões 2, valor 1000\./);
  assert.match(out, /\(50%\)/);
  assert.match(out, /não some as linhas dos assets/);

  // mesmo dado no nível asset_group: uma consulta só, e o mesmo total
  const group = fakeClient({ rows });
  const groupResult = await call(group.client, "get_pmax_channel_performance", { level: "asset_group", campaignId: "10", assetGroupId: "1", days: 7 });
  assert.equal(group.calls.queries.length, 1);
  assert.equal(jsonOf<{ total: Row }>(groupResult).total.spend, 200);
  assert.doesNotMatch(textOf(groupResult), /não some/);
});

test("pmax por canal: combinações que a API não aceita são recusadas antes de consultar", async () => {
  const { client, calls } = fakeClient();
  for (const args of [
    { level: "asset_group", splitByVideo: true },
    { level: "asset" },
    { assetGroupId: "1" },
    { campaignId: "10; DROP" },
    { dateRange: { since: "2026-13-01", until: "x" } },
  ]) {
    const result = await call(client, "get_pmax_channel_performance", args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
});

// ══ get_product_status ═════════════════════════════════════════════════

const issue = (code: string, severity: string, extra: Row = {}) => ({
  errorCode: code, adsSeverity: severity, description: `desc ${code}`, documentation: `https://support.google.com/${code}`, ...extra,
});
const product = (itemId: string, status: string, issues: Row[] = [], impressions = 0, extra: Row = {}) => ({
  shoppingProduct: {
    itemId, title: `Produto ${itemId}`, brand: "Marca", status, issues, availability: "IN_STOCK", channel: "ONLINE",
    feedLabel: "BR", merchantCenterId: "321", priceMicros: "99900000", currencyCode: "BRL", ...extra,
  },
  metrics: { impressions: String(impressions), clicks: "0", costMicros: "0", conversions: 0 },
});

test("status de produto (conta): contagem por status, problemas por código e elegíveis sem impressão", async () => {
  const { client, calls } = fakeClient({
    rows: {
      shopping_product: [
        product("A", "NOT_ELIGIBLE", [issue("missing_gtin", "ERROR", { attributeName: "gtin", affectedRegions: ["BR"] })]),
        product("B", "NOT_ELIGIBLE", [issue("missing_gtin", "ERROR", { affectedRegions: ["PT"] }), issue("image_too_small", "WARNING")]),
        product("C", "ELIGIBLE_LIMITED", [issue("image_too_small", "WARNING")], 0),
        product("D", "ELIGIBLE", [], 0, { availability: "OUT_OF_STOCK" }),
        product("E", "ELIGIBLE", [], 500),
      ],
    },
  });
  const result = await call(client, "get_product_status", { days: 7 });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 1, "escopo de conta: sem pré-leitura");
  const query = calls.queries[0].replace(/\s+/g, " ");
  assert.match(query, /FROM shopping_product WHERE segments\.date DURING LAST_7_DAYS/);
  assert.doesNotMatch(query, /SELECT[^]*segments\.date[^]*FROM/, "data só no WHERE (UNSUPPORTED_DATE_SEGMENTATION)");
  assert.doesNotMatch(query, /shopping_product\.campaign|effective_max_cpc/, "campo de escopo de campanha fora do escopo de conta");
  const body = jsonOf<Row>(result);
  assert.deepEqual(body.por_status, { NOT_ELIGIBLE: 2, ELIGIBLE_LIMITED: 1, ELIGIBLE: 2 });
  assert.equal(body.fora_de_estoque, 1);
  const issues = body.principais_problemas as Row[];
  assert.equal(issues[0].error_code, "missing_gtin", "ERROR vem antes de WARNING");
  assert.equal(issues[0].produtos_afetados, 2);
  assert.deepEqual(issues[0].regioes_afetadas, ["BR", "PT"]);
  assert.equal(issues[1].regioes_afetadas, "todas", "affected_regions vazio = todas as regiões");
  const idle = body.elegiveis_sem_impressoes as { total: number; amostra: Row[] };
  assert.equal(idle.total, 2);
  assert.deepEqual(idle.amostra.map((p) => p.item_id), ["C", "D"]);
  assert.match(textOf(result), /1 fora de estoque/);
});

test("status de produto: severity filtra problemas; itemIds e status vão escapados no WHERE", async () => {
  const { client, calls } = fakeClient({
    rows: { shopping_product: [product("B", "NOT_ELIGIBLE", [issue("missing_gtin", "ERROR"), issue("image_too_small", "WARNING")])] },
  });
  const result = await call(client, "get_product_status", { severity: "WARNING", status: "NOT_ELIGIBLE", itemIds: ["B", "sku'1"] });
  const query = calls.queries[0];
  assert.match(query, /shopping_product\.status = 'NOT_ELIGIBLE'/);
  assert.match(query, /shopping_product\.item_id IN \('B', 'sku\\'1'\)/);
  const body = jsonOf<Row>(result);
  assert.deepEqual((body.principais_problemas as Row[]).map((i) => i.error_code), ["image_too_small"]);
  const sample = (body.produtos_com_problema as { amostra: Array<{ issues: Row[] }> }).amostra[0];
  assert.deepEqual(sample.issues.map((i) => i.code), ["image_too_small"]);
});

test("status de produto (campanha/grupo): lê o escopo antes e filtra por resource name", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "20", name: "Shopping BR", advertisingChannelType: "SHOPPING" } }],
      ad_group: [{ adGroup: { id: "30", name: "Tênis" }, campaign: { id: "20", name: "Shopping BR", advertisingChannelType: "SHOPPING" } }],
      shopping_product: [product("A", "ELIGIBLE", [], 0, { effectiveMaxCpcMicros: "1500000" })],
    },
  });
  const result = await call(client, "get_product_status", { campaignId: "20" });
  assert.equal(calls.queries.length, 2);
  assert.match(calls.queries[0], /FROM campaign/);
  assert.match(calls.queries[1], /shopping_product\.campaign = 'customers\/1234567890\/campaigns\/20'/);
  assert.match(calls.queries[1], /shopping_product\.effective_max_cpc_micros/);
  assert.equal((jsonOf<Row>(result).elegiveis_sem_impressoes as { amostra: Row[] }).amostra[0].effective_max_cpc, 1.5);

  calls.queries.length = 0;
  await call(client, "get_product_status", { campaignId: "20", adGroupId: "30" });
  assert.match(calls.queries[0], /FROM ad_group/);
  assert.match(calls.queries[1], /shopping_product\.ad_group = 'customers\/1234567890\/adGroups\/30'/);
  assert.match(calls.queries[1], /shopping_product\.campaign = /);
});

test("status de produto: Demand Gen/Vídeo/App só pedem impressões e cliques; App sem status/issues", async () => {
  const demandGen = fakeClient({
    rows: { campaign: [{ campaign: { id: "40", name: "DG", advertisingChannelType: "DEMAND_GEN" } }], shopping_product: [product("A", "ELIGIBLE", [], 5)] },
  });
  const dg = await call(demandGen.client, "get_product_status", { campaignId: "40" });
  assert.equal(dg.isError, undefined);
  assert.doesNotMatch(demandGen.calls.queries[1], /metrics\.cost_micros|metrics\.conversions/);
  assert.match(demandGen.calls.queries[1], /shopping_product\.issues/);
  assert.match(textOf(dg), /só aceita impressões e cliques/);

  const app = fakeClient({ rows: { campaign: [{ campaign: { id: "50", name: "App", advertisingChannelType: "MULTI_CHANNEL" } }] } });
  await call(app.client, "get_product_status", { campaignId: "50" });
  assert.doesNotMatch(app.calls.queries[1], /shopping_product\.status|shopping_product\.issues|cost_micros/);
  const refused = await call(app.client, "get_product_status", { campaignId: "50", status: "NOT_ELIGIBLE" });
  assert.equal(refused.isError, true);
  assert.equal(app.calls.queries.filter((q) => /FROM shopping_product/.test(q)).length, 1);
});

test("status de produto: escopo inválido é recusado sem consultar shopping_product", async () => {
  const missing = fakeClient();
  const notFound = await call(missing.client, "get_product_status", { campaignId: "20" });
  assert.equal(notFound.isError, true);
  assert.match(textOf(notFound), /Campanha 20 não encontrada/);
  assert.ok(missing.calls.queries.every((q) => !/FROM shopping_product/.test(q)));

  const search = fakeClient({ rows: { campaign: [{ campaign: { id: "20", name: "Busca", advertisingChannelType: "SEARCH" } }] } });
  const wrongType = await call(search.client, "get_product_status", { campaignId: "20" });
  assert.equal(wrongType.isError, true);
  assert.match(textOf(wrongType), /é SEARCH/);

  const pmax = fakeClient({ rows: { ad_group: [{ adGroup: { id: "30" }, campaign: { id: "20", advertisingChannelType: "PERFORMANCE_MAX" } }] } });
  const pmaxGroup = await call(pmax.client, "get_product_status", { campaignId: "20", adGroupId: "30" });
  assert.equal(pmaxGroup.isError, true);
  assert.match(textOf(pmaxGroup), /PMax não tem grupos/);

  const none = fakeClient();
  for (const args of [{ adGroupId: "30" }, { limit: 0 }, { campaignId: "x" }, { itemIds: Array.from({ length: 501 }, (_v, i) => `i${i}`) }]) {
    assert.equal((await call(none.client, "get_product_status", args)).isError, true, JSON.stringify(args).slice(0, 60));
  }
  assert.equal(none.calls.queries.length, 0);
});

// ══ get_shopping_products ══════════════════════════════════════════════

const spvRow = (segments: Row, cost: number, extra: Row = {}, campaign?: Row) => ({
  segments, metrics: metrics(cost, extra), ...(campaign ? { campaign } : {}),
});

test("get_shopping_products: sem opções mantém a query e o formato de antes", async () => {
  const { client, calls } = fakeClient({
    rows: { shopping_performance_view: [spvRow({ productItemId: "SKU1", productTitle: "Tênis" }, 100)] },
  });
  const result = await call(client, "get_shopping_products", {});
  const query = calls.queries[0].replace(/\s+/g, " ");
  assert.match(query, /SELECT segments\.product_item_id, segments\.product_title, metrics\.impressions/);
  assert.match(query, /FROM shopping_performance_view WHERE segments\.date DURING LAST_30_DAYS ORDER BY metrics\.conversions_value DESC LIMIT \d+/);
  assert.doesNotMatch(query, /campaign\./);
  assert.match(textOf(result), /^1 produto\(s\)\./);
  const [row] = jsonOf<Row[]>(result);
  assert.deepEqual(Object.keys(row), ["title", "item_id", "clicks", "impressions", "spend", "conversions", "revenue", "roas"]);
  assert.deepEqual(row, { title: "Tênis", item_id: "SKU1", clicks: 50, impressions: 1000, spend: 100, conversions: 2, revenue: 300, roas: 3 });
});

test("get_shopping_products: campanha + marca + lucro (POAS) com campaign.id no SELECT", async () => {
  const { client, calls } = fakeClient({
    rows: {
      shopping_performance_view: [
        spvRow({ productBrand: "Nike" }, 100, { revenueMicros: "500000000", grossProfitMicros: "200000000", costOfGoodsSoldMicros: "300000000", unitsSold: 5, orders: 4 }, { id: "20" }),
      ],
    },
  });
  const result = await call(client, "get_shopping_products", { campaignId: "20", groupBy: "brand", includeProfit: true });
  const query = calls.queries[0];
  assert.match(query, /segments\.product_brand/);
  assert.match(query, /campaign\.id, metrics/);
  assert.match(query, /campaign\.id = 20/);
  assert.match(query, /metrics\.gross_profit_micros/);
  assert.match(textOf(result), /1 grupo\(s\) por marca\. Filtro: campanha 20\./);
  const [row] = jsonOf<Row[]>(result);
  assert.equal(row.brand, "Nike");
  assert.equal(row.gross_profit, 200);
  assert.equal(row.poas, 2);
  assert.equal(row.margin_pct, 40);
  assert.equal(row.profit_after_ads, 100);
});

test("get_shopping_products: channelType agrega as linhas por campanha antes de ordenar e cortar", async () => {
  const { client, calls } = fakeClient({
    rows: {
      shopping_performance_view: [
        spvRow({ productBrand: "Adidas" }, 50, {}, { advertisingChannelType: "PERFORMANCE_MAX" }),
        spvRow({ productBrand: "Nike" }, 40, {}, { advertisingChannelType: "PERFORMANCE_MAX" }),
        spvRow({ productBrand: "Nike" }, 40, {}, { advertisingChannelType: "PERFORMANCE_MAX" }),
      ],
    },
  });
  const result = await call(client, "get_shopping_products", { channelType: "PERFORMANCE_MAX", groupBy: "brand", orderBy: "spend", limit: 1 });
  const query = calls.queries[0];
  assert.match(query, /campaign\.advertising_channel_type = 'PERFORMANCE_MAX'/);
  assert.match(query, /LIMIT 50000/, "linhas por campanha: sem LIMIT curto para não truncar o grupo");
  const rows = jsonOf<Row[]>(result);
  assert.deepEqual(rows.map((r) => [r.brand, r.spend]), [["Nike", 80]]);
});

test("get_shopping_products: categoria vira nome pt-BR; IS agregado vira média ponderada", async () => {
  const cat = "productCategoryConstants/LEVEL1~187";
  const { client, calls } = fakeClient({
    rows: {
      shopping_performance_view: [
        spvRow({ productCategoryLevel1: cat }, 10, { impressions: "100", searchImpressionShare: 0.5 }, { advertisingChannelType: "SHOPPING" }),
        spvRow({ productCategoryLevel1: cat }, 10, { impressions: "300", searchImpressionShare: 0.9 }, { advertisingChannelType: "SHOPPING" }),
      ],
      product_category_constant: [{
        productCategoryConstant: {
          resourceName: cat, categoryId: "187",
          localizations: [{ regionCode: "US", languageCode: "en", value: "Shoes" }, { regionCode: "BR", languageCode: "pt", value: "Calçados" }],
        },
      }],
    },
  });
  const result = await call(client, "get_shopping_products", { groupBy: "category_l1", channelType: "SHOPPING", includeImpressionShare: true });
  assert.match(calls.queries[0], /metrics\.search_impression_share/);
  assert.match(calls.queries[1].replace(/\s+/g, " "), /FROM product_category_constant WHERE product_category_constant\.resource_name IN \('productCategoryConstants\/LEVEL1~187'\)/);
  const [row] = jsonOf<Row[]>(result);
  assert.equal(row.category_l1, "Calçados");
  assert.equal(row.impression_share_pct, 80);
  assert.match(String(row.impression_share_note), /ponderada/);
});

test("get_shopping_products: orderBy profit liga o lucro e avisa quando não há dados de carrinho", async () => {
  const { client, calls } = fakeClient({ rows: { shopping_performance_view: [spvRow({ productItemId: "A", productTitle: "A" }, 10)] } });
  const result = await call(client, "get_shopping_products", { orderBy: "profit" });
  assert.match(calls.queries[0], /ORDER BY metrics\.gross_profit_micros DESC/);
  assert.match(calls.queries[0], /metrics\.revenue_micros/);
  assert.match(textOf(result), /Sem dados de carrinho/);
  const invalid = fakeClient();
  for (const args of [{ campaignId: "20 OR 1=1" }, { limit: 0 }, { limit: 1.5 }]) {
    assert.equal((await call(invalid.client, "get_shopping_products", args)).isError, true);
  }
  assert.equal(invalid.calls.queries.length, 0);
});

// ══ get_listing_group_performance ══════════════════════════════════════

test("listing groups PMax: lê o tipo da campanha, rotula o caminho e traduz a categoria", async () => {
  const lg = (id: string, type: string, dimensions: Row[], cost: number) => ({
    campaign: { id: "10" }, assetGroup: { id: "77", name: "Calçados" },
    assetGroupListingGroupFilter: { id, type, path: { dimensions } },
    metrics: metrics(cost),
  });
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "10", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX" } }],
      asset_group_product_group_view: [
        lg("1", "SUBDIVISION", [], 100),
        lg("2", "UNIT_INCLUDED", [{ productBrand: { value: "Nike" } }], 70),
        lg("3", "UNIT_INCLUDED", [{ productBrand: {} }], 20),
        lg("4", "UNIT_EXCLUDED", [{ productCategory: { categoryId: "187", level: "LEVEL1" } }], 10),
      ],
      product_category_constant: [{ productCategoryConstant: { resourceName: "x", categoryId: "187", localizations: [{ languageCode: "pt", regionCode: "BR", value: "Calçados" }] } }],
    },
  });
  const result = await call(client, "get_listing_group_performance", { campaignId: "10", onlyUnits: true });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries[1], /FROM asset_group_product_group_view/);
  assert.match(calls.queries[1], /asset_group_listing_group_filter\.path/);
  assert.match(calls.queries[2], /product_category_constant\.category_id IN \(187\)/);
  const body = jsonOf<{ grupos: Row[] }>(result);
  assert.deepEqual(body.grupos.map((g) => g.path), ["Marca: Nike", "Marca: (outros)", "Categoria L1: Calçados (187)"]);
  assert.ok(body.grupos.every((g) => g.type !== "SUBDIVISION"), "onlyUnits tira as subdivisões");
});

test("listing groups Shopping: product_group_view por grupo de anúncios, com lance e exclusão", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [{ adGroup: { id: "30", name: "Tênis" }, campaign: { id: "20", advertisingChannelType: "SHOPPING" } }],
      product_group_view: [{
        campaign: { id: "20" }, adGroup: { id: "30", name: "Tênis" },
        adGroupCriterion: {
          criterionId: "5", negative: true, cpcBidMicros: "750000",
          listingGroup: { type: "UNIT", path: { dimensions: [{ productType: { value: "corrida", level: "LEVEL1" } }, { productCustomAttribute: { value: "promo", index: "INDEX0" } }] } },
        },
        metrics: metrics(5),
      }],
    },
  });
  const result = await call(client, "get_listing_group_performance", { adGroupId: "30", includeProfit: true, format: "table" });
  assert.match(calls.queries[1], /FROM product_group_view/);
  assert.match(calls.queries[1], /ad_group\.id = 30/);
  assert.match(calls.queries[1], /metrics\.gross_profit_micros/);
  const out = textOf(result);
  assert.match(out, /Tipo L1: corrida > Rótulo 0: promo/);
  assert.match(out, /UNIT \(excluído\)/);
  assert.match(out, /0\.75/);
});

test("listing groups: escopo ausente, duplo ou de campanha sem produtos é recusado", async () => {
  const none = fakeClient();
  assert.equal((await call(none.client, "get_listing_group_performance", {})).isError, true);
  assert.equal((await call(none.client, "get_listing_group_performance", { assetGroupId: "1", adGroupId: "2" })).isError, true);
  assert.equal(none.calls.queries.length, 0);
  const search = fakeClient({ rows: { campaign: [{ campaign: { id: "10", advertisingChannelType: "SEARCH" } }] } });
  const result = await call(search.client, "get_listing_group_performance", { campaignId: "10" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /só existem em Performance Max e Shopping/);
  assert.equal(search.calls.queries.length, 1);
});

// ══ get_cart_data_sales ════════════════════════════════════════════════

test("vendas com carrinho: produto vendido por padrão; clicado + campanha por marca", async () => {
  const { client, calls } = fakeClient({
    rows: {
      cart_data_sales_view: (query: string) => /product_sold_item_id/.test(query)
        ? [{ segments: { productSoldItemId: "SKU9", productSoldTitle: "Meia" }, metrics: { revenueMicros: "80000000", grossProfitMicros: "20000000", unitsSold: 4, crossSellRevenueMicros: "80000000", crossSellUnitsSold: 4 } }]
        : [{ segments: { productBrand: "Nike" }, campaign: { id: "20" }, metrics: { revenueMicros: "100000000", grossProfitMicros: "50000000", unitsSold: 2 } }],
    },
  });
  const sold = await call(client, "get_cart_data_sales", {});
  assert.match(calls.queries[0], /FROM cart_data_sales_view/);
  assert.match(calls.queries[0], /segments\.product_sold_item_id, segments\.product_sold_title/);
  assert.match(calls.queries[0], /ORDER BY metrics\.revenue_micros DESC/);
  const [row] = jsonOf<Row[]>(sold);
  assert.deepEqual(row, { ...row, item_id: "SKU9", title: "Meia", revenue: 80, gross_profit: 20, margin_pct: 25, cross_sell_units: 4 });

  const clicked = await call(client, "get_cart_data_sales", { perspective: "clicked", groupBy: "brand", campaignId: "20", orderBy: "profit" });
  assert.match(calls.queries[1], /segments\.product_brand, campaign\.id/);
  assert.match(calls.queries[1], /campaign\.id = 20/);
  assert.match(calls.queries[1], /ORDER BY metrics\.gross_profit_micros DESC/);
  assert.equal(jsonOf<Row[]>(clicked)[0].brand, "Nike");
});

test("vendas com carrinho: canal só do lado clicado; view vazia avisa que falta dado de carrinho", async () => {
  const { client, calls } = fakeClient();
  const bad = await call(client, "get_cart_data_sales", { groupBy: "channel" });
  assert.equal(bad.isError, true);
  assert.equal(calls.queries.length, 0);
  const empty = await call(client, "get_cart_data_sales", { groupBy: "channel", perspective: "clicked" });
  assert.match(calls.queries[0], /segments\.product_channel/);
  assert.match(textOf(empty), /Sem dados de carrinho/);
});

// ══ suggest_brands / list_brand_lists ══════════════════════════════════

test("suggest_brands: chama :suggestBrands com o prefixo e as marcas já escolhidas", async () => {
  const { client, calls } = fakeClient({
    customerAction: () => ({ brands: [{ id: "/m/0nike", name: "Nike", urls: ["nike.com"], state: "ENABLED" }] }),
  });
  const result = await call(client, "suggest_brands", { prefix: " nik ", excludeBrandIds: ["/m/0adidas"] });
  assert.deepEqual(calls.actions, [{ action: ":suggestBrands", body: { brandPrefix: "nik", selectedBrands: ["/m/0adidas"] } }]);
  assert.deepEqual(jsonOf<Row[]>(result), [{ id: "/m/0nike", name: "Nike", state: "ENABLED", urls: ["nike.com"] }]);
  const empty = await call(client, "suggest_brands", { prefix: "  " });
  assert.equal(empty.isError, true);
  assert.equal(calls.actions.length, 1);
});

test("suggest_brands de ponta a ponta: POST /customers/{id}:suggestBrands, liberado no modo leitura", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Row });
    return new Response(JSON.stringify({ brands: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({
      credentials: { token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token", client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z" },
      developerToken: "d", loginCustomerId: CID, readOnly: true,
    });
    const handlers = register(client, { readOnly: true });
    assert.ok(handlers.has("suggest_brands") && handlers.has("list_brand_lists"));
    assert.ok(!handlers.has("create_brand_list") && !handlers.has("attach_brand_list"), "escritas fora do modo leitura");
    await handlers.get("suggest_brands")!({ customerId: "123-456-7890", prefix: "nik" });
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/v\d+\/customers\/1234567890:suggestBrands$/);
    assert.deepEqual(sent[0].body, { brandPrefix: "nik" });
  } finally {
    globalThis.fetch = original;
  }
});

const SET_RN = `customers/${CID}/sharedSets/555`;
const brandSetRow = (extra: Row = {}) => ({
  sharedSet: { id: "555", resourceName: SET_RN, name: "Concorrentes", type: "BRANDS", status: "ENABLED", memberCount: "2", referenceCount: "1", ...extra },
});
const member = (entityId: string, criterionId: string, status = "ENABLED", extra: Row = {}) => ({
  sharedCriterion: {
    sharedSet: SET_RN, criterionId, resourceName: `customers/${CID}/sharedCriteria/555~${criterionId}`,
    brand: { entityId, displayName: `Marca ${entityId}`, primaryUrl: "x.com", status, ...extra },
  },
});

test("list_brand_lists: marcas com estado, anexos por campanha/grupo e aviso de marca rejeitada", async () => {
  const { client, calls } = fakeClient({
    rows: {
      shared_set: [brandSetRow()],
      shared_criterion: [member("/m/0a", "1"), member("/m/0b", "2", "REJECTED", { rejectionReason: "NOT_A_BRAND" })],
      campaign_criterion: [{
        campaign: { id: "10", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX", pmaxCampaignSettings: { brandTargetingOverrides: { ignoreExclusionsForShoppingAds: true } } },
        campaignCriterion: { criterionId: "9", negative: true, status: "ENABLED", brandList: { sharedSet: SET_RN } },
      }],
      ad_group_criterion: [{
        campaign: { id: "20", name: "Busca" }, adGroup: { id: "30", name: "Tênis" },
        adGroupCriterion: { criterionId: "8", negative: false, status: "ENABLED", brandList: { sharedSet: SET_RN } },
      }],
    },
  });
  const result = await call(client, "list_brand_lists", {});
  assert.match(calls.queries[0], /shared_set\.type = 'BRANDS' AND shared_set\.status = 'ENABLED'/);
  assert.match(calls.queries[1], /FROM shared_criterion/);
  assert.match(calls.queries[2], /campaign_criterion\.type = 'BRAND_LIST'/);
  assert.match(calls.queries[3], /ad_group_criterion\.type = 'BRAND_LIST'/);
  assert.match(textOf(result), /1 marca\(s\) sem efeito \(Marca \/m\/0b=REJECTED\/NOT_A_BRAND\)/);
  const [list] = jsonOf<Array<Row & { attached_campaigns: Row[]; attached_ad_groups: Row[]; brands: Row[] }>>(result);
  assert.equal(list.brands.length, 2);
  assert.deepEqual(list.attached_campaigns[0], {
    campaign_id: "10", campaign_name: "PMax", channel_type: "PERFORMANCE_MAX", mode: "EXCLUDE", criterion_id: "9", status: "ENABLED",
    ignore_exclusions_for_shopping_ads: true,
  });
  assert.equal(list.attached_ad_groups[0].mode, "INCLUDE");

  const foreign = await call(client, "list_brand_lists", { sharedSetId: "customers/999/sharedSets/1" });
  assert.equal(foreign.isError, true);
});

// ══ create_brand_list ══════════════════════════════════════════════════

test("create_brand_list: uma chamada atômica com ID temporário e marcas sem repetição", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_brand_list", { name: "Concorrentes", brandIds: ["/m/0a", "/m/0b", "/m/0a"] });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries[0], /shared_set\.name = 'Concorrentes'/);
  assert.equal(calls.writes.length, 1);
  const [write] = calls.writes;
  assert.equal(write.method, "batchMutate");
  const temp = `customers/${CID}/sharedSets/-1`;
  assert.deepEqual(write.operations, [
    { sharedSetOperation: { create: { resourceName: temp, name: "Concorrentes", type: "BRANDS" } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, brand: { entityId: "/m/0a" } } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, brand: { entityId: "/m/0b" } } } },
  ]);
  assert.match(textOf(result), /criada \(ID 555\) com 2 marca\(s\)/);
});

test("create_brand_list: nome repetido, marcas vazias ou inválidas não gravam", async () => {
  const dup = fakeClient({ rows: { shared_set: [brandSetRow()] } });
  const result = await call(dup.client, "create_brand_list", { name: "Concorrentes", brandIds: ["/m/0a"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Já existe a lista de marcas "Concorrentes" \(ID 555\)/);
  assert.equal(dup.calls.writes.length, 0);

  const none = fakeClient();
  for (const args of [{ name: "X", brandIds: [] }, { name: " ", brandIds: ["/m/0a"] }, { name: "X", brandIds: ["com espaço"] }, { name: "x".repeat(256), brandIds: ["/m/0a"] }]) {
    assert.equal((await call(none.client, "create_brand_list", args)).isError, true);
  }
  assert.equal(none.calls.queries.length + none.calls.writes.length, 0);
});

test("create_brand_list: erro da API vem traduzido e diz que nada foi criado", async () => {
  const { client } = fakeClient({
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The brand criteria has a brand input that is not recognized as a valid brand."); },
  });
  const result = await call(client, "create_brand_list", { name: "X", brandIds: ["Nike"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Marca não reconhecida: use o id devolvido por suggest_brands/);
  assert.match(textOf(result), /Nada foi criado/);
});

test("create_brand_list com validateOnly: roda em dry-run (não é encadeada) e não diz que criou", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_brand_list", { name: "X", brandIds: ["/m/0a"], validateOnly: true });
  assert.equal(result.isError, undefined);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /criada/);
});

test("create_brand_list de ponta a ponta: googleAds:mutate com validateOnly e IDs temporários", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Row });
    return new Response(JSON.stringify(url.endsWith(":searchStream") ? [] : {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({
      credentials: { token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token", client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z" },
      developerToken: "d", loginCustomerId: CID,
    });
    await register(client).get("create_brand_list")!({ customerId: CID, name: "X", brandIds: ["/m/0a"], validateOnly: true });
    const writes = sent.filter((s) => !s.url.endsWith(":searchStream"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal((writes[0].body.mutateOperations as Row[]).length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

// ══ update_brand_list ══════════════════════════════════════════════════

const brandListFake = (opts: FakeOptions = {}) =>
  fakeClient({ ...opts, rows: { shared_set: [brandSetRow()], shared_criterion: [member("/m/0a", "1"), member("/m/0b", "2")], ...(opts.rows ?? {}) } });

test("update_brand_list: adiciona só o que falta; tudo já presente não grava", async () => {
  const { client, calls } = brandListFake();
  const noop = await call(client, "update_brand_list", { sharedSetId: "555", add: ["/m/0a"] });
  assert.equal(noop.isError, undefined);
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(calls.writes.length, 0);

  const result = await call(client, "update_brand_list", { sharedSetId: SET_RN, add: ["/m/0a", "/m/0c"] });
  assert.equal(result.isError, false);
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0], {
    method: "mutate", resource: "sharedCriteria", dryRun: false, options: { partialFailure: true },
    operations: [{ create: { sharedSet: SET_RN, brand: { entityId: "/m/0c" } } }],
  });
  assert.match(textOf(result), /\+1 \/ -0/);
});

test("update_brand_list: remover exige confirm; com confirm manda remove + create e relata erro por item", async () => {
  const { client, calls } = brandListFake({
    mutate: (_resource, operations) => ({
      results: operations.map((_op, i) => (i === 1 ? {} : { resourceName: "ok" })),
      partialFailureError: {
        message: "falhou",
        details: [{ errors: [{ message: "The brand criteria has a brand input that is not recognized as a valid brand.", errorCode: { criterionError: "CANNOT_RECOGNIZE_BRAND" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const preview = await call(client, "update_brand_list", { sharedSetId: "555", remove: ["/m/0b"] });
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /exige confirm: true/);
  assert.equal(calls.writes.length, 0);

  const result = await call(client, "update_brand_list", { sharedSetId: "555", remove: ["2"], add: ["/m/0z", "Nike"], confirm: true });
  assert.equal(result.isError, true, "uma operação falhou");
  assert.deepEqual(calls.writes[0].operations, [
    { create: { sharedSet: SET_RN, brand: { entityId: "/m/0z" } } },
    { create: { sharedSet: SET_RN, brand: { entityId: "Nike" } } },
    { remove: `customers/${CID}/sharedCriteria/555~2` },
  ]);
  const body = jsonOf<{ resultado: Row; erros: Row[] }>(result);
  assert.deepEqual(body.resultado.adicionadas, ["/m/0z"]);
  assert.deepEqual(body.resultado.removidas, ["/m/0b"]);
  assert.equal(body.erros[0].marca, "Nike");
  assert.match(String(body.erros[0].error), /use o id devolvido por suggest_brands/);
});

test("update_brand_list: renomeia só com updateMask name e recusa nome já usado", async () => {
  const { client, calls } = brandListFake();
  const result = await call(client, "update_brand_list", { sharedSetId: "555", name: "Revendedores" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls.writes[0].operations, [{ update: { resourceName: SET_RN, name: "Revendedores" }, updateMask: "name" }]);
  assert.equal(calls.writes[0].resource, "sharedSets");

  const clash = brandListFake({
    rows: { shared_set: (q: string) => (/shared_set\.name = /.test(q) ? [{ sharedSet: { id: "999" } }] : [brandSetRow()]) },
  });
  const refused = await call(clash.client, "update_brand_list", { sharedSetId: "555", name: "Outra" });
  assert.equal(refused.isError, true);
  assert.equal(clash.calls.writes.length, 0);
});

test("update_brand_list: shared set de outro tipo ou removido não é tocado", async () => {
  const negatives = brandListFake({ rows: { shared_set: [brandSetRow({ type: "NEGATIVE_KEYWORDS" })] } });
  const wrong = await call(negatives.client, "update_brand_list", { sharedSetId: "555", add: ["/m/0c"] });
  assert.equal(wrong.isError, true);
  assert.match(textOf(wrong), /não BRANDS/);
  const removed = brandListFake({ rows: { shared_set: [brandSetRow({ status: "REMOVED" })] } });
  assert.equal((await call(removed.client, "update_brand_list", { sharedSetId: "555", add: ["/m/0c"] })).isError, true);
  assert.equal(negatives.calls.writes.length + removed.calls.writes.length, 0);
  const none = fakeClient();
  assert.equal((await call(none.client, "update_brand_list", { sharedSetId: "555" })).isError, true);
  assert.equal((await call(none.client, "update_brand_list", { sharedSetId: "555", add: ["/m/0a"], remove: ["/m/0a"] })).isError, true);
  assert.equal(none.calls.queries.length, 0);
});

test("update_brand_list com validateOnly: adicionar, remover e renomear rodam em dry-run e não dizem que gravaram", async () => {
  const { client, calls } = brandListFake();
  const result = await call(client, "update_brand_list", {
    sharedSetId: "555", add: ["/m/0c"], remove: ["/m/0b"], name: "Revendedores", confirm: true, validateOnly: true,
  });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(calls.writes.length, 2, "renomear + marcas");
  assert.ok(calls.writes.every((w) => w.dryRun), "toda escrita vai em validate_only");
  assert.deepEqual(calls.writes.map((w) => w.resource), ["sharedSets", "sharedCriteria"]);
  assert.deepEqual(calls.writes[1].operations, [
    { create: { sharedSet: SET_RN, brand: { entityId: "/m/0c" } } },
    { remove: `customers/${CID}/sharedCriteria/555~2` },
  ]);
  const out = textOf(result);
  assert.match(out, /^VALIDATE-ONLY/);
  assert.match(out, /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(out, /atualizada|adicionadas|removidas|renomeada|não confirmou/);
  const body = jsonOf<{ resultado: Row; erros: Row[] }>(result);
  assert.deepEqual(body.resultado, {
    renomearia: { from: "Concorrentes", to: "Revendedores" }, adicionariam: ["/m/0c"], removeriam: ["/m/0b"],
  });
  assert.deepEqual(body.erros, []);
});

test("update_brand_list em dry-run do servidor: só remover também não diz que removeu", async () => {
  const { client, calls } = brandListFake({ dryRun: true });
  const result = await call(client, "update_brand_list", { sharedSetId: "555", remove: ["/m/0a"], confirm: true });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /atualizada|removidas/);
  assert.deepEqual(jsonOf<{ resultado: Row }>(result).resultado, { adicionariam: [], removeriam: ["/m/0a"] });
});

// ══ attach_brand_list / detach_brand_list ══════════════════════════════

const campaignRow = (channel: string, extra: Row = {}) => ({
  campaign: { id: "10", name: "Campanha", status: "ENABLED", advertisingChannelType: channel, aiMaxSetting: { enableAiMax: false, bundlingRequired: "NOT_REQUIRED" }, ...extra },
});

const attachFake = (channel: string, extra: Row = {}, opts: FakeOptions = {}) =>
  fakeClient({ ...opts, rows: { shared_set: [brandSetRow()], campaign: [campaignRow(channel, extra)], ...(opts.rows ?? {}) } });

test("attach_brand_list PMax: exclusão + override de Shopping numa chamada atômica (updateMask folha)", async () => {
  const { client, calls } = attachFake("PERFORMANCE_MAX");
  const result = await call(client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE", ignoreExclusionsForShoppingAds: true });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries.find((q) => /FROM campaign_criterion/.test(q)) ?? "", /campaign_criterion\.type = 'BRAND_LIST'/);
  assert.equal(calls.writes.length, 1);
  const ops = calls.writes[0].operations as Array<Record<string, Row>>;
  assert.deepEqual(ops[0], { campaignCriterionOperation: { create: { campaign: `customers/${CID}/campaigns/10`, negative: true, brandList: { sharedSet: SET_RN } } } });
  const update = ops[1].campaignOperation as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(update.updateMask);
  assert.equal(update.updateMask, "pmax_campaign_settings.brand_targeting_overrides.ignore_exclusions_for_shopping_ads");
  assert.deepEqual(update.update, { resourceName: `customers/${CID}/campaigns/10`, pmaxCampaignSettings: { brandTargetingOverrides: { ignoreExclusionsForShoppingAds: true } } });
});

test("attach_brand_list: regras por canal recusam antes de gravar", async () => {
  const cases: Array<[string, Row, Row, RegExp]> = [
    ["PERFORMANCE_MAX", {}, { mode: "INCLUDE" }, /só aceita listas de marcas como exclusão/],
    ["SHOPPING", {}, { mode: "INCLUDE" }, /só é suportada como exclusão/],
    ["SEARCH", {}, { mode: "INCLUDE" }, /exige AI Max ligado/],
    ["SEARCH", { aiMaxSetting: { enableAiMax: false, bundlingRequired: "REQUIRED" } }, { mode: "EXCLUDE" }, /bundling_required = REQUIRED/],
    ["DISPLAY", {}, { mode: "EXCLUDE" }, /Pesquisa, Performance Max e Shopping/],
    ["SEARCH", { aiMaxSetting: { enableAiMax: true } }, { mode: "EXCLUDE", ignoreExclusionsForShoppingAds: true }, /só existe em Performance Max e Shopping/],
    ["SEARCH", { status: "REMOVED" }, { mode: "EXCLUDE" }, /foi removida/],
  ];
  for (const [channel, extra, args, message] of cases) {
    const { client, calls } = attachFake(channel, extra);
    const result = await call(client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", ...args });
    assert.equal(result.isError, true, `${channel} ${JSON.stringify(args)}`);
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length, 0);
  }
});

test("attach_brand_list Pesquisa: inclusão com AI Max ligado ou broad match legado; exclusão sem AI Max", async () => {
  const withAiMax = attachFake("SEARCH", { aiMaxSetting: { enableAiMax: true, bundlingRequired: "REQUIRED" } });
  assert.equal((await call(withAiMax.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "INCLUDE" })).isError, undefined);
  const create = (withAiMax.calls.writes[0].operations[0] as Record<string, Row>).campaignCriterionOperation.create as Row;
  assert.equal(create.negative, false);

  const legacyBroad = attachFake("SEARCH", { keywordMatchType: "BROAD" });
  assert.equal((await call(legacyBroad.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "INCLUDE" })).isError, undefined);

  const exclude = attachFake("SEARCH");
  assert.equal((await call(exclude.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE" })).isError, undefined);
  assert.equal(exclude.calls.writes.length, 1);
});

test("attach_brand_list em grupo de anúncios: só inclusão em Pesquisa com AI Max", async () => {
  const adGroupRow = (extra: Row = {}) => ({
    adGroup: { id: "30", name: "Tênis", status: "ENABLED" },
    campaign: { id: "10", name: "Busca", status: "ENABLED", advertisingChannelType: "SEARCH", aiMaxSetting: { enableAiMax: true }, ...extra },
  });
  const ok = fakeClient({ rows: { shared_set: [brandSetRow()], ad_group: [adGroupRow()] } });
  const result = await call(ok.client, "attach_brand_list", { sharedSetId: "555", adGroupId: "30", mode: "INCLUDE" });
  assert.equal(result.isError, undefined);
  assert.match(ok.calls.queries.find((q) => /FROM ad_group_criterion/.test(q)) ?? "", /ad_group\.id = 30/);
  assert.deepEqual(ok.calls.writes[0].operations, [
    { adGroupCriterionOperation: { create: { adGroup: `customers/${CID}/adGroups/30`, negative: false, brandList: { sharedSet: SET_RN } } } },
  ]);

  const exclude = fakeClient({ rows: { shared_set: [brandSetRow()], ad_group: [adGroupRow()] } });
  const refused = await call(exclude.client, "attach_brand_list", { sharedSetId: "555", adGroupId: "30", mode: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /só aceita a lista como inclusão/);
  assert.equal(exclude.calls.writes.length, 0);
});

test("attach_brand_list: já anexada no mesmo modo não grava; em modo oposto pede detach", async () => {
  const link = (negative: boolean) => [{ campaignCriterion: { criterionId: "9", resourceName: `customers/${CID}/campaignCriteria/10~9`, negative, status: "ENABLED", brandList: { sharedSet: SET_RN } } }];
  const same = attachFake("PERFORMANCE_MAX", { pmaxCampaignSettings: { brandTargetingOverrides: { ignoreExclusionsForShoppingAds: true } } }, { rows: { campaign_criterion: link(true) } });
  const noop = await call(same.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE", ignoreExclusionsForShoppingAds: true });
  assert.equal(noop.isError, undefined);
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(same.calls.writes.length, 0);

  const toggleOnly = attachFake("PERFORMANCE_MAX", {}, { rows: { campaign_criterion: link(true) } });
  await call(toggleOnly.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE", ignoreExclusionsForShoppingAds: true });
  assert.equal(toggleOnly.calls.writes[0].operations.length, 1, "só o override muda");
  assert.ok("campaignOperation" in toggleOnly.calls.writes[0].operations[0]);

  const opposite = attachFake("SEARCH", { aiMaxSetting: { enableAiMax: true } }, { rows: { campaign_criterion: link(false) } });
  const refused = await call(opposite.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /detach_brand_list/);
  assert.equal(opposite.calls.writes.length, 0);
});

test("attach_brand_list Shopping: override usa shopping_setting.ignore_brand_exclusion_in_shopping_ads", async () => {
  const { client, calls } = attachFake("SHOPPING");
  await call(client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE", ignoreExclusionsForShoppingAds: true });
  const update = (calls.writes[0].operations[1] as Record<string, { update: Row; updateMask: string }>).campaignOperation;
  assert.equal(update.updateMask, "shopping_setting.ignore_brand_exclusion_in_shopping_ads");
  assert.deepEqual(update.update.shoppingSetting, { ignoreBrandExclusionInShoppingAds: true });
});

test("attach_brand_list: entrada inválida, lista inexistente e erro da API", async () => {
  const none = fakeClient();
  for (const args of [
    { sharedSetId: "555", mode: "EXCLUDE" },
    { sharedSetId: "555", campaignId: "10", adGroupId: "30", mode: "EXCLUDE" },
    { sharedSetId: "abc", campaignId: "10", mode: "EXCLUDE" },
    { sharedSetId: "555", adGroupId: "30", mode: "INCLUDE", ignoreExclusionsForShoppingAds: true },
  ]) {
    assert.equal((await call(none.client, "attach_brand_list", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(none.calls.queries.length, 0);
  const missing = await call(none.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE" });
  assert.match(textOf(missing), /Lista 555 não encontrada/);
  assert.equal(none.calls.writes.length, 0);

  const apiError = attachFake("SEARCH", { aiMaxSetting: { enableAiMax: true } }, {
    batchMutate: () => { throw new Error("Google Ads API: invalid — CANNOT_ATTACH_BRAND_LIST_TO_NON_QUALIFIED_SEARCH_CAMPAIGN"); },
  });
  const failed = await call(apiError.client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "INCLUDE" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Ligue com set_ai_max_settings/);
  assert.match(textOf(failed), /Nada foi alterado/);
});

test("attach_brand_list em dry-run: valida e avisa que nada foi gravado", async () => {
  const { client, calls } = attachFake("PERFORMANCE_MAX", {}, { dryRun: true });
  const result = await call(client, "attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE" });
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /anexada à/);
});

test("detach_brand_list: exige confirm, remove o critério e é no-op quando não está anexada", async () => {
  const link = [{ campaignCriterion: { criterionId: "9", resourceName: `customers/${CID}/campaignCriteria/10~9`, negative: true, status: "ENABLED", brandList: { sharedSet: SET_RN } } }];
  const { client, calls } = attachFake("PERFORMANCE_MAX", {}, { rows: { campaign_criterion: link } });
  const preview = await call(client, "detach_brand_list", { sharedSetId: "555", campaignId: "10" });
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /exige confirm: true/);
  assert.equal(calls.writes.length, 0);

  const result = await call(client, "detach_brand_list", { sharedSetId: "555", campaignId: "10", confirm: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.writes[0], {
    method: "mutate", resource: "campaignCriteria", dryRun: false, options: undefined,
    operations: [{ remove: `customers/${CID}/campaignCriteria/10~9` }],
  });

  const notAttached = attachFake("PERFORMANCE_MAX");
  const noop = await call(notAttached.client, "detach_brand_list", { sharedSetId: "555", campaignId: "10", confirm: true });
  assert.equal(noop.isError, undefined);
  assert.match(textOf(noop), /não está anexada/);
  assert.equal(notAttached.calls.writes.length, 0);
});

test("detach_brand_list com validateOnly ou dry-run: valida o remove e não diz que desanexou", async () => {
  const link = [{ campaignCriterion: { criterionId: "9", resourceName: `customers/${CID}/campaignCriteria/10~9`, negative: true, status: "ENABLED", brandList: { sharedSet: SET_RN } } }];
  const viaParam = attachFake("PERFORMANCE_MAX", {}, { rows: { campaign_criterion: link } });
  const serverDryRun = attachFake("PERFORMANCE_MAX", {}, { rows: { campaign_criterion: link }, dryRun: true });
  for (const [fake, args] of [[viaParam, { validateOnly: true }], [serverDryRun, {}]] as const) {
    const result = await call(fake.client, "detach_brand_list", { sharedSetId: "555", campaignId: "10", confirm: true, ...args });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(fake.calls.writes.length, 1);
    assert.equal(fake.calls.writes[0].dryRun, true);
    assert.deepEqual(fake.calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/10~9` }]);
    const out = textOf(result);
    assert.match(out, /DRY-RUN \(validateOnly\): validado, nada foi gravado\. A lista 555 sairia/);
    assert.doesNotMatch(out, /desanexada|"removidos"/);
    assert.deepEqual(Object.keys(jsonOf(result)), ["seriam_removidos"]);
  }
  assert.match(textOf(await call(viaParam.client, "detach_brand_list", { sharedSetId: "555", campaignId: "10", confirm: true, validateOnly: true })), /^VALIDATE-ONLY/);
});

// ══ Guarda de conta ════════════════════════════════════════════════════

test("conta fora da allowlist é recusada antes de qualquer consulta ou escrita", async () => {
  const { client, calls } = fakeClient();
  const handlers = register(client, { allowed: ["9999999999"], hosted: true });
  for (const [tool, args] of [
    ["get_pmax_channel_performance", {}],
    ["get_product_status", {}],
    ["get_shopping_products", {}],
    ["get_cart_data_sales", {}],
    ["get_listing_group_performance", { campaignId: "10" }],
    ["suggest_brands", { prefix: "nik" }],
    ["list_brand_lists", {}],
    ["create_brand_list", { name: "X", brandIds: ["/m/0a"] }],
    ["update_brand_list", { sharedSetId: "555", add: ["/m/0a"] }],
    ["attach_brand_list", { sharedSetId: "555", campaignId: "10", mode: "EXCLUDE" }],
    ["detach_brand_list", { sharedSetId: "555", campaignId: "10", confirm: true }],
  ] as Array<[string, Row]>) {
    const result = await handlers.get(tool)!({ customerId: CID, ...args });
    assert.equal(result.isError, true, tool);
    assert.match(textOf(result), /Access denied/);
  }
  assert.equal(calls.queries.length + calls.writes.length + calls.actions.length, 0);
});
