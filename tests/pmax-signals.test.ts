/**
 * Lote pmax-signals: sinais de PMax (públicos e temas), automação de assets e expansão de URL,
 * diretrizes de marca, prévias compartilháveis e combinações de assets — mais as tools do núcleo
 * add_audience_signal, create_audience_from_lists e get_asset_group_performance.
 *
 * O que estes testes fixam, por tool:
 * - o payload/query exato que vai para a API (toda query passa por tests/gaql-rules.ts);
 * - entrada inválida é recusada antes de qualquer chamada;
 * - sem mudança não há escrita; remoção exige confirm;
 * - erro da API volta traduzido; partial failure vira relatório por item;
 * - dry-run/validateOnly: nada é gravado, e endpoints sem validate_only não são chamados.
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
const CAMPAIGN = "555";
const AG = "777";
const AG_RN = `customers/${CID}/assetGroups/${AG}`;

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  rows?: Record<string, Row[] | ((query: string) => Row[])>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
  batchMutate?: (operations: Row[]) => Row;
  mutateCampaigns?: (operations: Row[]) => Row;
  action?: (action: string, body: Row) => Row;
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
    actions: [] as Array<{ method: string; action: string; body: Row; dryRun: boolean }>,
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
      const source = opts.rows?.[from];
      return typeof source === "function" ? source(query) : source ?? [];
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations, options);
      if (dryRun) return {};
      return { results: operations.map((_op, i) => ({ resourceName: `customers/${CID}/${resource}/${900 + i}` })) };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => {
          const key = Object.keys(op)[0].replace(/Operation$/, "Result");
          return { [key]: { resourceName: `customers/${CID}/created/${i}` } };
        }),
      };
    },
    async mutateCampaigns(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateCampaigns", operations, dryRun });
      if (opts.mutateCampaigns) return opts.mutateCampaigns(operations);
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/campaigns/${CAMPAIGN}` }] };
    },
    async customerAction(_customerId: string, action: string, body: Row): Promise<Row> {
      calls.actions.push({ method: "customerAction", action, body, dryRun });
      return opts.action ? opts.action(action, body) : {};
    },
    async customerWriteAction(_customerId: string, action: string, body: Row): Promise<Row> {
      // mesmo comportamento do client real: fail-closed em dry-run
      if (dryRun) throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      calls.actions.push({ method: "customerWriteAction", action, body, dryRun });
      return opts.action ? opts.action(action, body) : {};
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, [], false);
  return handlers;
}

const call = (client: unknown, tool: string, args: Row) => {
  const handler = register(client).get(tool);
  assert.ok(handler, `tool ${tool} não registrada`);
  return handler({ customerId: CID, ...args });
};

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = Math.min(...["{", "["].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as Row;
}

const nothingSent = (calls: { writes: Write[]; actions: unknown[] }) => {
  assert.equal(calls.writes.length, 0, "nenhuma escrita");
  assert.equal(calls.actions.length, 0, "nenhuma ação");
};

// ── Fixtures ──────────────────────────────────────────────────────────

function assetGroupRow(overrides: Row = {}, campaign: Row = {}): Row {
  return {
    assetGroup: {
      id: AG, name: "Tênis", status: "ENABLED", resourceName: AG_RN, finalUrls: ["https://loja.com.br/tenis"], ...overrides,
    },
    campaign: { id: CAMPAIGN, name: "PMax Loja", advertisingChannelType: "PERFORMANCE_MAX", status: "ENABLED", ...campaign },
  };
}

function themeSignal(id: string, textValue: string, approvalStatus = "APPROVED", assetGroupId = AG, reasons: string[] = []): Row {
  return {
    assetGroupSignal: {
      resourceName: `customers/${CID}/assetGroupSignals/${assetGroupId}~${id}`,
      approvalStatus,
      searchTheme: { text: textValue },
      ...(reasons.length ? { disapprovalReasons: reasons } : {}),
    },
    assetGroup: { id: assetGroupId, name: `Grupo ${assetGroupId}`, status: "ENABLED" },
    campaign: { id: CAMPAIGN, name: "PMax Loja" },
  };
}

function audienceSignal(id: string, audience: string, assetGroupId = AG): Row {
  return {
    assetGroupSignal: { resourceName: `customers/${CID}/assetGroupSignals/${assetGroupId}~${id}`, audience: { audience } },
    assetGroup: { id: assetGroupId, name: `Grupo ${assetGroupId}`, status: "ENABLED" },
    campaign: { id: CAMPAIGN, name: "PMax Loja" },
  };
}

const AUD_RN = `customers/${CID}/audiences/44`;
function audienceRow(overrides: Row = {}): Row {
  return {
    audience: {
      resourceName: AUD_RN, id: "44", name: "Compradores", status: "ENABLED", scope: "CUSTOMER",
      dimensions: [
        { audienceSegments: { segments: [{ userList: { userList: `customers/${CID}/userLists/10` } }] } },
        { age: { ageRanges: [{ minAge: 25, maxAge: 34 }], includeUndetermined: false } },
      ],
      exclusionDimension: { exclusions: [{ userList: { userList: `customers/${CID}/userLists/11` } }] },
      ...overrides,
    },
  };
}

/** Segmentos que existem na conta: user lists 10, 11, 12; interesse 80432; custom audience 5; life event 3; detailed demographic 2. */
const segmentRows: Record<string, (query: string) => Row[]> = {
  user_list: (q) => ["10", "11", "12"].filter((id) => new RegExp(`\\b${id}\\b`).test(q.split("IN")[1] ?? ""))
    .map((id) => ({ userList: { id, name: `Lista ${id}`, membershipStatus: "OPEN", sizeForDisplay: "5000", sizeForSearch: "3000" } })),
  user_interest: (q) => (q.includes("80432") ? [{ userInterest: { userInterestId: "80432", name: "Esportes" } }] : []),
  custom_audience: (q) => (/IN \(5\)/.test(q) ? [{ customAudience: { id: "5", name: "Buscou tênis", status: "ENABLED" } }] : []),
  life_event: (q) => (/IN \(3\)/.test(q) ? [{ lifeEvent: { id: "3", name: "Mudou de casa" } }] : []),
  detailed_demographic: (q) => (/IN \(2\)/.test(q) ? [{ detailedDemographic: { id: "2", name: "Pais de bebês" } }] : []),
};

// ══════════════════════════ create_audience ══════════════════════════

test("create_audience: compõe todas as dimensões e envia o payload da v25 (sem status, que é output only)", async () => {
  const { client, calls } = fakeClient({ rows: { ...segmentRows } });
  const result = await call(client, "create_audience", {
    name: "Sinal Tênis",
    description: "Compradores + interesse",
    userLists: ["10", `customers/${CID}/userLists/12`],
    userInterests: ["80432"],
    customAudiences: ["5"],
    lifeEvents: ["3"],
    detailedDemographics: ["2"],
    ageRanges: ["25-54", "65+", "UNDETERMINED"],
    genders: ["FEMALE"],
    incomeRanges: ["INCOME_RANGE_90_UP"],
    parentalStatuses: ["PARENT"],
    excludeUserLists: ["11"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.method, "mutate");
  assert.equal(write.resource, "audiences");
  const create = (write.operations[0] as { create: Row }).create;
  assert.equal(create.status, undefined, "status é OUTPUT_ONLY");
  assert.equal(create.name, "Sinal Tênis");
  assert.equal(create.scope, "CUSTOMER");
  assert.equal(create.description, "Compradores + interesse");
  assert.deepEqual(create.dimensions, [
    {
      audienceSegments: {
        segments: [
          { userList: { userList: `customers/${CID}/userLists/10` } },
          { userList: { userList: `customers/${CID}/userLists/12` } },
          { userInterest: { userInterestCategory: `customers/${CID}/userInterests/80432` } },
          { customAudience: { customAudience: `customers/${CID}/customAudiences/5` } },
          { lifeEvent: { lifeEvent: `customers/${CID}/lifeEvents/3` } },
          { detailedDemographic: { detailedDemographic: `customers/${CID}/detailedDemographics/2` } },
        ],
      },
    },
    { age: { ageRanges: [{ minAge: 25, maxAge: 54 }, { minAge: 65 }], includeUndetermined: true } },
    { gender: { genders: ["FEMALE"], includeUndetermined: false } },
    { householdIncome: { incomeRanges: ["INCOME_RANGE_90_UP"], includeUndetermined: false } },
    { parentalStatus: { parentalStatuses: ["PARENT"], includeUndetermined: false } },
  ]);
  assert.deepEqual(create.exclusionDimension, { exclusions: [{ userList: { userList: `customers/${CID}/userLists/11` } }] });
  // conferiu nome e segmentos antes de gravar
  assert.ok(calls.queries.some((q) => /audience\.name = 'Sinal Tênis'/.test(q)));
  for (const from of ["user_list", "user_interest", "custom_audience", "life_event", "detailed_demographic"]) {
    assert.ok(calls.queries.some((q) => q.includes(`FROM ${from}`)), `conferiu ${from}`);
  }
  assert.match(textOf(result), /Público criado/);
  assert.match(textOf(result), /Esportes/, "relatório mostra o nome do segmento");
});

test("create_audience: entrada inválida é recusada antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ userLists: ["10"] }, /name é obrigatório/],
    [{ name: "X", ageRanges: ["30-40"] }, /idade mínima 30/],
    [{ name: "X", ageRanges: ["25-24"] }, /idade máxima 24 inválida/],
    [{ name: "X", genders: ["OUTRO"] }, /genders: "OUTRO" inválido/],
    [{ name: "X", userLists: ["customers/999/userLists/1"] }, /pertence à conta 999/],
    [{ name: "X", excludeUserLists: ["10"] }, /exclusão sozinha não forma público/],
    [{ scope: "ASSET_GROUP", name: "X", assetGroupId: AG, userLists: ["10"] }, /ASSET_GROUP não aceita name/],
    [{ scope: "ASSET_GROUP", userLists: ["10"] }, /scope ASSET_GROUP exige assetGroupId/],
    [{ name: "X", linkAsSignal: true, userLists: ["10"] }, /linkAsSignal exige assetGroupId/],
    [{ name: "X", assetGroupId: "abc", linkAsSignal: true, userLists: ["10"] }, /assetGroupId deve ser numérico/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: { ...segmentRows } });
    const result = await call(client, "create_audience", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length, 0, `nenhuma consulta para ${JSON.stringify(args)}`);
    nothingSent(calls);
  }
});

