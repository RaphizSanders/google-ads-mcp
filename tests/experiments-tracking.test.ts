/**
 * Lote experiments-tracking: aquisição de clientes (Goal/CampaignGoalConfig/UserListCustomerType),
 * experimentos e rascunhos, rastreamento de URL e rótulos.
 *
 * O que estes testes fixam:
 * - payload e caminho de cada escrita conferidos nos protos v25 (Goals:mutate com G maiúsculo,
 *   googleAds:mutate atômico com ID temporário, experiments/{id}:scheduleExperiment...);
 * - toda query passa pelas regras de GAQL da API (tests/gaql-rules.ts) e todo updateMask só
 *   nomeia folhas;
 * - entrada inválida é recusada antes de qualquer chamada; valor igual não gera escrita;
 * - ação destrutiva/em escala sem confirm não grava; dry-run/validateOnly nunca vira "gravado";
 * - erros da API chegam traduzidos (Como resolver: ...).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Row) => Promise<Result>;

const CID = "1234567890";
const MCC = "9998887776";

// ── Client falso ──────────────────────────────────────────────────────

interface Write {
  kind: "mutate" | "batchMutate" | "action" | "writeAction";
  cid: string;
  target: string;
  payload: unknown;
  options?: Row;
  dryRun: boolean;
}

type RowSource = Row[] | ((query: string, cid: string) => Row[]);

interface FakeOptions {
  rows?: Record<string, RowSource>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], cid: string) => Row;
  batchMutate?: (operations: Row[]) => Row;
  action?: (action: string, body: Row) => Row;
  get?: (path: string) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ cid: string; query: string }>,
    writes: [] as Write[],
    gets: [] as string[],
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(cid: string, query: string): Promise<Row[]> {
      calls.queries.push({ cid, query });
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      return typeof source === "function" ? source(query, cid) : source ?? [];
    },
    async mutate(cid: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ kind: "mutate", cid, target: resource, payload: operations, options, dryRun });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(resource, operations, cid);
      return dryRun ? {} : { results: operations.map((_, index) => ({ resourceName: `customers/${cid}/${resource}/${index + 1}` })) };
    },
    async batchMutate(cid: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ kind: "batchMutate", cid, target: "googleAds", payload: operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op) =>
          op.experimentOperation ? { experimentResult: { resourceName: `customers/${cid}/experiments/321` } }
            : op.experimentArmOperation ? { experimentArmResult: { resourceName: `customers/${cid}/experimentArms/321~1` } } : {}),
      };
    },
    async customerAction(cid: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ kind: "action", cid, target: action, payload: body, dryRun });
      return opts.action ? opts.action(action, body) : {};
    },
    async customerWriteAction(cid: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ kind: "writeAction", cid, target: action, payload: body, dryRun });
      return opts.action ? opts.action(action, body) : { name: "customers/1/operations/abc" };
    },
    async customerGet(_cid: string, path: string): Promise<Row> {
      calls.gets.push(path);
      return opts.get ? opts.get(path) : { errors: [] };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = { registerTool: (name: string, _config: Row, handler: Handler) => handlers.set(name, handler) };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row, allowed: string[] = [], hosted = false) =>
  register(client, allowed, hosted).get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

/** JSON que a tool imprime depois do cabeçalho (primeira linha em branco). */
function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = body.search(/\n\n[[{]/);
  return JSON.parse(body.slice(start + 2)) as Row;
}

const mutations = (calls: { writes: Write[] }) => calls.writes.filter((w) => w.kind === "mutate");
const ops = (write: Write) => write.payload as Row[];

// ═════════════════════════ Aquisição de clientes ═════════════════════

const ncaGoal = (values: Row = { additionalValue: 50 }) => ({
  goal: {
    resourceName: `customers/${CID}/goals/77`, goalId: "77", goalType: "NEW_CUSTOMER_ACQUISITION",
    ownerCustomer: `customers/${CID}`, optimizationEligibility: "ELIGIBLE",
    newCustomerAcquisitionGoalSettings: { valueSettings: values },
  },
});
const customerRow = (conversionCustomer = CID) => ({
  customer: { id: CID, conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${conversionCustomer}`, conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF" } },
});
const pmaxCampaign = { campaign: { id: "222", name: "PMax Loja", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" } };
const ncaConfig = (settings: Row) => ({
  campaignGoalConfig: {
    resourceName: `customers/${CID}/campaignGoalConfigs/222~77`, campaign: `customers/${CID}/campaigns/222`,
    goal: `customers/${CID}/goals/77`, goalType: "NEW_CUSTOMER_ACQUISITION", campaignNewCustomerAcquisitionSettings: settings,
  },
  ...pmaxCampaign,
});

test("get_lifecycle_goals: metas da conta, config por campanha (modo) e listas com tipo de cliente", async () => {
  const { client, calls } = fakeClient({
    rows: {
      customer: [customerRow()],
      goal: [ncaGoal({ additionalValue: 50, additionalHighLifetimeValue: 120 })],
      campaign_goal_config: [ncaConfig({ targetOption: "TARGET_SPECIFIC" })],
      user_list_customer_type: [{ userListCustomerType: { resourceName: `customers/${CID}/userListCustomerTypes/555~PURCHASERS`, userList: `customers/${CID}/userLists/555`, customerTypeCategory: "PURCHASERS" } }],
      user_list: [{ userList: { id: "555", name: "Compradores", type: "CRM_BASED" } }],
    },
  });
  const result = await call(client, "get_lifecycle_goals", {});
  assert.ok(!result.isError, textOf(result));
  const body = jsonOf(result);
  assert.deepEqual((body.goals as Row[])[0], {
    goal_id: "77", goal_type: "NEW_CUSTOMER_ACQUISITION", resource_name: `customers/${CID}/goals/77`, owner_customer: `customers/${CID}`,
    optimization_eligibility: "ELIGIBLE", additional_value: 50, additional_high_lifetime_value: 120, value_multiplier: null,
  });
  const config = (body.campaign_configs as Row[])[0];
  assert.equal(config.mode, "NEW_ONLY");
  assert.equal(config.campaign_name, "PMax Loja");
  assert.deepEqual(body.user_list_customer_types, [{ user_list_id: "555", user_list_name: "Compradores", user_list_type: "CRM_BASED", category: "PURCHASERS" }]);
  assert.equal(calls.writes.length, 0);
});

test("get_lifecycle_goals: conta de conversão fora da allowlist não é consultada", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow(MCC)] } });
  const result = await call(client, "get_lifecycle_goals", {}, [CID], true);
  const body = jsonOf(result);
  assert.match(String(body.conversion_account_goals), /fora da allowlist/);
  assert.ok(calls.queries.every((q) => q.cid === CID), "nenhuma query na conta de conversão");
});

test("set_new_customer_acquisition: cria a meta da conta em Goals:mutate", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow()] } });
  const result = await call(client, "set_new_customer_acquisition", { additionalValue: 50, highLifetimeValue: 150 });
  assert.ok(!result.isError, textOf(result));
  const [write] = mutations(calls);
  assert.equal(write.target, "Goals", "REST: /customers/{id}/Goals:mutate (G maiúsculo, do proto)");
  assert.deepEqual(ops(write)[0], {
    create: { goalType: "NEW_CUSTOMER_ACQUISITION", newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 50, additionalHighLifetimeValue: 150 } } },
  });
});

test("set_new_customer_acquisition: atualiza só a folha que muda; valor igual não grava", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow()], goal: [ncaGoal({ additionalValue: 50, additionalHighLifetimeValue: 150 })] } });
  await call(client, "set_new_customer_acquisition", { additionalValue: 60 });
  const op = ops(mutations(calls)[0])[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "new_customer_acquisition_goal_settings.value_settings.additional_value");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/goals/77`, newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 60 } } });

  const same = fakeClient({ rows: { customer: [customerRow()], goal: [ncaGoal({ additionalValue: 50 })] } });
  const result = await call(same.client, "set_new_customer_acquisition", { additionalValue: 50 });
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  // alto valor ficaria abaixo do valor base depois da mudança → recusado sem gravar
  const low = fakeClient({ rows: { customer: [customerRow()], goal: [ncaGoal({ additionalValue: 50, additionalHighLifetimeValue: 80 })] } });
  const refused = await call(low.client, "set_new_customer_acquisition", { additionalValue: 90 });
  assert.ok(refused.isError, textOf(refused));
  assert.equal(low.calls.writes.length, 0);
});

test("set_new_customer_acquisition: entrada inválida não consulta nem grava", async () => {
  for (const args of [
    { additionalValue: 50, highLifetimeValue: 40 },
    { additionalValue: -1 },
    { mode: "BID_HIGHER", additionalValue: 10 },
    { campaignId: "222" },
    { campaignId: "222", mode: "NEW_ONLY", additionalValue: 10 },
    { campaignId: "abc", mode: "OFF" },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_new_customer_acquisition", args);
    assert.ok(result.isError, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("set_new_customer_acquisition: com acompanhamento entre contas a meta vai para a conta de conversão", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow(MCC)] } });
  await call(client, "set_new_customer_acquisition", { additionalValue: 30 });
  assert.equal(mutations(calls)[0].cid, MCC);
  assert.equal(mutations(calls)[0].target, "Goals");

  const blocked = fakeClient({ rows: { customer: [customerRow(MCC)] } });
  const result = await call(blocked.client, "set_new_customer_acquisition", { additionalValue: 30 }, [CID], true);
  assert.ok(result.isError, textOf(result));
  assert.match(textOf(result), /fora da allowlist/);
  assert.equal(blocked.calls.writes.length, 0);
});

