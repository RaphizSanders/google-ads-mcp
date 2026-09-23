/**
 * Lote shopping: Merchant Center (product_link / product_link_invitation), campanha
 * Shopping padrão que veicula (grupo + anúncio de produto + árvore), árvores de produtos
 * de PMax e Shopping padrão (várias camadas, PRODUCT_CONDITION, leitura, exclusão de itens)
 * e desempenho por grupo de produtos.
 *
 * O client falso valida toda GAQL contra os metadados reais da v25 (assertGaqlRules) e
 * registra cada escrita, para provar: formato do payload, recusa antes de qualquer chamada,
 * no-op sem escrita, tradução de erro da API, dry-run/validateOnly e confirm.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerGoogleAdsTools } from "../src/tools.js";
import { buildTreeFromUnits, renderTree, treeToUnits } from "../src/tools/shopping.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const MC = "123456";
const AG = "555"; // asset group PMax
const AGR = "888"; // ad group Shopping padrão

// ── Client falso ──────────────────────────────────────────────────────

interface Write {
  method: string;
  dryRun: boolean;
  operations?: Row[];
  action?: string;
  body?: Row;
}

interface FakeOptions {
  rows?: Record<string, Row[] | ((query: string) => Row[])>;
  dryRun?: boolean;
  batchMutate?: (operations: Row[]) => Row;
  writeAction?: (action: string, body: Row) => Row;
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
      const rows = opts.rows?.[from];
      return typeof rows === "function" ? rows(query) : rows ?? [];
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => ({
          [Object.keys(op)[0].replace(/Operation$/, "Result")]: { resourceName: `customers/${CID}/x/${i}` },
        })),
      };
    },
    async customerWriteAction(_customerId: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ method: "customerWriteAction", action, body, dryRun });
      if (dryRun) throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      if (opts.writeAction) return opts.writeAction(action, body);
      return { resourceName: `customers/${CID}/productLinks/99` };
    },
    async customerAction(_customerId: string, action: string, body: Row): Promise<Row> {
      calls.writes.push({ method: "customerAction", action, body, dryRun });
      return {};
    },
    async mutateAdGroupAds(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroupAds", operations, dryRun });
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/adGroupAds/${AGR}~42` }] };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function handlers(client: unknown): Map<string, Handler> {
  const map = new Map<string, Handler>();
  registerGoogleAdsTools(
    { registerTool: (name: string, _config: unknown, handler: Handler) => map.set(name, handler) } as never,
    () => client as never,
    [],
    false
  );
  return map;
}

const call = (client: unknown, tool: string, args: Row) => handlers(client).get(tool)!({ customerId: CID, ...args });
const textOf = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
const creates = (write: Write, key: string) =>
  (write.operations ?? []).filter((op) => (op[key] as Row | undefined)?.create).map((op) => (op[key] as Row).create as Row);
const removes = (write: Write, key: string) =>
  (write.operations ?? []).filter((op) => (op[key] as Row | undefined)?.remove).map((op) => String((op[key] as Row).remove));

// ── Fixtures ──────────────────────────────────────────────────────────

const pmaxAssetGroup = (overrides: Row = {}) => [{
  assetGroup: { id: AG, name: "Todos os produtos", status: "ENABLED" },
  campaign: { id: "777", name: "PMax Loja", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", shoppingSetting: { merchantId: MC }, ...overrides },
}];

const pmaxName = (id: string) => `customers/${CID}/assetGroupListingGroupFilters/${AG}~${id}`;
function pmaxNode(id: string, type: string, parent?: string, caseValue?: Row, listingSource = "SHOPPING"): Row {
  return {
    assetGroupListingGroupFilter: {
      resourceName: pmaxName(id), id, type, listingSource,
      ...(parent ? { parentListingGroupFilter: pmaxName(parent) } : {}),
      ...(caseValue ? { caseValue } : {}),
    },
    assetGroup: { id: AG, name: "Todos os produtos", status: "ENABLED" },
    campaign: { id: "777", name: "PMax Loja" },
  };
}

const shoppingAdGroup = (overrides: { adGroup?: Row; campaign?: Row } = {}) => [{
  adGroup: { id: AGR, name: "Grupo Shopping", status: "ENABLED", type: "SHOPPING_PRODUCT_ADS", cpcBidMicros: "700000", ...overrides.adGroup },
  campaign: { id: "999", name: "Shopping Loja", status: "PAUSED", advertisingChannelType: "SHOPPING", biddingStrategyType: "MANUAL_CPC", ...overrides.campaign },
}];

const stdName = (id: string) => `customers/${CID}/adGroupCriteria/${AGR}~${id}`;
function stdNode(id: string, type: string, o: { parent?: string; caseValue?: Row; negative?: boolean; bid?: number } = {}): Row {
  return {
    adGroupCriterion: {
      resourceName: stdName(id), criterionId: id, status: "ENABLED",
      ...(o.negative ? { negative: true } : {}),
      ...(o.bid !== undefined ? { cpcBidMicros: String(o.bid) } : {}),
      listingGroup: { type, ...(o.parent ? { parentAdGroupCriterion: stdName(o.parent) } : {}), ...(o.caseValue ? { caseValue: o.caseValue } : {}) },
    },
    adGroup: { id: AGR, name: "Grupo Shopping", status: "ENABLED" },
    campaign: { id: "999", name: "Shopping Loja" },
  };
}

// ══ Merchant Center ═══════════════════════════════════════════════════

test("list_merchant_centers: product_link + convites + campanhas, sem merchant_center_link", async () => {
  const { client, calls } = fakeClient({
    rows: {
      product_link: [{ productLink: { resourceName: `customers/${CID}/productLinks/7`, productLinkId: "7", type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: MC } } }],
      product_link_invitation: [
        { productLinkInvitation: { resourceName: `customers/${CID}/productLinkInvitations/31`, productLinkInvitationId: "31", status: "PENDING_APPROVAL", type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: "999001" } } },
        { productLinkInvitation: { resourceName: `customers/${CID}/productLinkInvitations/32`, productLinkInvitationId: "32", status: "REJECTED", type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: "999002" } } },
      ],
      campaign: [
        { campaign: { id: "1", name: "Shopping BR", status: "ENABLED", advertisingChannelType: "SHOPPING", shoppingSetting: { merchantId: MC, feedLabel: "BR" } } },
        { campaign: { id: "2", name: "PMax antigo", status: "PAUSED", advertisingChannelType: "PERFORMANCE_MAX", shoppingSetting: { merchantId: "555000" } } },
      ],
    },
  });
  const result = await call(client, "list_merchant_centers", {});
  assert.equal(result.isError, undefined);
  const body = textOf(result);
  assert.ok(calls.queries.every((q) => !q.includes("merchant_center_link")));
  assert.ok(calls.queries.some((q) => /FROM product_link\b/.test(q)));
  assert.ok(calls.queries.some((q) => /FROM product_link_invitation/.test(q)));
  const json = JSON.parse(body.slice(body.indexOf("{")));
  assert.equal(json.linked[0].merchant_id, MC);
  assert.equal(json.linked[0].campaigns_using[0].name, "Shopping BR");
  assert.equal(json.pending_invitations.length, 1);
  assert.equal(json.pending_invitations[0].invitation_id, "31");
  assert.equal(json.invitation_history, undefined, "histórico só com includeInvitationHistory");
  assert.equal(json.merchants_in_campaigns_without_link[0].merchant_id, "555000");
  assert.equal(calls.writes.length, 0);
});

test("list_merchant_centers: falha de leitura aparece no resultado, não vira lista vazia silenciosa", async () => {
  const { client } = fakeClient({
    rows: { product_link: () => { throw new Error("Google Ads API: PERMISSION_DENIED"); } },
  });
  const result = await call(client, "list_merchant_centers", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Falha ao ler: product_link: .*PERMISSION_DENIED/);
});

const invitationRow = (status: string, type = "MERCHANT_CENTER") => [{
  productLinkInvitation: {
    resourceName: `customers/${CID}/productLinkInvitations/31`, productLinkInvitationId: "31", status, type,
    merchantCenter: { merchantCenterId: MC },
  },
}];

test("respond_merchant_center_invitation: valida o ID antes de qualquer chamada", async () => {
  for (const invitationId of ["abc", "31 OR 1=1", `customers/9999999999/productLinkInvitations/31`]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "respond_merchant_center_invitation", { invitationId, action: "ACCEPT", confirm: true });
    assert.equal(result.isError, true, invitationId);
    assert.equal(calls.queries.length, 0, invitationId);
    assert.equal(calls.writes.length, 0, invitationId);
  }
});

test("respond_merchant_center_invitation: aceita só com confirm, pelo endpoint productLinkInvitations:update", async () => {
  const preview = fakeClient({ rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") } });
  const noConfirm = await call(preview.client, "respond_merchant_center_invitation", { invitationId: "31", action: "ACCEPT" });
  assert.equal(noConfirm.isError, true);
  assert.match(textOf(noConfirm), /Prévia \(nada foi alterado\).*PENDING_APPROVAL → ACCEPTED/);
  assert.equal(preview.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") } });
  const result = await call(client, "respond_merchant_center_invitation", {
    invitationId: `customers/${CID}/productLinkInvitations/31`, action: "ACCEPT", confirm: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].action, "productLinkInvitations:update");
  assert.deepEqual(calls.writes[0].body, {
    resourceName: `customers/${CID}/productLinkInvitations/31`,
    productLinkInvitationStatus: "ACCEPTED",
  });
  assert.match(calls.queries[0], /product_link_invitation_id = 31/);
});

test("respond_merchant_center_invitation: recusa avisa que é definitiva e manda REJECTED", async () => {
  const preview = fakeClient({ rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") } });
  assert.match(textOf(await call(preview.client, "respond_merchant_center_invitation", { invitationId: "31", action: "REJECT" })), /definitiva/);
  const { client, calls } = fakeClient({ rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") } });
  await call(client, "respond_merchant_center_invitation", { invitationId: "31", action: "REJECT", confirm: true });
  assert.equal((calls.writes[0].body as Row).productLinkInvitationStatus, "REJECTED");
});

test("respond_merchant_center_invitation: no-op, convite enviado por nós, tipo errado e não encontrado", async () => {
  const cases: Array<[Row[], string, RegExp, boolean | undefined]> = [
    [invitationRow("ACCEPTED"), "ACCEPT", /Nada a fazer/, undefined],
    [invitationRow("REQUESTED"), "ACCEPT", /enviado por esta conta/, true],
    [invitationRow("EXPIRED"), "ACCEPT", /só convites PENDING_APPROVAL/, true],
    [invitationRow("PENDING_APPROVAL", "HOTEL_CENTER"), "ACCEPT", /não Merchant Center/, true],
    [[], "ACCEPT", /não encontrado/, true],
  ];
  for (const [rows, action, pattern, isError] of cases) {
    const { client, calls } = fakeClient({ rows: { product_link_invitation: rows } });
    const result = await call(client, "respond_merchant_center_invitation", { invitationId: "31", action, confirm: true });
    assert.match(textOf(result), pattern);
    assert.equal(result.isError, isError);
    assert.equal(calls.writes.length, 0);
  }
});

test("respond_merchant_center_invitation: dry-run não envia (a API não tem validate_only) e erro da API é traduzido", async () => {
  const dry = fakeClient({ dryRun: true, rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") } });
  const result = await call(dry.client, "respond_merchant_center_invitation", { invitationId: "31", action: "ACCEPT", confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não oferece validate_only.*nada foi enviado/);
  assert.equal(dry.calls.writes.length, 0);

  const failing = fakeClient({
    rows: { product_link_invitation: invitationRow("PENDING_APPROVAL") },
    writeAction: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The invitation status is invalid."); },
  });
  const error = await call(failing.client, "respond_merchant_center_invitation", { invitationId: "31", action: "ACCEPT", confirm: true });
  assert.equal(error.isError, true);
  assert.match(textOf(error), /Nada foi alterado[\s\S]*não está mais pendente/);
});

test("link_merchant_center: já vinculado é no-op; convite pendente manda aceitar; confirm e dry-run", async () => {
  const linked = fakeClient({ rows: { product_link: [{ productLink: { resourceName: "x", productLinkId: "7" } }] } });
  assert.match(textOf(await call(linked.client, "link_merchant_center", { merchantId: MC, confirm: true })), /já está vinculado/);
  assert.equal(linked.calls.writes.length, 0);

  const pending = fakeClient({ rows: { product_link_invitation: [{ productLinkInvitation: { productLinkInvitationId: "31", status: "PENDING_APPROVAL" } }] } });
  const pendingResult = await call(pending.client, "link_merchant_center", { merchantId: MC, confirm: true });
  assert.equal(pendingResult.isError, true);
  assert.match(textOf(pendingResult), /respond_merchant_center_invitation/);
  assert.equal(pending.calls.writes.length, 0);

  const preview = fakeClient();
  assert.equal((await call(preview.client, "link_merchant_center", { merchantId: MC })).isError, true);
  assert.equal(preview.calls.writes.length, 0);

  const dry = fakeClient({ dryRun: true });
  const dryResult = await call(dry.client, "link_merchant_center", { merchantId: MC, confirm: true });
  assert.match(textOf(dryResult), /não oferece validate_only para CreateProductLink/);
  assert.equal(dry.calls.writes.length, 0);

  const { client, calls } = fakeClient();
  const result = await call(client, "link_merchant_center", { merchantId: MC, confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].action, "productLinks:create");
  assert.deepEqual(calls.writes[0].body, { productLink: { merchantCenter: { merchantCenterId: MC } } });
});

test("link_merchant_center: ID inválido recusado antes da API; CREATION_NOT_PERMITTED explica o fluxo de convite", async () => {
  const bad = fakeClient();
  assert.equal((await call(bad.client, "link_merchant_center", { merchantId: "12a", confirm: true })).isError, true);
  assert.equal(bad.calls.queries.length, 0);

  const { client } = fakeClient({
    writeAction: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The creation request is not permitted."); },
  });
  const result = await call(client, "link_merchant_center", { merchantId: MC, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /administrador nas DUAS contas/);
});

test("unlink_merchant_center: mostra campanhas afetadas, exige confirm e valida em dry-run com validateOnly", async () => {
  const rows = {
    product_link: [{ productLink: { resourceName: `customers/${CID}/productLinks/7`, productLinkId: "7", type: "MERCHANT_CENTER", merchantCenter: { merchantCenterId: MC } } }],
    campaign: [{ campaign: { id: "1", name: "Shopping BR", status: "ENABLED", advertisingChannelType: "SHOPPING" } }],
  };
  const both = fakeClient({ rows });
  assert.equal((await call(both.client, "unlink_merchant_center", { productLinkId: "7", merchantId: MC, confirm: true })).isError, true);
  assert.equal(both.calls.queries.length, 0);

  const preview = fakeClient({ rows });
  const previewResult = await call(preview.client, "unlink_merchant_center", { merchantId: MC });
  assert.equal(previewResult.isError, true);
  assert.match(textOf(previewResult), /1 campanha\(s\) usam este MC[\s\S]*Shopping BR/);
  assert.equal(preview.calls.writes.length, 0);

  const dry = fakeClient({ rows, dryRun: true });
  const dryResult = await call(dry.client, "unlink_merchant_center", { productLinkId: "7" });
  assert.match(textOf(dryResult), /DRY-RUN \(validateOnly\): a API validou a remoção — nada foi removido/);
  assert.deepEqual(dry.calls.writes.map((w) => [w.method, w.action, (w.body as Row).validateOnly]), [["customerAction", "productLinks:remove", true]]);

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "unlink_merchant_center", { productLinkId: "7", confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes.map((w) => [w.method, w.action]), [["customerWriteAction", "productLinks:remove"]]);
  assert.deepEqual(calls.writes[0].body, { resourceName: `customers/${CID}/productLinks/7` });

  const missing = fakeClient();
  assert.match(textOf(await call(missing.client, "unlink_merchant_center", { productLinkId: "7", confirm: true })), /Nenhum vínculo encontrado/);
  assert.equal(missing.calls.writes.length, 0);
});

// ══ create_shopping_campaign ═══════════════════════════════════════════

const productRows = (labels: string[]) => labels.map((feedLabel) => ({ shoppingProduct: { feedLabel, merchantCenterId: MC } }));
const linkedMc = { product_link: [{ productLink: { resourceName: "x", merchantCenter: { merchantCenterId: MC } } }] };

test("create_shopping_campaign: orçamento + campanha atômicos, sem feed_label forçado, Maximizar cliques por padrão", async () => {
  const { client, calls } = fakeClient({ rows: { ...linkedMc, shopping_product: productRows(["BR", "BR"]) } });
  const result = await call(client, "create_shopping_campaign", { name: "Shopping Loja", merchantId: MC, dailyBudgetMicros: 50_000_000 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.method, "batchMutate");
  const [budget] = creates(write, "campaignBudgetOperation");
  const [campaign] = creates(write, "campaignOperation");
  assert.equal(budget.resourceName, `customers/${CID}/campaignBudgets/-1`);
  assert.equal(campaign.campaignBudget, budget.resourceName);
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.advertisingChannelType, "SHOPPING");
  assert.deepEqual(campaign.shoppingSetting, { merchantId: MC, campaignPriority: 0 });
  assert.deepEqual(campaign.targetSpend, {});
  assert.equal(campaign.maximizeConversionValue, undefined);
  assert.equal((campaign.networkSettings as Row).targetContentNetwork, false);
  assert.match(textOf(result), /feed: todos os feeds/);
});

test("create_shopping_campaign: feedLabel conferido contra os produtos do MC", async () => {
  const unknown = fakeClient({ rows: { ...linkedMc, shopping_product: productRows(["BR", "PT"]) } });
  const refused = await call(unknown.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, feedLabel: "us" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /feedLabel "US" não existe[\s\S]*BR, PT/);
  assert.equal(unknown.calls.writes.length, 0);

  const known = fakeClient({ rows: { ...linkedMc, shopping_product: productRows(["BR", "PT"]) } });
  await call(known.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, feedLabel: "pt", enableLocal: true });
  const [campaign] = creates(known.calls.writes[0], "campaignOperation");
  assert.deepEqual(campaign.shoppingSetting, { merchantId: MC, campaignPriority: 0, feedLabel: "PT", enableLocal: true });

  // Amostra truncada: não dá para afirmar que não existe — só avisa
  const many = fakeClient({ rows: { ...linkedMc, shopping_product: productRows(Array(10000).fill("BR")) } });
  const warned = await call(many.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, feedLabel: "PT" });
  assert.equal(warned.isError, undefined);
  assert.match(textOf(warned), /não apareceu na amostra/);

  // MC sem produto visível por merchant_center_id: tenta como conta multicliente
  const mca = fakeClient({ rows: { shopping_product: (q) => (q.includes("multi_client_account_id =") ? productRows(["BR"]) : []) } });
  await call(mca.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000 });
  assert.equal(mca.calls.queries.filter((q) => q.includes("FROM shopping_product")).length, 2);
  assert.match(textOf(await call(fakeClient().client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000 })), /Nenhum produto do Merchant Center/);
});

test("create_shopping_campaign: TARGET_ROAS vai como campaign.targetRoas; MAXIMIZE_CONVERSION_VALUE só por escolha e com aviso", async () => {
  const roas = fakeClient({ rows: linkedMc });
  await call(roas.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, biddingStrategy: "TARGET_ROAS", targetRoas: 4 });
  const [campaign] = creates(roas.calls.writes[0], "campaignOperation");
  assert.deepEqual(campaign.targetRoas, { targetRoas: 4 });
  assert.equal(campaign.maximizeConversionValue, undefined);

  const mcv = fakeClient({ rows: linkedMc });
  const result = await call(mcv.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, biddingStrategy: "MAXIMIZE_CONVERSION_VALUE" });
  assert.deepEqual(creates(mcv.calls.writes[0], "campaignOperation")[0].maximizeConversionValue, {});
  assert.match(textOf(result), /não consta na doc da API para Shopping padrão/);

  const clicks = fakeClient({ rows: linkedMc });
  await call(clicks.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000, biddingStrategy: "TARGET_SPEND", cpcBidCeilingMicros: 2_000_000 });
  assert.deepEqual(creates(clicks.calls.writes[0], "campaignOperation")[0].targetSpend, { cpcBidCeilingMicros: "2000000" });
});

test("create_shopping_campaign: entradas inválidas recusadas antes de qualquer chamada", async () => {
  const base = { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000 };
  const cases: Array<[Row, RegExp]> = [
    [{ biddingStrategy: "MAXIMIZE_CONVERSIONS" }, /MAXIMIZE_CONVERSIONS não é estratégia padrão válida para Shopping/],
    [{ biddingStrategy: "TARGET_ROAS" }, /TARGET_ROAS exige targetRoas/],
    [{ biddingStrategy: "MANUAL_CPC", cpcBidCeilingMicros: 1_000_000 }, /cpcBidCeilingMicros só vale com MAXIMIZE_CLICKS/],
    [{ targetRoas: 3 }, /targetRoas só vale com TARGET_ROAS ou MAXIMIZE_CONVERSION_VALUE/],
    [{ campaignPriority: 3 }, /campaignPriority aceita 0, 1 ou 2/],
    [{ feedLabel: "BR com espaço" }, /feedLabel inválido/],
    [{ merchantId: "MC-1" }, /merchantId inválido/],
    [{ dailyBudgetMicros: 0 }, /dailyBudgetMicros deve ser inteiro positivo/],
    [{ adGroupName: "Grupo" }, /só valem com withDefaultAdGroup/],
    [{ withDefaultAdGroup: true, biddingStrategy: "MANUAL_CPC" }, /exige adGroupCpcBidMicros/],
  ];
  for (const [overrides, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: linkedMc });
    const result = await call(client, "create_shopping_campaign", { ...base, ...overrides });
    assert.equal(result.isError, true, JSON.stringify(overrides));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(overrides));
  }
});

test("create_shopping_campaign: withDefaultAdGroup cria grupo, anúncio de produto e raiz num único mutate", async () => {
  const { client, calls } = fakeClient({ rows: linkedMc });
  const result = await call(client, "create_shopping_campaign", {
    name: "Shopping Loja", merchantId: MC, dailyBudgetMicros: 1_000_000, biddingStrategy: "MANUAL_CPC",
    withDefaultAdGroup: true, adGroupCpcBidMicros: 800_000,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.deepEqual(write.operations!.map((op) => Object.keys(op)[0]), [
    "campaignBudgetOperation", "campaignOperation", "adGroupOperation", "adGroupAdOperation", "adGroupCriterionOperation",
  ]);
  const [campaign] = creates(write, "campaignOperation");
  const [adGroup] = creates(write, "adGroupOperation");
  const [ad] = creates(write, "adGroupAdOperation");
  const [root] = creates(write, "adGroupCriterionOperation");
  assert.deepEqual(campaign.manualCpc, {});
  assert.equal(adGroup.campaign, campaign.resourceName);
  assert.equal(adGroup.type, "SHOPPING_PRODUCT_ADS");
  assert.equal(adGroup.cpcBidMicros, "800000");
  assert.equal(adGroup.name, "Shopping Loja — Todos os produtos");
  assert.deepEqual(ad, { adGroup: adGroup.resourceName, status: "ENABLED", ad: { shoppingProductAd: {} } });
  assert.deepEqual(root, { adGroup: adGroup.resourceName, status: "ENABLED", listingGroup: { type: "UNIT" }, cpcBidMicros: "800000" });
});

test("create_shopping_campaign: erro da API não deixa nada órfão; dry-run não afirma criação", async () => {
  const failing = fakeClient({ rows: linkedMc, batchMutate: () => { throw new Error("Google Ads API: DUPLICATE_CAMPAIGN_NAME"); } });
  const error = await call(failing.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000 });
  assert.equal(error.isError, true);
  assert.match(textOf(error), /Nada foi criado \(orçamento, campanha e grupo vão na mesma operação atômica\)/);

  const dry = fakeClient({ rows: linkedMc, dryRun: true });
  const result = await call(dry.client, "create_shopping_campaign", { name: "X", merchantId: MC, dailyBudgetMicros: 1_000_000 });
  assert.match(textOf(result), /^DRY-RUN \(validateOnly\): a API validou a operação — nada foi criado/);
  assert.equal(dry.calls.writes[0].dryRun, true);
});

// ══ create_shopping_product_ad ═════════════════════════════════════════

test("create_shopping_product_ad: cria shopping_product_ad PAUSADO e avisa se falta árvore", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: shoppingAdGroup() } });
  const result = await call(client, "create_shopping_product_ad", { adGroupId: AGR });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [
    { create: { adGroup: `customers/${CID}/adGroups/${AGR}`, status: "PAUSED", ad: { shoppingProductAd: {} } } },
  ]);
  assert.match(textOf(result), /set_shopping_product_groups/);
});

test("create_shopping_product_ad: no-op quando já existe, recusa grupo que não é Shopping e ID inválido", async () => {
  const existing = fakeClient({
    rows: {
      ad_group: shoppingAdGroup(),
      ad_group_ad: [{ adGroupAd: { resourceName: "customers/1/adGroupAds/888~1", status: "PAUSED", ad: { id: "1", type: "SHOPPING_PRODUCT_AD" } } }],
      ad_group_criterion: [{ adGroupCriterion: { resourceName: stdName("1") } }],
    },
  });
  const noop = await call(existing.client, "create_shopping_product_ad", { adGroupId: AGR, status: "ENABLED" });
  assert.match(textOf(noop), /Nada a fazer[\s\S]*PAUSADO — ative com update_ad_status/);
  assert.equal(existing.calls.writes.length, 0, "não reativa nem duplica");

  const search = fakeClient({ rows: { ad_group: shoppingAdGroup({ adGroup: { type: "SEARCH_STANDARD" }, campaign: { advertisingChannelType: "SEARCH" } }) } });
  assert.equal((await call(search.client, "create_shopping_product_ad", { adGroupId: AGR })).isError, true);
  assert.equal(search.calls.writes.length, 0);

  const bad = fakeClient();
  assert.equal((await call(bad.client, "create_shopping_product_ad", { adGroupId: "88 8" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);

  const dry = fakeClient({ dryRun: true, rows: { ad_group: shoppingAdGroup() } });
  assert.match(textOf(await call(dry.client, "create_shopping_product_ad", { adGroupId: AGR })), /DRY-RUN/);
});

// ══ Motor da árvore ════════════════════════════════════════════════════

test("árvore: vários níveis com PRODUCT_CONDITION e \"outros\" automáticos", () => {
  const { tree, errors, notes } = buildTreeFromUnits([
    { path: [{ dimension: "PRODUCT_CONDITION", value: "new" }] },
    { path: [{ dimension: "PRODUCT_CONDITION", value: "USED" }], excluded: true },
    { path: [{ dimension: "PRODUCT_CONDITION" }, { dimension: "PRODUCT_BRAND", value: "CoolBrand" }] },
  ], "PMAX");
  assert.deepEqual(errors, []);
  assert.ok(tree);
  const rendered = renderTree(tree);
  assert.match(rendered, /Condição = "NEW" — INCLUÍDO/);
  assert.match(rendered, /Condição = \(outros\) — subdividido por Marca/);
  assert.match(rendered, /Marca = \(outros\) — EXCLUÍDO/);
  assert.equal(notes.length, 1, "só o \"outros\" de marca foi criado");
  // ida e volta: units da árvore reconstroem a mesma árvore
  const again = buildTreeFromUnits(treeToUnits(tree), "PMAX");
  assert.equal(renderTree(again.tree!), rendered.replace(/ · \(criado automaticamente\)/g, ""));
});

test("árvore: \"outros\" automático decide depois de completar os filhos", () => {
  // Nike só tem exclusões abaixo → o "outros" de Nike é INCLUÍDO → Nike inclui produtos →
  // o "outros" da raiz (marca) fica EXCLUÍDO.
  const { tree } = buildTreeFromUnits([
    { path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }, { dimension: "PRODUCT_CONDITION", value: "USED" }], excluded: true },
  ], "PMAX");
  const rendered = renderTree(tree!);
  assert.match(rendered, /├─ Marca = "Nike" — subdividido[\s\S]*Condição = \(outros\) — INCLUÍDO[\s\S]*└─ Marca = \(outros\) — EXCLUÍDO/);
  const include = buildTreeFromUnits([{ path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] }], "PMAX", "INCLUDE");
  assert.match(renderTree(include.tree!), /Marca = \(outros\) — INCLUÍDO/);
});

test("árvore: regras da API recusadas antes de qualquer chamada", () => {
  const cases: Array<[Parameters<typeof buildTreeFromUnits>[0], RegExp, ("PMAX" | "SHOPPING")?]> = [
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }] }, { path: [{ dimension: "PRODUCT_CONDITION", value: "NEW" }] }], /mesma dimensão/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }, { dimension: "PRODUCT_BRAND", value: "B" }] }], /já foi usada acima/],
    [[{ path: [{ dimension: "PRODUCT_CATEGORY_LEVEL2", value: "123" }] }], /só pode refinar um nó com valor de nível 1/],
    [[{ path: [{ dimension: "PRODUCT_CATEGORY_LEVEL1" }, { dimension: "PRODUCT_CATEGORY_LEVEL2", value: "5" }] }, { path: [{ dimension: "PRODUCT_CATEGORY_LEVEL1", value: "1" }] }], /nem "outros" pode ser refinado/],
    [[{ path: [{ dimension: "PRODUCT_TYPE_LEVEL2", value: "a" }] }], /nível 1/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] }, { path: [{ dimension: "PRODUCT_BRAND", value: "nike" }] }], /mais de uma vez/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }] }, { path: [{ dimension: "PRODUCT_BRAND", value: "A" }, { dimension: "PRODUCT_CONDITION", value: "NEW" }] }], /passa por um nó/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }, { dimension: "PRODUCT_CONDITION", value: "NEW" }] }, { path: [{ dimension: "PRODUCT_BRAND", value: "A" }] }], /não pode ser folha também/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }], cpcBidMicros: 1_000_000 }], /PMax não usa lance/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }], excluded: true, cpcBidMicros: 1_000_000 }], /lance não se aplica a exclusão/, "SHOPPING"],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "A" }], cpcBidMicros: 0.5 }], /inteiro positivo/, "SHOPPING"],
    [[{ path: [], excluded: true }], /raiz .* não pode ser excluída/],
    [[{ path: [{ dimension: "PRODUCT_CONDITION", value: "SEMINOVO" }] }], /NEW, USED, REFURBISHED/],
    [[{ path: [{ dimension: "PRODUCT_CATEGORY_LEVEL1", value: "Roupas" }] }], /ID numérico da categoria/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "a==b" }] }], /"==" nem "&\+"/],
    [[{ path: [{ dimension: "PRODUCT_BRAND", value: "  " }] }], /value vazio/],
    [[{ path: [{ dimension: "PRODUCT_BRAND" }] }], /sem nenhum valor/],
    [[], /ao menos uma unidade/],
  ];
  for (const [units, pattern, engine] of cases) {
    const { tree, errors } = buildTreeFromUnits(units, engine ?? "PMAX");
    assert.equal(tree, undefined, JSON.stringify(units));
    assert.match(errors.join("\n"), pattern, JSON.stringify(units));
  }
});

// ══ set_listing_group_filter (PMax) ════════════════════════════════════

test("set_listing_group_filter: formato antigo (filters) mantém a semântica e vai num googleAds:mutate", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG,
    filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }, { dimension: "PRODUCT_BRAND", value: "Adidas" }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const created = creates(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.equal(created.length, 4);
  const [root, ...children] = created;
  assert.equal(root.type, "SUBDIVISION");
  assert.equal(root.parentListingGroupFilter, undefined);
  assert.equal(root.caseValue, undefined);
  assert.equal(root.resourceName, `customers/${CID}/assetGroupListingGroupFilters/${AG}~-1`);
  for (const child of children) {
    assert.equal(child.parentListingGroupFilter, root.resourceName);
    assert.equal(child.listingSource, "SHOPPING");
    assert.equal(child.assetGroup, `customers/${CID}/assetGroups/${AG}`);
  }
  assert.deepEqual(children.map((c) => [c.type, c.caseValue]), [
    ["UNIT_INCLUDED", { productBrand: { value: "Adidas" } }],
    ["UNIT_INCLUDED", { productBrand: { value: "Nike" } }],
    ["UNIT_EXCLUDED", { productBrand: {} }],
  ]);
});

test("set_listing_group_filter: árvore de vários níveis com PRODUCT_CONDITION, pais antes dos filhos", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG,
    units: [
      { path: [{ dimension: "PRODUCT_CONDITION", value: "NEW" }] },
      { path: [{ dimension: "PRODUCT_CONDITION", value: "USED" }] },
      { path: [{ dimension: "PRODUCT_CONDITION" }, { dimension: "PRODUCT_BRAND", value: "CoolBrand" }] },
      { path: [{ dimension: "PRODUCT_CONDITION" }, { dimension: "PRODUCT_BRAND", value: "CheapBrand" }] },
      { path: [{ dimension: "PRODUCT_CONDITION" }, { dimension: "PRODUCT_BRAND" }], excluded: true },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const created = creates(calls.writes[0], "assetGroupListingGroupFilterOperation");
  const seen = new Set<string>();
  for (const node of created) {
    if (node.parentListingGroupFilter) assert.ok(seen.has(String(node.parentListingGroupFilter)), "pai criado antes do filho");
    seen.add(String(node.resourceName));
  }
  const conditionOther = created.find((n) => JSON.stringify(n.caseValue) === JSON.stringify({ productCondition: {} }))!;
  assert.equal(conditionOther.type, "SUBDIVISION");
  assert.ok(created.some((n) => JSON.stringify(n.caseValue) === JSON.stringify({ productCondition: { condition: "NEW" } })));
  const brandOther = created.find((n) => JSON.stringify(n.caseValue) === JSON.stringify({ productBrand: {} }))!;
  assert.equal(brandOther.type, "UNIT_EXCLUDED");
  assert.equal(brandOther.parentListingGroupFilter, conditionOther.resourceName);
});

// Só SHOPPING: a API não aceita filtros de duas fontes no mesmo asset group (MULTIPLE_LISTING_SOURCES)
const subdividedPmaxTree = () => [
  pmaxNode("1", "SUBDIVISION"),
  pmaxNode("2", "UNIT_INCLUDED", "1", { productBrand: { value: "Nike" } }),
  pmaxNode("3", "UNIT_EXCLUDED", "1"), // "outros" sem case_value na resposta
];

/** Asset group só com filtro de página (WEBPAGE) — estado válido, sem árvore de produtos ao lado. */
const webpageOnly = () => [pmaxNode("9", "UNIT_INCLUDED", undefined, { webpage: { conditions: [{ urlContains: "/promo" }] } }, "WEBPAGE")];

