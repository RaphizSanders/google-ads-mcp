/**
 * Lote account-admin: edição em massa (bulk_update_status, bulk_mutate, batch jobs),
 * contas e vínculos do MCC, usuários e aprovações multi-party, faturamento.
 *
 * O client falso valida toda query GAQL contra os metadados reais da v25
 * (assertGaqlRules) e registra cada escrita. Os testes com o GoogleAdsClient real e fetch
 * interceptado conferem URL, método, corpo e o header login-customer-id.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const MCC = "9998887776";
const CLIENT = "5556667778";

// ── Client falso ──────────────────────────────────────────────────────

interface Call {
  kind: "mutate" | "action" | "write" | "get";
  cid: string;
  target: string;
  body: Row;
  options?: Row;
  dryRun: boolean;
  login: string;
}

interface FakeOptions {
  rows?: (from: string, query: string, cid: string) => Row[];
  mutate?: (resource: string, operations: Row[], dryRun: boolean) => Row;
  action?: (action: string, body: Row, dryRun: boolean) => Row;
  get?: (path: string, params: Row) => Row;
  dryRun?: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as Array<{ cid: string; query: string; login: string }>, writes: [] as Call[], dryRunClones: 0, logins: [] as string[] };
  const fail = (message: string) => { throw new Error(message); };
  const build = (dryRun: boolean, login: string): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true, login);
    },
    withLoginCustomerId(id: string) {
      calls.logins.push(id);
      return build(dryRun, id);
    },
    async searchStream(cid: string, query: string): Promise<Row[]> {
      assertGaqlRules(query);
      calls.queries.push({ cid, query, login });
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      return opts.rows?.(from, query, cid) ?? [];
    },
    async mutate(cid: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ kind: "mutate", cid, target: resource, body: { operations }, options, dryRun, login });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(resource, operations, dryRun);
      return dryRun ? {} : { results: operations.map((op) => ({ resourceName: String(op.remove ?? obj(op.update).resourceName ?? `customers/${cid}/${resource}/1`) })) };
    },
    async customerAction(cid: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ kind: "action", cid, target: action, body, dryRun, login });
      return opts.action?.(action, body, dryRun) ?? {};
    },
    async customerWriteAction(cid: string, action: string, body: Row): Promise<Row> {
      if (dryRun && !/:upload(Click|Call)Conversions$|:uploadConversionAdjustments$/.test(action)) {
        fail(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      }
      calls.writes.push({ kind: "write", cid, target: action, body, dryRun, login });
      return opts.action?.(action, body, dryRun) ?? {};
    },
    async customerGet(cid: string, path: string, params: Row = {}): Promise<Row> {
      calls.writes.push({ kind: "get", cid, target: path, body: params, dryRun, login });
      return opts.get?.(path, params) ?? {};
    },
  });
  return { client: build(opts.dryRun ?? false, "login-padrao"), calls };
}

const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = { registerTool: (name: string, _config: Row, handler: Handler) => handlers.set(name, handler) };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row, allowed: string[] = [], hosted = false) =>
  register(client, allowed, hosted).get(tool)!(args);

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const writes = (calls: { writes: Call[] }) => calls.writes.filter((w) => w.kind !== "get");

/** Resource names citados num IN ('a', 'b') da query. */
const namesInQuery = (query: string) => [...query.matchAll(/'(customers\/[^']+)'/g)].map((m) => m[1]);

// ── bulk_update_status ────────────────────────────────────────────────

test("bulk_update_status: lê antes, pula sem mudança/removido/inexistente e grava com partial failure", async () => {
  const status: Record<string, string> = { "111": "PAUSED", "222": "ENABLED", "333": "REMOVED", "444": "PAUSED" };
  const { client, calls } = fakeClient({
    rows: (from, query) => namesInQuery(query)
      .filter((rn) => status[rn.split("/").pop()!])
      .map((rn) => ({ campaign: { resourceName: rn, status: status[rn.split("/").pop()!], name: `C${rn.split("/").pop()}` } })),
    mutate: (_resource, operations) => ({
      results: operations.map((op, index) => (index === 1 ? {} : { resourceName: obj(op.update).resourceName })),
      partialFailureError: {
        message: "falhou",
        details: [{ errors: [{ message: "Campanha sem orçamento", errorCode: { campaignError: "X" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const result = await call(client, "bulk_update_status", {
    customerId: CID, resourceType: "campaigns", resourceIds: ["111", "222", "333", "444", "555", "111"], status: "ENABLED",
  });
  const mutates = calls.writes.filter((w) => w.kind === "mutate");
  assert.equal(mutates.length, 1);
  assert.equal(mutates[0].options?.partialFailure, true, "partial failure ligado");
  const ops = mutates[0].body.operations as Row[];
  assert.deepEqual(ops.map((op) => obj(op.update).resourceName), [`customers/${CID}/campaigns/111`, `customers/${CID}/campaigns/444`]);
  assert.ok(ops.every((op) => op.updateMask === "status" && obj(op.update).status === "ENABLED"));
  const body = textOf(result);
  assert.match(body, /1 campaigns → ENABLED/);
  assert.match(body, /Já estavam em ENABLED: 1 \| Removidos \(ignorados\): 1 \| Não encontrados: 1 \| Com erro: 1/);
  assert.match(body, /Campanha sem orçamento/);
  assert.equal(result.isError, true);
});

test("bulk_update_status: acima de 10.000 IDs divide o mutate em blocos e lê em blocos de 1.000", async () => {
  const ids = Array.from({ length: 10_001 }, (_, i) => String(100_000 + i));
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ adGroup: { resourceName: rn, status: "ENABLED", name: "g" } })),
  });
  const result = await call(client, "bulk_update_status", { customerId: CID, resourceType: "adGroups", resourceIds: ids, status: "PAUSED", confirm: true });
  const mutates = calls.writes.filter((w) => w.kind === "mutate");
  assert.deepEqual(mutates.map((m) => (m.body.operations as Row[]).length), [10_000, 1]);
  assert.equal(calls.queries.length, 11);
  assert.match(textOf(result), /10001 adGroups → PAUSED/);
  assert.equal(result.isError, false);
});

test("bulk_update_status: ID inválido é recusado antes de qualquer chamada", async () => {
  const { client, calls } = fakeClient();
  const bad = await call(client, "bulk_update_status", { customerId: CID, resourceType: "adGroupAds", resourceIds: ["123"], status: "PAUSED" });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /adGroupId~adId/);
  const empty = await call(client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: [], status: "PAUSED" });
  assert.equal(empty.isError, true);
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

test("bulk_update_status: anúncios usam adGroupId~adId e nada muda quando tudo já está no status", async () => {
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ adGroupAd: { resourceName: rn, status: "PAUSED", ad: { name: "A" } } })),
  });
  const result = await call(client, "bulk_update_status", { customerId: CID, resourceType: "adGroupAds", resourceIds: ["1~2", "3~4"], status: "PAUSED" });
  assert.match(calls.queries[0].query, /FROM ad_group_ad/);
  assert.equal(calls.writes.length, 0, "sem escrita quando nada muda");
  assert.match(textOf(result), /Já estavam em PAUSED: 2/);
});

test("bulk_update_status: validateOnly roda no client em dry-run e não diz que gravou", async () => {
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "PAUSED" } })),
  });
  const result = await call(client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ["1"], status: "ENABLED", validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): nada foi gravado/);
});

test("bulk_update_status: erro fora das operações interrompe e lista os não enviados", async () => {
  const ids = Array.from({ length: 10_005 }, (_, i) => String(1 + i));
  const { client } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "PAUSED" } })),
    mutate: () => { throw new Error("Google Ads API: quota"); },
  });
  const result = await call(client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids, status: "ENABLED", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Com erro: 10000 \| Não enviados: 5/);
});

// ── bulk_mutate ───────────────────────────────────────────────────────

const criterion = (id: string) => `customers/${CID}/adGroupCriteria/10~${id}`;

function bulkRows(from: string, query: string): Row[] {
  if (from === "ad_group_criterion") {
    const data: Record<string, Row> = {
      [criterion("1")]: { status: "ENABLED", cpcBidMicros: "1000000", finalUrls: ["https://a.com"] },
      [criterion("2")]: { status: "ENABLED", cpcBidMicros: "2000000" },
      [criterion("3")]: { status: "REMOVED" },
    };
    return namesInQuery(query).filter((rn) => data[rn]).map((rn) => ({ adGroupCriterion: { resourceName: rn, ...data[rn] } }));
  }
  if (from === "ad") {
    return namesInQuery(query).map((rn) => ({ ad: { resourceName: rn, finalUrlSuffix: "utm_source=old" } }));
  }
  if (from === "campaign_label") {
    return namesInQuery(query).map((rn) => ({ campaignLabel: { resourceName: rn } }));
  }
  return [];
}

const mixedOps = [
  { resource: "adGroupCriteria", action: "update", resourceName: criterion("1"), fields: { cpcBidMicros: 1500000 } },
  { resource: "adGroupCriteria", action: "update", resourceName: criterion("2"), fields: { cpcBidMicros: "2000000" } },
  { resource: "adGroupCriteria", action: "update", resourceName: criterion("3"), fields: { status: "PAUSED" } },
  { resource: "adGroupCriteria", action: "update", resourceName: criterion("9"), fields: { status: "PAUSED" } },
  { resource: "ads", action: "update", resourceName: `customers/${CID}/ads/55`, fields: { finalUrlSuffix: "utm_source=google" } },
  { resource: "campaignLabels", action: "create", fields: { campaign: `customers/${CID}/campaigns/7`, label: `customers/${CID}/labels/8` } },
  { resource: "campaignLabels", action: "remove", resourceName: `customers/${CID}/campaignLabels/7~9` },
];

