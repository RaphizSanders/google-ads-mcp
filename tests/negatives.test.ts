/**
 * Lote negatives — palavras-chave negativas em todos os níveis: grupo de anúncios, campanha
 * (inclusive PMax, até 10.000), listas compartilhadas (também do MCC) e a lista de nível de conta.
 *
 * O client falso valida toda query com os metadados reais da v25 (assertGaqlRules) e grava
 * cada escrita. Os payloads seguem os protos v25: SharedSet/SharedCriterion/CampaignSharedSet/
 * CustomerNegativeCriterion e os oneofs sharedSetOperation, sharedCriterionOperation,
 * campaignSharedSetOperation e customerNegativeCriterionOperation do googleAds:mutate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";
const MCC = "1112223333";
const CAMPAIGN_ID = "24250313718";
const AD_GROUP_ID = "180000000001";

// ── Client falso ──────────────────────────────────────────────────────

type RowSource = Row[] | ((query: string, customerId: string) => Row[]);

interface FakeOptions {
  rows?: Record<string, RowSource>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[]) => Row;
  batchMutate?: (operations: Row[]) => Row;
}

interface Write {
  method: string;
  customerId: string;
  operations: Row[];
  options?: Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ customerId: string; query: string }>,
    writes: [] as Write[],
    dryRunClones: 0,
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true);
    },
    async searchStream(customerId: string, query: string): Promise<Row[]> {
      calls.queries.push({ customerId, query });
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      if (typeof source === "function") return source(query, customerId);
      return source ?? [];
    },
    async mutate(customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: `mutate:${resource}`, customerId, operations, options });
      if (opts.mutate) return opts.mutate(resource, operations);
      if (dryRun) return {};
      return { results: operations.map((op, i) => ({ resourceName: String(op.remove ?? `customers/${customerId}/${resource}/new${i}`) })) };
    },
    async batchMutate(customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", customerId, operations });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => {
          const key = Object.keys(op)[0].replace(/Operation$/, "Result");
          return { [key]: { resourceName: `customers/${customerId}/${key}/${900 + i}` } };
        }),
      };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
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

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

function onlyWrite(calls: { writes: Write[] }, method: string): Write {
  assert.equal(calls.writes.length, 1, `esperava 1 escrita, houve ${calls.writes.map((w) => w.method).join(", ") || "nenhuma"}`);
  assert.equal(calls.writes[0].method, method);
  return calls.writes[0];
}

const nothingSent = (calls: { queries: unknown[]; writes: unknown[] }) => {
  assert.equal(calls.queries.length, 0, "não deveria consultar a API");
  assert.equal(calls.writes.length, 0, "não deveria gravar");
};

// ── Linhas de exemplo ────────────────────────────────────────────────

const campaignRow = (id = CAMPAIGN_ID, channel = "SEARCH", status = "ENABLED", name = "Pesquisa Marca"): Row => ({
  campaign: { id, name, status, advertisingChannelType: channel },
});

const adGroupRow = (campaignId = CAMPAIGN_ID, status = "ENABLED"): Row => ({
  adGroup: { id: AD_GROUP_ID, name: "Grupo Tênis", status },
  campaign: { id: campaignId, name: "Pesquisa Marca", advertisingChannelType: "SEARCH" },
});

const campaignNegative = (id: string, textValue: string, matchType: string): Row => ({
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa Marca" },
  campaignCriterion: {
    criterionId: id,
    resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~${id}`,
    keyword: { text: textValue, matchType },
  },
});

const adGroupNegative = (id: string, textValue: string, matchType: string): Row => ({
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa Marca" },
  adGroup: { id: AD_GROUP_ID, name: "Grupo Tênis" },
  adGroupCriterion: {
    criterionId: id,
    resourceName: `customers/${CID}/adGroupCriteria/${AD_GROUP_ID}~${id}`,
    keyword: { text: textValue, matchType },
  },
});

const sharedSetRow = (id: string, type = "NEGATIVE_KEYWORDS", overrides: Row = {}, owner = CID): Row => ({
  sharedSet: {
    id, name: `Lista ${id}`, type, status: "ENABLED", memberCount: "2", referenceCount: "1",
    resourceName: `customers/${owner}/sharedSets/${id}`, ...overrides,
  },
});

const member = (setId: string, id: string, textValue: string, matchType: string, owner = CID): Row => ({
  sharedSet: { id: setId, name: `Lista ${setId}` },
  sharedCriterion: {
    criterionId: id,
    type: "KEYWORD",
    resourceName: `customers/${owner}/sharedCriteria/${setId}~${id}`,
    keyword: { text: textValue, matchType },
  },
});

const campaignLink = (campaignId: string, setResource: string, name = `Campanha ${campaignId}`): Row => ({
  campaign: { id: campaignId, name, status: "ENABLED" },
  campaignSharedSet: {
    resourceName: `customers/${CID}/campaignSharedSets/${campaignId}~${setResource.split("/").pop()}`,
    sharedSet: setResource,
    status: "ENABLED",
  },
});

const accountLink = (setResource: string): Row => ({
  customerNegativeCriterion: {
    id: "4001",
    resourceName: `customers/${CID}/customerNegativeCriteria/4001`,
    type: "NEGATIVE_KEYWORD_LIST",
    negativeKeywordList: { sharedSet: setResource },
  },
});

const partialError = (index: number, message: string, code: Row) => ({
  details: [{ errors: [{ message, errorCode: code, location: { fieldPathElements: [{ fieldName: "operations", index }] } }] }],
});

// ── Guarda de conta ──────────────────────────────────────────────────

const NEGATIVE_TOOLS = [
  "list_negative_keywords", "list_shared_sets", "get_shared_set_members", "add_negative_keyword",
  "remove_negative_keyword", "create_shared_negative_list", "update_shared_set_members", "attach_shared_set",
  "detach_shared_set", "add_account_negative_keywords", "remove_account_negative_keywords",
];

test("allowlist: toda tool do lote nega conta fora da lista antes de consultar ou gravar", async () => {
  const { client, calls } = fakeClient();
  const handlers = register(client, ["9999999999"], true);
  for (const name of NEGATIVE_TOOLS) {
    const result = await handlers.get(name)!({
      customerId: CID, campaignId: CAMPAIGN_ID, sharedSetId: "77", keywords: [{ text: "gratis", matchType: "BROAD" }],
      name: "Lista", campaignIds: [CAMPAIGN_ID], confirm: true,
    });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Access denied/, name);
  }
  nothingSent(calls);
});

// ── add_negative_keyword ─────────────────────────────────────────────

test("add_negative_keyword: lote na campanha com dedupe (entrada e existentes) e partialFailure", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [campaignRow()], campaign_criterion: [campaignNegative("11", "Grátis", "BROAD")] },
  });
  const result = await call(client, "add_negative_keyword", {
    campaignId: CAMPAIGN_ID,
    keywords: [
      { text: "grátis", matchType: "BROAD" },
      { text: "vagas  de emprego", matchType: "PHRASE" },
      { text: "Vagas de emprego", matchType: "PHRASE" },
      { text: "vagas de emprego", matchType: "EXACT" },
    ],
    keyword: "curso", matchType: "EXACT",
  });
  assert.equal(result.isError, false);
  const write = onlyWrite(calls, "mutate:campaignCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, negative: true, keyword: { text: "vagas de emprego", matchType: "PHRASE" } } },
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, negative: true, keyword: { text: "vagas de emprego", matchType: "EXACT" } } },
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, negative: true, keyword: { text: "curso", matchType: "EXACT" } } },
  ]);
  const payload = jsonOf(result);
  assert.equal((payload.added as string[]).length, 3);
  assert.deepEqual(payload.already_present, ['-[BROAD] "grátis"']);
  assert.deepEqual(payload.duplicates_in_input, ['-[PHRASE] "Vagas de emprego"']);
  const negQuery = calls.queries.find((q) => /FROM campaign_criterion/.test(q.query))!.query;
  assert.match(negQuery, /campaign_criterion\.negative = true/);
  assert.match(negQuery, /campaign_criterion\.status != 'REMOVED'/);
});

test("add_negative_keyword: nível de grupo (inferido pelo adGroupId) grava em adGroupCriteria", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()], ad_group_criterion: [adGroupNegative("5", "usado", "BROAD")] } });
  const result = await call(client, "add_negative_keyword", {
    adGroupId: AD_GROUP_ID,
    keywords: [{ text: "usado", matchType: "BROAD" }, { text: "infantil", matchType: "PHRASE" }],
  });
  assert.equal(result.isError, false);
  const write = onlyWrite(calls, "mutate:adGroupCriteria");
  assert.deepEqual(write.operations, [
    { create: { adGroup: `customers/${CID}/adGroups/${AD_GROUP_ID}`, negative: true, keyword: { text: "infantil", matchType: "PHRASE" } } },
  ]);
  assert.equal((jsonOf(result).target as Row).level, "AD_GROUP");
  assert.match(calls.queries.find((q) => /FROM ad_group_criterion/.test(q.query))!.query, /ad_group\.id = 180000000001/);
});

test("add_negative_keyword: entrada inválida é recusada antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ keywords: [{ text: "x", matchType: "BROAD" }] }, /level CAMPAIGN exige campaignId/],
    [{ campaignId: "abc", keywords: [{ text: "x", matchType: "BROAD" }] }, /campaignId deve ser numérico/],
    [{ level: "CAMPAIGN", campaignId: CAMPAIGN_ID, adGroupId: AD_GROUP_ID, keyword: "x", matchType: "BROAD" }, /use level AD_GROUP/],
    [{ level: "AD_GROUP", keywords: [{ text: "x", matchType: "BROAD" }] }, /level AD_GROUP exige adGroupId/],
    [{ campaignId: CAMPAIGN_ID, keyword: "gratis" }, /keyword exige matchType/],
    [{ campaignId: CAMPAIGN_ID }, /Informe keywords/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "[gratis]", matchType: "EXACT" }] }, /não use \[ \] nem aspas/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "-gratis", matchType: "EXACT" }] }, /não use '-'/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "a".repeat(81), matchType: "EXACT" }] }, /mais de 80 caracteres/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "um dois tres quatro cinco seis sete oito nove dez onze", matchType: "BROAD" }] }, /mais de 10 palavras/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "gratis", matchType: "BROAD_MATCH_MODIFIER" }] }, /matchType deve ser EXACT, PHRASE ou BROAD/],
    [{ campaignId: CAMPAIGN_ID, keywords: '[{"text":"","matchType":"EXACT"}]' }, /texto vazio/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "add_negative_keyword", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.match(textOf(result), /Nada foi adicionado/);
    nothingSent(calls);
  }
});

test("add_negative_keyword: aceita keywords como string JSON (clientes que serializam arrays)", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()] } });
  const result = await call(client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keywords: '[{"text":"gratis","matchType":"BROAD"}]' });
  assert.equal(result.isError, false);
  assert.equal(onlyWrite(calls, "mutate:campaignCriteria").operations.length, 1);
});

test("add_negative_keyword: tudo já existe → nenhuma escrita", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()], campaign_criterion: [campaignNegative("11", "gratis", "BROAD")] } });
  const result = await call(client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "GRATIS", matchType: "BROAD" });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Nada a adicionar/);
  assert.equal(calls.writes.length, 0);
});

test("add_negative_keyword: limite de 10.000 por campanha (PMax) recusa sem gravar", async () => {
  const existing = Array.from({ length: 9_999 }, (_, i) => campaignNegative(String(1000 + i), `termo ${i}`, "BROAD"));
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow(CAMPAIGN_ID, "PERFORMANCE_MAX")], campaign_criterion: existing } });
  const result = await call(client, "add_negative_keyword", {
    campaignId: CAMPAIGN_ID,
    keywords: [{ text: "novo um", matchType: "BROAD" }, { text: "novo dois", matchType: "BROAD" }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /ficaria com 10001 negativas.*limite é 10000/);
  assert.equal(calls.writes.length, 0);

  const ok = fakeClient({ rows: { campaign: [campaignRow(CAMPAIGN_ID, "PERFORMANCE_MAX")], campaign_criterion: existing } });
  const r2 = await call(ok.client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "novo um", matchType: "BROAD" });
  assert.equal(r2.isError, false, "exatamente 10.000 é permitido");
  assert.equal(ok.calls.writes.length, 1);
});

test("add_negative_keyword: Display acima de 1.000 grava, mas avisa", async () => {
  const existing = Array.from({ length: 1_000 }, (_, i) => campaignNegative(String(i + 1), `termo ${i}`, "BROAD"));
  const { client } = fakeClient({ rows: { campaign: [campaignRow(CAMPAIGN_ID, "DISPLAY")], campaign_criterion: existing } });
  const result = await call(client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "novo", matchType: "BROAD" });
  assert.match((jsonOf(result).warnings as string[])[0], /só consideram 1000 negativas/);
});

test("add_negative_keyword: campanha inexistente/removida e grupo de outra campanha são recusados sem gravar", async () => {
  const cases: Array<[FakeOptions, Row, RegExp]> = [
    [{}, { campaignId: CAMPAIGN_ID, keyword: "x", matchType: "BROAD" }, /Campanha .* não encontrada/],
    [{ rows: { campaign: [campaignRow(CAMPAIGN_ID, "SEARCH", "REMOVED")] } }, { campaignId: CAMPAIGN_ID, keyword: "x", matchType: "BROAD" }, /está removida/],
    [{}, { adGroupId: AD_GROUP_ID, keyword: "x", matchType: "BROAD" }, /Performance Max não tem grupos/],
    [{ rows: { ad_group: [adGroupRow("999")] } }, { adGroupId: AD_GROUP_ID, campaignId: CAMPAIGN_ID, keyword: "x", matchType: "BROAD" }, /é da campanha 999/],
  ];
  for (const [opts, args, pattern] of cases) {
    const { client, calls } = fakeClient(opts);
    const result = await call(client, "add_negative_keyword", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("add_negative_keyword: erro por item é mapeado com dica; recusa do pedido inteiro diz que nada foi gravado", async () => {
  const partial = fakeClient({
    rows: { campaign: [campaignRow()] },
    mutate: () => ({
      results: [{ resourceName: "ok" }, {}],
      partialFailureError: partialError(1, "Keyword text has invalid characters or symbols.", { criterionError: "KEYWORD_HAS_INVALID_CHARS" }),
    }),
  });
  const r1 = await call(partial.client, "add_negative_keyword", {
    campaignId: CAMPAIGN_ID, keywords: [{ text: "gratis", matchType: "BROAD" }, { text: "promo!", matchType: "BROAD" }],
  });
  assert.equal(r1.isError, true);
  const payload = jsonOf(r1);
  assert.deepEqual(payload.added, ['-[BROAD] "gratis"']);
  const error = (payload.errors as Row[])[0];
  assert.equal(error.keyword, '-[BROAD] "promo!"');
  assert.match(String(error.error), /KEYWORD_HAS_INVALID_CHARS.*símbolos/);

  const whole = fakeClient({
    rows: { campaign: [campaignRow()] },
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument."); },
  });
  const r2 = await call(whole.client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "x", matchType: "BROAD" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Nada foi adicionado — a API recusou o pedido inteiro/);
});

test("add_negative_keyword: validateOnly roda em dry-run e não diz que gravou", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()] } });
  const result = await call(client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "gratis", matchType: "BROAD", validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): 1 negativa\(s\) validada\(s\), nada foi gravado/);
  assert.deepEqual(jsonOf(result).validated, ['-[BROAD] "gratis"']);
  assert.equal(jsonOf(result).added, undefined);
});

// ── remove_negative_keyword ──────────────────────────────────────────

test("remove_negative_keyword: nível de grupo remove em adGroupCriteria", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_criterion: [adGroupNegative("5", "usado", "BROAD"), adGroupNegative("6", "barato", "EXACT")] } });
  const result = await call(client, "remove_negative_keyword", {
    level: "AD_GROUP", adGroupId: AD_GROUP_ID, keywords: [{ text: "Usado", matchType: "BROAD" }], criterionIds: ["77"],
  });
  const write = onlyWrite(calls, "mutate:adGroupCriteria");
  assert.deepEqual(write.operations, [{ remove: `customers/${CID}/adGroupCriteria/${AD_GROUP_ID}~5` }]);
  assert.deepEqual(write.options, { partialFailure: true });
  const payload = jsonOf(result);
  assert.deepEqual(payload.removed, [{ criterion_id: "5", keyword: '-[BROAD] "usado"' }]);
  assert.deepEqual(payload.not_found, ["criterionId 77"]);
});

test("remove_negative_keyword: mais de 20 de uma vez exige confirm; validateOnly dispensa", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => campaignNegative(String(100 + i), `termo ${i}`, "BROAD"));
  const ids = rows.map((r) => String((r.campaignCriterion as Row).criterionId));

  const gated = fakeClient({ rows: { campaign_criterion: rows } });
  const r1 = await call(gated.client, "remove_negative_keyword", { campaignId: CAMPAIGN_ID, criterionIds: ids });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /PRÉVIA — nada foi gravado/);
  assert.equal(gated.calls.writes.length, 0);

  const confirmed = fakeClient({ rows: { campaign_criterion: rows } });
  const r2 = await call(confirmed.client, "remove_negative_keyword", { campaignId: CAMPAIGN_ID, criterionIds: ids, confirm: true });
  assert.equal(r2.isError, false);
  assert.equal(onlyWrite(confirmed.calls, "mutate:campaignCriteria").operations.length, 21);

  const validated = fakeClient({ rows: { campaign_criterion: rows } });
  const r3 = await call(validated.client, "remove_negative_keyword", { campaignId: CAMPAIGN_ID, criterionIds: ids, validateOnly: true });
  assert.match(textOf(r3), /DRY-RUN \(validateOnly\): nada foi removido. Validadas: 21/);
});

test("remove_negative_keyword: validações antes de consultar", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ criterionIds: ["1"] }, /campaignId deve ser numérico/],
    [{ level: "AD_GROUP", criterionIds: ["1"] }, /adGroupId deve ser numérico/],
    [{ campaignId: CAMPAIGN_ID, criterionIds: ["1x"] }, /criterionIds devem ser numéricos/],
    [{ campaignId: CAMPAIGN_ID }, /Informe criterionIds ou keywords/],
    [{ campaignId: CAMPAIGN_ID, keywords: [{ text: "x", matchType: "WRONG" }] }, /keywords inválidas/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "remove_negative_keyword", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    nothingSent(calls);
  }
});

// ── list_negative_keywords ───────────────────────────────────────────

function allSourcesRows(): Record<string, RowSource> {
  const own = `customers/${CID}/sharedSets/77`;
  const mcc = `customers/${MCC}/sharedSets/88`;
  const placements = `customers/${CID}/sharedSets/99`;
  return {
    campaign_criterion: [campaignNegative("11", "gratis", "BROAD")],
    ad_group_criterion: [adGroupNegative("5", "usado", "BROAD")],
    campaign_shared_set: [campaignLink(CAMPAIGN_ID, own), campaignLink(CAMPAIGN_ID, mcc), campaignLink(CAMPAIGN_ID, placements)],
    shared_set: [sharedSetRow("77"), sharedSetRow("55", "NEGATIVE_KEYWORDS", { name: "Sem uso" })],
    shared_criterion: (query) => {
      if (/shared_set\.id IN \(77\)/.test(query)) return [member("77", "1", "reclame aqui", "PHRASE"), member("77", "2", "procon", "BROAD")];
      if (/shared_set\.id = 66/.test(query)) return [member("66", "3", "download", "BROAD")];
      return [];
    },
    customer_negative_criterion: [accountLink(`customers/${CID}/sharedSets/66`)],
  };
}

test("list_negative_keywords: todas as origens com IDs — campanha, grupo, listas vinculadas e conta", async () => {
  const { client, calls } = fakeClient({ rows: allSourcesRows() });
  const result = await call(client, "list_negative_keywords", { campaignId: CAMPAIGN_ID });
  const payload = jsonOf(result);
  assert.deepEqual(payload.summary, { CAMPAIGN: 1, AD_GROUP: 1, SHARED_LIST: 2, ACCOUNT: 1 });
  const negatives = payload.negatives as Row[];
  assert.deepEqual(negatives.map((n) => `${n.source}:${n.criterion_id}:${n.text}`), [
    "CAMPAIGN:11:gratis", "AD_GROUP:5:usado", "SHARED_LIST:1:reclame aqui", "SHARED_LIST:2:procon", "ACCOUNT:3:download",
  ]);
  assert.equal(negatives[2].shared_set_id, "77");
  assert.match(String(negatives[2].scope), /lista 77 .* campanhas 24250313718/);
  const notes = (payload.notes as string[]).join("\n");
  assert.match(notes, new RegExp(`sharedSets/88 \\(da conta ${MCC}`));
  assert.match(notes, new RegExp(`customerId=${MCC}`));
  assert.doesNotMatch(notes, /Sem uso/, "com filtro de campanha não lista as listas sem vínculo");
  // primeira query é a de campanha, com o filtro
  assert.match(calls.queries[0].query, /FROM campaign_criterion/);
  assert.match(calls.queries[0].query, /campaign_criterion\.criterion_id/);
  assert.match(calls.queries[0].query, /campaign\.id = 24250313718/);
  const membersQuery = calls.queries.find((q) => /FROM shared_criterion/.test(q.query) && /IN \(/.test(q.query))!.query;
  assert.match(membersQuery, /shared_set\.id IN \(77\)/, "só a lista própria de palavras-chave (nem a do MCC nem a de placements)");
  const agQuery = calls.queries.find((q) => /FROM ad_group_criterion/.test(q.query))!.query;
  assert.match(agQuery, /campaign\.status != 'REMOVED'/, "negativas de grupo de campanha removida não valem");
});

test("list_negative_keywords: sem filtro, todas as origens deixam de fora campanhas e grupos removidos", async () => {
  const { client, calls } = fakeClient({ rows: allSourcesRows() });
  const result = await call(client, "list_negative_keywords", {});
  assert.notEqual(result.isError, true);
  const byFrom = (from: string) => calls.queries.find((q) => new RegExp(`FROM ${from}\\b`).test(q.query))!.query;
  const agQuery = byFrom("ad_group_criterion");
  assert.doesNotMatch(agQuery, /campaign\.id =/, "sem filtro de campanha");
  assert.match(agQuery, /ad_group_criterion\.status != 'REMOVED'/);
  assert.match(agQuery, /ad_group\.status != 'REMOVED'/);
  assert.match(agQuery, /campaign\.status != 'REMOVED'/, "grupo ativo dentro de campanha removida não pode aparecer");
  assert.match(byFrom("campaign_criterion"), /campaign\.status != 'REMOVED'/);
  assert.match(byFrom("campaign_shared_set"), /campaign\.status != 'REMOVED'/);
});

test("list_negative_keywords: por grupo resolve a campanha e mostra o que vale para o grupo", async () => {
  const rows = { ...allSourcesRows(), ad_group: [adGroupRow()] };
  const { client, calls } = fakeClient({ rows });
  await call(client, "list_negative_keywords", { adGroupId: AD_GROUP_ID });
  assert.match(calls.queries[0].query, /FROM ad_group\b/);
  const agQuery = calls.queries.find((q) => /FROM ad_group_criterion/.test(q.query))!.query;
  assert.match(agQuery, /campaign\.id = 24250313718/);
  assert.match(agQuery, /ad_group\.id = 180000000001/);
});

test("list_negative_keywords: source restringe; sem filtro avisa listas sem vínculo; csv e lista da conta do MCC", async () => {
  const account = fakeClient({ rows: allSourcesRows() });
  const r1 = await call(account.client, "list_negative_keywords", { source: "ACCOUNT" });
  assert.deepEqual(jsonOf(r1).summary, { ACCOUNT: 1 });
  assert.deepEqual(account.calls.queries.map((q) => /FROM (\w+)/.exec(q.query)![1]), ["customer_negative_criterion", "shared_criterion"]);

  const lists = fakeClient({ rows: allSourcesRows() });
  const r2 = await call(lists.client, "list_negative_keywords", { source: "SHARED_LIST" });
  assert.match((jsonOf(r2).notes as string[]).join("\n"), /Sem uso \(55/);

  const csv = fakeClient({ rows: allSourcesRows() });
  const r3 = await call(csv.client, "list_negative_keywords", { source: "CAMPAIGN", format: "csv" });
  assert.match(r3.content[0].text ?? "", /^source,text,match_type,criterion_id/);

  const mccAccount = fakeClient({ rows: { customer_negative_criterion: [accountLink(`customers/${MCC}/sharedSets/66`)] } });
  const r4 = await call(mccAccount.client, "list_negative_keywords", { source: "ACCOUNT" });
  assert.match((jsonOf(r4).notes as string[])[0], new RegExp(`da conta ${MCC} \\(MCC\\)`));
  assert.equal(mccAccount.calls.queries.length, 1, "não tenta ler itens de lista de outra conta");

  const bad = fakeClient();
  const r5 = await call(bad.client, "list_negative_keywords", { campaignId: "12a" });
  assert.equal(r5.isError, true);
  nothingSent(bad.calls);
});

// ── list_shared_sets / get_shared_set_members ────────────────────────

test("list_shared_sets: listas com campanhas, vínculo à conta, capacidade e listas do MCC", async () => {
  const { client, calls } = fakeClient({
    rows: {
      shared_set: [sharedSetRow("77", "NEGATIVE_KEYWORDS", { memberCount: "10", referenceCount: "1" }), sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")],
      campaign_shared_set: [campaignLink(CAMPAIGN_ID, `customers/${CID}/sharedSets/77`, "Pesquisa Marca"), campaignLink("222", `customers/${MCC}/sharedSets/88`)],
      customer_negative_criterion: [accountLink(`customers/${CID}/sharedSets/66`)],
    },
  });
  const result = await call(client, "list_shared_sets", {});
  const payload = jsonOf(result);
  const sets = payload.shared_sets as Row[];
  assert.equal(sets[0].campaigns, `${CAMPAIGN_ID} (Pesquisa Marca)`);
  assert.equal(sets[0].capacity, 5000);
  assert.equal(sets[0].member_count, 10);
  assert.equal(sets[1].attached_to_account, true);
  assert.equal(sets[1].capacity, 1000);
  assert.deepEqual(payload.mcc_lists, [{ resource_name: `customers/${MCC}/sharedSets/88`, owner_customer_id: MCC, campaigns: "222 (Campanha 222)", attached_to_account: false }]);
  assert.match(calls.queries[0].query, /shared_set\.type IN \('NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS'\)/);
  assert.match(calls.queries[0].query, /shared_set\.status = 'ENABLED'/);

  const all = fakeClient();
  await call(all.client, "list_shared_sets", { type: "ALL_NEGATIVES", includeRemoved: true });
  assert.match(all.calls.queries[0].query, /'NEGATIVE_PLACEMENTS'/);
  assert.doesNotMatch(all.calls.queries[0].query, /status = 'ENABLED'/);
});

test("get_shared_set_members: itens com IDs, filtro, campanhas e vínculo à conta", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const { client, calls } = fakeClient({
    rows: {
      shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS", { memberCount: "2" })],
      shared_criterion: [member("66", "1", "reclame aqui", "PHRASE"), member("66", "2", "procon", "BROAD")],
      campaign_shared_set: [],
      customer_negative_criterion: [accountLink(setResource)],
    },
  });
  const result = await call(client, "get_shared_set_members", { sharedSetId: "66", contains: "RECLAME" });
  const payload = jsonOf(result);
  assert.deepEqual(payload.members, [{ criterion_id: "1", type: "KEYWORD", value: "reclame aqui", match_type: "PHRASE", resource_name: `customers/${CID}/sharedCriteria/66~1` }]);
  assert.equal(payload.attached_to_account, true);
  assert.match(calls.queries[1].query, /WHERE shared_set\.id = 66/);

  const foreign = fakeClient();
  const r2 = await call(foreign.client, "get_shared_set_members", { sharedSetId: `customers/${MCC}/sharedSets/88` });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), new RegExp(`customerId=${MCC}`));
  nothingSent(foreign.calls);

  const missing = fakeClient();
  const r3 = await call(missing.client, "get_shared_set_members", { sharedSetId: "5" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /não encontrada/);
});

// ── update_shared_set_members ────────────────────────────────────────

const listRows = (type = "NEGATIVE_KEYWORDS", members: Row[] = [member("77", "1", "gratis", "BROAD"), member("77", "2", "vagas", "EXACT")], manager = false): Record<string, RowSource> => ({
  shared_set: [sharedSetRow("77", type, { referenceCount: "4" })],
  shared_criterion: members,
  customer: [{ customer: { id: CID, manager } }],
});

test("update_shared_set_members: inclui e remove numa chamada, pulando o que já existe", async () => {
  const { client, calls } = fakeClient({ rows: listRows() });
  const result = await call(client, "update_shared_set_members", {
    sharedSetId: "77",
    add: [{ text: "Grátis", matchType: "BROAD" }, { text: "gratis", matchType: "BROAD" }, { text: "curso online", matchType: "PHRASE" }],
    remove: [{ text: "VAGAS", matchType: "EXACT" }],
    removeCriterionIds: ["9"],
    confirm: true,
  });
  const write = onlyWrite(calls, "mutate:sharedCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { remove: `customers/${CID}/sharedCriteria/77~2` },
    { create: { sharedSet: `customers/${CID}/sharedSets/77`, keyword: { text: "Grátis", matchType: "BROAD" } } },
    { create: { sharedSet: `customers/${CID}/sharedSets/77`, keyword: { text: "curso online", matchType: "PHRASE" } } },
  ]);
  const payload = jsonOf(result);
  assert.deepEqual(payload.added, ['-[BROAD] "Grátis"', '-[PHRASE] "curso online"']);
  assert.deepEqual(payload.removed, ['-[EXACT] "vagas"']);
  assert.deepEqual(payload.not_found, ["criterionId 9"]);
  assert.match(textOf(result), /Campanhas afetadas: 4/);
});

test("update_shared_set_members: confirm — remoção, lista de conta e MCC pedem; inclusão comum não", async () => {
  const removal = fakeClient({ rows: listRows() });
  const r1 = await call(removal.client, "update_shared_set_members", { sharedSetId: "77", removeCriterionIds: ["1"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /PRÉVIA — nada foi gravado.*remove palavras/);
  assert.equal(removal.calls.writes.length, 0);

  const account = fakeClient({ rows: listRows("ACCOUNT_LEVEL_NEGATIVE_KEYWORDS") });
  const r2 = await call(account.client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "novo", matchType: "BROAD" }] });
  assert.match(textOf(r2), /PRÉVIA.*lista de nível de conta/);
  assert.equal(account.calls.writes.length, 0);

  const manager = fakeClient({ rows: listRows("NEGATIVE_KEYWORDS", [], true) });
  const r3 = await call(manager.client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "novo", matchType: "BROAD" }] });
  assert.match(textOf(r3), /PRÉVIA.*MCC/);
  assert.equal(manager.calls.writes.length, 0);

  const plain = fakeClient({ rows: listRows() });
  const r4 = await call(plain.client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "novo", matchType: "BROAD" }] });
  assert.equal(r4.isError, false);
  assert.equal(onlyWrite(plain.calls, "mutate:sharedCriteria").operations.length, 1);

  const validated = fakeClient({ rows: listRows() });
  const r5 = await call(validated.client, "update_shared_set_members", { sharedSetId: "77", removeCriterionIds: ["1"], validateOnly: true });
  assert.match(textOf(r5), /DRY-RUN \(validateOnly\): nada foi gravado/);
  assert.equal(validated.calls.writes.length, 1);
});

test("update_shared_set_members: recusas — entrada, tipo, status, capacidade, conflito e lista de outra conta", async () => {
  const early: Array<[Row, RegExp]> = [
    [{ sharedSetId: "abc", add: [{ text: "x", matchType: "BROAD" }] }, /sharedSetId inválido/],
    [{ sharedSetId: `customers/${MCC}/sharedSets/88`, add: [{ text: "x", matchType: "BROAD" }] }, new RegExp(`edite com customerId=${MCC}`)],
    [{ sharedSetId: "77" }, /Informe add, remove ou removeCriterionIds/],
    [{ sharedSetId: "77", add: [{ text: "x", matchType: "BROAD" }], remove: [{ text: "X", matchType: "BROAD" }] }, /mesmas palavras estão em add e remove/],
    [{ sharedSetId: "77", removeCriterionIds: ["1a"] }, /removeCriterionIds devem ser numéricos/],
  ];
  for (const [args, pattern] of early) {
    const { client, calls } = fakeClient();
    const result = await call(client, "update_shared_set_members", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    nothingSent(calls);
  }
  const later: Array<[Record<string, RowSource>, RegExp]> = [
    [{ ...listRows(), shared_set: [sharedSetRow("77", "NEGATIVE_PLACEMENTS")] }, /tipo NEGATIVE_PLACEMENTS/],
    [{ ...listRows(), shared_set: [sharedSetRow("77", "NEGATIVE_KEYWORDS", { status: "REMOVED" })] }, /está REMOVED/],
    [{ ...listRows(), shared_criterion: Array.from({ length: 5000 }, (_, i) => member("77", String(i + 1), `t ${i}`, "BROAD")) }, /ficaria com 5001 palavras; o limite é 5000/],
    [{ ...listRows("ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"), shared_criterion: Array.from({ length: 1000 }, (_, i) => member("77", String(i + 1), `t ${i}`, "BROAD")) }, /o limite é 1000/],
  ];
  for (const [rows, pattern] of later) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "novo", matchType: "BROAD" }], confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_shared_set_members: nada a mudar não grava; erro por item traz a ação", async () => {
  const noop = fakeClient({ rows: listRows() });
  const r1 = await call(noop.client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "gratis", matchType: "BROAD" }] });
  assert.match(textOf(r1), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const partial = fakeClient({
    rows: listRows(),
    mutate: () => ({ results: [{ resourceName: "ok" }, {}], partialFailureError: partialError(1, "Resource was not found.", { mutateError: "RESOURCE_NOT_FOUND" }) }),
  });
  const r2 = await call(partial.client, "update_shared_set_members", {
    sharedSetId: "77", add: [{ text: "novo", matchType: "BROAD" }], removeCriterionIds: ["1"], confirm: true,
  });
  assert.equal(r2.isError, true);
  const error = (jsonOf(r2).errors as Row[])[0];
  assert.equal(error.action, "add");
  assert.match(String(error.error), /não existe/);
});

test("partialFailure: operação sem resourceName na resposta vira erro, nunca 'adicionada'/'removida'", async () => {
  const unconfirmed = () => ({ results: [{}] });

  const add = fakeClient({ rows: { campaign: [campaignRow()] }, mutate: unconfirmed });
  const r1 = await call(add.client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "gratis", matchType: "BROAD" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /0 negativa\(s\) adicionada\(s\)/);
  const p1 = jsonOf(r1);
  assert.deepEqual(p1.added, []);
  assert.deepEqual(p1.errors, [{ keyword: '-[BROAD] "gratis"', error: "a API não confirmou a operação" }]);

  const list = fakeClient({ rows: listRows(), mutate: unconfirmed });
  const r2 = await call(list.client, "update_shared_set_members", { sharedSetId: "77", add: [{ text: "novo", matchType: "PHRASE" }] });
  assert.equal(r2.isError, true);
  const p2 = jsonOf(r2);
  assert.deepEqual(p2.added, []);
  assert.deepEqual(p2.removed, []);
  assert.deepEqual(p2.errors, [{ action: "add", keyword: '-[PHRASE] "novo"', error: "a API não confirmou a operação" }]);

  const removal = fakeClient({ rows: listRows(), mutate: unconfirmed });
  const r3 = await call(removal.client, "update_shared_set_members", { sharedSetId: "77", removeCriterionIds: ["1"], confirm: true });
  assert.equal(r3.isError, true);
  assert.deepEqual(jsonOf(r3).removed, []);
  assert.match(String(((jsonOf(r3).errors as Row[])[0]).error), /a API não confirmou a operação/);

  // Em dry-run (validateOnly) a API não devolve resourceName — isso não é erro.
  const dry = fakeClient({ rows: { campaign: [campaignRow()] }, mutate: unconfirmed });
  const r4 = await call(dry.client, "add_negative_keyword", { campaignId: CAMPAIGN_ID, keyword: "gratis", matchType: "BROAD", validateOnly: true });
  assert.equal(r4.isError, false);
  assert.deepEqual(jsonOf(r4).errors, []);
  assert.deepEqual(jsonOf(r4).validated, ['-[BROAD] "gratis"']);
});

// ── attach_shared_set / detach_shared_set ────────────────────────────

test("attach_shared_set: vincula às campanhas que faltam, pula as vinculadas e relata as inválidas", async () => {
  const own = `customers/${CID}/sharedSets/77`;
  const { client, calls } = fakeClient({
    rows: {
      shared_set: [sharedSetRow("77")],
      campaign: [campaignRow("1", "SEARCH"), campaignRow("2", "PERFORMANCE_MAX"), campaignRow("3", "SEARCH", "REMOVED")],
      campaign_shared_set: [campaignLink("1", own)],
    },
  });
  const result = await call(client, "attach_shared_set", { sharedSetId: "77", campaignIds: ["1", "2", "3", "4"] });
  const write = onlyWrite(calls, "mutate:campaignSharedSets");
  assert.deepEqual(write.operations, [{ create: { campaign: `customers/${CID}/campaigns/2`, sharedSet: own } }]);
  assert.deepEqual(write.options, { partialFailure: true });
  const payload = jsonOf(result);
  assert.deepEqual(payload.attached, ["2 (Pesquisa Marca, PERFORMANCE_MAX)"]);
  assert.deepEqual(payload.already_attached, ["1"]);
  assert.deepEqual(payload.not_found, ["4"]);
  assert.deepEqual(payload.removed_campaigns, ["3"]);
  assert.equal(result.isError, true, "campanhas inválidas marcam a resposta");
  const linkQuery = calls.queries.find((q) => /FROM campaign_shared_set/.test(q.query))!.query;
  assert.match(linkQuery, new RegExp(`campaign_shared_set\\.shared_set = '${own}'`));
});

test("attach_shared_set: lista do MCC — confere allowlist, a lista no MCC e a hierarquia", async () => {
  const mccSet = `customers/${MCC}/sharedSets/88`;
  const rows = {
    shared_set: (_q: string, customerId: string) => (customerId === MCC ? [sharedSetRow("88", "NEGATIVE_KEYWORDS", {}, MCC)] : []),
    customer_client: (_q: string, customerId: string) => (customerId === MCC ? [{ customerClient: { id: CID, manager: false, level: "1" } }] : []),
    campaign: [campaignRow()],
  };
  const { client, calls } = fakeClient({ rows });
  const handlers = register(client, [CID, MCC], true);
  const result = await handlers.get("attach_shared_set")!({ customerId: CID, sharedSetId: "customers/111-222-3333/sharedSets/88", campaignIds: [CAMPAIGN_ID] });
  assert.equal(result.isError, false);
  const write = onlyWrite(calls, "mutate:campaignSharedSets");
  assert.equal(write.customerId, CID);
  assert.deepEqual(write.operations, [{ create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, sharedSet: mccSet } }]);
  assert.deepEqual(calls.queries.filter((q) => q.customerId === MCC).map((q) => /FROM (\w+)/.exec(q.query)![1]), ["shared_set", "customer_client"]);
  assert.match(calls.queries.find((q) => /customer_client/.test(q.query))!.query, new RegExp(`customer_client\\.id = ${CID}`));

  const outside = fakeClient({ rows });
  const r2 = await register(outside.client, [CID], true).get("attach_shared_set")!({ customerId: CID, sharedSetId: mccSet, campaignIds: [CAMPAIGN_ID] });
  assert.match(textOf(r2), /fora da allowlist/);
  nothingSent(outside.calls);

  const notManager = fakeClient({ rows: { ...rows, customer_client: [] } });
  const r3 = await register(notManager.client, [CID, MCC], true).get("attach_shared_set")!({ customerId: CID, sharedSetId: mccSet, campaignIds: [CAMPAIGN_ID] });
  assert.match(textOf(r3), /não teria efeito/);
  assert.equal(notManager.calls.writes.length, 0);
});

test("attach_shared_set: toAccount vira a lista de negativas da conta (uma só), com confirm", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const base = { shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")] };

  const gated = fakeClient({ rows: base });
  const r1 = await call(gated.client, "attach_shared_set", { sharedSetId: "66", toAccount: true });
  assert.match(textOf(r1), /PRÉVIA/);
  assert.equal(gated.calls.writes.length, 0);

  const ok = fakeClient({ rows: base });
  const r2 = await call(ok.client, "attach_shared_set", { sharedSetId: "66", toAccount: true, confirm: true });
  assert.equal(r2.isError, undefined);
  assert.deepEqual(onlyWrite(ok.calls, "mutate:customerNegativeCriteria").operations, [{ create: { negativeKeywordList: { sharedSet: setResource } } }]);

  const same = fakeClient({ rows: { ...base, customer_negative_criterion: [accountLink(setResource)] } });
  const r3 = await call(same.client, "attach_shared_set", { sharedSetId: "66", toAccount: true, confirm: true });
  assert.match(textOf(r3), /já é a lista de negativas da conta/);
  assert.equal(same.calls.writes.length, 0);

  const other = fakeClient({ rows: { ...base, customer_negative_criterion: [accountLink(`customers/${CID}/sharedSets/65`)] } });
  const r4 = await call(other.client, "attach_shared_set", { sharedSetId: "66", toAccount: true, confirm: true });
  assert.match(textOf(r4), /só uma por conta.*fromAccount/);
  assert.equal(other.calls.writes.length, 0);
});

test("attach_shared_set: tipo, status e combinação de parâmetros errados são recusados", async () => {
  const early: Array<[Row, RegExp]> = [
    [{ sharedSetId: "77" }, /Informe campaignIds ou toAccount/],
    [{ sharedSetId: "77", campaignIds: ["1"], toAccount: true }, /campaignIds OU toAccount/],
    [{ sharedSetId: "77", campaignIds: ["x1"] }, /campaignIds devem ser numéricos/],
    [{ sharedSetId: "lista", campaignIds: ["1"] }, /sharedSetId inválido/],
  ];
  for (const [args, pattern] of early) {
    const { client, calls } = fakeClient();
    const result = await call(client, "attach_shared_set", args);
    assert.match(textOf(result), pattern);
    nothingSent(calls);
  }
  const later: Array<[Row, Row, RegExp]> = [
    [sharedSetRow("77", "NEGATIVE_KEYWORDS", { status: "REMOVED" }), { campaignIds: ["1"] }, /lista removida não pode ser vinculada/],
    [sharedSetRow("77", "NEGATIVE_KEYWORDS"), { toAccount: true, confirm: true }, /toAccount aceita só listas ACCOUNT_LEVEL_NEGATIVE_KEYWORDS/],
    [sharedSetRow("77", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"), { campaignIds: ["1"] }, /Use toAccount: true/],
    [sharedSetRow("77", "BRANDS"), { campaignIds: ["1"] }, /Listas BRANDS não se vinculam/],
  ];
  for (const [set, args, pattern] of later) {
    const { client, calls } = fakeClient({ rows: { shared_set: [set], campaign: [campaignRow("1")] } });
    const result = await call(client, "attach_shared_set", { sharedSetId: "77", ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("detach_shared_set: prévia sem confirm; com confirm remove só os vínculos existentes", async () => {
  const own = `customers/${CID}/sharedSets/77`;
  const rows = { campaign_shared_set: [campaignLink("1", own)] };

  const gated = fakeClient({ rows });
  const r1 = await call(gated.client, "detach_shared_set", { sharedSetId: "77", campaignIds: ["1", "2"] });
  assert.match(textOf(r1), /PRÉVIA.*sairia de 1 campanha/);
  assert.equal(gated.calls.writes.length, 0);

  const ok = fakeClient({ rows });
  const r2 = await call(ok.client, "detach_shared_set", { sharedSetId: "77", campaignIds: ["1", "2"], confirm: true });
  const write = onlyWrite(ok.calls, "mutate:campaignSharedSets");
  assert.deepEqual(write.operations, [{ remove: `customers/${CID}/campaignSharedSets/1~77` }]);
  assert.deepEqual(jsonOf(r2).not_attached, ["2"]);
  assert.match(ok.calls.queries[0].query, /campaign\.id IN \(1, 2\)/);

  const all = fakeClient({ rows });
  await call(all.client, "detach_shared_set", { sharedSetId: "77", allCampaigns: true, confirm: true });
  assert.doesNotMatch(all.calls.queries[0].query, /campaign\.id IN/);
  assert.equal(all.calls.writes.length, 1);

  const none = fakeClient();
  const r4 = await call(none.client, "detach_shared_set", { sharedSetId: "77", campaignIds: ["5"], confirm: true });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /não está vinculada/);
  assert.equal(none.calls.writes.length, 0);
});

test("detach_shared_set: fromAccount sem confirm é só prévia; validateOnly valida sem confirm e sem gravar", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const noConfirm = fakeClient({ rows: { customer_negative_criterion: [accountLink(setResource)] } });
  const r1 = await call(noConfirm.client, "detach_shared_set", { sharedSetId: "66", fromAccount: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /PRÉVIA — nada foi gravado/);
  assert.match(textOf(r1), new RegExp(`conta ${CID} deixaria de excluir`));
  assert.match(textOf(r1), /customerNegativeCriteria\/4001/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const falseConfirm = fakeClient({ rows: { customer_negative_criterion: [accountLink(setResource)] } });
  const r2 = await call(falseConfirm.client, "detach_shared_set", { sharedSetId: "66", fromAccount: true, confirm: false });
  assert.match(textOf(r2), /PRÉVIA/);
  assert.equal(falseConfirm.calls.writes.length, 0);

  const validate = fakeClient({ rows: { customer_negative_criterion: [accountLink(setResource)] } });
  const r3 = await call(validate.client, "detach_shared_set", { sharedSetId: "66", fromAccount: true, validateOnly: true });
  assert.equal(validate.calls.dryRunClones, 1);
  assert.match(textOf(r3), /DRY-RUN \(validateOnly\): desvínculo .* validado — nada foi gravado/);
  assert.doesNotMatch(textOf(r3), /desvinculada da conta/);
});

test("detach_shared_set: fromAccount remove o CustomerNegativeCriterion; modos exigem escolha única", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const ok = fakeClient({ rows: { customer_negative_criterion: [accountLink(setResource)] } });
  const r1 = await call(ok.client, "detach_shared_set", { sharedSetId: "66", fromAccount: true, confirm: true });
  assert.equal(r1.isError, undefined);
  assert.deepEqual(onlyWrite(ok.calls, "mutate:customerNegativeCriteria").operations, [{ remove: `customers/${CID}/customerNegativeCriteria/4001` }]);

  for (const args of [{}, { campaignIds: ["1"], allCampaigns: true }, { allCampaigns: true, fromAccount: true }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "detach_shared_set", { sharedSetId: "66", confirm: true, ...args });
    assert.match(textOf(result), /Escolha um/);
    nothingSent(calls);
  }
});

// ── Lista de nível de conta ──────────────────────────────────────────

test("add_account_negative_keywords: lista já vinculada — prévia, depois grava só as novas", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const rows = {
    customer_negative_criterion: [accountLink(setResource)],
    shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")],
    shared_criterion: [member("66", "1", "gratis", "BROAD")],
  };
  const gated = fakeClient({ rows });
  const r1 = await call(gated.client, "add_account_negative_keywords", { keywords: [{ text: "gratis", matchType: "BROAD" }, { text: "download", matchType: "PHRASE" }] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /PRÉVIA — nada foi gravado/);
  assert.deepEqual((jsonOf(r1).to_add as string[]), ['-[PHRASE] "download"']);
  assert.equal(gated.calls.writes.length, 0);

  const ok = fakeClient({ rows });
  const r2 = await call(ok.client, "add_account_negative_keywords", {
    keywords: [{ text: "gratis", matchType: "BROAD" }, { text: "download", matchType: "PHRASE" }], confirm: true,
  });
  assert.equal(r2.isError, false);
  const write = onlyWrite(ok.calls, "mutate:sharedCriteria");
  assert.deepEqual(write.operations, [{ create: { sharedSet: setResource, keyword: { text: "download", matchType: "PHRASE" } } }]);
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(jsonOf(r2).already_present, ['-[BROAD] "gratis"']);

  const noop = fakeClient({ rows });
  const r3 = await call(noop.client, "add_account_negative_keywords", { keywords: [{ text: "gratis", matchType: "BROAD" }], confirm: true });
  assert.match(textOf(r3), /Nada a adicionar/);
  assert.equal(noop.calls.writes.length, 0);
});

test("add_account_negative_keywords: sem lista, cria lista + palavras + vínculo numa operação atômica", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "add_account_negative_keywords", {
    keywords: [{ text: "gratis", matchType: "BROAD" }, { text: "reclame aqui", matchType: "PHRASE" }], confirm: true,
  });
  assert.equal(result.isError, undefined);
  const write = onlyWrite(calls, "batchMutate");
  const temp = `customers/${CID}/sharedSets/-1`;
  assert.deepEqual(write.operations, [
    { sharedSetOperation: { create: { resourceName: temp, name: "Negativas da conta", type: "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: "gratis", matchType: "BROAD" } } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: "reclame aqui", matchType: "PHRASE" } } } },
    { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: temp } } } },
  ]);
  assert.match(textOf(result), /criada: customers\/5820067509\/sharedSetResult\/900/);
});

test("add_account_negative_keywords: lista existente sem vínculo é reaproveitada; várias sem vínculo pedem escolha", async () => {
  const existing = fakeClient({
    rows: { shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")], shared_criterion: [member("66", "1", "gratis", "BROAD")] },
  });
  await call(existing.client, "add_account_negative_keywords", {
    keywords: [{ text: "gratis", matchType: "BROAD" }, { text: "download", matchType: "BROAD" }], confirm: true,
  });
  const setResource = `customers/${CID}/sharedSets/66`;
  assert.deepEqual(onlyWrite(existing.calls, "batchMutate").operations, [
    { sharedCriterionOperation: { create: { sharedSet: setResource, keyword: { text: "download", matchType: "BROAD" } } } },
    { customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: setResource } } } },
  ]);

  const many = fakeClient({ rows: { shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS"), sharedSetRow("67", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")] } });
  const r2 = await call(many.client, "add_account_negative_keywords", { keywords: [{ text: "x", matchType: "BROAD" }], confirm: true });
  assert.match(textOf(r2), /2 listas de nível de conta sem vínculo.*attach_shared_set/);
  assert.equal(many.calls.writes.length, 0);
});

test("add_account_negative_keywords: recusas — lista do MCC, limite de 1.000, entrada inválida; erro da API com dica", async () => {
  const mcc = fakeClient({ rows: { customer_negative_criterion: [accountLink(`customers/${MCC}/sharedSets/88`)] } });
  const r1 = await call(mcc.client, "add_account_negative_keywords", { keywords: [{ text: "x", matchType: "BROAD" }], confirm: true });
  assert.match(textOf(r1), new RegExp(`update_shared_set_members customerId=${MCC}`));
  assert.equal(mcc.calls.writes.length, 0);

  const full = fakeClient({
    rows: {
      customer_negative_criterion: [accountLink(`customers/${CID}/sharedSets/66`)],
      shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS")],
      shared_criterion: Array.from({ length: 999 }, (_, i) => member("66", String(i + 1), `t ${i}`, "BROAD")),
    },
  });
  const r2 = await call(full.client, "add_account_negative_keywords", {
    keywords: [{ text: "a", matchType: "BROAD" }, { text: "b", matchType: "BROAD" }], confirm: true,
  });
  assert.match(textOf(r2), /ficaria com 1001 .*limite é 1000/);
  assert.equal(full.calls.writes.length, 0);

  const removedList = fakeClient({
    rows: {
      customer_negative_criterion: [accountLink(`customers/${CID}/sharedSets/66`)],
      shared_set: [sharedSetRow("66", "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS", { status: "REMOVED" })],
    },
  });
  const rRemoved = await call(removedList.client, "add_account_negative_keywords", { keywords: [{ text: "x", matchType: "BROAD" }], confirm: true });
  assert.match(textOf(rRemoved), /está REMOVED/);
  assert.equal(removedList.calls.writes.length, 0);

  const bad = fakeClient();
  const r3 = await call(bad.client, "add_account_negative_keywords", { keywords: [{ text: '"gratis"', matchType: "PHRASE" }], confirm: true });
  assert.match(textOf(r3), /não use \[ \] nem aspas/);
  nothingSent(bad.calls);

  const refused = fakeClient({
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The customer cannot create this type of shared set."); },
  });
  const r4 = await call(refused.client, "add_account_negative_keywords", { keywords: [{ text: "x", matchType: "BROAD" }], confirm: true });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /crie-a na interface do Google Ads/);
  assert.match(textOf(r4), /Nada foi adicionado/);
});

test("add_account_negative_keywords: validateOnly valida a operação atômica sem confirm e sem gravar", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "add_account_negative_keywords", { keywords: [{ text: "gratis", matchType: "BROAD" }], validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.equal(onlyWrite(calls, "batchMutate").operations.length, 3);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.doesNotMatch(textOf(result), /Vinculada à conta: sim/);
});

test("remove_account_negative_keywords: prévia, remoção, e recusas (sem lista, lista do MCC, nada encontrado)", async () => {
  const setResource = `customers/${CID}/sharedSets/66`;
  const rows = {
    customer_negative_criterion: [accountLink(setResource)],
    shared_criterion: [member("66", "1", "gratis", "BROAD"), member("66", "2", "download", "PHRASE")],
  };
  const gated = fakeClient({ rows });
  const r1 = await call(gated.client, "remove_account_negative_keywords", { keywords: [{ text: "gratis", matchType: "BROAD" }] });
  assert.match(textOf(r1), /PRÉVIA/);
  assert.equal(gated.calls.writes.length, 0);

  const ok = fakeClient({ rows });
  const r2 = await call(ok.client, "remove_account_negative_keywords", { keywords: [{ text: "gratis", matchType: "BROAD" }], criterionIds: ["2", "3"], confirm: true });
  assert.deepEqual(onlyWrite(ok.calls, "mutate:sharedCriteria").operations, [
    { remove: `customers/${CID}/sharedCriteria/66~2` },
    { remove: `customers/${CID}/sharedCriteria/66~1` },
  ]);
  assert.deepEqual(jsonOf(r2).not_found, ["criterionId 3"]);

  const cases: Array<[Record<string, RowSource>, RegExp]> = [
    [{}, /não tem lista de negativas de nível de conta/],
    [{ customer_negative_criterion: [accountLink(`customers/${MCC}/sharedSets/88`)] }, new RegExp(`do MCC ${MCC}`)],
    [rows, /Nenhuma das negativas pedidas/],
  ];
  for (const [caseRows, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: caseRows });
    const result = await call(client, "remove_account_negative_keywords", { keywords: [{ text: "inexistente", matchType: "EXACT" }], confirm: true });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

// ── create_shared_negative_list ──────────────────────────────────────

test("create_shared_negative_list: lista, palavras e vínculos numa só operação atômica", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("1"), campaignRow("2", "PERFORMANCE_MAX")] } });
  const result = await call(client, "create_shared_negative_list", {
    name: "  Concorrentes  ",
    keywords: [{ text: "marca x", matchType: "PHRASE" }, { text: "Marca X", matchType: "PHRASE" }, { text: "marca y", matchType: "EXACT" }],
    campaignIds: ["1", "2"],
  });
  assert.equal(result.isError, undefined);
  const temp = `customers/${CID}/sharedSets/-1`;
  assert.deepEqual(onlyWrite(calls, "batchMutate").operations, [
    { sharedSetOperation: { create: { resourceName: temp, name: "Concorrentes", type: "NEGATIVE_KEYWORDS" } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: "marca x", matchType: "PHRASE" } } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: "marca y", matchType: "EXACT" } } } },
    { campaignSharedSetOperation: { create: { campaign: `customers/${CID}/campaigns/1`, sharedSet: temp } } },
    { campaignSharedSetOperation: { create: { campaign: `customers/${CID}/campaigns/2`, sharedSet: temp } } },
  ]);
  assert.match(textOf(result), /Palavras: 2 \(1 duplicada/);
  assert.match(textOf(result), /Campanhas vinculadas: 1 \(Pesquisa Marca\), 2/);
});

test("create_shared_negative_list: nome repetido, limite de 20 listas, campanha inválida e entrada ruim não gravam", async () => {
  const early: Array<[Row, RegExp]> = [
    [{ name: "", keywords: [] }, /de 1 a 255 bytes/],
    [{ name: "ç".repeat(128), keywords: [] }, /de 1 a 255 bytes \(recebido 256\)/],
    [{ name: "Lista", keywords: [{ text: "x", matchType: "BMM" }] }, /Palavras inválidas/],
    [{ name: "Lista", keywords: [], campaignIds: ["abc"] }, /campaignIds devem ser numéricos/],
  ];
  for (const [args, pattern] of early) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_shared_negative_list", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    nothingSent(calls);
  }
  const later: Array<[Record<string, RowSource>, Row, RegExp]> = [
    [{ shared_set: [sharedSetRow("77", "NEGATIVE_KEYWORDS", { name: "Concorrentes" })] }, {}, /Já existe a lista ativa "Concorrentes" \(ID 77\)/],
    [{ shared_set: Array.from({ length: 20 }, (_, i) => sharedSetRow(String(i + 1))) }, {}, /já tem 20 listas/],
    [{ campaign: [campaignRow("1", "SEARCH", "REMOVED")] }, { campaignIds: ["1", "2"] }, /não encontradas na conta .*: 2\..*removidas: 1/],
  ];
  for (const [rows, args, pattern] of later) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "create_shared_negative_list", { name: "Concorrentes", keywords: [], ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("create_shared_negative_list: dry-run global valida sem criar; recusa da API explica e diz que nada foi criado", async () => {
  const dry = fakeClient({ dryRun: true });
  const r1 = await call(dry.client, "create_shared_negative_list", { name: "Concorrentes", keywords: [{ text: "marca x", matchType: "PHRASE" }] });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /DRY-RUN \(validateOnly\).*nada foi criado/);
  assert.equal(dry.calls.writes.length, 1);

  const refused = fakeClient({ batchMutate: () => { throw new Error("Google Ads API: invalid — A shared set with this name already exists."); } });
  const r2 = await call(refused.client, "create_shared_negative_list", { name: "Concorrentes", keywords: [] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /já existe uma lista ativa com esse nome/);
  assert.match(textOf(r2), /Nada foi criado/);

  const unconfirmed = fakeClient({ batchMutate: () => ({ mutateOperationResponses: [] }) });
  const r3 = await call(unconfirmed.client, "create_shared_negative_list", { name: "Concorrentes", keywords: [] });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /não confirmou a criação/);
});

// ── REST de verdade: URL e corpo ─────────────────────────────────────

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

test("REST: update_shared_set_members com validateOnly vai para sharedCriteria:mutate com partialFailure e validateOnly", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return {};
    const query = String(body.query);
    if (/FROM shared_set/.test(query)) return [{ results: [sharedSetRow("77")] }];
    if (/FROM shared_criterion/.test(query)) return [{ results: [member("77", "1", "gratis", "BROAD")] }];
    return [{ results: [] }];
  });
  try {
    const handlers = register(realClient());
    const result = await handlers.get("update_shared_set_members")!({
      customerId: CID, sharedSetId: "77", removeCriterionIds: ["1"], add: [{ text: "download", matchType: "BROAD" }], validateOnly: true,
    });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/sharedCriteria:mutate`));
    assert.equal(writes[0].body.partialFailure, true);
    assert.equal(writes[0].body.validateOnly, true);
    assert.deepEqual(writes[0].body.operations, [
      { remove: `customers/${CID}/sharedCriteria/77~1` },
      { create: { sharedSet: `customers/${CID}/sharedSets/77`, keyword: { text: "download", matchType: "BROAD" } } },
    ]);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
  } finally {
    net.restore();
  }
});

test("REST: add_account_negative_keywords cria tudo em googleAds:mutate (mutateOperations)", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream") ? [{ results: [] }] : {
    mutateOperationResponses: [
      { sharedSetResult: { resourceName: `customers/${CID}/sharedSets/123` } },
      { sharedCriterionResult: { resourceName: `customers/${CID}/sharedCriteria/123~1` } },
      { customerNegativeCriterionResult: { resourceName: `customers/${CID}/customerNegativeCriteria/9` } },
    ],
  }));
  try {
    const handlers = register(realClient());
    const result = await handlers.get("add_account_negative_keywords")!({ customerId: CID, keywords: [{ text: "gratis", matchType: "BROAD" }], confirm: true });
    const writes = net.sent.filter((s) => !s.url.endsWith(":searchStream"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal((writes[0].body.mutateOperations as Row[]).length, 3);
    assert.equal(writes[0].body.validateOnly, undefined);
    assert.match(textOf(result), /criada: customers\/5820067509\/sharedSets\/123/);
  } finally {
    net.restore();
  }
});