test("set_listing_group_filter: não apaga árvore subdividida sem replace; mostra atual × proposta", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: subdividedPmaxTree() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG, units: [{ path: [{ dimension: "PRODUCT_CUSTOM_ATTRIBUTE0", value: "verao" }] }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /seria SUBSTITUÍDA inteira[\s\S]*Atual:[\s\S]*Marca = "Nike"[\s\S]*Proposta:[\s\S]*Rótulo personalizado 0 = "verao"[\s\S]*replace: true/);
  assert.equal(calls.writes.length, 0);
});

test("set_listing_group_filter: replace remove folhas antes da raiz e recria numa requisição", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: subdividedPmaxTree() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG, replace: true, units: [{ path: [{ dimension: "PRODUCT_CUSTOM_ATTRIBUTE0", value: "verao" }] }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const removed = removes(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.equal(removed.length, 3);
  assert.equal(removed[2], pmaxName("1"), "raiz removida por último");
  const ops = calls.writes[0].operations!;
  const firstCreate = ops.findIndex((op) => (op.assetGroupListingGroupFilterOperation as Row).create);
  assert.equal(firstCreate, 3, "removes antes dos creates");
  assert.doesNotMatch(textOf(result), /outras fontes/);
  const created = creates(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.deepEqual(created[1].caseValue, { productCustomAttribute: { index: "INDEX0", value: "verao" } });
  assert.deepEqual(created[2].caseValue, { productCustomAttribute: { index: "INDEX0" } });
});

test("set_listing_group_filter: árvore idêntica não grava; raiz 'todos os produtos' é trocada sem replace", async () => {
  const same = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: subdividedPmaxTree() } });
  const noop = await call(same.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "nike" }] });
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(same.calls.writes.length, 0);

  const trivial = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: [pmaxNode("1", "UNIT_INCLUDED")] } });
  const result = await call(trivial.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(removes(trivial.calls.writes[0], "assetGroupListingGroupFilterOperation"), [pmaxName("1")]);
});