test("bulk_mutate: preview (padrão) lê o estado, mostra antes/depois e não grava", async () => {
  const { client, calls } = fakeClient({ rows: bulkRows });
  const result = await call(client, "bulk_mutate", { customerId: CID, operations: mixedOps });
  assert.equal(calls.writes.length, 0);
  const body = textOf(result);
  assert.match(body, /PREVIEW — nada foi gravado\. 4 operação\(ões\) a enviar de 7/);
  assert.match(body, /"sem_mudanca": 1/);
  assert.match(body, /"nao_encontrados": 1/);
  assert.match(body, /"ja_removidos": 1/);
  assert.match(body, /"before": "1000000"/);
  const criterionQuery = calls.queries.find((q) => /FROM ad_group_criterion/.test(q.query))!.query;
  assert.match(criterionQuery, /ad_group_criterion\.cpc_bid_micros/);
  assert.match(criterionQuery, /ad_group_criterion\.status/);
});

test("bulk_mutate: gravar exige preview false + confirm; sem confirm nada é lido nem enviado", async () => {
  const { client, calls } = fakeClient({ rows: bulkRows });
  const result = await call(client, "bulk_mutate", { customerId: CID, operations: mixedOps, preview: false });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /preview: false e confirm: true/);
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

test("bulk_mutate: aplica por tipo de recurso com partial failure e updateMask só das folhas", async () => {
  const { client, calls } = fakeClient({
    rows: bulkRows,
    mutate: (resource, operations) => resource === "campaignLabels"
      ? {
          results: [{ resourceName: "x" }, {}],
          partialFailureError: { details: [{ errors: [{ message: "Label não encontrada", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
        }
      : { results: operations.map(() => ({ resourceName: "ok" })) },
  });
  const result = await call(client, "bulk_mutate", { customerId: CID, operations: mixedOps, preview: false, confirm: true });
  const mutates = calls.writes.filter((w) => w.kind === "mutate");
  assert.deepEqual(mutates.map((m) => m.target), ["adGroupCriteria", "ads", "campaignLabels"]);
  assert.ok(mutates.every((m) => m.options?.partialFailure === true));
  assert.deepEqual(mutates[0].body.operations, [
    { update: { cpcBidMicros: 1500000, resourceName: criterion("1") }, updateMask: "cpc_bid_micros" },
  ]);
  assert.deepEqual(mutates[1].body.operations, [
    { update: { finalUrlSuffix: "utm_source=google", resourceName: `customers/${CID}/ads/55` }, updateMask: "final_url_suffix" },
  ]);
  assert.deepEqual(mutates[2].body.operations, [
    { create: { campaign: `customers/${CID}/campaigns/7`, label: `customers/${CID}/labels/8` } },
    { remove: `customers/${CID}/campaignLabels/7~9` },
  ]);
  const body = textOf(result);
  assert.match(body, /3 operação\(ões\) aplicada\(s\) \| Com erro\/não enviadas: 1/);
  assert.match(body, /Label não encontrada/);
  assert.equal(result.isError, true);
});

test("bulk_mutate: campos aninhados viram máscara com folhas; objeto vazio é recusado", async () => {
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "ENABLED" } })),
  });
  const campaign = `customers/${CID}/campaigns/1`;
  await call(client, "bulk_mutate", {
    customerId: CID, preview: false, confirm: true,
    operations: [{ resource: "campaigns", action: "update", resourceName: campaign, fields: { networkSettings: { targetContentNetwork: false }, trackingUrlTemplate: "{lpurl}?a=1" } }],
  });
  const op = (calls.writes[0].body.operations as Row[])[0];
  assert.equal(op.updateMask, "network_settings.target_content_network,tracking_url_template");
  assert.match(calls.queries[0].query, /campaign\.network_settings\.target_content_network/);

  const { client: c2, calls: k2 } = fakeClient();
  const empty = await call(c2, "bulk_mutate", {
    customerId: CID, operations: [{ resource: "campaigns", action: "update", resourceName: campaign, fields: { manualCpc: {} } }],
  });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /FIELD_HAS_SUBFIELDS/);
  assert.equal(k2.queries.length + k2.writes.length, 0);
});

test("bulk_mutate: validação barra tudo antes da API (outra conta, ação inválida, duplicado, limite)", async () => {
  const { client, calls } = fakeClient();
  const cases: Array<[Row[], RegExp]> = [
    [[{ resource: "campaigns", action: "remove", resourceName: "customers/999/campaigns/1" }], /pertence à conta 999/],
    [[{ resource: "campaignLabels", action: "update", resourceName: `customers/${CID}/campaignLabels/1~2`, fields: { label: "x" } }], /aceita só create\/remove/],
    [[{ resource: "ads", action: "remove", resourceName: `customers/${CID}/ads/1` }], /aceita só update/],
    [[
      { resource: "campaigns", action: "remove", resourceName: `customers/${CID}/campaigns/1` },
      { resource: "campaigns", action: "update", resourceName: `customers/${CID}/campaigns/1`, fields: { status: "PAUSED" } },
    ], /já aparece na operação #0/],
    [[{ resource: "adGroupCriteria", action: "create", fields: { adGroup: "customers/777/adGroups/1" } }], /outra conta/],
    [[{ resource: "campaigns", action: "update", resourceName: `customers/${CID}/campaigns/1` }], /precisa de fields/],
    [[{ resource: "adGroupCriteria", action: "update", resourceName: `customers/${CID}/adGroupCriteria/12`, fields: { status: "PAUSED" } }], /resourceName inválido/],
  ];
  for (const [operations, expected] of cases) {
    const result = await call(client, "bulk_mutate", { customerId: CID, operations });
    assert.equal(result.isError, true, String(expected));
    assert.match(textOf(result), expected);
  }
  const tooMany = Array.from({ length: 10_001 }, (_, i) => ({ resource: "campaigns", action: "remove", resourceName: `customers/${CID}/campaigns/${i + 1}` }));
  const big = await call(client, "bulk_mutate", { customerId: CID, operations: tooMany });
  assert.match(textOf(big), /create_batch_job/);
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

test("bulk_mutate: falha na leitura é fail-closed (nada é enviado)", async () => {
  const { client, calls } = fakeClient({ rows: () => { throw new Error("Google Ads API: Unrecognized field"); } });
  const result = await call(client, "bulk_mutate", {
    customerId: CID, preview: false, confirm: true,
    operations: [{ resource: "campaigns", action: "update", resourceName: `customers/${CID}/campaigns/1`, fields: { status: "PAUSED" } }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Não foi possível ler o estado atual/);
  assert.equal(calls.writes.length, 0);
});

test("bulk_mutate: validateOnly valida na API sem gravar", async () => {
  const { client, calls } = fakeClient({ rows: bulkRows });
  const result = await call(client, "bulk_mutate", {
    customerId: CID, preview: false, confirm: true, validateOnly: true,
    operations: [mixedOps[0]],
  });
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): nada foi gravado\. 1 operação\(ões\) validada/);
});

// ── Batch jobs ────────────────────────────────────────────────────────

test("create_batch_job: cria, envia em blocos de 1.000 encadeando o sequence token e executa", async () => {
  const ops = Array.from({ length: 2_500 }, (_, i) => ({
    resource: "adGroupCriteria", action: "update", resourceName: criterion(String(100 + i)), fields: { status: "PAUSED" },
  }));
  let added = 0;
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ adGroupCriterion: { resourceName: rn, status: "ENABLED" } })),
    action: (action, body) => {
      if (action === "batchJobs:mutate") return { result: { resourceName: `customers/${CID}/batchJobs/77` } };
      if (action.endsWith(":addOperations")) {
        added += (body.mutateOperations as Row[]).length;
        return { totalOperations: String(added), nextSequenceToken: `tok${added}` };
      }
      if (action.endsWith(":run")) return { name: `customers/${CID}/operations/abc` };
      return {};
    },
  });
  const preview = await call(client, "create_batch_job", { customerId: CID, operations: ops });
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(preview), /PREVIEW — nada foi criado\. 2500/);

  const result = await call(client, "create_batch_job", { customerId: CID, operations: ops, preview: false, confirm: true, executionLimitSeconds: 3600 });
  const targets = calls.writes.map((w) => w.target);
  assert.deepEqual(targets, ["batchJobs:mutate", "batchJobs/77:addOperations", "batchJobs/77:addOperations", "batchJobs/77:addOperations", "batchJobs/77:run"]);
  assert.deepEqual(calls.writes[0].body, { operation: { create: { metadata: { executionLimitSeconds: 3600 } } } });
  const adds = calls.writes.filter((w) => w.target.endsWith(":addOperations"));
  assert.deepEqual(adds.map((a) => (a.body.mutateOperations as Row[]).length), [1000, 1000, 500]);
  assert.equal(adds[0].body.sequenceToken, undefined, "o primeiro envio vai sem token");
  assert.equal(adds[1].body.sequenceToken, "tok1000");
  assert.equal(adds[2].body.sequenceToken, "tok2000");
  const first = (adds[0].body.mutateOperations as Row[])[0];
  assert.deepEqual(first, { adGroupCriterionOperation: { update: { status: "PAUSED", resourceName: criterion("100") }, updateMask: "status" } });
  assert.match(textOf(result), /Batch job 77 criado e em execução: 2500/);
});

test("create_batch_job: falha no envio remove o job pendente e nada é executado", async () => {
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "ENABLED" } })),
    action: (action) => {
      if (action === "batchJobs:mutate") return { result: { resourceName: `customers/${CID}/batchJobs/5` } };
      if (action.endsWith(":addOperations")) throw new Error("Google Ads API: REQUEST_TOO_LARGE");
      return {};
    },
  });
  const result = await call(client, "create_batch_job", {
    customerId: CID, preview: false, confirm: true,
    operations: [{ resource: "campaigns", action: "update", resourceName: `customers/${CID}/campaigns/1`, fields: { status: "PAUSED" } }],
  });
  assert.equal(result.isError, true);
  assert.ok(!calls.writes.some((w) => w.target.endsWith(":run")));
  const removeCall = calls.writes.filter((w) => w.target === "batchJobs:mutate")[1];
  assert.deepEqual(removeCall.body, { operation: { remove: `customers/${CID}/batchJobs/5` } });
  assert.match(textOf(result), /Nada foi executado; o job pendente foi removido/);
});

