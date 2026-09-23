/**
 * Lote diagnostics: diagnóstico de veiculação, parcela de impressões, reprovações/exceções de
 * política, a correção do get_daily_trend (#21) e a regra de retenção de 37 meses (01/06/2026).
 *
 * Todo client falso passa as queries por assertGaqlRules (metadados reais da v25). As queries de
 * parcela de impressões também passam pela compatibilidade métrica × segmento × recurso da field
 * reference (tabela SHARE_COMPAT abaixo), que o validador genérico não cobre.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { catalog } from "../src/tools/diagnostics.catalog.js";
import {
  AD_GROUP_REASONS,
  AD_REASONS,
  ASSET_GROUP_REASONS,
  KEYWORD_REASONS,
  formatShare,
  impressionShareDiagnosis,
  parseAdsFailure,
} from "../src/tools/diagnostics.js";
import {
  buildDateClause,
  granularRetentionStart,
  retentionProblem,
} from "../src/tool-kit.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";
import { parseGaql, validateGaql } from "./gaql-validator.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";

// ── Client falso ──────────────────────────────────────────────────────

// ── WHERE e LIMIT como a API ─────────────────────────────────────────
/*
 * Um fake que ignora WHERE e LIMIT escondeu o bug do drill-down (grupo pausado pelo Google sumia
 * no GAQL, linhas herdadas enchiam o LIMIT). Com gaql: true o fake aplica as condições (AND de
 * =, !=, >, IN, NOT IN, CONTAINS ANY/ALL/NONE) e o LIMIT sobre as linhas devolvidas. Período
 * (segments.date) não é filtrado. Condição que ele não entende faz o teste falhar.
 */

const camel = (part: string) => part.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const fieldValue = (row: Row, field: string): unknown =>
  field.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Row)[camel(part)] : undefined), row);
const literal = (token: string) => token.trim().replace(/^'([\s\S]*)'$/, "$1");
const literalList = (inner: string) => inner.split(",").map(literal);

function splitAnd(where: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < where.length; i++) {
    const ch = where[i];
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    else if (!quoted && depth === 0 && where.startsWith(" AND ", i)) {
      parts.push(where.slice(start, i));
      start = i + 5;
      i += 4;
    }
  }
  parts.push(where.slice(start));
  return parts.map((p) => p.trim());
}

function matchesCondition(row: Row, condition: string): boolean {
  if (condition === "PERIODO") return true;
  let m = /^([a-z_.]+) CONTAINS (ANY|ALL|NONE) \((.*)\)$/.exec(condition);
  if (m) {
    const actual = ((fieldValue(row, m[1]) as unknown[] | undefined) ?? []).map(String);
    const wanted = literalList(m[3]);
    if (m[2] === "ANY") return wanted.some((w) => actual.includes(w));
    if (m[2] === "ALL") return wanted.every((w) => actual.includes(w));
    return !wanted.some((w) => actual.includes(w));
  }
  m = /^([a-z_.]+) (NOT IN|IN) \((.*)\)$/.exec(condition);
  if (m) {
    const inList = literalList(m[3]).includes(String(fieldValue(row, m[1]) ?? "UNSPECIFIED"));
    return m[2] === "IN" ? inList : !inList;
  }
  m = /^([a-z_.]+) (=|!=|>) (.+)$/.exec(condition);
  if (m) {
    const expected = literal(m[3]);
    const raw = fieldValue(row, m[1]);
    // valor ausente = padrão do proto (false, 0 ou UNSPECIFIED)
    const actual = raw !== undefined ? String(raw) : expected === "true" || expected === "false" ? "false" : /^\d+$/.test(expected) ? "0" : "UNSPECIFIED";
    if (m[2] === ">") return Number(actual) > Number(expected);
    return m[2] === "=" ? actual === expected : actual !== expected;
  }
  throw new Error(`fake GAQL: condição não suportada: ${condition}`);
}

function applyGaql(query: string, rows: Row[]): Row[] {
  const q = query.replace(/\s+/g, " ").trim().replace(/segments\.date (?:BETWEEN '[^']*' AND '[^']*'|DURING [A-Z_0-9]+)/g, "PERIODO");
  const where = / WHERE (.*?)(?= ORDER BY | LIMIT |$)/.exec(q)?.[1];
  const limit = Number(/ LIMIT (\d+)/.exec(q)?.[1] ?? Infinity);
  const conditions = where ? splitAnd(where) : [];
  return rows.filter((row) => conditions.every((c) => matchesCondition(row, c))).slice(0, limit);
}

interface FakeOptions {
  rows?: Record<string, Row[]>;
  respond?: (query: string) => Row[] | undefined;
  /** Aplica WHERE e LIMIT da query às linhas, como a API. */
  gaql?: boolean;
  dryRun?: boolean;
  /** Resposta do :mutate; recebe se a chamada foi validate-only. */
  mutate?: (resource: string, operations: Row[], validateOnly: boolean) => Row;
  mutateThrows?: string;
}

interface Write {
  resource: string;
  operations: Row[];
  options?: Row;
  validateOnly: boolean;
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
      const result = opts.respond?.(query) ?? opts.rows?.[from] ?? [];
      return opts.gaql ? applyGaql(query, result) : result;
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ resource, operations, options, validateOnly: dryRun });
      if (opts.mutateThrows) throw new Error(opts.mutateThrows);
      if (opts.mutate) return opts.mutate(resource, operations, dryRun);
      return dryRun ? {} : { results: operations.map(() => ({ resourceName: `customers/${CID}/${resource}/999` })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  registerGoogleAdsTools(
    { registerTool: (name: string, config: Row, handler: Handler) => { handlers.set(name, handler); configs.set(name, config); } } as never,
    () => client as never,
    allowed,
    hosted
  );
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row = {}) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const jsonOf = <T = Row>(result: Result): T => {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("\n\n") + 2)) as T;
};
const realWrites = (calls: { writes: Write[] }) => calls.writes.filter((w) => !w.validateOnly);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// ── Catálogo ──────────────────────────────────────────────────────────

test("catálogo: tools do lote classificadas; as de exceção são escrita com validateOnly", () => {
  for (const name of catalog.read) assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), `${name} fora do read`);
  for (const name of catalog.write) assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), `${name} fora do write`);
  const { handlers, configs } = register(fakeClient().client);
  for (const name of [...catalog.read, ...catalog.write]) assert.ok(handlers.has(name), `${name} não registrada`);
  for (const name of catalog.write) {
    assert.ok((configs.get(name)!.inputSchema as Row).validateOnly, `${name} sem validateOnly`);
  }
  assert.ok(!(configs.get("diagnose_campaigns")!.inputSchema as Row).validateOnly);
});

test("guarda de conta: tools do lote negam conta fora da allowlist antes de consultar", async () => {
  const { client, calls } = fakeClient();
  const { handlers } = register(client, ["1111111111"], true);
  for (const name of [...catalog.read, ...catalog.write]) {
    const result = await handlers.get(name)!({ customerId: CID, adGroupId: "1", keyword: "x", matchType: "EXACT" });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Access denied/);
  }
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

// ── #21 get_daily_trend ───────────────────────────────────────────────

test("get_daily_trend: com campaignId consulta FROM campaign (FROM customer não aceita campaign.id)", async () => {
  const old = "SELECT segments.date, metrics.impressions FROM customer WHERE segments.date DURING LAST_7_DAYS AND campaign.id = 123";
  assert.ok(validateGaql(old).some((e) => /campaign não é atribuído/.test(e)), "o validador precisa recusar o formato antigo");

  const { client, calls } = fakeClient({
    rows: { campaign: [{ segments: { date: "2026-09-01" }, campaign: { id: "123", name: "Busca" }, metrics: { impressions: "10", costMicros: "2500000" } }] },
  });
  const result = await call(client, "get_daily_trend", { campaignId: "123", days: 7 });
  const parsed = parseGaql(calls.queries[0]);
  assert.equal(parsed.from, "campaign");
  assert.match(calls.queries[0], /campaign\.id = 123/);
  assert.deepEqual(JSON.parse(textOf(result)), [{ date: "2026-09-01", impressions: 10, clicks: 0, spend: 2.5, conversions: 0, revenue: 0 }]);

  const account = fakeClient();
  await call(account.client, "get_daily_trend", { days: 7 });
  assert.equal(parseGaql(account.calls.queries[0]).from, "customer");
  assert.doesNotMatch(account.calls.queries[0], /campaign\./);
});

test("get_daily_trend: campaignId não numérico é recusado antes da API", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "get_daily_trend", { campaignId: "1 OR 1=1" });
  assert.equal(result.isError, true);
  assert.equal(calls.queries.length, 0);
});

test("get_daily_trend: sem linhas distingue campanha inexistente de campanha sem entrega", async () => {
  const missing = fakeClient();
  const notFound = await call(missing.client, "get_daily_trend", { campaignId: "5" });
  assert.equal(notFound.isError, true);
  assert.match(textOf(notFound), /não encontrada/);

  const idle = fakeClient({
    respond: (q) => (/segments\.date/.test(q) ? [] : [{ campaign: { id: "5", name: "Parada", status: "ENABLED" } }]),
  });
  const noData = await call(idle.client, "get_daily_trend", { campaignId: "5" });
  assert.notEqual(noData.isError, true);
  assert.match(textOf(noData), /não veiculou.*diagnose_campaigns/s);
});

test("get_daily_trend: granularity MONTH usa segments.month e aceita histórico antigo alinhado ao mês", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [{ segments: { month: "2021-01-01" }, metrics: { impressions: "5" } }] } });
  const result = await call(client, "get_daily_trend", { granularity: "MONTH", dateRange: { since: "2021-01-01", until: "2021-03-31" } });
  assert.match(calls.queries[0], /SELECT segments\.month/);
  assert.match(calls.queries[0], /ORDER BY segments\.month/);
  assert.equal((JSON.parse(textOf(result)) as Row[])[0].period, "2021-01-01");
});

