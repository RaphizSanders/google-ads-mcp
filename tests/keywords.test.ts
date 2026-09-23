/**
 * Lote keywords — palavras-chave, termos de pesquisa e DSA.
 *
 * Cobre: list_keywords, add_keywords, bulk_update_keyword_status, get_search_term_insights,
 * audit_dsa_and_legacy (novas) e get_search_terms, get_keyword_performance, create_keyword,
 * remove_keyword, create_ad_group (alteradas).
 *
 * Toda query passa por assertGaqlRules (metadados reais da v25); toda escrita é registrada
 * para conferir payload, updateMask, partialFailure e que validações/no-ops não escrevem.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { createReadOnlyToolServer } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import {
  DSA_PAGE_SCAN_CAP,
  DSA_TOP_TERMS_SCAN,
  ISSUE_CANDIDATE_QUERIES,
  ISSUE_SCAN_CAP,
  ISSUE_STATUS_REASONS,
  keywordDiagnostics,
  keywordTextProblem,
} from "../src/tools/keywords.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "222";
const AD_GROUP_ID = "777";

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  /** Linhas por recurso do FROM. */
  rows?: Record<string, Row[]>;
  /** Linhas por query (tem precedência sobre rows). */
  rowsFor?: (query: string, from: string) => Row[] | undefined;
  /** Erro lançado pela searchStream para um FROM. */
  throwFor?: Record<string, string>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[]) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ method: string; resource?: string; operations: Row[]; options?: Row }>,
    dryRunClones: 0,
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
      if (opts.throwFor?.[from]) throw new Error(opts.throwFor[from]);
      return opts.rowsFor?.(query, from) ?? opts.rows?.[from] ?? [];
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options });
      if (opts.mutate) return opts.mutate(resource, operations);
      if (dryRun) return {};
      return {
        results: operations.map((op, i) => ({
          resourceName: op.remove ? String(op.remove) : `customers/${CID}/adGroupCriteria/${AD_GROUP_ID}~${900 + i}`,
        })),
      };
    },
    async mutateAdGroupCriteria(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroupCriteria", operations });
      return dryRun ? {} : { results: operations.map(() => ({ resourceName: "agc" })) };
    },
    async mutateAdGroups(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroups", operations });
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/adGroups/1` }] };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, opts: { readOnly?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, [], false);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) =>
  register(client).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

/** LIMIT da query (o que a API devolveria no máximo numa conta grande). */
const limitOf = (query: string): number => Number(/\bLIMIT\s+(\d+)/.exec(query)?.[1] ?? 0);
/** Só a parte do WHERE em diante (o SELECT também cita os campos). */
const whereOf = (query: string): string => query.slice(query.indexOf("WHERE"));

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

function arrayOf(result: Result): Row[] {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("\n["))) as Row[];
}

const metrics = (costMicros: number, extra: Row = {}): Row => ({
  impressions: "100", clicks: "10", costMicros: String(costMicros), conversions: 2, conversionsValue: 300, ...extra,
});

const adGroupRow = (overrides: Row = {}, campaign: Row = {}): Row => ({
  adGroup: { id: AD_GROUP_ID, name: "Tênis", status: "ENABLED", type: "SEARCH_STANDARD", ...overrides },
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", ...campaign },
});

const existingKeyword = (text: string, matchType: string, status = "ENABLED", negative = false, id = "555"): Row => ({
  adGroupCriterion: { criterionId: id, status, negative, keyword: { text, matchType } },
});

// ── Validação de texto (limites do KeywordInfo) ───────────────────────

test("texto de palavra-chave: 80 caracteres, 10 palavras, sem colchetes/aspas/+/-", () => {
  assert.equal(keywordTextProblem("tenis de corrida"), null);
  assert.equal(keywordTextProblem("a".repeat(80)), null);
  assert.match(String(keywordTextProblem("a".repeat(81))), /81 caracteres/);
  assert.equal(keywordTextProblem("um dois tres quatro cinco seis sete oito nove dez"), null);
  assert.match(String(keywordTextProblem("um dois tres quatro cinco seis sete oito nove dez onze")), /11 palavras/);
  assert.match(String(keywordTextProblem("[tenis]")), /matchType/);
  assert.match(String(keywordTextProblem("\"tenis\"")), /matchType/);
  assert.match(String(keywordTextProblem("+tenis +corrida")), /BROAD_MATCH_MODIFIER/);
  assert.match(String(keywordTextProblem("-gratis")), /add_negative_keyword/);
  assert.match(String(keywordTextProblem("   ")), /vazio/);
});

test("diagnóstico: componentes do QS, 1ª página, volume, política e negativa viram códigos de ação", () => {
  const { fix } = keywordDiagnostics({
    qualityInfo: { qualityScore: 3, creativeQualityScore: "BELOW_AVERAGE", postClickQualityScore: "BELOW_AVERAGE", searchPredictedCtr: "AVERAGE" },
    effectiveCpcBidMicros: "500000",
    positionEstimates: { firstPageCpcMicros: "1200000" },
    systemServingStatus: "RARELY_SERVED",
    approvalStatus: "DISAPPROVED",
    primaryStatusReasons: ["CAMPAIGN_CRITERION_NEGATIVE"],
  }, "MANUAL_CPC");
  assert.deepEqual(fix, ["LP", "AD", "BID", "VOLUME", "POLICY", "NEGATIVE"]);
  // Em lance automático a estimativa de 1ª página não vira BID sozinha, só pelo motivo da API.
  assert.deepEqual(keywordDiagnostics({ effectiveCpcBidMicros: "500000", positionEstimates: { firstPageCpcMicros: "1200000" } }, "MAXIMIZE_CONVERSIONS").fix, []);
  assert.deepEqual(keywordDiagnostics({ primaryStatusReasons: ["AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID"] }, "TARGET_SPEND").fix, ["BID"]);
});

// ── list_keywords ─────────────────────────────────────────────────────

const listRow = (id: string, text: string, criterion: Row = {}, strategy = "MANUAL_CPC"): Row => ({
  adGroupCriterion: {
    criterionId: id, status: "ENABLED", negative: false, keyword: { text, matchType: "PHRASE" },
    primaryStatus: "ELIGIBLE", primaryStatusReasons: [], approvalStatus: "APPROVED", systemServingStatus: "ELIGIBLE",
    qualityInfo: { qualityScore: 7, creativeQualityScore: "AVERAGE", postClickQualityScore: "ABOVE_AVERAGE", searchPredictedCtr: "AVERAGE" },
    cpcBidMicros: "2000000", effectiveCpcBidMicros: "2000000",
    positionEstimates: { firstPageCpcMicros: "1000000", topOfPageCpcMicros: "2500000", firstPositionCpcMicros: "4000000" },
    finalUrls: [], ...criterion,
  },
  adGroup: { id: AD_GROUP_ID, name: "Tênis", status: "ENABLED" },
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa", status: "ENABLED", biddingStrategyType: strategy },
});

test("list_keywords: IDs, status, componentes do QS, lances e estimativas — sem depender de impressão", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_criterion: [
        listRow("1", "tenis corrida"),
        listRow("2", "tenis barato", {
          qualityInfo: { qualityScore: 2, creativeQualityScore: "BELOW_AVERAGE", postClickQualityScore: "BELOW_AVERAGE", searchPredictedCtr: "BELOW_AVERAGE" },
          effectiveCpcBidMicros: "300000", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID"],
        }),
      ],
    },
  });
  const result = await call(client, "list_keywords", { campaignId: CAMPAIGN_ID });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 1, "sem includeMetrics, uma consulta só");
  const query = calls.queries[0];
  assert.match(query, /FROM ad_group_criterion/);
  for (const field of [
    "ad_group_criterion.criterion_id", "ad_group_criterion.primary_status_reasons", "ad_group_criterion.system_serving_status",
    "ad_group_criterion.quality_info.post_click_quality_score", "ad_group_criterion.position_estimates.first_page_cpc_micros",
    "ad_group_criterion.effective_cpc_bid_micros", "ad_group.id", "campaign.id",
  ]) assert.ok(query.includes(field), `faltou ${field}`);
  assert.match(query, /ad_group_criterion\.type = 'KEYWORD'/);
  assert.match(query, /ad_group_criterion\.negative = false/);
  assert.match(query, /campaign\.id = 222/);
  assert.doesNotMatch(query, /metrics\./, "ad_group_criterion não tem métricas: nada de filtro por impressão");
  const payload = jsonOf(result);
  const [ok, bad] = payload.keywords as Row[];
  assert.equal(ok.criterion_id, "1");
  assert.equal(ok.ad_group_id, AD_GROUP_ID);
  assert.deepEqual(ok.fix, []);
  assert.equal(ok.first_page_cpc, 1);
  assert.deepEqual(bad.fix, ["LP", "AD", "CTR", "BID"]);
  assert.deepEqual((payload.summary as Row).by_fix, { LP: 1, AD: 1, CTR: 1, BID: 1 });
});

test("list_keywords: includeMetrics soma o período e dá zero para quem não teve tráfego; onlyIssues filtra", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_criterion: [listRow("1", "tenis corrida"), listRow("2", "tenis raro", { systemServingStatus: "RARELY_SERVED" })],
      keyword_view: [{ adGroup: { id: AD_GROUP_ID }, adGroupCriterion: { criterionId: "1" }, metrics: metrics(5_000_000) }],
    },
  });
  const result = await call(client, "list_keywords", { includeMetrics: true, days: 7 });
  assert.equal(calls.queries.length, 2);
  assert.match(calls.queries[1], /FROM keyword_view/);
  assert.match(calls.queries[1], /segments\.date DURING LAST_7_DAYS/);
  assert.doesNotMatch(calls.queries[1], /metrics\.impressions > 0/);
  const [withTraffic, without] = jsonOf(result).keywords as Row[];
  assert.equal(withTraffic.spend, 5);
  assert.equal(withTraffic.cpa, 2.5);
  assert.equal(without.impressions, 0);
  assert.equal(without.cpa, null);

  const issues = fakeClient({ rows: { ad_group_criterion: [listRow("1", "tenis corrida"), listRow("2", "tenis raro", { systemServingStatus: "RARELY_SERVED" })] } });
  const onlyIssues = jsonOf(await call(issues.client, "list_keywords", { onlyIssues: true }));
  assert.deepEqual((onlyIssues.keywords as Row[]).map((k) => k.criterion_id), ["2"]);
  assert.match(issues.calls.queries[0], /LIMIT 10000/, "onlyIssues filtra no servidor: busca além do limit");
});

test("list_keywords: IDs não numéricos e limit inválido são recusados antes de consultar; table achata listas", async () => {
  for (const args of [{ campaignId: "1 OR 1=1" }, { adGroupId: "abc" }, { limit: 0 }, { limit: 2.5 }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "list_keywords", args);
    assert.equal(result.isError, true);
    assert.equal(calls.queries.length, 0);
  }
  const { client } = fakeClient({ rows: { ad_group_criterion: [listRow("1", "tenis", { primaryStatusReasons: ["A", "B"] })] } });
  const table = textOf(await call(client, "list_keywords", { format: "table" }));
  assert.match(table, /primary_status_reasons/);
  assert.match(table, /A \| B/);
});

// ── list_keywords onlyIssues: conta com mais palavras-chave que o teto ─

/** Todos os valores do enum AdGroupCriterionPrimaryStatusReason da v25 (enums/ad_group_criterion_primary_status_reason.proto). */
const ALL_PRIMARY_STATUS_REASONS = [
  "UNSPECIFIED", "UNKNOWN", "CAMPAIGN_PENDING", "CAMPAIGN_CRITERION_NEGATIVE", "CAMPAIGN_PAUSED", "CAMPAIGN_REMOVED",
  "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED", "AD_GROUP_CRITERION_DISAPPROVED", "AD_GROUP_CRITERION_RARELY_SERVED",
  "AD_GROUP_CRITERION_LOW_QUALITY", "AD_GROUP_CRITERION_UNDER_REVIEW", "AD_GROUP_CRITERION_PENDING_REVIEW",
  "AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID", "AD_GROUP_CRITERION_NEGATIVE", "AD_GROUP_CRITERION_RESTRICTED",
  "AD_GROUP_CRITERION_PAUSED", "AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY", "AD_GROUP_CRITERION_REMOVED",
];

test("onlyIssues: a lista de motivos das consultas dirigidas é exatamente a que o diagnóstico usa", () => {
  for (const reason of ALL_PRIMARY_STATUS_REASONS) {
    const flagged = keywordDiagnostics({ primaryStatusReasons: [reason] }, "TARGET_SPEND").fix.length > 0;
    assert.equal(flagged, (ISSUE_STATUS_REASONS as readonly string[]).includes(reason), reason);
  }
});

/** Uma palavra-chave com problema por ramo de keywordDiagnostics. */
const issuePool: Row[] = [
  listRow("9001", "lp", { qualityInfo: { qualityScore: 4, postClickQualityScore: "BELOW_AVERAGE" } }),
  listRow("9002", "ad", { qualityInfo: { qualityScore: 4, creativeQualityScore: "BELOW_AVERAGE" } }),
  listRow("9003", "ctr", { qualityInfo: { qualityScore: 4, searchPredictedCtr: "BELOW_AVERAGE" } }),
  listRow("9004", "bid motivo", { primaryStatusReasons: ["AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID"] }, "TARGET_SPEND"),
  listRow("9005", "bid manual", { effectiveCpcBidMicros: "300000", positionEstimates: { firstPageCpcMicros: "1000000" } }, "MANUAL_CPC"),
  listRow("9006", "rara", { systemServingStatus: "RARELY_SERVED" }, "TARGET_SPEND"),
  listRow("9007", "baixa atividade", { primaryStatusReasons: ["AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY"] }, "TARGET_SPEND"),
  listRow("9008", "reprovada", { approvalStatus: "DISAPPROVED" }, "TARGET_SPEND"),
  listRow("9009", "restrita", { primaryStatusReasons: ["AD_GROUP_CRITERION_RESTRICTED"] }, "TARGET_SPEND"),
  listRow("9010", "negativada", { primaryStatusReasons: ["CAMPAIGN_CRITERION_NEGATIVE"] }, "TARGET_SPEND"),
  listRow("9011", "qs baixo", { primaryStatusReasons: ["AD_GROUP_CRITERION_LOW_QUALITY"] }, "TARGET_SPEND"),
];

const quoted = (list: string) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** Avalia a condição dirigida da query sobre uma linha, como a API faria. */
function matchesCandidate(where: string, row: Row): boolean | undefined {
  const c = row.adGroupCriterion as Row;
  const quality = (c.qualityInfo ?? {}) as Row;
  const campaign = row.campaign as Row;
  if (/post_click_quality_score = 'BELOW_AVERAGE'/.test(where)) return quality.postClickQualityScore === "BELOW_AVERAGE";
  if (/creative_quality_score = 'BELOW_AVERAGE'/.test(where)) return quality.creativeQualityScore === "BELOW_AVERAGE";
  if (/search_predicted_ctr = 'BELOW_AVERAGE'/.test(where)) return quality.searchPredictedCtr === "BELOW_AVERAGE";
  const reasons = /primary_status_reasons CONTAINS ANY \(([^)]*)\)/.exec(where);
  if (reasons) return quoted(reasons[1]).some((r) => ((c.primaryStatusReasons as string[]) ?? []).includes(r));
  if (/system_serving_status = 'RARELY_SERVED'/.test(where)) return c.systemServingStatus === "RARELY_SERVED";
  if (/approval_status = 'DISAPPROVED'/.test(where)) return c.approvalStatus === "DISAPPROVED";
  const manual = /bidding_strategy_type IN \(([^)]*)\)[\s\S]*first_page_cpc_micros > 0/.exec(where);
  if (manual) {
    return quoted(manual[1]).includes(String(campaign.biddingStrategyType)) && Number(((c.positionEstimates ?? {}) as Row).firstPageCpcMicros) > 0;
  }
  return undefined; // varredura sem condição de problema
}

const healthyRows = (count: number, from = 100_000) => Array.from({ length: count }, (_, i) => listRow(String(from + i), `saudavel ${i}`));

test("list_keywords onlyIssues: varredura no teto → uma consulta por problema; acha todos os ramos do diagnóstico", async () => {
  const { client, calls } = fakeClient({
    rowsFor: (query, from) => {
      if (from !== "ad_group_criterion") return undefined;
      const hit = issuePool.filter((row) => matchesCandidate(whereOf(query), row));
      // A varredura (sem condição) devolve o teto de linhas saudáveis: as com problema ficariam além do corte.
      return matchesCandidate(whereOf(query), issuePool[0]) === undefined ? healthyRows(limitOf(query)) : hit;
    },
  });
  const result = await call(client, "list_keywords", { onlyIssues: true, limit: 500 });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 1 + ISSUE_CANDIDATE_QUERIES.length);
  assert.match(calls.queries[0], new RegExp(`LIMIT ${ISSUE_SCAN_CAP}`));
  for (const query of calls.queries.slice(1)) {
    assert.match(query, /ad_group_criterion\.negative = false/, "as dirigidas mantêm os filtros da chamada");
    assert.match(query, new RegExp(`LIMIT ${ISSUE_SCAN_CAP}`));
  }
  assert.match(calls.queries.slice(1).join("\n"), /primary_status_reasons CONTAINS ANY \('AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID'/);
  const payload = jsonOf(result);
  const found = (payload.keywords as Row[]).map((k) => k.criterion_id).sort();
  assert.deepEqual(found, issuePool.map((r) => String((r.adGroupCriterion as Row).criterionId)).sort(), "um ramo do diagnóstico ficou sem consulta dirigida");
  const scan = (payload.summary as Row).scan as Row;
  assert.equal(scan.mode, "targeted");
  assert.equal(scan.complete, true);
  assert.match(textOf(result), /^11 palavra\(s\)-chave com problema\. A conta passa de 10\.000 palavras-chave no filtro: a busca foi dirigida/);
  assert.doesNotMatch(textOf(result), /INCOMPLETA/);
});

test("list_keywords onlyIssues: se as dirigidas também batem no teto, a resposta diz que a busca é incompleta", async () => {
  // Reprodução do achado: a API devolve LIMIT linhas saudáveis para toda consulta (conta muito grande).
  const { client } = fakeClient({ rowsFor: (query, from) => (from === "ad_group_criterion" ? healthyRows(limitOf(query)) : undefined) });
  const result = await call(client, "list_keywords", { onlyIssues: true, campaignId: CAMPAIGN_ID });
  const body = textOf(result);
  assert.doesNotMatch(body, /^0 palavra\(s\)-chave\.$/m, "não pode parecer 'nenhuma palavra-chave com problema'");
  assert.match(body, /^ATENÇÃO — busca INCOMPLETA: 0 palavra\(s\)-chave com problema encontrada\(s\), mas pode haver mais/);
  assert.match(body, /Filtre por campaignId\/adGroupId/);
  const scan = (jsonOf(result).summary as Row).scan as Row;
  assert.equal(scan.complete, false);
  assert.equal((scan.truncated_checks as string[]).length, ISSUE_CANDIDATE_QUERIES.length);
});

test("list_keywords onlyIssues: conta pequena é uma varredura só e completa; limit abaixo do achado avisa", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group_criterion: [...healthyRows(3), ...issuePool.slice(0, 2)] } });
  const result = await call(client, "list_keywords", { onlyIssues: true, limit: 1 });
  assert.equal(calls.queries.length, 1);
  assert.match(textOf(result), /^2 palavra\(s\)-chave com problema \(mostrando 1 — limite atingido; aumente limit/);
  assert.match(textOf(result), /varredura completa de 5 palavra\(s\)-chave/);
  assert.equal((jsonOf(result).keywords as Row[]).length, 1);
  assert.deepEqual(((jsonOf(result).summary as Row).scan as Row).mode, "full");
});

// ── add_keywords ──────────────────────────────────────────────────────

test("add_keywords: cria com partialFailure, pula existentes (sem reativar pausada) e repetidas no pedido", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [adGroupRow()],
      ad_group_criterion: [existingKeyword("Tenis Corrida", "EXACT", "PAUSED", false, "41"), existingKeyword("tenis usado", "BROAD", "ENABLED", true, "42")],
    },
  });
  const result = await call(client, "add_keywords", {
    adGroupId: AD_GROUP_ID,
    keywords: [
      { text: "tenis  corrida", matchType: "EXACT" },
      { text: "tenis corrida", matchType: "PHRASE", cpcBidMicros: 2_500_000, finalUrl: "https://loja.com/tenis" },
      { text: "TENIS CORRIDA", matchType: "PHRASE" },
      { text: "tenis usado", matchType: "PHRASE" },
    ],
  });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries[0], /FROM ad_group\b/);
  assert.match(calls.queries[1], /FROM ad_group_criterion/);
  assert.match(calls.queries[1], /ad_group\.id = 777/);
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.resource, "adGroupCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { create: { adGroup: `customers/${CID}/adGroups/777`, status: "ENABLED", keyword: { text: "tenis corrida", matchType: "PHRASE" }, cpcBidMicros: "2500000", finalUrls: ["https://loja.com/tenis"] } },
    { create: { adGroup: `customers/${CID}/adGroups/777`, status: "ENABLED", keyword: { text: "tenis usado", matchType: "PHRASE" } } },
  ]);
  const payload = jsonOf(result);
  assert.deepEqual((payload.created as Row[]).map((c) => c.criterion_id), ["900", "901"]);
  const [paused] = payload.skipped_existing as Row[];
  assert.equal(paused.criterion_id, "41");
  assert.match(String(paused.note), /PAUSADA — não foi reativada/);
  assert.equal(JSON.stringify(write.operations).includes("41"), false, "nunca toca na existente");
  assert.deepEqual(payload.skipped_duplicates_in_request, [{ keyword: "TENIS CORRIDA", match_type: "PHRASE" }]);
  assert.match(JSON.stringify(payload.warnings), /também é negativa/);
});

test("add_keywords: entrada inválida é recusada inteira antes de qualquer chamada", async () => {
  const cases: Row[] = [
    { adGroupId: "7 OR 1=1", keywords: [{ text: "tenis", matchType: "EXACT" }] },
    { adGroupId: AD_GROUP_ID, keywords: [] },
    { adGroupId: AD_GROUP_ID, keywords: [{ text: "a".repeat(81), matchType: "EXACT" }] },
    { adGroupId: AD_GROUP_ID, keywords: [{ text: "um dois tres quatro cinco seis sete oito nove dez onze", matchType: "EXACT" }] },
    { adGroupId: AD_GROUP_ID, keywords: [{ text: "[tenis]", matchType: "EXACT" }] },
    { adGroupId: AD_GROUP_ID, keywords: `[{"text":"tenis","matchType":"EXATA"}]` },
    { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT", cpcBidMicros: 1.5 }] },
    { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT", finalUrl: "loja.com" }] },
    { adGroupId: AD_GROUP_ID, keywords: Array.from({ length: 1001 }, (_, i) => ({ text: `kw ${i}`, matchType: "BROAD" })) },
  ];
  for (const args of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow()] } });
    const result = await call(client, "add_keywords", args);
    assert.equal(result.isError, true, JSON.stringify(args).slice(0, 80));
    assert.equal(calls.queries.length + calls.writes.length, 0, "nada consultado nem gravado");
  }
});

test("add_keywords: grupo inexistente, DSA ou de outro tipo é recusado sem escrita", async () => {
  const cases: Array<[Row[], RegExp]> = [
    [[], /não encontrado/],
    [[adGroupRow({ type: "SEARCH_DYNAMIC_ADS" })], /SEARCH_DYNAMIC_ADS/],
    [[adGroupRow({ type: "SHOPPING_PRODUCT_ADS" })], /SHOPPING_PRODUCT_ADS/],
    [[adGroupRow({ status: "REMOVED" })], /removido/],
  ];
  for (const [rows, message] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: rows } });
    const result = await call(client, "add_keywords", { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT" }] });
    assert.equal(result.isError, true);
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length, 0);
  }
});

test("add_keywords: tudo já existe → nenhuma escrita; lance em estratégia automática gera aviso", async () => {
  const none = fakeClient({ rows: { ad_group: [adGroupRow()], ad_group_criterion: [existingKeyword("tenis", "EXACT")] } });
  const r1 = await call(none.client, "add_keywords", { adGroupId: AD_GROUP_ID, keywords: [{ text: "Tenis", matchType: "EXACT" }] });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /Nenhuma escrita foi enviada/);
  assert.equal(none.calls.writes.length, 0);

  const auto = fakeClient({ rows: { ad_group: [adGroupRow({}, { biddingStrategyType: "MAXIMIZE_CONVERSIONS" })] } });
  const r2 = await call(auto.client, "add_keywords", { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT", cpcBidMicros: 50_000 }] });
  const warnings = JSON.stringify(jsonOf(r2).warnings);
  assert.match(warnings, /MAXIMIZE_CONVERSIONS: o lance automático ignora/);
  assert.match(warnings, /lance muito baixo/);
});

test("add_keywords: recusa por item vem do partialFailureError com o índice certo", async () => {
  const { client } = fakeClient({
    rows: { ad_group: [adGroupRow()] },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/adGroupCriteria/777~1` }, {}],
      partialFailureError: {
        details: [{ errors: [{
          errorCode: { policyViolationError: "POLICY_ERROR" }, message: "A policy was violated.",
          location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
        }] }],
      },
    }),
  });
  const result = await call(client, "add_keywords", {
    adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT" }, { text: "remedio", matchType: "EXACT" }],
  });
  assert.equal(result.isError, true);
  const payload = jsonOf(result);
  assert.deepEqual((payload.created as Row[]).map((c) => c.keyword), ["tenis"]);
  const [error] = payload.errors as Row[];
  assert.equal(error.keyword, "remedio");
  assert.match(String(error.error), /policyViolationError\.POLICY_ERROR/);
});