test("create_batch_job: validateOnly é recusado (tool encadeada) e dry-run da env também", async () => {
  const { client, calls } = fakeClient();
  const op = [{ resource: "campaigns", action: "remove", resourceName: `customers/${CID}/campaigns/1` }];
  const refused = await call(client, "create_batch_job", { customerId: CID, operations: op, preview: false, confirm: true, validateOnly: true });
  assert.match(textOf(refused), /validateOnly não é suportado em create_batch_job/);
  assert.equal(calls.queries.length + calls.writes.length, 0);

  const env = fakeClient({ dryRun: true });
  const envResult = await call(env.client, "create_batch_job", { customerId: CID, operations: op, preview: false, confirm: true });
  assert.match(textOf(envResult), /BatchJobService não tem validate_only/);
  assert.equal(env.calls.writes.length, 0);
});

test("get_batch_job_status / get_batch_job_results: status antes, resultados só com DONE", async () => {
  let status = "RUNNING";
  const { client, calls } = fakeClient({
    rows: () => [{ batchJob: { id: "77", status, resourceName: `customers/${CID}/batchJobs/77`, metadata: { estimatedCompletionRatio: 0.4, operationCount: "10" } } }],
    get: () => ({
      results: [
        { operationIndex: "0", mutateOperationResponse: { campaignResult: { resourceName: `customers/${CID}/campaigns/1` } } },
        { operationIndex: "1", status: { code: 3, message: "erro", details: [{ errors: [{ message: "Orçamento inválido", errorCode: { campaignError: "BAD" } }] }] } },
      ],
      nextPageToken: "p2",
    }),
  });
  const st = await call(client, "get_batch_job_status", { customerId: CID, batchJobId: "77" });
  assert.match(textOf(st), /"progress_pct": 40/);
  assert.match(calls.queries[0].query, /WHERE batch_job\.id = 77/);

  const notReady = await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "77" });
  assert.equal(notReady.isError, true);
  assert.match(textOf(notReady), /ainda não terminou \(status RUNNING, 40%\)/);
  assert.equal(calls.writes.length, 0, "sem listResults antes de DONE");

  status = "DONE";
  const done = await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "77", onlyErrors: true });
  const get = calls.writes.find((w) => w.kind === "get")!;
  assert.equal(get.target, "batchJobs/77:listResults");
  assert.deepEqual(get.body, { pageSize: 1000, pageToken: undefined });
  assert.match(textOf(done), /1 ok, 1 com erro/);
  assert.match(textOf(done), /Orçamento inválido \[campaignError\.BAD\]/);
  assert.match(textOf(done), /pageToken: "p2"/);

  const bad = await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "abc" });
  assert.equal(bad.isError, true);
});

// ── Contas do MCC ─────────────────────────────────────────────────────

function mccRows(opts: { manager?: boolean; sameName?: boolean } = {}) {
  return (from: string): Row[] => {
    if (from === "customer") return [{ customer: { id: MCC, descriptiveName: "Agência", manager: opts.manager ?? true, status: "ENABLED" } }];
    if (from === "customer_client") return opts.sameName ? [{ customerClient: { id: "111", descriptiveName: "Cliente X", status: "ENABLED" } }] : [];
    return [];
  };
}

test("create_client_account: sem confirm mostra moeda/fuso imutáveis e não cria", async () => {
  const { client, calls } = fakeClient({ rows: mccRows() });
  const result = await call(client, "create_client_account", { managerCustomerId: MCC, name: "Cliente X" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /BRL \/ America\/Sao_Paulo\? Moeda e fuso NÃO podem ser alterados/);
  assert.equal(calls.writes.length, 0);
});

test("create_client_account: cria sob o MCC com o corpo do CreateCustomerClient", async () => {
  const { client, calls } = fakeClient({
    rows: mccRows(),
    action: () => ({ resourceName: "customers/4443332221" }),
  });
  const result = await call(client, "create_client_account", {
    managerCustomerId: "999-888-7776", name: "Cliente X", currencyCode: "usd", timeZone: "America/New_York",
    trackingUrlTemplate: "{lpurl}?utm_source=google", confirm: true,
  });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].kind, "write");
  assert.equal(calls.writes[0].cid, MCC);
  assert.equal(calls.writes[0].target, ":createCustomerClient");
  assert.deepEqual(calls.writes[0].body, {
    customerClient: { descriptiveName: "Cliente X", currencyCode: "USD", timeZone: "America/New_York", trackingUrlTemplate: "{lpurl}?utm_source=google" },
  });
  assert.match(textOf(result), /Conta criada: 4443332221/);
});