test("retenção: dado diário com mais de 37 meses é recusado antes da API, com a saída mensal no texto", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(
    call(client, "get_daily_trend", { dateRange: { since: "2021-01-01", until: "2021-03-31" } }),
    /37 meses.*granularity MONTH/s
  );
  await assert.rejects(
    call(client, "get_daily_trend", { granularity: "MONTH", dateRange: { since: "2021-01-15", until: "2021-03-31" } }),
    /alinhados ao mês.*since 2021-01-01 e until 2021-03-31/s
  );
  assert.equal(calls.queries.length, 0);
});

test("retenção: regras de buildDateClause (limite, alinhamento, days, datas inválidas)", () => {
  const now = new Date(2026, 8, 23);
  assert.equal(granularRetentionStart(now), "2023-08-23");
  assert.equal(retentionProblem("2023-08-23", "2023-09-30", {}, now), null, "dentro da janela");
  assert.equal(retentionProblem("2023-08-23", "2023-09-30", { granular: true }, now), null);
  // A sugestão cobre o período pedido: since volta ao dia 1, until vai ao fim do mês (já completo).
  assert.match(retentionProblem("2023-08-22", "2023-09-10", {}, now)!, /since 2023-08-01 e until 2023-09-30/);
  assert.equal(retentionProblem("2020-01-01", "2020-12-31", {}, now), null, "antigo alinhado ao mês passa");
  assert.match(retentionProblem("2020-01-01", "2020-12-31", { granular: true }, now)!, /37 meses/);
  // until no mês corrente: a sugestão fecha no último mês completo
  assert.match(retentionProblem("2020-01-01", "2026-09-10", {}, now)!, /until 2026-08-31/);

  assert.throws(() => buildDateClause(undefined, 2000), /days=2000.*Use dateRange/s);
  assert.match(buildDateClause(undefined, 90), /BETWEEN/);
  assert.throws(() => buildDateClause({ since: "2026-02-30", until: "2026-03-01" }), /inexistente/);
  assert.throws(() => buildDateClause({ since: "2026-03-10", until: "2026-03-01" }), /depois de until/);
});

// ── compare_periods ───────────────────────────────────────────────────

test("compare_periods: datas cruas não chegam mais ao GAQL; campaignId compara uma campanha", async () => {
  const bad = fakeClient();
  const injected = await call(bad.client, "compare_periods", {
    periodA: { since: "2026-09-01' OR '1'='1", until: "2026-09-10" },
    periodB: { since: "2026-08-01", until: "2026-08-10" },
  });
  assert.equal(injected.isError, true);
  const reversed = await call(bad.client, "compare_periods", {
    periodA: { since: "2026-09-10", until: "2026-09-01" },
    periodB: { since: "2026-08-01", until: "2026-08-10" },
  });
  assert.equal(reversed.isError, true);
  const nonNumeric = await call(bad.client, "compare_periods", {
    periodA: { since: "2026-09-01", until: "2026-09-10" }, periodB: { since: "2026-08-01", until: "2026-08-10" }, campaignId: "x",
  });
  assert.equal(nonNumeric.isError, true);
  assert.equal(bad.calls.queries.length, 0);

  const { client, calls } = fakeClient({
    respond: (q) => [{
      campaign: { id: "7", name: "Marca" },
      metrics: /2026-09-01/.test(q) ? { costMicros: "200000000", conversionsValue: "800" } : { costMicros: "100000000", conversionsValue: "200" },
    }],
  });
  const result = await call(client, "compare_periods", {
    periodA: { since: "2026-09-01", until: "2026-09-10" },
    periodB: { since: "2026-08-01", until: "2026-08-10" },
    campaignId: "7",
  });
  assert.ok(calls.queries.every((q) => parseGaql(q).from === "campaign" && /campaign\.id = 7/.test(q)));
  const out = JSON.parse(textOf(result)) as Row;
  assert.equal(out.campaign_name, "Marca");
  assert.deepEqual(out.roas, { current: 4, previous: 2 });
});

test("compare_periods: since/until vazio é recusado (antes caía em LAST_30_DAYS com o rótulo do período pedido)", async () => {
  const { client, calls } = fakeClient();
  const good = { since: "2026-08-01", until: "2026-08-10" };
  for (const periodA of [
    { since: "", until: "2026-09-10" },
    { since: "2026-09-01", until: "" },
    { since: "", until: "" },
    { since: "2026-9-1", until: "2026-09-10" },
  ]) {
    const result = await call(client, "compare_periods", { periodA, periodB: good });
    assert.equal(result.isError, true, JSON.stringify(periodA));
    assert.match(textOf(result), /periodA precisa de since e until/);
  }
  const onB = await call(client, "compare_periods", { periodA: good, periodB: { since: "", until: "" } });
  assert.match(textOf(onB), /periodB precisa de since e until/);
  assert.equal(calls.queries.length, 0);
});

test("buildDateClause: dateRange com só uma ponta é erro; as duas vazias usam days", () => {
  assert.throws(() => buildDateClause({ since: "", until: "2026-09-10" }, 7), /dateRange incompleto/);
  assert.throws(() => buildDateClause({ since: "2026-09-01", until: "" }), /dateRange incompleto/);
  assert.doesNotMatch(buildDateClause({ since: "", until: "" }, 7), /2026-09-10/);
  assert.match(buildDateClause({ since: "2026-09-01", until: "2026-09-10" }), /BETWEEN '2026-09-01' AND '2026-09-10'/);
});

test("compare_periods: período antigo fora do mês civil recebe a sugestão alinhada", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "compare_periods", {
    periodA: { since: "2026-09-01", until: "2026-09-10" },
    periodB: { since: "2021-09-05", until: "2021-09-10" },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /alinhados ao mês/);
  assert.equal(calls.queries.length, 0);
});

// ── diagnose_campaigns ────────────────────────────────────────────────

const campaignStatus = (id: string, name: string, extra: Row = {}) => ({
  campaign: {
    id, name, status: "ENABLED", servingStatus: "SERVING", primaryStatus: "ELIGIBLE", primaryStatusReasons: [],
    biddingStrategyType: "MAXIMIZE_CONVERSIONS", biddingStrategySystemStatus: "ENABLED", advertisingChannelType: "SEARCH",
    ...extra,
  },
  campaignBudget: { amountMicros: "50000000", explicitlyShared: false },
});

function diagnoseClient(extraRespond?: (q: string) => Row[] | undefined) {
  return fakeClient({
    gaql: true,
    respond: (q) => {
      const custom = extraRespond?.(q);
      if (custom) return custom;
      if (/FROM campaign/.test(q) && /primary_status/.test(q)) {
        return [
          campaignStatus("1", "Ok"),
          campaignStatus("2", "Parou", { primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] }),
          campaignStatus("3", "Pausada", { status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["CAMPAIGN_PAUSED"] }),
          campaignStatus("4", "Sem palavras", {
            primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_KEYWORDS"], biddingStrategySystemStatus: "MISCONFIGURED_ZERO_ELIGIBILITY",
          }),
        ];
      }
      if (/FROM campaign/.test(q) && /metrics\.impressions/.test(q)) {
        return [
          { campaign: { id: "1" }, metrics: { impressions: "1000", costMicros: "30000000" } },
          { campaign: { id: "4" }, metrics: { impressions: "5" } },
        ];
      }
      return undefined;
    },
  });
}

test("diagnose_campaigns: mostra a campanha que parou de veicular, com motivo explicado e a tool que resolve", async () => {
  const { client, calls } = diagnoseClient();
  const result = await call(client, "diagnose_campaigns", {});
  assert.equal(calls.queries.length, 2, "status (sem métricas) + entrega recente");
  assert.doesNotMatch(calls.queries[0], /metrics\./, "a query de status não pode ter métricas — senão a campanha parada some");
  assert.match(calls.queries[1], /DURING LAST_7_DAYS/);
  const out = jsonOf<{ resumo: Row; campanhas: Row[] }>(result);
  assert.deepEqual(out.campanhas.map((c) => c.campaign_id), ["2", "4"], "onlyProblems: sem a elegível e sem a pausada");
  assert.equal(out.resumo.ocultas, 2);
  const stopped = out.campanhas[0];
  assert.equal(stopped.gravidade, "atencao");
  assert.match(String(stopped.alerta), /sem nenhuma impressão/);
  const reason = (stopped.motivos as Row[])[0];
  assert.equal(reason.codigo, "BUDGET_CONSTRAINED");
  assert.match(String(reason.acao), /update_budget/);
  const broken = out.campanhas[1];
  assert.equal(broken.gravidade, "problema");
  assert.match(String((broken.motivos as Row[])[0].acao), /create_keyword/);
  assert.match(String((broken.estrategia as Row).explicacao), /rastreamento de conversão/);

  const all = diagnoseClient();
  const full = jsonOf<{ campanhas: Row[] }>(await call(all.client, "diagnose_campaigns", { onlyProblems: false }));
  assert.equal(full.campanhas.length, 4);
  assert.equal(full.campanhas.find((c) => c.campaign_id === "3")!.gravidade, "info");
});

const ACTIVE = { id: "1", name: "Ok", status: "ENABLED", primaryStatus: "ELIGIBLE" };