test("add_keywords: dry-run e validateOnly relatam validação, nunca criação", async () => {
  const dry = fakeClient({ dryRun: true, rows: { ad_group: [adGroupRow()] } });
  const r1 = await call(dry.client, "add_keywords", { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT" }] });
  assert.match(textOf(r1), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.ok("validated" in jsonOf(r1));
  assert.ok(!("created" in jsonOf(r1)));

  const perCall = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const r2 = await call(perCall.client, "add_keywords", { adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT" }], validateOnly: true });
  assert.equal(perCall.calls.dryRunClones, 1);
  assert.match(r2.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(r2), /nada foi gravado/);
});

test("add_keywords de ponta a ponta: um :mutate em adGroupCriteria com partialFailure e validateOnly", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Row;
    sent.push({ url, body });
    const payload = url.endsWith(":searchStream")
      ? [{ results: String(body.query).includes("FROM ad_group\n") || /FROM ad_group\s+WHERE/.test(String(body.query)) ? [adGroupRow()] : [] }]
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({
      credentials: { token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token", client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z" },
      developerToken: "d",
      loginCustomerId: CID,
    });
    const result = await register(client).handlers.get("add_keywords")!({
      customerId: CID, adGroupId: AD_GROUP_ID, keywords: [{ text: "tenis", matchType: "EXACT" }], validateOnly: true,
    });
    for (const { body } of sent.filter((s) => s.url.endsWith(":searchStream"))) assertGaqlRules(String(body.query));
    const writes = sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/adGroupCriteria:mutate`));
    assert.equal(writes[0].body.partialFailure, true);
    assert.equal(writes[0].body.validateOnly, true);
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    globalThis.fetch = original;
  }
});

// ── create_keyword (delegado ao add_keywords) ─────────────────────────

test("create_keyword: valida, não duplica e cria com os mesmos campos do add_keywords", async () => {
  const bad = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const r0 = await call(bad.client, "create_keyword", { adGroupId: AD_GROUP_ID, keyword: "+tenis", matchType: "BROAD" });
  assert.equal(r0.isError, true);
  assert.equal(bad.calls.queries.length + bad.calls.writes.length, 0);

  const dup = fakeClient({ rows: { ad_group: [adGroupRow()], ad_group_criterion: [existingKeyword("tenis", "EXACT")] } });
  const r1 = await call(dup.client, "create_keyword", { adGroupId: AD_GROUP_ID, keyword: "tenis", matchType: "EXACT" });
  assert.equal(dup.calls.writes.length, 0);
  assert.match(textOf(r1), /Nenhuma escrita/);

  const ok = fakeClient({ rows: { ad_group: [adGroupRow()] } });
  const r2 = await call(ok.client, "create_keyword", { adGroupId: AD_GROUP_ID, keyword: "tenis", matchType: "EXACT", cpcBidMicros: 1_500_000 });
  assert.equal(r2.isError, undefined);
  assert.deepEqual(ok.calls.writes[0].operations, [
    { create: { adGroup: `customers/${CID}/adGroups/777`, status: "ENABLED", keyword: { text: "tenis", matchType: "EXACT" }, cpcBidMicros: "1500000" } },
  ]);
});

// ── bulk_update_keyword_status ────────────────────────────────────────

const statusRow = (key: string, status: string, extra: Row = {}, groupStatus = "ENABLED"): Row => {
  const [adGroupId, criterionId] = key.split("~");
  return {
    adGroupCriterion: {
      resourceName: `customers/${CID}/adGroupCriteria/${key}`, criterionId, status, negative: false, type: "KEYWORD",
      keyword: { text: `kw ${criterionId}`, matchType: "PHRASE" }, ...extra,
    },
    adGroup: { id: adGroupId, name: "G", status: groupStatus },
    campaign: { name: "C", status: "ENABLED" },
  };
};

test("bulk_update_keyword_status: pausa só o que muda, com updateMask status e partialFailure", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_criterion: [
        statusRow("777~1", "ENABLED"),
        statusRow("777~2", "PAUSED"),
        statusRow("777~3", "REMOVED"),
        statusRow("777~4", "ENABLED", { negative: true }),
      ],
    },
  });
  const result = await call(client, "bulk_update_keyword_status", {
    keywords: ["777~1", "777~2", "777~3", "777~4", "777~5", `customers/${CID}/adGroupCriteria/777~1`],
    status: "PAUSED",
  });
  assert.match(calls.queries[0], /ad_group_criterion\.resource_name IN \('customers\/1234567890\/adGroupCriteria\/777~1', /);
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { update: { resourceName: `customers/${CID}/adGroupCriteria/777~1`, status: "PAUSED" }, updateMask: "status" },
  ]);
  for (const op of write.operations) assertUpdateMaskLeaves(String(op.updateMask));
  const payload = jsonOf(result);
  assert.equal((payload.changed as Row[]).length, 1);
  assert.deepEqual(payload.not_found, ["777~5"]);
  assert.deepEqual((payload.skipped as Row[]).map((s) => s.id), ["777~2", "777~3", "777~4"]);
  assert.equal(result.isError, true, "referência não encontrada é sinalizada");
});

test("bulk_update_keyword_status: critério que não é palavra-chave (WEBPAGE etc.) é pulado e não é gravado", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_criterion: [
        statusRow("777~1", "ENABLED", { type: "WEBPAGE", keyword: undefined }),
        statusRow("777~2", "ENABLED", { type: "AUDIENCE", keyword: undefined }),
      ],
    },
  });
  const result = await call(client, "bulk_update_keyword_status", { keywords: ["777~1", "777~2"], status: "PAUSED" });
  assert.equal(calls.writes.length, 0, "nada fora de KEYWORD pode ser pausado por esta tool");
  assert.match(textOf(result), /Nenhuma escrita foi enviada/);
  const skipped = jsonOf(result).skipped as Row[];
  assert.deepEqual(skipped.map((s) => s.id), ["777~1", "777~2"]);
  assert.match(String(skipped[0].reason), /não é palavra-chave \(WEBPAGE\)/);

  const mixed = fakeClient({ rows: { ad_group_criterion: [statusRow("777~1", "ENABLED", { type: "WEBPAGE" }), statusRow("777~3", "ENABLED")] } });
  await call(mixed.client, "bulk_update_keyword_status", { keywords: ["777~1", "777~3"], status: "PAUSED" });
  assert.deepEqual(mixed.calls.writes[0].operations.map((op) => (op.update as Row).resourceName), [`customers/${CID}/adGroupCriteria/777~3`]);
});

test("bulk_update_keyword_status: referência inválida ou de outra conta não chega à API", async () => {
  for (const keywords of [["777-1"], ["abc~1"], ["customers/9999999999/adGroupCriteria/777~1"], []]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "bulk_update_keyword_status", { keywords, status: "PAUSED" });
    assert.equal(result.isError, true);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
});

test("bulk_update_keyword_status: acima de 20 mudanças exige confirm; no-op não grava", async () => {
  const keys = Array.from({ length: 21 }, (_, i) => `777~${i + 1}`);
  const rows = keys.map((key) => statusRow(key, "ENABLED"));
  const noConfirm = fakeClient({ rows: { ad_group_criterion: rows } });
  const r1 = await call(noConfirm.client, "bulk_update_keyword_status", { keywords: keys, status: "PAUSED" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const confirmed = fakeClient({ rows: { ad_group_criterion: rows } });
  await call(confirmed.client, "bulk_update_keyword_status", { keywords: keys, status: "PAUSED", confirm: true });
  assert.equal(confirmed.calls.writes[0].operations.length, 21);

  const noop = fakeClient({ rows: { ad_group_criterion: [statusRow("777~1", "PAUSED")] } });
  const r3 = await call(noop.client, "bulk_update_keyword_status", { keywords: ["777~1"], status: "PAUSED" });
  assert.equal(noop.calls.writes.length, 0);
  assert.match(textOf(r3), /Nenhuma escrita foi enviada/);
});

test("bulk_update_keyword_status: erro por item, aviso de grupo pausado e dry-run", async () => {
  const partial = fakeClient({
    rows: { ad_group_criterion: [statusRow("777~1", "PAUSED", {}, "PAUSED"), statusRow("777~2", "PAUSED")] },
    mutate: () => ({
      results: [{ resourceName: "ok" }, {}],
      partialFailureError: { details: [{ errors: [{ message: "Resource was not found.", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const r1 = await call(partial.client, "bulk_update_keyword_status", { keywords: ["777~1", "777~2"], status: "ENABLED" });
  assert.equal(r1.isError, true);
  const payload = jsonOf(r1);
  assert.deepEqual((payload.changed as Row[]).map((c) => c.id), ["777~1"]);
  assert.equal((payload.errors as Row[])[0].id, "777~2");
  assert.match(JSON.stringify(payload.warnings), /grupo\/campanha pausado/);

  const dry = fakeClient({ dryRun: true, rows: { ad_group_criterion: [statusRow("777~1", "ENABLED")] } });
  const r2 = await call(dry.client, "bulk_update_keyword_status", { keywords: ["777~1"], status: "PAUSED" });
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.ok("validated" in jsonOf(r2));
});

// ── remove_keyword ────────────────────────────────────────────────────

const removeRow = (overrides: Row = {}): Row => ({
  adGroupCriterion: { criterionId: "555", type: "KEYWORD", status: "ENABLED", negative: false, keyword: { text: "tenis gratis", matchType: "BROAD" }, ...overrides },
  adGroup: { id: AD_GROUP_ID, name: "Tênis" },
  campaign: { name: "Pesquisa" },
});

test("remove_keyword: sem confirm mostra o que seria removido e não grava; com confirm remove", async () => {
  const preview = fakeClient({ rows: { ad_group_criterion: [removeRow()] } });
  const r1 = await call(preview.client, "remove_keyword", { adGroupId: AD_GROUP_ID, criterionId: "555" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Vai remover "tenis gratis" \[BROAD\].*confirm: true/);
  assert.equal(preview.calls.writes.length, 0);
  assert.match(preview.calls.queries[0], /ad_group_criterion\.criterion_id = 555/);

  const confirmed = fakeClient({ rows: { ad_group_criterion: [removeRow()] } });
  const r2 = await call(confirmed.client, "remove_keyword", { adGroupId: AD_GROUP_ID, criterionId: "555", confirm: true });
  assert.equal(r2.isError, undefined);
  assert.deepEqual(confirmed.calls.writes[0].operations, [{ remove: `customers/${CID}/adGroupCriteria/777~555` }]);
});

test("remove_keyword: inexistente, não-keyword, já removida e IDs inválidos não gravam", async () => {
  const cases: Array<[Row, Row[], RegExp, boolean]> = [
    [{ adGroupId: AD_GROUP_ID, criterionId: "555", confirm: true }, [], /não encontrada/, true],
    [{ adGroupId: AD_GROUP_ID, criterionId: "555", confirm: true }, [removeRow({ type: "WEBPAGE" })], /não é palavra-chave/, true],
    [{ adGroupId: AD_GROUP_ID, criterionId: "555", confirm: true }, [removeRow({ status: "REMOVED" })], /já está removida/, false],
    [{ adGroupId: "7 OR 1=1", criterionId: "555", confirm: true }, [removeRow()], /numéricos/, true],
  ];
  for (const [args, rows, message, isError] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group_criterion: rows } });
    const result = await call(client, "remove_keyword", args);
    assert.equal(Boolean(result.isError), isError);
    assert.match(textOf(result), message);
    assert.equal(calls.writes.length, 0);
  }
  const dry = fakeClient({ dryRun: true, rows: { ad_group_criterion: [removeRow()] } });
  const r = await call(dry.client, "remove_keyword", { adGroupId: AD_GROUP_ID, criterionId: "555", confirm: true });
  assert.match(textOf(r), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
});

// ── get_search_terms: Performance Max ─────────────────────────────────

const pmaxCampaign = { campaign: { id: CAMPAIGN_ID, name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX" } };
const searchCampaign = { campaign: { id: CAMPAIGN_ID, name: "Pesquisa", advertisingChannelType: "SEARCH" } };

test("get_search_terms: campanha PMax troca para campaign_search_term_view, sem grupo nem palavra-chave", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [pmaxCampaign],
      campaign_search_term_view: [{
        campaignSearchTermView: { searchTerm: "tenis nike" }, campaign: { id: CAMPAIGN_ID, name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX" },
        segments: { searchTermMatchSource: "PERFORMANCE_MAX", searchTermTargetingStatus: "NONE" }, metrics: metrics(3_000_000),
      }],
    },
  });
  const result = await call(client, "get_search_terms", { campaignId: CAMPAIGN_ID });
  assert.equal(calls.queries.length, 2);
  assert.match(calls.queries[0], /FROM campaign WHERE campaign\.id = 222/);
  const query = calls.queries[1];
  assert.match(query, /FROM campaign_search_term_view/);
  assert.doesNotMatch(query, /ad_group\./, "PMax não tem grupo de anúncios");
  assert.doesNotMatch(query, /segments\.keyword/, "segmento de palavra-chave tira o PMax do resultado");
  assert.match(textOf(result), /visão campaign/);
  const [row] = arrayOf(result);
  assert.equal(row.search_term, "tenis nike");
  assert.equal(row.match_source, "PERFORMANCE_MAX");
  assert.equal(row.status, "NONE");
  assert.equal(row.campaign_id, CAMPAIGN_ID);
});

test("get_search_terms: filtro PERFORMANCE_MAX usa a visão de campanha; view campaign dispensa consultar o canal", async () => {
  const bySource = fakeClient();
  await call(bySource.client, "get_search_terms", { matchSources: ["PERFORMANCE_MAX"] });
  assert.equal(bySource.calls.queries.length, 1);
  assert.match(bySource.calls.queries[0], /FROM campaign_search_term_view/);
  assert.match(bySource.calls.queries[0], /segments\.search_term_match_source IN \('PERFORMANCE_MAX'\)/);

  const explicit = fakeClient();
  await call(explicit.client, "get_search_terms", { campaignId: CAMPAIGN_ID, view: "campaign" });
  assert.equal(explicit.calls.queries.length, 1);
  assert.match(explicit.calls.queries[0], /FROM campaign_search_term_view[\s\S]*campaign\.id = 222/);
});

test("get_search_terms: Pesquisa segue em search_term_view com IDs; includeKeyword traz a palavra-chave", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [searchCampaign],
      search_term_view: [{
        searchTermView: { searchTerm: "tenis", status: "NONE" }, campaign: { id: CAMPAIGN_ID, name: "Pesquisa" }, adGroup: { id: AD_GROUP_ID, name: "G" },
        segments: { searchTermMatchSource: "ADVERTISER_PROVIDED_KEYWORD", keyword: { info: { text: "tenis corrida", matchType: "PHRASE" } } },
        metrics: metrics(1_000_000),
      }],
    },
  });
  const result = await call(client, "get_search_terms", { campaignId: CAMPAIGN_ID, includeKeyword: true });
  assert.match(calls.queries[1], /FROM search_term_view/);
  assert.match(calls.queries[1], /segments\.keyword\.info\.text/);
  assert.match(textOf(result), /visão ad_group .*sem Performance Max/);
  const [row] = arrayOf(result);
  assert.equal(row.ad_group_id, AD_GROUP_ID);
  assert.equal(row.keyword, "tenis corrida");
});

test("get_search_terms: combinações que nunca devolveriam PMax são recusadas", async () => {
  const cases: Array<[Row, Row[], number]> = [
    [{ view: "ad_group", matchSources: ["PERFORMANCE_MAX"] }, [], 0],
    [{ view: "campaign", includeKeyword: true }, [], 0],
    [{ view: "ad_group", campaignId: CAMPAIGN_ID }, [pmaxCampaign], 1],
    [{ campaignId: CAMPAIGN_ID, includeKeyword: true }, [pmaxCampaign], 1],
    [{ campaignId: CAMPAIGN_ID }, [], 1],
    [{ limit: 0 }, [], 0],
  ];
  for (const [args, campaignRows, queries] of cases) {
    const { client, calls } = fakeClient({ rows: { campaign: campaignRows } });
    const result = await call(client, "get_search_terms", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, queries, `consultas para ${JSON.stringify(args)}`);
  }
});

// ── get_keyword_performance ───────────────────────────────────────────

test("get_keyword_performance: devolve os IDs para encadear e recusa campaignId manipulado", async () => {
  const { client, calls } = fakeClient({
    rows: {
      keyword_view: [{
        adGroupCriterion: { criterionId: "555", status: "ENABLED", keyword: { text: "tenis", matchType: "EXACT" }, qualityInfo: { qualityScore: 6 } },
        campaign: { id: CAMPAIGN_ID, name: "P" }, adGroup: { id: AD_GROUP_ID, name: "G" }, metrics: metrics(2_000_000, { ctr: 0.1, averageCpc: "200000" }),
      }],
    },
  });
  const result = await call(client, "get_keyword_performance", { adGroupId: AD_GROUP_ID });
  assert.match(calls.queries[0], /ad_group_criterion\.criterion_id/);
  assert.match(calls.queries[0], /ad_group\.id = 777/);
  assert.doesNotMatch(calls.queries[0], /quality_info\.post_click_quality_score/, "diagnóstico só quando pedido");
  const [row] = arrayOf(result);
  assert.equal(row.criterion_id, "555");
  assert.equal(row.ad_group_id, AD_GROUP_ID);
  assert.equal(row.campaign_id, CAMPAIGN_ID);
  assert.equal(row.spend, 2);

  const injected = fakeClient();
  const bad = await call(injected.client, "get_keyword_performance", { campaignId: "1 OR campaign.id > 0" });
  assert.equal(bad.isError, true);
  assert.equal(injected.calls.queries.length, 0);
});

test("get_keyword_performance: adGroupId manipulado é recusado antes de qualquer consulta", async () => {
  for (const adGroupId of ["1 OR 1=1", "777 AND campaign.id > 0", "abc", ""]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_keyword_performance", { adGroupId });
    assert.equal(result.isError, true, adGroupId);
    assert.match(textOf(result), /adGroupId deve ser numérico/);
    assert.equal(calls.queries.length, 0, `nenhuma GAQL com adGroupId "${adGroupId}"`);
  }
});

test("get_keyword_performance: diagnostics traz componentes do QS e a coluna fix", async () => {
  const { client, calls } = fakeClient({
    rows: {
      keyword_view: [{
        adGroupCriterion: {
          criterionId: "555", status: "ENABLED", keyword: { text: "tenis", matchType: "EXACT" },
          qualityInfo: { qualityScore: 3, postClickQualityScore: "BELOW_AVERAGE", creativeQualityScore: "AVERAGE", searchPredictedCtr: "AVERAGE" },
          primaryStatusReasons: ["AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID"], positionEstimates: { firstPageCpcMicros: "900000" }, effectiveCpcBidMicros: "400000",
        },
        campaign: { id: CAMPAIGN_ID, name: "P", biddingStrategyType: "MANUAL_CPC" }, adGroup: { id: AD_GROUP_ID, name: "G" }, metrics: metrics(1_000_000),
      }],
    },
  });
  const result = await call(client, "get_keyword_performance", { diagnostics: true });
  assert.match(calls.queries[0], /quality_info\.post_click_quality_score/);
  assert.match(calls.queries[0], /position_estimates\.first_page_cpc_micros/);
  const [row] = arrayOf(result);
  assert.deepEqual(row.fix, ["LP", "BID"]);
  assert.equal(row.landing_page_experience, "BELOW_AVERAGE");
  assert.equal(row.first_page_cpc, 0.9);
});

// ── get_search_term_insights ──────────────────────────────────────────

const insightRow = (resource: "customerSearchTermInsight" | "campaignSearchTermInsight", id: string, label: string, conversions: number, extra: Row = {}): Row => ({
  [resource]: { id, categoryLabel: label },
  metrics: { impressions: "1000", clicks: "50", ctr: 0.05, conversions, conversionsValue: conversions * 100, searchVolume: { min: "1000", max: "5000" } },
  ...extra,
});

test("insights: nível de conta primeiro, categorias ordenadas por conversão, com faixa de volume", async () => {
  const { client, calls } = fakeClient({
    rows: {
      customer_search_term_insight: [
        insightRow("customerSearchTermInsight", "11", "tenis de corrida", 1),
        insightRow("customerSearchTermInsight", "12", "", 4),
      ],
    },
  });
  const result = await call(client, "get_search_term_insights", { days: 30 });
  const query = calls.queries[0];
  assert.match(query, /FROM customer_search_term_insight/);
  assert.match(query, /metrics\.search_volume/);
  assert.match(query, /ORDER BY metrics\.conversions DESC/);
  assert.match(query, /segments\.date DURING LAST_30_DAYS/);
  const rows = arrayOf(result);
  assert.deepEqual(rows.map((r) => r.category_id), ["12", "11"]);
  assert.equal(rows[0].category, "(outras — sem categoria)");
  assert.equal(rows[1].search_volume, "1000–5000");
  assert.equal(rows[1].conversion_rate_pct, 2);
});

test("insights: com campaignId o nível de conta filtra pelo segmento campaign (e o seleciona)", async () => {
  const { client, calls } = fakeClient();
  await call(client, "get_search_term_insights", { campaignId: CAMPAIGN_ID });
  assert.match(calls.queries[0], /SELECT .*segments\.campaign/);
  assert.match(calls.queries[0], /segments\.campaign = 'customers\/1234567890\/campaigns\/222'/);
});

test("insights: abrir uma categoria — subcategorias com volume; termos sem volume (métrica incompatível)", async () => {
  const sub = fakeClient();
  await call(sub.client, "get_search_term_insights", { level: "campaign", campaignId: CAMPAIGN_ID, categoryId: "11", includeSubcategories: true });
  const q1 = sub.calls.queries[0];
  assert.match(q1, /FROM campaign_search_term_insight/);
  assert.match(q1, /campaign_search_term_insight\.campaign_id = 222/);
  assert.match(q1, /campaign_search_term_insight\.id = 11/);
  assert.match(q1, /segments\.search_subcategory/);
  assert.match(q1, /metrics\.search_volume/);

  const terms = fakeClient({
    rows: { campaign_search_term_insight: [insightRow("campaignSearchTermInsight", "11", "tenis", 2, { segments: { searchSubcategory: "nike", searchTerm: "tenis nike 42" } })] },
  });
  const result = await call(terms.client, "get_search_term_insights", { level: "campaign", campaignId: CAMPAIGN_ID, categoryId: "11", includeTerms: true });
  const q2 = terms.calls.queries[0];
  assert.match(q2, /segments\.search_term\b/);
  assert.doesNotMatch(q2, /metrics\.search_volume/, "search_volume não é selecionável com segments.search_term");
  const [row] = arrayOf(result);
  assert.equal(row.search_term, "tenis nike 42");
  assert.equal(row.subcategory, "nike");
  assert.ok(!("search_volume" in row));
});

test("insights: validações antes de consultar", async () => {
  const cases: Row[] = [
    { level: "campaign" },
    { includeTerms: true },
    { campaignId: CAMPAIGN_ID, categoryId: "11", includeSubcategories: true },
    { categoryId: "11 OR 1=1" },
    { campaignId: "x" },
    { limit: -1 },
  ];
  for (const args of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_search_term_insights", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0);
  }
});

test("insights: RESOURCE_EXHAUSTED no nível de campanha volta para o nível de conta; outros erros sobem", async () => {
  const exhausted = "Google Ads API: Resource has been exhausted (e.g. check quota). — Too many requests. RESOURCE_EXHAUSTED";
  const { client, calls } = fakeClient({
    throwFor: { campaign_search_term_insight: exhausted },
    rows: { customer_search_term_insight: [insightRow("customerSearchTermInsight", "11", "tenis", 3)] },
  });
  const result = await call(client, "get_search_term_insights", { level: "campaign", campaignId: CAMPAIGN_ID });
  assert.equal(result.isError, undefined);
  assert.equal(calls.queries.length, 2);
  assert.match(calls.queries[1], /FROM customer_search_term_insight[\s\S]*segments\.campaign = /);
  assert.match(textOf(result), /RESOURCE_EXHAUSTED; os dados vieram do nível de conta/);
  assert.equal(arrayOf(result)[0].category_id, "11");

  const drill = fakeClient({ throwFor: { campaign_search_term_insight: exhausted } });
  const r2 = await call(drill.client, "get_search_term_insights", { level: "campaign", campaignId: CAMPAIGN_ID, categoryId: "11", includeTerms: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /cota \(RESOURCE_EXHAUSTED\)/);

  const other = fakeClient({ throwFor: { customer_search_term_insight: "Google Ads API: Request contains an invalid argument." } });
  await assert.rejects(() => call(other.client, "get_search_term_insights", {}), /invalid argument/);
});

// ── audit_dsa_and_legacy ──────────────────────────────────────────────

test("auditoria DSA: campanhas, grupos, alvos de página, termos e páginas, legado de ampla e migrações", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "1", name: "DSA Loja", status: "ENABLED", dynamicSearchAdsSetting: { domainName: "loja.com.br", languageCode: "pt" }, aiMaxSetting: { enableAiMax: false }, biddingStrategyType: "MAXIMIZE_CONVERSIONS" } },
        { campaign: { id: "2", name: "Ampla legado", status: "ENABLED", keywordMatchType: "BROAD", broadMatchMigrationDateTime: "2026-09-05 10:00:00", aiMaxSetting: { enableAiMax: true } } },
        { campaign: { id: "3", name: "Normal", status: "ENABLED" } },
      ],
      ad_group: [{ adGroup: { id: "10", name: "DSA todas", status: "ENABLED", type: "SEARCH_DYNAMIC_ADS" }, campaign: { id: "1", name: "DSA Loja" } }],
      ad_group_criterion: [{
        adGroupCriterion: { criterionId: "99", status: "ENABLED", negative: false, webpage: { criterionName: "Produtos", conditions: [{ operand: "URL", operator: "CONTAINS", argument: "/produtos" }], coveragePercentage: 0.05, sample: { sampleUrls: ["https://loja.com.br/produtos/a"] } } },
        adGroup: { id: "10", name: "DSA todas" }, campaign: { id: "1" },
      }],
      campaign_criterion: [
        { campaignCriterion: { criterionId: "7", type: "WEBPAGE", negative: true, webpage: { criterionName: "Blog", conditions: [{ operand: "URL", operator: "CONTAINS", argument: "/blog" }] } }, campaign: { id: "1", name: "DSA Loja" } },
        { campaignCriterion: { criterionId: "8", type: "WEBPAGE_LIST", negative: false, webpageList: { sharedSet: `customers/${CID}/sharedSets/44` } }, campaign: { id: "1", name: "DSA Loja" } },
      ],
      campaign_asset_set: [
        { campaign: { id: "1" }, campaignAssetSet: { assetSet: `customers/${CID}/assetSets/60`, status: "ENABLED" }, assetSet: { id: "60", name: "URLs de produto", type: "PAGE_FEED", status: "ENABLED" } },
        { campaign: { id: "5" }, campaignAssetSet: { assetSet: `customers/${CID}/assetSets/61`, status: "ENABLED" }, assetSet: { id: "61", name: "PMax URLs", type: "PAGE_FEED", status: "ENABLED" } },
      ],
      dynamic_search_ads_search_term_view: [
        { dynamicSearchAdsSearchTermView: { searchTerm: "tenis branco", landingPage: "https://loja.com.br/tenis", hasMatchingKeyword: false }, campaign: { id: "1" }, adGroup: { id: "10" }, metrics: metrics(4_000_000) },
        { dynamicSearchAdsSearchTermView: { searchTerm: "tenis azul", landingPage: "https://loja.com.br/tenis", hasMatchingKeyword: true }, campaign: { id: "1" }, adGroup: { id: "10" }, metrics: metrics(1_000_000) },
        { dynamicSearchAdsSearchTermView: { searchTerm: "vaga loja", landingPage: "https://loja.com.br/trabalhe", hasMatchingKeyword: false }, campaign: { id: "1" }, adGroup: { id: "10" }, metrics: metrics(2_000_000, { conversions: 0 }) },
      ],
    },
  });
  const result = await call(client, "audit_dsa_and_legacy", { days: 30 });
  assert.equal(calls.writes.length, 0);
  const froms = calls.queries.map((q) => /\bFROM\s+([a-z_]+)/.exec(q)?.[1]);
  assert.deepEqual(froms, [
    "campaign", "ad_group", "ad_group_criterion", "campaign_criterion", "campaign_asset_set",
    "dynamic_search_ads_search_term_view", "dynamic_search_ads_search_term_view",
  ]);
  assert.match(calls.queries[0], /campaign\.aca_migration_date_time, campaign\.broad_match_migration_date_time/);
  assert.match(calls.queries[1], /ad_group\.type = 'SEARCH_DYNAMIC_ADS'/);
  assert.match(calls.queries[2], /ad_group_criterion\.type = 'WEBPAGE'/);
  assert.match(calls.queries[4], /asset_set\.type = 'PAGE_FEED'/);
  assert.match(calls.queries[4], /campaign_asset_set\.status != 'REMOVED'/);
  assert.match(calls.queries[5], new RegExp(`LIMIT ${DSA_TOP_TERMS_SCAN}\\b`));
  assert.doesNotMatch(calls.queries[6], /search_term,|headline/, "a soma por página só precisa da página e das métricas");
  assert.match(calls.queries[6], new RegExp(`LIMIT ${DSA_PAGE_SCAN_CAP}\\b`));
  const payload = jsonOf(result);
  const [dsa] = payload.dsa_campaigns as Row[];
  assert.equal(dsa.domain, "loja.com.br");
  assert.equal((dsa.dsa_ad_groups as Row[]).length, 1);
  const [target] = dsa.webpage_targets as Row[];
  assert.equal(target.coverage_pct, 5);
  assert.deepEqual(target.conditions, ["URL CONTAINS /produtos"]);
  const [exclusion, webpageList] = dsa.campaign_webpage_criteria as Row[];
  assert.equal(exclusion.negative, true);
  assert.equal(webpageList.webpage_list_shared_set, `customers/${CID}/sharedSets/44`);
  assert.ok(!JSON.stringify(payload).includes('"page_feed"'), "WEBPAGE_LIST não é page feed do DSA");
  assert.deepEqual(dsa.page_feeds, [
    { asset_set_id: "60", name: "URLs de produto", asset_set_status: "ENABLED", link_status: "ENABLED", asset_set: `customers/${CID}/assetSets/60` },
  ]);
  assert.equal((payload.summary as Row).dsa_page_feeds, 1);
  assert.match(textOf(result), /1 page feed\(s\)\.$/m);
  const pages = payload.dsa_top_landing_pages as Row[];
  assert.equal(pages[0].landing_page, "https://loja.com.br/tenis");
  assert.equal(pages[0].spend, 5);
  assert.equal(pages[0].term_rows, 2);
  assert.match(JSON.stringify(payload.data_notes), /soma todas as 3 linha\(s\) termo × página/);
  assert.doesNotMatch(textOf(result), /Atenção/);
  assert.equal((payload.campaign_level_broad_match as Row[])[0].migrated_at, "2026-09-05 10:00:00");
  assert.equal((payload.migrated_campaigns as Row[]).length, 1);
  const recommendations = JSON.stringify(payload.recommendations);
  assert.match(recommendations, /usa DSA sem AI Max/);
  assert.match(recommendations, /cobertura abaixo de 10%/);
  assert.match(recommendations, /termo\(s\) de DSA com conversão ainda sem palavra-chave/);
  assert.match(recommendations, /com gasto e sem conversão/);
});

test("auditoria DSA: sem DSA na conta não consulta termos de DSA", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [{ campaign: { id: "3", name: "Normal", status: "ENABLED" } }] } });
  const result = await call(client, "audit_dsa_and_legacy", {});
  assert.match(textOf(result), /Nenhuma campanha com DSA/);
  assert.ok(!calls.queries.some((q) => q.includes("dynamic_search_ads_search_term_view")));
  assert.ok(!calls.queries.some((q) => q.includes("FROM campaign_asset_set")));
  const bad = fakeClient();
  assert.equal((await call(bad.client, "audit_dsa_and_legacy", { termsLimit: 0 })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

const dsaCampaignRow = (setting: Row, extra: Row = {}): Row => ({
  campaign: { id: "1", name: "DSA Loja", status: "ENABLED", dynamicSearchAdsSetting: { domainName: "loja.com.br", languageCode: "pt", ...setting }, aiMaxSetting: { enableAiMax: true }, ...extra },
});

test("auditoria DSA: só URLs fornecidas sem page feed ativo gera recomendação; com page feed, não", async () => {
  const without = fakeClient({ rows: { campaign: [dsaCampaignRow({ useSuppliedUrlsOnly: true })] } });
  const r1 = jsonOf(await call(without.client, "audit_dsa_and_legacy", {}));
  const [dsa] = r1.dsa_campaigns as Row[];
  assert.equal(dsa.use_supplied_urls_only, true);
  assert.deepEqual(dsa.page_feeds, []);
  assert.match(JSON.stringify(r1.recommendations), /usa só URLs fornecidas \(use_supplied_urls_only\) e não tem page feed/);

  const withFeed = fakeClient({
    rows: {
      campaign: [dsaCampaignRow({ useSuppliedUrlsOnly: true })],
      campaign_asset_set: [{ campaign: { id: "1" }, campaignAssetSet: { assetSet: `customers/${CID}/assetSets/60`, status: "ENABLED" }, assetSet: { id: "60", name: "Feed", status: "ENABLED" } }],
    },
  });
  const r2 = jsonOf(await call(withFeed.client, "audit_dsa_and_legacy", {}));
  assert.equal(((r2.dsa_campaigns as Row[])[0].page_feeds as Row[]).length, 1);
  assert.doesNotMatch(JSON.stringify(r2.recommendations), /use_supplied_urls_only/);
});

test("auditoria DSA: página no teto da soma → sem recomendação de exclusão e com aviso de dados limitados", async () => {
  // Reprodução do achado: a API devolve LIMIT linhas caras de /tenis, sem conversão; as conversões
  // da cauda longa ficariam além do corte.
  const tenis = (i: number): Row => ({
    dynamicSearchAdsSearchTermView: { searchTerm: `tenis ${i}`, landingPage: "https://loja.com.br/tenis", hasMatchingKeyword: false },
    campaign: { id: "1" }, adGroup: { id: "10" }, metrics: { impressions: "10", clicks: "1", costMicros: "500000", conversions: 0, conversionsValue: 0 },
  });
  const { client } = fakeClient({
    rows: { campaign: [dsaCampaignRow({})] },
    rowsFor: (query, from) => (from === "dynamic_search_ads_search_term_view" ? Array.from({ length: limitOf(query) }, (_, i) => tenis(i)) : undefined),
  });
  const result = await call(client, "audit_dsa_and_legacy", { days: 30 });
  const payload = jsonOf(result);
  const recommendations = JSON.stringify(payload.recommendations);
  assert.doesNotMatch(recommendations, /avalie exclusão de URL/, "exclusão não pode sair de amostra truncada");
  const notes = JSON.stringify(payload.data_notes);
  assert.match(notes, /soma só as 50\.000 linhas termo × página de maior custo \(limite da consulta\)/);
  assert.match(notes, /recomendação de exclusão de URL não foi emitida/);
  assert.match(notes, /vêm só dos 1\.000 termos de maior custo/);
  assert.match(textOf(result), /Atenção: termos\/páginas do DSA limitados/);
  const [page] = payload.dsa_top_landing_pages as Row[];
  assert.equal(page.term_rows, DSA_PAGE_SCAN_CAP, "a soma por página usa a consulta própria, não os 1.000 termos");
});

test("auditoria DSA: página que só converte na cauda longa não é marcada para exclusão", async () => {
  // Os termos caros de /tenis não convertem; um termo barato (fora dos mais caros) converte.
  const expensive = Array.from({ length: DSA_TOP_TERMS_SCAN }, (_, i) => ({
    dynamicSearchAdsSearchTermView: { searchTerm: `tenis ${i}`, landingPage: "https://loja.com.br/tenis", hasMatchingKeyword: false },
    campaign: { id: "1" }, adGroup: { id: "10" }, metrics: { impressions: "10", clicks: "1", costMicros: "500000", conversions: 0, conversionsValue: 0 },
  }));
  const cheapConverter = {
    dynamicSearchAdsSearchTermView: { landingPage: "https://loja.com.br/tenis" },
    metrics: { impressions: "3", clicks: "1", costMicros: "10000", conversions: 2, conversionsValue: 400 },
  };
  const { client } = fakeClient({
    rows: { campaign: [dsaCampaignRow({})] },
    rowsFor: (query, from) => {
      if (from !== "dynamic_search_ads_search_term_view") return undefined;
      return /search_term,/.test(query) ? expensive.slice(0, limitOf(query)) : [...expensive, cheapConverter];
    },
  });
  const payload = jsonOf(await call(client, "audit_dsa_and_legacy", { days: 30 }));
  const [page] = payload.dsa_top_landing_pages as Row[];
  assert.equal(page.conversions, 2);
  assert.equal(page.term_rows, DSA_TOP_TERMS_SCAN + 1);
  assert.doesNotMatch(JSON.stringify(payload.recommendations), /avalie exclusão de URL/);
  assert.match(JSON.stringify(payload.data_notes), /vêm só dos 1\.000 termos de maior custo/);
});

// ── create_ad_group: DSA ──────────────────────────────────────────────

test("create_ad_group: SEARCH_DYNAMIC_ADS só em campanha com domínio de DSA", async () => {
  const noDomain = fakeClient({ rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } }] } });
  const r1 = await call(noDomain.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "DSA", type: "SEARCH_DYNAMIC_ADS" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /não tem domínio de Anúncios Dinâmicos/);
  assert.equal(noDomain.calls.writes.length, 0);
  assert.match(noDomain.calls.queries[0], /campaign\.dynamic_search_ads_setting\.domain_name/);

  const withDomain = fakeClient({ rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS", dynamicSearchAdsSetting: { domainName: "loja.com.br" } } }] } });
  const r2 = await call(withDomain.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "DSA", type: "SEARCH_DYNAMIC_ADS" });
  assert.equal(r2.isError, undefined);
  assert.equal(((withDomain.calls.writes[0].operations[0] as Row).create as Row).type, "SEARCH_DYNAMIC_ADS");
  assert.match(textOf(r2), /Grupo DSA no domínio loja\.com\.br/);
});

test("create_ad_group: type de outro canal é recusado; dry-run não diz que criou", async () => {
  const display = fakeClient({ rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "DISPLAY", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } }] } });
  const r1 = await call(display.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "G", type: "SEARCH_STANDARD" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /é de campanha SEARCH/);
  assert.equal(display.calls.writes.length, 0);

  const dry = fakeClient({ dryRun: true, rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } }] } });
  const r2 = await call(dry.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "G" });
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(r2), /Ad group created/);
});

test("create_ad_group: Demand Gen vai para a tool dedicada; tipos de vídeo nem entram no schema", async () => {
  const dg = fakeClient({ rows: { campaign: [{ campaign: { id: CAMPAIGN_ID, advertisingChannelType: "DEMAND_GEN", biddingStrategyType: "MAXIMIZE_CONVERSIONS" } }] } });
  const r1 = await call(dg.client, "create_ad_group", { campaignId: CAMPAIGN_ID, name: "G" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /create_demand_gen_ad_group/);
  assert.equal(dg.calls.writes.length, 0);

  const { configs } = register(fakeClient().client);
  const typeParam = (configs.get("create_ad_group")!.inputSchema as Record<string, { unwrap(): { options: string[] } }>).type;
  assert.ok(typeParam, "create_ad_group mantém o override de type");
  assert.deepEqual(typeParam.unwrap().options, ["SEARCH_STANDARD", "SEARCH_DYNAMIC_ADS", "DISPLAY_STANDARD", "SHOPPING_PRODUCT_ADS"]);
});

// ── Catálogo e read-only ──────────────────────────────────────────────

test("read-only publica as leituras do lote e omite as escritas", () => {
  const { handlers } = register(fakeClient().client, { readOnly: true });
  for (const name of ["list_keywords", "get_search_term_insights", "audit_dsa_and_legacy", "get_search_terms", "get_keyword_performance"]) {
    assert.ok(handlers.has(name), `${name} deveria estar no read-only`);
  }
  for (const name of ["add_keywords", "bulk_update_keyword_status", "create_keyword", "remove_keyword"]) {
    assert.ok(!handlers.has(name), `${name} não deveria estar no read-only`);
  }
  const { configs } = register(fakeClient().client);
  assert.ok("validateOnly" in (configs.get("add_keywords")!.inputSchema as Row));
  assert.ok("validateOnly" in (configs.get("bulk_update_keyword_status")!.inputSchema as Row));
  assert.ok(!("validateOnly" in (configs.get("list_keywords")!.inputSchema as Row)));
});