test("create_client_account: conta que não é MCC, nome duplicado e entradas inválidas são recusados", async () => {
  const notManager = fakeClient({ rows: mccRows({ manager: false }) });
  const r1 = await call(notManager.client, "create_client_account", { managerCustomerId: MCC, name: "X", confirm: true });
  assert.match(textOf(r1), /não é um MCC/);
  assert.equal(notManager.calls.writes.length, 0);

  const dup = fakeClient({ rows: mccRows({ sameName: true }) });
  const r2 = await call(dup.client, "create_client_account", { managerCustomerId: MCC, name: "Cliente X", confirm: true });
  assert.match(textOf(r2), /Já existe conta com o nome "Cliente X"/);
  assert.equal(dup.calls.writes.length, 0);
  assert.match(dup.calls.queries[1].query, /customer_client\.descriptive_name = 'Cliente X'/);

  const { client, calls } = fakeClient();
  for (const [args, expected] of [
    [{ currencyCode: "REAL" }, /currencyCode inválido/],
    [{ timeZone: "Sao Paulo" }, /timeZone inválido/],
    [{ trackingUrlTemplate: "utm=1" }, /trackingUrlTemplate/],
    [{ finalUrlSuffix: "?utm=1" }, /finalUrlSuffix/],
    [{ name: "" }, /1 a 255/],
  ] as Array<[Row, RegExp]>) {
    const result = await call(client, "create_client_account", { managerCustomerId: MCC, name: "Y", confirm: true, ...args });
    assert.match(textOf(result), expected);
  }
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

test("create_client_account: validateOnly vai com validate_only da API e não cria nada", async () => {
  const { client, calls } = fakeClient({ rows: mccRows() });
  const result = await call(client, "create_client_account", { managerCustomerId: MCC, name: "Novo", confirm: true, validateOnly: true });
  assert.equal(calls.writes[0].kind, "action");
  assert.equal(calls.writes[0].body.validateOnly, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): a API validou a criação — nenhuma conta foi criada/);
});

test("create_client_account: allowlist hospedada precisa liberar o MCC", async () => {
  const { client, calls } = fakeClient({ rows: mccRows() });
  const result = await call(client, "create_client_account", { managerCustomerId: MCC, name: "X", confirm: true }, [CID], true);
  assert.match(textOf(result), /Access denied/);
  assert.equal(calls.queries.length, 0);
});

// ── Vínculos ─────────────────────────────────────────────────────────

function linkRows(links: Array<{ status: string; hidden?: boolean }>, managerSide = true) {
  return (from: string, query: string): Row[] => {
    if (from === "customer_client_link") {
      const onlyPending = /status = 'PENDING'/.test(query);
      return links.filter((l) => !onlyPending || l.status === "PENDING").map((l, i) => ({
        customerClientLink: {
          resourceName: `customers/${MCC}/customerClientLinks/${CLIENT}~${100 + i}`,
          clientCustomer: `customers/${CLIENT}`, managerLinkId: String(100 + i), status: l.status, ...(l.hidden ? { hidden: true } : {}),
        },
      }));
    }
    if (from === "customer_manager_link" && !managerSide) {
      return links.map((l, i) => ({
        customerManagerLink: {
          resourceName: `customers/${CLIENT}/customerManagerLinks/${MCC}~${100 + i}`,
          managerCustomer: `customers/${MCC}`, managerLinkId: String(100 + i), status: l.status,
        },
      }));
    }
    if (from === "customer_client") return [{ customerClient: { clientCustomer: `customers/${CLIENT}`, descriptiveName: "Cliente", manager: false, status: "ENABLED" } }];
    return [];
  };
}

test("list_account_links: visão do MCC com nomes, contagem por status e aviso de pendentes", async () => {
  const { client, calls } = fakeClient({ rows: linkRows([{ status: "ACTIVE", hidden: true }, { status: "PENDING" }]) });
  const result = await call(client, "list_account_links", { customerId: MCC });
  const body = textOf(result);
  assert.match(body, /"PENDING": 1/);
  assert.match(body, /1 convite\(s\) pendente\(s\)/);
  assert.match(body, /"name": "Cliente"/);
  assert.match(body, /"hidden": true/);
  assert.equal(calls.queries.length, 2);

  const filtered = fakeClient({ rows: linkRows([]) });
  await call(filtered.client, "list_account_links", { customerId: CLIENT, view: "managers", status: "ACTIVE" });
  assert.match(filtered.calls.queries[0].query, /FROM customer_manager_link\s+WHERE customer_manager_link\.status = 'ACTIVE'/);
});

test("invite_client_account: cria o vínculo PENDING; não repete convite nem convida conta já gerenciada", async () => {
  const { client, calls } = fakeClient({
    rows: linkRows([{ status: "CANCELED" }]),
    action: () => ({ result: { resourceName: `customers/${MCC}/customerClientLinks/${CLIENT}~555` } }),
  });
  const result = await call(client, "invite_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].target, "customerClientLinks:mutate");
  assert.equal(calls.writes[0].cid, MCC);
  assert.deepEqual(calls.writes[0].body, { operation: { create: { clientCustomer: `customers/${CLIENT}`, status: "PENDING" } } });
  assert.match(textOf(result), /Convite enviado/);
  assert.match(textOf(result), /"manager_link_id": "555"/);

  for (const status of ["ACTIVE", "PENDING"]) {
    const again = fakeClient({ rows: linkRows([{ status }]) });
    const r = await call(again.client, "invite_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT });
    assert.equal(again.calls.writes.length, 0, status);
    assert.match(textOf(r), /Nada foi enviado/);
  }
  const self = await call(client, "invite_client_account", { managerCustomerId: MCC, clientCustomerId: MCC });
  assert.equal(self.isError, true);
});

test("invite_client_account: erro da API vem traduzido e validateOnly usa o validate_only do serviço", async () => {
  const { client } = fakeClient({
    rows: linkRows([]),
    action: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Manager has too many pending invitations."); },
  });
  const failed = await call(client, "invite_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /limite de 20 na mesma hierarquia/);

  const dry = fakeClient({ rows: linkRows([]) });
  const validated = await call(dry.client, "invite_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT, validateOnly: true });
  assert.equal(dry.calls.writes[0].kind, "action");
  assert.equal(dry.calls.writes[0].body.validateOnly, true);
  assert.match(textOf(validated), /convite validado, nada foi enviado/);
});

test("cancel_client_invitation e set_client_link_hidden: só mexem no que precisa", async () => {
  const pending = fakeClient({ rows: linkRows([{ status: "PENDING" }]) });
  await call(pending.client, "cancel_client_invitation", { managerCustomerId: MCC, clientCustomerId: CLIENT });
  assert.deepEqual(pending.calls.writes[0].body, {
    operation: { update: { resourceName: `customers/${MCC}/customerClientLinks/${CLIENT}~100`, status: "CANCELED" }, updateMask: "status" },
  });
  const none = fakeClient({ rows: linkRows([{ status: "ACTIVE" }]) });
  const noop = await call(none.client, "cancel_client_invitation", { managerCustomerId: MCC, clientCustomerId: CLIENT });
  assert.match(textOf(noop), /Não há convite pendente .*status atual: ACTIVE/);
  assert.equal(none.calls.writes.length, 0);

  const active = fakeClient({ rows: linkRows([{ status: "ACTIVE" }]) });
  await call(active.client, "set_client_link_hidden", { managerCustomerId: MCC, clientCustomerId: CLIENT, hidden: true });
  assert.deepEqual(active.calls.writes[0].body, {
    operation: { update: { resourceName: `customers/${MCC}/customerClientLinks/${CLIENT}~100`, hidden: true }, updateMask: "hidden" },
  });
  const already = fakeClient({ rows: linkRows([{ status: "ACTIVE", hidden: true }]) });
  const same = await call(already.client, "set_client_link_hidden", { managerCustomerId: MCC, clientCustomerId: CLIENT, hidden: true });
  assert.match(textOf(same), /já está oculta/);
  assert.equal(already.calls.writes.length, 0);
  const inactive = fakeClient({ rows: linkRows([{ status: "PENDING" }]) });
  const refused = await call(inactive.client, "set_client_link_hidden", { managerCustomerId: MCC, clientCustomerId: CLIENT, hidden: true });
  assert.equal(refused.isError, true);
});

test("unlink_client_account: exige confirm e desativa pela visão do cliente", async () => {
  const { client, calls } = fakeClient({ rows: linkRows([{ status: "ACTIVE" }], false) });
  const gate = await call(client, "unlink_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT });
  assert.equal(gate.isError, true);
  assert.match(textOf(gate), /confirm: true/);
  assert.equal(calls.writes.length, 0);

  const result = await call(client, "unlink_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT, confirm: true });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].kind, "mutate");
  assert.equal(calls.writes[0].cid, CLIENT);
  assert.equal(calls.writes[0].target, "customerManagerLinks");
  assert.deepEqual(calls.writes[0].body.operations, [
    { update: { resourceName: `customers/${CLIENT}/customerManagerLinks/${MCC}~100`, status: "INACTIVE" }, updateMask: "status" },
  ]);
  assert.match(calls.queries[0].query, /customer_manager_link\.manager_customer = 'customers\/9998887776'/);
  assert.match(textOf(result), /ACTIVE → INACTIVE/);

  const gone = fakeClient({ rows: linkRows([{ status: "INACTIVE" }], false) });
  const noop = await call(gone.client, "unlink_client_account", { managerCustomerId: MCC, clientCustomerId: CLIENT, confirm: true });
  assert.match(textOf(noop), /não tem vínculo ATIVO/);
  assert.equal(gone.calls.writes.length, 0);
});

test("move_client_account: MoveManagerLink com o vínculo atual; mesmo gerente não faz nada", async () => {
  const NEW = "1112223334";
  const { client, calls } = fakeClient({
    rows: linkRows([{ status: "ACTIVE" }], false),
    action: () => ({ resourceName: `customers/${CLIENT}/customerManagerLinks/${NEW}~9` }),
  });
  const gate = await call(client, "move_client_account", { clientCustomerId: CLIENT, fromManagerCustomerId: MCC, toManagerCustomerId: NEW });
  assert.equal(gate.isError, true);
  const result = await call(client, "move_client_account", { clientCustomerId: CLIENT, fromManagerCustomerId: MCC, toManagerCustomerId: NEW, confirm: true });
  assert.equal(calls.writes[0].target, "customerManagerLinks:moveManagerLink");
  assert.equal(calls.writes[0].cid, CLIENT);
  assert.deepEqual(calls.writes[0].body, {
    previousCustomerManagerLink: `customers/${CLIENT}/customerManagerLinks/${MCC}~100`,
    newManager: `customers/${NEW}`,
  });
  assert.match(textOf(result), /movida do gerente/);
  const same = await call(client, "move_client_account", { clientCustomerId: CLIENT, fromManagerCustomerId: MCC, toManagerCustomerId: MCC, confirm: true });
  assert.match(textOf(same), /mesmo gerente/);
  assert.equal(calls.writes.length, 1);
});

test("respond_to_manager_invitation: autentica como a conta cliente e aceita o convite pendente", async () => {
  const { client, calls } = fakeClient({ rows: linkRows([{ status: "PENDING" }], false) });
  const gate = await call(client, "respond_to_manager_invitation", { clientCustomerId: CLIENT, managerCustomerId: MCC, decision: "ACCEPT" });
  assert.match(textOf(gate), /Ele passa a controlar a conta/);
  assert.equal(calls.writes.length, 0);
  await call(client, "respond_to_manager_invitation", { clientCustomerId: CLIENT, managerCustomerId: MCC, decision: "ACCEPT", confirm: true });
  assert.deepEqual(calls.logins, [CLIENT, CLIENT]);
  assert.equal(calls.queries[0].login, CLIENT, "a leitura já vai com login-customer-id = cliente");
  assert.equal(calls.writes[0].login, CLIENT);
  assert.deepEqual(calls.writes[0].body.operations, [
    { update: { resourceName: `customers/${CLIENT}/customerManagerLinks/${MCC}~100`, status: "ACTIVE" }, updateMask: "status" },
  ]);
});

// ── Usuários ─────────────────────────────────────────────────────────

function userRows(users: Array<Partial<{ id: string; email: string; role: string; passkey: boolean; review: string }>>, invitations: Array<{ email: string; role: string }> = []) {
  return (from: string): Row[] => {
    if (from === "customer_user_access") {
      return users.map((u) => ({
        customerUserAccess: {
          resourceName: `customers/${CID}/customerUserAccesses/${u.id}`, userId: u.id, emailAddress: u.email, accessRole: u.role,
          ...(u.passkey ? { passkeyEnabled: true } : {}), ...(u.review ? { pendingMultiPartyAuthReview: u.review } : {}),
        },
      }));
    }
    if (from === "customer_user_access_invitation") {
      return invitations.map((inv, i) => ({
        customerUserAccessInvitation: {
          resourceName: `customers/${CID}/customerUserAccessInvitations/${70 + i}`, invitationId: String(70 + i),
          emailAddress: inv.email, accessRole: inv.role, invitationStatus: "PENDING",
        },
      }));
    }
    if (from === "customer_client") {
      return [MCC, CID, "7777777777"].map((id, level) => ({ customerClient: { id, descriptiveName: `Conta ${id}`, manager: level === 0, level, status: "ENABLED" } }));
    }
    return [];
  };
}

const team = [
  { id: "1", email: "dono@agencia.com", role: "ADMIN", passkey: true },
  { id: "2", email: "ex@agencia.com", role: "ADMIN" },
  { id: "3", email: "analista@agencia.com", role: "STANDARD", passkey: true },
];

test("list_account_users: sinaliza ADMIN, sem passkey e convites; allAccounts respeita a allowlist", async () => {
  const { client } = fakeClient({ rows: userRows(team, [{ email: "novo@cliente.com", role: "ADMIN" }]) });
  const result = await call(client, "list_account_users", { customerId: CID });
  const body = textOf(result);
  assert.match(body, /"admins": 2/);
  assert.match(body, /"admins_sem_passkey": 1/);
  assert.match(body, /"convites_pendentes": 1/);
  assert.match(body, /"flags": "ADMIN SEM_PASSKEY"/);

  const issues = await call(client, "list_account_users", { customerId: CID, onlyIssues: true, includeInvitations: false, format: "csv" });
  assert.doesNotMatch(textOf(issues), /analista@agencia\.com/);

  const scoped = fakeClient({ rows: userRows(team) });
  const all = await call(scoped.client, "list_account_users", { allAccounts: true, managerCustomerId: MCC, email: "ex@agencia.com" }, [MCC, CID], true);
  const queried = new Set(scoped.calls.queries.filter((q) => /customer_user_access/.test(q.query)).map((q) => q.cid));
  assert.deepEqual([...queried].sort(), [CID, MCC].sort(), "conta fora da allowlist não é lida");
  assert.match(textOf(all), /1 conta\(s\) fora da allowlist ignorada/);
  assert.match(textOf(all), /"usuarios": 2/);

  const missing = await call(client, "list_account_users", { allAccounts: true });
  assert.equal(missing.isError, true);
});

test("invite_user: recusado em validateOnly, não reconvida e exige confirm", async () => {
  const dry = fakeClient({ rows: userRows(team) });
  const refused = await call(dry.client, "invite_user", { customerId: CID, emailAddress: "a@b.com", accessRole: "STANDARD", confirm: true, validateOnly: true });
  assert.match(textOf(refused), /não tem validate_only na API/);
  assert.equal(dry.calls.queries.length + dry.calls.writes.length, 0);

  const { client, calls } = fakeClient({
    rows: userRows(team, [{ email: "pendente@x.com", role: "READ_ONLY" }]),
    action: () => ({ result: { multiPartyAuthReview: `customers/${CID}/multiPartyAuthReviews/42` } }),
  });
  const existing = await call(client, "invite_user", { customerId: CID, emailAddress: "DONO@agencia.com", accessRole: "READ_ONLY", confirm: true });
  assert.match(textOf(existing), /já tem acesso .* como ADMIN/);
  const pending = await call(client, "invite_user", { customerId: CID, emailAddress: "pendente@x.com", accessRole: "ADMIN", confirm: true });
  assert.match(textOf(pending), /já tem convite pendente/);
  const gate = await call(client, "invite_user", { customerId: CID, emailAddress: "novo@x.com", accessRole: "ADMIN" });
  assert.match(textOf(gate), /ADMIN controla usuários e faturamento/);
  assert.equal(calls.writes.length, 0);
  const bad = await call(client, "invite_user", { customerId: CID, emailAddress: "sem-arroba", accessRole: "ADMIN", confirm: true });
  assert.equal(bad.isError, true);

  const sent = await call(client, "invite_user", { customerId: CID, emailAddress: "novo@x.com", accessRole: "STANDARD", confirm: true });
  assert.equal(calls.writes[0].target, "customerUserAccessInvitations:mutate");
  assert.deepEqual(calls.writes[0].body, { operation: { create: { emailAddress: "novo@x.com", accessRole: "STANDARD" } } });
  assert.match(textOf(sent), /Aguardando aprovação multi-party/);
  assert.match(textOf(sent), /multiPartyAuthReviews\/42/);
});

test("change_user_role / remove_user: não deixam a conta sem ADMIN e só mandam o que muda", async () => {
  const solo = fakeClient({ rows: userRows([{ id: "1", email: "dono@a.com", role: "ADMIN" }, { id: "3", email: "b@a.com", role: "STANDARD" }]) });
  const demote = await call(solo.client, "change_user_role", { customerId: CID, userId: "1", accessRole: "STANDARD", confirm: true });
  assert.match(textOf(demote), /único ADMIN/);
  const remove = await call(solo.client, "remove_user", { customerId: CID, emailAddress: "dono@a.com", confirm: true });
  assert.match(textOf(remove), /único ADMIN/);
  assert.equal(solo.calls.writes.length, 0);

  const { client, calls } = fakeClient({
    rows: userRows(team),
    action: (_action, body) => ({ result: { resourceName: String(obj(obj(body.operation).update).resourceName ?? obj(body.operation).remove) } }),
  });
  const same = await call(client, "change_user_role", { customerId: CID, userId: "3", accessRole: "STANDARD", confirm: true });
  assert.match(textOf(same), /já é STANDARD/);
  assert.equal(calls.writes.length, 0);
  const changed = await call(client, "change_user_role", { customerId: CID, emailAddress: "ex@agencia.com", accessRole: "READ_ONLY", confirm: true });
  assert.deepEqual(calls.writes[0].body, {
    operation: { update: { resourceName: `customers/${CID}/customerUserAccesses/2`, accessRole: "READ_ONLY" }, updateMask: "access_role" },
  });
  assert.match(textOf(changed), /ADMIN → READ_ONLY/);
  await call(client, "remove_user", { customerId: CID, userId: "3", confirm: true });
  assert.deepEqual(calls.writes[1].body, { operation: { remove: `customers/${CID}/customerUserAccesses/3` } });

  const gate = fakeClient({ rows: userRows(team) });
  const noConfirm = await call(gate.client, "remove_user", { customerId: CID, userId: "3" });
  assert.match(textOf(noConfirm), /confirm: true/);
  assert.equal(gate.calls.writes.length, 0);
});

test("revoke_user_invitation: remove só convite pendente existente", async () => {
  const { client, calls } = fakeClient({
    rows: userRows(team, [{ email: "x@y.com", role: "ADMIN" }]),
    action: () => ({ result: { resourceName: `customers/${CID}/customerUserAccessInvitations/70` } }),
  });
  const missing = await call(client, "revoke_user_invitation", { customerId: CID, emailAddress: "z@y.com", confirm: true });
  assert.match(textOf(missing), /Não há convite pendente/);
  await call(client, "revoke_user_invitation", { customerId: CID, emailAddress: "X@y.com", confirm: true });
  assert.deepEqual(calls.writes[0].body, { operation: { remove: `customers/${CID}/customerUserAccessInvitations/70` } });
});

test("list_pending_approvals e resolve_approval", async () => {
  let reviewStatus = "PENDING";
  const rows = (from: string): Row[] => from === "multi_party_auth_review"
    ? [{ multiPartyAuthReview: { resourceName: `customers/${CID}/multiPartyAuthReviews/42`, multiPartyAuthReviewId: "42", reviewStatus, operationType: "CREATE", targetResource: "CUSTOMER_USER_ACCESS_INVITATION", requestUserEmail: "a@b.com" } }]
    : [];
  const { client, calls } = fakeClient({
    rows,
    action: () => ({ resultOrError: [{ result: { multiPartyAuthReview: `customers/${CID}/multiPartyAuthReviews/42` } }] }),
  });
  const list = await call(client, "list_pending_approvals", { customerId: CID });
  assert.match(calls.queries[0].query, /review_status = 'PENDING'/);
  assert.match(textOf(list), /1 pedido\(s\)/);
  const all = await call(client, "list_pending_approvals", { customerId: CID, status: "ALL" });
  assert.doesNotMatch(calls.queries[1].query, /WHERE/);
  assert.ok(all);

  const gate = await call(client, "resolve_approval", { customerId: CID, reviewId: "42", decision: "APPROVED" });
  assert.match(textOf(gate), /confirm: true/);
  await call(client, "resolve_approval", { customerId: CID, reviewId: `customers/${CID}/multiPartyAuthReviews/42`, decision: "APPROVED", confirm: true });
  assert.equal(calls.writes[0].target, "multiPartyAuthReview:resolve");
  assert.deepEqual(calls.writes[0].body, { operations: [{ multiPartyAuthReview: `customers/${CID}/multiPartyAuthReviews/42`, newStatus: "APPROVED" }] });

  const other = await call(client, "resolve_approval", { customerId: CID, reviewId: "customers/555/multiPartyAuthReviews/42", decision: "APPROVED", confirm: true });
  assert.match(textOf(other), /pertence à conta 555/);

  reviewStatus = "APPROVED";
  const done = await call(client, "resolve_approval", { customerId: CID, reviewId: "42", decision: "REJECTED", confirm: true });
  assert.match(textOf(done), /não está pendente/);
  assert.equal(calls.writes.length, 1);

  reviewStatus = "PENDING";
  const refused = fakeClient({
    rows,
    action: () => ({ resultOrError: [{ partialFailureError: { details: [{ errors: [{ message: "O solicitante não pode aprovar", errorCode: { multiPartyAuthError: "X" } }] }] } }] }),
  });
  const rejected = await call(refused.client, "resolve_approval", { customerId: CID, reviewId: "42", decision: "APPROVED", confirm: true });
  assert.equal(rejected.isError, true);
  assert.match(textOf(rejected), /O solicitante não pode aprovar/);

  const dry = await call(client, "resolve_approval", { customerId: CID, reviewId: "42", decision: "APPROVED", confirm: true, validateOnly: true });
  assert.match(textOf(dry), /MultiPartyAuthReviewService não tem validate_only/);
});

// ── Faturamento ──────────────────────────────────────────────────────

const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const iso = (date: Date) => `${day(date)} 00:00:00`;
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

function billingRows(opts: { budgets?: Row[]; setups?: Row[] } = {}) {
  return (from: string, query: string): Row[] => {
    if (from === "customer") return [{ customer: { descriptiveName: "Cliente", currencyCode: "BRL", manager: false } }];
    if (from === "billing_setup") {
      return (opts.setups ?? [{ id: "11", status: "APPROVED", resourceName: `customers/${CID}/billingSetups/11`, paymentsAccountInfo: { paymentsAccountId: "1234-5678-9012-3456" } }])
        .map((s) => ({ billingSetup: s }));
    }
    if (from === "account_budget") {
      const idMatch = /account_budget\.id = (\d+)/.exec(query);
      return (opts.budgets ?? []).filter((b) => !idMatch || b.id === idMatch[1]).map((b) => ({ accountBudget: b }));
    }
    if (from === "account_budget_proposal") {
      return [{ accountBudgetProposal: { resourceName: `customers/${CID}/accountBudgetProposals/88`, id: "88", status: query.includes("= 89") ? "APPROVED" : "PENDING", proposalType: "UPDATE" } }]
        .filter((p) => query.includes(`= ${p.accountBudgetProposal.id}`) || query.includes("= 89"));
    }
    return [];
  };
}

const activeBudget = (overrides: Row = {}): Row => ({
  resourceName: `customers/${CID}/accountBudgets/33`, id: "33", name: "Setembro", status: "APPROVED",
  approvedStartDateTime: iso(daysFromNow(-20)), approvedEndDateTime: iso(daysFromNow(3)),
  approvedSpendingLimitMicros: "10000000000", adjustedSpendingLimitMicros: "10000000000", amountServedMicros: "9000000000",
  ...overrides,
});

test("get_billing_status: saldo restante, dias até o fim e alertas", async () => {
  const { client } = fakeClient({ rows: billingRows({ budgets: [activeBudget()] }) });
  const result = await call(client, "get_billing_status", { customerId: CID });
  const body = textOf(result);
  assert.match(body, /"remaining": 1000/);
  assert.match(body, /"remaining_pct": 10/);
  assert.match(body, /abaixo de 20%/);
  assert.match(body, /termina em [34] dia/);
  assert.match(body, /não há próximo orçamento aprovado/);

  const none = fakeClient({ rows: billingRows({ budgets: [] }) });
  const prepaid = await call(none.client, "get_billing_status", { customerId: CID });
  assert.match(textOf(prepaid), /não usa faturamento mensal/);

  const table = await call(client, "get_billing_status", { customerId: CID, format: "table" });
  assert.match(textOf(table), /remaining_pct/);
});

test("propose_account_budget: CREATE monta a proposta com o billing setup aprovado", async () => {
  const { client, calls } = fakeClient({
    rows: billingRows(),
    action: () => ({ result: { resourceName: `customers/${CID}/accountBudgetProposals/90` } }),
  });
  const startDay = day(daysFromNow(10));
  const endDay = day(daysFromNow(40));
  const gate = await call(client, "propose_account_budget", { customerId: CID, proposalType: "CREATE", name: "Outubro", spendingLimitMicros: 5_000_000_000, endDateTime: endDay });
  assert.match(textOf(gate), /confirm: true/);
  assert.equal(calls.writes.length, 0);
  const result = await call(client, "propose_account_budget", {
    customerId: CID, proposalType: "CREATE", name: "Outubro", spendingLimitMicros: 5_000_000_000,
    startDateTime: startDay, endDateTime: endDay, purchaseOrderNumber: "PO-1", confirm: true,
  });
  assert.equal(calls.writes[0].target, "accountBudgetProposals:mutate");
  assert.deepEqual(calls.writes[0].body, {
    operation: {
      create: {
        billingSetup: `customers/${CID}/billingSetups/11`, proposalType: "CREATE", proposedName: "Outubro",
        proposedStartDateTime: `${startDay} 00:00:00`, proposedEndDateTime: `${endDay} 23:59:59`,
        proposedSpendingLimitMicros: "5000000000", proposedPurchaseOrderNumber: "PO-1",
      },
    },
  });
  assert.match(textOf(result), /Proposta CREATE enviada/);

  const missing = await call(client, "propose_account_budget", { customerId: CID, proposalType: "CREATE", name: "X", spendingLimitMicros: 1, confirm: true });
  assert.match(textOf(missing), /exige endDateTime/);
  const badDate = await call(client, "propose_account_budget", { customerId: CID, proposalType: "CREATE", name: "X", spendingLimitMicros: 1, endDateTime: "31/10/2026", confirm: true });
  assert.match(textOf(badDate), /endDateTime inválido/);
  const past = await call(client, "propose_account_budget", { customerId: CID, proposalType: "CREATE", name: "X", spendingLimitMicros: 1, endDateTime: day(daysFromNow(-2)), confirm: true });
  assert.match(textOf(past), /está no passado/);
  assert.equal(calls.writes.length, 1);
});

test("propose_account_budget: UPDATE só com o que muda (máscara pelo oneof), no-op e proposta pendente", async () => {
  const { client, calls } = fakeClient({
    rows: billingRows({ budgets: [activeBudget()] }),
    action: () => ({ result: { resourceName: `customers/${CID}/accountBudgetProposals/91` } }),
  });
  const noop = await call(client, "propose_account_budget", { customerId: CID, proposalType: "UPDATE", accountBudgetId: "33", name: "Setembro", spendingLimitMicros: 10_000_000_000, confirm: true });
  assert.match(textOf(noop), /Nada a mudar/);
  assert.equal(calls.writes.length, 0);

  await call(client, "propose_account_budget", {
    customerId: CID, proposalType: "UPDATE", accountBudgetId: "33", name: "Setembro", spendingLimitMicros: 12_000_000_000, endDateTime: "FOREVER", confirm: true,
  });
  assert.deepEqual(calls.writes[0].body, {
    operation: {
      create: { proposalType: "UPDATE", accountBudget: `customers/${CID}/accountBudgets/33`, proposedSpendingLimitMicros: "12000000000", proposedEndTimeType: "FOREVER" },
      updateMask: "proposed_spending_limit,proposed_end_time",
    },
  });

  const startedStart = await call(client, "propose_account_budget", { customerId: CID, proposalType: "UPDATE", accountBudgetId: "33", startDateTime: day(daysFromNow(90)), confirm: true });
  assert.match(textOf(startedStart), /já começou/);

  const pending = fakeClient({ rows: billingRows({ budgets: [activeBudget({ pendingProposal: { accountBudgetProposal: `customers/${CID}/accountBudgetProposals/88`, proposalType: "UPDATE" } })] }) });
  const blocked = await call(pending.client, "propose_account_budget", { customerId: CID, proposalType: "UPDATE", accountBudgetId: "33", name: "Novo", confirm: true });
  assert.match(textOf(blocked), /já tem proposta UPDATE pendente/);
  assert.equal(pending.calls.writes.length, 0);
});

test("propose_account_budget: END/REMOVE conferem a fase do orçamento; validateOnly usa validate_only", async () => {
  const future = activeBudget({ id: "34", resourceName: `customers/${CID}/accountBudgets/34`, approvedStartDateTime: iso(daysFromNow(10)), approvedEndDateTime: iso(daysFromNow(40)) });
  const { client, calls } = fakeClient({ rows: billingRows({ budgets: [activeBudget(), future] }) });
  const endFuture = await call(client, "propose_account_budget", { customerId: CID, proposalType: "END", accountBudgetId: "34", confirm: true });
  assert.match(textOf(endFuture), /END só encerra orçamento em andamento.*Use REMOVE/);
  const removeActive = await call(client, "propose_account_budget", { customerId: CID, proposalType: "REMOVE", accountBudgetId: "33", confirm: true });
  assert.match(textOf(removeActive), /Use END/);
  const extra = await call(client, "propose_account_budget", { customerId: CID, proposalType: "END", accountBudgetId: "33", name: "x", confirm: true });
  assert.match(textOf(extra), /não leva outros campos/);
  assert.equal(calls.writes.length, 0);

  const validated = await call(client, "propose_account_budget", { customerId: CID, proposalType: "END", accountBudgetId: "33", confirm: true, validateOnly: true });
  assert.equal(calls.writes[0].kind, "action");
  assert.deepEqual(calls.writes[0].body, { operation: { create: { proposalType: "END", accountBudget: `customers/${CID}/accountBudgets/33` } }, validateOnly: true });
  assert.match(textOf(validated), /proposta validada, nada foi enviado/);
});

test("cancel_account_budget_proposal: só cancela proposta pendente", async () => {
  const { client, calls } = fakeClient({ rows: billingRows() });
  const approved = await call(client, "cancel_account_budget_proposal", { customerId: CID, proposalId: "89", confirm: true });
  assert.match(textOf(approved), /não está pendente/);
  const gate = await call(client, "cancel_account_budget_proposal", { customerId: CID, proposalId: "88" });
  assert.match(textOf(gate), /confirm: true/);
  await call(client, "cancel_account_budget_proposal", { customerId: CID, proposalId: "88", confirm: true });
  assert.deepEqual(calls.writes.map((w) => w.body), [{ operation: { remove: `customers/${CID}/accountBudgetProposals/88` } }]);
});

test("list_account_users: EMAIL_ONLY não conta como sem passkey", async () => {
  const { client } = fakeClient({ rows: userRows([{ id: "9", email: "relatorio@cliente.com", role: "EMAIL_ONLY" }]) });
  const result = await call(client, "list_account_users", { customerId: CID, onlyIssues: true, includeInvitations: false });
  assert.match(textOf(result), /"sem_passkey": 0/);
  assert.doesNotMatch(textOf(result), /relatorio@cliente\.com/);
});

test("list_invoices: usa o billing setup aprovado, o mês por extenso e o gerente pagador como login", async () => {
  const { client, calls } = fakeClient({
    rows: billingRows(),
    get: () => ({
      invoices: [{
        id: "5555", type: "INVOICE", issueDate: "2026-09-01", currencyCode: "BRL", totalAmountMicros: "1234560000",
        accountBudgetSummaries: [{ customer: `customers/${CID}`, accountBudgetName: "Agosto", totalAmountMicros: "1234560000",
          campaignSummaries: [{ campaignDescription: "Busca", amountMicros: "1000000000" }] }],
      }],
    }),
  });
  const result = await call(client, "list_invoices", { customerId: CID, year: 2026, month: 8, granular: true, payingManagerCustomerId: MCC });
  const get = calls.writes.find((w) => w.kind === "get")!;
  assert.equal(get.target, "invoices");
  assert.equal(get.login, MCC);
  assert.deepEqual(get.body, { billingSetup: `customers/${CID}/billingSetups/11`, issueYear: "2026", issueMonth: "AUGUST", includeGranularLevelInvoiceDetails: true });
  assert.match(textOf(result), /"total": 1234.56/);
  assert.match(textOf(result), /"campaign": "Busca"/);

  const notInvoiced = fakeClient({ rows: billingRows(), get: () => { throw new Error("Google Ads API: Request contains an invalid argument. — NOT_INVOICED_CUSTOMER"); } });
  const failed = await call(notInvoiced.client, "list_invoices", { customerId: CID, year: 2026, month: 8 });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /faturamento mensal/);

  const noSetup = fakeClient({ rows: billingRows({ setups: [] }) });
  const empty = await call(noSetup.client, "list_invoices", { customerId: CID, year: 2026, month: 8 });
  assert.match(textOf(empty), /não tem billing setup aprovado/);
  assert.equal(noSetup.calls.writes.length, 0);
});

test("list_payments_accounts: GET paymentsAccounts com o login pedido", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ paymentsAccounts: [{ paymentsAccountId: "1111-2222-3333-4444", name: "Agência", currencyCode: "BRL", payingManagerCustomer: `customers/${MCC}` }] }),
  });
  const result = await call(client, "list_payments_accounts", { customerId: CID });
  assert.equal(calls.writes[0].target, "paymentsAccounts");
  assert.equal(calls.writes[0].login, "login-padrao");
  assert.match(textOf(result), /"paying_manager_customer_id": "9998887776"/);
  const bad = await call(client, "list_payments_accounts", { customerId: CID, payingManagerCustomerId: "abc" });
  assert.equal(bad.isError, true);
});

// ── GoogleAdsClient real com fetch interceptado ──────────────────────

function interceptFetch(respond: (url: string, method: string, body: Row) => unknown) {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; method: string; body: Row; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; method?: string; headers?: Record<string, string> }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = JSON.parse(String(init?.body ?? "{}")) as Row;
    if (typeof body.query === "string") assertGaqlRules(body.query);
    sent.push({ url, method, body, headers: init?.headers ?? {} });
    return new Response(JSON.stringify(respond(url, method, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

const realClient = () => new GoogleAdsClient({
  credentials: {
    token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token",
    client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z",
  },
  developerToken: "d",
  loginCustomerId: MCC,
});

test("cliente real: aceitar convite vai com login-customer-id da conta cliente", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream")
    ? [{ results: [{ customerManagerLink: { resourceName: `customers/${CLIENT}/customerManagerLinks/${MCC}~7`, status: "PENDING" } }] }]
    : { results: [{ resourceName: `customers/${CLIENT}/customerManagerLinks/${MCC}~7` }] }));
  try {
    const client = realClient();
    const result = await register(client).get("respond_to_manager_invitation")!({ clientCustomerId: CLIENT, managerCustomerId: MCC, decision: "ACCEPT", confirm: true });
    assert.equal(net.sent.length, 2);
    assert.ok(net.sent.every((s) => s.headers["login-customer-id"] === CLIENT));
    assert.ok(net.sent[1].url.endsWith(`/v25/customers/${CLIENT}/customerManagerLinks:mutate`));
    assert.match(textOf(result), /Convite aceito/);
    assert.equal((client as unknown as { loginCustomerId: string }).loginCustomerId, MCC, "o client original mantém o login");
  } finally {
    net.restore();
  }
});

test("cliente real: faturas por GET com query string e gerente pagador no header", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream") ? [{ results: [] }] : { invoices: [] }));
  try {
    const result = await register(realClient()).get("list_invoices")!({ customerId: CID, year: 2026, month: 1, billingSetupId: "11", payingManagerCustomerId: "111-222-3333" });
    assert.equal(net.sent.length, 1);
    assert.equal(net.sent[0].method, "GET");
    const url = new URL(net.sent[0].url);
    assert.equal(url.pathname, `/v25/customers/${CID}/invoices`);
    assert.equal(url.searchParams.get("billingSetup"), `customers/${CID}/billingSetups/11`);
    assert.equal(url.searchParams.get("issueYear"), "2026");
    assert.equal(url.searchParams.get("issueMonth"), "JANUARY");
    assert.equal(url.searchParams.has("includeGranularLevelInvoiceDetails"), false);
    assert.equal(net.sent[0].headers["login-customer-id"], "1112223333");
    assert.match(textOf(result), /0 fatura/);
  } finally {
    net.restore();
  }
});

