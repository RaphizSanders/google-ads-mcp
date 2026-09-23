/**
 * Lote budgets — orçamentos, ritmo de gasto e grupos de campanhas.
 *
 * Cobre update_budget (compartilhado, CUSTOM_PERIOD, makeShared, no-op, aumento grande),
 * list_budgets, get_budget_pacing (funções puras + handler), create_shared_budget,
 * assign_budget, remove_budget e as tools de grupo de campanhas. O client falso valida
 * toda query contra os metadados reais da v25 (assertGaqlRules) e filtra os dados pelo
 * WHERE, para que um filtro errado apareça como resultado errado.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { catalog } from "../src/tools/budgets.catalog.js";
import {
  explainBudgetError,
  paceDailyBudget,
  paceTotalBudget,
  parseResourceRef,
  todayInTimeZone,
} from "../src/tools/budgets.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";
import { toolImplementations } from "./tool-sources.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";
const TZ = "America/Sao_Paulo";
const bRN = (id: string) => `customers/${CID}/campaignBudgets/${id}`;
const cRN = (id: string) => `customers/${CID}/campaigns/${id}`;
const gRN = (id: string) => `customers/${CID}/campaignGroups/${id}`;

// ── Dados ─────────────────────────────────────────────────────────────

interface BudgetSeed {
  id: string;
  name: string;
  status?: string;
  period?: string;
  amountMicros?: number;
  totalAmountMicros?: number;
  explicitlyShared?: boolean;
  referenceCount?: number;
  type?: string;
  hasRecommendedBudget?: boolean;
  recommendedBudgetAmountMicros?: number;
  alignedBiddingStrategyId?: string;
}

interface CampaignSeed {
  id: string;
  name: string;
  status: string;
  budget: string;
  group?: string;
  experimentType?: string;
  biddingStrategy?: string;
  startDateTime?: string;
  endDateTime?: string;
  primaryStatusReasons?: string[];
}

interface Data {
  budgets: BudgetSeed[];
  campaigns: CampaignSeed[];
  groups: Array<{ id: string; name: string; status: string }>;
  experimentArms: Array<{ campaigns: string[]; inDesignCampaigns?: string[]; experiment: string; status: string }>;
  budgetSpend: Array<{ budgetId: string; date: string; costMicros: number }>;
  campaignMetrics: Array<{ campaignId: string; date?: string; metrics: Row }>;
}

function baseData(): Data {
  return {
    budgets: [
      { id: "111", name: "Marca compartilhado", amountMicros: 100_000_000, explicitlyShared: true, referenceCount: 2, hasRecommendedBudget: true, recommendedBudgetAmountMicros: 150_000_000 },
      { id: "222", name: "Budget — Genérica", amountMicros: 50_000_000, referenceCount: 1 },
      { id: "333", name: "Total Black Friday", period: "CUSTOM_PERIOD", totalAmountMicros: 3_000_000_000, referenceCount: 1 },
      { id: "444", name: "Órfão", amountMicros: 20_000_000, referenceCount: 0 },
      { id: "446", name: "Budget — Institucional", amountMicros: 30_000_000, referenceCount: 1 },
      { id: "555", name: "Removido", status: "REMOVED", amountMicros: 10_000_000, referenceCount: 0 },
    ],
    campaigns: [
      { id: "1", name: "Marca Search", status: "ENABLED", budget: "111", primaryStatusReasons: ["BUDGET_CONSTRAINED"] },
      { id: "2", name: "Marca PMax", status: "PAUSED", budget: "111" },
      { id: "3", name: "Genérica", status: "ENABLED", budget: "222" },
      { id: "4", name: "Black Friday", status: "ENABLED", budget: "333", startDateTime: "2026-08-01 00:00:00", endDateTime: "2026-08-31 23:59:59" },
      { id: "5", name: "Institucional", status: "ENABLED", budget: "446" },
    ],
    groups: [
      { id: "900", name: "Linha Tênis", status: "ENABLED" },
      { id: "901", name: "Vazio", status: "ENABLED" },
    ],
    experimentArms: [],
    budgetSpend: [],
    campaignMetrics: [],
  };
}

function budgetRow(b: BudgetSeed): Row {
  return {
    resourceName: bRN(b.id),
    id: b.id,
    name: b.name,
    status: b.status ?? "ENABLED",
    period: b.period ?? "DAILY",
    ...(b.amountMicros !== undefined ? { amountMicros: String(b.amountMicros) } : {}),
    ...(b.totalAmountMicros !== undefined ? { totalAmountMicros: String(b.totalAmountMicros) } : {}),
    explicitlyShared: b.explicitlyShared ?? false,
    referenceCount: String(b.referenceCount ?? 0),
    deliveryMethod: "STANDARD",
    type: b.type ?? "STANDARD",
    hasRecommendedBudget: b.hasRecommendedBudget ?? false,
    ...(b.recommendedBudgetAmountMicros !== undefined ? {
      recommendedBudgetAmountMicros: String(b.recommendedBudgetAmountMicros),
      recommendedBudgetEstimatedChangeWeeklyClicks: "120",
      recommendedBudgetEstimatedChangeWeeklyCostMicros: "350000000",
    } : {}),
    ...(b.alignedBiddingStrategyId ? { alignedBiddingStrategyId: b.alignedBiddingStrategyId } : {}),
  };
}

// ── Mini avaliador de WHERE (só as formas que as tools usam) ─────────

function conditions(query: string): string[] {
  const q = query.replace(/\s+/g, " ");
  const where = /\bWHERE (.*?)(?: ORDER BY | LIMIT |$)/.exec(q);
  return where ? where[1].replace(/BETWEEN '([^']*)' AND '([^']*)'/g, "BETWEEN $1..$2").split(" AND ") : [];
}

const literal = (v: string) => v.trim().replace(/^'(.*)'$/, "$1").replace(/\\'/g, "'");

function matches(query: string, flat: Record<string, unknown>): boolean {
  return conditions(query).every((cond) => {
    let m = /^([a-z_.]+) IN \((.*)\)$/.exec(cond);
    if (m) {
      if (!(m[1] in flat)) return true;
      return m[2].split(",").map(literal).includes(String(flat[m[1]]));
    }
    m = /^([a-z_.]+) BETWEEN (\S+)\.\.(\S+)$/.exec(cond);
    if (m) {
      if (!(m[1] in flat)) return true;
      const v = String(flat[m[1]]);
      return v >= m[2] && v <= m[3];
    }
    m = /^([a-z_.]+) (=|!=) (.*)$/.exec(cond);
    if (m) {
      if (!(m[1] in flat)) return true;
      const eq = String(flat[m[1]]) === literal(m[3]);
      return m[2] === "=" ? eq : !eq;
    }
    return true;
  });
}

function answer(data: Data, query: string): Row[] {
  const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
  const budgetById = (id: string) => data.budgets.find((b) => b.id === id);
  const budgetFlat = (b: BudgetSeed) => ({
    "campaign_budget.id": b.id,
    "campaign_budget.name": b.name,
    "campaign_budget.status": b.status ?? "ENABLED",
    "campaign_budget.explicitly_shared": String(b.explicitlyShared ?? false),
  });
  if (from === "campaign_budget") {
    if (/metrics\.cost_micros/.test(query)) {
      return data.budgetSpend
        .map((s) => ({ s, b: budgetById(s.budgetId)! }))
        .filter(({ s, b }) => matches(query, { ...budgetFlat(b), "segments.date": s.date }))
        .map(({ s, b }) => ({ campaignBudget: budgetRow(b), segments: { date: s.date }, metrics: { costMicros: String(s.costMicros) } }));
    }
    return data.budgets.filter((b) => matches(query, budgetFlat(b))).map((b) => ({ campaignBudget: budgetRow(b) }));
  }
  if (from === "campaign") {
    const campaignFlat = (c: CampaignSeed) => ({
      "campaign.id": c.id,
      "campaign.status": c.status,
      "campaign.campaign_budget": bRN(c.budget),
      "campaign.campaign_group": c.group ? gRN(c.group) : "",
    });
    const campaignRow = (c: CampaignSeed): Row => ({
      campaign: {
        resourceName: cRN(c.id), id: c.id, name: c.name, status: c.status, campaignBudget: bRN(c.budget),
        ...(c.group ? { campaignGroup: gRN(c.group) } : {}),
        experimentType: c.experimentType ?? "BASE",
        biddingStrategyType: "MAXIMIZE_CONVERSIONS",
        ...(c.biddingStrategy ? { biddingStrategy: c.biddingStrategy } : {}),
        advertisingChannelType: "SEARCH",
        primaryStatus: c.status === "ENABLED" ? "ELIGIBLE" : "PAUSED",
        primaryStatusReasons: c.primaryStatusReasons ?? [],
        ...(c.startDateTime ? { startDateTime: c.startDateTime } : {}),
        ...(c.endDateTime ? { endDateTime: c.endDateTime } : {}),
      },
      ...(budgetById(c.budget) ? { campaignBudget: budgetRow(budgetById(c.budget)!) } : {}),
    });
    if (/metrics\./.test(query)) {
      return data.campaignMetrics
        .map((m) => ({ m, c: data.campaigns.find((c) => c.id === m.campaignId)! }))
        .filter(({ m, c }) => matches(query, { ...campaignFlat(c), ...(m.date ? { "segments.date": m.date } : {}) }))
        .map(({ m, c }) => ({ ...campaignRow(c), metrics: m.metrics }));
    }
    return data.campaigns.filter((c) => matches(query, campaignFlat(c))).map(campaignRow);
  }
  if (from === "campaign_group") {
    return data.groups
      .filter((g) => matches(query, { "campaign_group.id": g.id, "campaign_group.name": g.name, "campaign_group.status": g.status }))
      .map((g) => ({ campaignGroup: { resourceName: gRN(g.id), id: g.id, name: g.name, status: g.status } }));
  }
  if (from === "experiment_arm") {
    return data.experimentArms
      .filter((arm) => matches(query, { "experiment.status": arm.status }))
      .map((arm) => ({
        experimentArm: { campaigns: arm.campaigns, ...(arm.inDesignCampaigns ? { inDesignCampaigns: arm.inDesignCampaigns } : {}) },
        experiment: { name: arm.experiment, status: arm.status },
      }));
  }
  throw new Error(`FROM ${from} sem dados no fake`);
}

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  data?: Data;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
  batchMutate?: (operations: Row[]) => Row;
  budgetMutate?: (operations: Row[]) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const data = opts.data ?? baseData();
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
    async getCustomer() {
      return { customer: { id: CID, timeZone: TZ, currencyCode: "BRL" } };
    },
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      return answer(data, query);
    },
    async mutateCampaignBudgets(_customerId: string, operations: Row[]): Promise<Row> {
      record("mutateCampaignBudgets", operations);
      if (opts.budgetMutate) return opts.budgetMutate(operations);
      return dryRun ? {} : { results: operations.map(() => ({ resourceName: bRN("777") })) };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      record(`mutate:${resource}`, operations, options);
      if (opts.mutate) return opts.mutate(resource, operations, options);
      return dryRun ? {} : { results: operations.map((op) => ({ resourceName: String(op.remove ?? obj(op.update).resourceName ?? `customers/${CID}/${resource}/888`) })) };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      record("batchMutate", operations);
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op) =>
          op.campaignBudgetOperation ? { campaignBudgetResult: { resourceName: bRN("777") } }
            : op.campaignGroupOperation ? { campaignGroupResult: { resourceName: gRN("999") } }
              : { campaignResult: { resourceName: String(obj(obj(op.campaignOperation).update).resourceName) } }
        ),
      };
    },
  });
  return { client: build(opts.dryRun ?? false), calls, data };
}

const obj = (v: unknown): Row => (v && typeof v === "object" ? (v as Row) : {});

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

const call = (client: unknown, tool: string, args: Row) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}
function onlyWrite(calls: { writes: Array<{ method: string; operations: Row[]; options?: Row }> }, method: string) {
  const writes = calls.writes.filter((w) => w.method === method);
  assert.equal(writes.length, 1, `exatamente uma escrita em ${method} (houve ${calls.writes.map((w) => w.method).join(", ") || "nenhuma"})`);
  for (const op of writes[0].operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
  return writes[0];
}

const isoShift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ── Catálogo ──────────────────────────────────────────────────────────

test("catálogo: tools novas classificadas, nenhuma encadeada, update_budget segue write", () => {
  for (const name of catalog.read) assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), name);
  for (const name of catalog.write) assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), name);
  assert.deepEqual(catalog.chained, []);
  assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has("update_budget"));
  const slices = toolImplementations();
  for (const name of [...catalog.read, ...catalog.write, "update_budget"]) {
    assert.match(slices.get(name) ?? "", /checkCustomerAccess\(/, `${name} sem guarda de conta`);
  }
});

// ── update_budget ─────────────────────────────────────────────────────

test("update_budget: descrição não cita tool inexistente e aceita campaignId", () => {
  const { client } = fakeClient();
  const config = register(client).configs.get("update_budget")!;
  assert.doesNotMatch(String(config.description), /google_run_gaql/);
  const shape = config.inputSchema as Row;
  for (const key of ["campaignId", "totalAmountMicros", "confirmShared", "makeShared", "validateOnly"]) assert.ok(key in shape, key);
});

test("update_budget: orçamento individual pela campanha grava só amount_micros", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "update_budget", { campaignId: "3", amountMicros: 60_000_000 });
  assert.ok(!result.isError, textOf(result));
  const write = onlyWrite(calls, "mutateCampaignBudgets");
  assert.deepEqual(write.operations[0], {
    update: { resourceName: bRN("222"), amountMicros: "60000000" },
    updateMask: "amount_micros",
  });
  const body = jsonOf(result);
  assert.deepEqual(body.changes, [{ setting: "daily_amount", before: 50, after: 60 }]);
  assert.match(calls.queries[0], /campaign\.id = 3/);
});

test("update_budget: compartilhado por 2 campanhas exige confirmShared e lista as afetadas", async () => {
  const { client, calls } = fakeClient();
  const refused = await call(client, "update_budget", { budgetResourceName: bRN("111"), amountMicros: 120_000_000 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /COMPARTILHADO por 2 campanhas/);
  assert.match(textOf(refused), /Marca Search/);
  assert.match(textOf(refused), /Marca PMax/);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "update_budget", { budgetResourceName: "111", amountMicros: 120_000_000, confirmShared: true });
  assert.ok(!ok.isError, textOf(ok));
  onlyWrite(calls, "mutateCampaignBudgets");
  assert.equal((jsonOf(ok).affected_campaigns as Row[]).length, 2);
});

test("update_budget: CUSTOM_PERIOD recusa amountMicros e grava total_amount_micros", async () => {
  const { client, calls } = fakeClient();
  const refused = await call(client, "update_budget", { campaignId: "4", amountMicros: 100_000_000 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /TOTAL da campanha/);
  assert.match(textOf(refused), /totalAmountMicros/);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "update_budget", { campaignId: "4", totalAmountMicros: 4_000_000_000 });
  assert.ok(!ok.isError, textOf(ok));
  const write = onlyWrite(calls, "mutateCampaignBudgets");
  assert.deepEqual(write.operations[0], {
    update: { resourceName: bRN("333"), totalAmountMicros: "4000000000" },
    updateMask: "total_amount_micros",
  });
});

test("update_budget: orçamento diário recusa totalAmountMicros", async () => {
  const { client, calls } = fakeClient();
  const refused = await call(client, "update_budget", { budgetResourceName: "222", totalAmountMicros: 1_000_000_000 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /DIÁRIO/);
  assert.equal(calls.writes.length, 0);
});

test("update_budget: mesmo valor não grava nada", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "update_budget", { budgetResourceName: "222", amountMicros: 50_000_000 });
  assert.ok(!result.isError);
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(calls.writes.length, 0);
});

test("update_budget: entradas inválidas são recusadas antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ amountMicros: 1_000_000 }, /exatamente um/],
    [{ budgetResourceName: "222", campaignId: "3", amountMicros: 1_000_000 }, /exatamente um/],
    [{ budgetResourceName: "222" }, /Nada para mudar/],
    [{ budgetResourceName: "222", amountMicros: 1_000_000, totalAmountMicros: 2_000_000 }, /mutuamente exclusivos/],
    [{ budgetResourceName: "222", amountMicros: 1_234_567 }, /múltiplo de 10000/],
    [{ budgetResourceName: "222", amountMicros: -10_000 }, /inteiro positivo/],
    [{ budgetResourceName: "222", amountMicros: 1.5 }, /inteiro positivo/],
    [{ budgetResourceName: "customers/9999999999/campaignBudgets/222", amountMicros: 1_000_000 }, /pertence à conta 9999999999/],
    [{ budgetResourceName: "222' OR '1'='1", amountMicros: 1_000_000 }, /não é uma referência/],
    [{ campaignId: "3 OR 1=1", amountMicros: 1_000_000 }, /numérico/],
    [{ budgetResourceName: "111", name: "linha\nquebrada" }, /quebra de linha/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "update_budget", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length, 0, `consultou a API com ${JSON.stringify(args)}`);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_budget: aumento acima do dobro exige confirm", async () => {
  const { client, calls } = fakeClient();
  const refused = await call(client, "update_budget", { budgetResourceName: "222", amountMicros: 500_000_000 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /mais que o dobro/);
  assert.equal(calls.writes.length, 0);
  const ok = await call(client, "update_budget", { budgetResourceName: "222", amountMicros: 500_000_000, confirm: true });
  assert.ok(!ok.isError, textOf(ok));
  onlyWrite(calls, "mutateCampaignBudgets");
});

test("update_budget: makeShared é irreversível — exige confirm e grava explicitly_shared + name", async () => {
  const { client, calls } = fakeClient();
  const refused = await call(client, "update_budget", { budgetResourceName: "222", makeShared: true, name: "Genéricas" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /irreversível/);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "update_budget", { budgetResourceName: "222", makeShared: true, name: "Genéricas", confirm: true });
  assert.ok(!ok.isError, textOf(ok));
  const write = onlyWrite(calls, "mutateCampaignBudgets");
  assert.deepEqual(write.operations[0], {
    update: { resourceName: bRN("222"), explicitlyShared: true, name: "Genéricas" },
    updateMask: "explicitly_shared,name",
  });
  assert.ok(calls.queries.some((q) => /FROM experiment_arm/.test(q)), "confere experimentos antes de compartilhar");
});

test("update_budget: makeShared recusa campanha com experimento, em grupo ou orçamento total", async () => {
  const withExperiment = baseData();
  withExperiment.experimentArms.push({ campaigns: [cRN("3")], experiment: "Teste CPA", status: "ENABLED" });
  let fake = fakeClient({ data: withExperiment });
  let result = await call(fake.client, "update_budget", { budgetResourceName: "222", makeShared: true, name: "X", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /experimento/);
  assert.equal(fake.calls.writes.length, 0);

  const grouped = baseData();
  grouped.campaigns.find((c) => c.id === "3")!.group = "900";
  fake = fakeClient({ data: grouped });
  result = await call(fake.client, "update_budget", { budgetResourceName: "222", makeShared: true, name: "X", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /grupo de campanhas/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "update_budget", { budgetResourceName: "333", makeShared: true, name: "X", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não pode ser compartilhado/);
  assert.equal(fake.calls.writes.length, 0);
});

test("update_budget: nome só em orçamento compartilhado; nome repetido é recusado", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "update_budget", { budgetResourceName: "222", name: "Outro" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não é compartilhado/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "update_budget", { budgetResourceName: "111", name: "Órfão" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Já existe outro orçamento/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "update_budget", { budgetResourceName: "111", name: "Marca 2026" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(onlyWrite(fake.calls, "mutateCampaignBudgets").operations[0], {
    update: { resourceName: bRN("111"), name: "Marca 2026" },
    updateMask: "name",
  });
});

test("update_budget: orçamento removido ou inexistente não é tocado", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "update_budget", { budgetResourceName: "555", amountMicros: 20_000_000 });
  assert.match(textOf(result), /removido/);
  assert.equal(fake.calls.writes.length, 0);
  fake = fakeClient();
  result = await call(fake.client, "update_budget", { budgetResourceName: "12345", amountMicros: 20_000_000 });
  assert.match(textOf(result), /não encontrado/);
  assert.equal(fake.calls.writes.length, 0);
});

test("update_budget: erro da API vem traduzido", async () => {
  const { client } = fakeClient({
    budgetMutate: () => {
      throw new Error("Google Ads API: Request contains an invalid argument. — Budget amount or total amount must be above this campaign's per-day minimum.");
    },
  });
  const result = await call(client, "update_budget", { budgetResourceName: "222", amountMicros: 10_000 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /mínimo diário/);
  assert.match(textOf(result), /per-day minimum/);
});

test("update_budget: dry-run e validateOnly não dizem que gravou", async () => {
  let fake = fakeClient({ dryRun: true });
  let result = await call(fake.client, "update_budget", { budgetResourceName: "222", amountMicros: 60_000_000 });
  assert.match(textOf(result), /DRY-RUN/);
  assert.doesNotMatch(textOf(result), /aplicada/);

  fake = fakeClient();
  result = await call(fake.client, "update_budget", { budgetResourceName: "222", amountMicros: 60_000_000, validateOnly: true });
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN/);
  assert.equal(fake.calls.dryRunClones, 1);
});

// ── list_budgets ──────────────────────────────────────────────────────

test("list_budgets: inventário com campanhas por orçamento, órfãos e recomendação", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "list_budgets", {});
  assert.ok(!result.isError, textOf(result));
  const body = jsonOf(result);
  const budgets = body.budgets as Row[];
  assert.deepEqual(budgets.map((b) => b.budget_id), ["111", "222", "446", "333", "444"]);
  const shared = budgets.find((b) => b.budget_id === "111")!;
  assert.deepEqual((shared.campaigns as Row[]).map((c) => c.id), ["1", "2"]);
  assert.equal(shared.daily_amount, 100);
  assert.equal((shared.recommendation as Row).recommended_daily_amount, 150);
  const total = budgets.find((b) => b.budget_id === "333")!;
  assert.equal(total.daily_amount, null);
  assert.equal(total.total_amount, 3000);
  assert.equal(budgets.find((b) => b.budget_id === "444")!.orphan, true);
  assert.equal((body.summary as Row).orphans, 1);
  assert.match(calls.queries[0], /campaign_budget\.status = 'ENABLED'/);
});

test("list_budgets: filtros sharedOnly / unusedOnly / includeRemoved e formatos", async () => {
  let fake = fakeClient();
  let body = jsonOf(await call(fake.client, "list_budgets", { sharedOnly: true }));
  assert.deepEqual((body.budgets as Row[]).map((b) => b.budget_id), ["111"]);
  assert.match(fake.calls.queries[0], /explicitly_shared = true/);

  fake = fakeClient();
  body = jsonOf(await call(fake.client, "list_budgets", { unusedOnly: true }));
  assert.deepEqual((body.budgets as Row[]).map((b) => b.budget_id), ["444"]);

  fake = fakeClient();
  body = jsonOf(await call(fake.client, "list_budgets", { includeRemoved: true }));
  assert.ok((body.budgets as Row[]).some((b) => b.budget_id === "555"));

  fake = fakeClient();
  const csv = textOf(await call(fake.client, "list_budgets", { format: "csv" }));
  assert.match(csv.split("\n")[0], /^budget_id,name,status,period/);
  assert.match(csv, /1:Marca Search \(ENABLED\); 2:Marca PMax \(PAUSED\)/);

  fake = fakeClient();
  const bad = await call(fake.client, "list_budgets", { budgetId: "abc" });
  assert.equal(bad.isError, true);
  assert.equal(fake.calls.queries.length, 0);
});

// ── get_budget_pacing ─────────────────────────────────────────────────

test("pacing (puro): diário abaixo do ritmo, projeção e diário necessário", () => {
  const pace = paceDailyBudget({
    dailyMicros: 100_000_000, spendToYesterdayMicros: 800_000_000, spendTodayMicros: 30_000_000,
    monthDays: 30, elapsedFullDays: 10, isPastMonth: false, hasEnabledCampaign: true,
  });
  assert.equal(pace.month_reference, 3000);
  assert.equal(pace.expected_to_yesterday, 1000);
  assert.equal(pace.pace_pct, 80);
  assert.equal(pace.projected_month_end, 2400);
  assert.equal(pace.spend_month_to_date, 830);
  assert.equal(pace.daily_needed_to_reach_reference, 110);
  assert.equal(pace.status, "ABAIXO_DO_RITMO");
  assert.equal(pace.monthly_charge_cap, 3040);
});

test("pacing (puro): projeção limitada a 30,4 × diário e meta acima do teto", () => {
  const pace = paceDailyBudget({
    dailyMicros: 100_000_000, spendToYesterdayMicros: 1_500_000_000, spendTodayMicros: 0,
    monthDays: 31, elapsedFullDays: 10, isPastMonth: false, hasEnabledCampaign: true,
  });
  assert.equal(pace.month_reference, 3040, "31 dias × 100 passa do teto de 3040");
  assert.equal(pace.projected_month_end_uncapped, 4650);
  assert.equal(pace.projected_month_end, 3040);
  assert.equal(pace.projection_capped, true);
  assert.equal(pace.status, "ACIMA_DO_RITMO");

  const target = paceDailyBudget({
    dailyMicros: 100_000_000, spendToYesterdayMicros: 1_000_000_000, spendTodayMicros: 0,
    monthDays: 30, elapsedFullDays: 10, isPastMonth: false, hasEnabledCampaign: true, targetMicros: 5_000_000_000,
  });
  assert.equal(target.month_target, 5000);
  assert.equal(target.target_above_charge_cap, true);
  assert.equal(target.pace_pct, 60);

  const firstDay = paceDailyBudget({
    dailyMicros: 100_000_000, spendToYesterdayMicros: 0, spendTodayMicros: 10_000_000,
    monthDays: 30, elapsedFullDays: 0, isPastMonth: false, hasEnabledCampaign: true,
  });
  assert.equal(firstDay.pace_pct, null);
  const closed = paceDailyBudget({
    dailyMicros: 100_000_000, spendToYesterdayMicros: 2_000_000_000, spendTodayMicros: 0,
    monthDays: 31, elapsedFullDays: 31, isPastMonth: true, hasEnabledCampaign: false,
  });
  assert.equal(closed.status, "MES_ENCERRADO", "mês fechado não depende do status atual das campanhas");
  assert.equal(closed.projected_month_end, 2000);
  assert.equal(firstDay.status, "SEM_DIA_COMPLETO");
  assert.equal(paceDailyBudget({ ...firstDay as never, dailyMicros: 1, spendToYesterdayMicros: 0, spendTodayMicros: 0, monthDays: 30, elapsedFullDays: 5, isPastMonth: false, hasEnabledCampaign: false }).status, "SEM_CAMPANHA_ATIVA");
});

test("pacing (puro): orçamento total da campanha sobre as datas", () => {
  const running = paceTotalBudget({
    totalMicros: 3_000_000_000, startDate: "2026-09-01", endDate: "2026-09-30", today: "2026-09-11",
    spendToYesterdayMicros: 1_200_000_000, spendTodayMicros: 50_000_000, hasEnabledCampaign: true,
  });
  assert.equal(running.total_days, 30);
  assert.equal(running.elapsed_full_days, 10);
  assert.equal(running.expected_to_yesterday, 1000);
  assert.equal(running.pace_pct, 120);
  assert.equal(running.projected_end, 3000, "projeção não passa do total");
  assert.equal(running.status, "ACIMA_DO_RITMO");
  assert.equal(running.remaining_budget, 1750);

  assert.equal(paceTotalBudget({ ...running as never, totalMicros: 1, startDate: "2026-10-01", endDate: "2026-10-31", today: "2026-09-11", spendToYesterdayMicros: 0, spendTodayMicros: 0, hasEnabledCampaign: true }).status, "NAO_INICIADA");
  assert.equal(paceTotalBudget({ totalMicros: 1, startDate: "2026-08-01", endDate: "2026-08-31", today: "2026-09-11", spendToYesterdayMicros: 5, spendTodayMicros: 0, hasEnabledCampaign: true }).status, "ENCERRADA");
  assert.equal(paceTotalBudget({ totalMicros: 1, startDate: null, endDate: null, today: "2026-09-11", spendToYesterdayMicros: 0, spendTodayMicros: 0, hasEnabledCampaign: true }).status, "SEM_DATAS");
});

test("get_budget_pacing: mês fechado por orçamento, com campanhas, IS perdido e recomendação", async () => {
  const data = baseData();
  for (let day = 1; day <= 31; day++) {
    const date = `2026-08-${String(day).padStart(2, "0")}`;
    data.budgetSpend.push({ budgetId: "111", date, costMicros: 90_000_000 });
    data.budgetSpend.push({ budgetId: "222", date, costMicros: 60_000_000 });
    data.budgetSpend.push({ budgetId: "333", date, costMicros: 100_000_000 });
  }
  data.budgetSpend.push({ budgetId: "111", date: "2026-07-31", costMicros: 999_000_000 }); // fora do mês
  data.campaignMetrics.push({ campaignId: "1", metrics: { costMicros: "2790000000", searchBudgetLostImpressionShare: 0.25, searchImpressionShare: 0.6 } });
  const { client, calls } = fakeClient({ data });
  const result = await call(client, "get_budget_pacing", { month: "2026-08" });
  assert.ok(!result.isError, textOf(result));
  const body = jsonOf(result);
  const summary = body.summary as Row;
  assert.equal(summary.month, "2026-08");
  assert.equal(summary.elapsed_full_days, 31);
  assert.equal(summary.spend_month_to_date, round2(31 * (90 + 60 + 100)));
  const budgets = body.budgets as Row[];
  const shared = budgets.find((b) => b.budget_id === "111")!;
  const pacing = shared.pacing as Row;
  assert.equal(pacing.status, "MES_ENCERRADO");
  assert.equal(pacing.spend_month_to_date, 2790, "a linha de julho não entra");
  assert.equal(pacing.month_reference, 3040);
  const campaign1 = (shared.campaigns as Row[]).find((c) => c.id === "1")!;
  assert.equal(campaign1.budget_constrained, true);
  assert.equal(campaign1.search_budget_lost_is_pct, 25);
  assert.equal(shared.max_budget_lost_is_pct, 25);
  assert.ok((shared.flags as string[]).some((f) => /BUDGET_CONSTRAINED: 1/.test(f)));
  assert.ok((shared.flags as string[]).some((f) => /recomenda R\$ 150\.00/.test(f)));
  assert.equal((shared.recommendation as Row).weekly_change_clicks, 120);
  const total = budgets.find((b) => b.budget_id === "333")!;
  assert.equal((total.pacing as Row).status, "ENCERRADA");
  assert.equal((total.pacing as Row).spend_since_start, 3100);
  assert.ok(!budgets.some((b) => b.budget_id === "444"), "órfão sem gasto fica fora");
  for (const q of calls.queries) assert.doesNotMatch(q, /THIS_MONTH/);
  assert.ok(calls.queries.some((q) => /segments\.date BETWEEN '2026-08-01' AND '2026-08-31'/.test(q)));
});

test("get_budget_pacing: mês atual separa o gasto de hoje e mede orçamento total pelas datas", async () => {
  const today = todayInTimeZone(TZ);
  const month = today.slice(0, 7);
  const elapsed = Number(today.slice(8, 10)) - 1;
  const data = baseData();
  const total = data.campaigns.find((c) => c.id === "4")!;
  total.startDateTime = `${isoShift(today, -40)} 00:00:00`;
  total.endDateTime = `${isoShift(today, 19)} 23:59:59`;
  for (let d = 1; d <= elapsed; d++) {
    data.budgetSpend.push({ budgetId: "222", date: `${month}-${String(d).padStart(2, "0")}`, costMicros: 50_000_000 });
  }
  data.budgetSpend.push({ budgetId: "222", date: today, costMicros: 7_000_000 });
  data.budgetSpend.push({ budgetId: "333", date: isoShift(today, -41), costMicros: 500_000_000 }); // antes do início
  data.budgetSpend.push({ budgetId: "333", date: isoShift(today, -10), costMicros: 400_000_000 });
  data.budgetSpend.push({ budgetId: "333", date: today, costMicros: 10_000_000 });
  // segundo orçamento total, que começou depois: o gasto dele antes do próprio início
  // cai dentro da janela da query (que vai do início mais antigo) e precisa ser descartado
  data.budgets.push({ id: "334", name: "Total Natal", period: "CUSTOM_PERIOD", totalAmountMicros: 1_000_000_000, referenceCount: 1 });
  data.campaigns.push({ id: "9", name: "Natal", status: "ENABLED", budget: "334", startDateTime: `${isoShift(today, -5)} 00:00:00`, endDateTime: `${isoShift(today, 14)} 23:59:59` });
  data.budgetSpend.push({ budgetId: "334", date: isoShift(today, -20), costMicros: 700_000_000 });
  data.budgetSpend.push({ budgetId: "334", date: isoShift(today, -2), costMicros: 60_000_000 });
  const { client, calls } = fakeClient({ data });
  const result = await call(client, "get_budget_pacing", {
    monthlyTargets: [{ campaignId: "3", monthlyTargetMicros: 3_000_000_000 }],
    accountMonthlyTargetMicros: 10_000_000_000,
  });
  assert.ok(!result.isError, textOf(result));
  const body = jsonOf(result);
  const summary = body.summary as Row;
  assert.equal(summary.today, today);
  assert.equal(summary.elapsed_full_days, elapsed);
  assert.equal(summary.account_target, 10000);
  const generic = (body.budgets as Row[]).find((b) => b.budget_id === "222")!.pacing as Row;
  assert.equal(generic.spend_today_partial, 7);
  assert.equal(generic.spend_to_yesterday, round2(elapsed * 50));
  assert.equal(generic.month_target, 3000);
  if (elapsed > 0) assert.equal(generic.status, paceDailyBudget({
    dailyMicros: 50_000_000, spendToYesterdayMicros: elapsed * 50_000_000, spendTodayMicros: 7_000_000,
    monthDays: Number(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()),
    elapsedFullDays: elapsed, isPastMonth: false, hasEnabledCampaign: true, targetMicros: 3_000_000_000,
  }).status);
  const custom = (body.budgets as Row[]).find((b) => b.budget_id === "333")!.pacing as Row;
  assert.equal(custom.spend_since_start, 410, "gasto antes do início da campanha não conta");
  assert.equal(custom.elapsed_full_days, 40);
  assert.equal(custom.total_days, 60);
  const later = (body.budgets as Row[]).find((b) => b.budget_id === "334")!.pacing as Row;
  assert.equal(later.spend_since_start, 60, "gasto anterior ao início deste orçamento não conta");
  assert.equal(later.elapsed_full_days, 5);
  assert.ok(calls.queries.some((q) => /campaign_budget\.id IN \(333, 334\)/.test(q) && q.includes(isoShift(today, -40))));
});

test("get_budget_pacing: campaignId restringe ao orçamento (e às campanhas que o dividem)", async () => {
  const data = baseData();
  data.budgetSpend.push({ budgetId: "111", date: "2026-08-10", costMicros: 90_000_000 });
  data.budgetSpend.push({ budgetId: "222", date: "2026-08-10", costMicros: 60_000_000 });
  const { client, calls } = fakeClient({ data });
  const body = jsonOf(await call(client, "get_budget_pacing", { campaignId: "2", month: "2026-08" }));
  assert.deepEqual((body.budgets as Row[]).map((b) => b.budget_id), ["111"]);
  assert.deepEqual(((body.budgets as Row[])[0].campaigns as Row[]).map((c) => c.id), ["1", "2"]);
  assert.ok(calls.queries.some((q) => /campaign_budget\.id IN \(111\)/.test(q)));
  assert.ok(calls.queries.some((q) => /campaign\.campaign_budget IN \('customers\/5820067509\/campaignBudgets\/111'\)/.test(q)));
});

test("get_budget_pacing: validações antes da API", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ month: "2026-13" }, /month inválido/],
    [{ month: "agosto" }, /month inválido/],
    [{ campaignId: "x" }, /numérico/],
    [{ monthlyTargets: [{ monthlyTargetMicros: 1_000_000 }] }, /budgetId OU campaignId/],
    [{ monthlyTargets: [{ budgetId: "1", campaignId: "2", monthlyTargetMicros: 1_000_000 }] }, /budgetId OU campaignId/],
    [{ monthlyTargets: [{ budgetId: "1", monthlyTargetMicros: -5 }] }, /inteiro positivo/],
    [{ accountMonthlyTargetMicros: 0 }, /inteiro positivo/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_budget_pacing", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length, 0);
  }
  const { client } = fakeClient();
  const future = await call(client, "get_budget_pacing", { month: "2999-01" });
  assert.equal(future.isError, true);
  assert.match(textOf(future), /futuro/);
});

test("get_budget_pacing: formato tabela", async () => {
  const data = baseData();
  data.budgetSpend.push({ budgetId: "222", date: "2026-08-10", costMicros: 60_000_000 });
  const { client } = fakeClient({ data });
  const table = textOf(await call(client, "get_budget_pacing", { month: "2026-08", format: "table" }));
  assert.match(table.split("\n")[0], /budget_id .*pace_pct .*status/);
});

test("pacing (puro): orçamento total em mês fechado congela no fechamento", () => {
  // Fechamento de agosto: asOf = 2026-09-01 (dia seguinte ao fim do mês)
  const running = paceTotalBudget({
    totalMicros: 3_000_000_000, startDate: "2026-07-20", endDate: "2026-09-30", today: "2026-09-01",
    spendToYesterdayMicros: 150_000_000, spendTodayMicros: 0, hasEnabledCampaign: false, closedMonth: true,
  });
  assert.equal(running.measured_through, "2026-08-31");
  assert.equal(running.elapsed_full_days, 43);
  assert.equal(running.status, "MES_ENCERRADO", "status do fechamento, não o ritmo nem o status atual da campanha");
  const ended = paceTotalBudget({ ...running as never, totalMicros: 1, startDate: "2026-08-01", endDate: "2026-08-31", today: "2026-09-01", spendToYesterdayMicros: 1, spendTodayMicros: 0, hasEnabledCampaign: true, closedMonth: true });
  assert.equal(ended.status, "ENCERRADA");
  const startsNextDay = paceTotalBudget({ totalMicros: 1, startDate: "2026-09-01", endDate: "2026-09-30", today: "2026-09-01", spendToYesterdayMicros: 0, spendTodayMicros: 0, hasEnabledCampaign: true, closedMonth: true });
  assert.equal(startsNextDay.status, "NAO_INICIADA", "começou depois do mês fechado");
  const current = paceTotalBudget({ totalMicros: 1, startDate: "2026-09-01", endDate: "2026-09-30", today: "2026-09-01", spendToYesterdayMicros: 0, spendTodayMicros: 0, hasEnabledCampaign: true });
  assert.equal(current.status, "SEM_DIA_COMPLETO", "no mês atual, começou hoje");
  assert.equal(current.measured_through, "2026-09-01");
});

test("get_budget_pacing: mês fechado mede o orçamento total só até o fim do mês (JSON e CSV)", async () => {
  // Campanha com orçamento total que atravessa o fechamento: começou em julho, termina em setembro.
  const data = baseData();
  const bf = data.campaigns.find((c) => c.id === "4")!;
  bf.startDateTime = "2026-07-20 00:00:00";
  bf.endDateTime = "2026-09-30 23:59:59";
  data.budgetSpend.push({ budgetId: "333", date: "2026-07-25", costMicros: 50_000_000 });
  data.budgetSpend.push({ budgetId: "333", date: "2026-08-20", costMicros: 100_000_000 });
  data.budgetSpend.push({ budgetId: "333", date: "2026-09-10", costMicros: 900_000_000 }); // depois do mês pedido
  data.budgetSpend.push({ budgetId: "222", date: "2026-08-10", costMicros: 60_000_000 });

  let fake = fakeClient({ data });
  const body = jsonOf(await call(fake.client, "get_budget_pacing", { month: "2026-08", budgetId: "333" }));
  const row = (body.budgets as Row[])[0];
  assert.equal(row.budget_id, "333");
  assert.equal(row.spend_month_to_date, 100);
  const pacing = row.pacing as Row;
  assert.equal(pacing.spend_since_start, 150, "gasto de setembro não entra no fechamento de agosto");
  assert.equal(pacing.measured_through, "2026-08-31");
  assert.equal(pacing.total_days, 73);
  assert.equal(pacing.elapsed_full_days, 43, "dias de 20/07 a 31/08, não até hoje");
  assert.equal(pacing.expected_to_yesterday, 1767.12);
  assert.equal(pacing.pace_pct, 8.49);
  assert.equal(pacing.projected_end, 254.65);
  assert.equal(pacing.remaining_budget, 2850);
  assert.equal(pacing.status, "MES_ENCERRADO");
  assert.ok(
    fake.calls.queries.some((q) => /campaign_budget\.id IN \(333\)/.test(q) && /BETWEEN '2026-07-20' AND '2026-08-31'/.test(q)),
    "a query do acumulado para no último dia do mês pedido"
  );
  assert.ok(!fake.calls.queries.some((q) => q.includes(todayInTimeZone(TZ))), "nenhuma query vai até hoje num mês fechado");
  assert.ok((body.warnings as string[]).some((w) => /até 2026-08-31/.test(w)));

  fake = fakeClient({ data });
  const csv = textOf(await call(fake.client, "get_budget_pacing", { month: "2026-08", format: "csv" })).split("\n");
  const header = csv[0].split(",");
  const cell = (id: string, column: string) => csv.find((line) => line.startsWith(`${id},`))!.split(",")[header.indexOf(column)];
  assert.ok(header.includes("spend_since_start"), csv[0]);
  assert.equal(cell("333", "spend"), "100", "spend é o gasto do mês também no orçamento total");
  assert.equal(cell("333", "spend_since_start"), "150");
  assert.equal(cell("333", "status"), "MES_ENCERRADO");
  assert.equal(cell("222", "spend"), "60");
  assert.equal(cell("222", "spend_since_start"), "");
});

test("get_budget_pacing: verba da conta não combina com campaignId/budgetId", async () => {
  for (const scope of [{ campaignId: "3" }, { budgetId: "222" }, { budgetId: bRN("222") }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_budget_pacing", { ...scope, accountMonthlyTargetMicros: 10_000_000_000 });
    assert.equal(result.isError, true, JSON.stringify(scope));
    assert.match(textOf(result), /conta inteira/);
    assert.equal(calls.queries.length, 0, "recusa antes de qualquer consulta");
  }
  // Sem filtro, o resumo da conta soma todos os orçamentos
  const today = todayInTimeZone(TZ);
  const data = baseData();
  data.budgetSpend.push({ budgetId: "222", date: `${today.slice(0, 7)}-01`, costMicros: 1_000_000_000 });
  data.budgetSpend.push({ budgetId: "111", date: `${today.slice(0, 7)}-01`, costMicros: 9_000_000_000 });
  const { client } = fakeClient({ data });
  const summary = jsonOf(await call(client, "get_budget_pacing", { accountMonthlyTargetMicros: 10_000_000_000 })).summary as Row;
  assert.equal(summary.spend_month_to_date, 10000);
  assert.equal(summary.account_target, 10000);
  // o filtro sem verba da conta segue valendo
  const scoped = jsonOf(await call(fakeClient({ data }).client, "get_budget_pacing", { campaignId: "3" }));
  assert.deepEqual((scoped.budgets as Row[]).map((b) => b.budget_id), ["222"]);
  assert.equal((scoped.summary as Row).account_target, undefined);
});

// ── create_shared_budget ──────────────────────────────────────────────

test("create_shared_budget: cria compartilhado sem campanhas", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_shared_budget", { name: "  Linha Tênis  ", amountMicros: 200_000_000 });
  assert.ok(!result.isError, textOf(result));
  const write = onlyWrite(calls, "mutateCampaignBudgets");
  assert.deepEqual(write.operations[0], {
    create: { name: "Linha Tênis", amountMicros: "200000000", deliveryMethod: "STANDARD", period: "DAILY", explicitlyShared: true },
  });
  assert.match(textOf(result), /campaignBudgets\/777/);
});

test("create_shared_budget: com campanhas — prévia sem confirm, atômico com confirm", async () => {
  const { client, calls } = fakeClient();
  const preview = await call(client, "create_shared_budget", { name: "Genéricas", amountMicros: 80_000_000, campaignIds: ["3", "5"] });
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /PRÉVIA/);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "create_shared_budget", { name: "Genéricas", amountMicros: 80_000_000, campaignIds: ["3"], confirm: true });
  assert.ok(!ok.isError, textOf(ok));
  const write = onlyWrite(calls, "batchMutate");
  const temp = `customers/${CID}/campaignBudgets/-1`;
  assert.deepEqual(write.operations, [
    { campaignBudgetOperation: { create: { resourceName: temp, name: "Genéricas", amountMicros: "80000000", deliveryMethod: "STANDARD", period: "DAILY", explicitlyShared: true } } },
    { campaignOperation: { update: { resourceName: cRN("3"), campaignBudget: temp }, updateMask: "campaign_budget" } },
  ]);
  assert.match(textOf(ok), /ficaram sem campanha: 222/);
});

test("create_shared_budget: recusas antes de gravar (nome repetido, grupo, experimento, orçamento total)", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "create_shared_budget", { name: "Órfão", amountMicros: 10_000_000 });
  assert.match(textOf(result), /Já existe orçamento chamado "Órfão"/);
  assert.equal(fake.calls.writes.length, 0);

  const data = baseData();
  data.campaigns.find((c) => c.id === "3")!.group = "900";
  data.experimentArms.push({ campaigns: [cRN("1")], experiment: "Teste", status: "INITIATED" });
  fake = fakeClient({ data });
  result = await call(fake.client, "create_shared_budget", { name: "Novo", amountMicros: 10_000_000, campaignIds: ["3", "1", "4", "77"], confirm: true });
  assert.equal(result.isError, true);
  const body = textOf(result);
  assert.match(body, /3 "Genérica".*grupo de campanhas/);
  assert.match(body, /1 "Marca Search".*rodando ou agendado/);
  assert.match(body, /4 "Black Friday".*período/);
  assert.match(body, /77: não encontrada/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "create_shared_budget", { name: "X", amountMicros: 1_000 });
  assert.match(textOf(result), /múltiplo de 10000/);
  assert.equal(fake.calls.queries.length, 0);
});

test("create_shared_budget: dry-run", async () => {
  const { client } = fakeClient({ dryRun: true });
  const result = await call(client, "create_shared_budget", { name: "Novo", amountMicros: 10_000_000, campaignIds: ["3"], confirm: true });
  assert.ok(!result.isError, textOf(result));
  assert.match(textOf(result), /DRY-RUN/);
});

// ── assign_budget ─────────────────────────────────────────────────────

test("assign_budget: prévia sem confirm; com confirm grava só campaign_budget, pula quem já usa", async () => {
  const { client, calls } = fakeClient();
  const preview = await call(client, "assign_budget", { campaignIds: ["3", "1"], budgetId: "111" });
  assert.equal(preview.isError, true);
  assert.match(textOf(preview), /PRÉVIA — nada foi gravado/);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "assign_budget", { campaignIds: ["3", "1"], budgetId: bRN("111"), confirm: true });
  assert.ok(!ok.isError, textOf(ok));
  const write = onlyWrite(calls, "mutate:campaigns");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [{ update: { resourceName: cRN("3"), campaignBudget: bRN("111") }, updateMask: "campaign_budget" }]);
  const body = jsonOf(ok);
  assert.deepEqual((body.skipped as Row[]).map((s) => s.campaign_id), ["1"]);
  assert.match(textOf(ok), /sem campanha: 222/);
});

test("assign_budget: recusas por campanha (experimento, período, tipo, alinhamento, grupo)", async () => {
  const data = baseData();
  data.budgets.push({ id: "666", name: "Alinhado", amountMicros: 10_000_000, explicitlyShared: true, referenceCount: 0, alignedBiddingStrategyId: "42" });
  data.budgets.push({ id: "667", name: "Smart", amountMicros: 10_000_000, explicitlyShared: true, type: "SMART_CAMPAIGN" });
  data.campaigns.push({ id: "6", name: "Com grupo", status: "ENABLED", budget: "444", group: "900" });
  data.campaigns.push({ id: "7", name: "Experimento", status: "ENABLED", budget: "444", experimentType: "EXPERIMENT" });
  data.experimentArms.push({ campaigns: [cRN("3")], experiment: "Teste", status: "ENABLED" });
  const { client, calls } = fakeClient({ data });

  const refusedAll = jsonOf(await call(client, "assign_budget", { campaignIds: ["3", "4", "6", "7"], budgetId: "111", confirm: true }));
  const reasons = Object.fromEntries((refusedAll.refused as Row[]).map((r) => [r.campaign_id, String(r.reason)]));
  assert.match(reasons["3"], /experimento/);
  assert.match(reasons["4"], /período/);
  assert.match(reasons["6"], /grupo de campanhas/);
  assert.match(reasons["7"], /campanha de experimento/);

  // orçamento de destino individual e vazio: só a regra de experimento rodando pode recusar
  const running = jsonOf(await call(client, "assign_budget", { campaignIds: ["3"], budgetId: "444", confirm: true }));
  assert.match(String((running.refused as Row[])[0].reason), /rodando ou agendado/);

  const aligned = jsonOf(await call(client, "assign_budget", { campaignIds: ["1"], budgetId: "666", confirm: true }));
  assert.match(String((aligned.refused as Row[])[0].reason), /estratégia de portfólio 42/);
  const typed = jsonOf(await call(client, "assign_budget", { campaignIds: ["1"], budgetId: "667", confirm: true }));
  assert.match(String((typed.refused as Row[])[0].reason), /tipo de orçamento/);
  assert.equal(calls.writes.length, 0);
});

test("experimento em montagem (SETUP): destino compartilhado é recusado, inclusive campanha em in_design_campaigns", async () => {
  const data = baseData();
  // Braço de controle (campaigns) e de tratamento (in_design_campaigns) de um experimento em SETUP.
  // O fake marca as duas como BASE para exercitar o ramo in_design_campaigns da consulta de experimentos.
  data.experimentArms.push({ campaigns: [cRN("3")], experiment: "Teste lance", status: "SETUP" });
  data.experimentArms.push({ campaigns: [], inDesignCampaigns: [cRN("5")], experiment: "Teste lance", status: "SETUP" });

  let fake = fakeClient({ data });
  let result = await call(fake.client, "assign_budget", { campaignIds: ["3", "5"], budgetId: "111", confirm: true });
  assert.equal(result.isError, true);
  const reasons = Object.fromEntries((jsonOf(result).refused as Row[]).map((r) => [r.campaign_id, String(r.reason)]));
  assert.match(reasons["3"], /"Teste lance" \(SETUP\).*não compartilhado/);
  assert.match(reasons["5"], /"Teste lance" \(SETUP\).*não compartilhado/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient({ data });
  result = await call(fake.client, "create_shared_budget", { name: "Novo", amountMicros: 10_000_000, campaignIds: ["3", "5"], confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /3 "Genérica".*SETUP.*não compartilhado/);
  assert.match(textOf(result), /5 "Institucional".*SETUP.*não compartilhado/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient({ data });
  result = await call(fake.client, "update_budget", { budgetResourceName: "446", makeShared: true, name: "X", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /experimento/);
  assert.equal(fake.calls.writes.length, 0);

  // Destino individual: SETUP não trava a troca (só ENABLED/INITIATED travam)
  fake = fakeClient({ data });
  result = await call(fake.client, "assign_budget", { campaignIds: ["3"], budgetId: "444", confirm: true });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(onlyWrite(fake.calls, "mutate:campaigns").operations, [
    { update: { resourceName: cRN("3"), campaignBudget: bRN("444") }, updateMask: "campaign_budget" },
  ]);
});

test("assign_budget: orçamento individual não recebe segunda campanha; total não é destino", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "assign_budget", { campaignIds: ["1"], budgetId: "222", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não é compartilhado e ficaria com 2 campanhas/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "assign_budget", { campaignIds: ["1"], budgetId: "333", confirm: true });
  assert.match(textOf(result), /CUSTOM_PERIOD/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "assign_budget", { campaignIds: ["x"], budgetId: "111", confirm: true });
  assert.match(textOf(result), /numérico/);
  assert.equal(fake.calls.queries.length, 0);
});

test("assign_budget: falha parcial vira relatório por campanha", async () => {
  const data = baseData();
  data.campaigns.push({ id: "8", name: "Outra", status: "ENABLED", budget: "444" });
  const { client } = fakeClient({
    data,
    mutate: () => ({
      results: [{ resourceName: cRN("3") }, {}],
      partialFailureError: {
        message: "falhou",
        details: [{ errors: [{
          message: "Bidding strategy type is incompatible with shared budget.",
          errorCode: { biddingError: "BIDDING_STRATEGY_TYPE_INCOMPATIBLE_WITH_SHARED_BUDGET" },
          location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
        }] }],
      },
    }),
  });
  const result = await call(client, "assign_budget", { campaignIds: ["3", "8"], budgetId: "111", confirm: true });
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.deepEqual((body.moved as Row[]).map((m) => m.campaign_id), ["3"]);
  assert.equal((body.errors as Row[])[0].campaign_id, "8");
  assert.match(String((body.errors as Row[])[0].error), /não aceita orçamento compartilhado/);
});

// ── remove_budget ─────────────────────────────────────────────────────

test("remove_budget: exige confirm, remove órfão, recusa em uso, pula removido", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "remove_budget", { budgetIds: ["444"], confirm: false });
  assert.equal(result.isError, true);
  assert.equal(fake.calls.queries.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "remove_budget", { budgetIds: ["444", "111", "555", "31337"], confirm: true });
  const write = onlyWrite(fake.calls, "mutate:campaignBudgets");
  assert.deepEqual(write.operations, [{ remove: bRN("444") }]);
  assert.deepEqual(write.options, { partialFailure: true });
  const body = jsonOf(result);
  assert.deepEqual((body.removed as Row[]).map((r) => r.budget_id), ["444"]);
  assert.deepEqual((body.skipped as Row[]).map((r) => r.budget_id), ["555"]);
  const refused = body.refused as Row[];
  assert.match(String(refused.find((r) => r.budget_id === "111")!.reason), /em uso por 2/);
  assert.match(String(refused.find((r) => r.budget_id === "31337")!.reason), /não encontrado/);
  assert.equal(result.isError, true, "recusas marcam isError");
});

test("remove_budget: órfão alinhado a estratégia de portfólio é recusado sem escrita", async () => {
  const data = baseData();
  data.budgets.push({ id: "668", name: "Alinhado órfão", amountMicros: 10_000_000, explicitlyShared: true, referenceCount: 0, alignedBiddingStrategyId: "42" });
  let fake = fakeClient({ data });
  let result = await call(fake.client, "remove_budget", { budgetIds: ["668"], confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada a remover/);
  const refused = jsonOf(result).refused as Row[];
  assert.equal(refused[0].budget_id, "668");
  assert.match(String(refused[0].reason), /estratégia de portfólio 42/);
  assert.equal(fake.calls.writes.length, 0);

  // Junto com um órfão comum: só o comum sai
  fake = fakeClient({ data });
  result = await call(fake.client, "remove_budget", { budgetIds: ["668", "444"], confirm: true });
  assert.deepEqual(onlyWrite(fake.calls, "mutate:campaignBudgets").operations, [{ remove: bRN("444") }]);
  assert.deepEqual((jsonOf(result).refused as Row[]).map((r) => r.budget_id), ["668"]);
});

test("remove_budget: nada removível não grava; erro da API traduzido", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "remove_budget", { budgetIds: ["111"], confirm: true });
  assert.equal(fake.calls.writes.length, 0);
  assert.match(textOf(result), /Nada a remover/);

  fake = fakeClient({ mutate: () => { throw new Error("Google Ads API: invalid — CAMPAIGN_BUDGET_IN_USE"); } });
  result = await call(fake.client, "remove_budget", { budgetIds: ["444"], confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /mova as campanhas com assign_budget/);
});

// ── Grupos de campanhas ───────────────────────────────────────────────

test("create_campaign_group: grupo + campanhas num mutate atômico; recusa orçamento compartilhado", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "create_campaign_group", { name: "Funil topo", campaignIds: ["3", "4"] });
  assert.ok(!result.isError, textOf(result));
  const temp = `customers/${CID}/campaignGroups/-1`;
  assert.deepEqual(onlyWrite(fake.calls, "batchMutate").operations, [
    { campaignGroupOperation: { create: { resourceName: temp, name: "Funil topo", status: "ENABLED" } } },
    { campaignOperation: { update: { resourceName: cRN("3"), campaignGroup: temp }, updateMask: "campaign_group" } },
    { campaignOperation: { update: { resourceName: cRN("4"), campaignGroup: temp }, updateMask: "campaign_group" } },
  ]);

  fake = fakeClient();
  result = await call(fake.client, "create_campaign_group", { name: "Marca", campaignIds: ["1"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /orçamento compartilhado 111/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "create_campaign_group", { name: "Linha Tênis" });
  assert.match(textOf(result), /Já existe grupo/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "create_campaign_group", { name: "Só grupo" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(onlyWrite(fake.calls, "mutate:campaignGroups").operations, [{ create: { name: "Só grupo", status: "ENABLED" } }]);
});

test("assign_campaign_group: coloca, tira (null limpa o campo) e pula no-op", async () => {
  const data = baseData();
  data.campaigns.find((c) => c.id === "4")!.group = "900";
  let fake = fakeClient({ data });
  let result = await call(fake.client, "assign_campaign_group", { campaignIds: ["3", "4"], campaignGroupId: "900" });
  assert.ok(!result.isError, textOf(result));
  let write = onlyWrite(fake.calls, "mutate:campaigns");
  assert.deepEqual(write.operations, [{ update: { resourceName: cRN("3"), campaignGroup: gRN("900") }, updateMask: "campaign_group" }]);
  assert.deepEqual((jsonOf(result).skipped as Row[]).map((s) => s.campaign_id), ["4"]);

  fake = fakeClient({ data });
  result = await call(fake.client, "assign_campaign_group", { campaignIds: ["4"], campaignGroupId: null });
  write = onlyWrite(fake.calls, "mutate:campaigns");
  assert.deepEqual(write.operations, [{ update: { resourceName: cRN("4") }, updateMask: "campaign_group" }]);
  assert.equal((jsonOf(result).changed as Row[])[0].after, null);

  fake = fakeClient({ data });
  result = await call(fake.client, "assign_campaign_group", { campaignIds: ["1"], campaignGroupId: "900" });
  assert.equal(result.isError, true);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient({ data });
  result = await call(fake.client, "assign_campaign_group", { campaignIds: ["3"], campaignGroupId: "12345" });
  assert.match(textOf(result), /não encontrado/);
  assert.equal(fake.calls.writes.length, 0);
});

test("update_campaign_group / remove_campaign_group", async () => {
  let fake = fakeClient();
  let result = await call(fake.client, "update_campaign_group", { campaignGroupId: "900", name: "Linha Tênis" });
  assert.match(textOf(result), /Nenhuma escrita/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient();
  result = await call(fake.client, "update_campaign_group", { campaignGroupId: gRN("900"), name: "Tênis 2026" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(onlyWrite(fake.calls, "mutate:campaignGroups").operations, [
    { update: { resourceName: gRN("900"), name: "Tênis 2026" }, updateMask: "name" },
  ]);

  const data = baseData();
  data.campaigns.find((c) => c.id === "3")!.group = "900";
  fake = fakeClient({ data });
  result = await call(fake.client, "remove_campaign_group", { campaignGroupId: "900", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /ainda tem 1 campanha/);
  assert.equal(fake.calls.writes.length, 0);

  fake = fakeClient({ data });
  result = await call(fake.client, "remove_campaign_group", { campaignGroupId: "901", confirm: false });
  assert.equal(result.isError, true);
  assert.equal(fake.calls.queries.length, 0);

  fake = fakeClient({ data });
  result = await call(fake.client, "remove_campaign_group", { campaignGroupId: "901", confirm: true });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(onlyWrite(fake.calls, "mutate:campaignGroups").operations, [{ remove: gRN("901") }]);
});

test("get_campaign_group_performance: soma por grupo e separa as sem grupo", async () => {
  const data = baseData();
  data.campaigns.find((c) => c.id === "3")!.group = "900";
  data.campaigns.find((c) => c.id === "4")!.group = "900";
  data.campaignMetrics.push({ campaignId: "3", metrics: { impressions: "1000", clicks: "100", costMicros: "200000000", conversions: 10, conversionsValue: 1000 } });
  data.campaignMetrics.push({ campaignId: "4", metrics: { impressions: "1000", clicks: "50", costMicros: "100000000", conversions: 5, conversionsValue: 500 } });
  data.campaignMetrics.push({ campaignId: "1", metrics: { impressions: "10", clicks: "1", costMicros: "1000000", conversions: 0, conversionsValue: 0 } });
  const { client, calls } = fakeClient({ data });
  const result = await call(client, "get_campaign_group_performance", { days: 30 });
  assert.ok(!result.isError, textOf(result));
  const body = JSON.parse(textOf(result).slice(textOf(result).indexOf("["))) as Row[];
  const group = body.find((g) => g.group_id === "900")!;
  assert.equal(group.campaigns_count, 2);
  assert.equal(group.spend, 300);
  assert.equal(group.conversions, 15);
  assert.equal(group.cpa, 20);
  assert.equal(group.roas, 5);
  const ungrouped = body.find((g) => g.name === "(sem grupo)")!;
  assert.equal(ungrouped.spend, 1);
  assert.ok(body.some((g) => g.group_id === "901"), "grupo vazio também aparece");
  assert.ok(calls.queries.some((q) => /DURING LAST_30_DAYS/.test(q)));

  const bad = await call(fakeClient().client, "get_campaign_group_performance", { dateRange: { since: "2026-01-01' OR 1=1", until: "2026-01-31" } });
  assert.equal(bad.isError, true);
});

test("get_campaign_group_performance: campanha ligada a grupo removido não some do relatório", async () => {
  const data = baseData();
  // remove_campaign_group só recusa grupo com campanha NÃO removida: a removida com histórico fica ligada
  data.groups.push({ id: "902", name: "Linha antiga", status: "REMOVED" });
  data.groups.push({ id: "903", name: "Removido vazio", status: "REMOVED" });
  data.campaigns.push({ id: "7", name: "Antiga", status: "REMOVED", budget: "444", group: "902" });
  data.campaigns.push({ id: "8", name: "Sem grupo listado", status: "REMOVED", budget: "444", group: "904" });
  data.campaignMetrics.push({ campaignId: "7", metrics: { impressions: "500", clicks: "40", costMicros: "900000000", conversions: 3, conversionsValue: 300 } });
  data.campaignMetrics.push({ campaignId: "8", metrics: { impressions: "5", clicks: "1", costMicros: "5000000", conversions: 0, conversionsValue: 0 } });
  data.campaignMetrics.push({ campaignId: "1", metrics: { impressions: "10", clicks: "1", costMicros: "1000000", conversions: 0, conversionsValue: 0 } });
  const { client, calls } = fakeClient({ data });
  const result = await call(client, "get_campaign_group_performance", { days: 30 });
  assert.ok(!result.isError, textOf(result));
  const body = JSON.parse(textOf(result).slice(textOf(result).indexOf("["))) as Row[];

  const removed = body.find((g) => g.group_id === "902")!;
  assert.ok(removed, "grupo removido com gasto no período vira balde");
  assert.equal(removed.name, "Linha antiga");
  assert.equal(removed.status, "REMOVED");
  assert.equal(removed.spend, 900);
  assert.deepEqual((removed.campaigns as Row[]).map((c) => [c.id, c.name, c.status]), [["7", "Antiga", "REMOVED"]]);
  const unknown = body.find((g) => g.group_id === "904")!;
  assert.equal(unknown.name, "(grupo não encontrado)");
  assert.equal(unknown.spend, 5);
  assert.ok(!body.some((g) => g.group_id === "903"), "grupo removido sem campanha não aparece");
  assert.ok(body.some((g) => g.group_id === "901"), "grupo ativo vazio continua aparecendo");

  // Os baldes fecham com o total da conta e cada campanha aparece uma vez só
  const spent = round2(body.reduce((sum, g) => sum + Number(g.spend), 0));
  assert.equal(spent, 906);
  assert.match(textOf(result), /Gasto total no período.*R\$ 906\.00/);
  const ids = body.flatMap((g) => (g.campaigns as Row[]).map((c) => c.id));
  assert.equal(ids.length, new Set(ids).size);
  assert.match(textOf(result), /2 grupo\(s\) removido\(s\) ou não encontrado\(s\)/);
  assert.ok(calls.queries.some((q) => /FROM campaign_group$/.test(q.trim())), "lê os grupos sem filtro de status (removidos também)");
});

// ── Todas as tools de escrita: validateOnly ───────────────────────────

test("validateOnly: tools de escrita do lote rodam em dry-run e avisam", async () => {
  const cases: Array<[string, Row]> = [
    ["create_shared_budget", { name: "VO", amountMicros: 10_000_000 }],
    ["assign_budget", { campaignIds: ["3"], budgetId: "111", confirm: true }],
    ["remove_budget", { budgetIds: ["444"], confirm: true }],
    ["create_campaign_group", { name: "VO", campaignIds: ["3"] }],
    ["update_campaign_group", { campaignGroupId: "900", name: "VO" }],
    ["remove_campaign_group", { campaignGroupId: "901", confirm: true }],
    ["assign_campaign_group", { campaignIds: ["3"], campaignGroupId: "900" }],
  ];
  for (const [tool, args] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, tool, { ...args, validateOnly: true });
    const body = textOf(result);
    assert.match(body, /VALIDATE-ONLY/, tool);
    assert.match(body, /DRY-RUN/, `${tool}: ${body}`);
    assert.equal(calls.dryRunClones, 1, tool);
    assert.ok(!result.isError, `${tool}: ${body}`);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

test("helpers: referências e tradução de erros", () => {
  assert.deepEqual(parseResourceRef("campaignBudgets", "582-006-7509".replace(/-/g, "") && "12", CID), { id: "12", resourceName: bRN("12") });
  assert.deepEqual(parseResourceRef("campaignGroups", "customers/582-006-7509/campaignGroups/9", CID), { id: "9", resourceName: gRN("9") });
  assert.ok("error" in parseResourceRef("campaignGroups", bRN("9"), CID));
  assert.match(explainBudgetError("CANNOT_CHANGE_BUDGET_PERIOD"), /período do orçamento/);
  assert.equal(explainBudgetError("algo desconhecido"), "algo desconhecido");
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