test("create_audience: nome em uso e segmento inexistente são recusados sem gravar", async () => {
  const clash = fakeClient({
    rows: { ...segmentRows, audience: [{ audience: { id: "9", name: "Sinal", status: "ENABLED" } }] },
  });
  const r1 = await call(clash.client, "create_audience", { name: "Sinal", userLists: ["10"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Já existe o público "Sinal" \(id 9\)/);
  nothingSent(clash.calls);

  const missing = fakeClient({ rows: { ...segmentRows } });
  const r2 = await call(missing.client, "create_audience", { name: "Novo", userLists: ["10", "99"], userInterests: ["1"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /userLists: customers\/1234567890\/userLists\/99/);
  assert.match(textOf(r2), /userInterests: customers\/1234567890\/userInterests\/1/);
  nothingSent(missing.calls);
});

test("create_audience ASSET_GROUP: cria e vincula como sinal numa chamada atômica com ID temporário", async () => {
  const { client, calls } = fakeClient({ rows: { ...segmentRows, asset_group: [assetGroupRow()] } });
  const result = await call(client, "create_audience", { scope: "ASSET_GROUP", assetGroupId: AG, userLists: ["10"], genders: ["MALE"] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const [audienceOp, signalOp] = calls.writes[0].operations as Array<Record<string, { create: Row }>>;
  const created = audienceOp.audienceOperation.create;
  assert.equal(created.resourceName, `customers/${CID}/audiences/-1`);
  assert.equal(created.scope, "ASSET_GROUP");
  assert.equal(created.assetGroup, AG_RN);
  assert.equal(created.name, undefined, "ASSET_GROUP não leva name");
  assert.deepEqual(signalOp.assetGroupSignalOperation.create, { assetGroup: AG_RN, audience: { audience: `customers/${CID}/audiences/-1` } });
  assert.ok(!calls.queries.some((q) => /audience\.name =/.test(q)), "escopo ASSET_GROUP não confere nome");
});

test("create_audience com linkAsSignal: grupo que já tem público exige replaceExistingSignal + confirm", async () => {
  const rows = {
    ...segmentRows,
    asset_group: [assetGroupRow()],
    asset_group_signal: [audienceSignal("1", `customers/${CID}/audiences/8`)],
  };
  const a = fakeClient({ rows });
  const r1 = await call(a.client, "create_audience", { name: "Novo", assetGroupId: AG, linkAsSignal: true, userLists: ["10"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP/);
  nothingSent(a.calls);

  const b = fakeClient({ rows });
  const r2 = await call(b.client, "create_audience", { name: "Novo", assetGroupId: AG, linkAsSignal: true, replaceExistingSignal: true, userLists: ["10"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /confirm: true/);
  nothingSent(b.calls);

  const c = fakeClient({ rows });
  const r3 = await call(c.client, "create_audience", {
    name: "Novo", assetGroupId: AG, linkAsSignal: true, replaceExistingSignal: true, confirm: true, userLists: ["10"],
  });
  assert.equal(r3.isError, undefined, textOf(r3));
  const ops = c.calls.writes[0].operations as Row[];
  assert.deepEqual(ops.map((op) => Object.keys(op)[0]), ["audienceOperation", "assetGroupSignalOperation", "assetGroupSignalOperation"]);
  assert.deepEqual(ops[1], { assetGroupSignalOperation: { remove: `customers/${CID}/assetGroupSignals/${AG}~1` } }, "remove antes de criar");
  assert.equal((ops[0].audienceOperation as { create: Row }).create.name, "Novo");
});

test("create_audience: grupo de campanha que não é PMax é recusado", async () => {
  const { client, calls } = fakeClient({ rows: { ...segmentRows, asset_group: [assetGroupRow({}, { advertisingChannelType: "DEMAND_GEN" })] } });
  const result = await call(client, "create_audience", { scope: "ASSET_GROUP", assetGroupId: AG, userLists: ["10"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /só existem em Performance Max/);
  nothingSent(calls);
});

test("create_audience: erro da API volta traduzido, e validateOnly roda em dry-run sem gravar", async () => {
  const failing = fakeClient({
    rows: { ...segmentRows },
    mutate: () => {
      throw new Error("Google Ads API: Request contains an invalid argument. — The audience segment is not found. [audienceError.AUDIENCE_SEGMENT_NOT_FOUND]");
    },
  });
  const r1 = await call(failing.client, "create_audience", { name: "Novo", userLists: ["10"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /nada foi criado/);
  assert.match(textOf(r1), /Dica: Um dos segmentos não existe/);

  const { client, calls } = fakeClient({ rows: { ...segmentRows } });
  const r2 = await call(client, "create_audience", { name: "Novo", userLists: ["10"], validateOnly: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(calls.dryRunClones, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(r2.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\)/);
  assert.doesNotMatch(textOf(r2), /Público criado/);
});

// ══════════════════════════ update_audience ══════════════════════════

test("update_audience: troca só a dimensão pedida e mantém o resto (updateMask dimensions)", async () => {
  const { client, calls } = fakeClient({ rows: { ...segmentRows, audience: [audienceRow()], asset_group_signal: [audienceSignal("1", AUD_RN)] } });
  const result = await call(client, "update_audience", { audienceId: "44", genders: ["FEMALE"] });
  assert.equal(result.isError, undefined, textOf(result));
  const op = calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(calls.writes[0].resource, "audiences");
  assert.equal(op.updateMask, "dimensions");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update.dimensions, [
    { audienceSegments: { segments: [{ userList: { userList: `customers/${CID}/userLists/10` } }] } },
    { age: { ageRanges: [{ minAge: 25, maxAge: 34 }], includeUndetermined: false } },
    { gender: { genders: ["FEMALE"], includeUndetermined: false } },
  ]);
  assert.equal(op.update.exclusionDimension, undefined, "exclusões não mudaram");
  const body = jsonOf(result);
  assert.equal((body.used_by as Row[]).length, 1, "mostra os grupos que usam o público");
});

test("update_audience: sem mudança não grava; [] limpa exclusões com o caminho folha", async () => {
  const same = fakeClient({ rows: { ...segmentRows, audience: [audienceRow()] } });
  const r1 = await call(same.client, "update_audience", { audienceId: AUD_RN, ageRanges: ["25-34"], userLists: ["10"] });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /nada a mudar/);
  nothingSent(same.calls);

  const clear = fakeClient({ rows: { ...segmentRows, audience: [audienceRow()] } });
  const r2 = await call(clear.client, "update_audience", { audienceId: "44", excludeUserLists: [] });
  assert.equal(r2.isError, undefined, textOf(r2));
  const op = clear.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "exclusion_dimension.exclusions");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update.exclusionDimension, { exclusions: [] });
});

test("update_audience: escopo, nome e público vazio", async () => {
  const assetGroupAudience = () => audienceRow({ scope: "ASSET_GROUP", name: undefined, assetGroup: AG_RN });
  const a = fakeClient({ rows: { audience: [assetGroupAudience()] } });
  const r1 = await call(a.client, "update_audience", { audienceId: "44", name: "Novo nome" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /ASSET_GROUP não aceita name/);
  nothingSent(a.calls);

  const b = fakeClient({ rows: { audience: [assetGroupAudience()] } });
  const r2 = await call(b.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /exige name/);
  nothingSent(b.calls);

  const c = fakeClient({ rows: { audience: (q) => (q.includes("audience.name =") ? [] : [assetGroupAudience()]) } });
  const r3 = await call(c.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, name: "Compartilhado", confirm: true });
  assert.equal(r3.isError, undefined, textOf(r3));
  const op = c.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "scope,name");
  assert.equal(op.update.scope, "CUSTOMER");

  const d = fakeClient({ rows: { audience: [audienceRow()] } });
  const r4 = await call(d.client, "update_audience", { audienceId: "44", userLists: [], ageRanges: [] });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /sem nenhum segmento ou dimensão positiva/);
  nothingSent(d.calls);
});

test("update_audience: promover ASSET_GROUP → CUSTOMER é irreversível e exige confirm (sem confirm devolve o plano)", async () => {
  const rows = {
    audience: (q: string) => (q.includes("audience.name =") ? [] : [audienceRow({ scope: "ASSET_GROUP", name: undefined, assetGroup: AG_RN })]),
    asset_group_signal: [audienceSignal("1", AUD_RN)],
  };
  const a = fakeClient({ rows });
  const r1 = await call(a.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, name: "X" });
  assert.equal(r1.isError, true, "sem confirm é recusado");
  assert.match(textOf(r1), /IRREVERSÍVEL/);
  assert.match(textOf(r1), /confirm: true/);
  nothingSent(a.calls);
  const plan = jsonOf(r1);
  assert.deepEqual(plan.update_mask, ["scope", "name"]);
  assert.deepEqual(plan.scope, { before: "ASSET_GROUP", after: "CUSTOMER" });
  assert.deepEqual(plan.asset_group, { before: AG_RN, after: null });
  assert.equal((plan.used_by as Row[])[0].asset_group_id, AG, "o plano mostra quem usa o público");
  assert.ok(plan.before && plan.after, "o plano mostra antes/depois");

  const b = fakeClient({ rows });
  const r2 = await call(b.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, name: "X", confirm: false });
  assert.equal(r2.isError, true, "confirm: false também é recusado");
  nothingSent(b.calls);

  // Em validateOnly o gate vale igual: sem confirm, nada vai nem para a validação.
  const dry = fakeClient({ rows, dryRun: true });
  const r3 = await call(dry.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, name: "X" });
  assert.equal(r3.isError, true);
  nothingSent(dry.calls);

  const dryOk = fakeClient({ rows, dryRun: true });
  const r4 = await call(dryOk.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, name: "X", confirm: true });
  assert.equal(r4.isError, undefined, textOf(r4));
  assert.match(textOf(r4), /DRY-RUN/);
  assert.equal(dryOk.calls.writes[0].dryRun, true);

  // Público já CUSTOMER: promoteToCustomerScope é no-op e não pede confirm para outras mudanças.
  const customer = fakeClient({ rows: { ...segmentRows, audience: [audienceRow()] } });
  const r5 = await call(customer.client, "update_audience", { audienceId: "44", promoteToCustomerScope: true, genders: ["MALE"] });
  assert.equal(r5.isError, undefined, textOf(r5));
  const op = customer.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "dimensions");
  assert.equal(op.update.scope, undefined);
});

test("update_audience: segmento novo inexistente e público inexistente são recusados", async () => {
  const a = fakeClient({ rows: { ...segmentRows, audience: [audienceRow()] } });
  const r1 = await call(a.client, "update_audience", { audienceId: "44", userInterests: ["123"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /userInterests: customers\/1234567890\/userInterests\/123/);
  nothingSent(a.calls);

  const b = fakeClient();
  const r2 = await call(b.client, "update_audience", { audienceId: "44", genders: ["MALE"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não encontrado/);
  nothingSent(b.calls);

  const c = fakeClient();
  const r3 = await call(c.client, "update_audience", { audienceId: "abc", genders: ["MALE"] });
  assert.equal(r3.isError, true);
  assert.equal(c.calls.queries.length, 0);
});

// ══════════════════════════ list_asset_group_signals ══════════════════════════

test("list_asset_group_signals: agrupa temas e público, mostra reprovação e resolve o nome do público", async () => {
  const { client, calls } = fakeClient({
    rows: {
      asset_group_signal: [
        themeSignal("1", "tênis de corrida"),
        themeSignal("2", "tênis falsificado", "DISAPPROVED", AG, ["COUNTERFEIT"]),
        audienceSignal("3", AUD_RN),
      ],
      audience: [audienceRow()],
    },
  });
  const result = await call(client, "list_asset_group_signals", { campaignId: CAMPAIGN });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /3 sinal\(is\) em 1 grupo\(s\) de recursos — 1 tema\(s\) REPROVADO\(s\)/);
  const [group] = jsonOf(result) as unknown as Row[];
  assert.equal((group.audience as Row).name, "Compradores");
  assert.deepEqual((group.audience as Row).composition, {
    userLists: [{ resource_name: `customers/${CID}/userLists/10` }],
    ageRanges: ["25-34"],
    excludeUserLists: [{ resource_name: `customers/${CID}/userLists/11` }],
  });
  const themes = group.search_themes as Row[];
  assert.deepEqual(themes[1].disapproval_reasons, ["COUNTERFEIT"]);
  assert.ok(calls.queries.some((q) => /WHERE campaign\.id = 555/.test(q)));

  const table = await call(fakeClient({ rows: { asset_group_signal: [themeSignal("1", "tênis")] } }).client, "list_asset_group_signals", {
    assetGroupId: AG, format: "table",
  });
  assert.match(textOf(table), /SEARCH_THEME/);
});

test("list_asset_group_signals: exige um filtro e IDs numéricos", async () => {
  for (const args of [{}, { campaignId: "1 OR 1=1" }, { assetGroupId: "x" }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "list_asset_group_signals", args);
    assert.equal(result.isError, true);
    assert.equal(calls.queries.length, 0);
  }
});

// ══════════════════════════ manage_asset_group_signals ══════════════════════════

test("manage_asset_group_signals: temas em lote com partial failure, pulando repetidos e existentes", async () => {
  const { client, calls } = fakeClient({
    rows: { asset_group: [assetGroupRow()], asset_group_signal: [themeSignal("1", "Tênis de Corrida")] },
    mutate: (_resource, operations) => ({
      results: operations.map((_op, i) => (i === 1 ? {} : { resourceName: `customers/${CID}/assetGroupSignals/${AG}~${50 + i}` })),
      partialFailureError: {
        message: "Multiple errors",
        details: [{
          errors: [{
            message: "The search theme violates policy.",
            errorCode: { assetGroupSignalError: "SEARCH_THEME_POLICY_VIOLATION" },
            location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
          }],
        }],
      },
    }),
  });
  const result = await call(client, "manage_asset_group_signals", {
    assetGroupId: AG,
    addSearchThemes: ["tênis de corrida", "tênis   masculino", "TÊNIS MASCULINO", "tênis réplica"],
  });
  const write = calls.writes[0];
  assert.equal(write.resource, "assetGroupSignals");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { create: { assetGroup: AG_RN, searchTheme: { text: "tênis masculino" } } },
    { create: { assetGroup: AG_RN, searchTheme: { text: "tênis réplica" } } },
  ]);
  assert.equal(result.isError, true, "um tema foi recusado");
  const body = jsonOf(result);
  assert.equal((body.applied as Row[]).length, 1);
  const [error] = body.errors as Row[];
  assert.equal(error.search_theme, "tênis réplica");
  assert.match(String(error.error), /SEARCH_THEME_POLICY_VIOLATION/);
  assert.match(String(error.error), /Dica: Tema de pesquisa recusado pela política/);
  assert.equal((body.skipped as Row[])[0].search_theme, "tênis de corrida");
});

test("manage_asset_group_signals: validação local antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ assetGroupId: "7x7" }, /assetGroupId deve ser numérico/],
    [{ assetGroupId: AG, addSearchThemes: ["um dois três quatro cinco seis sete oito nove dez onze"] }, /11 palavras/],
    [{ assetGroupId: AG, removeSignalIds: [`customers/${CID}/assetGroupSignals/999~1`] }, /não é um ID de sinal deste grupo/],
    [{ assetGroupId: AG, setAudience: "44", removeAudience: true }, /setAudience OU removeAudience/],
    [{ assetGroupId: AG }, /ao menos uma ação/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "manage_asset_group_signals", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length, 0);
    nothingSent(calls);
  }
});

test("manage_asset_group_signals: remoção sem confirm devolve o plano e não envia nada", async () => {
  const rows = { asset_group: [assetGroupRow()], asset_group_signal: [themeSignal("1", "tênis"), themeSignal("2", "chinelo")] };
  const a = fakeClient({ rows });
  const r1 = await call(a.client, "manage_asset_group_signals", { assetGroupId: AG, removeSearchThemes: ["TÊNIS"], removeSignalIds: ["2", "404"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  nothingSent(a.calls);

  const b = fakeClient({ rows });
  const r2 = await call(b.client, "manage_asset_group_signals", {
    assetGroupId: AG, removeSearchThemes: ["TÊNIS"], removeSignalIds: ["2", "404"], confirm: true,
  });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.deepEqual(b.calls.writes[0].operations, [
    { remove: `customers/${CID}/assetGroupSignals/${AG}~1` },
    { remove: `customers/${CID}/assetGroupSignals/${AG}~2` },
  ]);
  assert.deepEqual((jsonOf(r2).not_found as Row[]).map((item) => item.signal_id), ["404"]);
});

test("manage_asset_group_signals: troca de público é atômica (remove + cria, sem partial failure)", async () => {
  const { client, calls } = fakeClient({
    rows: {
      asset_group: [assetGroupRow()],
      asset_group_signal: [audienceSignal("9", `customers/${CID}/audiences/8`), themeSignal("1", "tênis")],
      audience: [audienceRow()],
    },
  });
  const result = await call(client, "manage_asset_group_signals", { assetGroupId: AG, setAudience: "44", addSearchThemes: ["sapatênis"], confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 2);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true }, "temas com partial failure");
  assert.equal(calls.writes[1].options, undefined, "público atômico");
  assert.deepEqual(calls.writes[1].operations, [
    { remove: `customers/${CID}/assetGroupSignals/${AG}~9` },
    { create: { assetGroup: AG_RN, audience: { audience: AUD_RN } } },
  ]);
  const applied = jsonOf(result).applied as Row[];
  assert.equal(applied.find((item) => item.action === "replace_audience")?.previous_audience, `customers/${CID}/audiences/8`);
});

test("manage_asset_group_signals: público de escopo de outro grupo e grupo fora do PMax são recusados", async () => {
  const a = fakeClient({
    rows: { asset_group: [assetGroupRow()], audience: [audienceRow({ scope: "ASSET_GROUP", assetGroup: `customers/${CID}/assetGroups/1` })] },
  });
  const r1 = await call(a.client, "manage_asset_group_signals", { assetGroupId: AG, setAudience: "44" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /escopo do grupo customers\/1234567890\/assetGroups\/1/);
  nothingSent(a.calls);

  const b = fakeClient({ rows: { asset_group: [assetGroupRow({ status: "REMOVED" })] } });
  const r2 = await call(b.client, "manage_asset_group_signals", { assetGroupId: AG, addSearchThemes: ["x"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /está removido/);
  nothingSent(b.calls);
});

test("manage_asset_group_signals em validateOnly: tudo em dry-run e sem 'aplicadas'", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: [assetGroupRow()] } });
  const result = await call(client, "manage_asset_group_signals", { assetGroupId: AG, addSearchThemes: ["tênis"], validateOnly: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): nada foi gravado\. Validadas: 1/);
  assert.ok("validated" in jsonOf(result));
});

// ══════════════════════════ copy_asset_group_signals ══════════════════════════

test("copy_asset_group_signals: copia temas que faltam (sem reprovados) e vincula público CUSTOMER", async () => {
  const TARGET = "888";
  const { client, calls } = fakeClient({
    rows: {
      asset_group: [assetGroupRow(), assetGroupRow({ id: TARGET, name: "Chinelos", resourceName: `customers/${CID}/assetGroups/${TARGET}` })],
      asset_group_signal: [
        themeSignal("1", "tênis"),
        themeSignal("2", "réplica", "DISAPPROVED"),
        themeSignal("3", "corrida"),
        audienceSignal("4", AUD_RN),
        themeSignal("5", "Corrida", "APPROVED", TARGET),
      ],
      audience: [audienceRow()],
    },
  });
  const result = await call(client, "copy_asset_group_signals", { sourceAssetGroupId: AG, targetAssetGroupIds: [TARGET] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.deepEqual(calls.writes[0].operations, [
    { create: { assetGroup: `customers/${CID}/assetGroups/${TARGET}`, searchTheme: { text: "tênis" } } },
    { create: { assetGroup: `customers/${CID}/assetGroups/${TARGET}`, audience: { audience: AUD_RN } } },
  ]);
  const skipped = jsonOf(result).skipped as Row[];
  assert.deepEqual(skipped.map((item) => item.reason).sort(), ["já existe no destino", "reprovado na origem"]);
});

test("copy_asset_group_signals: público ASSET_GROUP vira cópia com escopo do destino (atômico)", async () => {
  const TARGET = "888";
  const scoped = audienceRow({ scope: "ASSET_GROUP", name: undefined, assetGroup: AG_RN });
  const { client, calls } = fakeClient({
    rows: {
      asset_group: [assetGroupRow(), assetGroupRow({ id: TARGET, resourceName: `customers/${CID}/assetGroups/${TARGET}` })],
      asset_group_signal: [audienceSignal("4", AUD_RN)],
      audience: [scoped],
    },
  });
  const result = await call(client, "copy_asset_group_signals", { sourceAssetGroupId: AG, targetAssetGroupIds: [TARGET], includeSearchThemes: false });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].method, "batchMutate");
  const [audienceOp, signalOp] = calls.writes[0].operations as Array<Record<string, { create: Row }>>;
  assert.equal(audienceOp.audienceOperation.create.scope, "ASSET_GROUP");
  assert.equal(audienceOp.audienceOperation.create.assetGroup, `customers/${CID}/assetGroups/${TARGET}`);
  assert.deepEqual(audienceOp.audienceOperation.create.dimensions, (scoped.audience as Row).dimensions);
  assert.equal(signalOp.assetGroupSignalOperation.create.audience && (signalOp.assetGroupSignalOperation.create.audience as Row).audience,
    audienceOp.audienceOperation.create.resourceName);
});

test("copy_asset_group_signals: destino com outro público é pulado, não trocado; destino inválido recusa tudo", async () => {
  const TARGET = "888";
  const a = fakeClient({
    rows: {
      asset_group: [assetGroupRow(), assetGroupRow({ id: TARGET, resourceName: `customers/${CID}/assetGroups/${TARGET}` })],
      asset_group_signal: [audienceSignal("4", AUD_RN), audienceSignal("6", `customers/${CID}/audiences/8`, TARGET)],
      audience: [audienceRow()],
    },
  });
  const r1 = await call(a.client, "copy_asset_group_signals", { sourceAssetGroupId: AG, targetAssetGroupIds: [TARGET] });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /Nada a copiar/);
  nothingSent(a.calls);

  const b = fakeClient({ rows: { asset_group: [assetGroupRow()] } });
  const r2 = await call(b.client, "copy_asset_group_signals", { sourceAssetGroupId: AG, targetAssetGroupIds: ["999"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Grupo de recursos 999 não encontrado/);
  nothingSent(b.calls);
});

// ══════════════════════════ automação ══════════════════════════

function pmaxCampaign(settings: Row[] = [], extra: Row = {}): Row[] {
  return [{
    campaign: {
      id: CAMPAIGN, name: "PMax Loja", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", assetAutomationSettings: settings, ...extra,
    },
  }];
}

test("set_pmax_asset_automation: troca só o tipo pedido e reenvia os demais (lista repetida inteira)", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: pmaxCampaign([{ assetAutomationType: "GENERATE_ENHANCED_YOUTUBE_VIDEOS", assetAutomationStatus: "OPTED_OUT" }]) },
  });
  const result = await call(client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, imageEnhancement: false, enhancedVideos: false });
  assert.equal(result.isError, undefined, textOf(result));
  const op = calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(calls.writes[0].method, "mutateCampaigns");
  assert.equal(op.updateMask, "asset_automation_settings");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update, {
    resourceName: `customers/${CID}/campaigns/${CAMPAIGN}`,
    assetAutomationSettings: [
      { assetAutomationType: "GENERATE_ENHANCED_YOUTUBE_VIDEOS", assetAutomationStatus: "OPTED_OUT" },
      { assetAutomationType: "GENERATE_IMAGE_ENHANCEMENT", assetAutomationStatus: "OPTED_OUT" },
    ],
  });
  assert.match(textOf(result), /Vídeos aprimorados \(OPTED_OUT\)/, "o já aplicado aparece como sem mudança");
});