test("set_new_customer_acquisition: entre contas, meta só na conta cliente não é atualizada pela conta de conversão", async () => {
  // Reprodução da revisão: a conta de conversão (MCC) não tem meta; só a conta cliente devolve a meta 77.
  const rows = { customer: [customerRow(MCC)], goal: (_query: string, cid: string) => (cid === CID ? [ncaGoal()] : []) };
  const gate = fakeClient({ rows });
  const refused = await call(gate.client, "set_new_customer_acquisition", { additionalValue: 60 });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /confirm: true/);
  assert.match(textOf(refused), new RegExp(`customers/${CID}/goals/77`));
  assert.equal(gate.calls.writes.length, 0, "sem confirm nada é gravado");

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_new_customer_acquisition", { additionalValue: 60, confirm: true });
  assert.ok(!result.isError, textOf(result));
  const writes = mutations(calls);
  assert.deepEqual(writes.map((w) => [w.cid, w.target]), [[MCC, "Goals"]]);
  assert.deepEqual(ops(writes[0]), [{ create: { goalType: "NEW_CUSTOMER_ACQUISITION", newCustomerAcquisitionGoalSettings: { valueSettings: { additionalValue: 60 } } } }]);
  for (const write of writes) {
    for (const op of ops(write)) assert.equal(op.update, undefined, "nunca atualiza a meta da conta cliente pela conta de conversão");
  }
  assert.match(textOf(result), /todas as contas/);
});

test("set_new_customer_acquisition: entre contas, update vai para a conta dona da meta (resource name da conta de conversão)", async () => {
  const mccGoal = { goal: { ...(ncaGoal().goal as Row), resourceName: `customers/${MCC}/goals/88`, goalId: "88", ownerCustomer: `customers/${MCC}` } };
  const { client, calls } = fakeClient({ rows: { customer: [customerRow(MCC)], goal: (_query: string, cid: string) => (cid === MCC ? [mccGoal] : [ncaGoal()]) } });
  await call(client, "set_new_customer_acquisition", { additionalValue: 60 });
  const [write] = mutations(calls);
  assert.equal(write.cid, MCC);
  assert.equal((ops(write)[0].update as Row).resourceName, `customers/${MCC}/goals/88`);

  // Defesa: se a meta lida na conta de conversão viesse com resource name de outra conta, não grava.
  const odd = fakeClient({ rows: { customer: [customerRow(MCC)], goal: (_query: string, cid: string) => (cid === MCC ? [ncaGoal()] : []) } });
  const refused = await call(odd.client, "set_new_customer_acquisition", { additionalValue: 60 });
  assert.ok(refused.isError, textOf(refused));
  assert.equal(odd.calls.writes.length, 0);
});

test("set_new_customer_acquisition: campanha sem meta e conta de conversão fora da allowlist não cria a meta lá", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow(MCC)], campaign: [pmaxCampaign] } });
  const result = await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "BID_HIGHER", additionalValue: 40 }, [CID], true);
  assert.ok(result.isError, textOf(result));
  assert.match(textOf(result), /fora da allowlist/);
  assert.equal(calls.writes.length, 0, "nenhum Goals:mutate na conta de conversão bloqueada");
  assert.ok(calls.queries.every((q) => q.cid === CID), "a conta de conversão bloqueada nem é consultada");
});

test("set_new_customer_acquisition: campanha em BID_HIGHER cria o vínculo com valor próprio", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow()], goal: [ncaGoal()], campaign: [pmaxCampaign] } });
  const result = await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "BID_HIGHER", additionalValue: 70 });
  assert.ok(!result.isError, textOf(result));
  const [write] = mutations(calls);
  assert.equal(write.target, "CampaignGoalConfigs");
  assert.deepEqual(ops(write)[0], {
    create: {
      campaign: `customers/${CID}/campaigns/222`, goal: `customers/${CID}/goals/77`,
      campaignNewCustomerAcquisitionSettings: { targetOption: "TARGET_ALL", valueSettingsOverride: { additionalValue: 70 } },
    },
  });
});

test("set_new_customer_acquisition: NEW_ONLY sobre config existente limpa os valores próprios", async () => {
  const { client, calls } = fakeClient({
    rows: { customer: [customerRow()], goal: [ncaGoal()], campaign: [pmaxCampaign], campaign_goal_config: [ncaConfig({ targetOption: "TARGET_ALL", valueSettingsOverride: { additionalValue: 70 } })] },
  });
  await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "NEW_ONLY" });
  const op = ops(mutations(calls)[0])[0] as { update: Row; updateMask: string };
  assert.deepEqual(op.updateMask.split(","), [
    "campaign_new_customer_acquisition_settings.target_option",
    "campaign_new_customer_acquisition_settings.value_settings_override.additional_value",
  ]);
  assert.deepEqual(op.update.campaignNewCustomerAcquisitionSettings, { targetOption: "TARGET_SPECIFIC" }, "máscara sem valor = limpa");
});

test("set_new_customer_acquisition: OFF pede confirm e remove a config", async () => {
  const rows = { customer: [customerRow()], goal: [ncaGoal()], campaign: [pmaxCampaign], campaign_goal_config: [ncaConfig({ targetOption: "TARGET_ALL" })] };
  const gate = fakeClient({ rows });
  const refused = await call(gate.client, "set_new_customer_acquisition", { campaignId: "222", mode: "OFF" });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(gate.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "OFF", confirm: true });
  assert.deepEqual(ops(mutations(calls)[0]), [{ remove: `customers/${CID}/campaignGoalConfigs/222~77` }]);
});

test("set_new_customer_acquisition: sem meta na conta cria a meta e vincula; em dry-run só valida a meta", async () => {
  const rows = { customer: [customerRow()], campaign: [pmaxCampaign] };
  const { client, calls } = fakeClient({ rows });
  await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "BID_HIGHER", additionalValue: 40 });
  const [goalWrite, configWrite] = mutations(calls);
  assert.equal(goalWrite.target, "Goals");
  assert.equal(configWrite.target, "CampaignGoalConfigs");
  const created = ops(configWrite)[0].create as Row;
  assert.equal(created.goal, `customers/${CID}/Goals/1`, "usa o resource name devolvido pela criação");
  assert.deepEqual(created.campaignNewCustomerAcquisitionSettings, { targetOption: "TARGET_ALL" }, "os valores foram para a meta da conta");

  const dry = fakeClient({ rows, dryRun: true });
  const result = await call(dry.client, "set_new_customer_acquisition", { campaignId: "222", mode: "BID_HIGHER", additionalValue: 40 });
  assert.deepEqual(mutations(dry.calls).map((w) => w.target), ["Goals"]);
  assert.match(textOf(result), /DRY-RUN/);
  assert.match(textOf(result), /não foi validado/);
});

test("set_new_customer_acquisition: erro da API chega traduzido", async () => {
  const { client } = fakeClient({
    rows: { customer: [customerRow()], goal: [ncaGoal()], campaign: [pmaxCampaign] },
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — CAMPAIGN_OVERRIDE_HIGH_LIFETIME_VALUE_NOT_SUPPORTED_FOR_CAMPAIGN_TYPE"); },
  });
  const result = await call(client, "set_new_customer_acquisition", { campaignId: "222", mode: "BID_HIGHER", additionalValue: 10, highLifetimeValue: 20 });
  assert.ok(result.isError, textOf(result));
  assert.match(textOf(result), /Como resolver: highLifetimeValue por campanha não vale/);
});

test("set_new_customer_acquisition: validateOnly roda em dry-run e não diz que gravou", async () => {
  const { client, calls } = fakeClient({ rows: { customer: [customerRow()], goal: [ncaGoal()] } });
  const result = await call(client, "set_new_customer_acquisition", { additionalValue: 99, validateOnly: true });
  assert.ok(mutations(calls).every((w) => w.dryRun), "toda escrita em dry-run");
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /nada foi gravado/);
  assert.doesNotMatch(textOf(result), /atualizada\./);
});

const listRows = (existing: string[], type = "CRM_BASED") => ({
  user_list: [{ userList: { id: "555", name: "Compradores", type } }],
  user_list_customer_type: existing.map((category) => ({
    userListCustomerType: { resourceName: `customers/${CID}/userListCustomerTypes/555~${category}`, customerTypeCategory: category },
  })),
});

test("tag_user_list_customer_type: marca categorias novas e ignora as já marcadas", async () => {
  const { client, calls } = fakeClient({ rows: listRows(["HIGH_VALUE_CUSTOMERS"]) });
  const result = await call(client, "tag_user_list_customer_type", { userListId: "555", categories: ["PURCHASERS", "HIGH_VALUE_CUSTOMERS"] });
  assert.ok(!result.isError, textOf(result));
  const [write] = mutations(calls);
  assert.equal(write.target, "userListCustomerTypes");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(ops(write), [{ create: { userList: `customers/${CID}/userLists/555`, customerTypeCategory: "PURCHASERS" } }]);
  assert.deepEqual(jsonOf(result).already_tagged, ["HIGH_VALUE_CUSTOMERS"]);
});

test("tag_user_list_customer_type: pares conflitantes são recusados antes de enviar", async () => {
  for (const [existing, wanted] of [[["PURCHASERS"], ["CART_ABANDONERS"]], [[], ["QUALIFIED_LEADS", "CONVERTED_LEADS"]], [["LOYALTY_TIER_1_MEMBERS"], ["LOYALTY_TIER_2_MEMBERS"]]] as const) {
    const { client, calls } = fakeClient({ rows: listRows([...existing]) });
    const result = await call(client, "tag_user_list_customer_type", { userListId: "555", categories: [...wanted] });
    assert.ok(result.isError, wanted.join());
    assert.match(textOf(result), /CONFLICTING_CUSTOMER_TYPES/);
    assert.equal(calls.writes.length, 0);
  }
});

test("tag_user_list_customer_type: no-op, remove com confirm e categoria inválida", async () => {
  const noop = fakeClient({ rows: listRows(["PURCHASERS"]) });
  assert.match(textOf(await call(noop.client, "tag_user_list_customer_type", { userListId: "555", categories: ["PURCHASERS"] })), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const gate = fakeClient({ rows: listRows(["PURCHASERS"]) });
  assert.ok((await call(gate.client, "tag_user_list_customer_type", { userListId: "555", categories: ["PURCHASERS"], action: "remove" })).isError, "tag_user_list_customer_type deveria recusar");
  assert.equal(gate.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: listRows(["PURCHASERS"]) });
  await call(client, "tag_user_list_customer_type", { userListId: "555", categories: ["PURCHASERS"], action: "remove", confirm: true });
  assert.deepEqual(ops(mutations(calls)[0]), [{ remove: `customers/${CID}/userListCustomerTypes/555~PURCHASERS` }]);

  const bad = fakeClient();
  assert.ok((await call(bad.client, "tag_user_list_customer_type", { userListId: "555", categories: "[\"COMPRADORES\"]" })).isError, "tag_user_list_customer_type deveria recusar");
  assert.equal(bad.calls.queries.length, 0);
});