test("diagnose_campaigns: drillDown monta queries válidas nos quatro níveis e explica os motivos", async () => {
  const detail: Record<string, Row[]> = {
    ad_group: [{ adGroup: { id: "10", name: "G", status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_AD_GROUP_ADS"] }, campaign: ACTIVE }],
    ad_group_ad: [{ adGroupAd: { ad: { id: "20", type: "RESPONSIVE_SEARCH_AD" }, status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_AD_DISAPPROVED"], policySummary: { approvalStatus: "DISAPPROVED" } }, adGroup: { id: "10", name: "G", status: "ENABLED" }, campaign: ACTIVE }],
    ad_group_criterion: [
      { adGroupCriterion: { criterionId: "30", type: "KEYWORD", keyword: { text: "tenis", matchType: "EXACT" }, status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_CRITERION_RARELY_SERVED"], systemServingStatus: "RARELY_SERVED" }, adGroup: { id: "10", name: "G", status: "ENABLED" }, campaign: ACTIVE },
      { adGroupCriterion: { criterionId: "31", type: "KEYWORD", keyword: { text: "ok", matchType: "EXACT" }, status: "ENABLED", primaryStatus: "ELIGIBLE", primaryStatusReasons: [] }, adGroup: { id: "10", name: "G", status: "ENABLED" }, campaign: ACTIVE },
    ],
    asset_group: [{ assetGroup: { id: "40", name: "AG", status: "ENABLED", primaryStatus: "LIMITED", primaryStatusReasons: ["ASSET_GROUP_LIMITED"] }, campaign: ACTIVE }],
  };
  for (const [drillDown, from, expected] of [
    ["ad_groups", "ad_group", /create_ad/],
    ["ads", "ad_group_ad", /list_policy_issues/],
    ["keywords", "ad_group_criterion", /Raramente veiculada/],
    ["asset_groups", "asset_group", /limitada por política/],
  ] as const) {
    const { client, calls } = diagnoseClient((q) => (parseGaql(q).from === from ? detail[from] : undefined));
    const result = await call(client, "diagnose_campaigns", { drillDown, limit: 50 });
    assert.equal(calls.queries.length, 5, `${drillDown}: status + entrega + 3 consultas do drill-down (problema, atenção, sem motivo)`);
    for (const query of calls.queries.slice(2)) {
      assert.equal(parseGaql(query).from, from);
      assert.match(query, /LIMIT 50/);
    }
    const out = jsonOf<{ detalhe: { itens: Row[] } }>(result);
    assert.equal(out.detalhe.itens.length, 1, `${drillDown}: onlyProblems deixa só o que tem pendência`);
    assert.match(formatJsonSafe(out.detalhe.itens[0].motivos), expected);
  }
});

const formatJsonSafe = (value: unknown) => JSON.stringify(value);

/**
 * Valores dos enums v25 sem UNSPECIFIED/UNKNOWN — google/ads/googleads/v25/enums/
 * {ad_group,ad_group_ad,ad_group_criterion,asset_group}_primary_status{,_reason}.proto (lidos em 2026-09-23).
 */
const V25_REASONS: Record<string, string[]> = {
  ad_group: ["CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED", "AD_GROUP_INCOMPLETE", "KEYWORDS_PAUSED", "NO_KEYWORDS", "AD_GROUP_ADS_PAUSED", "NO_AD_GROUP_ADS", "HAS_ADS_DISAPPROVED", "HAS_ADS_LIMITED_BY_POLICY", "MOST_ADS_UNDER_REVIEW", "CAMPAIGN_DRAFT", "AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY"],
  ad_group_ad: ["CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED", "AD_GROUP_AD_PAUSED", "AD_GROUP_AD_REMOVED", "AD_GROUP_AD_DISAPPROVED", "AD_GROUP_AD_UNDER_REVIEW", "AD_GROUP_AD_POOR_QUALITY", "AD_GROUP_AD_NO_ADS", "AD_GROUP_AD_APPROVED_LABELED", "AD_GROUP_AD_AREA_OF_INTEREST_ONLY", "AD_GROUP_AD_UNDER_APPEAL"],
  ad_group_criterion: ["CAMPAIGN_PENDING", "CAMPAIGN_CRITERION_NEGATIVE", "CAMPAIGN_PAUSED", "CAMPAIGN_REMOVED", "CAMPAIGN_ENDED", "AD_GROUP_PAUSED", "AD_GROUP_REMOVED", "AD_GROUP_CRITERION_DISAPPROVED", "AD_GROUP_CRITERION_RARELY_SERVED", "AD_GROUP_CRITERION_LOW_QUALITY", "AD_GROUP_CRITERION_UNDER_REVIEW", "AD_GROUP_CRITERION_PENDING_REVIEW", "AD_GROUP_CRITERION_BELOW_FIRST_PAGE_BID", "AD_GROUP_CRITERION_NEGATIVE", "AD_GROUP_CRITERION_RESTRICTED", "AD_GROUP_CRITERION_PAUSED", "AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY", "AD_GROUP_CRITERION_REMOVED"],
  asset_group: ["ASSET_GROUP_PAUSED", "ASSET_GROUP_REMOVED", "CAMPAIGN_REMOVED", "CAMPAIGN_PAUSED", "CAMPAIGN_PENDING", "CAMPAIGN_ENDED", "ASSET_GROUP_LIMITED", "ASSET_GROUP_DISAPPROVED", "ASSET_GROUP_UNDER_REVIEW"],
};
const V25_STATUSES: Record<string, string[]> = {
  ad_group: ["ELIGIBLE", "PAUSED", "REMOVED", "PENDING", "NOT_ELIGIBLE", "LIMITED"],
  ad_group_ad: ["ELIGIBLE", "PAUSED", "REMOVED", "PENDING", "LIMITED", "NOT_ELIGIBLE"],
  ad_group_criterion: ["ELIGIBLE", "PAUSED", "REMOVED", "PENDING", "NOT_ELIGIBLE"],
  asset_group: ["ELIGIBLE", "PAUSED", "REMOVED", "NOT_ELIGIBLE", "LIMITED", "PENDING"],
};

test("diagnose_campaigns: tabelas de motivos = enums v25; só valores do enum vão para o GAQL do drill-down", async () => {
  const tables: Record<string, Record<string, unknown>> = {
    ad_group: AD_GROUP_REASONS, ad_group_ad: AD_REASONS, ad_group_criterion: KEYWORD_REASONS, asset_group: ASSET_GROUP_REASONS,
  };
  for (const [entity, table] of Object.entries(tables)) {
    assert.deepEqual(Object.keys(table).sort(), [...V25_REASONS[entity]].sort(), `${entity}: tabela ≠ enum v25`);
  }
  for (const [drillDown, entity] of [["ad_groups", "ad_group"], ["ads", "ad_group_ad"], ["keywords", "ad_group_criterion"], ["asset_groups", "asset_group"]]) {
    const { client, calls } = diagnoseClient();
    await call(client, "diagnose_campaigns", { drillDown });
    for (const query of calls.queries.slice(2)) {
      const flat = query.replace(/\s+/g, " ");
      for (const [, list] of flat.matchAll(new RegExp(`${entity}\\.primary_status_reasons CONTAINS (?:ANY|NONE) \\(([^)]*)\\)`, "g"))) {
        for (const code of literalList(list)) assert.ok(V25_REASONS[entity].includes(code), `${entity}: ${code} não existe no enum`);
      }
      for (const [, list] of flat.matchAll(new RegExp(`${entity}\\.primary_status IN \\(([^)]*)\\)`, "g"))) {
        for (const code of literalList(list)) assert.ok(V25_STATUSES[entity].includes(code), `${entity}: status ${code} não existe`);
      }
    }
  }
});

const groupRow = (id: string, name: string, group: Row, campaign: Row = ACTIVE) => ({
  adGroup: { id, name, status: "ENABLED", primaryStatusReasons: [], ...group },
  campaign,
});

test("diagnose_campaigns: drill-down padrão acha grupo pausado pelo Google e grupo elegível com anúncio reprovado", async () => {
  const rows = [
    groupRow("11", "Auto-pausado", { status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["AD_GROUP_PAUSED_DUE_TO_LOW_ACTIVITY"] }),
    groupRow("12", "Veicula com reprovado", { primaryStatus: "ELIGIBLE", primaryStatusReasons: ["HAS_ADS_DISAPPROVED"] }),
    groupRow("13", "Pausado pelo usuário", { status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["AD_GROUP_PAUSED"] }),
    groupRow("14", "Saudável", { primaryStatus: "ELIGIBLE" }),
  ];
  const { client } = diagnoseClient((q) => (parseGaql(q).from === "ad_group" ? rows : undefined));
  const out = jsonOf<{ detalhe: { itens: Row[]; aviso?: string } }>(await call(client, "diagnose_campaigns", { drillDown: "ad_groups" }));
  const byId = Object.fromEntries(out.detalhe.itens.map((i) => [String(i.id), i.gravidade]));
  assert.deepEqual(byId, { 12: "problema", 11: "atencao" }, "problema antes de atenção; pausa do usuário e saudável ficam de fora");
  assert.equal(String(out.detalhe.itens[0].id), "12");
  assert.equal(out.detalhe.aviso, undefined);
});

test("diagnose_campaigns: linhas herdadas de campanha encerrada/pendente/pausada não tomam o LIMIT", async () => {
  const ended = { id: "5", name: "Encerrada", status: "ENABLED", primaryStatus: "ENDED" };
  const pending = { id: "6", name: "Futura", status: "ENABLED", primaryStatus: "PENDING" };
  const paused = { id: "7", name: "Pausada", status: "PAUSED", primaryStatus: "PAUSED" };
  const rows = [
    ...["50", "51", "52", "53", "54"].map((id) => groupRow(id, `Herdado ${id}`, { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_ENDED"] }, ended)),
    groupRow("55", "Encerrada sem anúncio", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_ENDED", "NO_AD_GROUP_ADS"] }, ended),
    groupRow("60", "Pendente herdado", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PENDING"] }, pending),
    groupRow("61", "Pendente sem anúncio", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PENDING", "NO_AD_GROUP_ADS"] }, pending),
    groupRow("70", "Pausada sem anúncio", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PAUSED", "NO_AD_GROUP_ADS"] }, paused),
    groupRow("80", "Sem anúncio", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_AD_GROUP_ADS"] }),
    groupRow("81", "Não elegível sem motivo", { primaryStatus: "NOT_ELIGIBLE" }),
  ];
  const { client } = diagnoseClient((q) => (parseGaql(q).from === "ad_group" ? rows : undefined));
  const out = jsonOf<{ detalhe: { itens: Row[]; aviso?: string } }>(await call(client, "diagnose_campaigns", { drillDown: "ad_groups", limit: 5 }));
  assert.deepEqual(out.detalhe.itens.map((i) => String(i.id)).sort(), ["61", "80", "81"],
    "fica: sem anúncio (ativa), sem motivo mas NOT_ELIGIBLE, e o problema próprio da campanha que ainda vai começar");
  assert.equal(out.detalhe.aviso, undefined, "nenhuma consulta encheu o limite");

  const all = diagnoseClient((q) => (parseGaql(q).from === "ad_group" ? rows : undefined));
  const full = jsonOf<{ detalhe: { itens: Row[] } }>(await call(all.client, "diagnose_campaigns", { drillDown: "ad_groups", onlyProblems: false, limit: 500 }));
  assert.equal(all.calls.queries.length, 3, "sem onlyProblems: uma consulta só");
  assert.doesNotMatch(all.calls.queries[2], /WHERE[\s\S]*primary_status/, "sem filtro de status");
  const severity = Object.fromEntries(full.detalhe.itens.map((i) => [String(i.id), i.gravidade]));
  assert.equal(full.detalhe.itens.length, rows.length);
  assert.equal(severity[50], "info", "herdado da campanha encerrada é info");
  assert.equal(severity[70], "problema", "com onlyProblems=false o problema próprio aparece mesmo em campanha pausada");
});

test("diagnose_campaigns: anúncios e palavras-chave — grupo pausado fica de fora, QS baixo e pausa automática entram, sem repetir", async () => {
  const pausedGroup = { id: "9", name: "Grupo pausado", status: "PAUSED" };
  const activeGroup = { id: "10", name: "G", status: "ENABLED" };
  const ads = [
    { adGroupAd: { ad: { id: "20" }, status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_AD_DISAPPROVED", "AD_GROUP_AD_AREA_OF_INTEREST_ONLY"] }, adGroup: activeGroup, campaign: ACTIVE },
    { adGroupAd: { ad: { id: "21" }, status: "ENABLED", primaryStatus: "PAUSED", primaryStatusReasons: ["AD_GROUP_PAUSED", "AD_GROUP_AD_DISAPPROVED"] }, adGroup: pausedGroup, campaign: ACTIVE },
  ];
  const adClient = diagnoseClient((q) => (parseGaql(q).from === "ad_group_ad" ? ads : undefined));
  const adOut = jsonOf<{ detalhe: { itens: Row[] } }>(await call(adClient.client, "diagnose_campaigns", { drillDown: "ads" }));
  assert.deepEqual(adOut.detalhe.itens.map((i) => String(i.id)), ["20"], "motivo de problema e de atenção: uma linha só; grupo pausado fora");

  const kw = (id: string, extra: Row, group: Row = activeGroup) => ({
    adGroupCriterion: { criterionId: id, type: "KEYWORD", negative: false, keyword: { text: `kw${id}`, matchType: "EXACT" }, status: "ENABLED", ...extra },
    adGroup: group, campaign: ACTIVE,
  });
  const keywords = [
    kw("30", { primaryStatus: "ELIGIBLE", primaryStatusReasons: ["AD_GROUP_CRITERION_LOW_QUALITY"] }),
    kw("31", { status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["AD_GROUP_CRITERION_PAUSED_DUE_TO_LOW_ACTIVITY"] }),
    kw("32", { status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["AD_GROUP_CRITERION_PAUSED"] }),
    kw("33", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["AD_GROUP_CRITERION_DISAPPROVED"] }, pausedGroup),
  ];
  const kwClient = diagnoseClient((q) => (parseGaql(q).from === "ad_group_criterion" ? keywords : undefined));
  const kwOut = jsonOf<{ detalhe: { itens: Row[] } }>(await call(kwClient.client, "diagnose_campaigns", { drillDown: "keywords" }));
  assert.deepEqual(kwOut.detalhe.itens.map((i) => String(i.id)).sort(), ["30", "31"]);
});

test("diagnose_campaigns: motivos de problema vêm antes dos de atenção no LIMIT, e o corte é avisado", async () => {
  const rows = [
    ...["1", "2", "3"].map((id) => groupRow(`2${id}`, `Limitado ${id}`, { primaryStatus: "LIMITED", primaryStatusReasons: ["HAS_ADS_LIMITED_BY_POLICY"] })),
    groupRow("90", "Sem palavras", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_KEYWORDS"] }),
    groupRow("91", "Não elegível sem motivo", { primaryStatus: "NOT_ELIGIBLE" }),
  ];
  const { client } = diagnoseClient((q) => (parseGaql(q).from === "ad_group" ? rows : undefined));
  const result = await call(client, "diagnose_campaigns", { drillDown: "ad_groups", limit: 2 });
  const out = jsonOf<{ detalhe: { itens: Row[]; aviso?: string } }>(result);
  // A consulta "sem motivo" chega por último; a ordenação por gravidade a põe antes dos de atenção.
  assert.deepEqual(out.detalhe.itens.map((i) => String(i.id)), ["90", "91"], "os problemas não perdem a vaga para os de atenção");
  assert.match(String(out.detalhe.aviso), /Limite de 2 linha/);
  assert.match(textOf(result).split("\n\n")[0], /Limite de 2 linha/, "o aviso também sai no cabeçalho");
});

test("diagnose_campaigns: format table e csv trazem o drill-down (antes só o JSON trazia)", async () => {
  const campaign = [campaignStatus("1", "Veiculando")];
  const groups = [groupRow("10", "Grupo sem anuncio", { primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_AD_GROUP_ADS"] })];
  const respond = (q: string) => {
    const from = parseGaql(q).from;
    if (from === "campaign") return /metrics\./.test(q) ? [{ campaign: { id: "1" }, metrics: { impressions: "1000" } }] : campaign;
    return from === "ad_group" ? groups : undefined;
  };
  const table = textOf(await call(fakeClient({ gaql: true, respond }).client, "diagnose_campaigns", { drillDown: "ad_groups", format: "table" }));
  assert.match(table, /0 de 1 campanha/);
  assert.match(table, /Detalhe \(ad_groups\): 1 linha/);
  assert.match(table, /Grupo sem anuncio/);
  assert.match(table, /NO_AD_GROUP_ADS/);

  const csv = textOf(await call(fakeClient({ gaql: true, respond }).client, "diagnose_campaigns", { drillDown: "ad_groups", format: "csv" }));
  const [head, ...lines] = csv.split("\n");
  assert.match(head, /^nivel,campaign_id,campanha,id,nome,status,primary_status,gravidade,motivos/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^grupo,1,Ok,10,Grupo sem anuncio,ENABLED,NOT_ELIGIBLE,problema,NO_AD_GROUP_ADS/);

  // Campanha com problema + detalhe: as duas no mesmo CSV, pela coluna nivel.
  const both = textOf(await call(diagnoseClient((q) => (parseGaql(q).from === "ad_group" ? groups : undefined)).client, "diagnose_campaigns", { drillDown: "ad_groups", format: "csv" }));
  assert.deepEqual(both.split("\n").slice(1).map((line) => line.split(",")[0]), ["campanha", "campanha", "grupo"]);

  // Sem nada a mostrar: nunca string vazia.
  const empty = textOf(await call(fakeClient({ gaql: true, respond: (q) => (parseGaql(q).from === "campaign" ? respond(q) : []) }).client, "diagnose_campaigns", { drillDown: "ad_groups", format: "csv" }));
  assert.match(empty, /^# 0 de 1 campanha/);
});

test("diagnose_campaigns: validações antes da API, campanha inexistente e formato tabela", async () => {
  const { client, calls } = fakeClient();
  assert.equal((await call(client, "diagnose_campaigns", { campaignId: "abc" })).isError, true);
  assert.equal((await call(client, "diagnose_campaigns", { limit: 0 })).isError, true);
  assert.equal((await call(client, "diagnose_campaigns", { days: -1 })).isError, true);
  assert.equal(calls.queries.length, 0);
  const missing = await call(client, "diagnose_campaigns", { campaignId: "99" });
  assert.match(textOf(missing), /não encontrada/);
  assert.equal(calls.queries.length, 1);
  assert.match(calls.queries[0], /campaign\.id = 99/);

  const table = diagnoseClient();
  const out = textOf(await call(table.client, "diagnose_campaigns", { format: "table" }));
  assert.match(out, /campaign_id \| name/);
  assert.match(out, /BUDGET_CONSTRAINED/);
});

// ── get_account_health ────────────────────────────────────────────────

test("get_account_health: junta status, rastreamento, cliques inválidos, status primário e reprovações", async () => {
  const { client, calls } = fakeClient({
    respond: (q) => {
      const from = parseGaql(q).from;
      if (from === "customer" && /optimization_score/.test(q)) {
        return [{ customer: {
          id: CID, descriptiveName: "Loja", status: "ENABLED", manager: false, optimizationScore: 0.62, autoTaggingEnabled: false,
          conversionTrackingSetting: { conversionTrackingStatus: "NOT_CONVERSION_TRACKED", acceptedCustomerDataTerms: false },
        } }];
      }
      if (from === "customer") return [{ metrics: { clicks: "1000", invalidClicks: "150", invalidClickRate: 0.15 } }];
      if (from === "campaign") {
        return [
          { campaign: { id: "1", status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["NO_KEYWORDS"] } },
          { campaign: { id: "2", status: "ENABLED", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] } },
          { campaign: { id: "3", status: "PAUSED", primaryStatus: "PAUSED", primaryStatusReasons: ["CAMPAIGN_PAUSED"] } },
        ];
      }
      if (from === "ad_group_ad") return [{ adGroupAd: { ad: { id: "1" } } }, { adGroupAd: { ad: { id: "2" } } }];
      return undefined;
    },
  });
  const result = await call(client, "get_account_health", { days: 30 });
  assert.equal(calls.queries.length, 4);
  const out = jsonOf<Row>(result);
  assert.deepEqual((out.campanhas as Row).por_primary_status, { NOT_ELIGIBLE: 1, LIMITED: 1, PAUSED: 1 });
  assert.equal(out.anuncios_reprovados_em_campanhas_ativas, 2);
  assert.equal((out.trafego as Row).taxa_cliques_invalidos, "15%");
  const alerts = (out.alertas as Row[]).map((a) => String(a.texto)).join("\n");
  for (const expected of [/Auto-tagging/, /não rastreia conversões/, /cliques inválidos/, /NOT_ELIGIBLE/, /LIMITED/, /reprovado/, /otimização/, /termos de dados/]) {
    assert.match(alerts, expected);
  }
  assert.equal((out.alertas as Row[])[0].nivel, "problema", "alertas mais graves primeiro");
});

test("get_account_health: conta gerenciadora responde sem consultar métricas", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [{ customer: { id: CID, manager: true, status: "ENABLED" } }] } });
  const result = await call(client, "get_account_health", {});
  assert.match(textOf(result), /gerenciadora/);
  assert.equal(calls.queries.length, 1);
});

// ── get_impression_share ─────────────────────────────────────────────

/**
 * "Selectable with" da field reference v25 (developers.google.com/google-ads/api/fields/v25/metrics,
 * extraído em 2026-09-23), restrito aos recursos e segmentos que a tool usa.
 */
const BASE = ["customer", "campaign", "ad_group", "keyword_view"];
const ALL_SEGMENTS = ["segments.date", "segments.week", "segments.month", "segments.device", "segments.day_of_week", "segments.hour"];
const SHARE_COMPAT: Record<string, string[]> = {
  search_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_budget_lost_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_rank_lost_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_top_impression_share: [...BASE, ...ALL_SEGMENTS],
  search_absolute_top_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_budget_lost_top_impression_share: [...BASE, ...ALL_SEGMENTS],
  search_rank_lost_top_impression_share: [...BASE, ...ALL_SEGMENTS],
  search_budget_lost_absolute_top_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_rank_lost_absolute_top_impression_share: [...BASE, "shopping_performance_view", ...ALL_SEGMENTS, "segments.product_item_id"],
  search_exact_match_impression_share: [...BASE, ...ALL_SEGMENTS.filter((s) => s !== "segments.hour")],
  top_impression_percentage: [...BASE, ...ALL_SEGMENTS],
  absolute_top_impression_percentage: [...BASE, ...ALL_SEGMENTS],
  content_impression_share: ["customer", "campaign", "ad_group", ...ALL_SEGMENTS],
  content_budget_lost_impression_share: ["customer", "campaign", "ad_group", ...ALL_SEGMENTS.filter((s) => s !== "segments.hour")],
  content_rank_lost_impression_share: ["customer", "campaign", "ad_group", ...ALL_SEGMENTS.filter((s) => s !== "segments.hour")],
};

function assertShareCompat(query: string) {
  const parsed = parseGaql(query);
  const segments = parsed.select.filter((f) => f.startsWith("segments."));
  for (const field of parsed.select.filter((f) => f.startsWith("metrics."))) {
    const allowed = SHARE_COMPAT[field.slice("metrics.".length)];
    if (!allowed) continue;
    assert.ok(allowed.includes(parsed.from), `${field} não é selecionável com FROM ${parsed.from}`);
    for (const segment of segments) assert.ok(allowed.includes(segment), `${field} não é selecionável com ${segment}`);
  }
}

test("get_impression_share: todas as combinações nível × segmento × rede montam GAQL aceito (ou são recusadas antes)", async () => {
  const levels = ["account", "campaign", "ad_group", "keyword", "product"];
  const segments = ["none", "date", "week", "month", "device", "day_of_week", "hour"];
  let built = 0;
  let refused = 0;
  for (const level of levels) {
    for (const segmentBy of segments) {
      for (const network of ["SEARCH", "DISPLAY"]) {
        const { client, calls } = fakeClient();
        const result = await call(client, "get_impression_share", {
          level, segmentBy, network, days: 30,
          ...(level !== "account" ? { campaignId: "7" } : {}),
          ...(level === "keyword" || level === "ad_group" ? { adGroupId: "8" } : {}),
        });
        if (result.isError) {
          refused++;
          assert.equal(calls.queries.length, 0, `${level}/${segmentBy}/${network}: recusa depois de consultar`);
          assert.ok(
            (network === "DISPLAY" && (level === "keyword" || level === "product")) || (segmentBy === "hour" && (level === "keyword" || level === "product")),
            `${level}/${segmentBy}/${network} recusado sem motivo: ${textOf(result)}`
          );
          continue;
        }
        built++;
        for (const query of calls.queries) assertShareCompat(query);
      }
    }
  }
  assert.ok(built >= 50 && refused > 0, `montou ${built}, recusou ${refused}`);
});

test("get_impression_share: valores truncados pela API viram <10% / >90% e o diagnóstico aponta o gargalo", async () => {
  assert.equal(formatShare(0.0999, "share"), "<10%");
  assert.equal(formatShare(0.9001, "lost"), ">90%");
  assert.equal(formatShare(0.4567, "share"), "45.67%");
  assert.equal(formatShare(undefined, "share"), null);
  assert.equal(impressionShareDiagnosis(0.5, 0.3, 0.2), "limitada por orçamento");
  assert.equal(impressionShareDiagnosis(0.5, 0.05, 0.45), "limitada por ranking (lance/qualidade)");
  assert.equal(impressionShareDiagnosis(0.95, 0, 0.05), "parcela alta (≥ 90%)");
  assert.equal(impressionShareDiagnosis(undefined, 0, 0), "sem dados de parcela");

  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "1", name: "Busca", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, metrics: { searchImpressionShare: 0.0999, searchBudgetLostImpressionShare: 0.9001, searchRankLostImpressionShare: 0.0, costMicros: "10000000", conversionsValue: "40" } },
        { campaign: { id: "2", name: "Display", advertisingChannelType: "DISPLAY" }, metrics: { costMicros: "5000000" } },
      ],
    },
  });
  const result = await call(client, "get_impression_share", {});
  assert.match(calls.queries[0], /FROM campaign/);
  assert.match(calls.queries[0], /metrics\.impressions > 0/);
  assert.match(calls.queries[0], /ORDER BY metrics\.cost_micros DESC\s+LIMIT 100/);
  const rows = jsonOf<Row[]>(result);
  assert.equal(rows.length, 1, "linha sem parcela (Display na visão SEARCH) é omitida");
  assert.match(textOf(result), /1 linha\(s\) sem parcela/);
  assert.equal(rows[0].parcela_impressoes, "<10%");
  assert.equal(rows[0].perdida_orcamento, ">90%");
  assert.equal(rows[0].diagnostico, "limitada por orçamento");
  assert.equal(rows[0].roas, 4);
});

test("get_impression_share: Display por hora não inventa diagnóstico sem as métricas de perda", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [{ campaign: { id: "1", name: "Display" }, segments: { hour: 10 }, metrics: { contentImpressionShare: 0.4 } }] },
  });
  const [row] = jsonOf<Row[]>(await call(client, "get_impression_share", { network: "DISPLAY", segmentBy: "hour" }));
  assert.doesNotMatch(calls.queries[0], /content_budget_lost|content_rank_lost/);
  assert.equal(row.hour, 10);
  assert.equal(row.parcela_impressoes, "40%");
  assert.equal(row.diagnostico, "perdas não disponíveis com este segmento");
});

test("get_impression_share: limite atingido é avisado (json, table, csv) e a série por data sai em ordem do período", async () => {
  const dates = ["2026-09-03", "2026-09-01", "2026-09-02"];
  const rows = Array.from({ length: 6 }, (_, i) => ({
    campaign: { id: String((i % 2) + 1), name: `C${(i % 2) + 1}`, advertisingChannelType: "SEARCH", status: "ENABLED" },
    segments: { date: dates[i % 3] },
    metrics: { searchImpressionShare: 0.5, impressions: "10", costMicros: String((6 - i) * 1_000_000) },
  }));
  const { client, calls } = fakeClient({ gaql: true, rows: { campaign: rows } });
  const result = await call(client, "get_impression_share", { segmentBy: "date", limit: 4 });
  assert.match(calls.queries[0], /ORDER BY metrics\.cost_micros DESC\s+LIMIT 4/);
  const top = textOf(result).split("\n\n")[0];
  assert.match(top, /Limite de 4 linha\(s\) atingido: a consulta trouxe só as 4 de maior custo — a série por date está incompleta/);
  const out = jsonOf<Row[]>(result);
  assert.deepEqual(out.map((r) => r.date), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-03"], "em ordem do período");
  assert.deepEqual(out.slice(2).map((r) => r.custo), [6, 3], "no mesmo dia continua por custo");

  const table = textOf(await call(client, "get_impression_share", { segmentBy: "date", limit: 4, format: "table" }));
  assert.match(table, /Limite de 4 linha/);
  const csv = textOf(await call(client, "get_impression_share", { segmentBy: "date", limit: 4, format: "csv" }));
  assert.match(csv.split("\n")[0], /^# Limite de 4 linha/);
  assert.match(csv.split("\n")[1], /^campaign_id,campanha/);

  const roomy = await call(client, "get_impression_share", { segmentBy: "date", limit: 10 });
  assert.doesNotMatch(textOf(roomy), /Limite de/);
  const pureCsv = textOf(await call(client, "get_impression_share", { segmentBy: "date", limit: 10, format: "csv" }));
  assert.match(pureCsv, /^campaign_id,/, "sem aviso, o CSV sai puro");

  // Conta sem segmento: uma linha, sem LIMIT, sem aviso.
  const account = fakeClient({ rows: { customer: [{ customer: { descriptiveName: "Loja" }, metrics: { searchImpressionShare: 0.7 } }] } });
  const accountResult = await call(account.client, "get_impression_share", { level: "account", limit: 1 });
  assert.doesNotMatch(account.calls.queries[0], /LIMIT/);
  assert.doesNotMatch(textOf(accountResult), /Limite de/);
});

test("get_impression_share: na visão SEARCH, Display/Vídeo/Demand Gen saem no GAQL e não tomam vagas do LIMIT", async () => {
  const rows = [
    { campaign: { id: "1", name: "Display", advertisingChannelType: "DISPLAY", status: "ENABLED" }, metrics: { impressions: "900", costMicros: "9000000" } },
    { campaign: { id: "2", name: "Busca", advertisingChannelType: "SEARCH", status: "ENABLED" }, metrics: { impressions: "10", costMicros: "1000000", searchImpressionShare: 0.4 } },
  ];
  const { client, calls } = fakeClient({ gaql: true, rows: { campaign: rows } });
  const out = jsonOf<Row[]>(await call(client, "get_impression_share", { limit: 1 }));
  assert.match(calls.queries[0], /campaign\.advertising_channel_type NOT IN \('DISPLAY', 'VIDEO', 'DEMAND_GEN'\)/);
  assert.deepEqual(out.map((r) => r.campanha), ["Busca"]);

  for (const level of ["ad_group", "keyword"]) {
    const other = fakeClient();
    await call(other.client, "get_impression_share", { level });
    assert.match(other.calls.queries[0], /advertising_channel_type NOT IN/, level);
  }
  for (const args of [{ network: "DISPLAY" }, { level: "account" }, { level: "product" }]) {
    const other = fakeClient();
    await call(other.client, "get_impression_share", args);
    assert.doesNotMatch(other.calls.queries[0], /advertising_channel_type NOT IN/, JSON.stringify(args));
  }
});

test("get_impression_share: TARGET_IMPRESSION_SHARE compara com a meta da campanha e da estratégia de portfólio", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "1", name: "Marca", biddingStrategyType: "TARGET_IMPRESSION_SHARE", targetImpressionShare: { location: "TOP_OF_PAGE", locationFractionMicros: "800000" } }, metrics: { searchImpressionShare: 0.9, searchTopImpressionShare: 0.65 } },
        { campaign: { id: "2", name: "Portfólio", biddingStrategyType: "TARGET_IMPRESSION_SHARE", biddingStrategy: `customers/${CID}/biddingStrategies/55` }, metrics: { searchImpressionShare: 0.5, searchAbsoluteTopImpressionShare: 0.3 } },
      ],
      bidding_strategy: [{ biddingStrategy: { resourceName: `customers/${CID}/biddingStrategies/55`, targetImpressionShare: { location: "ABSOLUTE_TOP_OF_PAGE", locationFractionMicros: "200000" } } }],
    },
  });
  const rows = jsonOf<Row[]>(await call(client, "get_impression_share", { level: "campaign" }));
  assert.equal(calls.queries.length, 2, "a meta de portfólio vem de FROM bidding_strategy");
  assert.deepEqual(rows[0].meta_parcela, { local: "TOP_OF_PAGE", meta: "80%", atual: "65%", atingiu: false });
  assert.deepEqual(rows[1].meta_parcela, { local: "ABSOLUTE_TOP_OF_PAGE", meta: "20%", atual: "30%", atingiu: true });
});

test("get_impression_share: combinações sem sentido e datas antigas por dia são recusadas antes da API", async () => {
  const { client, calls } = fakeClient();
  for (const args of [
    { level: "keyword", network: "DISPLAY" },
    { level: "product", segmentBy: "hour" },
    { level: "account", campaignId: "1" },
    { level: "campaign", adGroupId: "1" },
    { level: "campaign", campaignId: "1; DROP" },
    { level: "campaign", limit: 100000 },
    { level: "campaign", segmentBy: "date", dateRange: { since: "2020-01-01", until: "2020-01-31" } },
  ]) {
    const result = await call(client, "get_impression_share", args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
  // Sem segmento diário, o mesmo período antigo (alinhado ao mês) passa.
  await call(client, "get_impression_share", { level: "campaign", dateRange: { since: "2020-01-01", until: "2020-01-31" } });
  assert.equal(calls.queries.length, 1);
});

test("get_campaign_performance / get_ad_group_performance: includeImpressionShare acrescenta a parcela", async () => {
  const plain = fakeClient();
  await call(plain.client, "get_campaign_performance", {});
  assert.doesNotMatch(plain.calls.queries[0], /impression_share/, "sem a flag, a query não muda");

  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "1", name: "Busca" }, metrics: { costMicros: "1000000", impressions: "10", searchImpressionShare: 0.0999, searchBudgetLostImpressionShare: 0.3, searchRankLostImpressionShare: 0.1 } }],
      ad_group: [{ adGroup: { id: "2", name: "G" }, campaign: { id: "1", name: "Busca" }, metrics: { costMicros: "1000000", searchImpressionShare: 0.5, searchRankLostImpressionShare: 0.9001 } }],
    },
  });
  const campaigns = await call(client, "get_campaign_performance", { includeImpressionShare: true });
  assert.match(calls.queries[0], /metrics\.search_budget_lost_impression_share/);
  const body = textOf(campaigns);
  const [row] = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as Row[];
  assert.equal(row.search_impression_share, "<10%");
  assert.equal(row.is_diagnosis, "limitada por orçamento");

  const groups = await call(client, "get_ad_group_performance", { includeImpressionShare: true, campaignId: "1" });
  const groupBody = textOf(groups);
  const [group] = JSON.parse(groupBody.slice(groupBody.indexOf("["), groupBody.lastIndexOf("]") + 1)) as Row[];
  assert.equal(group.lost_is_rank, ">90%");
  assert.equal(group.campaign_id, "1");

  const bad = fakeClient();
  const rejected = await call(bad.client, "get_ad_group_performance", { campaignId: "1 OR 1=1" });
  assert.equal(rejected.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ── get_performance_alerts ────────────────────────────────────────────

test("get_performance_alerts: alerta campanha ativa que não veicula e a limitada pelo orçamento com bom ROAS", async () => {
  const { client, calls } = fakeClient({
    respond: (q) => {
      if (/metrics\.cost_micros > 0/.test(q)) {
        return [{ campaign: { id: "1", name: "Escala" }, metrics: { costMicros: "100000000", conversions: "20", conversionsValue: "600", searchBudgetLostImpressionShare: 0.35 } }];
      }
      return [
        { campaign: { id: "1", name: "Escala", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] } },
        { campaign: { id: "2", name: "Reprovada", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["HAS_ADS_DISAPPROVED"] } },
        { campaign: { id: "3", name: "Muda", primaryStatus: "ELIGIBLE", primaryStatusReasons: [] } },
        { campaign: { id: "4", name: "Futura", primaryStatus: "PENDING", primaryStatusReasons: ["CAMPAIGN_PENDING"] } },
      ];
    },
  });
  const result = await call(client, "get_performance_alerts", { days: 7 });
  assert.equal(calls.queries.length, 2);
  const alerts = JSON.parse(textOf(result).slice(textOf(result).indexOf("["))) as Row[];
  const titles = alerts.map((a) => String(a.title));
  assert.ok(titles.some((t) => /Escala — limitada pelo orçamento com bom retorno/.test(t)));
  assert.ok(titles.some((t) => /Reprovada — ativa, mas não veicula \(NOT_ELIGIBLE\)/.test(t)));
  assert.ok(titles.some((t) => /Muda — ativa e sem gasto/.test(t)));
  assert.ok(!titles.some((t) => /Futura/.test(t)), "campanha que ainda não começou não é alerta");
  assert.match(String(alerts.find((a) => /Reprovada/.test(String(a.title)))!.text), /anúncios reprovados/);
});

// ── list_policy_issues ────────────────────────────────────────────────

const destinationDown = {
  topic: "DESTINATION_NOT_WORKING",
  type: "PROHIBITED",
  evidences: [{ destinationNotWorking: { expandedUrl: "https://loja.com.br/x", device: "ANDROID", httpErrorCode: "404", lastCheckedDateTime: "2026-09-20 10:00:00" } }],
  constraints: [{ countryConstraintList: { totalTargetedCountries: 1, countries: [{ countryCriterion: "geoTargetConstants/2076" }] } }],
};

test("list_policy_issues: anúncios, assets (4 vínculos) e palavras-chave com tópico, evidência e sugestão", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group_ad: [{
        adGroupAd: { status: "ENABLED", ad: { id: "20", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://loja.com.br/x"] }, policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED", policyTopicEntries: [destinationDown] } },
        adGroup: { id: "10", name: "G" }, campaign: { id: "1", name: "Busca" },
      }],
      campaign_asset: [{ campaignAsset: { fieldType: "SITELINK", status: "ENABLED", primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["ASSET_DISAPPROVED"] }, campaign: { id: "1", name: "Busca" }, asset: { id: "70", type: "SITELINK", policySummary: { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED", evidences: [{ textList: { texts: ["Nike"] } }] }] } } }],
      ad_group_asset: [],
      customer_asset: [{ customerAsset: { fieldType: "CALLOUT", status: "ENABLED" }, asset: { id: "71", type: "CALLOUT", policySummary: { approvalStatus: "APPROVED_LIMITED", policyTopicEntries: [] } } }],
      asset_group_asset: [{ assetGroupAsset: { fieldType: "HEADLINE", status: "ENABLED", policySummary: { approvalStatus: "DISAPPROVED", policyTopicEntries: [{ topic: "CAPITALIZATION", type: "PROHIBITED" }] } }, assetGroup: { id: "40", name: "AG" }, campaign: { id: "2", name: "PMax" }, asset: { id: "72", type: "TEXT" } }],
      ad_group_criterion: [{ adGroupCriterion: { criterionId: "30", keyword: { text: "remédio", matchType: "BROAD" }, status: "ENABLED", approvalStatus: "DISAPPROVED", disapprovalReasons: ["Unapproved pharmaceuticals"] }, adGroup: { id: "10", name: "G" }, campaign: { id: "1", name: "Busca" } }],
    },
  });
  const result = await call(client, "list_policy_issues", {});
  assert.deepEqual(calls.queries.map((q) => parseGaql(q).from), ["ad_group_ad", "campaign_asset", "ad_group_asset", "customer_asset", "asset_group_asset", "ad_group_criterion"]);
  const out = jsonOf<{ resumo: Row; itens: Row[] }>(result);
  assert.deepEqual(out.resumo, { anuncios: 1, assets: 3, palavras_chave: 1 });
  const ad = out.itens[0];
  const topic = (ad.topicos as Row[])[0];
  assert.equal(topic.efeito, "não veicula");
  assert.match(String((topic.evidencias as string[])[0]), /HTTP 404 no ANDROID/);
  assert.match(String((topic.restricoes as string[])[0]), /geoTargetConstants\/2076/);
  assert.match(String(topic.sugestao), /página de destino/);
  const trademark = out.itens.find((i) => i.nivel === "campanha")!;
  assert.match(String(((trademark.topicos as Row[])[0]).sugestao), /request_ad_policy_exemption/);
  assert.match(String(((trademark.topicos as Row[])[0].evidencias as string[])[0]), /"Nike"/);
  const keyword = out.itens.find((i) => i.tipo === "palavra-chave")!;
  assert.deepEqual(keyword.motivos_reprovacao, ["Unapproved pharmaceuticals"]);
});

test("list_policy_issues: consulta que enche o limite é avisada no cabeçalho, no resumo e no csv", async () => {
  const ad = (id: string) => ({
    adGroupAd: { status: "ENABLED", ad: { id, type: "RESPONSIVE_SEARCH_AD" }, policySummary: { approvalStatus: "DISAPPROVED", policyTopicEntries: [] } },
    adGroup: { id: "10", name: "G" }, campaign: { id: "1", name: "Busca" },
  });
  const keyword = { adGroupCriterion: { criterionId: "30", keyword: { text: "x", matchType: "BROAD" }, approvalStatus: "DISAPPROVED" }, adGroup: { id: "10" }, campaign: { id: "1" } };
  const { client } = fakeClient({ rows: { ad_group_ad: [ad("1"), ad("2")], ad_group_criterion: [keyword, keyword] } });
  const full = await call(client, "list_policy_issues", { limit: 2 });
  assert.match(textOf(full).split("\n\n")[0], /Limite de 2 linha\(s\) por consulta atingido em: anúncios, palavras-chave — pode haver mais itens/);
  assert.deepEqual(jsonOf<{ resumo: Row }>(full).resumo.limite_atingido_em, ["anúncios", "palavras-chave"]);

  const roomy = await call(client, "list_policy_issues", { limit: 3 });
  assert.doesNotMatch(textOf(roomy), /Limite de/);
  assert.equal(jsonOf<{ resumo: Row }>(roomy).resumo.limite_atingido_em, undefined);

  const csv = textOf(await call(client, "list_policy_issues", { limit: 2, format: "csv" })).split("\n");
  assert.match(csv[0], /^# Limite de 2 linha/);
  assert.match(csv[1], /^tipo,nivel,id/);
});

test("list_policy_issues: filtros de status/escopo/campanha e validação antes da API", async () => {
  const { client, calls } = fakeClient();
  await call(client, "list_policy_issues", { scope: "keywords", statuses: ["APPROVED_LIMITED"] });
  assert.equal(calls.queries.length, 0, "palavra-chave só tem DISAPPROVED: nada a consultar");

  await call(client, "list_policy_issues", { scope: "assets", campaignId: "9", statuses: "[\"DISAPPROVED\"]" });
  assert.match(calls.queries[0], new RegExp(`campaign_asset\\.campaign = 'customers/${CID}/campaigns/9'`));
  assert.match(calls.queries[0], /IN \('DISAPPROVED'\)/);
  assert.match(calls.queries[1], /campaign\.id = 9/);
  assert.doesNotMatch(calls.queries[2], /campaign/, "assets da conta valem para todas as campanhas");

  const before = calls.queries.length;
  for (const args of [
    { statuses: "[\"DISAPPROVED') OR ('1'='1\"]" },
    { statuses: [] },
    { campaignId: "x" },
    { limit: 5000 },
  ]) {
    assert.equal((await call(client, "list_policy_issues", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, before);
});

// ── Erros estruturados ────────────────────────────────────────────────

const violationFailure = (policies: Array<{ name: string; text?: string; exemptible: boolean }>) => ({
  code: 3,
  message: "Multiple errors in 'details'.",
  details: [{
    "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
    errors: policies.map((p) => ({
      errorCode: { policyViolationError: "POLICY_ERROR" },
      message: "A policy was violated. See PolicyViolationDetails for more detail.",
      trigger: { stringValue: p.text ?? "" },
      location: { fieldPathElements: [{ fieldName: "operations", index: 0 }, { fieldName: "create" }, { fieldName: "keyword" }, { fieldName: "text" }] },
      details: { policyViolationDetails: { externalPolicyName: `Política ${p.name}`, externalPolicyDescription: "desc", key: { policyName: p.name, violatingText: p.text }, isExemptible: p.exemptible } },
    })),
    requestId: "abc",
  }],
});

test("parseAdsFailure: guarda código, gatilho, caminho, violação e achados que o client descartaria", () => {
  const [error] = parseAdsFailure(violationFailure([{ name: "PHARMA", text: "remédio", exemptible: true }]));
  assert.deepEqual(error.codes, ["policyViolationError.POLICY_ERROR"]);
  assert.equal(error.trigger, "remédio");
  assert.equal(error.fieldPath, "operations[0].create.keyword.text");
  assert.equal(error.operationIndex, 0);
  assert.deepEqual(error.violation, { policyName: "PHARMA", violatingText: "remédio", externalPolicyName: "Política PHARMA", description: "desc", isExemptible: true });
  const [finding] = parseAdsFailure({ details: [{ errors: [{ errorCode: { policyFindingError: "POLICY_FINDING" }, message: "m", details: { policyFindingDetails: { policyTopicEntries: [destinationDown] } } }] }] });
  assert.equal(finding.findings!.length, 1);
  assert.deepEqual(parseAdsFailure(undefined), []);
  assert.deepEqual(parseAdsFailure({}), []);
});

// ── request_keyword_policy_exemption ──────────────────────────────────

const adGroupRow = { adGroup: { id: "10", name: "G", status: "ENABLED" }, campaign: { id: "1", name: "Busca", status: "ENABLED" } };

function keywordClient(opts: { violations?: Array<{ name: string; text?: string; exemptible: boolean }>; existing?: Row[]; dryRun?: boolean; other?: boolean; throws?: string; realFailure?: boolean } = {}) {
  return fakeClient({
    dryRun: opts.dryRun,
    mutateThrows: opts.throws,
    respond: (q) => {
      const from = parseGaql(q).from;
      if (from === "ad_group") return [adGroupRow];
      if (from === "ad_group_criterion") return opts.existing ?? [];
      return undefined;
    },
    mutate: (_resource, operations, validateOnly) => {
      if (validateOnly && opts.other) {
        return { partialFailureError: { details: [{ errors: [{ errorCode: { adGroupCriterionError: "INVALID_KEYWORD_TEXT" }, message: "Keyword text is invalid." }] }] } };
      }
      const exempted = Boolean((operations[0] as Row).exemptPolicyViolationKeys);
      if (opts.violations?.length && !exempted) return { partialFailureError: violationFailure(opts.violations), results: [{}] };
      if (opts.realFailure && !validateOnly) return { partialFailureError: violationFailure([{ name: "X", exemptible: false }]) };
      return validateOnly ? {} : { results: [{ resourceName: `customers/${CID}/adGroupCriteria/10~555` }] };
    },
  });
}

const kwArgs = { adGroupId: "10", keyword: "comprar  remédio", matchType: "PHRASE" };

test("exceção de palavra-chave: sem confirm só valida (validate_only) e lista as políticas — nada gravado", async () => {
  const { client, calls } = keywordClient({ violations: [{ name: "PHARMA", text: "remédio", exemptible: true }] });
  const result = await call(client, "request_keyword_policy_exemption", kwArgs);
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].validateOnly, true, "a validação prévia é validate_only");
  assert.deepEqual(calls.writes[0].options, { partialFailure: true }, "partialFailure devolve os detalhes estruturados");
  assert.equal(realWrites(calls).length, 0);
  const create = (calls.writes[0].operations[0] as Row).create as Row;
  assert.deepEqual(create.keyword, { text: "comprar remédio", matchType: "PHRASE" });
  assert.match(textOf(result), /exemptPolicies: \["PHARMA"\]/);
  assert.match(calls.queries[1], /ad_group_criterion\.keyword\.text = 'comprar remédio'/);
});

test("exceção de palavra-chave: confirm + todas as políticas cria com as chaves devolvidas pela API", async () => {
  const { client, calls } = keywordClient({ violations: [{ name: "PHARMA", text: "remédio", exemptible: true }, { name: "HEALTH", exemptible: true }] });
  const partial = await call(client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true, exemptPolicies: ["pharma"] });
  assert.match(textOf(partial), /faltou confirmar: HEALTH/);
  assert.equal(realWrites(calls).length, 0, "confirmar só parte das políticas não grava");

  const result = await call(client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true, exemptPolicies: "[\"PHARMA\",\"HEALTH\"]" });
  const [write] = realWrites(calls);
  assert.ok(write, textOf(result));
  assert.equal(write.resource, "adGroupCriteria");
  assert.deepEqual((write.operations[0] as Row).exemptPolicyViolationKeys, [
    { policyName: "PHARMA", violatingText: "remédio" },
    { policyName: "HEALTH" },
  ]);
  assert.match(textOf(result), /criada no grupo 10 com pedido de exceção/);
  assert.match(textOf(result), /10~555/);
});

test("exceção de palavra-chave: não-isenta, sem violação, erro comum, duplicada e falha na gravação", async () => {
  const hard = keywordClient({ violations: [{ name: "WEAPONS", exemptible: false }] });
  const refused = await call(hard.client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true, exemptPolicies: ["WEAPONS"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /não admite exceção/);
  assert.equal(realWrites(hard.calls).length, 0);

  const clean = keywordClient();
  const none = await call(clean.client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true });
  assert.match(textOf(none), /Nenhuma violação.*create_keyword/s);
  assert.equal(realWrites(clean.calls).length, 0);

  const other = keywordClient({ other: true });
  const invalid = await call(other.client, "request_keyword_policy_exemption", kwArgs);
  assert.equal(invalid.isError, true);
  assert.match(textOf(invalid), /INVALID_KEYWORD_TEXT/);

  const dup = keywordClient({ existing: [{ adGroupCriterion: { criterionId: "9", keyword: { text: "Comprar Remédio" }, status: "PAUSED" } }] });
  const noop = await call(dup.client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true });
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(dup.calls.writes.length, 0, "duplicada: nem validação");

  const thrown = keywordClient({ throws: "Google Ads API: Request contains an invalid argument." });
  const failed = await call(thrown.client, "request_keyword_policy_exemption", kwArgs);
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /não devolveu os detalhes/);

  const late = keywordClient({ violations: [{ name: "PHARMA", exemptible: true }], realFailure: true });
  const rejected = await call(late.client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true, exemptPolicies: ["PHARMA"] });
  assert.equal(rejected.isError, true, "falha na gravação não vira sucesso");
});