test("cliente real: createCustomerClient em validateOnly e convite de usuário bloqueado em dry-run", async () => {
  const net = interceptFetch((url, _method, body) => {
    if (!url.endsWith(":searchStream")) return {};
    return /FROM customer\b(?!_)/.test(String(body.query)) ? [{ results: [{ customer: { id: MCC, manager: true } }] }] : [{ results: [] }];
  });
  try {
    const handlers = register(realClient());
    const result = await handlers.get("create_client_account")!({ managerCustomerId: MCC, name: "Nova", confirm: true, validateOnly: true });
    const post = net.sent.find((s) => s.url.endsWith(":createCustomerClient"))!;
    assert.equal(post.url, `https://googleads.googleapis.com/v25/customers/${MCC}:createCustomerClient`);
    assert.equal(post.body.validateOnly, true);
    assert.deepEqual(post.body.customerClient, { descriptiveName: "Nova", currencyCode: "BRL", timeZone: "America/Sao_Paulo" });
    assert.match(textOf(result), /^VALIDATE-ONLY/);

    net.sent.length = 0;
    const refused = await handlers.get("invite_user")!({ customerId: CID, emailAddress: "a@b.com", accessRole: "ADMIN", confirm: true, validateOnly: true });
    assert.equal(net.sent.length, 0);
    assert.equal(refused.isError, true);
  } finally {
    net.restore();
  }
});

