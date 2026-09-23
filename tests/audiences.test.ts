/**
 * Lote audiences — públicos, remarketing e Customer Match.
 *
 * Cobre as tools novas do módulo src/tools/audiences.ts e as antigas corrigidas
 * (create_audience_segment, update_ad_group_targeting, create_remarketing_list,
 * update_remarketing_list, list_remarketing_lists, list_audience_segments): formato do
 * payload v25, validação antes de qualquer chamada, no-op, erros da API, dry-run,
 * validateOnly e os portões de confirm. Toda query passa pelo validador de GAQL real.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerGoogleAdsTools } from "../src/tools.js";
import { normalizeEmail, normalizePhone, prepareCustomerMatchMembers, sha256Hex, likeLiteral } from "../src/tools/audiences.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN = "111";
const AD_GROUP = "222";

// ── Client falso ──────────────────────────────────────────────────────

interface Write {
  method: string;
  resource?: string;
  operations?: Row[];
  options?: Row;
  action?: string;
  body?: Row;
  dryRun: boolean;
}

interface FakeOptions {
  /** Linhas por consulta: recebe a query e devolve as linhas (default: nenhuma). */
  rows?: (query: string) => Row[];
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
  batchMutate?: (operations: Row[]) => Row;
  writeAction?: (action: string, body: Row) => Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[] };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      assertGaqlRules(query);
      calls.queries.push(query.replace(/\s+/g, " ").trim());
      return opts.rows?.(query.replace(/\s+/g, " ")) ?? [];
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options, dryRun });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(resource, operations, options);
      if (dryRun) return {};
      return { results: operations.map((_op, i) => ({ resourceName: `customers/${CID}/${resource}/9${i}` })) };
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => {
          const kind = Object.keys(op)[0].replace(/Operation$/, "Result");
          return { [kind]: { resourceName: `customers/${CID}/x/${i}` } };
        }),
      };
    },
    async customerWriteAction(_customerId: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ method: "customerWriteAction", action, body, dryRun });
      if (dryRun) throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      if (opts.writeAction) return opts.writeAction(action, body);
      if (action === "offlineUserDataJobs:create") return { resourceName: `customers/${CID}/offlineUserDataJobs/555` };
      if (action.endsWith(":run")) return { name: `customers/${CID}/operations/abc` };
      return {};
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function handlers(client: unknown) {
  const map = new Map<string, Handler>();
  const fakeMcp = { registerTool: (name: string, _config: unknown, handler: Handler) => map.set(name, handler) };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, [], false);
  return map;
}

const call = (client: unknown, tool: string, args: Row) => handlers(client).get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const from = (query: string) => /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";

// Fixtures REST (camelCase, como a API devolve)
const campaignRow = (channel: string, restrictions: Row[] = [], id = CAMPAIGN) => ({
  campaign: { id, name: `Camp ${channel}`, status: "ENABLED", advertisingChannelType: channel, targetingSetting: { targetRestrictions: restrictions } },
});
const adGroupRow = (channel: string, opts: { grouped?: boolean; own?: Row[]; campaign?: Row[] } = {}) => ({
  adGroup: {
    id: AD_GROUP, name: "Grupo A", status: "ENABLED", type: "SEARCH_STANDARD",
    audienceSetting: { useAudienceGrouped: opts.grouped === true },
    targetingSetting: { targetRestrictions: opts.own ?? [] },
  },
  campaign: { id: CAMPAIGN, name: `Camp ${channel}`, status: "ENABLED", advertisingChannelType: channel, targetingSetting: { targetRestrictions: opts.campaign ?? [] } },
});
const userListRow = (id: string, extra: Row = {}) => ({ userList: { id, name: `Lista ${id}`, type: "RULE_BASED", membershipStatus: "OPEN", eligibleForSearch: true, eligibleForDisplay: true, ...extra } });

/** Roteia as leituras do add_audience_segment_targeting. */
function targetingRows(parts: {
  campaign?: Row; adGroup?: Row; userLists?: Row[]; audiences?: Row[]; interests?: Row[]; lifeEvents?: Row[];
  customAudiences?: Row[]; combinedAudiences?: Row[];
  campaignCriteria?: Row[]; adGroupCriteria?: Row[]; adGroupSettings?: Row[];
}) {
  return (q: string): Row[] => {
    switch (from(q)) {
      case "campaign": return parts.campaign ? [parts.campaign] : [];
      case "ad_group": return q.includes("WHERE campaign.id") ? parts.adGroupSettings ?? [] : parts.adGroup ? [parts.adGroup] : [];
      case "user_list": return parts.userLists ?? [];
      case "audience": return parts.audiences ?? [];
      case "user_interest": return parts.interests ?? [];
      case "life_event": return parts.lifeEvents ?? [];
      case "custom_audience": return parts.customAudiences ?? [];
      case "combined_audience": return parts.combinedAudiences ?? [];
      case "campaign_criterion": return parts.campaignCriteria ?? [];
      case "ad_group_criterion": return parts.adGroupCriteria ?? [];
      default: return [];
    }
  };
}

// ── create_audience_segment / update_custom_audience (item 6) ─────────

test("create_audience_segment: membros no formato v25 (member_type + oneof), sem status, tipo AUTO", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_audience_segment", {
    name: "Concorrentes", description: "Sites de concorrentes",
    keywords: ["tênis de corrida", "tênis de corrida"], urls: ["https://concorrente.com.br"], apps: ["com.concorrente.app"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.resource, "customAudiences");
  const create = (write.operations![0] as { create: Row }).create;
  assert.deepEqual(create, {
    name: "Concorrentes", type: "AUTO", description: "Sites de concorrentes",
    members: [
      { memberType: "KEYWORD", keyword: "tênis de corrida" },
      { memberType: "URL", url: "https://concorrente.com.br" },
      { memberType: "APP", app: "com.concorrente.app" },
    ],
  });
  assert.ok(!("status" in create), "status é OUTPUT_ONLY");
  assert.doesNotMatch(JSON.stringify(create), /keywordInfo|urlInfo/);
  assert.match(textOf(result), /customers\/1234567890\/customAudiences\/90/);
});