test("get_new_vs_returning_performance: segmento só com métricas de conversão; custo em query separada", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: (query) => query.includes("new_versus_returning_customers")
        ? [
          { campaign: { id: "222", name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX" }, segments: { newVersusReturningCustomers: "NEW" }, metrics: { conversions: 30, conversionsValue: 3000 } },
          { campaign: { id: "222", name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX" }, segments: { newVersusReturningCustomers: "NEW_AND_HIGH_LTV" }, metrics: { conversions: 10, conversionsValue: 2000 } },
          { campaign: { id: "222", name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX" }, segments: { newVersusReturningCustomers: "RETURNING" }, metrics: { conversions: 60, conversionsValue: 5000 } },
        ]
        : [{ campaign: { id: "222" }, metrics: { costMicros: "2000000000" } }],
    },
  });
  const result = await call(client, "get_new_vs_returning_performance", { days: 30 });
  const [segmented, costs] = calls.queries.map((q) => q.query);
  assert.doesNotMatch(segmented, /cost_micros|clicks|impressions/, "o segmento não combina com métricas de custo/clique");
  assert.doesNotMatch(costs, /new_versus_returning/);
  const [row] = jsonOf(result) as unknown as Row[];
  assert.equal(row.new_share_pct, 40);
  assert.equal(row.approx_cost_per_new_customer_conversion, 50);
});

// ═════════════════════════════ Experimentos ═══════════════════════════

const searchCampaign = (overrides: Row = {}) => ({
  campaign: { id: "111", name: "Pesquisa Marca", status: "ENABLED", advertisingChannelType: "SEARCH", experimentType: "BASE", biddingStrategyType: "MAXIMIZE_CONVERSIONS", ...overrides },
  campaignBudget: { explicitlyShared: false },
});

test("create_experiment SEARCH_CUSTOM: experimento + braços num googleAds:mutate atômico e rascunho devolvido", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: (query) => query.includes("include_drafts")
        ? [{ campaign: { id: "111", name: "Pesquisa Marca", status: "ENABLED", experimentType: "BASE" } }, { campaign: { id: "999", name: "Pesquisa Marca [tCPA]", status: "ENABLED", experimentType: "DRAFT" } }]
        : [searchCampaign()],
      experiment_arm: [
        { experimentArm: { experiment: `customers/${CID}/experiments/321`, name: "Controle", control: true, trafficSplit: "70", campaigns: [`customers/${CID}/campaigns/111`] } },
        { experimentArm: { experiment: `customers/${CID}/experiments/321`, name: "Tratamento", control: false, trafficSplit: "30", inDesignCampaigns: [`customers/${CID}/campaigns/999`] } },
      ],
    },
  });
  const result = await call(client, "create_experiment", {
    type: "SEARCH_CUSTOM", name: "tCPA 80", suffix: " [tCPA]", controlCampaignId: "111", trafficSplit: 30, syncEnabled: true,
  });
  assert.ok(!result.isError, textOf(result));
  const [write] = calls.writes;
  assert.equal(write.kind, "batchMutate");
  const operations = ops(write);
  assert.deepEqual(operations[0], {
    experimentOperation: { create: { resourceName: `customers/${CID}/experiments/-1`, name: "tCPA 80", type: "SEARCH_CUSTOM", suffix: " [tCPA]", status: "SETUP", syncEnabled: true } },
  });
  assert.deepEqual(operations[1], { experimentArmOperation: { create: { experiment: `customers/${CID}/experiments/-1`, name: "Controle", control: true, trafficSplit: 70, campaigns: [`customers/${CID}/campaigns/111`] } } });
  assert.deepEqual(operations[2], { experimentArmOperation: { create: { experiment: `customers/${CID}/experiments/-1`, name: "Tratamento", control: false, trafficSplit: 30 } } });
  assert.ok(calls.queries.some((q) => /FROM experiment_arm[\s\S]*PARAMETERS include_drafts=true/.test(q.query)), "rascunho só aparece com include_drafts");
  assert.match(textOf(result), /ID 321/);
  assert.match(textOf(result), /update_experiment_campaign/);
  const arms = jsonOf(result).arms as Row[];
  assert.deepEqual((arms[1].in_design_campaigns as Row[])[0], { id: "999", name: "Pesquisa Marca [tCPA]", status: "ENABLED", experiment_type: "DRAFT" });
});