test("set_pmax_asset_automation: personalização de texto não desliga com expansão ligada nem com feed de páginas", async () => {
  const a = fakeClient({ rows: { campaign: pmaxCampaign() } });
  const r1 = await call(a.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, textCustomization: false });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /expansão de URL final ligada/);
  nothingSent(a.calls);

  const b = fakeClient({
    rows: {
      campaign: pmaxCampaign(),
      campaign_asset_set: [{ campaignAssetSet: { resourceName: "cas/1" }, assetSet: { id: "31", name: "Páginas", type: "PAGE_FEED" } }],
    },
  });
  const r2 = await call(b.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, textCustomization: false, finalUrlExpansion: false });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /remover o CampaignAssetSet PAGE_FEED antes/);
  nothingSent(b.calls);
});

test("set_pmax_asset_automation: no-op, campanha que não é PMax, entrada vazia e erro da API", async () => {
  const same = fakeClient({ rows: { campaign: pmaxCampaign([{ assetAutomationType: "GENERATE_IMAGE_EXTRACTION", assetAutomationStatus: "OPTED_IN" }]) } });
  const r1 = await call(same.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, imageExtraction: true });
  assert.match(textOf(r1), /nada a mudar/);
  nothingSent(same.calls);

  const search = fakeClient({ rows: { campaign: pmaxCampaign([], { advertisingChannelType: "SEARCH" }) } });
  const r2 = await call(search.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, imageEnhancement: false });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não Performance Max/);
  nothingSent(search.calls);

  const empty = fakeClient();
  const r3 = await call(empty.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN });
  assert.equal(r3.isError, true);
  assert.equal(empty.calls.queries.length, 0);

  const failing = fakeClient({
    rows: { campaign: pmaxCampaign() },
    mutateCampaigns: () => { throw new Error("Google Ads API: bad [contextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT]"); },
  });
  const r4 = await call(failing.client, "set_pmax_asset_automation", { campaignId: CAMPAIGN, finalUrlExpansion: false });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /Ordem exigida pela API/);
});