test("create_audience_segment: entrada inválida é recusada antes de qualquer chamada", async () => {
  for (const args of [
    { name: "X", urls: ["concorrente.com.br"] },
    { name: "X", keywords: ["um dois tres quatro cinco seis sete oito nove dez onze"] },
    { name: "X", keywords: ["a".repeat(81)] },
    { name: "X", apps: ["nao e pacote"] },
    { name: "X" },
    { name: "X", keywords: ["ok"], type: "INTEREST" },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_audience_segment", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, `nada enviado para ${JSON.stringify(args)}`);
  }
});

test("create_audience_segment: nome repetido (sem diferenciar maiúsculas) não grava; erro da API explicado", async () => {
  const dup = fakeClient({ rows: () => [{ customAudience: { id: "7", name: "concorrentes", status: "ENABLED" } }] });
  const refused = await call(dup.client, "create_audience_segment", { name: "Concorrentes", keywords: ["x"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Já existe/);
  assert.equal(dup.calls.writes.length, 0);

  const failing = fakeClient({ mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The pair of [type, value] already exists in members."); } });
  const result = await call(failing.client, "create_audience_segment", { name: "Novo", keywords: ["x"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /nada foi criado/);
});

test("create_audience_segment: dry-run e validateOnly não dizem que criaram", async () => {
  const dry = fakeClient({ dryRun: true });
  const result = await call(dry.client, "create_audience_segment", { name: "Novo", keywords: ["x"] });
  assert.match(textOf(result), /DRY-RUN/);
  assert.doesNotMatch(textOf(result), /criado:/);

  const { client, calls } = fakeClient();
  const validated = await call(client, "create_audience_segment", { name: "Novo", keywords: ["x"], validateOnly: true });
  assert.match(textOf(validated), /VALIDATE-ONLY/);
  assert.equal(calls.writes[0].dryRun, true, "a mutação saiu pelo client em dry-run");
});

test("update_custom_audience: add preserva membros e PLACE_CATEGORY; remove; replace; no-op; vazio recusado", async () => {
  const current = {
    customAudience: {
      id: "77", name: "Seg", description: "", type: "AUTO", status: "ENABLED",
      members: [{ memberType: "KEYWORD", keyword: "tenis" }, { memberType: "PLACE_CATEGORY", placeCategory: "123" }],
    },
  };
  const rows = () => [current];

  const add = fakeClient({ rows });
  const added = await call(add.client, "update_custom_audience", { customAudienceId: "77", urls: ["https://x.com.br"] });
  assert.equal(added.isError, undefined, textOf(added));
  const op = add.calls.writes[0].operations![0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "members");
  assert.deepEqual(op.update.members, [
    { memberType: "KEYWORD", keyword: "tenis" },
    { memberType: "PLACE_CATEGORY", placeCategory: "123" },
    { memberType: "URL", url: "https://x.com.br" },
  ]);

  const replace = fakeClient({ rows });
  await call(replace.client, "update_custom_audience", { customAudienceId: "77", membersMode: "replace", keywords: ["corrida"] });
  assert.deepEqual((replace.calls.writes[0].operations![0] as { update: Row }).update.members, [
    { memberType: "PLACE_CATEGORY", placeCategory: "123" },
    { memberType: "KEYWORD", keyword: "corrida" },
  ]);

  const noop = fakeClient({ rows });
  const same = await call(noop.client, "update_custom_audience", { customAudienceId: "77", keywords: ["TENIS"] });
  assert.match(textOf(same), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const onlyKeyword = { customAudience: { ...current.customAudience, members: [{ memberType: "KEYWORD", keyword: "tenis" }] } };
  const empty = fakeClient({ rows: () => [onlyKeyword] });
  const refused = await call(empty.client, "update_custom_audience", { customAudienceId: "77", membersMode: "remove", keywords: ["tenis"] });
  assert.equal(refused.isError, true);
  assert.equal(empty.calls.writes.length, 0);

  const missing = fakeClient();
  assert.equal((await call(missing.client, "update_custom_audience", { customAudienceId: "77", name: "x" })).isError, true);
  assert.equal((await call(missing.client, "update_custom_audience", { customAudienceId: "abc", name: "x" })).isError, true);
});

test("update_custom_audience: renomear para um nome já usado (sem diferenciar maiúsculas) é recusado", async () => {
  const rows = (q: string): Row[] => q.includes("WHERE custom_audience.id = 77")
    ? [{ customAudience: { id: "77", name: "Seg", description: "", type: "AUTO", status: "ENABLED", members: [{ memberType: "KEYWORD", keyword: "tenis" }] } }]
    : [
      { customAudience: { id: "77", name: "Seg", status: "ENABLED" } },
      { customAudience: { id: "88", name: "Concorrentes", status: "ENABLED" } },
      { customAudience: { id: "99", name: "Antigo", status: "REMOVED" } },
    ];
  const dup = fakeClient({ rows });
  const refused = await call(dup.client, "update_custom_audience", { customAudienceId: "77", name: "  concorrentes " });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /Já existe o segmento "Concorrentes" \(ID 88\)/);
  assert.equal(dup.calls.writes.length, 0);

  // Nome de um segmento removido fica livre
  const free = fakeClient({ rows });
  const renamed = await call(free.client, "update_custom_audience", { customAudienceId: "77", name: "antigo" });
  assert.equal(renamed.isError, undefined, textOf(renamed));
  assert.deepEqual(free.calls.writes[0].operations, [{ update: { resourceName: `customers/${CID}/customAudiences/77`, name: "antigo" }, updateMask: "name" }]);
});

// ── Busca de segmentos ────────────────────────────────────────────────

test("search_audience_segments: todo tipo monta GAQL válido; LIKE escapa % _ [ ] e aspas", async () => {
  for (const type of ["AUDIENCE", "USER_LIST", "AFFINITY", "IN_MARKET", "LIFE_EVENT", "DETAILED_DEMOGRAPHIC", "CUSTOM", "COMBINED"]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "search_audience_segments", { type, query: "50% off_[x] d'água" });
    assert.equal(result.isError, undefined, `${type}: ${textOf(result)}`);
    assert.equal(calls.queries.length, 1);
    assert.match(calls.queries[0], /LIKE '%50\[%\] off\[_\]\[\[\]x\[\]\] d\\'água%'/);
  }
  assert.equal(likeLiteral("a_b"), "a[_]b");
  const { client, calls } = fakeClient();
  await call(client, "search_audience_segments", { type: "IN_MARKET" });
  assert.match(calls.queries[0], /user_interest\.taxonomy_type = 'IN_MARKET'/);
  const bad = await call(client, "search_audience_segments", { type: "IN_MARKET", limit: 0 });
  assert.equal(bad.isError, true);
});

test("list_audience_segments: sem type continua listando Audiences (compatível)", async () => {
  const { client, calls } = fakeClient({ rows: () => [{ audience: { id: "5", name: "Compradores", resourceName: `customers/${CID}/audiences/5`, status: "ENABLED" } }] });
  const result = await call(client, "list_audience_segments", {});
  assert.equal(from(calls.queries[0]), "audience");
  assert.match(textOf(result), /"targeting_type": "AUDIENCE"/);
  await call(client, "list_audience_segments", { type: "USER_LIST" });
  assert.equal(from(calls.queries[1]), "user_list");
});

// ── add_audience_segment_targeting (item 7) ───────────────────────────

test("targeting: RLSA em Pesquisa sem restrição vira Observação na mesma operação atômica", async () => {
  const { client, calls } = fakeClient({ rows: targetingRows({ campaign: campaignRow("SEARCH"), userLists: [userListRow("10")] }) });
  const result = await call(client, "add_audience_segment_targeting", {
    level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10", bidModifier: 1.3 }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const [setting, create] = calls.writes[0].operations as Row[];
  assert.deepEqual(setting, {
    campaignOperation: {
      update: { resourceName: `customers/${CID}/campaigns/${CAMPAIGN}`, targetingSetting: { targetRestrictions: [{ targetingDimension: "AUDIENCE", bidOnly: true }] } },
      updateMask: "targeting_setting.target_restrictions",
    },
  });
  assert.deepEqual(create, {
    campaignCriterionOperation: {
      create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN}`, userList: { userList: `customers/${CID}/userLists/10` }, negative: false, bidModifier: 1.3 },
    },
  });
  assert.match(textOf(result), /Observação/);
});

test("targeting: Pesquisa com segmentos positivos em Segmentação implícita pede modo explícito", async () => {
  const existing = { adGroup: { id: AD_GROUP }, adGroupCriterion: { criterionId: "1", type: "USER_LIST", negative: false, userList: { userList: `customers/${CID}/userLists/99` } } };
  const { client, calls } = fakeClient({
    rows: targetingRows({ adGroup: adGroupRow("SEARCH"), userLists: [userListRow("10")], adGroupCriteria: [existing] }),
  });
  const result = await call(client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /targetingMode OBSERVATION/);
  assert.equal(calls.writes.length, 0);

  // Com o modo explícito, grava (TARGETING já é o efetivo: nenhuma troca de setting)
  const explicit = fakeClient({
    rows: targetingRows({ adGroup: adGroupRow("SEARCH"), userLists: [userListRow("10")], adGroupCriteria: [existing] }),
  });
  const ok = await call(explicit.client, "add_audience_segment_targeting", {
    level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }], targetingMode: "TARGETING",
  });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.deepEqual(explicit.calls.writes[0].operations!.map((op) => Object.keys(op)[0]), ["adGroupCriterionOperation"]);
});

test("targeting: restrição explícita existente é mantida; level=campaign recebe a troca pedida", async () => {
  const restr = [{ targetingDimension: "AUDIENCE", bidOnly: false }, { targetingDimension: "TOPIC", bidOnly: true }];
  const keep = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("SEARCH", { campaign: restr }), userLists: [userListRow("10")] }) });
  await call(keep.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] });
  assert.deepEqual(keep.calls.writes[0].operations!.map((op) => Object.keys(op)[0]), ["adGroupCriterionOperation"]);

  const change = fakeClient({ rows: targetingRows({ campaign: campaignRow("SEARCH", restr), userLists: [userListRow("10")] }) });
  const result = await call(change.client, "add_audience_segment_targeting", {
    level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }], targetingMode: "OBSERVATION",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const setting = (change.calls.writes[0].operations![0] as { campaignOperation: { update: Row } }).campaignOperation.update;
  assert.equal(setting.resourceName, `customers/${CID}/campaigns/${CAMPAIGN}`);
  assert.deepEqual((setting.targetingSetting as Row).targetRestrictions, [
    { targetingDimension: "TOPIC", bidOnly: true },
    { targetingDimension: "AUDIENCE", bidOnly: true },
  ], "a lista inteira é reenviada, com TOPIC preservado");
  assert.match(textOf(result), /vale para todos os grupos/);
});

test("targeting: pedido de grupo nunca troca o modo guardado na campanha (vale para todos os grupos)", async () => {
  // Campanha em Observação; outro grupo (333) tem um segmento positivo que passaria a restringir o alcance
  const observation = [{ targetingDimension: "AUDIENCE", bidOnly: true }];
  const otherGroup = { adGroup: { id: "333" }, adGroupCriterion: {
    criterionId: "9", resourceName: `customers/${CID}/adGroupCriteria/333~9`, type: "USER_INTEREST", negative: false,
    userInterest: { userInterestCategory: `customers/${CID}/userInterests/80` },
  } };
  const rows = (campaign: Row[]) => targetingRows({
    adGroup: adGroupRow("SEARCH", { campaign }), userLists: [userListRow("10")], adGroupCriteria: [otherGroup],
  });

  // add_audience_segment_targeting level=adGroup com targetingMode diferente do da campanha
  const escalate = fakeClient({ rows: rows(observation) });
  const refused = await call(escalate.client, "add_audience_segment_targeting", {
    level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }], targetingMode: "TARGETING",
  });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /set_targeting_mode level=campaign campaignId=111 mode=TARGETING/);
  assert.match(textOf(refused), /targetingMode KEEP/);
  assert.match(textOf(refused), /333/, "lista os grupos afetados");
  assert.equal(escalate.calls.writes.length, 0, "nenhuma escrita — nem o critério, nem a campanha");

  // O mesmo pela tool antiga, que delega
  const legacy = fakeClient({ rows: rows(observation) });
  const legacyResult = await call(legacy.client, "update_ad_group_targeting", {
    adGroupId: AD_GROUP, audienceResourceName: `customers/${CID}/userLists/10`, targetingMode: "TARGETING",
  });
  assert.equal(legacyResult.isError, true, textOf(legacyResult));
  assert.match(textOf(legacyResult), /set_targeting_mode level=campaign/);
  assert.equal(legacy.calls.writes.length, 0);

  // Sentido inverso: campanha em Segmentação explícita, pedido de Observação no grupo
  const toObservation = fakeClient({ rows: rows([{ targetingDimension: "AUDIENCE", bidOnly: false }]) });
  const refusedObs = await call(toObservation.client, "update_ad_group_targeting", {
    adGroupId: AD_GROUP, audienceResourceName: `customers/${CID}/userLists/10`, targetingMode: "OBSERVATION",
  });
  assert.equal(refusedObs.isError, true, textOf(refusedObs));
  assert.equal(toObservation.calls.writes.length, 0);

  // Default de Pesquisa (Observação) quando a campanha tem setting sem AUDIENCE: também não grava na campanha
  const implicit = fakeClient({ rows: targetingRows({
    adGroup: adGroupRow("SEARCH", { campaign: [{ targetingDimension: "TOPIC", bidOnly: true }] }), userLists: [userListRow("10")],
  }) });
  const refusedDefault = await call(implicit.client, "add_audience_segment_targeting", {
    level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }],
  });
  assert.equal(refusedDefault.isError, true, textOf(refusedDefault));
  assert.match(textOf(refusedDefault), /mora na campanha/);
  assert.equal(implicit.calls.writes.length, 0);

  // KEEP e o mesmo modo da campanha: grava só o critério do grupo
  for (const targetingMode of ["KEEP", "OBSERVATION"]) {
    const ok = fakeClient({ rows: rows(observation) });
    const result = await call(ok.client, "update_ad_group_targeting", {
      adGroupId: AD_GROUP, audienceResourceName: `customers/${CID}/userLists/10`, targetingMode,
    });
    assert.equal(result.isError, undefined, `${targetingMode}: ${textOf(result)}`);
    assert.deepEqual(ok.calls.writes[0].operations!.map((op) => Object.keys(op)[0]), ["adGroupCriterionOperation"], targetingMode);
  }
});

test("targeting: regras de canal recusadas antes de gravar", async () => {
  const cases: Array<{ name: string; args: Row; rows: Parameters<typeof targetingRows>[0]; expect: RegExp; queries?: number }> = [
    { name: "PMax", args: { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }] },
      rows: { campaign: campaignRow("PERFORMANCE_MAX") }, expect: /add_audience_signal/ },
    { name: "lista positiva em campanha Display", args: { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }] },
      rows: { campaign: campaignRow("DISPLAY") }, expect: /só é aceita em Pesquisa/ },
    { name: "Audience em grupo sem use_audience_grouped", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "AUDIENCE", id: "5" }] },
      rows: { adGroup: adGroupRow("DEMAND_GEN") }, expect: /use_audience_grouped=false/ },
    { name: "Audience em Display", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "AUDIENCE", id: "5" }] },
      rows: { adGroup: adGroupRow("DISPLAY", { grouped: true }) }, expect: /só em Demand Gen e App/ },
    { name: "segmento avulso em grupo com Audience", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_INTEREST", id: "80" }] },
      rows: { adGroup: adGroupRow("DEMAND_GEN", { grouped: true }) }, expect: /não aceita segmentos avulsos/ },
    { name: "SIMILAR", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10", negative: true }] },
      rows: { adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10", { type: "SIMILAR" })] }, expect: /SIMILAR/ },
    { name: "CLOSED como alvo", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] },
      rows: { adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10", { membershipStatus: "CLOSED" })] }, expect: /CLOSED/ },
    { name: "segmento inexistente", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "CUSTOM_AUDIENCE", id: "44" }] },
      rows: { adGroup: adGroupRow("DISPLAY") }, expect: /não existe nesta conta/ },
    { name: "lista positiva nos dois níveis", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }], targetingMode: "KEEP" },
      rows: { adGroup: adGroupRow("SEARCH"), userLists: [userListRow("10")],
        campaignCriteria: [{ campaignCriterion: { criterionId: "3", type: "USER_LIST", negative: false, userList: { userList: `customers/${CID}/userLists/11` } } }] },
      expect: /dois níveis/ },
    { name: "segundo Audience no grupo", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "AUDIENCE", id: "5" }] },
      rows: { adGroup: adGroupRow("DEMAND_GEN", { grouped: true }), audiences: [{ audience: { id: "5", name: "A", status: "ENABLED", scope: "CUSTOMER" } }],
        adGroupCriteria: [{ adGroup: { id: AD_GROUP }, adGroupCriterion: { criterionId: "4", type: "AUDIENCE", negative: false, audience: { audience: `customers/${CID}/audiences/6` } } }] },
      expect: /único Audience/ },
  ];
  for (const c of cases) {
    const { client, calls } = fakeClient({ rows: targetingRows(c.rows) });
    const result = await call(client, "add_audience_segment_targeting", c.args);
    assert.equal(result.isError, true, `${c.name}: ${textOf(result)}`);
    assert.match(textOf(result), c.expect, c.name);
    assert.equal(calls.writes.length, 0, `${c.name}: nada gravado`);
  }
});

test("targeting: polaridade invertida, segmento removido, Audience ASSET_GROUP e limite de 50 são recusados", async () => {
  const listCriterion = (negative: boolean) => ({ adGroup: { id: AD_GROUP }, adGroupCriterion: {
    criterionId: "5", resourceName: `customers/${CID}/adGroupCriteria/${AD_GROUP}~5`, type: "USER_LIST", negative,
    userList: { userList: `customers/${CID}/userLists/10` },
  } });
  const cases: Array<{ name: string; args: Row; rows: Parameters<typeof targetingRows>[0]; expect: RegExp }> = [
    { name: "alvo pedido, já excluído", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] },
      rows: { adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10")], adGroupCriteria: [listCriterion(true)] }, expect: /já está excluído/ },
    { name: "exclusão pedida, já é alvo", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10", negative: true }] },
      rows: { adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10")], adGroupCriteria: [listCriterion(false)] }, expect: /já está como alvo/ },
    { name: "CUSTOM_AUDIENCE removido", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "CUSTOM_AUDIENCE", id: "44" }] },
      rows: { adGroup: adGroupRow("DISPLAY"), customAudiences: [{ customAudience: { id: "44", name: "Concorrentes", status: "REMOVED" } }] }, expect: /CUSTOM_AUDIENCE 44 "Concorrentes": está removido/ },
    { name: "COMBINED_AUDIENCE removido", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "COMBINED_AUDIENCE", id: "45" }] },
      rows: { adGroup: adGroupRow("DISPLAY"), combinedAudiences: [{ combinedAudience: { id: "45", name: "Mix", status: "REMOVED" } }] }, expect: /COMBINED_AUDIENCE 45 "Mix": está removido/ },
    { name: "Audience com escopo ASSET_GROUP", args: { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "AUDIENCE", id: "5" }] },
      rows: { adGroup: adGroupRow("DEMAND_GEN", { grouped: true }), audiences: [{ audience: { id: "5", name: "PMax", status: "ENABLED", scope: "ASSET_GROUP" } }] }, expect: /ASSET_GROUP/ },
  ];
  for (const c of cases) {
    const { client, calls } = fakeClient({ rows: targetingRows(c.rows) });
    const result = await call(client, "add_audience_segment_targeting", c.args);
    assert.equal(result.isError, true, `${c.name}: ${textOf(result)}`);
    assert.match(textOf(result), c.expect, c.name);
    assert.equal(calls.writes.length, 0, `${c.name}: nada gravado`);
  }

  // Os mesmos segmentos válidos gravam (o fixture não é o motivo da recusa)
  const enabled = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("DISPLAY"), customAudiences: [{ customAudience: { id: "44", name: "Concorrentes", status: "ENABLED" } }] }) });
  const ok = await call(enabled.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "CUSTOM_AUDIENCE", id: "44" }] });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal(enabled.calls.writes.length, 1);

  // 51 segmentos: recusado antes de qualquer leitura
  const many = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("DISPLAY") }) });
  const segments = Array.from({ length: 51 }, (_v, i) => ({ type: "USER_LIST", id: String(1000 + i) }));
  const tooMany = await call(many.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments });
  assert.equal(tooMany.isError, true);
  assert.match(textOf(tooMany), /No máximo 50 segmentos/);
  assert.equal(many.calls.queries.length + many.calls.writes.length, 0);
});

test("targeting: entrada inválida não consulta a API", async () => {
  for (const args of [
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "AUDIENCE", id: "5" }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10", negative: true, bidModifier: 1.2 }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10", bidModifier: 11 }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", resourceName: "customers/999/userLists/10" }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", resourceName: `customers/${CID}/audiences/10` }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }, { type: "USER_LIST", id: "10" }] },
    { level: "adGroup", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }] },
    { level: "campaign", campaignId: "1 OR 1=1", segments: [{ type: "USER_LIST", id: "10" }] },
    { level: "campaign", campaignId: CAMPAIGN, segments: [] },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "add_audience_segment_targeting", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("targeting: existente é no-op; bidModifier diferente vira update só de bid_modifier; LIFE_EVENT usa o ID", async () => {
  const existing = { adGroup: { id: AD_GROUP }, adGroupCriterion: {
    criterionId: "7", resourceName: `customers/${CID}/adGroupCriteria/${AD_GROUP}~7`, type: "USER_INTEREST", negative: false, bidModifier: 1.1,
    userInterest: { userInterestCategory: `customers/${CID}/userInterests/80` },
  } };
  const rows = targetingRows({ adGroup: adGroupRow("DISPLAY"), interests: [{ userInterest: { userInterestId: "80", name: "Esportes", taxonomyType: "IN_MARKET" } }],
    lifeEvents: [{ lifeEvent: { id: "600", name: "Mudou-se" } }], adGroupCriteria: [existing] });

  const noop = fakeClient({ rows });
  const same = await call(noop.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_INTEREST", id: "80" }] });
  assert.match(textOf(same), /Nada a fazer/);
  assert.equal(noop.calls.writes.length, 0);

  const bid = fakeClient({ rows });
  await call(bid.client, "add_audience_segment_targeting", {
    level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_INTEREST", id: "80", bidModifier: 1.4 }, { type: "LIFE_EVENT", id: "600" }],
  });
  const ops = bid.calls.writes[0].operations as Row[];
  assert.deepEqual(ops[0], { adGroupCriterionOperation: { update: { resourceName: `customers/${CID}/adGroupCriteria/${AD_GROUP}~7`, bidModifier: 1.4 }, updateMask: "bid_modifier" } });
  assert.deepEqual(ops[1], { adGroupCriterionOperation: { create: { adGroup: `customers/${CID}/adGroups/${AD_GROUP}`, lifeEvent: { lifeEventId: "600" }, negative: false } } });
});

test("targeting: campanha sem setting e grupos com setting próprio — não força Observação", async () => {
  const { client, calls } = fakeClient({ rows: targetingRows({
    campaign: campaignRow("SEARCH"), userLists: [userListRow("10")],
    adGroupSettings: [{ adGroup: { id: "333", name: "G", targetingSetting: { targetRestrictions: [{ targetingDimension: "AUDIENCE", bidOnly: true }] } } }],
  }) });
  const result = await call(client, "add_audience_segment_targeting", { level: "campaign", campaignId: CAMPAIGN, segments: [{ type: "USER_LIST", id: "10" }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /targeting_setting próprio|têm o próprio/);
  assert.equal(calls.writes.length, 0);
});

test("targeting: erro da API, dry-run e validateOnly", async () => {
  const rows = targetingRows({ adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10")] });
  const failing = fakeClient({ rows, batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Not allowed to target a closed user list."); } });
  const refused = await call(failing.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /nada foi gravado \(operação atômica\)/);
  assert.match(textOf(refused), /CLOSED/);

  const dry = fakeClient({ rows, dryRun: true });
  const dryResult = await call(dry.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }] });
  assert.match(textOf(dryResult), /DRY-RUN/);

  const validate = fakeClient({ rows });
  const validated = await call(validate.client, "add_audience_segment_targeting", { level: "adGroup", adGroupId: AD_GROUP, segments: [{ type: "USER_LIST", id: "10" }], validateOnly: true });
  assert.match(textOf(validated), /VALIDATE-ONLY/);
  assert.equal(validate.calls.writes[0].dryRun, true);
});

test("update_ad_group_targeting: infere o tipo pelo resource name e não inventa bidModifier 1.0", async () => {
  const { client, calls } = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("DISPLAY"), userLists: [userListRow("10")] }) });
  const result = await call(client, "update_ad_group_targeting", { adGroupId: AD_GROUP, audienceResourceName: `customers/${CID}/userLists/10` });
  assert.equal(result.isError, undefined, textOf(result));
  const create = ((calls.writes[0].operations![0] as Row).adGroupCriterionOperation as { create: Row }).create;
  assert.deepEqual(create, { adGroup: `customers/${CID}/adGroups/${AD_GROUP}`, userList: { userList: `customers/${CID}/userLists/10` }, negative: false });

  const numeric = fakeClient();
  const refused = await call(numeric.client, "update_ad_group_targeting", { adGroupId: AD_GROUP, audienceResourceName: "10" });
  assert.equal(refused.isError, true);
  assert.equal(numeric.calls.queries.length, 0);
});

test("remove_audience_segment_targeting: pede confirm e mapeia falha parcial", async () => {
  const criteria = [
    { campaign: { id: CAMPAIGN }, campaignCriterion: { criterionId: "1", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~1`, type: "USER_LIST", negative: true, displayName: "Compradores", userList: { userList: `customers/${CID}/userLists/10` } } },
    { campaign: { id: CAMPAIGN }, campaignCriterion: { criterionId: "2", resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~2`, type: "USER_INTEREST", negative: false, displayName: "Esportes", userInterest: { userInterestCategory: `customers/${CID}/userInterests/80` } } },
  ];
  const noConfirm = fakeClient({ rows: () => criteria });
  const refused = await call(noConfirm.client, "remove_audience_segment_targeting", { level: "campaign", campaignId: CAMPAIGN, criterionIds: ["1"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const partial = fakeClient({
    rows: () => criteria,
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN}~1` }, {}],
      partialFailureError: { details: [{ errors: [{ message: "falhou", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] },
    }),
  });
  const result = await call(partial.client, "remove_audience_segment_targeting", {
    level: "campaign", campaignId: CAMPAIGN, criterionIds: ["1"], segments: [{ type: "USER_INTEREST", id: "80" }], confirm: true,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(partial.calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN}~1` },
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN}~2` },
  ]);
  assert.deepEqual(partial.calls.writes[0].options, { partialFailure: true });
  assert.match(textOf(result), /1 critério\(s\) de público removido/);
});

// ── set_targeting_mode (set_optimized_targeting fica no lote placements-brand-safety) ──────────────────────

test("set_targeting_mode: reenvia a lista inteira, só troca a dimensão pedida, e respeita os dois níveis", async () => {
  const restr = [{ targetingDimension: "AUDIENCE", bidOnly: false }, { targetingDimension: "TOPIC", bidOnly: true }];
  const { client, calls } = fakeClient({ rows: targetingRows({ campaign: campaignRow("SEARCH", restr) }) });
  const result = await call(client, "set_targeting_mode", { level: "campaign", campaignId: CAMPAIGN, mode: "OBSERVATION" });
  assert.equal(result.isError, undefined, textOf(result));
  const op = calls.writes[0].operations![0] as { update: Row; updateMask: string };
  assert.equal(calls.writes[0].resource, "campaigns");
  assert.equal(op.updateMask, "targeting_setting.target_restrictions");
  assert.deepEqual((op.update.targetingSetting as Row).targetRestrictions, [
    { targetingDimension: "TOPIC", bidOnly: true }, { targetingDimension: "AUDIENCE", bidOnly: true },
  ]);

  const noop = fakeClient({ rows: targetingRows({ campaign: campaignRow("SEARCH", restr) }) });
  const same = await call(noop.client, "set_targeting_mode", { level: "campaign", campaignId: CAMPAIGN, dimension: "TOPIC", mode: "OBSERVATION" });
  assert.match(textOf(same), /já está/);
  assert.equal(noop.calls.writes.length, 0);

  const implicit = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("SEARCH") }) });
  assert.match(textOf(await call(implicit.client, "set_targeting_mode", { level: "adGroup", adGroupId: AD_GROUP, mode: "TARGETING" })), /implícito/);
  assert.equal(implicit.calls.writes.length, 0);

  const blockedGroup = fakeClient({ rows: targetingRows({ adGroup: adGroupRow("SEARCH", { campaign: restr }) }) });
  const refused = await call(blockedGroup.client, "set_targeting_mode", { level: "adGroup", adGroupId: AD_GROUP, mode: "OBSERVATION" });
  assert.equal(refused.isError, true);
  assert.equal(blockedGroup.calls.writes.length, 0);

  const blockedCampaign = fakeClient({ rows: targetingRows({ campaign: campaignRow("SEARCH"),
    adGroupSettings: [{ adGroup: { id: "333", name: "G", targetingSetting: { targetRestrictions: restr } } }] }) });
  assert.equal((await call(blockedCampaign.client, "set_targeting_mode", { level: "campaign", campaignId: CAMPAIGN, mode: "OBSERVATION" })).isError, true);
  assert.equal(blockedCampaign.calls.writes.length, 0);
});

// ── Listas de remarketing (item 8) ────────────────────────────────────

test("create_remarketing_list: uma regra por operando, OR de verdade, janela em cada operando e pré-população", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_remarketing_list", {
    name: "Produto ou categoria", membershipLifeSpan: 30,
    rules: [{ ruleType: "URL_CONTAINS", value: "/produto" }, { ruleType: "URL_CONTAINS", value: "/categoria", lookbackDays: 14 }],
    excludeRules: [{ ruleType: "URL_CONTAINS", value: "/obrigado" }, { ruleType: "CUSTOM_PARAMETER", parameterName: "ecomm_pagetype", value: "purchase" }],
    excludeLifeSpan: 7,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const create = (calls.writes[0].operations![0] as { create: Row }).create;
  assert.equal(calls.writes[0].resource, "userLists");
  assert.ok(!("membershipLifeSpan" in create), "ignorado em rule-based: não é enviado");
  assert.deepEqual(create.ruleBasedUserList, {
    prepopulationStatus: "REQUESTED",
    flexibleRuleUserList: {
      inclusiveRuleOperator: "OR",
      inclusiveOperands: [
        { rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/produto" } }] }] }, lookbackWindowDays: 30 },
        { rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/categoria" } }] }] }, lookbackWindowDays: 14 },
      ],
      exclusiveOperands: [
        { rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/obrigado" } }] }] }, lookbackWindowDays: 7 },
        { rule: { ruleItemGroups: [{ ruleItems: [{ name: "ecomm_pagetype", stringRuleItem: { operator: "EQUALS", value: "purchase" } }] }] }, lookbackWindowDays: 7 },
      ],
    },
  });
  const body = textOf(result);
  const summary = JSON.parse(body.slice(body.indexOf("{"))) as Row;
  assert.equal(summary.rule,
    '(url CONTAINS "/produto" [30d]) OU (url CONTAINS "/categoria" [14d]) E NÃO [(url CONTAINS "/obrigado" [7d]) OU (ecomm_pagetype EQUALS "purchase" [7d])]');
});

test("create_remarketing_list: AND, parâmetro numérico e prepopulate=false", async () => {
  const { client, calls } = fakeClient();
  await call(client, "create_remarketing_list", {
    name: "Carrinho alto", membershipLifeSpan: 60, ruleOperator: "AND", prepopulate: false,
    rules: [{ ruleType: "URL_CONTAINS", value: "/carrinho" }, { ruleType: "CUSTOM_PARAMETER", parameterName: "value", operator: "GREATER_THAN", value: "500" }],
  });
  const rule = (calls.writes[0].operations![0] as { create: { ruleBasedUserList: Row } }).create.ruleBasedUserList;
  assert.ok(!("prepopulationStatus" in rule));
  const flex = rule.flexibleRuleUserList as Row;
  assert.equal(flex.inclusiveRuleOperator, "AND");
  assert.deepEqual(((flex.inclusiveOperands as Row[])[1].rule as Row).ruleItemGroups, [{ ruleItems: [{ name: "value", numberRuleItem: { operator: "GREATER_THAN", value: 500 } }] }]);
});

test("create_remarketing_list: CUSTOM_EVENT, URL inválida, janela fora do limite e nome repetido não gravam", async () => {
  for (const args of [
    { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "CUSTOM_EVENT", value: "purchase" }] },
    { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "URL_CONTAINS", value: "/a(b)" }] },
    { name: "X", membershipLifeSpan: 541, rules: [{ ruleType: "URL_CONTAINS", value: "/a" }] },
    { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "CUSTOM_PARAMETER", value: "1" }] },
    { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "CUSTOM_PARAMETER", parameterName: "9x", value: "1" }] },
    { name: "X", membershipLifeSpan: 30, rules: [] },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_remarketing_list", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
  const { client } = fakeClient();
  assert.match(textOf(await call(client, "create_remarketing_list", { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "CUSTOM_EVENT", value: "p" }] })), /CUSTOM_PARAMETER/);

  const dup = fakeClient({ rows: () => [{ userList: { id: "3", name: "X" } }] });
  const refused = await call(dup.client, "create_remarketing_list", { name: "X", membershipLifeSpan: 30, rules: [{ ruleType: "URL_CONTAINS", value: "/a" }] });
  assert.equal(refused.isError, true);
  assert.equal(dup.calls.writes.length, 0);
  assert.match(dup.calls.queries[0], /user_list\.name = 'X'/);
});