test("set_listing_group_filter: recusas antes de gravar (árvore inválida, asset group errado, IDs)", async () => {
  const invalid = fakeClient({ rows: { asset_group: pmaxAssetGroup() } });
  const bad = await call(invalid.client, "set_listing_group_filter", {
    assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "A" }, { dimension: "PRODUCT_CHANNEL", value: "ONLINE" }],
  });
  assert.equal(bad.isError, true);
  assert.equal(invalid.calls.queries.length + invalid.calls.writes.length, 0);

  const noMerchant = fakeClient({ rows: { asset_group: pmaxAssetGroup({ shoppingSetting: {} }) } });
  const r1 = await call(noMerchant.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "A" }] });
  assert.match(textOf(r1), /não tem Merchant Center/);
  assert.equal(noMerchant.calls.writes.length, 0);

  const search = fakeClient({ rows: { asset_group: pmaxAssetGroup({ advertisingChannelType: "DEMAND_GEN" }) } });
  assert.match(textOf(await call(search.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "A" }] })), /não PMax/);

  const ids = fakeClient();
  assert.equal((await call(ids.client, "set_listing_group_filter", { assetGroupId: "5 OR 1=1", filters: [{ dimension: "PRODUCT_BRAND", value: "A" }] })).isError, true);
  assert.equal((await call(ids.client, "set_listing_group_filter", { assetGroupId: AG })).isError, true);
  assert.equal(ids.calls.queries.length, 0);
});