test("exceção de palavra-chave: validação de entrada antes de qualquer chamada", async () => {
  const { client, calls } = keywordClient();
  for (const args of [
    { ...kwArgs, adGroupId: "10 OR 1=1" },
    { ...kwArgs, keyword: "   " },
    { ...kwArgs, keyword: "a".repeat(81) },
    { ...kwArgs, keyword: "um dois três quatro cinco seis sete oito nove dez onze" },
    { ...kwArgs, cpcBidMicros: 10_000 },
    { ...kwArgs, cpcBidMicros: 1.5 },
  ]) {
    assert.equal((await call(client, "request_keyword_policy_exemption", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length + calls.writes.length, 0);
  const missing = fakeClient();
  const notFound = await call(missing.client, "request_keyword_policy_exemption", kwArgs);
  assert.match(textOf(notFound), /não encontrado/);
  assert.equal(missing.calls.writes.length, 0);
});

test("exceção de palavra-chave: validateOnly roda tudo em validate_only e não diz que gravou", async () => {
  const { client, calls } = keywordClient({ violations: [{ name: "PHARMA", exemptible: true }] });
  const result = await call(client, "request_keyword_policy_exemption", { ...kwArgs, confirm: true, exemptPolicies: ["PHARMA"], validateOnly: true });
  assert.equal(realWrites(calls).length, 0);
  assert.equal(calls.writes.length, 2);
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /nada foi gravado/);
});

// ── request_ad_policy_exemption ───────────────────────────────────────

const findingFailure = (topics: string[]) => ({
  details: [{
    errors: [{
      errorCode: { policyFindingError: "POLICY_FINDING" },
      message: "The resource has been disapproved since the policy summary includes policy topics of type PROHIBITED.",
      trigger: { stringValue: "Nike" },
      location: { fieldPathElements: [{ fieldName: "operations", index: 0 }] },
      details: { policyFindingDetails: { policyTopicEntries: topics.map((topic) => ({ topic, type: "PROHIBITED", evidences: [{ textList: { texts: ["Nike"] } }] })) } },
    }],
  }],
});

function adClient(opts: { topics?: string[]; current?: Row; other?: boolean } = {}) {
  return fakeClient({
    respond: (q) => {
      const from = parseGaql(q).from;
      if (from === "ad_group") return [adGroupRow];
      if (from === "ad_group_ad") return opts.current ? [opts.current] : [];
      return undefined;
    },
    mutate: (_resource, operations, validateOnly) => {
      if (validateOnly && opts.other) {
        return { partialFailureError: { details: [{ errors: [{ errorCode: { adError: "TOO_LONG" }, message: "Too long." }] }] } };
      }
      const exempted = Boolean((operations[0] as Row).policyValidationParameter);
      if (opts.topics?.length && !exempted) return { partialFailureError: findingFailure(opts.topics), results: [{}] };
      return validateOnly ? {} : { results: [{ resourceName: `customers/${CID}/adGroupAds/10~777` }] };
    },
  });
}

const rsaArgs = {
  adGroupId: "10",
  finalUrl: "https://loja.com.br/nike",
  headlines: ["Tênis Nike Original", "Frete Grátis", "Revendedor Autorizado"],
  descriptions: ["Compre tênis Nike com garantia.", "Parcelamos em 10x."],
};

test("exceção de anúncio: cria RSA pausado com ignorable_policy_topics só depois da confirmação", async () => {
  const { client, calls } = adClient({ topics: ["TRADEMARKS_IN_AD_TEXT"] });
  const preview = await call(client, "request_ad_policy_exemption", rsaArgs);
  assert.equal(realWrites(calls).length, 0);
  assert.equal(calls.writes[0].resource, "adGroupAds");
  assert.match(textOf(preview), /ignorablePolicyTopics: \["TRADEMARKS_IN_AD_TEXT"\]/);
  assert.match(textOf(preview), /gatilho/);

  const result = await call(client, "request_ad_policy_exemption", { ...rsaArgs, confirm: true, ignorablePolicyTopics: ["trademarks_in_ad_text"] });
  const [write] = realWrites(calls);
  assert.ok(write, textOf(result));
  const op = write.operations[0] as Row;
  assert.deepEqual(op.policyValidationParameter, { ignorablePolicyTopics: ["TRADEMARKS_IN_AD_TEXT"] });
  assert.equal((op.create as Row).status, "PAUSED");
  assert.match(textOf(result), /RSA criado \(PAUSED\)/);
});

test("exceção de anúncio: edição lê o RSA, mantém pins, manda só as folhas alteradas e pula no-op", async () => {
  const current = {
    adGroupAd: {
      status: "ENABLED",
      ad: {
        id: "77", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://loja.com.br/nike"],
        responsiveSearchAd: {
          headlines: [{ text: "Tênis Nike Original", pinnedField: "HEADLINE_1" }, { text: "Frete Grátis" }, { text: "Loja" }],
          descriptions: [{ text: "Compre tênis Nike com garantia." }, { text: "Parcelamos em 10x." }],
          path1: "nike",
        },
      },
    },
    adGroup: { id: "10" },
  };
  const { client, calls } = adClient({ topics: ["TRADEMARKS_IN_AD_TEXT"], current });
  const result = await call(client, "request_ad_policy_exemption", {
    adId: "77", headlines: rsaArgs.headlines, confirm: true, ignorablePolicyTopics: ["TRADEMARKS_IN_AD_TEXT"],
  });
  const [write] = realWrites(calls);
  assert.ok(write, textOf(result));
  assert.equal(write.resource, "ads");
  const op = write.operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "responsive_search_ad.headlines");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual((op.update.responsiveSearchAd as Row).headlines, [
    { text: "Tênis Nike Original", pinnedField: "HEADLINE_1" },
    { text: "Frete Grátis" },
    { text: "Revendedor Autorizado" },
  ]);
  assert.equal(op.update.resourceName, `customers/${CID}/ads/77`);

  const same = adClient({ current });
  const noop = await call(same.client, "request_ad_policy_exemption", { adId: "77", finalUrl: "https://loja.com.br/nike", path1: "nike" });
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(same.calls.writes.length, 0);

  const display = adClient({ current: { adGroupAd: { ad: { id: "77", type: "RESPONSIVE_DISPLAY_AD" } } } });
  const wrongType = await call(display.client, "request_ad_policy_exemption", { adId: "77", finalUrl: "https://x.com" });
  assert.equal(wrongType.isError, true);
  assert.equal(display.calls.writes.length, 0);
});

test("exceção de anúncio: erro que não é achado de política para; validação antes da API", async () => {
  const other = adClient({ other: true });
  const stopped = await call(other.client, "request_ad_policy_exemption", { ...rsaArgs, confirm: true, ignorablePolicyTopics: ["X"] });
  assert.equal(stopped.isError, true);
  assert.match(textOf(stopped), /adError\.TOO_LONG/);
  assert.equal(realWrites(other.calls).length, 0);

  const clean = adClient();
  const none = await call(clean.client, "request_ad_policy_exemption", rsaArgs);
  assert.match(textOf(none), /Nenhum achado.*create_ad/s);
  assert.equal(realWrites(clean.calls).length, 0);

  const { client, calls } = adClient();
  for (const args of [
    {},
    { adId: "7a" },
    { adId: "77" },
    { ...rsaArgs, headlines: ["só dois", "títulos"] },
    { ...rsaArgs, headlines: [...rsaArgs.headlines, "x".repeat(31)] },
    { ...rsaArgs, descriptions: ["uma"] },
    { ...rsaArgs, finalUrl: "javascript:alert(1)" },
    { ...rsaArgs, path1: "caminho-longo-demais" },
    { adGroupId: "10", headlines: rsaArgs.headlines },
  ]) {
    assert.equal((await call(client, "request_ad_policy_exemption", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length + calls.writes.length, 0);
});