test("cliente real: resultados de batch job por GET em batchJobs/{id}:listResults", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream")
    ? [{ results: [{ batchJob: { id: "77", status: "DONE" } }] }]
    : { results: [] }));
  try {
    await register(realClient()).get("get_batch_job_results")!({ customerId: CID, batchJobId: "77", pageSize: 500, pageToken: "abc" });
    const get = net.sent[1];
    assert.equal(get.method, "GET");
    assert.equal(get.url, `https://googleads.googleapis.com/v25/customers/${CID}/batchJobs/77:listResults?pageSize=500&pageToken=abc`);
  } finally {
    net.restore();
  }
});

test("withLoginCustomerId recusa ID inválido e preserva o dry-run", () => {
  const client = realClient();
  assert.throws(() => client.withLoginCustomerId("abc"), /login-customer-id inválido/);
  const scoped = client.withDryRun().withLoginCustomerId("123-456-7890");
  assert.equal(scoped.isDryRun, true);
  assert.equal(client.isDryRun, false);
});

// ── Correções da revisão ──────────────────────────────────────────────

const FOREIGN = "4443332221";

function foreignLinkRows(from: string): Row[] {
  if (from === "customer_client_link") {
    return [CID, FOREIGN].map((id, i) => ({
      customerClientLink: {
        resourceName: `customers/${MCC}/customerClientLinks/${id}~${200 + i}`,
        clientCustomer: `customers/${id}`, managerLinkId: String(200 + i), status: i === 0 ? "ACTIVE" : "PENDING",
      },
    }));
  }
  if (from === "customer_client") {
    return [
      { customerClient: { clientCustomer: `customers/${CID}`, descriptiveName: "Cliente Liberado", manager: false, status: "ENABLED" } },
      { customerClient: { clientCustomer: `customers/${FOREIGN}`, descriptiveName: "Cliente Secreto", manager: false, status: "ENABLED" } },
    ];
  }
  if (from === "customer_manager_link") {
    return [MCC, FOREIGN].map((id, i) => ({
      customerManagerLink: { resourceName: `customers/${CID}/customerManagerLinks/${id}~${300 + i}`, managerCustomer: `customers/${id}`, managerLinkId: String(300 + i), status: "ACTIVE" },
    }));
  }
  return [];
}