test("create_experiment: validação antes de qualquer chamada", async () => {
  for (const args of [
    { type: "SEARCH_CUSTOM", name: "x", controlCampaignId: "111" }, // sem suffix
    { type: "ADOPT_BROAD_MATCH_KEYWORDS", name: "x", controlCampaignId: "111", trafficSplit: 30 },
    { type: "SEARCH_CUSTOM", name: "x", suffix: "s", controlCampaignId: "111", startDate: "2020-01-01" },
    { type: "DISPLAY_CUSTOM", name: "x", suffix: "s", controlCampaignId: "111", startDate: "2099-02-01", endDate: "2099-01-01" },
    { type: "PMAX_REPLACEMENT_SHOPPING", name: "x", suffix: "s", controlCampaignId: "111", syncEnabled: true },
    { type: "COMPARE_CAMPAIGNS", name: "x", arms: [{ name: "A", campaignIds: ["1"], trafficSplit: 60 }, { name: "B", campaignIds: ["2"], trafficSplit: 60 }] },
    { type: "COMPARE_CAMPAIGNS", name: "x", arms: [{ name: "A", campaignIds: ["1", "2"], trafficSplit: 50 }, { name: "B", campaignIds: ["2", "1"], trafficSplit: 50 }] },
    { type: "OPTIMIZE_ASSETS", name: "x", assetGroupId: "5", treatmentTextAssets: [{ fieldType: "HEADLINE", text: "x".repeat(31) }] },
    { type: "SEARCH_CUSTOM", name: "x", suffix: "s", controlCampaignId: "1 OR 1=1" },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_experiment", args);
    assert.ok(result.isError, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("create_experiment: canal errado, orçamento compartilhado e nome repetido são recusados sem gravar", async () => {
  const wrongChannel = fakeClient({ rows: { campaign: [searchCampaign({ advertisingChannelType: "DISPLAY" })] } });
  const channel = await call(wrongChannel.client, "create_experiment", { type: "SEARCH_CUSTOM", name: "x", suffix: "s", controlCampaignId: "111" });
  assert.match(textOf(channel), /exige campanha de controle SEARCH/);

  const shared = fakeClient({ rows: { campaign: [{ ...searchCampaign(), campaignBudget: { explicitlyShared: true } }] } });
  assert.match(textOf(await call(shared.client, "create_experiment", { type: "SEARCH_CUSTOM", name: "x", suffix: "s", controlCampaignId: "111" })), /orçamento compartilhado/);

  const dup = fakeClient({ rows: { experiment: [{ experiment: { experimentId: "5", name: "x", status: "ENABLED" } }] } });
  assert.match(textOf(await call(dup.client, "create_experiment", { type: "SEARCH_CUSTOM", name: "x", suffix: "s", controlCampaignId: "111" })), /Já existe o experimento/);

  for (const { calls } of [wrongChannel, shared, dup]) assert.equal(calls.writes.length, 0);
});

test("create_experiment ADOPT_AI_MAX: mesma campanha nos dois braços e AI Max ligado na mesma operação", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [searchCampaign({
        aiMaxSetting: { enableAiMax: false },
        assetAutomationSettings: [{ assetAutomationType: "GENERATE_IMAGE_EXTRACTION", assetAutomationStatus: "OPTED_OUT" }],
      })],
    },
  });
  const result = await call(client, "create_experiment", { type: "ADOPT_AI_MAX", name: "AI Max", controlCampaignId: "111", aiMaxFinalUrlExpansion: false });
  assert.ok(!result.isError, textOf(result));
  const operations = ops(calls.writes[0]);
  const experiment = (operations[0].experimentOperation as Row).create as Row;
  assert.equal(experiment.status, undefined, "intra-campaign não usa SETUP/sufixo (guia intra-campaign)");
  const arms = operations.slice(1, 3).map((op) => (op.experimentArmOperation as Row).create as Row);
  assert.deepEqual(arms.map((arm) => [arm.control, arm.trafficSplit, arm.campaigns]), [
    [true, 50, [`customers/${CID}/campaigns/111`]],
    [false, 50, [`customers/${CID}/campaigns/111`]],
  ]);
  const campaignOp = operations[3].campaignOperation as { update: Row; updateMask: string };
  assert.equal(campaignOp.updateMask, "ai_max_setting.enable_ai_max,asset_automation_settings");
  assertUpdateMaskLeaves(campaignOp.updateMask);
  assert.deepEqual(campaignOp.update.assetAutomationSettings, [
    { assetAutomationType: "GENERATE_IMAGE_EXTRACTION", assetAutomationStatus: "OPTED_OUT" },
    { assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_IN" },
    { assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_OUT" },
  ], "o tipo que não mexemos é reenviado como estava");

  const already = fakeClient({ rows: { campaign: [searchCampaign({ aiMaxSetting: { enableAiMax: true } })] } });
  assert.match(textOf(await call(already.client, "create_experiment", { type: "ADOPT_AI_MAX", name: "AI Max", controlCampaignId: "111" })), /já está com AI Max ligado/);
  assert.equal(already.calls.writes.length, 0);
});

test("create_experiment COMPARE_CAMPAIGNS e OPTIMIZE_ASSETS: braços e assets com IDs temporários", async () => {
  const compare = fakeClient({ rows: { campaign: [searchCampaign({ id: "1" }), searchCampaign({ id: "2", advertisingChannelType: "PERFORMANCE_MAX" })] } });
  await call(compare.client, "create_experiment", {
    type: "COMPARE_CAMPAIGNS", name: "Mix", arms: [{ name: "Pesquisa", campaignIds: ["1"], trafficSplit: 50 }, { name: "PMax", campaignIds: ["2"], trafficSplit: 50 }],
  });
  const armOps = ops(compare.calls.writes[0]).slice(1).map((op) => (op.experimentArmOperation as Row).create as Row);
  assert.deepEqual(armOps.map((arm) => [arm.name, arm.control, arm.campaigns]), [
    ["Pesquisa", true, [`customers/${CID}/campaigns/1`]],
    ["PMax", false, [`customers/${CID}/campaigns/2`]],
  ]);

  const assets = fakeClient({
    rows: {
      asset_group: [{ assetGroup: { id: "5", name: "Grupo", status: "ENABLED", campaign: `customers/${CID}/campaigns/2` }, campaign: { id: "2", advertisingChannelType: "PERFORMANCE_MAX" } }],
      campaign: [searchCampaign({ id: "2", advertisingChannelType: "PERFORMANCE_MAX" })],
    },
  });
  const result = await call(assets.client, "create_experiment", {
    type: "OPTIMIZE_ASSETS", name: "Títulos", assetGroupId: "5", treatmentTextAssets: [{ fieldType: "HEADLINE", text: "Frete grátis hoje" }],
  });
  assert.ok(!result.isError, textOf(result));
  const operations = ops(assets.calls.writes[0]);
  assert.deepEqual(operations.map((op) => Object.keys(op)[0]), ["assetOperation", "experimentOperation", "experimentArmOperation", "experimentArmOperation", "assetGroupAssetOperation"]);
  assert.deepEqual((operations[0].assetOperation as Row).create, { resourceName: `customers/${CID}/assets/-2`, textAsset: { text: "Frete grátis hoje" } });
  assert.deepEqual(((operations[1].experimentOperation as Row).create as Row).optimizeAssetsExperiment, { optimizeAssetsExperimentSubtype: "COMPARE_ASSETS" });
  const treatment = (operations[3].experimentArmOperation as Row).create as Row;
  assert.deepEqual(treatment.assetGroups, [{ assetGroup: `customers/${CID}/assetGroups/5`, assetGroupAssets: [{ asset: `customers/${CID}/assets/-2`, fieldType: "HEADLINE" }] }]);
});

test("create_experiment: dry-run valida sem ler braços e erro da API vem traduzido", async () => {
  const dry = fakeClient({ rows: { campaign: [searchCampaign()] }, dryRun: true });
  const result = await call(dry.client, "create_experiment", { type: "SEARCH_CUSTOM", name: "x", suffix: " [t]", controlCampaignId: "111" });
  assert.match(textOf(result), /DRY-RUN/);
  assert.ok(dry.calls.writes[0].dryRun, "escrita em dry-run");
  assert.ok(!dry.calls.queries.some((q) => q.query.includes("FROM experiment_arm")), "dry-run não lê braços");

  const failing = fakeClient({ rows: { campaign: [searchCampaign()] }, batchMutate: () => { throw new Error("Google Ads API: x — ExperimentError.DUPLICATE_EXPERIMENT_CAMPAIGN_NAME"); } });
  const failed = await call(failing.client, "create_experiment", { type: "SEARCH_CUSTOM", name: "x", suffix: " [t]", controlCampaignId: "111" });
  assert.ok(failed.isError, textOf(failed));
  assert.match(textOf(failed), /troque o suffix/);
});

const experimentRow = (overrides: Row = {}) => ({
  experiment: {
    resourceName: `customers/${CID}/experiments/321`, experimentId: "321", name: "tCPA 80", type: "SEARCH_CUSTOM", status: "ENABLED",
    startDate: "2026-09-01", endDate: "2026-10-01", ...overrides,
  },
});
const armRows = [
  { experimentArm: { experiment: `customers/${CID}/experiments/321`, name: "Controle", control: true, trafficSplit: "50", campaigns: [`customers/${CID}/campaigns/111`] } },
  { experimentArm: { experiment: `customers/${CID}/experiments/321`, name: "Tratamento", control: false, trafficSplit: "50", campaigns: [`customers/${CID}/campaigns/888`] } },
];

test("list_experiments: braços com campanhas e erros assíncronos (GET)", async () => {
  const { client, calls } = fakeClient({
    rows: { experiment: [experimentRow({ status: "SETUP" })], experiment_arm: armRows, campaign: [{ campaign: { id: "111", name: "Pesquisa Marca", status: "ENABLED", experimentType: "BASE" } }] },
    get: () => ({ errors: [{ code: 3, message: "IN_DESIGN_CAMPAIGNS_NOT_SET" }] }),
  });
  const result = await call(client, "list_experiments", { experimentId: "321" });
  const [view] = jsonOf(result) as unknown as Row[];
  assert.deepEqual(calls.gets, ["experiments/321:listExperimentAsyncErrors"]);
  assert.deepEqual(view.async_errors, [{ code: 3, message: "IN_DESIGN_CAMPAIGNS_NOT_SET" }]);
  assert.equal((view.arms as Row[]).length, 2);
  assert.equal(calls.writes.length, 0);
});

test("get_experiment_results: lift, intervalo, p-valor e veredito por métrica", async () => {
  const { client } = fakeClient({
    rows: {
      experiment: [{
        ...experimentRow(),
        metrics: {
          conversions: 120, controlConversions: 100,
          conversionsAbsoluteChangePointEstimate: 20, conversionsAbsoluteChangeMarginOfError: 8, conversionsAbsoluteChangePValue: 0.01,
          clicks: "1000", controlClicks: "990", clicksPointEstimate: 0.01, clicksMarginOfError: 0.05, clicksPValue: 0.6,
          costPerConversion: 40000000, controlCostPerConversion: 50000000,
          costPerConversionChangePointEstimate: -0.2, costPerConversionMarginOfError: 0.05, costPerConversionPValue: 0.001,
        },
      }],
    },
  });
  const result = await call(client, "get_experiment_results", { experimentId: "321" });
  const metrics = jsonOf(result).metrics as Row[];
  const byKey = new Map(metrics.map((metric) => [metric.metric, metric]));
  assert.equal(byKey.get("conversions")?.verdict, "AUMENTO_SIGNIFICATIVO");
  assert.deepEqual(byKey.get("conversions")?.confidence_interval, [12, 28]);
  assert.equal(byKey.get("conversions")?.favorable, true);
  assert.equal(byKey.get("clicks")?.verdict, "INCONCLUSIVO");
  assert.equal(byKey.get("cost_per_conversion")?.verdict, "QUEDA_SIGNIFICATIVA");
  assert.equal(byKey.get("cost_per_conversion")?.favorable, true, "CPA menor é favorável");
  assert.equal(byKey.get("cost_per_conversion")?.lift, -20);
  assert.equal(byKey.get("cost_per_conversion")?.treatment, 40, "micros viram moeda");
  assert.equal(byKey.get("impressions")?.verdict, "SEM_DADOS");

  const bad = fakeClient();
  assert.ok((await call(bad.client, "get_experiment_results", { experimentId: "321", pValueThreshold: 5 })).isError, "get_experiment_results deveria recusar");
  assert.equal(bad.calls.queries.length, 0);
});

test("schedule_experiment: chama :scheduleExperiment; em dry-run manda validateOnly pelo caminho de leitura", async () => {
  const setupRows = { experiment: [experimentRow({ status: "SETUP" })], experiment_arm: [armRows[0], { experimentArm: { ...(armRows[1].experimentArm as Row), campaigns: [], inDesignCampaigns: [`customers/${CID}/campaigns/999`] } }] };
  const { client, calls } = fakeClient({ rows: setupRows });
  const result = await call(client, "schedule_experiment", { experimentId: "321" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(calls.writes.map((w) => [w.kind, w.target, w.payload]), [["writeAction", "experiments/321:scheduleExperiment", {}]]);

  const dry = fakeClient({ rows: setupRows });
  const dryResult = await call(dry.client, "schedule_experiment", { experimentId: "321", validateOnly: true });
  assert.deepEqual(dry.calls.writes.map((w) => [w.kind, w.target, w.payload]), [["action", "experiments/321:scheduleExperiment", { validateOnly: true }]]);
  assert.match(textOf(dryResult), /nada foi gravado/);

  const running = fakeClient({ rows: { experiment: [experimentRow()], experiment_arm: armRows } });
  assert.match(textOf(await call(running.client, "schedule_experiment", { experimentId: "321" })), /já está agendado/);
  const halted = fakeClient({ rows: { experiment: [experimentRow({ status: "HALTED" })], experiment_arm: armRows } });
  assert.ok((await call(halted.client, "schedule_experiment", { experimentId: "321" })).isError, "schedule_experiment deveria recusar");
  const noDraft = fakeClient({ rows: { experiment: [experimentRow({ status: "SETUP" })], experiment_arm: [armRows[0], { experimentArm: { ...(armRows[1].experimentArm as Row), campaigns: [] } }] } });
  assert.match(textOf(await call(noDraft.client, "schedule_experiment", { experimentId: "321" })), /IN_DESIGN_CAMPAIGNS_NOT_SET/);
  for (const { calls: c } of [running, halted, noDraft]) assert.equal(c.writes.length, 0);
});

test("end/promote_experiment: confirm, tipo e status conferidos antes de gravar", async () => {
  const rows = { experiment: [experimentRow()], experiment_arm: armRows };
  for (const tool of ["end_experiment", "promote_experiment"]) {
    const gate = fakeClient({ rows });
    const refused = await call(gate.client, tool, { experimentId: "321" });
    assert.ok(refused.isError, textOf(refused));
    assert.match(textOf(refused), /confirm: true/);
    assert.equal(gate.calls.writes.length, 0);
  }
  const end = fakeClient({ rows });
  await call(end.client, "end_experiment", { experimentId: "321", confirm: true });
  assert.deepEqual(end.calls.writes.map((w) => w.target), ["experiments/321:endExperiment"]);

  const promote = fakeClient({ rows });
  await call(promote.client, "promote_experiment", { experimentId: "321", confirm: true });
  assert.deepEqual(promote.calls.writes.map((w) => w.target), ["experiments/321:promoteExperiment"]);

  const shopping = fakeClient({ rows: { experiment: [experimentRow({ type: "PMAX_REPLACEMENT_SHOPPING" })], experiment_arm: armRows } });
  assert.match(textOf(await call(shopping.client, "promote_experiment", { experimentId: "321", confirm: true })), /não pode ser promovido/);
  const ended = fakeClient({ rows: { experiment: [experimentRow({ status: "HALTED" })], experiment_arm: armRows } });
  assert.match(textOf(await call(ended.client, "end_experiment", { experimentId: "321", confirm: true })), /já está encerrado/);
  for (const { calls } of [shopping, ended]) assert.equal(calls.writes.length, 0);
});

test("graduate_experiment: mapeia campanha de tratamento → orçamento; intra-campaign não gradua", async () => {
  const rows = {
    experiment: [experimentRow()], experiment_arm: armRows,
    campaign_budget: [{ campaignBudget: { id: "44", name: "Novo", status: "ENABLED", explicitlyShared: false, referenceCount: "0" } }],
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "graduate_experiment", { experimentId: "321", campaignBudgetId: "44", confirm: true });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(calls.writes.map((w) => [w.target, w.payload]), [[
    "experiments/321:graduateExperiment",
    { campaignBudgetMappings: [{ experimentCampaign: `customers/${CID}/campaigns/888`, campaignBudget: `customers/${CID}/campaignBudgets/44` }] },
  ]]);

  const withNew = fakeClient({ rows });
  await call(withNew.client, "graduate_experiment", { experimentId: "321", dailyBudgetMicros: 50_000_000, confirm: true });
  assert.deepEqual(withNew.calls.writes.map((w) => w.target), ["campaignBudgets", "experiments/321:graduateExperiment"]);
  assert.equal(((ops(withNew.calls.writes[0])[0].create as Row).amountMicros), "50000000");

  const dry = fakeClient({ rows, dryRun: true });
  const dryResult = await call(dry.client, "graduate_experiment", { experimentId: "321", dailyBudgetMicros: 50_000_000, confirm: true });
  assert.ok(dryResult.isError, textOf(dryResult));
  assert.equal(dry.calls.queries.length + dry.calls.writes.length, 0, "dry-run com orçamento novo é recusado sem enviar nada");

  const intra = fakeClient({ rows: { ...rows, experiment: [experimentRow({ type: "ADOPT_AI_MAX" })] } });
  assert.match(textOf(await call(intra.client, "graduate_experiment", { experimentId: "321", campaignBudgetId: "44", confirm: true })), /não pode ser graduado/);
  const gate = fakeClient({ rows });
  assert.match(textOf(await call(gate.client, "graduate_experiment", { experimentId: "321", campaignBudgetId: "44" })), /confirm: true/);
  for (const { calls: c } of [intra, gate]) assert.equal(c.writes.length, 0);
});

const mixRows = (extraArm = false) => ({
  experiment: [{ experiment: { resourceName: `customers/${CID}/experiments/9`, experimentId: "9", name: "Mix", type: "COMPARE_CAMPAIGNS", status: "ENABLED" } }],
  experiment_arm: [
    { experimentArm: { experiment: `customers/${CID}/experiments/9`, name: "Controle", control: true, trafficSplit: "50", campaigns: [`customers/${CID}/campaigns/1`] } },
    { experimentArm: { experiment: `customers/${CID}/experiments/9`, name: "Braço B", control: false, trafficSplit: extraArm ? "25" : "50", campaigns: [`customers/${CID}/campaigns/2`] } },
    ...(extraArm ? [{ experimentArm: { experiment: `customers/${CID}/experiments/9`, name: "Braço C", control: false, trafficSplit: "25", campaigns: [`customers/${CID}/campaigns/3`] } }] : []),
  ],
  campaign: [
    { campaign: { id: "1", name: "Pesquisa Controle", status: "ENABLED", experimentType: "BASE" } },
    { campaign: { id: "2", name: "PMax B", status: "ENABLED", experimentType: "BASE" } },
    { campaign: { id: "3", name: "Shopping C", status: "ENABLED", experimentType: "BASE" } },
  ],
  campaign_budget: [{ campaignBudget: { id: "5", name: "Orç", status: "ENABLED", explicitlyShared: false, referenceCount: "0" } }],
});

test("graduate_experiment COMPARE_CAMPAIGNS: prévia e resultado avisam que o controle e os outros braços são pausados", async () => {
  const gate = fakeClient({ rows: mixRows() });
  const preview = await call(gate.client, "graduate_experiment", { experimentId: "9", campaignBudgetId: "5" });
  assert.ok(preview.isError, textOf(preview));
  assert.match(textOf(preview), /confirm: true/);
  assert.match(textOf(preview), /PAUSADAS/);
  assert.match(textOf(preview), /inclusive o controle/);
  const planned = jsonOf(preview);
  assert.deepEqual((planned.campaigns_to_pause as Row[]).map((c) => [c.id, c.name, c.control]), [["1", "Pesquisa Controle", true]]);
  assert.equal((planned.warnings as string[]).length, 1);
  assert.equal(gate.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: mixRows() });
  const result = await call(client, "graduate_experiment", { experimentId: "9", campaignBudgetId: "5", confirm: true });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(calls.writes.map((w) => w.target), ["experiments/9:graduateExperiment"]);
  assert.match(textOf(result), /pausa 1 campanha/);
  assert.deepEqual((jsonOf(result).paused_campaigns as Row[]).map((c) => c.id), ["1"]);

  // Três braços: gradua o B e pausa o controle e o C (nunca a campanha graduada).
  const three = fakeClient({ rows: mixRows(true) });
  const threePreview = jsonOf(await call(three.client, "graduate_experiment", { experimentId: "9", experimentCampaignId: "2", campaignBudgetId: "5" }));
  assert.deepEqual((threePreview.campaigns_to_pause as Row[]).map((c) => [c.id, c.arm]), [["1", "Controle"], ["3", "Braço C"]]);

  // Dry-run: só valida e diz o que seria pausado, sem afirmar que pausou.
  const dry = fakeClient({ rows: mixRows(), dryRun: true });
  const dryResult = await call(dry.client, "graduate_experiment", { experimentId: "9", campaignBudgetId: "5", confirm: true });
  assert.match(textOf(dryResult), /DRY-RUN/);
  assert.match(textOf(dryResult), /Se gravar, 1 campanha\(s\) .* serão pausadas/);
  assert.doesNotMatch(textOf(dryResult), /pausa 1 campanha/);
  assert.deepEqual((jsonOf(dryResult).campaigns_to_pause as Row[]).map((c) => c.id), ["1"]);
});

test("graduate_experiment SEARCH_CUSTOM: controle não muda — sem aviso de pausa", async () => {
  const rows = {
    experiment: [experimentRow()], experiment_arm: armRows,
    campaign_budget: [{ campaignBudget: { id: "44", name: "Novo", status: "ENABLED", explicitlyShared: false, referenceCount: "0" } }],
  };
  const { client } = fakeClient({ rows });
  const preview = await call(client, "graduate_experiment", { experimentId: "321", campaignBudgetId: "44" });
  assert.match(textOf(preview), /confirm: true/);
  assert.doesNotMatch(textOf(preview), /PAUSA/i);
  assert.deepEqual(jsonOf(preview).campaigns_to_pause, []);
});

test("update_experiment_campaign: acha o rascunho do tratamento e só mexe em campanha DRAFT", async () => {
  const draft = { campaign: { id: "999", name: "Pesquisa Marca [tCPA]", status: "ENABLED", experimentType: "DRAFT", biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: {} } };
  const rows = {
    experiment: [experimentRow({ status: "SETUP" })],
    experiment_arm: [armRows[0], { experimentArm: { ...(armRows[1].experimentArm as Row), campaigns: [], inDesignCampaigns: [`customers/${CID}/campaigns/999`] } }],
    campaign: [draft],
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "update_experiment_campaign", { experimentId: "321", biddingStrategy: "MAXIMIZE_CONVERSION_VALUE", targetRoas: 4 });
  assert.ok(!result.isError, textOf(result));
  assert.ok(calls.queries.some((q) => /FROM campaign WHERE campaign\.id = 999[\s\S]*include_drafts=true/.test(q.query)), "query esperada não foi montada");
  const op = ops(mutations(calls)[0])[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "maximize_conversion_value.target_roas");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/campaigns/999`, maximizeConversionValue: { targetRoas: 4 } });

  const same = fakeClient({ rows: { ...rows, campaign: [{ campaign: { ...draft.campaign, maximizeConversions: { targetCpaMicros: "80000000" } } }] } });
  assert.match(textOf(await call(same.client, "update_experiment_campaign", { campaignId: "999", targetCpaMicros: 80_000_000 })), /nada a mudar/);

  const base = fakeClient({ rows: { campaign: [{ campaign: { ...draft.campaign, experimentType: "BASE" } }] } });
  assert.match(textOf(await call(base.client, "update_experiment_campaign", { campaignId: "999", name: "x" })), /update_campaign/);

  const wrong = fakeClient({ rows });
  assert.ok((await call(wrong.client, "update_experiment_campaign", { campaignId: "999", targetRoas: 3 })).isError, "targetRoas não vale para MAXIMIZE_CONVERSIONS");
  for (const { calls: c } of [same, base, wrong]) assert.equal(c.writes.length, 0);
});

test("rascunhos: criar, listar com erros assíncronos e aplicar com confirm", async () => {
  const draftRow = (status: string) => ({
    campaignDraft: {
      resourceName: `customers/${CID}/campaignDrafts/111~7`, draftId: "7", name: "Novos lances", status,
      baseCampaign: `customers/${CID}/campaigns/111`, draftCampaign: `customers/${CID}/campaigns/5555`,
    },
  });
  const create = fakeClient({ rows: { campaign: [searchCampaign()], campaign_draft: (query) => query.includes("resource_name =") ? [draftRow("PROPOSED")] : [] } });
  const created = await call(create.client, "create_campaign_draft", { baseCampaignId: "111", name: "Novos lances" });
  assert.ok(!created.isError, textOf(created));
  assert.deepEqual(ops(mutations(create.calls)[0]), [{ create: { baseCampaign: `customers/${CID}/campaigns/111`, name: "Novos lances" } }]);
  assert.match(textOf(created), /5555/);

  const dup = fakeClient({ rows: { campaign: [searchCampaign()], campaign_draft: [draftRow("PROPOSED")] } });
  assert.ok((await call(dup.client, "create_campaign_draft", { baseCampaignId: "111", name: "Novos lances" })).isError, "create_campaign_draft deveria recusar");
  assert.equal(dup.calls.writes.length, 0);

  const list = fakeClient({ rows: { campaign_draft: [draftRow("PROMOTE_FAILED")] }, get: () => ({ errors: [{ code: 3, message: "falhou" }] }) });
  const listed = jsonOf(await call(list.client, "list_campaign_drafts", {})) as unknown as Row[];
  assert.deepEqual(list.calls.gets, ["campaignDrafts/111~7:listAsyncErrors"]);
  assert.deepEqual(listed[0].async_errors, [{ code: 3, message: "falhou" }]);

  const gate = fakeClient({ rows: { campaign_draft: [draftRow("PROPOSED")] } });
  assert.ok((await call(gate.client, "promote_campaign_draft", { baseCampaignId: "111", draftId: "7" })).isError, "promote_campaign_draft deveria recusar");
  assert.equal(gate.calls.writes.length, 0);
  const promote = fakeClient({ rows: { campaign_draft: [draftRow("PROPOSED")] } });
  await call(promote.client, "promote_campaign_draft", { baseCampaignId: "111", draftId: "7", confirm: true });
  assert.deepEqual(promote.calls.writes.map((w) => w.target), ["campaignDrafts/111~7:promote"]);
  const done = fakeClient({ rows: { campaign_draft: [draftRow("PROMOTED")] } });
  assert.match(textOf(await call(done.client, "promote_campaign_draft", { baseCampaignId: "111", draftId: "7", confirm: true })), /já aplicado/);
  assert.equal(done.calls.writes.length, 0);
});

// ═════════════════════════════ Rastreamento ═══════════════════════════

test("get_tracking_settings: efetivo por grupo, sobreposições e parâmetros usados sem definição", async () => {
  const { client } = fakeClient({
    rows: {
      customer: [{ customer: { id: CID, trackingUrlTemplate: "{lpurl}?src=conta", finalUrlSuffix: "" } }],
      campaign: [{ campaign: { id: "111", name: "Pesquisa", status: "ENABLED", finalUrlSuffix: "utm_campaign={_camp}", urlCustomParameters: [{ key: "camp", value: "marca" }] } }],
      ad_group: [
        { adGroup: { id: "10", name: "Grupo A", status: "ENABLED", trackingUrlTemplate: "https://track.exemplo.com/?u={lpurl}&g={_grupo}" }, campaign: { id: "111" } },
        { adGroup: { id: "11", name: "Grupo B", status: "ENABLED" }, campaign: { id: "111" } },
      ],
      ad_group_ad: [
        { adGroupAd: { status: "ENABLED", ad: { id: "900", type: "RESPONSIVE_SEARCH_AD", trackingUrlTemplate: "{lpurl}?ad=1" } }, adGroup: { id: "11" }, campaign: { id: "111" } },
        { adGroupAd: { status: "ENABLED", ad: { id: "901", type: "RESPONSIVE_SEARCH_AD" } }, adGroup: { id: "11" }, campaign: { id: "111" } },
      ],
      ad_group_criterion: [],
    },
  });
  const result = await call(client, "get_tracking_settings", {});
  const body = jsonOf(result);
  const effective = body.effective_by_ad_group as Row[];
  assert.deepEqual(effective.map((row) => [row.ad_group_id, row.template_source, row.suffix_source]), [["10", "adGroup", "campaign"], ["11", "account", "campaign"]]);
  const issues = (body.issues as Row[]).map((issue) => `${issue.issue}:${issue.ad_group_id ?? issue.campaign_id}`);
  assert.ok(issues.includes("PARAMETRO_NAO_DEFINIDO:10"), "{_grupo} sem parâmetro");
  assert.ok(issues.includes("SOBREPOSICAO:11"), "anúncio 900 sobrepõe o modelo da conta");
  assert.deepEqual(((body.overrides as Row).ads as Row[]).map((ad) => ad.id), ["11~900"], "só anúncios que definem algo");
});

const trackedCampaign = (id: string, overrides: Row = {}) => ({
  campaign: { id, name: `C${id}`, status: "ENABLED", trackingUrlTemplate: "", finalUrlSuffix: "utm_source=google", urlCustomParameters: [{ key: "camp", value: "old" }, { key: "keep", value: "1" }], ...overrides },
});

test("set_tracking campaign: mescla parâmetros, pula quem já está igual e usa partial failure", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [trackedCampaign("1"), trackedCampaign("2", { finalUrlSuffix: "utm_source=google&utm_medium=cpc", urlCustomParameters: [{ key: "camp", value: "novo" }] })] },
  });
  const result = await call(client, "set_tracking", {
    level: "campaign", ids: ["1", "2", "3"], finalUrlSuffix: "utm_source=google&utm_medium=cpc", customParameters: [{ key: "camp", value: "novo" }],
  });
  const [write] = mutations(calls);
  assert.equal(write.target, "campaigns");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(ops(write), [{
    update: { resourceName: `customers/${CID}/campaigns/1`, finalUrlSuffix: "utm_source=google&utm_medium=cpc", urlCustomParameters: [{ key: "keep", value: "1" }, { key: "camp", value: "novo" }] },
    updateMask: "final_url_suffix,url_custom_parameters",
  }]);
  const body = jsonOf(result);
  assert.deepEqual(body.not_found, ["3"]);
  assert.deepEqual(body.unchanged, ["Campanha 2 (\"C2\")"]);
  assert.ok(calls.queries[0].query.includes("include_drafts=true"), "rascunhos de experimento também podem ser ajustados");
});

test("set_tracking: entrada inválida não consulta nem grava", async () => {
  for (const args of [
    { level: "campaign", ids: ["1"], finalUrlSuffix: "?utm_source=google" },
    { level: "campaign", ids: ["1"], finalUrlSuffix: "u={lpurl}" },
    { level: "campaign", ids: ["1"], trackingUrlTemplate: "track.com/?u={lpurl}" },
    { level: "campaign", ids: ["1"], customParameters: [{ key: "_utm-x", value: "a" }] },
    { level: "campaign", ids: ["1"], customParameters: [{ key: "a", value: "x".repeat(201) }] },
    { level: "campaign", ids: ["1"], customParameters: [{ key: "a", value: "1" }, { key: "A", value: "2" }] },
    { level: "account", customParameters: [{ key: "a", value: "1" }] },
    { level: "keyword", ids: ["123"], finalUrlSuffix: "a=1" },
    { level: "campaign", ids: ["1"] },
    { level: "campaign", ids: ["1"], trackingUrlTemplate: "{lpurl}", clear: ["trackingUrlTemplate"] },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_tracking", args);
    assert.ok(result.isError, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("set_tracking: limite de 8 parâmetros, clear e erro por operação", async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ key: `k${index}`, value: "1" }));
  const full = fakeClient({ rows: { campaign: [trackedCampaign("1", { urlCustomParameters: many })] } });
  const refused = await call(full.client, "set_tracking", { level: "campaign", ids: ["1"], customParameters: [{ key: "novo", value: "1" }] });
  assert.match(textOf(refused), /máx\. 8/);
  assert.equal(full.calls.writes.length, 0);

  const clear = fakeClient({ rows: { campaign: [trackedCampaign("1", { trackingUrlTemplate: "{lpurl}?a=1" })] } });
  await call(clear.client, "set_tracking", { level: "campaign", ids: ["1"], clear: ["trackingUrlTemplate", "customParameters"] });
  const op = ops(mutations(clear.calls)[0])[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "tracking_url_template,url_custom_parameters");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/campaigns/1`, urlCustomParameters: [] }, "limpar = caminho na máscara sem valor");

  const partial = fakeClient({
    rows: { campaign: [trackedCampaign("1"), trackedCampaign("2")] },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaigns/1` }, {}],
      partialFailureError: { message: "x", details: [{ errors: [{ message: "sufixo inválido", errorCode: { urlFieldError: "FINAL_URL_SUFFIX_MALFORMED" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const result = await call(partial.client, "set_tracking", { level: "campaign", ids: ["1", "2"], finalUrlSuffix: "a=b" });
  assert.ok(result.isError, textOf(result));
  const body = jsonOf(result);
  assert.equal((body.updated as Row[]).length, 1);
  assert.match(String((body.errors as Row[])[0].error), /Como resolver: o sufixo não pode começar/);
});

test("set_tracking keyword/ad: aviso de revisão com confirm; conta via customers:mutate", async () => {
  const keywordRows = { ad_group_criterion: [{ adGroupCriterion: { criterionId: "77", status: "ENABLED", keyword: { text: "tenis", matchType: "PHRASE" }, finalUrls: ["https://loja.com.br"] }, adGroup: { id: "10" } }] };
  const gate = fakeClient({ rows: keywordRows });
  const refused = await call(gate.client, "set_tracking", { level: "keyword", ids: ["10~77"], trackingUrlTemplate: "{lpurl}?kw={keyword}" });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /revisão/);
  assert.equal(gate.calls.writes.length, 0);
  const keyword = fakeClient({ rows: keywordRows });
  await call(keyword.client, "set_tracking", { level: "keyword", ids: ["10~77"], trackingUrlTemplate: "{lpurl}?kw={keyword}", confirm: true });
  assert.deepEqual(ops(mutations(keyword.calls)[0])[0], {
    update: { resourceName: `customers/${CID}/adGroupCriteria/10~77`, trackingUrlTemplate: "{lpurl}?kw={keyword}" }, updateMask: "tracking_url_template",
  });

  const ad = fakeClient({ rows: { ad_group_ad: [{ adGroupAd: { status: "ENABLED", ad: { id: "900", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://loja.com.br"] } }, adGroup: { id: "10" } }] } });
  await call(ad.client, "set_tracking", { level: "ad", ids: ["900"], finalUrlSuffix: "a=1", confirm: true });
  assert.equal(mutations(ad.calls)[0].target, "ads");
  assert.equal((ops(mutations(ad.calls)[0])[0].update as Row).resourceName, `customers/${CID}/ads/900`);

  const accountRows = { customer: [{ customer: { id: CID, descriptiveName: "Loja", trackingUrlTemplate: "", finalUrlSuffix: "" } }] };
  const account = fakeClient({ rows: accountRows });
  await call(account.client, "set_tracking", { level: "account", finalUrlSuffix: "utm_source=google", confirm: true });
  assert.deepEqual(account.calls.writes.map((w) => [w.kind, w.target, w.payload]), [[
    "writeAction", ":mutate", { operation: { update: { resourceName: `customers/${CID}`, finalUrlSuffix: "utm_source=google" }, updateMask: "final_url_suffix" } },
  ]]);
  const dry = fakeClient({ rows: accountRows, dryRun: true });
  const dryResult = await call(dry.client, "set_tracking", { level: "account", finalUrlSuffix: "utm_source=google", confirm: true });
  assert.equal(dry.calls.writes[0].kind, "action");
  assert.equal((dry.calls.writes[0].payload as Row).validateOnly, true);
  assert.match(textOf(dryResult), /DRY-RUN/);
});

test("set_tracking account: sem confirm não reescreve o modelo/sufixo da conta", async () => {
  const accountRows = { customer: [{ customer: { id: CID, descriptiveName: "Loja", trackingUrlTemplate: "{lpurl}?a=1", finalUrlSuffix: "" } }] };
  const gate = fakeClient({ rows: accountRows });
  const refused = await call(gate.client, "set_tracking", { level: "account", trackingUrlTemplate: "{lpurl}?b=2" });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /confirm: true/);
  assert.match(textOf(refused), /todas as campanhas/);
  assert.deepEqual(jsonOf(refused), { before: { tracking_url_template: "{lpurl}?a=1" }, after: { tracking_url_template: "{lpurl}?b=2" } });
  assert.equal(gate.calls.writes.length, 0);
});

test("set_tracking ad: sem confirm não manda anúncio para revisão", async () => {
  const gate = fakeClient({ rows: { ad_group_ad: [{ adGroupAd: { status: "ENABLED", ad: { id: "900", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://loja.com.br"] } }, adGroup: { id: "10" } }] } });
  const refused = await call(gate.client, "set_tracking", { level: "ad", ids: ["10~900"], finalUrlSuffix: "a=1" });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /revisão/);
  assert.equal(gate.calls.writes.length, 0);
});

// ═══════════════════════════════ Rótulos ══════════════════════════════

test("create_label: cor e descrição; nome repetido não cria; validação antes da API", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_label", { name: " Black Friday ", backgroundColor: "#FF9900", description: "Campanhas BF" });
  assert.ok(!result.isError, textOf(result));
  assert.deepEqual(ops(mutations(calls)[0]), [{ create: { name: "Black Friday", textLabel: { backgroundColor: "#FF9900", description: "Campanhas BF" } } }]);
  assert.match(textOf(result), /ID 1/);

  const dup = fakeClient({ rows: { label: [{ label: { id: "8", name: "Black Friday", status: "ENABLED" } }] } });
  assert.match(textOf(await call(dup.client, "create_label", { name: "Black Friday" })), /já existe \(ID 8\)/);
  assert.equal(dup.calls.writes.length, 0);

  for (const args of [{ name: "" }, { name: "x", backgroundColor: "laranja" }, { name: "x", description: "d".repeat(201) }]) {
    const bad = fakeClient();
    assert.ok((await call(bad.client, "create_label", args)).isError, "create_label deveria recusar");
    assert.equal(bad.calls.queries.length + bad.calls.writes.length, 0);
  }
  const dry = fakeClient({ dryRun: true });
  assert.match(textOf(await call(dry.client, "create_label", { name: "BF" })), /DRY-RUN/);
});

const labelRow = { label: { id: "8", name: "BF", status: "ENABLED" } };

test("assign_label: vários itens, já vinculados não reenviam, não encontrados e erro por item", async () => {
  const { client, calls } = fakeClient({
    rows: {
      label: [labelRow],
      campaign: [{ campaign: { id: "1", status: "ENABLED" } }, { campaign: { id: "2", status: "ENABLED" } }, { campaign: { id: "3", status: "ENABLED" } }],
      campaign_label: [{ campaign: { id: "2" }, campaignLabel: { resourceName: `customers/${CID}/campaignLabels/2~8` } }],
    },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaignLabels/1~8` }, {}],
      partialFailureError: { details: [{ errors: [{ message: "limite", errorCode: { labelError: "EXCEEDED_LABEL_LIMIT_PER_TYPE" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const result = await call(client, "assign_label", { resourceType: "campaign", resourceIds: ["1", "2", "3", "4"], labelId: "8" });
  const [write] = mutations(calls);
  assert.equal(write.target, "campaignLabels");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(ops(write), [
    { create: { campaign: `customers/${CID}/campaigns/1`, label: `customers/${CID}/labels/8` } },
    { create: { campaign: `customers/${CID}/campaigns/3`, label: `customers/${CID}/labels/8` } },
  ]);
  const body = jsonOf(result);
  assert.deepEqual(body.assigned, [{ id: "1" }]);
  assert.deepEqual(body.unchanged, ["2"]);
  assert.deepEqual(body.not_found, ["4"]);
  assert.deepEqual((body.errors as Row[]).map((e) => e.id), ["3"]);
});

test("assign_label: compatível com resourceId; palavra-chave negativa; unassign pede confirm", async () => {
  const compat = fakeClient({ rows: { label: [labelRow], ad_group: [{ adGroup: { id: "5", status: "ENABLED" } }] } });
  await call(compat.client, "assign_label", { resourceType: "adGroup", resourceId: "5", labelId: "8" });
  assert.deepEqual(ops(mutations(compat.calls)[0]), [{ create: { adGroup: `customers/${CID}/adGroups/5`, label: `customers/${CID}/labels/8` } }]);

  const negative = fakeClient({ rows: { label: [labelRow], ad_group_criterion: [{ adGroup: { id: "5" }, adGroupCriterion: { criterionId: "77", status: "ENABLED", negative: true } }] } });
  const negResult = await call(negative.client, "assign_label", { resourceType: "adGroupCriterion", resourceIds: ["5~77"], labelId: "8" });
  assert.match(textOf(negResult), /negativa/);
  assert.equal(negative.calls.writes.length, 0);

  const linked = { label: [labelRow], ad_group_ad: [{ adGroup: { id: "5" }, adGroupAd: { status: "ENABLED", ad: { id: "900" } } }], ad_group_ad_label: [{ adGroup: { id: "5" }, adGroupAd: { ad: { id: "900" } }, adGroupAdLabel: { resourceName: `customers/${CID}/adGroupAdLabels/5~900~8` } }] };
  const gate = fakeClient({ rows: linked });
  assert.match(textOf(await call(gate.client, "assign_label", { resourceType: "adGroupAd", resourceIds: ["5~900"], labelId: "8", action: "unassign" })), /confirm: true/);
  assert.equal(gate.calls.writes.length, 0);
  const unassign = fakeClient({ rows: linked });
  await call(unassign.client, "assign_label", { resourceType: "adGroupAd", resourceIds: ["5~900"], labelId: "8", action: "unassign", confirm: true });
  assert.deepEqual(ops(mutations(unassign.calls)[0]), [{ remove: `customers/${CID}/adGroupAdLabels/5~900~8` }]);

  const bad = fakeClient();
  assert.ok((await call(bad.client, "assign_label", { resourceType: "adGroupAd", resourceIds: ["900"], labelId: "8" })).isError, "assign_label deveria recusar");
  assert.equal(bad.calls.queries.length, 0);
});

test("assign_label customer: rótulo do MCC aplicado em cada conta cliente, uma requisição por conta", async () => {
  const CLIENT_A = "1111111111";
  const CLIENT_B = "2222222222";
  const { client, calls } = fakeClient({
    rows: {
      label: [labelRow],
      customer_label: (_query, cid) => cid === CLIENT_B ? [{ customerLabel: { resourceName: `customers/${CLIENT_B}/customerLabels/8`, label: `customers/${MCC}/labels/8` } }] : [],
    },
  });
  const result = await register(client).get("assign_label")!({ customerId: MCC, resourceType: "customer", resourceIds: ["111-111-1111", CLIENT_B], labelId: "8" });
  assert.deepEqual(mutations(calls).map((w) => [w.cid, w.target, w.payload]), [[CLIENT_A, "customerLabels", [{ create: { label: `customers/${MCC}/labels/8` } }]]]);
  assert.deepEqual(jsonOf(result).unchanged, [CLIENT_B]);

  const denied = fakeClient({ rows: { label: [labelRow] } });
  const refused = await register(denied.client, [MCC, CLIENT_A], true).get("assign_label")!({ customerId: MCC, resourceType: "customer", resourceIds: [CLIENT_B], labelId: "8" });
  assert.match(textOf(refused), /fora da allowlist/);
  assert.equal(denied.calls.queries.length, 0);
});

test("list_labels: cor, descrição e contagem de uso", async () => {
  const { client } = fakeClient({
    rows: {
      label: [{ label: { id: "8", name: "BF", status: "ENABLED", textLabel: { backgroundColor: "#FF9900", description: "Black Friday" } } }],
      campaign_label: [{ label: { id: "8" } }, { label: { id: "8" } }],
      ad_group_criterion_label: [{ label: { id: "8" } }],
      customer_label: [],
    },
  });
  const [label] = jsonOf(await call(client, "list_labels", {})) as unknown as Row[];
  assert.deepEqual(label, { id: "8", name: "BF", status: "ENABLED", background_color: "#FF9900", description: "Black Friday", campaigns: 2, ad_groups: 0, ads: 0, keywords: 1, accounts: 0 });
});

test("update_label e remove_label: só folhas no updateMask, no-op e confirm", async () => {
  const rows = { label: (query: string) => query.includes("label.name =") ? [] : [{ label: { id: "8", name: "BF", status: "ENABLED", textLabel: { backgroundColor: "#FF9900", description: "velha" } } }] };
  const { client, calls } = fakeClient({ rows: { label: rows.label } });
  await call(client, "update_label", { labelId: "8", backgroundColor: "#ff9900", description: "" , name: "Black Friday" });
  const op = ops(mutations(calls)[0])[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "name,text_label.description", "cor igual (sem diferenciar maiúsculas) não vai");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/labels/8`, name: "Black Friday" });

  const same = fakeClient({ rows: { label: rows.label } });
  assert.match(textOf(await call(same.client, "update_label", { labelId: "8", backgroundColor: "#FF9900" })), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const gate = fakeClient({ rows: { label: rows.label, campaign_label: [{ campaignLabel: { resourceName: "x" } }] } });
  const preview = await call(gate.client, "remove_label", { labelId: "8" });
  assert.ok(preview.isError, textOf(preview));
  assert.match(textOf(preview), /"campaigns": 1/);
  assert.equal(gate.calls.writes.length, 0);
  const remove = fakeClient({ rows: { label: rows.label } });
  await call(remove.client, "remove_label", { labelId: "8", confirm: true });
  assert.deepEqual(ops(mutations(remove.calls)[0]), [{ remove: `customers/${CID}/labels/8` }]);
});

test("update_label: renomear para o nome de outro rótulo ativo não grava", async () => {
  const byName = [
    { label: { id: "9", name: "Natal", status: "ENABLED" } },
    { label: { id: "10", name: "Natal", status: "REMOVED" } },
  ];
  const clashRows = (query: string) => query.includes("label.name =") ? byName : [{ label: { id: "8", name: "BF", status: "ENABLED" } }];
  const clash = fakeClient({ rows: { label: clashRows } });
  const refused = await call(clash.client, "update_label", { labelId: "8", name: "Natal" });
  assert.ok(refused.isError, textOf(refused));
  assert.match(textOf(refused), /Já existe o rótulo "Natal" \(ID 9\)/);
  assert.equal(clash.calls.writes.length, 0);

  // Só um rótulo REMOVIDO com o nome não bloqueia.
  const removedOnly = (query: string) => query.includes("label.name =") ? [byName[1]] : [{ label: { id: "8", name: "BF", status: "ENABLED" } }];
  const free = fakeClient({ rows: { label: removedOnly } });
  await call(free.client, "update_label", { labelId: "8", name: "Natal" });
  assert.deepEqual(ops(mutations(free.calls)[0]), [{ update: { resourceName: `customers/${CID}/labels/8`, name: "Natal" }, updateMask: "name" }]);
});

// Rótulo de MCC aplicado em contas: o CustomerLabel mora na conta cliente, então o MCC só enxerga o uso
// por customer_client.applied_labels. customer_label consultado no MCC não traz os clientes.
const mccLabelRows = {
  label: [
    { label: { id: "44", name: "Black Friday", status: "ENABLED" } },
    { label: { id: "45", name: "Natal", status: "ENABLED" } },
  ],
  customer_client: (_query: string, cid: string) => cid !== MCC ? [] : [
    { customerClient: { id: MCC, appliedLabels: [] } },
    { customerClient: { id: "5556667778", appliedLabels: [`customers/${MCC}/labels/44`] } },
    { customerClient: { id: "1112223334", appliedLabels: [`customers/${MCC}/labels/44`, `customers/${MCC}/labels/45`] } },
    { customerClient: { id: "7778889990", appliedLabels: ["customers/1231231234/labels/44"] } },
  ],
  customer_label: (_query: string, cid: string) => cid === "5556667778"
    ? [{ customerLabel: { resourceName: "customers/5556667778/customerLabels/44", label: `customers/${MCC}/labels/44` } }]
    : [],
};

test("list_labels no MCC: contas rotuladas vêm de customer_client.applied_labels", async () => {
  const { client, calls } = fakeClient({ rows: mccLabelRows });
  const result = await register(client).get("list_labels")!({ customerId: MCC });
  const labels = jsonOf(result) as unknown as Row[];
  assert.deepEqual(labels.map((label) => [label.id, label.accounts]), [["44", 2], ["45", 1]], "rótulo de outro dono não conta");
  assert.ok(calls.queries.some((q) => q.cid === MCC && /FROM customer_client/.test(q.query)), "query esperada não foi montada");
  assert.ok(!calls.queries.some((q) => /FROM customer_label/.test(q.query)), "customer_label no MCC não enxerga os clientes");
});

test("remove_label no MCC: prévia conta as contas clientes com o rótulo", async () => {
  const { client, calls } = fakeClient({ rows: mccLabelRows });
  const preview = await register(client).get("remove_label")!({ customerId: MCC, labelId: "44" });
  assert.ok(preview.isError, textOf(preview));
  assert.match(textOf(preview), /"accounts": 2/);
  assert.ok(calls.queries.some((q) => q.query.includes(`customer_client.applied_labels CONTAINS ANY ('customers/${MCC}/labels/44')`)), "query esperada não foi montada");
  assert.equal(calls.writes.length, 0);
});

test("get_label_performance: filtro CONTAINS ANY pelo resource name do rótulo e total do conjunto", async () => {
  const { client, calls } = fakeClient({
    rows: {
      label: [labelRow],
      campaign: [
        { campaign: { id: "1", name: "A", status: "ENABLED", labels: [`customers/${CID}/labels/8`] }, metrics: { impressions: "100", clicks: "10", costMicros: "20000000", conversions: 2, conversionsValue: 100 } },
        { campaign: { id: "2", name: "B", status: "PAUSED", labels: [`customers/${CID}/labels/8`] }, metrics: { impressions: "50", clicks: "5", costMicros: "10000000", conversions: 1, conversionsValue: 20 } },
      ],
    },
  });
  const result = await call(client, "get_label_performance", { labelIds: ["8"], days: 7 });
  assert.match(calls.queries[1].query, new RegExp(`campaign\\.labels CONTAINS ANY \\('customers/${CID}/labels/8'\\)`));
  const body = jsonOf(result);
  assert.equal((body.total as Row).spend, 30);
  assert.equal((body.items as Row[])[0].labels, "BF");

  const unknown = fakeClient();
  assert.ok((await call(unknown.client, "get_label_performance", { labelIds: ["9"] })).isError, "get_label_performance deveria recusar");
  for (const level of ["adGroup", "ad", "keyword"]) {
    const each = fakeClient({ rows: { label: [labelRow] } });
    await call(each.client, "get_label_performance", { labelIds: ["8"], level, match: "ALL" });
    assert.match(each.calls.queries[1].query, /CONTAINS ALL/);
  }
});

test("update_status_by_label: prévia sem confirm, só muda quem está diferente, dry-run", async () => {
  const rows = {
    label: [labelRow],
    ad_group: [{ adGroup: { id: "1", name: "A", status: "ENABLED" } }, { adGroup: { id: "2", name: "B", status: "PAUSED" } }],
  };
  const gate = fakeClient({ rows });
  const preview = await call(gate.client, "update_status_by_label", { labelIds: ["8"], resourceType: "adGroup", status: "PAUSED" });
  assert.ok(preview.isError, textOf(preview));
  assert.match(textOf(preview), /confirm: true/);
  assert.equal(gate.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "update_status_by_label", { labelIds: ["8"], resourceType: "adGroup", status: "PAUSED", confirm: true });
  assert.deepEqual(ops(mutations(calls)[0]), [{ update: { resourceName: `customers/${CID}/adGroups/1`, status: "PAUSED" }, updateMask: "status" }]);
  assert.deepEqual(jsonOf(result).already, ["2"]);

  const dry = fakeClient({ rows, dryRun: true });
  const dryResult = await call(dry.client, "update_status_by_label", { labelIds: ["8"], resourceType: "adGroup", status: "PAUSED", confirm: true });
  assert.match(textOf(dryResult), /DRY-RUN/);
  assert.doesNotMatch(textOf(dryResult), /→ PAUSED/);
});

test("cobertura de GAQL: todo nível/tipo monta query válida para a v25", async () => {
  const everything = {
    label: [labelRow],
    customer: [customerRow()],
    campaign: [searchCampaign()],
    ad_group: [{ adGroup: { id: "5", name: "G", status: "ENABLED" }, campaign: { id: "111" } }],
    experiment: [experimentRow()],
    experiment_arm: armRows,
    campaign_draft: [],
  };
  const runs: Array<[string, Row]> = [
    ...["campaign", "adGroup", "ad", "keyword"].map((resourceType) => ["update_status_by_label", { labelIds: ["8"], resourceType, status: "PAUSED" }] as [string, Row]),
    ...["campaign", "adGroup", "ad", "keyword"].map((level) => ["set_tracking", { level, ids: level === "keyword" ? ["5~7"] : ["5"], finalUrlSuffix: "a=1", confirm: true }] as [string, Row]),
    ["get_tracking_settings", { campaignId: "111", levels: ["account", "campaign", "adGroup", "ad", "keyword"] }],
    ["get_lifecycle_goals", { campaignId: "111" }],
    ["list_experiments", { includeRemoved: true }],
    ["list_campaign_drafts", { baseCampaignId: "111", includeRemoved: true }],
    ["get_new_vs_returning_performance", { campaignId: "111", dateRange: { since: "2026-08-01", until: "2026-08-31" } }],
    ["list_labels", { includeRemoved: true }],
    ["remove_label", { labelId: "8" }],
  ];
  for (const [tool, args] of runs) {
    const { client, calls } = fakeClient({ rows: everything });
    await call(client, tool, args);
    assert.ok(calls.queries.length > 0, `${tool} ${JSON.stringify(args)} não montou query`);
  }
});

test("allowlist: toda tool nova recusa conta fora da lista antes de qualquer chamada", async () => {
  const tools = [
    "get_lifecycle_goals", "set_new_customer_acquisition", "tag_user_list_customer_type", "get_new_vs_returning_performance",
    "create_experiment", "list_experiments", "get_experiment_results", "schedule_experiment", "end_experiment",
    "promote_experiment", "graduate_experiment", "update_experiment_campaign", "create_campaign_draft", "list_campaign_drafts",
    "promote_campaign_draft", "get_tracking_settings", "set_tracking", "update_label", "remove_label", "get_label_performance",
    "update_status_by_label", "create_label", "assign_label", "list_labels",
  ];
  for (const tool of tools) {
    const { client, calls } = fakeClient();
    const result = await register(client, ["5555555555"], true).get(tool)!({ customerId: CID });
    assert.match(textOf(result), /Access denied/, tool);
    assert.equal(calls.queries.length + calls.writes.length, 0, tool);
  }
});