test("set_listing_group_filter: validateOnly por chamada roda em dry-run e erro de árvore é traduzido", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG, validateOnly: true, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY[\s\S]*DRY-RUN \(validateOnly\): a API validou/);

  const failing = fakeClient({
    rows: { asset_group: pmaxAssetGroup() },
    batchMutate: () => { throw new Error("Google Ads API: TREE_WAS_INVALID_BEFORE_MUTATION"); },
  });
  const error = await call(failing.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] });
  assert.equal(error.isError, true);
  assert.match(textOf(error), /Nada foi alterado \(operação atômica\)[\s\S]*já estava inválida/);
});

test("set_listing_group_filter: asset group com filtros WEBPAGE é recusado antes de qualquer escrita (MULTIPLE_LISTING_SOURCES)", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: webpageOnly() } });
  const result = await call(client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 0, "nenhuma escrita: a API recusaria duas fontes no mesmo asset group");
  const body = textOf(result);
  assert.match(body, /Nada foi alterado/);
  assert.match(body, /WEBPAGE UNIT_INCLUDED \(URL contém "\/promo"\)/);
  assert.ok(body.includes(pmaxName("9")), "lista o filtro WEBPAGE pelo resource name");
  assert.match(body, /UMA fonte só[\s\S]*MULTIPLE_LISTING_SOURCES[\s\S]*replaceOtherSources: true/);
  assert.match(body, /Proposta \(árvore de produtos\):[\s\S]*Marca = "Nike"/);
  assert.doesNotMatch(body, /preservad/);
  // a leitura pede o conteúdo do filtro de página (para listar o que seria removido)
  assert.ok(calls.queries.some((q) => q.includes("asset_group_listing_group_filter.case_value.webpage.conditions")));
});