test("get_pmax_automation_settings: padrões do PMax, exclusões, feeds e URLs finais", async () => {
  const { client } = fakeClient({
    rows: {
      campaign: pmaxCampaign([{ assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_OUT" }]),
      campaign_criterion: [{
        campaignCriterion: {
          criterionId: "71", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~71`, negative: true, status: "ENABLED", type: "WEBPAGE",
          webpage: { criterionName: "Blog", conditions: [{ operand: "URL", operator: "CONTAINS", argument: "/blog" }] },
        },
      }],
      asset_group: [assetGroupRow()],
    },
  });
  const result = await call(client, "get_pmax_automation_settings", { campaignId: CAMPAIGN });
  assert.equal(result.isError, undefined, textOf(result));
  const body = jsonOf(result);
  const automation = body.automation as Row[];
  assert.equal(automation.find((item) => item.type === "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION")?.effective, "OPTED_OUT");
  assert.equal(automation.find((item) => item.type === "TEXT_ASSET_AUTOMATION")?.effective, "OPTED_IN (padrão)");
  assert.equal((body.url_exclusions as Row[])[0].criterion_id, "71");
  assert.match(String((body.notes as string[])[0]), /exclusões de URL não têm efeito/);
});

// ══════════════════════════ exclusões de URL ══════════════════════════

const existingExclusion = {
  campaignCriterion: {
    criterionId: "71", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~71`, negative: true, status: "ENABLED", type: "WEBPAGE",
    webpage: { criterionName: "Blog", conditions: [{ operand: "URL", operator: "CONTAINS", argument: "/blog" }] },
  },
};

test("set_pmax_url_exclusions: cria critérios WEBPAGE negativos (URL e rótulo) com partial failure", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: pmaxCampaign(), asset_group: [assetGroupRow()], campaign_criterion: [existingExclusion] } });
  const result = await call(client, "set_pmax_url_exclusions", {
    campaignId: CAMPAIGN,
    rules: [{ operator: "CONTAINS", url: "/BLOG" }, { operator: "CONTAINS", url: "/carreiras" }, { operator: "EQUALS", url: "https://loja.com.br/privacidade" }],
    customLabels: ["nao_anunciar"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.resource, "campaignCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  const campaign = `customers/${CID}/campaigns/${CAMPAIGN}`;
  assert.deepEqual(write.operations, [
    { create: { campaign, negative: true, webpage: { criterionName: "Exclusão: URL contém /carreiras", conditions: [{ operand: "URL", operator: "CONTAINS", argument: "/carreiras" }] } } },
    { create: { campaign, negative: true, webpage: { criterionName: "Exclusão: URL igual a https://loja.com.br/privacidade", conditions: [{ operand: "URL", operator: "EQUALS", argument: "https://loja.com.br/privacidade" }] } } },
    { create: { campaign, negative: true, webpage: { criterionName: "Exclusão: rótulo nao_anunciar", conditions: [{ operand: "CUSTOM_LABEL", argument: "nao_anunciar" }] } } },
  ]);
  assert.equal((jsonOf(result).already_excluded as Row[])[0].criterion_id, "71", "/BLOG já existe (sem diferenciar maiúsculas)");
});

test("set_pmax_url_exclusions: URL final de grupo não pode ser excluída (EQUALS recusa, CONTAINS avisa)", async () => {
  const a = fakeClient({ rows: { campaign: pmaxCampaign(), asset_group: [assetGroupRow()] } });
  const r1 = await call(a.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ operator: "EQUALS", url: "http://www.loja.com.br/tenis/" }] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /é a URL final do\(s\) grupo\(s\) 777/);
  nothingSent(a.calls);

  const b = fakeClient({ rows: { campaign: pmaxCampaign(), asset_group: [assetGroupRow()] } });
  const r2 = await call(b.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ operator: "CONTAINS", url: "/tenis" }] });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.match(textOf(r2), /a URL final continua veiculando/);
  assert.equal(b.calls.writes.length, 1);
});

test("set_pmax_url_exclusions: replace/remoção exige confirm; no-op não grava; validação local", async () => {
  const rows = { campaign: pmaxCampaign(), asset_group: [assetGroupRow()], campaign_criterion: [existingExclusion] };
  const a = fakeClient({ rows });
  const r1 = await call(a.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ url: "/politicas" }], replace: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /repita com confirm: true/i);
  nothingSent(a.calls);

  const b = fakeClient({ rows });
  const r2 = await call(b.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ url: "/politicas" }], replace: true, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.deepEqual(b.calls.writes[0].operations[1], { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN}~71` });

  const c = fakeClient({ rows });
  const r3 = await call(c.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ operator: "CONTAINS", url: "/blog" }] });
  assert.match(textOf(r3), /nada a mudar/);
  nothingSent(c.calls);

  for (const args of [{ rules: [{ operator: "STARTS_WITH", url: "/x" }] }, { rules: [{ url: "" }] }, { removeCriterionIds: ["x"] }, {}]) {
    const d = fakeClient({ rows });
    const r = await call(d.client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(d.calls.queries.length, 0);
  }
});

test("set_pmax_url_exclusions: pedir a regra e remover a exclusão que a aplica é contraditório — recusa sem enviar", async () => {
  const rows = { campaign: pmaxCampaign(), campaign_criterion: [existingExclusion] };
  const a = fakeClient({ rows });
  const r1 = await call(a.client, "set_pmax_url_exclusions", {
    campaignId: CAMPAIGN, rules: [{ operator: "CONTAINS", url: "/blog" }], removeCriterionIds: ["71"], confirm: true,
  });
  assert.equal(r1.isError, true, textOf(r1));
  assert.match(textOf(r1), /contraditório/);
  assert.match(textOf(r1), /tire o ID de removeCriterionIds/);
  nothingSent(a.calls);
  const body = jsonOf(r1);
  assert.deepEqual((body.conflicts as Row[]).map((item) => item.criterion_id), ["71"]);
  assert.equal(body.already_excluded, undefined, "não diz que a regra está excluída");

  // O mesmo vale para rótulo personalizado.
  const labelExclusion = {
    campaignCriterion: {
      criterionId: "72", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~72`, negative: true, status: "ENABLED", type: "WEBPAGE",
      webpage: { criterionName: "Rótulo", conditions: [{ operand: "CUSTOM_LABEL", argument: "nao_anunciar" }] },
    },
  };
  const b = fakeClient({ rows: { campaign: pmaxCampaign(), campaign_criterion: [existingExclusion, labelExclusion] } });
  const r2 = await call(b.client, "set_pmax_url_exclusions", {
    campaignId: CAMPAIGN, customLabels: ["NAO_ANUNCIAR"], removeCriterionIds: ["72"], confirm: true,
  });
  assert.equal(r2.isError, true);
  assert.deepEqual((jsonOf(r2).conflicts as Row[]).map((item) => item.criterion_id), ["72"]);
  nothingSent(b.calls);

  // Duplicata: duas exclusões com a mesma regra; remover uma mantém a outra, que é a "já excluída".
  const duplicate = { campaignCriterion: { ...existingExclusion.campaignCriterion, criterionId: "73", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~73` } };
  const c = fakeClient({ rows: { campaign: pmaxCampaign(), campaign_criterion: [existingExclusion, duplicate] } });
  const r3 = await call(c.client, "set_pmax_url_exclusions", {
    campaignId: CAMPAIGN, rules: [{ operator: "CONTAINS", url: "/blog" }], removeCriterionIds: ["71"], confirm: true,
  });
  assert.equal(r3.isError, undefined, textOf(r3));
  assert.deepEqual(c.calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN}~71` }]);
  assert.deepEqual((jsonOf(r3).already_excluded as Row[]).map((item) => item.criterion_id), ["73"], "a sobrevivente é a que vale");

  // Remover outra exclusão (não relacionada à regra pedida) continua funcionando.
  const d = fakeClient({ rows: { campaign: pmaxCampaign(), campaign_criterion: [existingExclusion, labelExclusion] } });
  const r4 = await call(d.client, "set_pmax_url_exclusions", {
    campaignId: CAMPAIGN, rules: [{ operator: "CONTAINS", url: "/blog" }], removeCriterionIds: ["72"], confirm: true,
  });
  assert.equal(r4.isError, undefined, textOf(r4));
  assert.deepEqual(d.calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN}~72` }]);
  assert.deepEqual((jsonOf(r4).already_excluded as Row[]).map((item) => item.criterion_id), ["71"]);
});

test("set_pmax_url_exclusions: erro por operação vira relatório por item", async () => {
  const { client } = fakeClient({
    rows: { campaign: pmaxCampaign(), asset_group: [assetGroupRow()] },
    mutate: (_resource, operations) => ({
      results: operations.map((_op, i) => (i === 0 ? { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~80` } : {})),
      partialFailureError: {
        details: [{ errors: [{ message: "Invalid argument.", errorCode: { criterionError: "INVALID_WEBPAGE_CONDITION" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const result = await call(client, "set_pmax_url_exclusions", { campaignId: CAMPAIGN, rules: [{ url: "/a" }, { url: "/b" }] });
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.equal((body.applied as Row[]).length, 1);
  assert.match(String((body.errors as Row[])[0].error), /INVALID_WEBPAGE_CONDITION/);
});

// ══════════════════════════ assets da expansão de URL ══════════════════════════

const expansionRows = [
  {
    finalUrlExpansionAssetView: {
      asset: `customers/${CID}/assets/901`, fieldType: "HEADLINE", finalUrl: "https://loja.com.br/blog/dicas", status: "ENABLED", assetGroup: AG_RN,
    },
    asset: { id: "901", type: "TEXT", textAsset: { text: "Dicas de corrida" } },
    assetGroup: { name: "Tênis" },
    metrics: { impressions: "100", clicks: "4", costMicros: "2500000", conversions: 1, conversionsValue: 90 },
  },
  {
    finalUrlExpansionAssetView: {
      asset: `customers/${CID}/assets/901`, fieldType: "HEADLINE", finalUrl: "https://loja.com.br/blog/dicas", status: "ENABLED", assetGroup: AG_RN,
    },
    asset: { id: "901", type: "TEXT", textAsset: { text: "Dicas de corrida" } },
    assetGroup: { name: "Tênis" },
    metrics: { impressions: "50", clicks: "1", costMicros: "500000", conversions: 0, conversionsValue: 0 },
  },
];

test("list_url_expansion_assets: agrega por asset + field type + URL e aceita csv", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: pmaxCampaign(), final_url_expansion_asset_view: expansionRows } });
  const result = await call(client, "list_url_expansion_assets", { campaignId: CAMPAIGN, days: 7 });
  assert.equal(result.isError, undefined, textOf(result));
  const [row] = jsonOf(result) as unknown as Row[];
  assert.deepEqual(
    { asset_id: row.asset_id, text: row.text, impressions: row.impressions, clicks: row.clicks, spend: row.spend },
    { asset_id: "901", text: "Dicas de corrida", impressions: 150, clicks: 5, spend: 3 }
  );
  assert.match(calls.queries.find((q) => /FROM final_url_expansion_asset_view/.test(q))!, /segments\.date DURING LAST_7_DAYS/);
  const csv = await call(client, "list_url_expansion_assets", { campaignId: CAMPAIGN, format: "csv" });
  assert.match(textOf(csv), /^asset_id,field_type,text,final_url/);
  const bad = fakeClient();
  assert.equal((await call(bad.client, "list_url_expansion_assets", { campaignId: "1;DROP" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("expansão de URL: a view é filtrada pelo canal da campanha com '=' e canal sem expansão não é consultado", async () => {
  // o grupo selecionado depende do canal (tests/gaql-rules.ts recusa o outro, como a API)
  for (const [channel, group] of [["PERFORMANCE_MAX", "asset_group"], ["SEARCH", "ad_group"]] as const) {
    const { client, calls } = fakeClient({ rows: { campaign: pmaxCampaign([], { advertisingChannelType: channel }) } });
    const result = await call(client, "list_url_expansion_assets", { campaignId: CAMPAIGN });
    assert.equal(result.isError, undefined, textOf(result));
    const query = calls.queries.find((q) => /FROM final_url_expansion_asset_view/.test(q))!;
    assert.match(query, new RegExp(`campaign\\.id = ${CAMPAIGN} AND campaign\\.advertising_channel_type = '${channel}'`));
    assert.match(query, new RegExp(`final_url_expansion_asset_view\\.${group}, ${group}\\.name`));
  }
  const search = fakeClient({
    rows: {
      campaign: pmaxCampaign([], { advertisingChannelType: "SEARCH" }),
      final_url_expansion_asset_view: [{
        finalUrlExpansionAssetView: {
          asset: `customers/${CID}/assets/905`, fieldType: "HEADLINE", finalUrl: "https://loja.com.br/frete", status: "ENABLED", adGroup: `customers/${CID}/adGroups/${AG}`,
        },
        asset: { id: "905", type: "TEXT", textAsset: { text: "Frete grátis" } },
        adGroup: { name: "Tênis Pesquisa" },
        metrics: { impressions: "10" },
      }],
    },
  });
  const [searchRow] = jsonOf(await call(search.client, "list_url_expansion_assets", { campaignId: CAMPAIGN })) as unknown as Row[];
  assert.deepEqual({ asset_group: searchRow.asset_group, ad_group: searchRow.ad_group }, { asset_group: "", ad_group: "Tênis Pesquisa" });

  // a API responde "Invalid advertising channel type DEMAND_GEN in filter"
  const items = [{ assetId: "901", fieldType: "HEADLINE" }];
  for (const [tool, args, tail] of [
    ["list_url_expansion_assets", {}, ""],
    ["remove_auto_created_assets", { items, confirm: true }, " Nada foi removido."],
  ] as const) {
    const demandGen = fakeClient({ rows: { campaign: pmaxCampaign([], { advertisingChannelType: "DEMAND_GEN" }) }, action: () => ({}) });
    const refused = await call(demandGen.client, tool, { campaignId: CAMPAIGN, ...args });
    assert.equal(refused.isError, true, tool);
    assert.equal(textOf(refused), `Campanha ${CAMPAIGN} ("PMax Loja") é DEMAND_GEN: a expansão de URL final só existe em Performance Max e Pesquisa.${tail}`);
    assert.ok(!demandGen.calls.queries.some((q) => /final_url_expansion_asset_view/.test(q)), tool);
    assert.equal(demandGen.calls.actions.length, 0, tool);

    const missing = fakeClient({ action: () => ({}) });
    assert.match(textOf(await call(missing.client, tool, { campaignId: CAMPAIGN, ...args })), new RegExp(`Campanha ${CAMPAIGN} não encontrada`));
    assert.equal(missing.calls.queries.length, 1, "só a busca da campanha");
  }
});

test("remove_auto_created_assets: confirm, conferência na campanha e partial failure obrigatório", async () => {
  const rows = { campaign: pmaxCampaign(), final_url_expansion_asset_view: expansionRows.slice(0, 1) };
  const items = [{ assetId: "901", fieldType: "headline" }, { assetId: "902", fieldType: "DESCRIPTION" }];

  const a = fakeClient({ rows });
  const r1 = await call(a.client, "remove_auto_created_assets", { campaignId: CAMPAIGN, items });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /irreversível/);
  nothingSent(a.calls);

  const b = fakeClient({ rows, action: () => ({}) });
  const r2 = await call(b.client, "remove_auto_created_assets", { campaignId: CAMPAIGN, items, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(b.calls.actions.length, 1);
  assert.equal(b.calls.actions[0].action, ":removeCampaignAutomaticallyCreatedAsset");
  assert.deepEqual(b.calls.actions[0].body, {
    operations: [{ campaign: `customers/${CID}/campaigns/${CAMPAIGN}`, asset: `customers/${CID}/assets/901`, fieldType: "HEADLINE" }],
    partialFailure: true,
  });
  const body = jsonOf(r2);
  assert.equal((body.removed as Row[]).length, 1);
  assert.equal((body.not_found as Row[])[0].assetId, "902", "o que não é gerado nesta campanha não é enviado");
});

test("remove_auto_created_assets: validateOnly não chama o endpoint (ele não tem validate_only)", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: pmaxCampaign(), final_url_expansion_asset_view: expansionRows.slice(0, 1) } });
  const result = await call(client, "remove_auto_created_assets", {
    campaignId: CAMPAIGN, items: [{ assetId: "901", fieldType: "HEADLINE" }], confirm: true, validateOnly: true,
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não aceita validate_only/);
  assert.equal(calls.actions.length, 0);
});

test("remove_auto_created_assets: field type inválido e erro por item traduzido", async () => {
  const a = fakeClient();
  const r1 = await call(a.client, "remove_auto_created_assets", { campaignId: CAMPAIGN, items: [{ assetId: "901", fieldType: "TITULO" }], confirm: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /não existe no AssetFieldType/);
  assert.equal(a.calls.queries.length, 0);

  const b = fakeClient({
    rows: { campaign: pmaxCampaign(), final_url_expansion_asset_view: expansionRows.slice(0, 1) },
    action: () => ({
      partialFailureError: {
        details: [{ errors: [{ message: "Not automatically created.", errorCode: { automaticallyCreatedAssetRemovalError: "NOT_AN_AUTOMATICALLY_CREATED_ASSET" } }] }],
      },
    }),
  });
  const r2 = await call(b.client, "remove_auto_created_assets", { campaignId: CAMPAIGN, items: [{ assetId: "901", fieldType: "HEADLINE" }], confirm: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /confira com list_url_expansion_assets/);
});

// ══════════════════════════ diretrizes de marca ══════════════════════════

function brandCampaign(enabled: boolean, guidelines: Row = {}): Row[] {
  return pmaxCampaign([], { brandGuidelinesEnabled: enabled, brandGuidelines: guidelines });
}

function brandLink(assetId: string, fieldType: string, asset: Row): Row {
  return {
    campaignAsset: {
      resourceName: `customers/${CID}/campaignAssets/${CAMPAIGN}~${assetId}~${fieldType}`,
      asset: `customers/${CID}/assets/${assetId}`, fieldType, status: "ENABLED", source: "ADVERTISER",
    },
    asset: { id: assetId, ...asset },
  };
}

const BN = brandLink("1", "BUSINESS_NAME", { type: "TEXT", textAsset: { text: "Loja Antiga" } });
const LOGO = brandLink("2", "LOGO", { type: "IMAGE", imageAsset: { fullSize: { url: "https://img/2", widthPixels: "1200", heightPixels: "1200" } } });

const assetRows = (query: string): Row[] => {
  const catalog: Record<string, Row> = {
    "3": { id: "3", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/3", widthPixels: "1200", heightPixels: "1200" } } },
    "4": { id: "4", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/4", widthPixels: "1200", heightPixels: "300" } } },
    "5": { id: "5", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/5", widthPixels: "1200", heightPixels: "628" } } },
    "6": { id: "6", type: "TEXT", textAsset: { text: "Loja Nova" } },
    "7": { id: "7", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/7", widthPixels: "600", heightPixels: "600" } } },
    "8": { id: "8", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/8", widthPixels: "600", heightPixels: "600" } } },
    "9": { id: "9", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/9", widthPixels: "600", heightPixels: "600" } } },
    "10": { id: "10", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/10", widthPixels: "800", heightPixels: "200" } } },
  };
  if (/asset\.text_asset\.text = /.test(query)) return [];
  const ids = /asset\.id IN \(([^)]*)\)/.exec(query)?.[1].split(",").map((s) => s.trim()) ?? [];
  return ids.filter((id) => catalog[id]).map((id) => ({ asset: catalog[id] }));
};

test("get_pmax_brand_settings: ativas com contagens; desligadas listam os assets dos grupos para migrar", async () => {
  const on = fakeClient({ rows: { campaign: brandCampaign(true, { mainColor: "#112233", accentColor: "#445566", predefinedFontFamily: "Roboto" }), campaign_asset: [BN, LOGO] } });
  const r1 = await call(on.client, "get_pmax_brand_settings", { campaignId: CAMPAIGN });
  const b1 = jsonOf(r1);
  assert.equal(b1.brand_guidelines_enabled, true);
  assert.deepEqual(b1.colors, { main_color: "#112233", accent_color: "#445566" });
  assert.equal((b1.checks as Row).business_name, "1 (exige exatamente 1)");
  assert.equal((b1.campaign_brand_assets as Row[])[0].content, "Loja Antiga");

  const off = fakeClient({
    rows: {
      campaign: brandCampaign(false),
      asset_group_asset: [{ assetGroupAsset: { fieldType: "LOGO" }, assetGroup: { id: AG }, asset: { id: "2", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/2" } } } }],
    },
  });
  const r2 = await call(off.client, "get_pmax_brand_settings", { campaignId: CAMPAIGN });
  const b2 = jsonOf(r2);
  assert.equal((b2.asset_group_brand_assets as Row[])[0].asset_id, "2");
  assert.match(String(b2.next_step), /enable_pmax_brand_guidelines/);
});

test("enable_pmax_brand_guidelines: validação local (modo, logos, cores, fonte, limite de 10)", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ campaignIds: [CAMPAIGN], autoPopulateBrandAssets: true, businessNameAsset: "6" }, /OU os assets/],
    [{ campaignIds: [CAMPAIGN] }, /businessNameAsset é obrigatório/],
    [{ campaignIds: Array.from({ length: 11 }, (_, i) => String(100 + i)), autoPopulateBrandAssets: true }, /máx\. 10/],
    [{ campaignIds: [CAMPAIGN], autoPopulateBrandAssets: true, mainColor: "#000000" }, /vão juntas/],
    [{ campaignIds: [CAMPAIGN], autoPopulateBrandAssets: true, mainColor: "red", accentColor: "#000000" }, /hex #RRGGBB/],
    [{ campaignIds: [CAMPAIGN], autoPopulateBrandAssets: true, fontFamily: "roboto" }, /fontFamily "roboto" não aceita/],
    [{ campaignIds: [CAMPAIGN], businessNameAsset: "6", logoAssets: ["3", "7", "8"], landscapeLogoAssets: ["4", "9", "5"] }, /máx\. 5/],
    [{ campaignIds: [CAMPAIGN], autoPopulateBrandAssets: true, finalUriDomain: "não é domínio" }, /não é um domínio/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "enable_pmax_brand_guidelines", { ...args, confirm: true });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length, 0);
    nothingSent(calls);
  }
});

test("enable_pmax_brand_guidelines: confirm, puladas, payload do EnableOperation e erro por campanha", async () => {
  const campaigns = [
    { campaign: { id: "555", name: "PMax A", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false } },
    { campaign: { id: "556", name: "PMax B", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: true } },
    { campaign: { id: "557", name: "PMax C", status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false } },
  ];
  const args = {
    campaignIds: ["555", "556", "557", "558"], businessNameAsset: "6", logoAssets: ["3"], landscapeLogoAssets: ["4"],
    finalUriDomain: "https://www.loja.com.br/tenis", mainColor: "#112233", accentColor: "#445566", fontFamily: "Playfair Display",
  };
  const noConfirm = fakeClient({ rows: { campaign: campaigns, asset: assetRows } });
  const r0 = await call(noConfirm.client, "enable_pmax_brand_guidelines", args);
  assert.equal(r0.isError, true);
  assert.match(textOf(r0), /irreversível/);
  nothingSent(noConfirm.calls);

  const { client, calls } = fakeClient({
    rows: { campaign: campaigns, asset: assetRows },
    action: () => ({
      results: [
        { campaign: `customers/${CID}/campaigns/555` },
        { campaign: `customers/${CID}/campaigns/557`, enablementError: { code: 3, message: "Logo limit.", details: [{ errors: [{ message: "Too many logos", errorCode: { brandGuidelinesMigrationError: "BRAND_GUIDELINES_LOGO_LIMIT_EXCEEDED" } }] }] } },
      ],
    }),
  });
  const result = await call(client, "enable_pmax_brand_guidelines", { ...args, confirm: true });
  assert.equal(calls.actions[0].action, "campaigns:enablePMaxBrandGuidelines");
  const operations = (calls.actions[0].body as { operations: Row[] }).operations;
  assert.equal(operations.length, 2, "556 já tinha diretrizes; 558 não existe");
  assert.deepEqual(operations[0], {
    campaign: `customers/${CID}/campaigns/555`,
    autoPopulateBrandAssets: false,
    brandAssets: {
      businessNameAsset: `customers/${CID}/assets/6`,
      logoAsset: [`customers/${CID}/assets/3`],
      landscapeLogoAsset: [`customers/${CID}/assets/4`],
    },
    finalUriDomain: "www.loja.com.br",
    mainColor: "#112233",
    accentColor: "#445566",
    fontFamily: "Playfair Display",
  });
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.deepEqual((body.enabled as Row[]).map((item) => item.campaign_id), ["555"]);
  assert.match(String((body.errors as Row[])[0].error), /Máximo de 5 logotipos/);
  assert.equal((body.skipped as Row[]).length, 2);
});

test("enable_pmax_brand_guidelines: asset de tipo/proporção errada e dry-run não chamam o endpoint", async () => {
  const campaign = [{ campaign: { id: "555", name: "A", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false } }];
  const a = fakeClient({ rows: { campaign, asset: assetRows } });
  const r1 = await call(a.client, "enable_pmax_brand_guidelines", { campaignIds: ["555"], businessNameAsset: "3", logoAssets: ["5"], confirm: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /asset 3 é IMAGE, e o nome da empresa precisa ser TEXT/);
  assert.match(textOf(r1), /LOGO exige proporção 1:1/);
  nothingSent(a.calls);

  const b = fakeClient({ rows: { campaign } });
  const r2 = await call(b.client, "enable_pmax_brand_guidelines", { campaignIds: ["555"], autoPopulateBrandAssets: true, confirm: true, validateOnly: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não aceita validate_only/);
  assert.equal(b.calls.actions.length, 0);
});

test("update_pmax_brand_assets: troca o nome (asset de texto novo com ID temporário) adicionando antes de remover", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: brandCampaign(true), campaign_asset: [BN, LOGO], asset: assetRows } });
  const noConfirm = await call(client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, businessNameText: "Loja Nova Marca" });
  assert.equal(noConfirm.isError, true);
  assert.match(textOf(noConfirm), /confirm: true/);
  nothingSent(calls);

  const result = await call(client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, businessNameText: "Loja Nova Marca", confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  const campaign = `customers/${CID}/campaigns/${CAMPAIGN}`;
  assert.deepEqual(calls.writes[0].operations, [
    { assetOperation: { create: { resourceName: `customers/${CID}/assets/-1`, textAsset: { text: "Loja Nova Marca" } } } },
    { campaignAssetOperation: { create: { campaign, asset: `customers/${CID}/assets/-1`, fieldType: "BUSINESS_NAME" } } },
    { campaignAssetOperation: { remove: `customers/${CID}/campaignAssets/${CAMPAIGN}~1~BUSINESS_NAME` } },
  ]);
  assert.equal(calls.writes[0].method, "batchMutate", "uma chamada atômica");
});

test("update_pmax_brand_assets: regras de contagem, proporção e diretrizes desligadas", async () => {
  const rows = { campaign: brandCampaign(true), campaign_asset: [BN, LOGO], asset: assetRows };
  const cases: Array<[Row, RegExp]> = [
    [{ removeLogos: ["2"], confirm: true }, /nenhum logo quadrado \(LOGO\) restaria/],
    [{ addLogos: ["3", "7", "8"], addLandscapeLogos: ["4", "10"], confirm: true }, /6 logos no total \(máx\. 5\)/],
    [{ addLandscapeLogos: ["9"] }, /asset 9 tem 600x600 — LANDSCAPE_LOGO exige proporção 4:1/],
    [{ addLandscapeLogos: ["5"] }, /LANDSCAPE_LOGO exige proporção 4:1/],
    [{ removeLandscapeLogos: ["4"], confirm: true }, /não estão vinculados/],
    [{ businessNameText: "Um nome grande demais para a regra" }, /máx\. 25/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    nothingSent(calls);
  }
  const off = fakeClient({ rows: { ...rows, campaign: brandCampaign(false) } });
  const r = await call(off.client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, fontFamily: "Lato" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /enable_pmax_brand_guidelines/);
  nothingSent(off.calls);
});

test("update_pmax_brand_assets: cores e fonte vão como folhas de brand_guidelines; logo novo sem remoção dispensa confirm", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: brandCampaign(true, { mainColor: "#000000", accentColor: "#ffffff", predefinedFontFamily: "Lato" }), campaign_asset: [BN, LOGO], asset: assetRows },
  });
  const result = await call(client, "update_pmax_brand_assets", {
    campaignId: CAMPAIGN, addLogos: ["3"], mainColor: "#112233", accentColor: "#445566", fontFamily: "Lato",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.writes[0].operations as Row[];
  assert.deepEqual(ops[0], { campaignAssetOperation: { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN}`, asset: `customers/${CID}/assets/3`, fieldType: "LOGO" } } });
  const update = ops[1].campaignOperation as { update: Row; updateMask: string };
  assert.equal(update.updateMask, "brand_guidelines.main_color,brand_guidelines.accent_color");
  assertUpdateMaskLeaves(update.updateMask);
  assert.deepEqual(update.update.brandGuidelines, { mainColor: "#112233", accentColor: "#445566" });
  assert.match(textOf(result), /fonte/, "fonte igual fica em unchanged");

  const same = fakeClient({ rows: { campaign: brandCampaign(true, { predefinedFontFamily: "Lato" }), campaign_asset: [BN, LOGO], asset: assetRows } });
  const r2 = await call(same.client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, fontFamily: "Lato", addLogos: ["2"] });
  assert.match(textOf(r2), /nada a mudar/);
  nothingSent(same.calls);

  const dry = fakeClient({ rows: { campaign: brandCampaign(true), campaign_asset: [BN, LOGO], asset: assetRows } });
  const r3 = await call(dry.client, "update_pmax_brand_assets", { campaignId: CAMPAIGN, fontFamily: "Oswald", validateOnly: true });
  assert.equal(r3.isError, undefined, textOf(r3));
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r3), /DRY-RUN/);
});

// ══════════════════════════ prévias ══════════════════════════

test("get_shareable_preview: UI_PREVIEW para grupo PMax e YOUTUBE_LIVE_PREVIEW para vídeo, com validade", async () => {
  const { client, calls } = fakeClient({
    rows: {
      asset_group: [assetGroupRow()],
      ad_group_ad: [{ adGroupAd: { resourceName: `customers/${CID}/adGroupAds/10~20`, ad: { id: "20", type: "VIDEO_RESPONSIVE_AD" } } }],
    },
    action: () => ({
      result: {
        previews: [
          { assetGroup: AG_RN, uiPreviewResult: { shareablePreviewUrl: "https://ads.google.com/preview/abc" }, expirationDateTime: "2026-10-01T00:00:00Z" },
          { adGroupAd: `customers/${CID}/adGroupAds/10~20`, youtubeLivePreviewResult: { youtubePreviewUrl: "https://yt/1", youtubeTvPreviewUrl: "https://yt/tv/1" } },
        ],
      },
    }),
  });
  const result = await call(client, "get_shareable_preview", { assetGroupIds: [AG], adGroupAdIds: ["10~20"] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.actions[0].method, "customerAction", "não é escrita");
  assert.equal(calls.actions[0].action, ":generateShareablePreviews");
  assert.deepEqual(calls.actions[0].body, {
    operation: {
      shareablePreviews: [
        { previewType: "UI_PREVIEW", assetGroup: AG_RN },
        { previewType: "YOUTUBE_LIVE_PREVIEW", adGroupAd: `customers/${CID}/adGroupAds/10~20` },
      ],
    },
  });
  const previews = jsonOf(result) as unknown as Row[];
  assert.equal(previews[0].preview_url, "https://ads.google.com/preview/abc");
  assert.equal(previews[0].expires_at, "2026-10-01T00:00:00Z");
  assert.equal(previews[1].youtube_tv_preview_url, "https://yt/tv/1");
});

test("get_shareable_preview: RSA, grupo inexistente, formato ruim e mais de 10 itens são recusados antes da API", async () => {
  const rsa = fakeClient({
    rows: { ad_group_ad: [{ adGroupAd: { resourceName: `customers/${CID}/adGroupAds/10~21`, ad: { id: "21", type: "RESPONSIVE_SEARCH_AD" } } }] },
  });
  const r1 = await call(rsa.client, "get_shareable_preview", { adGroupAdIds: ["10~21"], assetGroupIds: ["404"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /RESPONSIVE_SEARCH_AD/);
  assert.match(textOf(r1), /grupo de recursos 404 não existe/);
  assert.equal(rsa.calls.actions.length, 0);

  for (const args of [{ adGroupAdIds: ["20"] }, { assetGroupIds: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, {}]) {
    const { client, calls } = fakeClient();
    const r = await call(client, "get_shareable_preview", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.actions.length, 0);
  }
});

// ══════════════════════════ combinações ══════════════════════════

test("get_pmax_top_combinations: resolve cada asset para texto, imagem ou vídeo e respeita o limite", async () => {
  const combo = (ids: Array<[string, string]>) => ({
    assetCombinationServedAssets: ids.map(([id, fieldType]) => ({ asset: `customers/${CID}/assets/${id}`, servedAssetFieldType: fieldType })),
  });
  const { client, calls } = fakeClient({
    rows: {
      asset_group_top_combination_view: [{
        assetGroupTopCombinationView: {
          assetGroupTopCombinations: [combo([["61", "HEADLINE_1"], ["62", "MARKETING_IMAGE"]]), combo([["63", "YOUTUBE_VIDEO"]]), combo([["61", "HEADLINE_1"]])],
        },
        assetGroup: { id: AG, name: "Tênis" },
        campaign: { id: CAMPAIGN, name: "PMax Loja" },
      }],
      asset: [
        { asset: { id: "61", type: "TEXT", textAsset: { text: "Frete grátis" } } },
        { asset: { id: "62", type: "IMAGE", imageAsset: { fullSize: { url: "https://img/62" } } } },
        { asset: { id: "63", type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: "abc123" } } },
      ],
    },
  });
  const result = await call(client, "get_pmax_top_combinations", { campaignId: CAMPAIGN, limitPerGroup: 2 });
  assert.equal(result.isError, undefined, textOf(result));
  const [group] = jsonOf(result) as unknown as Row[];
  const combos = group.combinations as Row[];
  assert.equal(combos.length, 2);
  assert.deepEqual((combos[0].assets as Row[]).map((a) => a.content), ["Frete grátis", "https://img/62"]);
  assert.equal((combos[1].assets as Row[])[0].content, "https://www.youtube.com/watch?v=abc123");
  assert.ok(!/segments\.date/.test(calls.queries[0]), "sem período, sem filtro de data");

  const withDates = fakeClient();
  await call(withDates.client, "get_pmax_top_combinations", { assetGroupId: AG, dateRange: { since: "2026-08-01", until: "2026-08-31" }, format: "table" });
  assert.match(withDates.calls.queries[0], /asset_group\.id = 777 AND segments\.date BETWEEN '2026-08-01' AND '2026-08-31'/);

  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_pmax_top_combinations", {})).isError, true);
  assert.equal((await call(bad.client, "get_pmax_top_combinations", { assetGroupId: "1 OR 1" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ══════════════════════════ tools do núcleo ══════════════════════════

test("add_audience_signal: tema novo, tema repetido (no-op), público em conflito e ID inválido", async () => {
  const rows = { asset_group: [assetGroupRow()], asset_group_signal: [themeSignal("1", "Tênis"), audienceSignal("2", `customers/${CID}/audiences/8`)], audience: [audienceRow()] };
  const ok = fakeClient({ rows });
  const r1 = await call(ok.client, "add_audience_signal", { assetGroupId: AG, signalType: "search_theme", searchThemeText: "  tênis  de corrida " });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.deepEqual(ok.calls.writes[0].operations, [{ create: { assetGroup: AG_RN, searchTheme: { text: "tênis de corrida" } } }]);

  const dup = fakeClient({ rows });
  const r2 = await call(dup.client, "add_audience_signal", { assetGroupId: AG, signalType: "search_theme", searchThemeText: "TÊNIS" });
  assert.match(textOf(r2), /já existe/);
  nothingSent(dup.calls);

  const clash = fakeClient({ rows });
  const r3 = await call(clash.client, "add_audience_signal", { assetGroupId: AG, signalType: "audience", audienceResourceName: "44" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /ONE_AUDIENCE_ALLOWED_PER_ASSET_GROUP/);
  nothingSent(clash.calls);

  const bad = fakeClient();
  const r4 = await call(bad.client, "add_audience_signal", { assetGroupId: "7'77", signalType: "search_theme", searchThemeText: "x" });
  assert.equal(r4.isError, true);
  assert.equal(bad.calls.queries.length, 0);

  const dry = fakeClient({ rows: { asset_group: [assetGroupRow()], audience: [audienceRow()] } });
  const r5 = await call(dry.client, "add_audience_signal", { assetGroupId: AG, signalType: "audience", audienceResourceName: AUD_RN, validateOnly: true });
  assert.equal(r5.isError, undefined, textOf(r5));
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r5), /DRY-RUN/);
  assert.deepEqual(dry.calls.writes[0].operations, [{ create: { assetGroup: AG_RN, audience: { audience: AUD_RN } } }]);
});

test("create_audience_from_lists: aceita ID ou resource name, confere as listas e não manda status", async () => {
  const { client, calls } = fakeClient({ rows: { ...segmentRows } });
  const result = await call(client, "create_audience_from_lists", { name: "Remarketing", userListResourceNames: ["10", `customers/${CID}/userLists/12`] });
  assert.equal(result.isError, undefined, textOf(result));
  const create = (calls.writes[0].operations[0] as { create: Row }).create;
  assert.deepEqual(create, {
    scope: "CUSTOMER",
    name: "Remarketing",
    dimensions: [{ audienceSegments: { segments: [
      { userList: { userList: `customers/${CID}/userLists/10` } },
      { userList: { userList: `customers/${CID}/userLists/12` } },
    ] } }],
  });

  const missing = fakeClient({ rows: { ...segmentRows } });
  const r2 = await call(missing.client, "create_audience_from_lists", { name: "X", userListResourceNames: ["99"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não encontrados/);
  nothingSent(missing.calls);

  const empty = fakeClient();
  assert.equal((await call(empty.client, "create_audience_from_lists", { name: "X", userListResourceNames: [] })).isError, true);
  assert.equal(empty.calls.queries.length, 0);
});

test("get_asset_group_performance: valida IDs, filtra um grupo e oferece csv", async () => {
  const bad = fakeClient();
  const r1 = await call(bad.client, "get_asset_group_performance", { campaignId: "1 OR 1=1" });
  assert.equal(r1.isError, true);
  assert.equal(bad.calls.queries.length, 0);

  const { client, calls } = fakeClient({
    rows: {
      asset_group: [{
        assetGroup: { id: AG, name: "Tênis", status: "ENABLED", adStrength: "GOOD", primaryStatus: "ELIGIBLE" },
        metrics: { costMicros: "10000000", impressions: "1000", clicks: "50", conversions: 2, conversionsValue: 300 },
      }],
    },
  });
  const result = await call(client, "get_asset_group_performance", { campaignId: CAMPAIGN, assetGroupId: AG, format: "csv" });
  assert.match(calls.queries[0], /AND asset_group\.id = 777/);
  assert.match(textOf(result), /asset_group_id,name,status,primary_status,ad_strength,spend/);
  assert.match(textOf(result), /777,Tênis,ENABLED,ELIGIBLE,GOOD,10,1000,50,2,300,30,5/);
});

// ══════════════════════════ client real (fetch interceptado) ══════════════════════════

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

test("client real: caminhos REST dos endpoints customizados e validate_only onde existe", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      const query = String(body.query);
      assertGaqlRules(query);
      if (/FROM campaign\s/.test(query)) {
        return [{ results: [{ campaign: { id: "555", name: "A", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false } }] }];
      }
      if (/FROM asset_group\s/.test(query)) return [{ results: [assetGroupRow()] }];
      return [{ results: [] }];
    }
    if (url.endsWith(":generateShareablePreviews")) return { result: { previews: [{ assetGroup: AG_RN, uiPreviewResult: { shareablePreviewUrl: "https://p" } }] } };
    if (url.endsWith(":enablePMaxBrandGuidelines")) return { results: [{ campaign: `customers/${CID}/campaigns/555` }] };
    return {};
  });
  try {
    const handlers = register(realClient());
    await handlers.get("get_shareable_preview")!({ customerId: CID, assetGroupIds: [AG] });
    assert.ok(net.sent.some((s) => s.url.endsWith(`/customers/${CID}:generateShareablePreviews`)));

    await handlers.get("enable_pmax_brand_guidelines")!({ customerId: CID, campaignIds: ["555"], autoPopulateBrandAssets: true, confirm: true });
    const enable = net.sent.find((s) => s.url.endsWith(`/customers/${CID}/campaigns:enablePMaxBrandGuidelines`));
    assert.ok(enable, "POST /v25/customers/{cid}/campaigns:enablePMaxBrandGuidelines");
    assert.equal(enable.body.validateOnly, undefined);

    net.sent.length = 0;
    const dry = await handlers.get("manage_asset_group_signals")!({ customerId: CID, assetGroupId: AG, addSearchThemes: ["tênis"], validateOnly: true });
    const write = net.sent.find((s) => s.url.endsWith("/assetGroupSignals:mutate"));
    assert.ok(write);
    assert.equal(write.body.validateOnly, true);
    assert.equal(write.body.partialFailure, true);
    assert.match(textOf(dry), /^VALIDATE-ONLY/);

    net.sent.length = 0;
    const blocked = await handlers.get("enable_pmax_brand_guidelines")!({
      customerId: CID, campaignIds: ["555"], autoPopulateBrandAssets: true, confirm: true, validateOnly: true,
    });
    assert.equal(blocked.isError, true);
    assert.ok(!net.sent.some((s) => s.url.includes("enablePMaxBrandGuidelines")), "sem validate_only no endpoint: nada é enviado");
  } finally {
    net.restore();
  }
});