test("list_account_links: no modo hospedado não mostra contas fora da allowlist (nem nas contagens)", async () => {
  const { client } = fakeClient({ rows: foreignLinkRows });
  const hostedClients = textOf(await call(client, "list_account_links", { customerId: MCC }, [MCC, CID], true));
  assert.doesNotMatch(hostedClients, new RegExp(FOREIGN));
  assert.doesNotMatch(hostedClients, /Cliente Secreto/);
  assert.match(hostedClients, /Cliente Liberado/);
  assert.match(hostedClients, /MCC 9998887776: 1 vínculo\(s\) \{\s*"ACTIVE": 1\s*\}/, "o PENDING da conta oculta não entra nas contagens");
  assert.match(hostedClients, /1 vínculo\(s\) com contas fora de ALLOWED_CUSTOMER_IDS ocultado\(s\)/);

  const csv = textOf(await call(client, "list_account_links", { customerId: MCC, format: "csv" }, [MCC, CID], true));
  assert.doesNotMatch(csv, new RegExp(`${FOREIGN}|Cliente Secreto`));

  const managers = textOf(await call(client, "list_account_links", { customerId: CID, view: "managers" }, [MCC, CID], true));
  assert.doesNotMatch(managers, new RegExp(FOREIGN));
  assert.match(managers, /1 vínculo\(s\) com gerentes fora de ALLOWED_CUSTOMER_IDS ocultado/);

  // Sem allowlist no stdio e com "*" nada é ocultado.
  for (const [allowed, hosted] of [[[], false], [["*"], true]] as Array<[string[], boolean]>) {
    const all = textOf(await call(client, "list_account_links", { customerId: MCC }, allowed, hosted));
    assert.match(all, /Cliente Secreto/);
    assert.doesNotMatch(all, /ocultado/);
  }
});

test("list_invoices: orçamentos de contas fora da allowlist viram um total agregado e o PDF sai", async () => {
  const invoice = {
    id: "5555", currencyCode: "BRL", totalAmountMicros: "3000000000", pdfUrl: "https://ads.google.com/pdf/5555",
    accountBudgetSummaries: [
      { customer: `customers/${CID}`, customerDescriptiveName: "Cliente Liberado", accountBudgetName: "Agosto", totalAmountMicros: "1000000000",
        campaignSummaries: [{ campaignDescription: "Busca Liberada", amountMicros: "1000000000" }] },
      { customer: `customers/${FOREIGN}`, customerDescriptiveName: "Cliente Secreto", accountBudgetName: "Orçamento Secreto", totalAmountMicros: "1500000000",
        subtotalAmountMicros: "1400000000", campaignSummaries: [{ campaignDescription: "Campanha Secreta", amountMicros: "1500000000" }] },
      { customer: "customers/1112223334", customerDescriptiveName: "Outro Secreto", totalAmountMicros: "500000000", subtotalAmountMicros: "450000000" },
    ],
  };
  const { client } = fakeClient({ rows: billingRows(), get: () => ({ invoices: [invoice] }) });
  const hosted = textOf(await call(client, "list_invoices", { customerId: CID, year: 2026, month: 8, granular: true }, [CID], true));
  assert.doesNotMatch(hosted, /Cliente Secreto|Outro Secreto|Orçamento Secreto|Campanha Secreta|4443332221|1112223334/);
  assert.match(hosted, /Busca Liberada/);
  assert.match(hosted, /"outras_contas_fora_da_allowlist": \{\s*"orcamentos": 2,\s*"subtotal": 1850,\s*"tax": 0,\s*"total": 2000/);
  assert.match(hosted, /"pdf_url": null/);
  assert.match(hosted, /2 orçamento\(s\) de contas fora de ALLOWED_CUSTOMER_IDS agrupado/);

  const open = textOf(await call(client, "list_invoices", { customerId: CID, year: 2026, month: 8, granular: true }));
  assert.match(open, /Cliente Secreto/);
  assert.match(open, /"pdf_url": "https:\/\/ads\.google\.com\/pdf\/5555"/);
  assert.doesNotMatch(open, /outras_contas_fora_da_allowlist/);
});

test("bulk_mutate: payload e updateMask levam só os campos que mudam (o preview bate com a escrita)", async () => {
  const rn = criterion("1");
  const { client, calls } = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((name) => ({ adGroupCriterion: { resourceName: name, status: "PAUSED", cpcBidMicros: "1000000" } })),
  });
  const operations = [{ resource: "adGroupCriteria", action: "update", resourceName: rn, fields: { status: "PAUSED", cpcBidMicros: 1500000 } }];
  const preview = textOf(await call(client, "bulk_mutate", { customerId: CID, operations }));
  assert.match(preview, /"update_mask": "cpc_bid_micros"/);
  assert.doesNotMatch(preview, /"update_mask": "status,cpc_bid_micros"/);

  await call(client, "bulk_mutate", { customerId: CID, operations, preview: false, confirm: true });
  const mutate = calls.writes.find((w) => w.kind === "mutate")!;
  assert.deepEqual(mutate.body.operations, [{ update: { cpcBidMicros: 1500000, resourceName: rn }, updateMask: "cpc_bid_micros" }]);

  // Campo aninhado: só a folha que muda fica, dentro da mesma mensagem.
  const campaign = `customers/${CID}/campaigns/1`;
  const nested = fakeClient({
    rows: (_from, query) => namesInQuery(query).map((name) => ({ campaign: { resourceName: name, status: "ENABLED", networkSettings: { targetSearchNetwork: true, targetContentNetwork: true } } })),
  });
  await call(nested.client, "bulk_mutate", {
    customerId: CID, preview: false, confirm: true,
    operations: [{ resource: "campaigns", action: "update", resourceName: campaign, fields: { networkSettings: { targetSearchNetwork: true, targetContentNetwork: false } } }],
  });
  assert.deepEqual(nested.calls.writes[0].body.operations, [
    { update: { networkSettings: { targetContentNetwork: false }, resourceName: campaign }, updateMask: "network_settings.target_content_network" },
  ]);
});