test("set_listing_group_filter: replaceOtherSources remove os filtros WEBPAGE e cria a árvore na mesma requisição", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: webpageOnly() } });
  const result = await call(client, "set_listing_group_filter", {
    assetGroupId: AG, replaceOtherSources: true, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const ops = calls.writes[0].operations!;
  assert.deepEqual(removes(calls.writes[0], "assetGroupListingGroupFilterOperation"), [pmaxName("9")]);
  assert.ok((ops[0].assetGroupListingGroupFilterOperation as Row).remove, "remoção antes das criações");
  const created = creates(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.equal(created.length, 3);
  assert.ok(created.every((c) => c.listingSource === "SHOPPING"));
  assert.match(textOf(result), /Filtros de outras fontes removidos \(replaceOtherSources\):\n- WEBPAGE/);

  // validateOnly: vai em dry-run e não afirma remoção
  const dry = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: webpageOnly() } });
  const validated = await call(dry.client, "set_listing_group_filter", {
    assetGroupId: AG, replaceOtherSources: true, validateOnly: true, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }],
  });
  assert.equal(validated.isError, undefined, textOf(validated));
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(validated), /nada foi gravado[\s\S]*que seriam removidos/);
  assert.doesNotMatch(textOf(validated), /fontes removidos/);
});

