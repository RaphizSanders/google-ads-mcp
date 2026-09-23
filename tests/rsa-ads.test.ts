/**
 * Lote rsa-ads: RSA com fixação (pin), auditoria de anúncios, relatório de assets sem o rótulo
 * que a API deixou de devolver, customizadores e migração dos anúncios só de chamada.
 *
 * O bug que abriu o lote: update_ad reenviava os títulos só como texto e apagava todos os pins
 * (inclusive marca/aviso legal fixados em HEADLINE_1) numa edição de rotina. Estes testes fixam
 * que a edição lê o anúncio antes, preserva os pins dos textos mantidos e só envia o que muda.
 *
 * Client falso: toda query passa por assertGaqlRules (metadados reais da v25) e toda escrita é
 * registrada, com o modo (real ou validateOnly) em que foi feita.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { createMcpServer } from "../src/server.js";
import { VALIDATE_ONLY_BANNER } from "../src/tool-kit.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type RowSource = Row[] | ((query: string) => Row[]);

const CID = "1234567890";
const AG = "555";
const AD = "777";
const CAMPAIGN = "111";

interface FakeOptions {
  rows?: Record<string, RowSource>;
  mutate?: (resource: string, operations: Row[], dryRun: boolean) => Row | Promise<Row>;
  batchMutate?: (operations: Row[]) => Row;
  mutateAdGroupAds?: (operations: Row[]) => Row;
}

interface Write {
  method: string;
  resource?: string;
  operations: Row[];
  dryRun: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[] };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      return typeof source === "function" ? source(query) : source ?? [];
    },
    async mutate(_customerId: string, resource: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, dryRun });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(resource, operations, dryRun);
      return dryRun ? {} : { results: operations.map((_, i) => ({ resourceName: `customers/${CID}/${resource}/${900 + i}` })) };
    },
    async mutateAdGroupAds(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroupAds", operations, dryRun });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutateAdGroupAds) return opts.mutateAdGroupAds(operations);
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/adGroupAds/${AG}~999` }] };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      return dryRun ? {} : { mutateOperationResponses: operations.map(() => ({ adGroupAdResult: { resourceName: "x" } })) };
    },
  });
  return { client: build(false), calls };
}

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: Row, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row) => register(client).get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf<T = Row>(result: Result): T {
  const body = textOf(result);
  const start = body.search(/\n\n[[{]/);
  assert.ok(start >= 0, `sem JSON na resposta:\n${body}`);
  return JSON.parse(body.slice(start + 2)) as T;
}

// ── Linhas de exemplo ─────────────────────────────────────────────────

const adGroupRow = (overrides: { adGroup?: Row; campaign?: Row } = {}): Row => ({
  adGroup: { id: AG, name: "Tênis Corrida", status: "ENABLED", type: "SEARCH_STANDARD", ...overrides.adGroup },
  campaign: { id: CAMPAIGN, name: "Pesquisa Loja", status: "ENABLED", advertisingChannelType: "SEARCH", ...overrides.campaign },
});

const HEADLINES = [
  { text: "Loja Oficial Marca X", pinnedField: "HEADLINE_1" },
  { text: "Frete Grátis Brasil" },
  { text: "Tênis de Corrida" },
  { text: "Até 12x Sem Juros" },
];
const DESCRIPTIONS = [
  { text: "Compre online com entrega rápida para todo o Brasil." },
  { text: "Troca grátis em 30 dias. Consulte condições.", pinnedField: "DESCRIPTION_1" },
];

function rsaRow(headlines: Row[] = HEADLINES, descriptions: Row[] = DESCRIPTIONS, overrides: Row = {}): Row {
  return {
    adGroupAd: {
      status: "ENABLED",
      ad: {
        id: AD,
        type: "RESPONSIVE_SEARCH_AD",
        finalUrls: ["https://loja.com.br/tenis"],
        responsiveSearchAd: { headlines, descriptions, path1: "tenis" },
      },
      ...overrides,
    },
    adGroup: { id: AG, name: "Tênis Corrida" },
    campaign: { id: CAMPAIGN, name: "Pesquisa Loja" },
  };
}

const attributeRow = (name: string, type: string, id = "42", status = "ENABLED"): Row => ({
  customizerAttribute: { id, name, type, status, resourceName: `customers/${CID}/customizerAttributes/${id}` },
});

function updateOp(calls: { writes: Write[] }): { update: Row; updateMask: string } {
  const writes = calls.writes.filter((w) => w.method === "mutate" && w.resource === "ads");
  assert.equal(writes.length, 1, "exatamente uma escrita em ads");
  assert.equal(writes[0].operations.length, 1);
  return writes[0].operations[0] as { update: Row; updateMask: string };
}

// ── create_ad ─────────────────────────────────────────────────────────

test("create_ad: pins vão como pinnedField, sem pin vai só o texto, anúncio nasce PAUSADO", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const result = await call(client, "create_ad", {
    adGroupId: AG,
    finalUrl: "https://loja.com.br/tenis",
    headlines: [{ text: "Loja Oficial Marca X", pin: "HEADLINE_1" }, "Frete Grátis Brasil", "Tênis de Corrida"],
    descriptions: ["Compre online com entrega rápida.", { text: "Troca grátis em 30 dias.", pin: "DESCRIPTION_1" }],
    path1: "tenis",
  });
  assert.ok(!result.isError, textOf(result));
  assert.equal(calls.writes.length, 1);
  const create = calls.writes[0].operations[0].create as Row;
  assert.equal(create.adGroup, `customers/${CID}/adGroups/${AG}`);
  assert.equal(create.status, "PAUSED");
  const rsa = (create.ad as Row).responsiveSearchAd as Row;
  assert.deepEqual(rsa.headlines, [
    { text: "Loja Oficial Marca X", pinnedField: "HEADLINE_1" },
    { text: "Frete Grátis Brasil" },
    { text: "Tênis de Corrida" },
  ]);
  assert.deepEqual(rsa.descriptions, [
    { text: "Compre online com entrega rápida." },
    { text: "Troca grátis em 30 dias.", pinnedField: "DESCRIPTION_1" },
  ]);
  assert.equal(rsa.path1, "tenis");
  const body = jsonOf<{ ad_id: string; warnings: string[] }>(result);
  assert.equal(body.ad_id, "999");
  assert.ok(body.warnings.some((w) => /2 posições fixadas/.test(w)), "avisa que fixar 2 posições derruba a força");
  assert.match(calls.queries[0], /FROM ad_group\b/);
});

test("create_ad: entrada inválida é recusada antes de qualquer chamada à API", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ headlines: ["A", "B"], descriptions: ["Desc um", "Desc dois"] }, /3 a 15 títulos/],
    [{ headlines: [{ text: "A", pin: "DESCRIPTION_1" }, "B", "C"], descriptions: ["D1", "D2"] }, /título só pode ser fixado em HEADLINE_1/],
    [{ headlines: ["A".repeat(31), "B", "C"], descriptions: ["D1", "D2"] }, /31 caracteres \(máx\. 30\)/],
    [{ headlines: ["A", "A", "C"], descriptions: ["D1", "D2"] }, /título repetido: "A"/],
    [{ headlines: ["A", "B", "C"], descriptions: ["D1", "D2"], path1: "caminho-longo-demais" }, /path1 .* \(máx\. 15\)/],
    [{ headlines: ["A", "B", "C"], descriptions: ["D1", "D2"], finalUrl: "loja.com.br" }, /finalUrl inválida/],
    [{ headlines: ["A", "B", "C"], descriptions: ["D1", "D2"], adGroupId: "55 OR 1=1" }, /IDs devem ser numéricos/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
    const result = await call(client, "create_ad", { adGroupId: AG, finalUrl: "https://loja.com.br", ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length + calls.writes.length, 0, `nenhuma chamada para ${JSON.stringify(args)}`);
  }
});

test("create_ad: grupo inexistente, removido ou fora de Pesquisa é recusado sem gravar", async () => {
  const base = { adGroupId: AG, finalUrl: "https://loja.com.br", headlines: ["A", "B", "C"], descriptions: ["D1", "D2"] };
  for (const [rows, expected] of [
    [[], /não encontrado/],
    [[adGroupRow({ adGroup: { status: "REMOVED" } })], /removido/],
    [[adGroupRow({ campaign: { advertisingChannelType: "DISPLAY" } })], /DISPLAY, não SEARCH/],
    [[adGroupRow({ adGroup: { type: "SEARCH_DYNAMIC_ADS" } })], /SEARCH_DYNAMIC_ADS/],
  ] as Array<[Row[], RegExp]>) {
    const { client, calls } = fakeClient({ rows: { ad_group: rows } });
    const result = await call(client, "create_ad", base);
    assert.equal(result.isError, true);
    assert.match(textOf(result), expected);
    assert.equal(calls.writes.length, 0);
  }
});

test("create_ad: {CUSTOMIZER.x} é conferido contra a conta; sem padrão gera aviso", async () => {
  const base = { adGroupId: AG, finalUrl: "https://loja.com.br", descriptions: ["D1", "D2"] };
  const missing = fakeClient({ rows: { ad_group: [adGroupRow()], customizer_attribute: [attributeRow("Preco", "PRICE")] } });
  const refused = await call(missing.client, "create_ad", { ...base, headlines: ["Por {CUSTOMIZER.Parcelas:12x}", "B", "C"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /não há atributo ativo "Parcelas".*Ativos: Preco/s);
  assert.equal(missing.calls.writes.length, 0);

  const ok = fakeClient({ rows: { ad_group: [adGroupRow()], customizer_attribute: [attributeRow("Preco", "PRICE")] } });
  const created = await call(ok.client, "create_ad", { ...base, headlines: ["Só {CUSTOMIZER.preco}", "B", "C"] });
  assert.ok(!created.isError, textOf(created));
  assert.ok(jsonOf<{ warnings: string[] }>(created).warnings.some((w) => /sem valor padrão/.test(w)));
  assert.ok(ok.calls.queries.some((q) => /FROM customizer_attribute/.test(q)));

  // sem customizador no texto: nenhuma consulta extra
  const plain = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  await call(plain.client, "create_ad", { ...base, headlines: ["A", "B", "C"] });
  assert.ok(!plain.calls.queries.some((q) => /customizer_attribute/.test(q)));
});

test("create_ad: erro da API vira mensagem clara; validateOnly grava só em modo validação", async () => {
  const failing = fakeClient({
    rows: { ad_group: [adGroupRow()] },
    mutateAdGroupAds: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Too long."); },
  });
  const refused = await call(failing.client, "create_ad", { adGroupId: AG, finalUrl: "https://loja.com.br", headlines: ["A", "B", "C"], descriptions: ["D1", "D2"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /A API recusou o anúncio: .*Too long.*\nNada foi criado/s);

  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const validated = await call(client, "create_ad", {
    adGroupId: AG, finalUrl: "https://loja.com.br", headlines: ["A", "B", "C"], descriptions: ["D1", "D2"], validateOnly: true,
  });
  assert.ok(!validated.isError, textOf(validated));
  assert.equal(validated.content[0].text, VALIDATE_ONLY_BANNER);
  assert.match(textOf(validated), /DRY-RUN \(validateOnly\)/);
  assert.deepEqual(calls.writes.map((w) => w.dryRun), [true]);
});

test("create_ad: conta fora da allowlist é negada antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const handler = register(client, ["9999999999"], true).get("create_ad")!;
  const result = await handler({ customerId: CID, adGroupId: AG, finalUrl: "https://a.com", headlines: ["A", "B", "C"], descriptions: ["D1", "D2"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Access denied/);
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

// ── update_ad ─────────────────────────────────────────────────────────

test("update_ad: trocar a lista de títulos preserva o pin dos textos mantidos (o bug original)", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const result = await call(client, "update_ad", {
    adId: AD,
    headlines: ["Loja Oficial Marca X", "Frete Grátis Brasil", "Tênis de Corrida", "Tênis em Promoção"],
  });
  assert.ok(!result.isError, textOf(result));
  const op = updateOp(calls);
  assert.equal(op.updateMask, "responsive_search_ad.headlines", "só os títulos vão no updateMask");
  assert.equal(op.update.resourceName, `customers/${CID}/ads/${AD}`);
  assert.deepEqual((op.update.responsiveSearchAd as Row).headlines, [
    { text: "Loja Oficial Marca X", pinnedField: "HEADLINE_1" },
    { text: "Frete Grátis Brasil" },
    { text: "Tênis de Corrida" },
    { text: "Tênis em Promoção" },
  ]);
  assert.equal((op.update.responsiveSearchAd as Row).descriptions, undefined, "descrições não mudaram e não são reenviadas");
  const body = jsonOf<{ changes: Array<{ field: string; before: string[]; after: string[] }>; notes: string[] }>(result);
  assert.deepEqual(body.changes[0].before[0], "Loja Oficial Marca X [HEADLINE_1]");
  assert.ok(body.notes.some((n) => /mantiveram o pin atual/.test(n)));
});

test("update_ad: pin null solta, keepExistingPins=false descarta, e sair um texto fixado é avisado", async () => {
  const unpin = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  await call(unpin.client, "update_ad", {
    adId: AD,
    headlines: [{ text: "Loja Oficial Marca X", pin: null }, "Frete Grátis Brasil", "Tênis de Corrida", "Até 12x Sem Juros"],
  });
  assert.deepEqual((updateOp(unpin.calls).update.responsiveSearchAd as Row).headlines, [
    { text: "Loja Oficial Marca X" }, { text: "Frete Grátis Brasil" }, { text: "Tênis de Corrida" }, { text: "Até 12x Sem Juros" },
  ]);

  const drop = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  await call(drop.client, "update_ad", {
    adId: AD, keepExistingPins: false,
    headlines: ["Loja Oficial Marca X", "Frete Grátis Brasil", "Tênis de Corrida", "Até 12x Sem Juros"],
  });
  assert.ok(((updateOp(drop.calls).update.responsiveSearchAd as Row).headlines as Row[]).every((h) => !h.pinnedField));

  const removed = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const result = await call(removed.client, "update_ad", {
    adId: AD, headlines: ["Frete Grátis Brasil", "Tênis de Corrida", "Até 12x Sem Juros"],
  });
  assert.ok(jsonOf<{ notes: string[] }>(result).notes.some((n) => /Saíram título\(s\) fixados: "Loja Oficial Marca X" \[HEADLINE_1\]/.test(n)));
});

test("update_ad: addHeadlines/removeHeadlines/setPins mexem só nos textos citados e mantêm os pins", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const result = await call(client, "update_ad", {
    adId: AD,
    addHeadlines: [{ text: "Compre Agora", pin: "HEADLINE_2" }],
    removeHeadlines: ["Até 12x Sem Juros"],
    setPins: [{ text: "Troca grátis em 30 dias. Consulte condições.", pin: null }],
  });
  assert.ok(!result.isError, textOf(result));
  const op = updateOp(calls);
  assert.equal(op.updateMask, "responsive_search_ad.headlines,responsive_search_ad.descriptions");
  const rsa = op.update.responsiveSearchAd as Row;
  assert.deepEqual(rsa.headlines, [
    { text: "Loja Oficial Marca X", pinnedField: "HEADLINE_1" },
    { text: "Frete Grátis Brasil" },
    { text: "Tênis de Corrida" },
    { text: "Compre Agora", pinnedField: "HEADLINE_2" },
  ]);
  assert.deepEqual(rsa.descriptions, [
    { text: "Compre online com entrega rápida para todo o Brasil." },
    { text: "Troca grátis em 30 dias. Consulte condições." },
  ]);
  assert.ok(jsonOf<{ warnings: string[] }>(result).warnings.some((w) => /2 posições fixadas \(HEADLINE_1, HEADLINE_2\)/.test(w)));
});

test("update_ad: nada muda (mesmos textos e pins em outra ordem, mesma URL) = nenhuma escrita", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const result = await call(client, "update_ad", {
    adId: AD,
    headlines: ["Até 12x Sem Juros", "Tênis de Corrida", "Frete Grátis Brasil", "Loja Oficial Marca X"],
    finalUrl: "https://loja.com.br/tenis",
    path1: "tenis",
  });
  assert.ok(!result.isError);
  assert.match(textOf(result), /nada a mudar.*Nenhuma escrita/s);
  assert.equal(calls.writes.length, 0);

  const url = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  await call(url.client, "update_ad", { adId: AD, finalUrl: "https://loja.com.br/novo", path2: "" });
  const op = updateOp(url.calls);
  assert.equal(op.updateMask, "final_urls", "path2 já vazio não entra no updateMask");
  assert.deepEqual(op.update.finalUrls, ["https://loja.com.br/novo"]);
});

test("update_ad: erros de entrada e de estado são recusados sem gravar", async () => {
  const early: Array<[Row, RegExp]> = [
    [{}, /Informe ao menos uma mudança/],
    [{ headlines: ["A", "B", "C"], addHeadlines: ["D"] }, /OU addHeadlines/],
    [{ setPins: [{ text: "X", pin: "HEADLINE_9" }] }, /pin inválido|Nada foi enviado/],
    [{ adId: "7 OR 1=1", finalUrl: "https://a.com" }, /IDs devem ser numéricos/],
  ];
  for (const [args, expected] of early) {
    const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
    const result = await call(client, "update_ad", { adId: AD, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length + calls.writes.length, 0, `nenhuma chamada para ${JSON.stringify(args)}`);
  }

  const afterRead: Array<[Row[], Row, RegExp]> = [
    [[], { finalUrl: "https://a.com" }, /não encontrado/],
    [[rsaRow()], { removeHeadlines: ["Não existe"] }, /"Não existe" não está no anúncio/],
    [[rsaRow()], { removeHeadlines: ["Frete Grátis Brasil", "Tênis de Corrida"] }, /3 a 15 títulos \(headlines\); ficariam 2/],
    [[rsaRow()], { setPins: [{ text: "Frete Grátis Brasil", pin: "DESCRIPTION_1" }] }, /é título; use HEADLINE_1/],
    [[rsaRow(HEADLINES, DESCRIPTIONS, { ad: { id: AD, type: "RESPONSIVE_DISPLAY_AD" } })], { addHeadlines: ["X"] }, /não RSA/],
  ];
  for (const [rows, args, expected] of afterRead) {
    const { client, calls } = fakeClient({ rows: { ad_group_ad: rows } });
    const result = await call(client, "update_ad", { adId: AD, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_ad: customizador novo inexistente é recusado; o que já estava no anúncio não trava a edição", async () => {
  const withRef = [...HEADLINES.slice(0, 3), { text: "Por {CUSTOMIZER.Antigo:R$99}" }];
  const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow(withRef)], customizer_attribute: [] } });
  const ok = await call(client, "update_ad", { adId: AD, addHeadlines: ["Novo Título"] });
  assert.ok(!ok.isError, textOf(ok));
  assert.ok(!calls.queries.some((q) => /customizer_attribute/.test(q)), "texto novo sem customizador não consulta atributos");

  const bad = fakeClient({ rows: { ad_group_ad: [rsaRow()], customizer_attribute: [] } });
  const refused = await call(bad.client, "update_ad", { adId: AD, addHeadlines: ["Leve {CUSTOMIZER.Parcelas:12x}"] });
  assert.equal(refused.isError, true);
  assert.equal(bad.calls.writes.length, 0);
});

test("update_ad: erro da API e validateOnly", async () => {
  const failing = fakeClient({ rows: { ad_group_ad: [rsaRow()] }, mutate: () => { throw new Error("Google Ads API: POLICY_FINDING"); } });
  const refused = await call(failing.client, "update_ad", { adId: AD, addHeadlines: ["Novo"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /A API recusou a edição .*POLICY_FINDING.*Nada foi alterado/s);

  const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const validated = await call(client, "update_ad", { adId: AD, addHeadlines: ["Novo"], validateOnly: true });
  assert.equal(validated.content[0].text, VALIDATE_ONLY_BANNER);
  assert.match(textOf(validated), /DRY-RUN/);
  assert.deepEqual(calls.writes.map((w) => w.dryRun), [true]);
});

// ── Pins pelo servidor MCP real (schema zod) ──────────────────────────
//
// Os testes acima chamam o handler direto. Aqui a chamada passa pelo McpServer de verdade, que
// valida os argumentos com o schema zod e entrega ao handler só o que o schema devolve. Foi aí
// que o pin sumia: zod descartava as chaves pinned_field/pinnedField (o formato que list_ads,
// get_ad_creatives e get_asset_performance devolvem) e o anúncio era criado sem pin, ou o
// update_ad dizia "nada a mudar" sem gravar.

async function callViaMcp(client: unknown, tool: string, args: Row): Promise<Result> {
  const server = createMcpServer({ getClient: () => client as never });
  const mcpClient = new Client({ name: "rsa-ads-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    return (await mcpClient.callTool({ name: tool, arguments: { customerId: CID, ...args } })) as Result;
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

const createdHeadlines = (calls: { writes: Write[] }) =>
  (((calls.writes[0].operations[0].create as Row).ad as Row).responsiveSearchAd as Row).headlines;

test("create_ad pelo MCP: pinned_field e pinnedField (formato das leituras) chegam ao payload, em lista ou string JSON", async () => {
  const base = { adGroupId: AG, finalUrl: "https://loja.com.br", descriptions: ["D1", "D2"] };
  const expected = [{ text: "Marca X", pinnedField: "HEADLINE_1" }, { text: "B" }, { text: "C" }];
  for (const key of ["pin", "pinned_field", "pinnedField"]) {
    const list = [{ text: "Marca X", [key]: "HEADLINE_1" }, "B", "C"];
    for (const headlines of [list, JSON.stringify(list)]) {
      const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
      const result = await callViaMcp(client, "create_ad", { ...base, headlines });
      assert.ok(!result.isError, textOf(result));
      assert.equal(calls.writes.length, 1);
      assert.deepEqual(createdHeadlines(calls), expected, `${key} como ${typeof headlines}`);
    }
  }

  // o item exatamente como list_ads devolve (com approval_status) também serve de entrada
  const fromRead = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const copied = await callViaMcp(fromRead.client, "create_ad", {
    ...base,
    headlines: [{ text: "Marca X", pinned_field: "HEADLINE_1", approval_status: "APPROVED_LIMITED" }, { text: "B" }, "C"],
  });
  assert.ok(!copied.isError, textOf(copied));
  assert.deepEqual(createdHeadlines(fromRead.calls), expected);
});

test("create_ad pelo MCP: chave desconhecida ou pins conflitantes são recusados (nada descartado em silêncio)", async () => {
  const base = { adGroupId: AG, finalUrl: "https://loja.com.br", descriptions: ["D1", "D2"] };
  const cases: Array<[unknown[], RegExp]> = [
    [[{ text: "Marca X", position: "HEADLINE_1" }, "B", "C"], /headlines\[0\]: chave\(s\) desconhecida\(s\) "position"/],
    [[{ text: "Marca X", pin: "HEADLINE_1", pinned_field: "HEADLINE_2" }, "B", "C"], /headlines\[0\]: "Marca X" com pins diferentes/],
    [[{ text: "Marca X", pin: null, pinnedField: "HEADLINE_1" }, "B", "C"], /com pins diferentes/],
  ];
  for (const [list, expected] of cases) {
    for (const headlines of [list, JSON.stringify(list)]) {
      const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
      const result = await callViaMcp(client, "create_ad", { ...base, headlines });
      assert.equal(result.isError, true, `${JSON.stringify(headlines)}: ${textOf(result)}`);
      assert.match(textOf(result), expected);
      assert.equal(calls.queries.length + calls.writes.length, 0, `nenhuma chamada para ${JSON.stringify(headlines)}`);
    }
  }
});

test("update_ad pelo MCP: pin pedido como pinned_field é gravado (antes: 'nada a mudar' sem escrita)", async () => {
  const unpinned = [{ text: "A" }, { text: "B" }, { text: "C" }];
  const list = [{ text: "A", pinnedField: "HEADLINE_2" }, "B", "C"];
  for (const headlines of [list, JSON.stringify(list), [{ text: "A", pinned_field: "HEADLINE_2" }, "B", "C"]]) {
    const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow(unpinned)] } });
    const result = await callViaMcp(client, "update_ad", { adId: AD, headlines });
    assert.ok(!result.isError, textOf(result));
    assert.doesNotMatch(textOf(result), /nada a mudar/);
    const op = updateOp(calls);
    assert.equal(op.updateMask, "responsive_search_ad.headlines");
    assert.deepEqual((op.update.responsiveSearchAd as Row).headlines, [{ text: "A", pinnedField: "HEADLINE_2" }, { text: "B" }, { text: "C" }]);
  }

  // addHeadlines com o alias também leva o pin
  const add = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const added = await callViaMcp(add.client, "update_ad", { adId: AD, addHeadlines: [{ text: "Compre Agora", pinned_field: "HEADLINE_2" }] });
  assert.ok(!added.isError, textOf(added));
  assert.deepEqual(((updateOp(add.calls).update.responsiveSearchAd as Row).headlines as Row[]).at(-1), { text: "Compre Agora", pinnedField: "HEADLINE_2" });
});

test("update_ad pelo MCP: setPins aceita os aliases e não solta o pin quando a chave de pin falta", async () => {
  const target = "Frete Grátis Brasil";
  const setPinsCases = [
    [{ text: target, pinned_field: "HEADLINE_2" }],
    JSON.stringify([{ text: target, pinned_field: "HEADLINE_2" }]),
    [{ text: target, pinnedField: "HEADLINE_2" }],
  ];
  for (const setPins of setPinsCases) {
    const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
    const result = await callViaMcp(client, "update_ad", { adId: AD, setPins });
    assert.ok(!result.isError, textOf(result));
    const heads = (updateOp(calls).update.responsiveSearchAd as Row).headlines as Row[];
    assert.deepEqual(heads.find((h) => h.text === target), { text: target, pinnedField: "HEADLINE_2" }, JSON.stringify(setPins));
  }

  // sem pin nenhum: antes a string JSON soltava o pin de "Loja Oficial Marca X" em silêncio
  for (const setPins of [[{ text: "Loja Oficial Marca X" }], JSON.stringify([{ text: "Loja Oficial Marca X" }])]) {
    const { client, calls } = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
    const result = await callViaMcp(client, "update_ad", { adId: AD, setPins });
    assert.equal(result.isError, true, textOf(result));
    assert.match(textOf(result), /setPins\[0\]: informe pin/);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
});

test("migrate_call_only_ad pelo MCP: rsa.headlines com pinned_field mantém o pin", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()], ad_group_ad: [], ad_group_asset: [] } });
  const result = await callViaMcp(client, "migrate_call_only_ad", {
    adGroupId: AG,
    rsa: {
      finalUrl: "https://loja.com.br/contato",
      headlines: [{ text: "Ligue Agora", pinned_field: "HEADLINE_1" }, "Atendimento 24h", "Orçamento Grátis"],
      descriptions: ["Fale com um especialista agora mesmo.", "Atendemos todo o Brasil."],
    },
  });
  assert.ok(!result.isError, textOf(result));
  const rsa = calls.writes.flatMap((w) => w.operations).map((op) => asCreate(op)).find((c) => c && (c.ad as Row | undefined)?.responsiveSearchAd);
  assert.ok(rsa, `RSA não foi criado: ${JSON.stringify(calls.writes)}`);
  assert.deepEqual(((rsa!.ad as Row).responsiveSearchAd as Row).headlines, [
    { text: "Ligue Agora", pinnedField: "HEADLINE_1" }, { text: "Atendimento 24h" }, { text: "Orçamento Grátis" },
  ]);
});

function asCreate(op: Row): Row | undefined {
  if (op.create) return op.create as Row;
  const nested = (op.adGroupAdOperation as Row | undefined)?.create;
  return nested as Row | undefined;
}

// ── update_ad_status / delete_ad ──────────────────────────────────────

test("update_ad_status: lê antes, não reenvia status igual, avisa ao ativar reprovado", async () => {
  const same = fakeClient({ rows: { ad_group_ad: [rsaRow(HEADLINES, DESCRIPTIONS, { status: "PAUSED" })] } });
  const noop = await call(same.client, "update_ad_status", { adGroupId: AG, adId: AD, status: "PAUSED" });
  assert.match(textOf(noop), /já está PAUSED\. Nenhuma escrita/);
  assert.equal(same.calls.writes.length, 0);

  const disapproved = fakeClient({
    rows: { ad_group_ad: [rsaRow(HEADLINES, DESCRIPTIONS, { status: "PAUSED", policySummary: { approvalStatus: "DISAPPROVED" } })] },
  });
  const enabled = await call(disapproved.client, "update_ad_status", { adGroupId: AG, adId: AD, status: "ENABLED" });
  const op = disapproved.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "status");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/adGroupAds/${AG}~${AD}`, status: "ENABLED" });
  assert.ok(jsonOf<{ warnings: string[] }>(enabled).warnings.some((w) => /reprovado/.test(w)));

  const missing = fakeClient({ rows: { ad_group_ad: [] } });
  assert.equal((await call(missing.client, "update_ad_status", { adGroupId: AG, adId: AD, status: "ENABLED" })).isError, true);
  const removed = fakeClient({ rows: { ad_group_ad: [rsaRow(HEADLINES, DESCRIPTIONS, { status: "REMOVED" })] } });
  assert.match(textOf(await call(removed.client, "update_ad_status", { adGroupId: AG, adId: AD, status: "ENABLED" })), /removido/);
  assert.equal(missing.calls.writes.length + removed.calls.writes.length, 0);
});

test("delete_ad: exige confirm, não repete remoção e avisa quando o grupo fica sem anúncio ativo", async () => {
  const gate = fakeClient({ rows: { ad_group_ad: [rsaRow()] } });
  const refused = await call(gate.client, "delete_ad", { adGroupId: AG, adId: AD, confirm: false });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(gate.calls.queries.length + gate.calls.writes.length, 0);

  const already = fakeClient({ rows: { ad_group_ad: [rsaRow(HEADLINES, DESCRIPTIONS, { status: "REMOVED" })] } });
  assert.match(textOf(await call(already.client, "delete_ad", { adGroupId: AG, adId: AD, confirm: true })), /já estava removido/);
  assert.equal(already.calls.writes.length, 0);

  const last = fakeClient({ rows: { ad_group_ad: [rsaRow(), rsaRow(HEADLINES, DESCRIPTIONS, { status: "PAUSED", ad: { id: "778", type: "RESPONSIVE_SEARCH_AD" } })] } });
  const result = await call(last.client, "delete_ad", { adGroupId: AG, adId: AD, confirm: true });
  assert.deepEqual(last.calls.writes[0].operations, [{ remove: `customers/${CID}/adGroupAds/${AG}~${AD}` }]);
  const body = jsonOf<{ warnings: string[]; removed: { headlines: string[] } }>(result);
  assert.ok(body.warnings.some((w) => /sem nenhum anúncio ATIVO/.test(w)));
  assert.equal(body.removed.headlines[0], "Loja Oficial Marca X [HEADLINE_1]");
});

// ── Leituras: criativos, desempenho, assets ───────────────────────────

test("get_ad_creatives e get_ad_performance: trazem ad_group_id/campaign_id e os pins", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad: [{
        ...rsaRow(),
        adGroupAd: { ...(rsaRow().adGroupAd as Row), adStrength: "GOOD", policySummary: { approvalStatus: "APPROVED" } },
        metrics: { costMicros: "12500000", impressions: "1000", clicks: "50", ctr: 0.05, conversions: 2, conversionsValue: 300 },
      }],
    },
  });
  const creatives = jsonOf<Row[]>(await call(client, "get_ad_creatives", { campaignId: CAMPAIGN, adGroupId: AG }));
  assert.equal(creatives[0].ad_group_id, AG);
  assert.equal(creatives[0].campaign_id, CAMPAIGN);
  assert.deepEqual((creatives[0].headlines as Row[])[0], { text: "Loja Oficial Marca X", pinned_field: "HEADLINE_1" });
  assert.match(calls.queries[0], /ad_group\.id = 555/);

  const perf = jsonOf<Row[]>(await call(client, "get_ad_performance", { adGroupId: AG, days: 7 }));
  assert.equal(perf[0].ad_group_id, AG);
  assert.equal(perf[0].ad_strength, "GOOD");
  assert.equal(perf[0].roas, 24);

  const table = await call(client, "get_ad_creatives", { format: "table" });
  assert.match(textOf(table), /Loja Oficial Marca X \[HEADLINE_1\]/);

  const bad = fakeClient();
  const refused = await call(bad.client, "get_ad_creatives", { campaignId: "1; DROP" });
  assert.equal(refused.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

const assetViewRow = (assetId: string, textValue: string, impressions: number, clicks: number, conversions: number, extra: Row = {}): Row => ({
  campaign: { id: CAMPAIGN, name: "Pesquisa Loja" },
  adGroup: { id: AG, name: "Tênis Corrida" },
  adGroupAd: { ad: { id: AD, type: "RESPONSIVE_SEARCH_AD" } },
  adGroupAdAssetView: { fieldType: "HEADLINE", source: "ADVERTISER", enabled: true, ...extra },
  asset: { id: assetId, type: "TEXT", textAsset: { text: textValue } },
  metrics: { impressions, clicks, conversions, conversionsValue: conversions * 100, costMicros: clicks * 1_000_000 },
});

test("get_asset_performance: sem PENDING inventado, só assets ativos, pins e índice contra a média do anúncio", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad_asset_view: [
        assetViewRow("1", "Loja Oficial", 1000, 100, 10, { pinnedField: "HEADLINE_1", performanceLabel: "NOT_APPLICABLE" }),
        assetViewRow("2", "Frete Grátis", 1000, 20, 1),
        assetViewRow("3", "Novo Título", 50, 1, 0, { performanceLabel: "LEARNING" }),
      ],
    },
  });
  const result = await call(client, "get_asset_performance", { days: 30 });
  assert.match(calls.queries[0], /ad_group_ad_asset_view\.enabled = TRUE/);
  const rows = jsonOf<Row[]>(result);
  const byId = new Map(rows.map((r) => [String(r.asset_id), r]));
  assert.equal(byId.get("1")!.performance_label, undefined, "NOT_APPLICABLE não vira rótulo");
  assert.equal(byId.get("2")!.performance_label, undefined, "sem rótulo da API não inventa PENDING");
  assert.equal(byId.get("3")!.performance_label, "LEARNING");
  assert.ok(!textOf(result).includes('"PENDING"'));
  assert.equal(byId.get("1")!.pinned_field, "HEADLINE_1");
  assert.equal(byId.get("1")!.ad_id, AD);
  assert.equal(byId.get("1")!.ad_group_id, AG);
  assert.equal(byId.get("1")!.source, "ADVERTISER");
  // média do anúncio: 121 cliques / 2050 impressões = 5,9% → 10% dá índice 1,69; 2% dá 0,34
  assert.equal(byId.get("1")!.ctr_index, 1.69);
  assert.equal(byId.get("2")!.ctr_index, 0.34);
  assert.equal(byId.get("2")!.signal, "abaixo da média");
  assert.equal(byId.get("1")!.signal, "acima da média");
  assert.equal(byId.get("3")!.signal, "poucos dados");
  assert.deepEqual(["1", "2", "3"].map((id) => byId.get(id)!.ctr_rank), ["1/3", "2/3", "3/3"]);
  assert.match(textOf(result), /deixou de devolver o rótulo na v23/);

  const removed = fakeClient();
  await call(removed.client, "get_asset_performance", { includeRemoved: true, adId: AD, fieldType: "HEADLINE" });
  assert.doesNotMatch(removed.calls.queries[0], /enabled = TRUE/);
  assert.match(removed.calls.queries[0], /ad_group_ad\.ad\.id = 777/);
});

test("get_asset_performance: avisa período anterior a 05/06/2025, agrupa por asset e mantém o PMax", async () => {
  const { client } = fakeClient({
    rows: {
      ad_group_ad_asset_view: [
        assetViewRow("1", "Loja Oficial", 100, 10, 1),
        { ...assetViewRow("1", "Loja Oficial", 300, 30, 3), adGroupAd: { ad: { id: "778", type: "RESPONSIVE_SEARCH_AD" } } },
      ],
    },
  });
  const old = await call(client, "get_asset_performance", { dateRange: { since: "2025-01-01", until: "2025-12-31" }, groupBy: "ASSET" });
  assert.match(textOf(old), /começa em 2025-01-01.*a partir de 2025-06-05/s);
  const rows = jsonOf<Row[]>(old);
  assert.equal(rows.length, 1, "o mesmo asset em dois anúncios vira uma linha");
  assert.equal(rows[0].impressions, 400);
  assert.equal(rows[0].ad_id, undefined);

  const pmax = fakeClient();
  await call(pmax.client, "get_asset_performance", { level: "PMAX", assetGroupId: "9" });
  assert.match(pmax.calls.queries[0], /FROM asset_group_asset/);
  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_asset_performance", { level: "PMAX", assetGroupId: "9 OR 1" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ── list_ads ──────────────────────────────────────────────────────────

test("list_ads: audita tipos diferentes, resolve imagens, marca problemas e filtra onlyIssues", async () => {
  const rda: Row = {
    adGroupAd: {
      status: "ENABLED", adStrength: "POOR", actionItems: ["Adicione mais títulos"], primaryStatus: "ELIGIBLE",
      policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" },
      ad: {
        id: "801", type: "RESPONSIVE_DISPLAY_AD", finalUrls: ["https://loja.com.br"],
        responsiveDisplayAd: {
          headlines: [{ text: "Tênis" }], longHeadline: { text: "Tênis de corrida com frete grátis" },
          descriptions: [{ text: "Compre já" }],
          marketingImages: [{ asset: `customers/${CID}/assets/501` }], squareMarketingImages: [{ asset: `customers/${CID}/assets/502` }],
          logoImages: [], businessName: "Loja X",
        },
      },
    },
    adGroup: { id: "556", name: "Display" }, campaign: { id: "112", name: "Display Loja", advertisingChannelType: "DISPLAY" },
  };
  const rsa: Row = {
    ...rsaRow(),
    adGroupAd: {
      ...(rsaRow().adGroupAd as Row), adStrength: "EXCELLENT", primaryStatus: "ELIGIBLE",
      policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" },
    },
  };
  const disapproved: Row = {
    ...rsaRow(),
    adGroupAd: {
      ...(rsaRow().adGroupAd as Row), adStrength: "GOOD", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_AD_DISAPPROVED"],
      policySummary: { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "HEALTH_IN_PERSONALIZED_ADS", type: "PROHIBITED" }] },
      ad: { ...((rsaRow().adGroupAd as Row).ad as Row), id: "802" },
    },
  };
  const callOnly: Row = {
    adGroupAd: { status: "ENABLED", ad: { id: "803", type: "CALL_AD" }, policySummary: { approvalStatus: "APPROVED" } },
    adGroup: { id: AG, name: "Tênis" }, campaign: { id: CAMPAIGN, name: "Pesquisa" },
  };
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad: [rsa, rda, disapproved, callOnly],
      asset: [
        { asset: { id: "501", type: "IMAGE", name: "banner", imageAsset: { fullSize: { url: "https://img/501.jpg", widthPixels: 1200, heightPixels: 628 } } } },
        { asset: { id: "502", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/502.jpg", widthPixels: 1200, heightPixels: 1200 } } } },
      ],
    },
  });
  const all = jsonOf<{ summary: Row; ads: Row[] }>(await call(client, "list_ads", {}));
  assert.equal(all.ads.length, 4);
  const byId = new Map(all.ads.map((ad) => [String(ad.ad_id), ad]));
  const rdaContent = byId.get("801")!.content as Row;
  assert.deepEqual((rdaContent.marketing_images as Row[])[0], {
    asset_id: "501", type: "IMAGE", name: "banner", url: "https://img/501.jpg", dimensions: "1200x628",
  });
  assert.equal((rdaContent.long_headline as Row).text, "Tênis de corrida com frete grátis");
  assert.deepEqual(byId.get("801")!.asset_counts, { headlines: 1, descriptions: 1, marketingImages: 1, squareMarketingImages: 1, logoImages: 0, squareLogoImages: 0, youtubeVideos: 0 });
  assert.ok((byId.get("801")!.issues as string[]).some((i) => /força do anúncio POOR/.test(i)));
  assert.deepEqual(((byId.get(AD)!.content as Row).headlines as Row[])[0], { text: "Loja Oficial Marca X", pinned_field: "HEADLINE_1" });
  assert.deepEqual(byId.get(AD)!.issues, []);
  assert.ok((byId.get("802")!.issues as string[]).some((i) => /reprovado/.test(i)));
  assert.deepEqual(byId.get("802")!.policy_topics, ["HEALTH_IN_PERSONALIZED_ADS (PROHIBITED)"]);
  assert.ok((byId.get("803")!.issues as string[]).some((i) => /só de chamada/.test(i)));
  assert.equal(byId.get(AD)!.ad_group_id, AG);
  assert.equal((all.summary.by_type as Row).RESPONSIVE_SEARCH_AD, 2);

  const issues = jsonOf<{ ads: Row[] }>(await call(client, "list_ads", { onlyIssues: true }));
  assert.deepEqual(issues.ads.map((ad) => ad.ad_id).sort(), ["801", "802", "803"]);
  assert.ok(calls.queries.some((q) => /FROM asset\b/.test(q)));
});

test("list_ads: filtro por tipo e força vai para o GAQL; entrada inválida é recusada antes", async () => {
  const { client, calls } = fakeClient();
  await call(client, "list_ads", { adType: "DEMAND_GEN", adStrength: ["POOR", "AVERAGE"], campaignId: CAMPAIGN, includePaused: false });
  const q = calls.queries[0];
  assert.match(q, /ad_group_ad\.ad\.type IN \('DEMAND_GEN_MULTI_ASSET_AD', 'DEMAND_GEN_CAROUSEL_AD', 'DEMAND_GEN_VIDEO_RESPONSIVE_AD', 'DEMAND_GEN_PRODUCT_AD'\)/);
  assert.match(q, /ad_group_ad\.ad_strength IN \('POOR', 'AVERAGE'\)/);
  assert.match(q, /ad_group_ad\.status IN \('ENABLED'\)/);
  assert.doesNotMatch(q, /responsive_search_ad/, "só seleciona os campos dos tipos pedidos");

  const bad = fakeClient();
  assert.equal((await call(bad.client, "list_ads", { adStrength: ["OTIMO"] })).isError, true);
  assert.equal((await call(bad.client, "list_ads", { adGroupId: "x" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("enums são conferidos no código antes de entrar no GAQL ou no payload", async () => {
  const cases: Array<[string, Row]> = [
    ["list_ads", { adType: "RSA') OR ('1'='1" }],
    ["get_asset_performance", { fieldType: "HEADLINE' OR '1'='1" }],
    ["update_ad_status", { adGroupId: AG, adId: AD, status: "REMOVED" }],
    ["create_customizer_attribute", { name: "Preco", type: "MONEY" }],
    ["set_customizer_value", { attribute: "Preco", level: "WORLD", value: "R$1" }],
    ["list_customizers", { level: "WORLD" }],
    ["migrate_call_only_ad", { adGroupId: AG, phoneNumber: "11 4000-1000", rsaStatus: "REMOVED" }],
  ];
  for (const [tool, args] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, tool, args);
    assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.match(textOf(result), /inválido/);
    assert.equal(calls.queries.length + calls.writes.length, 0, tool);
  }
});

test("list_ads: combinações mais exibidas do RSA, com o texto de cada posição", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad: [rsaRow()],
      ad_group_ad_asset_combination_view: [
        {
          adGroupAd: { ad: { id: AD } },
          adGroupAdAssetCombinationView: {
            servedAssets: [
              { asset: `customers/${CID}/assets/11`, servedAssetFieldType: "HEADLINE_1" },
              { asset: `customers/${CID}/assets/12`, servedAssetFieldType: "HEADLINE_2" },
            ],
          },
          metrics: { impressions: "900" },
        },
      ],
      asset: [
        { asset: { id: "11", type: "TEXT", textAsset: { text: "Loja Oficial Marca X" } } },
        { asset: { id: "12", type: "TEXT", textAsset: { text: "Frete Grátis Brasil" } } },
      ],
    },
  });
  const body = jsonOf<{ ads: Row[] }>(await call(client, "list_ads", { includeTopCombinations: true, days: 30 }));
  assert.deepEqual(body.ads[0].top_combinations, [
    { impressions: 900, served: [{ position: "HEADLINE_1", text: "Loja Oficial Marca X" }, { position: "HEADLINE_2", text: "Frete Grátis Brasil" }] },
  ]);
  assert.ok(calls.queries.some((q) => /FROM ad_group_ad_asset_combination_view[\s\S]*ad_group_ad\.ad\.id IN \(777\)/.test(q)));
});

// ── Customizadores ────────────────────────────────────────────────────

test("create_customizer_attribute: cria, não duplica, respeita tipo e o limite de 40", async () => {
  const { client, calls } = fakeClient({ rows: { customizer_attribute: [] } });
  const created = await call(client, "create_customizer_attribute", { name: "Parcelas", type: "TEXT" });
  assert.ok(!created.isError, textOf(created));
  assert.deepEqual(calls.writes[0], {
    method: "mutate", resource: "customizerAttributes", operations: [{ create: { name: "Parcelas", type: "TEXT" } }], dryRun: false,
  });
  assert.equal(jsonOf<Row>(created).syntax, "{CUSTOMIZER.Parcelas:padrão}");

  const same = fakeClient({ rows: { customizer_attribute: [attributeRow("parcelas", "TEXT")] } });
  assert.match(textOf(await call(same.client, "create_customizer_attribute", { name: "Parcelas", type: "TEXT" })), /já existe/);
  assert.equal(same.calls.writes.length, 0);
  const otherType = await call(same.client, "create_customizer_attribute", { name: "PARCELAS", type: "NUMBER" });
  assert.equal(otherType.isError, true);
  assert.match(textOf(otherType), /do tipo TEXT/);

  const full = fakeClient({ rows: { customizer_attribute: Array.from({ length: 40 }, (_, i) => attributeRow(`A${i}`, "TEXT", String(i))) } });
  const limit = await call(full.client, "create_customizer_attribute", { name: "Novo", type: "PRICE" });
  assert.equal(limit.isError, true);
  assert.match(textOf(limit), /limite do Google: 40/);
  assert.equal(full.calls.writes.length, 0);

  for (const name of ["_Preco", "Preço:Base", "", "x".repeat(41)]) {
    const bad = fakeClient();
    assert.equal((await call(bad.client, "create_customizer_attribute", { name, type: "TEXT" })).isError, true, name);
    assert.equal(bad.calls.queries.length, 0);
  }
});

test("set_customizer_value: formato do PRICE, criação no nível certo e no-op", async () => {
  const attrs = [attributeRow("Preco", "PRICE", "42")];
  const badPrice = fakeClient({ rows: { customizer_attribute: attrs, campaign: [{ campaign: { id: CAMPAIGN, name: "Pesquisa", status: "ENABLED" } }] } });
  for (const value of ["R$ 99,90", "99,90", "noventa reais"]) {
    const result = await call(badPrice.client, "set_customizer_value", { attribute: "preco", level: "CAMPAIGN", campaignId: CAMPAIGN, value });
    assert.equal(result.isError, true, value);
  }
  assert.match(
    textOf(await call(badPrice.client, "set_customizer_value", { attribute: "Preco", level: "CAMPAIGN", campaignId: CAMPAIGN, value: "R$ 99,90" })),
    /R\$99,90/
  );
  assert.equal(badPrice.calls.writes.length, 0);

  const { client, calls } = fakeClient({
    rows: { customizer_attribute: attrs, campaign: [{ campaign: { id: CAMPAIGN, name: "Pesquisa", status: "ENABLED" } }], campaign_customizer: [] },
  });
  const created = await call(client, "set_customizer_value", { attribute: "42", level: "CAMPAIGN", campaignId: CAMPAIGN, value: "R$99,90" });
  assert.ok(!created.isError, textOf(created));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "campaignCustomizers");
  assert.deepEqual(calls.writes[0].operations[0], {
    create: {
      campaign: `customers/${CID}/campaigns/${CAMPAIGN}`,
      customizerAttribute: `customers/${CID}/customizerAttributes/42`,
      value: { type: "PRICE", stringValue: "R$99,90" },
    },
  });
  assert.ok(calls.queries.some((q) => /FROM campaign_customizer[\s\S]*campaign_customizer\.campaign = 'customers\/1234567890\/campaigns\/111'/.test(q)));

  const same = fakeClient({
    rows: {
      customizer_attribute: attrs,
      customer_customizer: [{ customerCustomizer: { resourceName: `customers/${CID}/customerCustomizers/42`, status: "ENABLED", value: { type: "PRICE", stringValue: "R$99,90" } } }],
    },
  });
  assert.match(textOf(await call(same.client, "set_customizer_value", { attribute: "Preco", level: "CUSTOMER", value: "R$99,90" })), /já vale R\$99,90/);
  assert.equal(same.calls.writes.length, 0);
});

test("set_customizer_value: troca = remove e cria (duas chamadas); falha na criação recria o valor antigo", async () => {
  const current = { adGroupCustomizer: { resourceName: `customers/${CID}/adGroupCustomizers/${AG}~42`, status: "ENABLED", value: { type: "PERCENT", stringValue: "10%" } } };
  const rows = { customizer_attribute: [attributeRow("Desconto", "PERCENT", "42")], ad_group: [adGroupRow()], ad_group_customizer: [current] };
  const { client, calls } = fakeClient({ rows });
  const replaced = await call(client, "set_customizer_value", { attribute: "Desconto", level: "AD_GROUP", adGroupId: AG, value: "15%" });
  assert.ok(!replaced.isError, textOf(replaced));
  assert.deepEqual(calls.writes.map((w) => [w.resource, Object.keys(w.operations[0])[0]]), [
    ["adGroupCustomizers", "remove"],
    ["adGroupCustomizers", "create"],
  ]);
  assert.equal(calls.writes[0].operations[0].remove, `customers/${CID}/adGroupCustomizers/${AG}~42`);
  assert.match(textOf(replaced), /10% → 15%/);

  let creates = 0;
  const rollback = fakeClient({
    rows,
    mutate: (resource, operations) => {
      if (operations[0].create && ++creates === 1) throw new Error("Google Ads API: invalid value");
      return { results: [{ resourceName: `customers/${CID}/${resource}/1` }] };
    },
  });
  const failed = await call(rollback.client, "set_customizer_value", { attribute: "Desconto", level: "AD_GROUP", adGroupId: AG, value: "15%" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /invalid value[\s\S]*valor anterior \(10%\) foi recriado/);
  assert.deepEqual(
    rollback.calls.writes.map((w) => (w.operations[0].create ? ((w.operations[0].create as Row).value as Row).stringValue : "remove")),
    ["remove", "15%", "10%"]
  );
});

test("set_customizer_value: validateOnly numa troca valida só a remoção e diz isso", async () => {
  const rows = {
    customizer_attribute: [attributeRow("Desconto", "PERCENT", "42")],
    customer_customizer: [{ customerCustomizer: { resourceName: `customers/${CID}/customerCustomizers/42`, status: "ENABLED", value: { type: "PERCENT", stringValue: "10%" } } }],
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_customizer_value", { attribute: "Desconto", level: "CUSTOMER", value: "15%", validateOnly: true });
  assert.ok(!result.isError, textOf(result));
  assert.equal(result.content[0].text, VALIDATE_ONLY_BANNER);
  assert.match(textOf(result), /remoção do valor atual \(10%\) foi validada.*não pode ser validada/s);
  assert.deepEqual(calls.writes.map((w) => [w.resource, Object.keys(w.operations[0])[0], w.dryRun]), [["CustomerCustomizers", "remove", true]]);
});

test("set_customizer_value: palavra-chave usa AdGroupCriterionCustomizers; nível sem ID é recusado antes", async () => {
  const early = fakeClient();
  const missing = await call(early.client, "set_customizer_value", { attribute: "Preco", level: "KEYWORD", adGroupId: AG, value: "R$10" });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /exige criterionId/);
  assert.equal(early.calls.queries.length, 0);

  const { client, calls } = fakeClient({
    rows: {
      customizer_attribute: [attributeRow("Preco", "PRICE", "42")],
      ad_group_criterion: [{ adGroupCriterion: { criterionId: "333", keyword: { text: "tenis nike", matchType: "PHRASE" }, status: "ENABLED", negative: false }, adGroup: { id: AG } }],
      ad_group_criterion_customizer: [],
    },
  });
  const result = await call(client, "set_customizer_value", { attribute: "Preco", level: "KEYWORD", adGroupId: AG, criterionId: "333", value: "299,90BRL" });
  assert.ok(!result.isError, textOf(result));
  assert.equal(calls.writes[0].resource, "AdGroupCriterionCustomizers");
  assert.equal((calls.writes[0].operations[0].create as Row).adGroupCriterion, `customers/${CID}/adGroupCriteria/${AG}~333`);

  const negative = fakeClient({
    rows: {
      customizer_attribute: [attributeRow("Preco", "PRICE", "42")],
      ad_group_criterion: [{ adGroupCriterion: { criterionId: "333", keyword: { text: "gratis", matchType: "BROAD" }, status: "ENABLED", negative: true } }],
    },
  });
  assert.match(textOf(await call(negative.client, "set_customizer_value", { attribute: "Preco", level: "KEYWORD", adGroupId: AG, criterionId: "333", value: "R$10" })), /negativa/);
  assert.equal(negative.calls.writes.length, 0);
});

test("remove_customizer_value e remove_customizer_attribute: confirm, no-op e trava de uso", async () => {
  const gate = fakeClient();
  assert.equal((await call(gate.client, "remove_customizer_value", { attribute: "Preco", level: "CUSTOMER", confirm: false })).isError, true);
  assert.equal((await call(gate.client, "remove_customizer_attribute", { attribute: "Preco", confirm: false })).isError, true);
  assert.equal(gate.calls.queries.length + gate.calls.writes.length, 0);

  const none = fakeClient({ rows: { customizer_attribute: [attributeRow("Preco", "PRICE")], customer_customizer: [] } });
  assert.match(textOf(await call(none.client, "remove_customizer_value", { attribute: "Preco", level: "CUSTOMER", confirm: true })), /não tem valor definido/);
  assert.equal(none.calls.writes.length, 0);

  const withValue = fakeClient({
    rows: {
      customizer_attribute: [attributeRow("Preco", "PRICE")],
      customer_customizer: [{ customerCustomizer: { resourceName: `customers/${CID}/customerCustomizers/42`, value: { stringValue: "R$10" } } }],
    },
  });
  await call(withValue.client, "remove_customizer_value", { attribute: "Preco", level: "CUSTOMER", confirm: true });
  assert.deepEqual(withValue.calls.writes[0].operations, [{ remove: `customers/${CID}/customerCustomizers/42` }]);

  const inUse = [...HEADLINES.slice(0, 3), { text: "Só {CUSTOMIZER.Preco:barato}" }];
  const used = fakeClient({ rows: { customizer_attribute: [attributeRow("Preco", "PRICE")], ad_group_ad: [rsaRow(inUse)] } });
  const refused = await call(used.client, "remove_customizer_attribute", { attribute: "Preco", confirm: true });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /1 RSA\(s\) usam \{CUSTOMIZER\.Preco\}: ad 777/);
  assert.equal(used.calls.writes.length, 0);
  await call(used.client, "remove_customizer_attribute", { attribute: "Preco", confirm: true, force: true });
  assert.deepEqual(used.calls.writes[0], {
    method: "mutate", resource: "customizerAttributes", operations: [{ remove: `customers/${CID}/customizerAttributes/42` }], dryRun: false,
  });
});

test("list_customizers: valores por nível, uso nos RSAs, referência quebrada e anúncios sem valor", async () => {
  const headlines = [
    { text: "Tênis por {CUSTOMIZER.Preco:ótimo preço}" },
    { text: "Em {CUSTOMIZER.Parcelas:até 10x}" },
    { text: "Frete {CUSTOMIZER.Inexistente:grátis}" },
  ];
  const { client, calls } = fakeClient({
    rows: {
      customizer_attribute: [attributeRow("Preco", "PRICE", "42"), attributeRow("Parcelas", "TEXT", "43"), attributeRow("SemUso", "NUMBER", "44")],
      customer_customizer: [],
      campaign_customizer: [{
        campaignCustomizer: { customizerAttribute: `customers/${CID}/customizerAttributes/42`, status: "ENABLED", value: { type: "PRICE", stringValue: "R$199" } },
        customizerAttribute: { name: "Preco" }, campaign: { id: CAMPAIGN, name: "Pesquisa" },
      }],
      ad_group_customizer: [],
      ad_group_criterion_customizer: [],
      ad_group_ad: [rsaRow(headlines)],
    },
  });
  const body = jsonOf<{ summary: Row; attributes: Row[] }>(await call(client, "list_customizers", {}));
  for (const resource of ["customer_customizer", "campaign_customizer", "ad_group_customizer", "ad_group_criterion_customizer", "customizer_attribute"]) {
    assert.ok(calls.queries.some((q) => new RegExp(`FROM ${resource}\\b`).test(q)), resource);
  }
  const byName = new Map(body.attributes.map((a) => [a.name, a]));
  assert.deepEqual(byName.get("Preco")!.values, [{ level: "CAMPAIGN", campaign_id: CAMPAIGN, campaign: "Pesquisa", value: "R$199", status: "ENABLED" }]);
  assert.equal(byName.get("Preco")!.used_by_ads, 1);
  assert.equal(byName.get("Preco")!.ads_without_value, 0);
  assert.equal(byName.get("Parcelas")!.ads_without_value, 1, "sem valor em nível nenhum: o anúncio usa o padrão");
  assert.deepEqual(body.summary.unused_attributes, ["SemUso"]);
  assert.deepEqual((body.summary.broken_references as Row[]).map((b) => b.reference), ["{CUSTOMIZER.inexistente}"]);
  assert.equal(body.summary.enabled_attributes, "3/40");
});

test("list_customizers: filtro de campanha/grupo/nível não faz anúncio coberto por nível acima contar como sem valor", async () => {
  const PRECO = `customers/${CID}/customizerAttributes/42`;
  const customerValue = (status = "ENABLED"): Row => ({
    customerCustomizer: { customizerAttribute: PRECO, status, value: { type: "PRICE", stringValue: "R$99" } },
    customizerAttribute: { name: "Preco" },
  });
  const campaignValue: Row = {
    campaignCustomizer: { customizerAttribute: PRECO, status: "ENABLED", value: { type: "PRICE", stringValue: "R$89" } },
    customizerAttribute: { name: "Preco" }, campaign: { id: CAMPAIGN, name: "Pesquisa" },
  };
  // o client falso respeita o filtro de campanha do GAQL, como a API
  const byCampaign = (rows: Row[]) => (query: string) => {
    const id = /campaign\.id = (\d+)/.exec(query)?.[1];
    return id ? rows.filter((row) => String((row.campaign as Row | undefined)?.id) === id) : rows;
  };
  const setup = (customer: Row[], campaign: Row[]) => fakeClient({
    rows: {
      customizer_attribute: [attributeRow("Preco", "PRICE", "42")],
      customer_customizer: customer,
      campaign_customizer: byCampaign(campaign),
      ad_group_customizer: [],
      ad_group_criterion_customizer: [],
      ad_group_ad: [rsaRow([{ text: "Tênis {CUSTOMIZER.Preco:barato}" }, { text: "B" }, { text: "C" }])],
    },
  });
  const preco = async (client: unknown, args: Row) => {
    const result = await call(client, "list_customizers", args);
    assert.ok(!result.isError, textOf(result));
    return jsonOf<{ attributes: Row[] }>(result).attributes.find((a) => a.name === "Preco")!;
  };

  // valor só na conta: o anúncio mostra R$99 com ou sem filtro
  for (const args of [{}, { campaignId: CAMPAIGN }, { adGroupId: AG }, { level: "CAMPAIGN" }, { level: "AD_GROUP", campaignId: CAMPAIGN }]) {
    const { client } = setup([customerValue()], []);
    const attribute = await preco(client, args);
    assert.equal(attribute.used_by_ads, 1, JSON.stringify(args));
    assert.equal(attribute.ads_without_value, 0, `valor da conta cobre o anúncio com ${JSON.stringify(args)}`);
  }
  // o filtro continua valendo para os valores exibidos
  const filtered = setup([customerValue()], []);
  assert.deepEqual((await preco(filtered.client, { campaignId: CAMPAIGN })).values, []);
  assert.deepEqual((await preco(filtered.client, { level: "CUSTOMER" })).values, [{ level: "CUSTOMER", value: "R$99", status: "ENABLED" }]);

  // valor só na campanha: filtro por grupo (sem campaignId) ou por nível ainda enxerga a campanha
  for (const args of [{ adGroupId: AG }, { level: "AD_GROUP" }, { level: "CUSTOMER" }]) {
    const { client } = setup([], [campaignValue]);
    const attribute = await preco(client, args);
    assert.equal(attribute.ads_without_value, 0, `valor da campanha cobre o anúncio com ${JSON.stringify(args)}`);
    assert.equal((attribute.values as Row[]).some((v) => v.level === "CAMPAIGN"), false, "nível filtrado não aparece em values");
  }

  // valor removido não cobre o anúncio, mesmo exibido com includeRemoved
  const removed = setup([customerValue("REMOVED")], []);
  const withRemoved = await preco(removed.client, { includeRemoved: true });
  assert.deepEqual(withRemoved.values, [{ level: "CUSTOMER", value: "R$99", status: "REMOVED" }]);
  assert.equal(withRemoved.ads_without_value, 1, "valor removido não conta como cobertura");

  // sem includeUsage não há cobertura a calcular: só os níveis pedidos são consultados
  const noUsage = setup([customerValue()], []);
  await call(noUsage.client, "list_customizers", { level: "CAMPAIGN", includeUsage: false });
  assert.deepEqual(
    noUsage.calls.queries.map((q) => /FROM ([a-z_]+)/.exec(q)?.[1]),
    ["customizer_attribute", "campaign_customizer"]
  );
});

// ── Anúncios só de chamada ────────────────────────────────────────────

const callOnlyRow = (adId: string, adGroupId: string, campaignId: string, status = "ENABLED"): Row => ({
  adGroupAd: { status, primaryStatus: "ELIGIBLE", ad: { id: adId }, policySummary: { approvalStatus: "APPROVED" } },
  adGroup: { id: adGroupId, name: `Grupo ${adGroupId}`, status: "ENABLED" },
  campaign: { id: campaignId, name: `Campanha ${campaignId}`, status: "ENABLED" },
});

test("list_call_only_ads: inventário com métricas, RSAs do grupo e cobertura de telefone por nível", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad: (query) => {
        if (/'CALL_AD'/.test(query) && /metrics\./.test(query)) {
          return [{ adGroupAd: { ad: { id: "901" } }, adGroup: { id: "10" }, metrics: { impressions: "500", clicks: "40", phoneCalls: "25", costMicros: "80000000", conversions: 5 } }];
        }
        if (/'CALL_AD'/.test(query)) return [callOnlyRow("901", "10", "1"), callOnlyRow("902", "20", "2", "PAUSED"), callOnlyRow("903", "30", "3")];
        return [{ adGroup: { id: "10" }, adGroupAd: { ad: { id: "1001" } } }, { adGroup: { id: "30" }, adGroupAd: { ad: { id: "1003" } } }];
      },
      ad_group_asset: [{ adGroupAsset: { adGroup: `customers/${CID}/adGroups/10` }, asset: { id: "71", callAsset: { phoneNumber: "11 4000-1000", countryCode: "BR" } } }],
      campaign_asset: [{ campaignAsset: { campaign: `customers/${CID}/campaigns/2` }, asset: { id: "72", callAsset: { phoneNumber: "11 4000-2000", countryCode: "BR" } } }],
      customer_asset: [],
    },
  });
  const result = await call(client, "list_call_only_ads", { days: 30 });
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /3 anúncio\(s\) só de chamada; 1 pronto\(s\).*fevereiro de 2027/s);
  const ads = jsonOf<Row[]>(result);
  const byId = new Map(ads.map((ad) => [String(ad.ad_id), ad]));
  assert.equal(byId.get("901")!.phone_calls, 25);
  assert.equal(byId.get("901")!.spend, 80);
  assert.deepEqual(byId.get("901")!.call_asset_coverage, { level: "grupo", phones: ["11 4000-1000 (BR)"] });
  assert.match(String(byId.get("901")!.migration_status), /^pronto/);
  assert.match(String(byId.get("902")!.migration_status), /falta: RSA ativo no grupo/);
  assert.deepEqual(byId.get("902")!.call_asset_coverage, { level: "campanha", phones: ["11 4000-2000 (BR)"] });
  assert.match(String(byId.get("903")!.migration_status), /falta: recurso de chamada/);
  assert.equal(byId.get("903")!.impressions, 0, "anúncio sem impressão no período continua no inventário");
  assert.ok(calls.queries.some((q) => /ad_group_asset\.ad_group IN \('customers\/1234567890\/adGroups\/10'/.test(q)));

  const empty = fakeClient();
  assert.match(textOf(await call(empty.client, "list_call_only_ads", {})), /Nenhum anúncio só de chamada/);
  assert.equal(empty.calls.queries.length, 1);
});

test("migrate_call_only_ad: telefone novo + RSA + pausa numa única gravação atômica com ID temporário", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [adGroupRow()],
      ad_group_ad: (query) => (/'RESPONSIVE_SEARCH_AD'/.test(query) ? [] : [{ adGroupAd: { status: "ENABLED", ad: { id: "901", type: "CALL_AD" } }, adGroup: { id: AG } }]),
      ad_group_asset: [],
    },
  });
  const result = await call(client, "migrate_call_only_ad", {
    adGroupId: AG,
    callOnlyAdId: "901",
    phoneNumber: "+55 11 4000-1000",
    rsa: {
      finalUrl: "https://loja.com.br/contato",
      headlines: [{ text: "Ligue Agora", pin: "HEADLINE_1" }, "Atendimento 24h", "Orçamento Grátis"],
      descriptions: ["Fale com um especialista agora mesmo.", "Atendemos todo o Brasil."],
    },
    rsaStatus: "ENABLED",
    pauseCallOnlyAd: true,
    confirm: true,
  });
  assert.ok(!result.isError, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const ops = calls.writes[0].operations;
  assert.deepEqual(ops.map((op) => Object.keys(op)[0]), ["assetOperation", "adGroupAssetOperation", "adGroupAdOperation", "adGroupAdOperation"]);
  const asset = (ops[0].assetOperation as Row).create as Row;
  assert.deepEqual(asset, { resourceName: `customers/${CID}/assets/-1`, callAsset: { countryCode: "BR", phoneNumber: "+55 11 4000-1000" } });
  assert.deepEqual((ops[1].adGroupAssetOperation as Row).create, { adGroup: `customers/${CID}/adGroups/${AG}`, asset: `customers/${CID}/assets/-1`, fieldType: "CALL" });
  const rsa = (ops[2].adGroupAdOperation as Row).create as Row;
  assert.equal(rsa.status, "ENABLED");
  assert.deepEqual(((rsa.ad as Row).responsiveSearchAd as Row).headlines, [{ text: "Ligue Agora", pinnedField: "HEADLINE_1" }, { text: "Atendimento 24h" }, { text: "Orçamento Grátis" }]);
  const pause = ops[3].adGroupAdOperation as { update: Row; updateMask: string };
  assert.deepEqual(pause, { update: { resourceName: `customers/${CID}/adGroupAds/${AG}~901`, status: "PAUSED" }, updateMask: "status" });
});

test("migrate_call_only_ad: travas — confirm, grupo sem RSA ativo, tipo errado, telefone repetido e erro atômico", async () => {
  const early = fakeClient();
  const noConfirm = await call(early.client, "migrate_call_only_ad", { adGroupId: AG, callOnlyAdId: "901", pauseCallOnlyAd: true });
  assert.equal(noConfirm.isError, true);
  assert.match(textOf(noConfirm), /confirm: true/);
  assert.equal((await call(early.client, "migrate_call_only_ad", { adGroupId: AG, phoneNumber: "123" })).isError, true);
  assert.equal((await call(early.client, "migrate_call_only_ad", { adGroupId: AG })).isError, true);
  assert.equal(early.calls.queries.length, 0);

  const base = { ad_group: [adGroupRow()], ad_group_asset: [] as Row[] };
  const noRsa = fakeClient({
    rows: { ...base, ad_group_ad: (q) => (/'RESPONSIVE_SEARCH_AD'/.test(q) ? [] : [{ adGroupAd: { status: "ENABLED", ad: { id: "901", type: "CALL_AD" } } }]) },
  });
  const guard = await call(noRsa.client, "migrate_call_only_ad", { adGroupId: AG, callOnlyAdId: "901", pauseCallOnlyAd: true, confirm: true });
  assert.equal(guard.isError, true);
  assert.match(textOf(guard), /sem RSA ativo/);
  assert.equal(noRsa.calls.writes.length, 0);

  const wrongType = fakeClient({ rows: { ...base, ad_group_ad: [{ adGroupAd: { status: "ENABLED", ad: { id: "901", type: "RESPONSIVE_SEARCH_AD" } } }] } });
  assert.match(textOf(await call(wrongType.client, "migrate_call_only_ad", { adGroupId: AG, callOnlyAdId: "901", phoneNumber: "1140001000" })), /não só de chamada/);

  const linked = fakeClient({
    rows: { ...base, ad_group_asset: [{ adGroupAsset: { status: "PAUSED" }, asset: { id: "71", callAsset: { phoneNumber: "(11) 4000-1000" } } }] },
  });
  const noop = await call(linked.client, "migrate_call_only_ad", { adGroupId: AG, phoneNumber: "11 4000-1000" });
  assert.ok(!noop.isError, textOf(noop));
  assert.match(textOf(noop), /nada a fazer/);
  assert.match(textOf(noop), /PAUSADO \(não foi reativado\)/);
  assert.equal(linked.calls.writes.length, 0);

  const notCall = fakeClient({ rows: { ...base, asset: [{ asset: { id: "72", type: "IMAGE" } }] } });
  assert.match(textOf(await call(notCall.client, "migrate_call_only_ad", { adGroupId: AG, callAssetId: "72" })), /não CALL/);
  assert.equal(notCall.calls.writes.length, 0);

  const failing = fakeClient({ rows: base, batchMutate: () => { throw new Error("Google Ads API: invalid phone"); } });
  const refused = await call(failing.client, "migrate_call_only_ad", { adGroupId: AG, phoneNumber: "11 4000-1000" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /invalid phone[\s\S]*atômica: nada foi alterado/);
});

test("migrate_call_only_ad: validateOnly valida a gravação atômica sem gravar", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()], ad_group_asset: [] } });
  const result = await call(client, "migrate_call_only_ad", { adGroupId: AG, phoneNumber: "11 4000-1000", validateOnly: true });
  assert.ok(!result.isError, textOf(result));
  assert.equal(result.content[0].text, VALIDATE_ONLY_BANNER);
  assert.match(textOf(result), /DRY-RUN.*2 operação\(ões\) validadas/s);
  assert.deepEqual(calls.writes.map((w) => [w.method, w.dryRun]), [["batchMutate", true]]);
});