test("update_remarketing_list: duração de rule-based explicada; CRM atualiza; CLOSED pede confirm; no-op", async () => {
  const ruleBased = () => [{ userList: { id: "10", name: "Visitantes", type: "RULE_BASED", membershipStatus: "OPEN", ruleBasedUserList: { flexibleRuleUserList: {
    inclusiveRuleOperator: "OR", inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/p" } }] }] }, lookbackWindowDays: "30" }],
  } } } }];
  const rb = fakeClient({ rows: ruleBased });
  const refused = await call(rb.client, "update_remarketing_list", { userListId: "10", membershipLifeSpan: 60 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /lookback.*\[30d\]/s);
  assert.equal(rb.calls.writes.length, 0);

  const crm = () => [{ userList: { id: "11", name: "CRM", type: "CRM_BASED", membershipStatus: "OPEN", membershipLifeSpan: "540", eligibleForSearch: true } }];
  const updated = fakeClient({ rows: crm });
  await call(updated.client, "update_remarketing_list", { userListId: "11", membershipLifeSpan: 180, eligibleForSearch: true });
  assert.deepEqual(updated.calls.writes[0].operations, [{ update: { resourceName: `customers/${CID}/userLists/11`, membershipLifeSpan: 180 }, updateMask: "membership_life_span" }]);

  const close = fakeClient({ rows: crm });
  assert.equal((await call(close.client, "update_remarketing_list", { userListId: "11", status: "CLOSED" })).isError, true);
  assert.equal(close.calls.writes.length, 0);
  await call(close.client, "update_remarketing_list", { userListId: "11", status: "CLOSED", confirm: true });
  assert.equal((close.calls.writes[0].operations![0] as { updateMask: string }).updateMask, "membership_status");

  const noop = fakeClient({ rows: crm });
  assert.match(textOf(await call(noop.client, "update_remarketing_list", { userListId: "11", membershipLifeSpan: 540 })), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const readOnly = fakeClient({ rows: () => [{ userList: { id: "12", name: "Sim", type: "SIMILAR", readOnly: true } }] });
  assert.equal((await call(readOnly.client, "update_remarketing_list", { userListId: "12", name: "Novo" })).isError, true);
  assert.equal(readOnly.calls.writes.length, 0);
});

test("list_remarketing_lists: regra legível, duração nula em rule-based, filtro de tipo e formatos", async () => {
  const rows = () => [
    { userList: { id: "10", name: "Visitantes", type: "RULE_BASED", membershipLifeSpan: "30", membershipStatus: "OPEN", ruleBasedUserList: { prepopulationStatus: "FINISHED", flexibleRuleUserList: {
      inclusiveRuleOperator: "OR", inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/p" } }] }] }, lookbackWindowDays: "30" }],
    } } } },
    { userList: { id: "11", name: "CRM", type: "CRM_BASED", membershipLifeSpan: "540", matchRatePercentage: 42 } },
    { userList: { id: "12", name: "Carrinho sem compra", type: "LOGICAL", logicalUserList: { rules: [{ operator: "ANY", ruleOperands: [{ userList: `customers/${CID}/userLists/10` }] }, { operator: "NONE", ruleOperands: [{ userList: `customers/${CID}/userLists/13` }] }] } } },
  ];
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "list_remarketing_lists", { type: "RULE_BASED", query: "Visit" });
  assert.match(calls.queries[0], /user_list\.type = 'RULE_BASED'/);
  const body = textOf(result);
  const lists = JSON.parse(body.slice(body.indexOf("["))) as Row[];
  assert.equal(lists[0].membership_days, null);
  assert.equal(lists[0].rule, '(url CONTAINS "/p" [30d])');
  assert.equal(lists[1].match_rate_pct, 42);
  assert.equal(lists[2].rule, "ANY(10) E NONE(13)");
  assert.match(textOf(await call(client, "list_remarketing_lists", { format: "csv" })), /^id,name,type/);
});

test("create_logical_user_list: payload v25 e operandos recusados (lógica, CRM misturado, inexistente)", async () => {
  const lists = [userListRow("10"), userListRow("13"), userListRow("20", { type: "LOGICAL" }), userListRow("30", { type: "CRM_BASED" })];
  const { client, calls } = fakeClient({ rows: (q) => (q.includes("user_list.name =") ? [] : lists) });
  const result = await call(client, "create_logical_user_list", {
    name: "Carrinho sem compra", rules: [{ operator: "ANY", userListIds: ["10"] }, { operator: "NONE", userListIds: [`customers/${CID}/userLists/13`] }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual((calls.writes[0].operations![0] as { create: Row }).create, {
    name: "Carrinho sem compra", membershipStatus: "OPEN",
    logicalUserList: { rules: [
      { operator: "ANY", ruleOperands: [{ userList: `customers/${CID}/userLists/10` }] },
      { operator: "NONE", ruleOperands: [{ userList: `customers/${CID}/userLists/13` }] },
    ] },
  });
  for (const rules of [
    [{ operator: "ANY", userListIds: ["20"] }],
    [{ operator: "ANY", userListIds: ["10", "30"] }],
    [{ operator: "ANY", userListIds: ["99"] }],
    [{ operator: "ANY", userListIds: ["abc"] }],
  ]) {
    const f = fakeClient({ rows: (q) => (q.includes("user_list.name =") ? [] : lists) });
    const refused = await call(f.client, "create_logical_user_list", { name: "L", rules });
    assert.equal(refused.isError, true, JSON.stringify(rules));
    assert.equal(f.calls.writes.length, 0);
  }
});

// ── Relatórios (item 62) ──────────────────────────────────────────────

test("get_audience_performance: modo efetivo, comparação com a campanha e sinais", async () => {
  const rows = (q: string): Row[] => {
    if (from(q) === "campaign_audience_view") {
      return [
        { campaign: { id: CAMPAIGN, name: "Busca", advertisingChannelType: "SEARCH" }, campaignCriterion: { criterionId: "1", displayName: "Compradores", type: "USER_LIST", negative: false, bidModifier: 1.2, status: "ENABLED" },
          metrics: { impressions: "1000", clicks: "100", costMicros: "100000000", conversions: 10, conversionsValue: 1000 } },
        { campaign: { id: CAMPAIGN, name: "Busca", advertisingChannelType: "SEARCH" }, campaignCriterion: { criterionId: "2", displayName: "Esportes", type: "USER_INTEREST", negative: false, status: "ENABLED" },
          metrics: { impressions: "1000", clicks: "50", costMicros: "80000000", conversions: 0, conversionsValue: 0 } },
      ];
    }
    if (from(q) === "campaign" && q.includes("metrics.")) return [{ campaign: { id: CAMPAIGN }, metrics: { impressions: "10000", clicks: "500", costMicros: "400000000", conversions: 20, conversionsValue: 2000 } }];
    if (from(q) === "campaign") return [{ campaign: { id: CAMPAIGN, targetingSetting: { targetRestrictions: [{ targetingDimension: "AUDIENCE", bidOnly: true }] } } }];
    return [];
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "get_audience_performance", { campaignId: CAMPAIGN, days: 30 });
  assert.equal(result.isError, undefined, textOf(result));
  const body = textOf(result);
  const report = JSON.parse(body.slice(body.indexOf("{"))) as { rows: Row[] };
  const [buyers, sports] = report.rows;
  assert.equal(buyers.mode, "OBSERVATION");
  assert.equal(buyers.mode_source, "campanha");
  assert.equal(buyers.cpa, 10);
  assert.equal(buyers.campaign_cpa, 20);
  assert.equal(buyers.cpa_vs_campaign_pct, -50);
  assert.match(String(buyers.signal), /aumentar lance/);
  assert.match(String(sports.signal), /sem converter/);
  assert.equal(calls.queries.length, 3);

  const adGroupLevel = fakeClient();
  await call(adGroupLevel.client, "get_audience_performance", { level: "ad_group", adGroupId: AD_GROUP, dateRange: { since: "2026-08-01", until: "2026-08-31" }, format: "csv" });
  assert.equal(from(adGroupLevel.calls.queries[0]), "ad_group_audience_view");

  const invalid = fakeClient();
  assert.equal((await call(invalid.client, "get_audience_performance", { campaignId: "1 OR 1" })).isError, true);
  assert.equal((await call(invalid.client, "get_audience_performance", { dateRange: { since: "2026-01-01' OR", until: "2026-01-02" } })).isError, true);
  assert.equal(invalid.calls.queries.length, 0);
});

test("get_demographic_performance: todas as dimensões montam GAQL válido; faixa excluída e candidata a reduzir lance", async () => {
  for (const dimension of ["AGE", "GENDER", "PARENTAL", "INCOME"]) {
    const { client } = fakeClient({ rows: (q) => (from(q).endsWith("_view") ? [{ campaign: { id: CAMPAIGN, name: "C" }, adGroup: { id: AD_GROUP, name: "G" }, adGroupCriterion: { criterionId: "1" }, metrics: { clicks: "1" } }] : []) });
    const result = await call(client, "get_demographic_performance", { dimension, campaignId: CAMPAIGN });
    assert.equal(result.isError, undefined, `${dimension}: ${textOf(result)}`);
  }
  const rows = (q: string): Row[] => {
    if (from(q) === "age_range_view") {
      return [
        { campaign: { id: CAMPAIGN, name: "C" }, adGroup: { id: AD_GROUP, name: "G" }, adGroupCriterion: { criterionId: "1", ageRange: { type: "AGE_RANGE_25_34" }, negative: false },
          metrics: { impressions: "1000", clicks: "100", costMicros: "100000000", conversions: 10, conversionsValue: 0 } },
        { campaign: { id: CAMPAIGN, name: "C" }, adGroup: { id: AD_GROUP, name: "G" }, adGroupCriterion: { criterionId: "2", ageRange: { type: "AGE_RANGE_65_UP" }, negative: false, bidModifier: 0.8 },
          metrics: { impressions: "1000", clicks: "60", costMicros: "60000000", conversions: 1, conversionsValue: 0 } },
      ];
    }
    if (from(q) === "ad_group_criterion") return [{ campaign: { id: CAMPAIGN, name: "C" }, adGroup: { id: AD_GROUP, name: "G" }, adGroupCriterion: { criterionId: "3", ageRange: { type: "AGE_RANGE_18_24" }, negative: true } }];
    if (from(q) === "campaign_criterion") return [{ campaign: { id: CAMPAIGN }, campaignCriterion: { ageRange: { type: "AGE_RANGE_UNDETERMINED" }, negative: true } }];
    return [];
  };
  const { client } = fakeClient({ rows });
  const result = await call(client, "get_demographic_performance", { dimension: "AGE", level: "ad_group" });
  const body = textOf(result);
  const report = JSON.parse(body.slice(body.indexOf("{"))) as { rows: Row[] };
  const byBucket = new Map(report.rows.map((r) => [r.bucket, r]));
  assert.equal(byBucket.get("AGE_RANGE_18_24")?.excluded, true, "exclusão sem métrica aparece");
  assert.equal(byBucket.get("AGE_RANGE_65_UP")?.bid_down_candidate, true);
  // CPA 60 contra 14,55 da campanha (160 / 11 conversões)
  assert.equal(byBucket.get("AGE_RANGE_65_UP")?.cpa_vs_campaign_pct, 312.37);
  assert.equal(byBucket.get("AGE_RANGE_25_34")?.bid_down_candidate, false);
  assert.match(body, /Candidatas a reduzir lance: 1/);
});

// ── Customer Match (item 86) ──────────────────────────────────────────

test("normalização de Customer Match: gmail, E.164 com +55 e SHA-256 hex", () => {
  assert.equal(normalizeEmail("  Cloudy.SanFrancisco+shopping@Gmail.com "), "cloudysanfrancisco@gmail.com");
  assert.equal(normalizeEmail("user.name+NYC@Example.com"), "user.name+nyc@example.com");
  assert.equal(normalizeEmail("sem-arroba"), null);
  assert.equal(normalizePhone("(11) 91234-5678"), "+5511912345678");
  assert.equal(normalizePhone("011 3456-7890"), "+551134567890");
  assert.equal(normalizePhone("+1 (800) 555-0100"), "+18005550100");
  assert.equal(normalizePhone("0044 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("5511912345678"), "+5511912345678");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(sha256Hex("test@example.com"), "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b");
});

test("Customer Match: telefone que já traz o DDI sem '+' não ganha o DDI de novo (qualquer país)", () => {
  assert.equal(normalizePhone("15551234567", "1"), "+15551234567");
  assert.equal(normalizePhone("5551234567", "1"), "+15551234567");
  assert.equal(normalizePhone("351912345678", "351"), "+351912345678");
  assert.equal(normalizePhone("447911123456", "44"), null, "DDI sem plano conhecido e sem '+': ambíguo, recusado");
  const prepared = prepareCustomerMatchMembers({ phones: ["15551234567", "+1 555 123 4567", "447911123456"] }, "1");
  assert.equal(prepared.userData.length, 1, "as duas grafias do mesmo número viram um membro só");
  assert.equal(prepared.duplicates, 1);
  assert.equal(prepared.userData[0].identifiers[0].hashedPhoneNumber, sha256Hex("+15551234567"));
  assert.equal(prepared.invalid.length, 1);
  assert.match(prepared.invalid[0].reason, /telefone/);
});

test("create_customer_match_list: CRM CONTACT_INFO com 540 dias; limites recusados antes de gravar", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_customer_match_list", { name: "Clientes" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual((calls.writes[0].operations![0] as { create: Row }).create, {
    name: "Clientes", membershipStatus: "OPEN", membershipLifeSpan: 540, crmBasedUserList: { uploadKeyType: "CONTACT_INFO" },
  });
  for (const args of [
    { name: "X", membershipLifeSpan: 10000 },
    { name: "X", uploadKeyType: "MOBILE_ADVERTISING_ID" },
    { name: "X", appId: "com.x" },
  ]) {
    const f = fakeClient();
    assert.equal((await call(f.client, "create_customer_match_list", args)).isError, true, JSON.stringify(args));
    assert.equal(f.calls.queries.length + f.calls.writes.length, 0);
  }
});

const crmList = (extra: Row = {}) => () => [{ userList: { id: "50", name: "Clientes", type: "CRM_BASED", membershipStatus: "OPEN", crmBasedUserList: { uploadKeyType: "CONTACT_INFO" }, ...extra } }];
const GRANTED = { adUserData: "GRANTED", adPersonalization: "GRANTED" };

test("upload_customer_match_members: job criar → operações → executar, só hashes, nada em claro", async () => {
  const { client, calls } = fakeClient({ rows: crmList() });
  const result = await call(client, "upload_customer_match_members", {
    userListId: "50", consent: GRANTED,
    members: [{ email: "Maria.Silva@Gmail.com", phone: "(11) 91234-5678" }, { email: "invalido" }],
    emails: ["maria.silva@gmail.com", "joao@empresa.com.br"],
  });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(calls.writes.map((w) => w.action), [
    "offlineUserDataJobs:create", "offlineUserDataJobs/555:addOperations", "offlineUserDataJobs/555:run",
  ]);
  assert.deepEqual(calls.writes[0].body, { job: { type: "CUSTOMER_MATCH_USER_LIST", customerMatchUserListMetadata: {
    userList: `customers/${CID}/userLists/50`, consent: GRANTED,
  } } });
  const add = calls.writes[1].body as { enablePartialFailure: boolean; operations: Row[] };
  assert.equal(add.enablePartialFailure, true);
  assert.deepEqual(add.operations[0], { create: { userIdentifiers: [
    { hashedEmail: sha256Hex("mariasilva@gmail.com") }, { hashedPhoneNumber: sha256Hex("+5511912345678") },
  ] } });
  assert.equal(add.operations.length, 3, "maria.silva@gmail.com sozinha é outra pessoa (só e-mail); joao; o inválido fica fora");
  const everything = JSON.stringify(calls.writes) + textOf(result);
  assert.doesNotMatch(everything, /maria|joao|91234/i, "nenhum dado em claro sai da tool");
  assert.match(textOf(result), /emails\[0\]|members\[1\]/);
});

test("upload_customer_match_members: consentimento, confirm e preview antes de qualquer envio", async () => {
  const noConsent = fakeClient({ rows: crmList() });
  assert.equal((await call(noConsent.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"] })).isError, true);
  assert.equal((await call(noConsent.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: { adUserData: "GRANTED", adPersonalization: "DENIED" } })).isError, true);
  assert.equal(noConsent.calls.queries.length + noConsent.calls.writes.length, 0);

  const replace = fakeClient({ rows: crmList() });
  const refused = await call(replace.client, "upload_customer_match_members", { userListId: "50", mode: "replace", emails: ["a@b.com"], consent: GRANTED });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(replace.calls.writes.length, 0);

  const preview = fakeClient({ rows: crmList() });
  const previewed = await call(preview.client, "upload_customer_match_members", { userListId: "50", mode: "replace", emails: ["a@b.com"], consent: GRANTED, preview: true });
  assert.match(textOf(previewed), /PREVIEW/);
  assert.equal(preview.calls.writes.length, 0);

  const confirmed = fakeClient({ rows: crmList() });
  await call(confirmed.client, "upload_customer_match_members", { userListId: "50", mode: "replace", emails: ["a@b.com"], consent: GRANTED, confirm: true });
  const ops = (confirmed.calls.writes[1].body as { operations: Row[] }).operations;
  assert.deepEqual(ops[0], { removeAll: true }, "remove_all vem primeiro");

  const remove = fakeClient({ rows: crmList() });
  await call(remove.client, "upload_customer_match_members", { userListId: "50", mode: "remove", emails: ["a@b.com"], confirm: true });
  const job = (remove.calls.writes[0].body as { job: { customerMatchUserListMetadata: Row } }).job;
  assert.ok(!("consent" in job.customerMatchUserListMetadata), "remoção não precisa de consentimento");
  assert.ok("remove" in (remove.calls.writes[1].body as { operations: Row[] }).operations[0]);
});

test("upload_customer_match_members: remove pede confirm; lista CLOSED e somente leitura recusadas", async () => {
  const remove = fakeClient({ rows: crmList() });
  const refused = await call(remove.client, "upload_customer_match_members", { userListId: "50", mode: "remove", emails: ["a@b.com"] });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /remove tira os contatos da lista/);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(remove.calls.writes.length, 0, "nenhum customerWriteAction sem confirm");
  assert.equal(remove.calls.queries.length, 0, "recusado antes de ler a lista");

  const closed = fakeClient({ rows: crmList({ membershipStatus: "CLOSED" }) });
  const closedResult = await call(closed.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: GRANTED });
  assert.equal(closedResult.isError, true, textOf(closedResult));
  assert.match(textOf(closedResult), /está CLOSED/);
  assert.equal(closed.calls.writes.length, 0);

  const closedReplace = fakeClient({ rows: crmList({ membershipStatus: "CLOSED" }) });
  assert.equal((await call(closedReplace.client, "upload_customer_match_members", { userListId: "50", mode: "replace", emails: ["a@b.com"], consent: GRANTED, confirm: true })).isError, true);
  assert.equal(closedReplace.calls.writes.length, 0);

  // Remover de uma lista CLOSED continua permitido (só incluir é bloqueado)
  const closedRemove = fakeClient({ rows: crmList({ membershipStatus: "CLOSED" }) });
  const removed = await call(closedRemove.client, "upload_customer_match_members", { userListId: "50", mode: "remove", emails: ["a@b.com"], confirm: true });
  assert.notEqual(removed.isError, true, textOf(removed));
  assert.ok(closedRemove.calls.writes.length > 0);

  for (const mode of ["add", "remove"]) {
    const readOnly = fakeClient({ rows: crmList({ readOnly: true }) });
    const result = await call(readOnly.client, "upload_customer_match_members", { userListId: "50", mode, emails: ["a@b.com"], consent: GRANTED, confirm: true });
    assert.equal(result.isError, true, `${mode}: ${textOf(result)}`);
    assert.match(textOf(result), /somente leitura/);
    assert.equal(readOnly.calls.writes.length, 0, mode);
  }
});

test("upload_customer_match_members: lista errada, projeto sem Customer Match, falha parcial, dry-run e validateOnly", async () => {
  const notCrm = fakeClient({ rows: () => [userListRow("50")] });
  assert.equal((await call(notCrm.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: GRANTED })).isError, true);
  assert.equal(notCrm.calls.writes.length, 0);

  const blocked = fakeClient({ rows: crmList(), writeAction: () => { throw new Error("Google Ads API: The caller does not have permission — Customer is not allowlisted for accessing this feature. CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE"); } });
  const refused = await call(blocked.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: GRANTED });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Data Manager API/);
  assert.equal(blocked.calls.writes.length, 1, "parou no create");

  const partial = fakeClient({
    rows: crmList(),
    writeAction: (action) => {
      if (action.endsWith(":create")) return { resourceName: `customers/${CID}/offlineUserDataJobs/555` };
      if (action.endsWith(":addOperations")) return { partialFailureError: { details: [{ errors: [{ message: "hash inválido", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }] } };
      return { name: "op" };
    },
  });
  const partialResult = await call(partial.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com", "c@d.com"], consent: GRANTED });
  assert.equal(partialResult.isError, true);
  assert.match(textOf(partialResult), /"source": "emails\[1\]"/);
  assert.doesNotMatch(textOf(partialResult), /c@d\.com/);
  assert.ok(partial.calls.writes.some((w) => w.action?.endsWith(":run")), "as válidas seguem para execução");

  const dry = fakeClient({ rows: crmList(), dryRun: true });
  const dryResult = await call(dry.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: GRANTED });
  assert.match(textOf(dryResult), /DRY-RUN: nada foi enviado/);
  assert.equal(dry.calls.writes.length, 0);

  const validate = fakeClient({ rows: crmList() });
  const validated = await call(validate.client, "upload_customer_match_members", { userListId: "50", emails: ["a@b.com"], consent: GRANTED, validateOnly: true });
  assert.equal(validated.isError, true);
  assert.match(textOf(validated), /passos encadeados/);
  assert.equal(validate.calls.queries.length + validate.calls.writes.length, 0);
});

test("get_customer_match_status: listas CRM com jobs; falha ao ler jobs não derruba a leitura", async () => {
  const rows = (q: string): Row[] => {
    if (from(q) === "user_list") return [{ userList: { id: "50", name: "Clientes", membershipStatus: "OPEN", matchRatePercentage: 55, crmBasedUserList: { uploadKeyType: "CONTACT_INFO" } } }];
    if (from(q) === "offline_user_data_job") return [{ offlineUserDataJob: { id: "555", status: "SUCCESS", customerMatchUserListMetadata: { userList: `customers/${CID}/userLists/50` }, operationMetadata: { matchRateRange: "MATCH_RANGE_51_TO_60" } } }];
    return [];
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "get_customer_match_status", { userListId: "50" });
  assert.match(calls.queries[0], /user_list\.type = 'CRM_BASED' AND user_list\.id = 50/);
  assert.match(calls.queries[1], /customer_match_user_list_metadata\.user_list = 'customers\/1234567890\/userLists\/50'/);
  assert.match(textOf(result), /"job_id": "555"/);

  let first = true;
  const flaky = fakeClient({ rows: (q) => {
    if (from(q) === "offline_user_data_job") throw new Error("sem acesso");
    return first ? ((first = false), rows(q)) : [];
  } });
  const partial = await call(flaky.client, "get_customer_match_status", {});
  assert.equal(partial.isError, undefined);
  assert.match(textOf(partial), /Não consegui ler os jobs/);
  assert.equal((await call(flaky.client, "get_customer_match_status", { userListId: "x" })).isError, true);
});