test("set_listing_group_filter: MULTIPLE_LISTING_SOURCES da API vem explicado", async () => {
  const failing = fakeClient({
    rows: { asset_group: pmaxAssetGroup() },
    batchMutate: () => { throw new Error("Google Ads API: MULTIPLE_LISTING_SOURCES — All the filters under an AssetGroup should have the same listing source."); },
  });
  const result = await call(failing.client, "set_listing_group_filter", { assetGroupId: AG, filters: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi alterado \(operação atômica\)[\s\S]*MULTIPLE_LISTING_SOURCES[\s\S]*fonte só \(listing_source\)[\s\S]*replaceOtherSources: true/);
});

// ══ set_shopping_product_groups (Shopping padrão) ══════════════════════

test("set_shopping_product_groups: cria a árvore com lances, exclusões e IDs temporários", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: shoppingAdGroup() } });
  const result = await call(client, "set_shopping_product_groups", {
    adGroupId: AGR,
    units: [
      { path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }], cpcBidMicros: 1_200_000 },
      { path: [{ dimension: "PRODUCT_BRAND", value: "Genérica" }], excluded: true },
      { path: [{ dimension: "PRODUCT_BRAND" }], cpcBidMicros: 400_000 },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const created = creates(calls.writes[0], "adGroupCriterionOperation");
  const [root, ...children] = created;
  assert.deepEqual(root, {
    resourceName: `customers/${CID}/adGroupCriteria/${AGR}~-1`,
    adGroup: `customers/${CID}/adGroups/${AGR}`,
    status: "ENABLED",
    listingGroup: { type: "SUBDIVISION" },
  });
  assert.deepEqual(children.map((c) => [(c.listingGroup as Row).caseValue, c.negative, c.cpcBidMicros]), [
    [{ productBrand: { value: "Genérica" } }, true, undefined],
    [{ productBrand: { value: "Nike" } }, undefined, "1200000"],
    [{ productBrand: {} }, undefined, "400000"],
  ]);
  for (const child of children) assert.equal((child.listingGroup as Row).parentAdGroupCriterion, root.resourceName);
});

test("set_shopping_product_groups: CPC manual exige lance — recusa sem, completa com default ou CPC do grupo", async () => {
  const units = [{ path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] }];
  const noBid = fakeClient({ rows: { ad_group: shoppingAdGroup({ adGroup: { cpcBidMicros: undefined } }) } });
  const refused = await call(noBid.client, "set_shopping_product_groups", { adGroupId: AGR, units, othersPolicy: "INCLUDE" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /toda folha incluída precisa de lance[\s\S]*Marca=Nike[\s\S]*Marca=\(outros\)/);
  assert.equal(noBid.calls.writes.length, 0);

  const withDefault = fakeClient({ rows: { ad_group: shoppingAdGroup() } });
  await call(withDefault.client, "set_shopping_product_groups", { adGroupId: AGR, units, othersPolicy: "INCLUDE", defaultCpcBidMicros: 900_000 });
  const bids = creates(withDefault.calls.writes[0], "adGroupCriterionOperation").map((c) => c.cpcBidMicros).filter(Boolean);
  assert.deepEqual(bids, ["900000", "900000"]);

  const inherit = fakeClient({ rows: { ad_group: shoppingAdGroup() } });
  const inherited = await call(inherit.client, "set_shopping_product_groups", { adGroupId: AGR, units });
  assert.match(textOf(inherited), /R\$ 0\.70 \(CPC do grupo\)/);
});

const existingStdTree = () => [
  stdNode("1", "SUBDIVISION"),
  stdNode("2", "UNIT", { parent: "1", caseValue: { productBrand: { value: "Nike" } }, bid: 1_000_000 }),
  stdNode("3", "UNIT", { parent: "1", bid: 500_000 }),
];

test("set_shopping_product_groups: só lances mudam → update de cpc_bid_micros, sem recriar a árvore", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const result = await call(client, "set_shopping_product_groups", {
    adGroupId: AGR,
    units: [
      { path: [{ dimension: "PRODUCT_BRAND", value: "NIKE" }], cpcBidMicros: 1_300_000 },
      { path: [{ dimension: "PRODUCT_BRAND" }], cpcBidMicros: 500_000 },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.writes[0].operations!;
  assert.equal(ops.length, 1);
  const op = ops[0].adGroupCriterionOperation as { update: Row; updateMask: string };
  assert.deepEqual(op.update, { resourceName: stdName("2"), cpcBidMicros: "1300000" });
  assert.equal(op.updateMask, "cpc_bid_micros");
  assertUpdateMaskLeaves(op.updateMask);
  assert.match(textOf(result), /Marca=Nike: R\$ 1\.00 → R\$ 1\.30/);
});

test("set_shopping_product_groups: idêntica = no-op; estrutura nova exige replace e remove só a raiz", async () => {
  const same = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const noop = await call(same.client, "set_shopping_product_groups", {
    adGroupId: AGR,
    units: [{ path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }], cpcBidMicros: 1_000_000 }, { path: [{ dimension: "PRODUCT_BRAND" }] }],
  });
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(same.calls.writes.length, 0);

  const units = [{ path: [{ dimension: "PRODUCT_CONDITION", value: "NEW" }], cpcBidMicros: 1_000_000 }, { path: [{ dimension: "PRODUCT_CONDITION" }], excluded: true }];
  const gated = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const refused = await call(gated.client, "set_shopping_product_groups", { adGroupId: AGR, units });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /replace: true/);
  assert.equal(gated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const result = await call(client, "set_shopping_product_groups", { adGroupId: AGR, units, replace: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(removes(calls.writes[0], "adGroupCriterionOperation"), [stdName("1")], "remover a raiz remove a árvore");
  assert.equal(creates(calls.writes[0], "adGroupCriterionOperation").length, 3);
});

test("set_shopping_product_groups: recusa grupo que não é Shopping; estratégia automática avisa que ignora lances", async () => {
  const pmaxLike = fakeClient({ rows: { ad_group: shoppingAdGroup({ adGroup: { type: "SEARCH_STANDARD" }, campaign: { advertisingChannelType: "SEARCH" } }) } });
  const refused = await call(pmaxLike.client, "set_shopping_product_groups", { adGroupId: AGR, units: [{ path: [] }] });
  assert.equal(refused.isError, true);
  assert.equal(pmaxLike.calls.writes.length, 0);

  const auto = fakeClient({ rows: { ad_group: shoppingAdGroup({ campaign: { biddingStrategyType: "TARGET_ROAS" } }) } });
  const result = await call(auto.client, "set_shopping_product_groups", { adGroupId: AGR, units: [{ path: [], cpcBidMicros: 50_000 }] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /ignora os CPCs[\s\S]*Lance muito baixo/);
  const [root] = creates(auto.calls.writes[0], "adGroupCriterionOperation");
  assert.deepEqual(root.listingGroup, { type: "UNIT" });
});

// ══ exclude_products ═══════════════════════════════════════════════════

test("exclude_products (PMax): raiz 'todos' vira divisão por item com o resto em \"outros\"", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: [pmaxNode("1", "UNIT_INCLUDED")] } });
  const result = await call(client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1", "sku-2", "SKU-1"] });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.deepEqual(removes(write, "assetGroupListingGroupFilterOperation"), [pmaxName("1")]);
  const created = creates(write, "assetGroupListingGroupFilterOperation");
  assert.deepEqual(created.map((c) => [c.type, c.caseValue]), [
    ["SUBDIVISION", undefined],
    ["UNIT_EXCLUDED", { productItemId: { value: "SKU-1" } }],
    ["UNIT_EXCLUDED", { productItemId: { value: "sku-2" } }],
    ["UNIT_INCLUDED", { productItemId: {} }],
  ]);
});