test("create_batch_job: devolve o mapa completo enviada→entrada e get_batch_job_results traduz para input_index", async () => {
  // Probe da revisão: 1.000 updates; ids < 700 já estão PAUSED (600 sem mudança), o resto muda.
  const ops = Array.from({ length: 1_000 }, (_, i) => ({
    resource: "adGroupCriteria", action: "update", resourceName: criterion(String(100 + i)), fields: { status: "PAUSED" },
  }));
  let added = 0;
  const { client, calls } = fakeClient({
    rows: (from, query) => from === "batch_job"
      ? [{ batchJob: { id: "77", status: "DONE", metadata: { operationCount: "400" } } }]
      : namesInQuery(query).map((rn) => ({ adGroupCriterion: { resourceName: rn, status: Number(rn.split("~")[1]) < 700 ? "PAUSED" : "ENABLED" } })),
    action: (action, body) => {
      if (action === "batchJobs:mutate") return { result: { resourceName: `customers/${CID}/batchJobs/77` } };
      if (action.endsWith(":addOperations")) {
        added += (body.mutateOperations as Row[]).length;
        return { totalOperations: String(added), nextSequenceToken: "t" };
      }
      return { name: "op" };
    },
    get: () => ({
      results: [
        { operationIndex: "0", status: { code: 3, details: [{ errors: [{ message: "Critério inválido" }] }] } },
        { operationIndex: "399", mutateOperationResponse: { adGroupCriterionResult: { resourceName: criterion("1099") } } },
      ],
    }),
  });
  const created = textOf(await call(client, "create_batch_job", { customerId: CID, operations: ops, preview: false, confirm: true }));
  assert.match(created, /400 operação\(ões\) enviada\(s\) de 1000/);
  assert.match(created, /"mapa_indices": "0-399:600"/);
  assert.match(created, /"sem_mudanca": \{\s*"total": 600,\s*"indices": "0-599"\s*\}/);

  const results = textOf(await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "77", indexMap: "0-399:600" }));
  assert.match(results, /"operation_index": 0,\s*"input_index": 600/);
  assert.match(results, /"operation_index": 399,\s*"input_index": 999/);

  // Mapa de outro job (tamanho diferente) e mapa malformado: recusados antes do listResults.
  const gets = () => calls.writes.filter((w) => w.kind === "get").length;
  const before = gets();
  const wrongJob = await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "77", indexMap: "0-9:0" });
  assert.equal(wrongJob.isError, true);
  assert.match(textOf(wrongJob), /cobre 10 operação\(ões\), mas o batch job 77 tem 400/);
  const malformed = await call(client, "get_batch_job_results", { customerId: CID, batchJobId: "77", indexMap: "5-9:0" });
  assert.equal(malformed.isError, true);
  assert.match(textOf(malformed), /indexMap inválido/);
  assert.equal(gets(), before);
});

test("create_batch_job: mapa com pulos intercalados cobre cada operação enviada, sem corte", async () => {
  // 3.000 operações; toda terceira não existe na conta → 2.000 enviadas em 1.000 trechos.
  const ops = Array.from({ length: 3_000 }, (_, i) => ({
    resource: "campaigns", action: "update", resourceName: `customers/${CID}/campaigns/${i + 1}`, fields: { status: "PAUSED" },
  }));
  const { client } = fakeClient({
    rows: (_from, query) => namesInQuery(query)
      .filter((rn) => Number(rn.split("/").pop()) % 3 !== 0)
      .map((rn) => ({ campaign: { resourceName: rn, status: "ENABLED" } })),
    action: (action) => (action === "batchJobs:mutate" ? { result: { resourceName: `customers/${CID}/batchJobs/9` } } : {}),
  });
  const body = textOf(await call(client, "create_batch_job", { customerId: CID, operations: ops, preview: false, confirm: true }));
  const map = /"mapa_indices": "([^"]+)"/.exec(body)![1];
  const segments = map.split(",");
  assert.equal(segments.length, 1000);
  assert.equal(segments[0], "0-1:0");
  assert.equal(segments[999], "1998-1999:2997");
  const skipped = /"nao_encontrado": \{\s*"total": 1000,\s*"indices": "([^"]+)"/.exec(body)![1].split(",");
  assert.equal(skipped.length, 1000, "cada índice pulado aparece, nenhum cortado");
  assert.equal(skipped[999], "2999");
});

test("get_billing_status allAccounts: gerentes não ocupam as vagas de maxAccounts", async () => {
  const adAccounts = ["1000000001", "1000000002", "1000000003", "1000000004", "1000000005"];
  const { client, calls } = fakeClient({
    rows: (from) => {
      if (from === "customer_client") {
        return [
          { customerClient: { id: MCC, descriptiveName: "Agência", manager: true, level: 0 } },
          ...["2000000001", "2000000002", "2000000003"].map((id) => ({ customerClient: { id, descriptiveName: "Sub-MCC", manager: true, level: 1 } })),
          ...adAccounts.map((id) => ({ customerClient: { id, descriptiveName: `Cliente ${id}`, manager: false, level: 2 } })),
        ];
      }
      return billingRows({ budgets: [activeBudget()] })(from, "");
    },
  });
  const all = textOf(await call(client, "get_billing_status", { allAccounts: true, managerCustomerId: MCC, maxAccounts: 5 }));
  const read = () => [...new Set(calls.queries.filter((q) => /FROM billing_setup/.test(q.query)).map((q) => q.cid))];
  assert.deepEqual(read().sort(), adAccounts, "as 5 contas de anúncio são lidas");
  assert.match(all, /Faturamento de 5 conta\(s\)/);
  assert.doesNotMatch(all, /além de maxAccounts/);

  calls.queries.length = 0;
  const capped = textOf(await call(client, "get_billing_status", { allAccounts: true, managerCustomerId: MCC, maxAccounts: 3 }));
  assert.equal(read().length, 3);
  assert.match(capped, /2 conta\(s\) de anúncio além de maxAccounts não lida/);
});

test("bulk_update_status: em escala devolve o plano e só grava com confirm; chamadas pequenas seguem iguais", async () => {
  const pausedCampaigns = (_from: string, query: string) =>
    namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "PAUSED", name: `C${rn.split("/").pop()}` } }));
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(1 + i));

  // Ativar 21 (acima de 20): plano, nada gravado.
  const enable = fakeClient({ rows: pausedCampaigns });
  const gated = await call(enable.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(21), status: "ENABLED" });
  assert.equal(gated.isError, true);
  assert.equal(enable.calls.writes.length, 0);
  assert.match(textOf(gated), /21 campaigns mudariam para ENABLED — acima de 20 .* exige confirm: true/);
  assert.match(textOf(gated), /"before": "PAUSED"/);
  const confirmed = await call(enable.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(21), status: "ENABLED", confirm: true });
  assert.equal(confirmed.isError, false);
  assert.equal((enable.calls.writes[0].body.operations as Row[]).length, 21);

  // Ativar 20 grava direto (compatível com os agentes de hoje).
  const small = fakeClient({ rows: pausedCampaigns });
  await call(small.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(20), status: "ENABLED" });
  assert.equal(small.calls.writes.length, 1);

  // Pausar: limite de 100, contado sobre o que de fato muda depois da leitura.
  const enabledCampaigns = (_from: string, query: string) =>
    namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: Number(rn.split("/").pop()) <= 3 ? "ENABLED" : "PAUSED" } }));
  const fewChange = fakeClient({ rows: enabledCampaigns });
  await call(fewChange.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(20_000), status: "PAUSED" });
  assert.equal((fewChange.calls.writes[0].body.operations as Row[]).length, 3, "20.000 IDs, só 3 mudam: sem trava");
  const pause = fakeClient({ rows: (_f, query) => namesInQuery(query).map((rn) => ({ campaign: { resourceName: rn, status: "ENABLED" } })) });
  const pauseGate = await call(pause.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(101), status: "PAUSED" });
  assert.equal(pauseGate.isError, true);
  assert.equal(pause.calls.writes.length, 0);
  await call(pause.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(100), status: "PAUSED" });
  assert.equal(pause.calls.writes.length, 1);

  // validateOnly não grava: valida em escala sem pedir confirm.
  const dry = fakeClient({ rows: pausedCampaigns });
  const validated = await call(dry.client, "bulk_update_status", { customerId: CID, resourceType: "campaigns", resourceIds: ids(50), status: "ENABLED", validateOnly: true });
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(validated), /DRY-RUN \(validateOnly\): nada foi gravado\. 50 campaigns validado/);
});