test("exclude_products (PMax): raiz já por item só acrescenta; incluído vira excluído; já excluído é ignorado", async () => {
  const tree = [
    pmaxNode("1", "SUBDIVISION"),
    pmaxNode("2", "UNIT_EXCLUDED", "1", { productItemId: { value: "SKU-1" } }),
    pmaxNode("3", "UNIT_INCLUDED", "1", { productItemId: { value: "SKU-2" } }),
    pmaxNode("4", "UNIT_INCLUDED", "1", { productItemId: {} }),
  ];
  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: tree } });
  const result = await call(client, "exclude_products", { assetGroupId: AG, itemIds: ["sku-1", "SKU-2", "SKU-3"] });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.deepEqual(removes(write, "assetGroupListingGroupFilterOperation"), [pmaxName("3")]);
  const created = creates(write, "assetGroupListingGroupFilterOperation");
  assert.deepEqual(created.map((c) => [c.type, c.caseValue, c.parentListingGroupFilter]), [
    ["UNIT_EXCLUDED", { productItemId: { value: "SKU-2" } }, pmaxName("1")],
    ["UNIT_EXCLUDED", { productItemId: { value: "SKU-3" } }, pmaxName("1")],
  ]);
  assert.match(textOf(result), /Já estavam excluídos: sku-1/);

  const noop = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: tree } });
  assert.match(textOf(await call(noop.client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"] })), /Nada a fazer/);
  assert.equal(noop.calls.writes.length, 0);
});

test("exclude_products (Shopping padrão): árvore por marca com lances só vai para \"outros\" com replace", async () => {
  const gated = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const refused = await call(gated.client, "exclude_products", { adGroupId: AGR, itemIds: "[\"SKU-9\"]" });
  assert.equal(refused.isError, true);
  assert.equal(gated.calls.writes.length, 0, "sem replace nada é recriado");
  assert.match(textOf(refused), /REMOVIDA e RECRIADA[\s\S]*Atual:[\s\S]*Marca = "Nike"[\s\S]*Proposta:[\s\S]*ID do item = "SKU-9"[\s\S]*replace: true[\s\S]*lances atuais são copiados/);

  const { client, calls } = fakeClient({ rows: { ad_group: shoppingAdGroup(), ad_group_criterion: existingStdTree() } });
  const result = await call(client, "exclude_products", { adGroupId: AGR, itemIds: "[\"SKU-9\"]", replace: true });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.deepEqual(removes(write, "adGroupCriterionOperation"), [stdName("1")]);
  const created = creates(write, "adGroupCriterionOperation");
  assert.deepEqual(created.map((c) => [(c.listingGroup as Row).type, (c.listingGroup as Row).caseValue, c.negative, c.cpcBidMicros]), [
    ["SUBDIVISION", undefined, undefined, undefined],
    ["UNIT", { productItemId: { value: "SKU-9" } }, true, undefined],
    ["SUBDIVISION", { productItemId: {} }, undefined, undefined],
    ["UNIT", { productBrand: { value: "Nike" } }, undefined, "1000000"],
    ["UNIT", { productBrand: {} }, undefined, "500000"],
  ]);
});

test("exclude_products (PMax): árvore subdividida por marca não é recriada sem replace; com replace, atômica", async () => {
  // Reprodução do achado: SUBDIVISION(1) → Nike(2), Adidas(3), outros(4, excluído)
  const brandTree = () => [
    pmaxNode("1", "SUBDIVISION"),
    pmaxNode("2", "UNIT_INCLUDED", "1", { productBrand: { value: "Nike" } }),
    pmaxNode("3", "UNIT_INCLUDED", "1", { productBrand: { value: "Adidas" } }),
    pmaxNode("4", "UNIT_EXCLUDED", "1", { productBrand: {} }),
  ];
  const gated = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: brandTree() } });
  const refused = await call(gated.client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"] });
  assert.equal(refused.isError, true);
  assert.equal(gated.calls.writes.length, 0, "nenhum nó removido nem recriado sem replace");
  const body = textOf(refused);
  assert.match(body, /Nada foi alterado[\s\S]*REMOVIDA e RECRIADA inteira/);
  assert.match(body, /Atual:[\s\S]*Marca = "Adidas"[\s\S]*Marca = "Nike"[\s\S]*Proposta:[\s\S]*ID do item = "SKU-1" — EXCLUÍDO[\s\S]*ID do item = \(outros\)/);
  assert.match(body, /replace: true[\s\S]*histórico por nó fica nos nós antigos/);
  assert.doesNotMatch(body, /lances atuais/, "PMax não tem lance por nó");

  // validateOnly sem replace também não passa do gate
  const dryGated = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: brandTree() } });
  assert.equal((await call(dryGated.client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"], validateOnly: true })).isError, true);
  assert.equal(dryGated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: brandTree() } });
  const result = await call(client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"], replace: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const removed = removes(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.equal(removed.length, 4);
  assert.equal(removed[3], pmaxName("1"), "raiz removida por último");
  const created = creates(calls.writes[0], "assetGroupListingGroupFilterOperation");
  assert.deepEqual(created.map((c) => [c.type, c.caseValue]), [
    ["SUBDIVISION", undefined],
    ["UNIT_EXCLUDED", { productItemId: { value: "SKU-1" } }],
    ["SUBDIVISION", { productItemId: {} }],
    ["UNIT_INCLUDED", { productBrand: { value: "Adidas" } }],
    ["UNIT_INCLUDED", { productBrand: { value: "Nike" } }],
    ["UNIT_EXCLUDED", { productBrand: {} }],
  ]);
  assert.match(textOf(result), /a árvore anterior foi recriada em "outros"/);
});

test("exclude_products: raiz excluída é no-op; asset group com filtros WEBPAGE é recusado sem escrita", async () => {
  const allExcluded = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: [pmaxNode("1", "UNIT_EXCLUDED")] } });
  const noop = await call(allExcluded.client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"] });
  assert.equal(noop.isError, undefined, textOf(noop));
  assert.match(textOf(noop), /Nada a fazer[\s\S]*já exclui todos os produtos/);
  assert.equal(allExcluded.calls.writes.length, 0);

  const webpage = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: webpageOnly() } });
  const refused = await call(webpage.client, "exclude_products", { assetGroupId: AG, itemIds: ["SKU-1"], replace: true });
  assert.equal(refused.isError, true);
  assert.equal(webpage.calls.writes.length, 0);
  assert.match(textOf(refused), /WEBPAGE UNIT_INCLUDED \(URL contém "\/promo"\)[\s\S]*MULTIPLE_LISTING_SOURCES[\s\S]*set_listing_group_filter com replaceOtherSources: true/);
});

test("exclude_products: recusas (sem árvore, item abaixo da raiz, IDs, limite)", async () => {
  const none = fakeClient({ rows: { asset_group: pmaxAssetGroup() } });
  assert.match(textOf(await call(none.client, "exclude_products", { assetGroupId: AG, itemIds: ["A"] })), /não tem árvore/);
  assert.equal(none.calls.writes.length, 0);

  const deeper = [
    pmaxNode("1", "SUBDIVISION"),
    pmaxNode("2", "SUBDIVISION", "1", { productBrand: { value: "Nike" } }),
    pmaxNode("3", "UNIT_EXCLUDED", "2", { productItemId: { value: "X" } }),
    pmaxNode("4", "UNIT_INCLUDED", "2", { productItemId: {} }),
    pmaxNode("5", "UNIT_EXCLUDED", "1", { productBrand: {} }),
  ];
  const deep = fakeClient({ rows: { asset_group: pmaxAssetGroup(), asset_group_listing_group_filter: deeper } });
  assert.match(textOf(await call(deep.client, "exclude_products", { assetGroupId: AG, itemIds: ["A"] })), /já usa ID do item abaixo da raiz/);
  assert.equal(deep.calls.writes.length, 0);

  const ids = fakeClient();
  assert.equal((await call(ids.client, "exclude_products", { assetGroupId: AG, adGroupId: AGR, itemIds: ["A"] })).isError, true);
  assert.equal((await call(ids.client, "exclude_products", { assetGroupId: AG, itemIds: [] })).isError, true);
  assert.equal((await call(ids.client, "exclude_products", { assetGroupId: AG, itemIds: ["a&+b"] })).isError, true);
  assert.match(textOf(await call(ids.client, "exclude_products", { assetGroupId: AG, itemIds: Array.from({ length: 201 }, (_, i) => `S${i}`) })), /até 200/);
  assert.equal(ids.calls.queries.length, 0);
});

// ══ Leitura ════════════════════════════════════════════════════════════

test("get_listing_group_tree (PMax): árvore legível, \"outros\" sem case_value inferido, units reaproveitáveis e métricas", async () => {
  const { client, calls } = fakeClient({
    rows: {
      asset_group_listing_group_filter: subdividedPmaxTree(),
      asset_group_product_group_view: [
        { assetGroupProductGroupView: { assetGroupListingGroupFilter: pmaxName("2") }, metrics: { impressions: "100", clicks: "10", costMicros: "20000000", conversions: 2, conversionsValue: 100 } },
      ],
    },
  });
  const result = await call(client, "get_listing_group_tree", { assetGroupId: AG, includeMetrics: true, days: 30 });
  assert.equal(result.isError, undefined, textOf(result));
  const body = textOf(result);
  assert.match(body, /Marca = "Nike" — INCLUÍDO · 100 impr · 10 cliques · R\$ 20\.00 · 2 conv · ROAS 5/);
  assert.match(body, /Marca = \(outros\) — EXCLUÍDO/);
  assert.doesNotMatch(body, /Outros filtros/);
  const json = JSON.parse(body.slice(body.lastIndexOf("\n[") + 1));
  assert.deepEqual(json[0].units, [
    { path: [{ dimension: "PRODUCT_BRAND", value: "Nike" }] },
    { path: [{ dimension: "PRODUCT_BRAND" }], excluded: true },
  ]);
  assert.ok(calls.queries.some((q) => q.includes("FROM asset_group_product_group_view") && q.includes("DURING LAST_30_DAYS")));
  assert.equal(calls.writes.length, 0);
});

test("get_listing_group_tree (PMax): asset group só com filtros WEBPAGE mostra os filtros e avisa da fonte única", async () => {
  const { client, calls } = fakeClient({ rows: { asset_group_listing_group_filter: webpageOnly() } });
  const result = await call(client, "get_listing_group_tree", { assetGroupId: AG });
  assert.equal(result.isError, undefined, textOf(result));
  const body = textOf(result);
  assert.match(body, /\(sem árvore de produtos\)/);
  assert.match(body, /Outros filtros \(não-produto\): WEBPAGE UNIT_INCLUDED \(URL contém "\/promo"\)[\s\S]*MULTIPLE_LISTING_SOURCES/);
  const json = JSON.parse(body.slice(body.lastIndexOf("\n[") + 1));
  assert.deepEqual(json[0].units, []);
  assert.deepEqual(json[0].other_sources, [{ listing_source: "WEBPAGE", type: "UNIT_INCLUDED", conditions: 'URL contém "/promo"', resource_name: pmaxName("9") }]);
  assert.equal(calls.writes.length, 0);
});

test("get_listing_group_tree: por campanha descobre o tipo; exige exatamente um escopo", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "999", name: "Shopping Loja", advertisingChannelType: "SHOPPING", status: "ENABLED" } }],
      ad_group_criterion: existingStdTree(),
    },
  });
  const result = await call(client, "get_listing_group_tree", { campaignId: "999" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /Grupo 888 "Grupo Shopping"[\s\S]*Marca = "Nike" — INCLUÍDO · lance R\$ 1\.00/);
  assert.ok(calls.queries.some((q) => q.includes("FROM ad_group_criterion") && q.includes("campaign.id = 999")));
  const withMetrics = await call(client, "get_listing_group_tree", { adGroupId: AGR, includeMetrics: true, dateRange: { since: "2026-09-01", until: "2026-09-20" } });
  assert.equal(withMetrics.isError, undefined, textOf(withMetrics));
  assert.ok(calls.queries.some((q) => q.includes("FROM product_group_view") && q.includes("BETWEEN '2026-09-01' AND '2026-09-20'")));

  const none = fakeClient();
  assert.equal((await call(none.client, "get_listing_group_tree", {})).isError, true);
  assert.equal((await call(none.client, "get_listing_group_tree", { assetGroupId: AG, adGroupId: AGR })).isError, true);
  assert.equal(none.calls.queries.length, 0);

  const search = fakeClient({ rows: { campaign: [{ campaign: { id: "1", advertisingChannelType: "SEARCH" } }] } });
  assert.match(textOf(await call(search.client, "get_listing_group_tree", { campaignId: "1" })), /só existe em PMax e Shopping/);
});

test("get_product_group_performance: métricas por grupo rotuladas pelo caminho, só folhas, ordenadas por custo", async () => {
  const metricsRow = (id: string, type: string, cost: number, extra: Row = {}) => ({
    adGroupCriterion: { resourceName: stdName(id), listingGroup: { type }, cpcBidMicros: "1000000", ...extra },
    adGroup: { id: AGR, name: "Grupo Shopping" },
    campaign: { id: "999", name: "Shopping Loja" },
    metrics: { impressions: "50", clicks: "5", costMicros: String(cost), conversions: 1, conversionsValue: 30 },
  });
  const { client, calls } = fakeClient({
    rows: {
      product_group_view: [metricsRow("2", "UNIT", 3_000_000), metricsRow("3", "UNIT", 9_000_000), metricsRow("1", "SUBDIVISION", 12_000_000)],
      ad_group_criterion: existingStdTree(),
    },
  });
  const result = await call(client, "get_product_group_performance", { campaignId: "999", days: 7 });
  assert.equal(result.isError, undefined, textOf(result));
  const body = textOf(result);
  const rows = JSON.parse(body.slice(body.indexOf("[")));
  assert.deepEqual(rows.map((r: Row) => [r.product_group, r.spend]), [["Marca=(outros)", 9], ["Marca=Nike", 3]]);
  assert.equal(rows[0].roas, 3.33);
  assert.ok(calls.queries.some((q) => q.includes("FROM product_group_view") && q.includes("campaign.id = 999") && q.includes("LAST_7_DAYS")));

  const table = await call(client, "get_product_group_performance", { adGroupId: AGR, format: "csv", onlyUnits: false });
  assert.match(textOf(table), /^campaign,ad_group,ad_group_id,product_group,type/);
  assert.match(textOf(table), /Todos os produtos,SUBDIVISÃO/);

  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_product_group_performance", { campaignId: "1; DROP" })).isError, true);
  assert.equal((await call(bad.client, "get_product_group_performance", { dateRange: { since: "2026-1-1", until: "2026-02-01" } })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});
