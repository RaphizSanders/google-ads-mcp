/**
 * Lote conversions-core — ações e metas de conversão.
 *
 * Cobre: conta de conversão (acompanhamento entre contas / MCC) em toda gravação,
 * include_in_conversions_metric traduzido para primary, regras por tipo e checagem do modelo
 * baseado em dados, aviso de meta biddable depois do create, tag de instalação, auditoria,
 * metas da conta / personalizadas / da campanha, e o aviso de desligamento das metas da conta.
 *
 * O client falso valida toda query com os metadados reais da v25 (assertGaqlRules) e aplica
 * os filtros de ID que as tools usam, para que "não encontrado" seja testável.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import {
  CONVERSION_ORIGINS,
  checkConversionTypeRules,
  conversionCategoryV25Schema,
  createConversionCustomerCache,
  explainConversionError,
  parseConversionTracking,
  parseSendTo,
} from "../src/tools/conversions-core.js";
import { catalog } from "../src/tools/conversions-core.catalog.js";
import { CONVERSION_CATEGORY_ALIASES, resolveEnumAlias } from "../src/tool-kit.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "5820067509";
const MCC = "9998887776";
const CAMPAIGN_ID = "24250313718";

// ── Fixtures ──────────────────────────────────────────────────────────

const trackingRow = (conversionCustomer = CID, extra: Row = {}): Row => ({
  customer: {
    id: CID,
    descriptiveName: "Cliente",
    conversionTrackingSetting: {
      googleAdsConversionCustomer: `customers/${conversionCustomer}`,
      conversionTrackingStatus: conversionCustomer === CID ? "CONVERSION_TRACKING_MANAGED_BY_SELF" : "CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER",
      conversionTrackingId: "111222333",
      ...(conversionCustomer === CID ? {} : { crossAccountConversionTrackingId: "444555666" }),
      ...extra,
    },
  },
});

const action = (fields: Row): Row => ({
  conversionAction: {
    id: "1001",
    name: "Compra",
    type: "WEBPAGE",
    category: "PURCHASE",
    origin: "WEBSITE",
    status: "ENABLED",
    primaryForGoal: true,
    ownerCustomer: `customers/${CID}`,
    countingType: "MANY_PER_CLICK",
    attributionModelSettings: { attributionModel: "GOOGLE_ADS_LAST_CLICK", dataDrivenModelStatus: "AVAILABLE" },
    valueSettings: { defaultValue: 1, defaultCurrencyCode: "BRL", alwaysUseDefaultValue: false },
    clickThroughLookbackWindowDays: "30",
    viewThroughLookbackWindowDays: "1",
    ...fields,
  },
});

const accountGoal = (category: string, origin: string, biddable: boolean): Row => ({ customerConversionGoal: { category, origin, biddable } });
const campaignGoal = (category: string, origin: string, biddable: boolean): Row => ({
  campaign: { id: CAMPAIGN_ID }, campaignConversionGoal: { category, origin, biddable },
});
const configRow = (level: string, customGoal = "", campaign: Row = {}): Row => ({
  campaign: { id: CAMPAIGN_ID, name: "PMax Loja", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", ...campaign },
  conversionGoalCampaignConfig: { goalConfigLevel: level, ...(customGoal ? { customConversionGoal: customGoal } : {}) },
});
const customGoalRow = (id: string, name: string, actionIds: string[], owner = CID, status = "ENABLED"): Row => ({
  customConversionGoal: {
    id, name, status, resourceName: `customers/${owner}/customConversionGoals/${id}`,
    conversionActions: actionIds.map((a) => `customers/${owner}/conversionActions/${a}`),
  },
});

const WEBPAGE_SNIPPETS = [
  {
    type: "WEBPAGE", pageFormat: "HTML",
    globalSiteTag: "<script async src=\"https://www.googletagmanager.com/gtag/js?id=AW-111222333\"></script>",
    eventSnippet: "<script>gtag('event', 'conversion', {'send_to': 'AW-111222333/AbC-d_12', 'transaction_id': ''});</script>",
  },
  {
    type: "WEBPAGE_ONCLICK", pageFormat: "HTML",
    globalSiteTag: "<script>gtag('config','AW-111222333');</script>",
    eventSnippet: "<script>function gtag_report_conversion(url){gtag('event','conversion',{'send_to':'AW-111222333/Click_9'});}</script>",
  },
];

// ── Client falso ──────────────────────────────────────────────────────

type Data = Record<string, Row[]>; // "cid:from" ou "*:from"

interface FakeOptions {
  data?: Data;
  dryRun?: boolean;
  mutate?: (cid: string, resource: string, operations: Row[]) => Row;
}

function filterRows(from: string, query: string, rows: Row[]): Row[] {
  const idOf = (row: Row, key: string) => String(((row[key] ?? {}) as Row).id ?? "");
  const byId = (key: string, field: string) => {
    const single = new RegExp(`${field}\\s*=\\s*(\\d+)`).exec(query);
    const list = new RegExp(`${field}\\s+IN\\s*\\(([^)]*)\\)`).exec(query);
    if (single) return rows.filter((row) => idOf(row, key) === single[1]);
    if (list) {
      const ids = list[1].split(",").map((s) => s.trim());
      return rows.filter((row) => ids.includes(idOf(row, key)));
    }
    return rows;
  };
  if (from === "conversion_action") {
    const name = /conversion_action\.name = '((?:\\.|[^'\\])*)'/.exec(query);
    const filtered = byId("conversionAction", "conversion_action\\.id");
    return name ? filtered.filter((row) => ((row.conversionAction ?? {}) as Row).name === name[1].replace(/\\(.)/g, "$1")) : filtered;
  }
  if (from === "custom_conversion_goal") return byId("customConversionGoal", "custom_conversion_goal\\.id");
  if (from === "customer_conversion_goal") {
    const cat = /customer_conversion_goal\.category = '([A-Z_]+)'/.exec(query)?.[1];
    const origin = /customer_conversion_goal\.origin = '([A-Z_]+)'/.exec(query)?.[1];
    return rows.filter((row) => {
      const g = (row.customerConversionGoal ?? {}) as Row;
      return (!cat || g.category === cat) && (!origin || g.origin === origin);
    });
  }
  if (from === "conversion_goal_campaign_config" && /custom_conversion_goal = '/.test(query)) {
    const rn = /custom_conversion_goal = '([^']+)'/.exec(query)?.[1];
    return rows.filter((row) => ((row.conversionGoalCampaignConfig ?? {}) as Row).customConversionGoal === rn);
  }
  return rows;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ cid: string; query: string }>,
    writes: [] as Array<{ cid: string; resource: string; operations: Row[]; options?: Row }>,
    currency: [] as string[],
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(customerId: string, query: string): Promise<Row[]> {
      const cid = customerId.replace(/-/g, "");
      calls.queries.push({ cid, query });
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const rows = opts.data?.[`${cid}:${from}`] ?? opts.data?.[`*:${from}`] ?? [];
      return filterRows(from, query, rows);
    },
    async getAccountCurrency(customerId: string) {
      calls.currency.push(customerId);
      return "BRL";
    },
    async mutate(customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      const cid = customerId.replace(/-/g, "");
      calls.writes.push({ cid, resource, operations, options });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(cid, resource, operations);
      if (dryRun) return {};
      return { results: operations.map((_, i) => ({ resourceName: `customers/${cid}/${resource}/${900 + i}` })) };
    },
    async mutateCampaignConversionGoals(customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ cid: customerId, resource: "campaignConversionGoals", operations });
      return dryRun ? {} : { results: operations.map(() => ({ resourceName: "g" })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, allowed: string[] = []) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  registerGoogleAdsTools(
    { registerTool: (name: string, config: Row, handler: Handler) => { handlers.set(name, handler); configs.set(name, config); } } as never,
    () => client as never,
    allowed,
    allowed.length > 0
  );
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row, allowed: string[] = []) =>
  register(client, allowed).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonTail(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

const NEW_TOOLS = [...catalog.read, ...catalog.write];

// ── Enums e regras puras ─────────────────────────────────────────────

// Ground truth: google/ads/googleads/v25/enums/conversion_action_category.proto
const V25_CATEGORIES = new Set([
  "DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART", "BEGIN_CHECKOUT",
  "SUBSCRIBE_PAID", "PHONE_CALL_LEAD", "IMPORTED_LEAD", "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT",
  "REQUEST_QUOTE", "GET_DIRECTIONS", "OUTBOUND_CLICK", "CONTACT", "ENGAGEMENT", "STORE_VISIT",
  "STORE_SALE", "QUALIFIED_LEAD", "CONVERTED_LEAD", "YOUTUBE_FOLLOW_ON_VIEWS",
]);

test("enums: categorias v25 completas (com YOUTUBE_FOLLOW_ON_VIEWS) e origens do proto", () => {
  const sent = new Set(conversionCategoryV25Schema.options.map((c) => resolveEnumAlias(c, CONVERSION_CATEGORY_ALIASES)));
  assert.deepEqual([...sent].sort(), [...V25_CATEGORIES].sort());
  assert.deepEqual([...CONVERSION_ORIGINS].sort(), ["APP", "CALL_FROM_ADS", "GOOGLE_HOSTED", "LOCAL_SERVICES_ADS", "STORE", "WEBSITE", "YOUTUBE_HOSTED"]);
});

test("regras por tipo: valor fixo e janelas de chamada, duração só em chamada", () => {
  assert.match(checkConversionTypeRules("WEBSITE_CALL", { alwaysUseDefaultValue: false }).errors.join(), /alwaysUseDefaultValue=true/);
  assert.match(checkConversionTypeRules("AD_CALL", { viewThroughLookbackWindowDays: 1 }).errors.join(), /VALUE_MUST_BE_UNSET/);
  assert.deepEqual(checkConversionTypeRules("AD_CALL", { clickThroughLookbackWindowDays: 60 }).errors, []);
  assert.match(checkConversionTypeRules("AD_CALL", { clickThroughLookbackWindowDays: 61 }).errors.join(), /1 a 60/);
  assert.match(checkConversionTypeRules("WEBPAGE", { clickThroughLookbackWindowDays: 91 }).errors.join(), /1 a 90/);
  assert.match(checkConversionTypeRules("WEBPAGE", { clickThroughLookbackWindowDays: 60 }).warnings.join(), /\[1,30\]/);
  assert.match(checkConversionTypeRules("WEBPAGE", { viewThroughLookbackWindowDays: 31 }).errors.join(), /1 a 30/);
  assert.match(checkConversionTypeRules("WEBPAGE", { phoneCallDurationSeconds: 60 }).errors.join(), /só vale para ações de chamada/);
  assert.match(checkConversionTypeRules("WEBSITE_CALL", { phoneCallDurationSeconds: 10001 }).errors.join(), /0 a 10000/);
  assert.deepEqual(checkConversionTypeRules("WEBSITE_CALL", { phoneCallDurationSeconds: 60, alwaysUseDefaultValue: true }).errors, []);
});

test("send_to: separa ID de conversão e rótulo", () => {
  assert.deepEqual(parseSendTo(String(WEBPAGE_SNIPPETS[0].eventSnippet)), {
    send_to: "AW-111222333/AbC-d_12", conversion_id: "AW-111222333", conversion_label: "AbC-d_12",
  });
  assert.equal(parseSendTo("<script>nada</script>"), null);
});

test("erros da API viram explicação em PT-BR", () => {
  assert.match(explainConversionError("Google Ads API: x — The attribution model cannot be set to DATA_DRIVEN because a data-driven model has never been generated."), /nunca foi gerado/);
  assert.match(explainConversionError("Google Ads API: Request contains an invalid argument. — The field cannot be modified. [IMMUTABLE_FIELD]"), /primary_for_goal/);
  assert.equal(explainConversionError("algo sem dica"), "algo sem dica");
});

test("conta de conversão: parse e cache por sessão (uma leitura, refresh sob pedido)", async () => {
  const info = parseConversionTracking(CID, trackingRow(MCC));
  assert.equal(info.conversionCustomerId, MCC);
  assert.equal(info.crossAccount, true);
  assert.equal(info.acceptedCustomerDataTerms, false, "bool omitido no JSON = false");
  assert.equal(parseConversionTracking(CID, undefined).conversionCustomerId, CID, "sem configuração = a própria conta");

  const { client, calls } = fakeClient({ data: { [`${CID}:customer`]: [trackingRow(MCC)] } });
  const cache = createConversionCustomerCache();
  await cache.get(client as never, CID);
  await cache.get(client as never, "582-006-7509");
  assert.equal(calls.queries.length, 1);
  await cache.get(client as never, CID, true);
  assert.equal(calls.queries.length, 2);
});

test("catálogo: tools novas classificadas e só as de escrita ganham validateOnly", () => {
  const { handlers, configs } = register(fakeClient().client);
  for (const name of catalog.read) {
    assert.ok(handlers.has(name), name);
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name as never));
    assert.ok(!("validateOnly" in (configs.get(name)!.inputSchema as Row)));
  }
  for (const name of catalog.write) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name as never));
    assert.ok("validateOnly" in (configs.get(name)!.inputSchema as Row), `${name} sem validateOnly`);
  }
  for (const name of ["list_conversion_actions", "create_conversion_action", "update_conversion_action", "set_campaign_conversion_goals"]) {
    assert.ok(handlers.has(name), `${name} continua registrada`);
  }
  assert.equal(catalog.chained.length, 0);
});

test("allowlist: toda tool nova recusa conta fora do ALLOWED_CUSTOMER_IDS sem chamar a API", async () => {
  for (const name of NEW_TOOLS) {
    const { client, calls } = fakeClient();
    const result = await call(client, name, {}, ["1111111111"]);
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Access denied/);
    assert.equal(calls.queries.length + calls.writes.length, 0, name);
  }
});

// ── list_conversion_actions ──────────────────────────────────────────

test("list_conversion_actions: devolve origem, dona, atribuição e GA4; omite REMOVED por padrão", async () => {
  const { client, calls } = fakeClient({
    data: {
      [`${CID}:customer`]: [trackingRow(MCC)],
      [`${CID}:conversion_action`]: [action({ ownerCustomer: `customers/${MCC}`, googleAnalytics4Settings: { propertyId: "123", propertyName: "Loja", eventName: "purchase" } })],
    },
  });
  const result = await call(client, "list_conversion_actions", {});
  const query = calls.queries.find((q) => /FROM conversion_action/.test(q.query))!.query;
  for (const field of ["conversion_action.owner_customer", "conversion_action.origin", "conversion_action.include_in_conversions_metric", "attribution_model_settings.data_driven_model_status", "google_analytics_4_settings.property_id"]) {
    assert.match(query, new RegExp(field.replace(/\./g, "\\.")));
  }
  assert.match(query, /conversion_action\.status != 'REMOVED'/);
  const body = textOf(result);
  assert.match(body, /"owner_customer_id": "9998887776"/);
  assert.match(body, /"ga4_property": "Loja \(123\)"/);
  assert.match(body, /1 ação\(ões\) pertencem a outra conta/);
  assert.match(body, /Conta de conversão: 9998887776/);
});

// ── create_conversion_action ─────────────────────────────────────────

function createData(extra: Data = {}): Data {
  return {
    [`${CID}:customer`]: [trackingRow()],
    [`*:customer_conversion_goal`]: [accountGoal("PURCHASE", "WEBSITE", true)],
    [`*:conversion_action`]: [action({ id: "900", name: "Lead", category: "SUBMIT_LEAD_FORM", tagSnippets: WEBPAGE_SNIPPETS })],
    ...extra,
  };
}

test("create: payload sem include_in_conversions_metric, tag e aviso de meta nova biddable", async () => {
  const { client, calls } = fakeClient({
    data: createData({ [`*:customer_conversion_goal`]: [accountGoal("PURCHASE", "WEBSITE", true)] }),
  });
  // a meta SUBMIT_LEAD_FORM~WEBSITE "aparece" depois da criação
  let created = false;
  const original = (client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(client);
  client.searchStream = async (c: string, q: string) => {
    if (created && /FROM customer_conversion_goal WHERE/.test(q)) {
      calls.queries.push({ cid: c, query: q });
      assertGaqlRules(q);
      return [accountGoal("SUBMIT_LEAD_FORM", "WEBSITE", true)];
    }
    if (/FROM conversion_action\s+WHERE conversion_action\.name/.test(q)) {
      calls.queries.push({ cid: c, query: q });
      assertGaqlRules(q);
      return [];
    }
    return original(c, q);
  };
  const mutate = client.mutate as (...a: unknown[]) => Promise<Row>;
  client.mutate = async (...args: unknown[]) => { created = true; return mutate(...args); };

  const result = await call(client, "create_conversion_action", {
    name: "  Lead ", type: "WEBPAGE", category: "LEAD", includeInConversionsMetric: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes.find((w) => w.resource === "conversionActions")!;
  assert.equal(write.cid, CID);
  const payload = write.operations[0].create as Row;
  assert.equal(payload.name, "Lead");
  assert.equal(payload.category, "SUBMIT_LEAD_FORM");
  assert.equal(payload.primaryForGoal, true);
  assert.ok(!("includeInConversionsMetric" in payload), "a API recusa include_in_conversions_metric (IMMUTABLE_FIELD)");
  assert.deepEqual(payload.attributionModelSettings, { attributionModel: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN" });
  const body = textOf(result);
  assert.match(body, /traduzido para primary=true/);
  assert.match(body, /A API criou a meta da conta SUBMIT_LEAD_FORM \(WEBSITE\) com biddable=true/);
  assert.match(body, /"conversion_id": "AW-111222333"/);
  assert.match(body, /"conversion_label": "AbC-d_12"/);
  assert.match(body, /Conta usada: 5820067509/);
});

test("create: acompanhamento entre contas cria na MCC; fora do allowlist é recusado sem gravar", async () => {
  const data = createData({ [`${CID}:customer`]: [trackingRow(MCC)] });
  const cross = fakeClient({ data });
  const result = await call(cross.client, "create_conversion_action", { name: "Compra", type: "WEBPAGE", category: "PURCHASE", valueSetting: { defaultValue: 10 } });
  const write = cross.calls.writes.find((w) => w.resource === "conversionActions")!;
  assert.equal(write.cid, MCC);
  assert.deepEqual(cross.calls.currency, [MCC], "moeda da conta dona da ação");
  assert.match(textOf(result), /Conta usada: 9998887776 \(conta de conversão de 5820067509\)/);
  assert.ok(cross.calls.queries.some((q) => q.cid === MCC && /conversion_action\.name = 'Compra'/.test(q.query)), "checa nome duplicado na MCC");

  const blocked = fakeClient({ data });
  const refused = await call(blocked.client, "create_conversion_action", { name: "Compra", type: "WEBPAGE", category: "PURCHASE" }, [CID]);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /9998887776 não está em ALLOWED_CUSTOMER_IDS/);
  assert.equal(blocked.calls.writes.length, 0);
});

test("create: micro-conversão nasce secundária; primary explícito vence", async () => {
  const a = fakeClient({ data: createData() });
  const r1 = await call(a.client, "create_conversion_action", { name: "Carrinho", type: "WEBPAGE", category: "ADD_TO_CART" });
  assert.equal((a.calls.writes[0].operations[0].create as Row).primaryForGoal, false);
  assert.match(textOf(r1), /micro-conversão: criada como SECUNDÁRIA/);

  const b = fakeClient({ data: createData() });
  await call(b.client, "create_conversion_action", { name: "Carrinho", type: "WEBPAGE", category: "ADD_TO_CART", primary: true });
  assert.equal((b.calls.writes[0].operations[0].create as Row).primaryForGoal, true);
});

test("create: regras por tipo e conflito include × primary recusados antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ type: "WEBSITE_CALL", valueSetting: { alwaysUseDefaultValue: false } }, /alwaysUseDefaultValue=true/],
    [{ type: "AD_CALL", viewThroughLookbackWindowDays: 1 }, /VALUE_MUST_BE_UNSET/],
    [{ type: "AD_CALL", clickThroughLookbackWindowDays: 90 }, /1 a 60/],
    [{ type: "WEBPAGE", phoneCallDurationSeconds: 30 }, /só vale para ações de chamada/],
    [{ type: "WEBPAGE", primary: true, includeInConversionsMetric: false }, /divergem/],
    [{ type: "WEBPAGE", name: "   " }, /name não pode ser vazio/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient({ data: createData() });
    const result = await call(client, "create_conversion_action", { name: "X", category: "PHONE_CALL_LEAD", ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length + calls.writes.length, 0, `nenhuma chamada para ${JSON.stringify(args)}`);
  }
});

test("create: chamada do site sempre com valor fixo; nome duplicado não grava", async () => {
  const call1 = fakeClient({ data: createData() });
  await call(call1.client, "create_conversion_action", { name: "Ligação", type: "PHONE_CALL", category: "PHONE_CALL_LEAD", phoneCallDurationSeconds: 60 });
  const payload = call1.calls.writes[0].operations[0].create as Row;
  assert.equal(payload.type, "WEBSITE_CALL");
  assert.deepEqual(payload.valueSettings, { defaultValue: 0, alwaysUseDefaultValue: true, defaultCurrencyCode: "BRL" });
  assert.equal(payload.phoneCallDurationSeconds, "60");

  const dup = fakeClient({ data: createData() });
  const result = await call(dup.client, "create_conversion_action", { name: "Lead", type: "WEBPAGE", category: "SUBMIT_LEAD_FORM" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Já existe a ação "Lead" \(id 900/);
  assert.equal(dup.calls.writes.length, 0);
});

test("create: dry-run não relê nada e diz que não gravou; erro da API vem explicado", async () => {
  const dry = fakeClient({ data: createData(), dryRun: true });
  const result = await call(dry.client, "create_conversion_action", { name: "Nova", type: "WEBPAGE", category: "PURCHASE" });
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.ok(!dry.calls.queries.some((q) => /tag_snippets/.test(q.query)), "sem leitura pós-criação em dry-run");

  const failing = fakeClient({
    data: createData(),
    mutate: () => { throw new Error("Google Ads API: invalid — The attribution model cannot be set to DATA_DRIVEN because the data-driven model is unavailable or the conversion action was newly added."); },
  });
  const err = await call(failing.client, "create_conversion_action", { name: "Nova", type: "WEBPAGE", category: "PURCHASE" });
  assert.equal(err.isError, true);
  assert.match(textOf(err), /Use LAST_CLICK por enquanto/);
});

test("create: validateOnly por chamada roda em dry-run e avisa no topo", async () => {
  const { client, calls } = fakeClient({ data: createData() });
  const result = await call(client, "create_conversion_action", { name: "Nova", type: "WEBPAGE", category: "PURCHASE", validateOnly: true });
  assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(result), /nada foi gravado/);
  assert.equal(calls.writes.length, 1);
});

// ── update_conversion_action ─────────────────────────────────────────

function updateData(fields: Row = {}, conversionCustomer = CID): Data {
  return {
    [`${CID}:customer`]: [trackingRow(conversionCustomer)],
    [`*:conversion_action`]: [action(fields)],
    [`*:customer_conversion_goal`]: [accountGoal("SUBMIT_LEAD_FORM", "WEBSITE", false)],
  };
}

test("update: grava na conta dona (MCC), só o que muda, e include vira primary", async () => {
  const { client, calls } = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const result = await call(client, "update_conversion_action", {
    conversionActionId: "1001", includeInConversionsMetric: false, name: "Compra", countingType: "MANY_PER_CLICK", clickThroughLookbackWindowDays: 15,
    confirm: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.cid, MCC);
  const op = write.operations[0] as { update: Row; updateMask: string };
  assert.equal(op.update.resourceName, `customers/${MCC}/conversionActions/1001`);
  assert.equal(op.updateMask, "primary_for_goal,click_through_lookback_window_days");
  assert.equal(op.update.primaryForGoal, false);
  assert.ok(!("includeInConversionsMetric" in op.update));
  const body = textOf(result);
  assert.match(body, /primary_for_goal: true → false/);
  assert.match(body, /Sem mudança: name, counting_type/);
  assert.match(body, /Conta usada: 9998887776 \(dona da ação/);
  assert.match(body, /Ação compartilhada: pertence à conta 9998887776/);
  assert.match(body, /TODAS as contas que usam 9998887776 como conta de conversão, não só 5820067509/);
});

test("update: ação da MCC (compartilhada) sem confirm só mostra a prévia, com a conta dona e o alcance", async () => {
  const { client, calls } = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const result = await call(client, "update_conversion_action", { conversionActionId: "1001", includeInConversionsMetric: false });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 0);
  const body = textOf(result);
  assert.match(body, /^Prévia — nada foi gravado\. Ação 1001 \("Compra"; PURCHASE; primária; ENABLED\) na conta 9998887776/);
  assert.match(body, /primary_for_goal: true → false/);
  assert.match(body, /Ação compartilhada: pertence à conta 9998887776 \(a conta de conversão de 5820067509/);
  assert.match(body, /TODAS as contas que usam 9998887776 como conta de conversão/);
  assert.match(body, /Envie confirm: true/);
  assert.doesNotMatch(body, /atualizada/);

  // validateOnly também passa pelo gate: sem confirm não chega à API
  const dry = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const r2 = await call(dry.client, "update_conversion_action", { conversionActionId: "1001", name: "Compra MCC", validateOnly: true });
  assert.equal(r2.isError, true);
  assert.equal(dry.calls.writes.length, 0);
  const dryOk = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const r3 = await call(dryOk.client, "update_conversion_action", { conversionActionId: "1001", name: "Compra MCC", validateOnly: true, confirm: true });
  assert.equal(dryOk.calls.writes.length, 1);
  assert.match(textOf(r3), /DRY-RUN \(validateOnly\): atualização da ação 1001 validada, nada foi gravado/);
  assert.doesNotMatch(textOf(r3), /Gravado/);

  // Consultando a própria MCC (dona = conta consultada): continua compartilhada
  const managerTracking: Row = {
    customer: {
      id: MCC, descriptiveName: "MCC", manager: true,
      conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${MCC}`, conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF" },
    },
  };
  const own = fakeClient({ data: { [`${MCC}:customer`]: [managerTracking], [`*:conversion_action`]: [action({ ownerCustomer: `customers/${MCC}` })] } });
  const r4 = await call(own.client, "update_conversion_action", { customerId: MCC, conversionActionId: "1001", countingType: "ONE_PER_CLICK" });
  assert.equal(r4.isError, true);
  assert.equal(own.calls.writes.length, 0);
  assert.match(textOf(r4), /Ação compartilhada: pertence à MCC 9998887776/);

  // Ação só da conta (não MCC): edição comum não pede confirm
  const local = fakeClient({ data: updateData() });
  const r5 = await call(local.client, "update_conversion_action", { conversionActionId: "1001", name: "Compra site" });
  assert.equal(r5.isError, undefined, textOf(r5));
  assert.equal(local.calls.writes.length, 1);
  assert.doesNotMatch(textOf(r5), /compartilhada/);
});

test("update: sem mudança não grava; ação inexistente ou do sistema é recusada", async () => {
  const noop = fakeClient({ data: updateData() });
  const r1 = await call(noop.client, "update_conversion_action", { conversionActionId: "1001", primary: true, countingType: "MANY_PER_CLICK" });
  assert.match(textOf(r1), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const missing = fakeClient({ data: updateData() });
  const r2 = await call(missing.client, "update_conversion_action", { conversionActionId: "4242", name: "X" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não existe na conta/);

  const system = fakeClient({ data: updateData({ ownerCustomer: undefined }) });
  const r3 = await call(system.client, "update_conversion_action", { conversionActionId: "1001", name: "X" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /definida pelo sistema/);
  assert.equal(missing.calls.writes.length + system.calls.writes.length, 0);
});

test("update: DATA_DRIVEN só com modelo AVAILABLE", async () => {
  for (const status of ["STALE", "EXPIRED", "NEVER_GENERATED", undefined]) {
    const { client, calls } = fakeClient({ data: updateData({ attributionModelSettings: { attributionModel: "GOOGLE_ADS_LAST_CLICK", ...(status ? { dataDrivenModelStatus: status } : {}) } }) });
    const result = await call(client, "update_conversion_action", { conversionActionId: "1001", attributionModel: "DATA_DRIVEN" });
    assert.equal(result.isError, true, String(status));
    assert.match(textOf(result), /só aceita DATA_DRIVEN com AVAILABLE/);
    assert.equal(calls.writes.length, 0);
  }
  const ok = fakeClient({ data: updateData() });
  await call(ok.client, "update_conversion_action", { conversionActionId: "1001", attributionModel: "DATA_DRIVEN" });
  const op = ok.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "attribution_model_settings.attribution_model");
  assert.deepEqual(op.update.attributionModelSettings, { attributionModel: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN" });
});

test("update: REMOVED exige confirm; regras usam o tipo atual da ação", async () => {
  const gate = fakeClient({ data: updateData() });
  const r1 = await call(gate.client, "update_conversion_action", { conversionActionId: "1001", status: "REMOVED" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  assert.match(textOf(r1), /status ENABLED → REMOVED: remove a ação/);
  assert.equal(gate.calls.writes.length, 0);

  const confirmed = fakeClient({ data: updateData() });
  await call(confirmed.client, "update_conversion_action", { conversionActionId: "1001", status: "REMOVED", confirm: true });
  assert.equal((confirmed.calls.writes[0].operations[0] as Row).updateMask, "status");

  const adCall = fakeClient({ data: updateData({ type: "AD_CALL", category: "PHONE_CALL_LEAD", origin: "CALL_FROM_ADS" }) });
  const r3 = await call(adCall.client, "update_conversion_action", { conversionActionId: "1001", viewThroughLookbackWindowDays: 3 });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /AD_CALL.*VALUE_MUST_BE_UNSET/);
  assert.equal(adCall.calls.writes.length, 0);
});

test("update: HIDDEN para de registrar e some da interface — exige confirm como REMOVED", async () => {
  const gate = fakeClient({ data: updateData() });
  const r1 = await call(gate.client, "update_conversion_action", { conversionActionId: "1001", status: "HIDDEN" });
  assert.equal(r1.isError, true);
  assert.equal(gate.calls.writes.length, 0);
  const body = textOf(r1);
  assert.match(body, /^Prévia — nada foi gravado/);
  assert.match(body, /status ENABLED → HIDDEN: a ação para de registrar conversões/);
  assert.match(body, /some da interface do Google Ads/);
  assert.match(body, /A ação é PRIMÁRIA \(PURCHASE\)/);
  assert.match(body, /Envie confirm: true/);

  const confirmed = fakeClient({ data: updateData() });
  const r2 = await call(confirmed.client, "update_conversion_action", { conversionActionId: "1001", status: "HIDDEN", confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  const op = confirmed.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "status");
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/conversionActions/1001`, status: "HIDDEN" });
  assert.match(textOf(r2), /status: ENABLED → HIDDEN/);

  // HIDDEN numa ação da MCC: a prévia avisa as duas coisas
  const shared = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const r3 = await call(shared.client, "update_conversion_action", { conversionActionId: "1001", status: "HIDDEN" });
  assert.equal(shared.calls.writes.length, 0);
  assert.match(textOf(r3), /some da interface[\s\S]*TODAS as contas que usam 9998887776/);

  // já HIDDEN: no-op sem confirm e sem escrita; reativar (ENABLED) não é bloqueado
  const noop = fakeClient({ data: updateData({ status: "HIDDEN" }) });
  const r4 = await call(noop.client, "update_conversion_action", { conversionActionId: "1001", status: "HIDDEN" });
  assert.equal(r4.isError, undefined);
  assert.match(textOf(r4), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);
  const enable = fakeClient({ data: updateData({ status: "HIDDEN" }) });
  await call(enable.client, "update_conversion_action", { conversionActionId: "1001", status: "ENABLED" });
  assert.equal((enable.calls.writes[0].operations[0] as Row).updateMask, "status");
});

test("update: valor padrão não troca a moeda existente; dona fora do allowlist é recusada", async () => {
  const value = fakeClient({ data: updateData() });
  await call(value.client, "update_conversion_action", { conversionActionId: "1001", valueSetting: { defaultValue: 5 } });
  const op = value.calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "value_settings.default_value");
  assert.deepEqual(op.update.valueSettings, { defaultValue: 5 });

  const blocked = fakeClient({ data: updateData({ ownerCustomer: `customers/${MCC}` }, MCC) });
  const r = await call(blocked.client, "update_conversion_action", { conversionActionId: "1001", name: "Outra" }, [CID]);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /não está em ALLOWED_CUSTOMER_IDS/);
  assert.equal(blocked.calls.writes.length, 0);
});

test("update: troca de categoria informa a meta da conta da nova categoria", async () => {
  const { client } = fakeClient({ data: updateData() });
  const result = await call(client, "update_conversion_action", { conversionActionId: "1001", category: "LEAD" });
  assert.match(textOf(result), /meta da conta SUBMIT_LEAD_FORM \(WEBSITE\) está sem lance/);
});

// ── get_conversion_tag ───────────────────────────────────────────────

test("get_conversion_tag: ID/rótulo para o GTM, passos de compra e gatilho de clique", async () => {
  const data = { [`${CID}:customer`]: [trackingRow()], [`*:conversion_action`]: [action({ tagSnippets: WEBPAGE_SNIPPETS })] };
  const { client } = fakeClient({ data });
  const view = jsonTail(await call(client, "get_conversion_tag", { conversionActionId: "1001" }));
  assert.equal(view.send_to, "AW-111222333/AbC-d_12");
  assert.deepEqual(view.gtm, { id_de_conversao: "111222333", rotulo_de_conversao: "AbC-d_12" });
  assert.match((view.instalacao as string[]).join("\n"), /transaction_id/);

  const click = jsonTail(await call(fakeClient({ data }).client, "get_conversion_tag", { conversionActionId: "1001", trigger: "CLICK" }));
  assert.equal(click.conversion_label, "Click_9");
});

test("get_conversion_tag: ID diferente do da conta é avisado; importação não tem tag", async () => {
  const mismatch = fakeClient({ data: { [`${CID}:customer`]: [trackingRow(MCC)], [`*:conversion_action`]: [action({ tagSnippets: WEBPAGE_SNIPPETS })] } });
  assert.match(textOf(await call(mismatch.client, "get_conversion_tag", { conversionActionId: "1001" })), /difere do ID de conversão em uso na conta \(AW-444555666\)/);

  const upload = fakeClient({ data: { [`*:conversion_action`]: [action({ type: "UPLOAD_CLICKS" })] } });
  const r = await call(upload.client, "get_conversion_tag", { conversionActionId: "1001" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /conversões importadas/);

  const bad = fakeClient();
  const r2 = await call(bad.client, "get_conversion_tag", { conversionActionId: "10 OR 1=1" });
  assert.equal(r2.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ── get_conversion_tracking_settings ─────────────────────────────────

test("get_conversion_tracking_settings: conta de conversão, ID em uso e allowlist", async () => {
  const { client } = fakeClient({ data: { [`${CID}:customer`]: [trackingRow(MCC, { enhancedConversionsForLeadsEnabled: true })] } });
  const result = await call(client, "get_conversion_tracking_settings", {}, [CID]);
  const view = jsonTail(result);
  assert.equal(view.conta_de_conversao, MCC);
  assert.equal(view.id_de_conversao_em_uso, "AW-444555666");
  assert.equal(view.conta_de_conversao_liberada_no_allowlist, false);
  assert.equal(view.enhanced_conversions_for_leads_enabled, true);
  assert.match(textOf(result), /criar\/editar conversões e metas da conta será recusado/);
});

// ── list_conversion_goals ────────────────────────────────────────────

test("list_conversion_goals: metas da conta na MCC e ações que guiam o lance por nível", async () => {
  const actions = [
    action({ id: "1", name: "Compra site", category: "PURCHASE" }),
    action({ id: "2", name: "Compra GA4", category: "PURCHASE", primaryForGoal: false }),
    action({ id: "3", name: "Lead", category: "SUBMIT_LEAD_FORM" }),
    action({ id: "4", name: "Compra aprovada", category: "PURCHASE", type: "UPLOAD_CLICKS", primaryForGoal: false }),
  ];
  const { client, calls } = fakeClient({
    data: {
      [`${CID}:customer`]: [trackingRow(MCC)],
      [`${MCC}:customer_conversion_goal`]: [accountGoal("PURCHASE", "WEBSITE", true), accountGoal("SUBMIT_LEAD_FORM", "WEBSITE", false)],
      [`${CID}:conversion_action`]: actions,
      [`${MCC}:custom_conversion_goal`]: [customGoalRow("77", "Só aprovada", ["4"], MCC)],
      [`${CID}:conversion_goal_campaign_config`]: [
        configRow("CUSTOMER"),
        configRow("CAMPAIGN", "", { id: "2", name: "Busca" }),
        configRow("CAMPAIGN", `customers/${MCC}/customConversionGoals/77`, { id: "3", name: "PMax aprovada" }),
      ],
      [`${CID}:campaign_conversion_goal`]: [
        { campaign: { id: "2" }, campaignConversionGoal: { category: "SUBMIT_LEAD_FORM", origin: "WEBSITE", biddable: true } },
        { campaign: { id: "2" }, campaignConversionGoal: { category: "PURCHASE", origin: "WEBSITE", biddable: false } },
      ],
    },
  });
  const view = jsonTail(await call(client, "list_conversion_goals", {}));
  assert.ok(calls.queries.some((q) => q.cid === MCC && /FROM customer_conversion_goal/.test(q.query)));
  const campaigns = view.campanhas as Array<Row>;
  const byId = new Map(campaigns.map((c) => [c.campaign_id, c]));
  assert.deepEqual(byId.get(CAMPAIGN_ID)!.acoes_que_guiam_o_lance, ["Compra site"], "CUSTOMER: meta PURCHASE biddable, só a primária");
  assert.deepEqual(byId.get("2")!.acoes_que_guiam_o_lance, ["Lead"], "CAMPAIGN: metas próprias");
  assert.deepEqual(byId.get("3")!.acoes_que_guiam_o_lance, ["Compra aprovada"], "meta personalizada vale mesmo secundária");
  assert.deepEqual((view.metas_da_conta as Row[])[0].acoes_secundarias, ["Compra GA4", "Compra aprovada"]);
});

test("list_conversion_goals: MCC fora do allowlist lê na conta cliente e avisa", async () => {
  const { client, calls } = fakeClient({ data: { [`${CID}:customer`]: [trackingRow(MCC)] } });
  const result = await call(client, "list_conversion_goals", { campaignId: CAMPAIGN_ID }, [CID]);
  assert.ok(calls.queries.every((q) => q.cid === CID));
  assert.match(textOf(result), /fora de ALLOWED_CUSTOMER_IDS/);
  assert.ok(calls.queries.some((q) => /campaign\.id = 24250313718/.test(q.query)));
});

test("list_conversion_goals: leitura na MCC recusada pela API cai para a conta cliente com aviso", async () => {
  const { client, calls } = fakeClient({
    data: { [`${CID}:customer`]: [trackingRow(MCC)], [`${CID}:customer_conversion_goal`]: [accountGoal("PURCHASE", "WEBSITE", true)] },
  });
  const original = (client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(client);
  client.searchStream = async (c: string, q: string) => {
    if (c === MCC) throw new Error("Google Ads API: The caller does not have permission — USER_PERMISSION_DENIED");
    return original(c, q);
  };
  const result = await call(client, "list_conversion_goals", {});
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /Leitura na conta de conversão 9998887776 falhou/);
  assert.equal((jsonTail(result).metas_da_conta as Row[]).length, 1);
  assert.equal(jsonTail(result).metas_da_conta_lidas_em, CID);
  assert.ok(calls.queries.every((q) => q.cid === CID));
});

// ── audit_conversion_tracking ────────────────────────────────────────

test("audit: aponta contagem dupla, primária zerada, compra sem valor, DDA, micro, ECL, termos e GA4 oculto", async () => {
  const old = "2026-01-01 10:00:00";
  const { client, calls } = fakeClient({
    data: {
      [`${CID}:customer`]: [trackingRow(CID, { acceptedCustomerDataTerms: false })],
      [`${CID}:conversion_action`]: [
        action({ id: "1", name: "Compra tag", countingType: "ONE_PER_CLICK", attributionModelSettings: { attributionModel: "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN", dataDrivenModelStatus: "STALE" } }),
        action({ id: "2", name: "Compra GA4", type: "GOOGLE_ANALYTICS_4_PURCHASE" }),
        action({ id: "3", name: "Page view", category: "PAGE_VIEW" }),
        action({ id: "4", name: "Import", type: "UPLOAD_CLICKS", category: "IMPORTED_LEAD" }),
        action({ id: "5", name: "scroll", type: "GOOGLE_ANALYTICS_4_CUSTOM", status: "HIDDEN", category: "DEFAULT", googleAnalytics4Settings: { eventName: "scroll", propertyId: "9" } }),
      ],
      [`${CID}:customer`]: [trackingRow(CID)],
      [`*:customer_conversion_goal`]: [accountGoal("PAGE_VIEW", "WEBSITE", true)],
    },
  });
  // métricas por ação (FROM customer segmentado) e última conversão recebida (FROM conversion_action com métricas)
  const original = (client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(client);
  client.searchStream = async (c: string, q: string) => {
    if (/segments\.conversion_action/.test(q)) {
      calls.queries.push({ cid: c, query: q });
      assertGaqlRules(q);
      return [
        { segments: { conversionAction: `customers/${CID}/conversionActions/1` }, metrics: { conversions: 5, conversionsValue: 0, allConversions: 5, allConversionsValue: 0 } },
        { segments: { conversionAction: `customers/${CID}/conversionActions/2` }, metrics: { conversions: 4, conversionsValue: 400, allConversions: 4, allConversionsValue: 400 } },
        { segments: { conversionAction: `customers/${CID}/conversionActions/3` }, metrics: { conversions: 50, allConversions: 50 } },
      ];
    }
    if (/conversion_last_received_request_date_time/.test(q)) {
      calls.queries.push({ cid: c, query: q });
      assertGaqlRules(q);
      return [{ conversionAction: { id: "2" }, metrics: { conversionLastReceivedRequestDateTime: old } }];
    }
    return original(c, q);
  };
  const view = jsonTail(await call(client, "audit_conversion_tracking", { days: 30 }));
  const codes = (view.alertas as Row[]).map((f) => f.codigo);
  for (const code of ["PRIMARIA_SEM_CONVERSOES", "COMPRA_PRIMARIA_DUPLICADA", "COMPRA_UMA_POR_CLIQUE", "COMPRA_SEM_VALOR", "MODELO_DADOS_INDISPONIVEL", "MICRO_CONVERSAO_PRIMARIA", "META_DA_CONTA_MICRO_BIDDABLE", "ECL_DESLIGADO", "TERMOS_DADOS_CLIENTE", "GA4_NAO_IMPORTADO", "TAG_PARADA"]) {
    assert.ok(codes.includes(code), `faltou ${code}: ${codes.join(", ")}`);
  }
  const dup = (view.alertas as Row[]).find((f) => f.codigo === "COMPRA_PRIMARIA_DUPLICADA")!;
  assert.match(String(dup.mensagem), /GA4 e tag do Google Ads/);
  assert.deepEqual((view.alertas as Row[]).find((f) => f.codigo === "PRIMARIA_SEM_CONVERSOES")!.acoes, ["Import (4)"]);
  assert.equal((view.alertas as Row[])[0].severidade, "alta");
  assert.ok(calls.queries.some((q) => /segments\.date DURING LAST_30_DAYS/.test(q.query)));
});

test("audit: conta limpa não gera alerta; datas inválidas são recusadas antes da API", async () => {
  const clean = fakeClient({
    data: {
      [`${CID}:customer`]: [trackingRow(CID, { acceptedCustomerDataTerms: true })],
      [`${CID}:conversion_action`]: [action({ id: "1" })],
    },
  });
  const original = (clean.client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(clean.client);
  clean.client.searchStream = async (c: string, q: string) => /segments\.conversion_action/.test(q)
    ? [{ segments: { conversionAction: `customers/${CID}/conversionActions/1` }, metrics: { conversions: 3, allConversions: 3, allConversionsValue: 300 } }]
    : original(c, q);
  const view = jsonTail(await call(clean.client, "audit_conversion_tracking", {}));
  assert.deepEqual(view.alertas, []);

  const bad = fakeClient();
  const r = await call(bad.client, "audit_conversion_tracking", { dateRange: { since: "01/08/2026", until: "2026-08-31" } });
  assert.equal(r.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("audit: numa MCC não pede métricas (REQUESTED_METRICS_FOR_MANAGER) e devolve a auditoria de configuração", async () => {
  const managerTracking: Row = {
    customer: {
      id: MCC, descriptiveName: "MCC Agência", manager: true,
      conversionTrackingSetting: {
        googleAdsConversionCustomer: `customers/${MCC}`, conversionTrackingStatus: "CONVERSION_TRACKING_MANAGED_BY_SELF",
        conversionTrackingId: "444555666", acceptedCustomerDataTerms: true,
      },
    },
  };
  const build = () => {
    const fake = fakeClient({
      data: {
        [`${MCC}:customer`]: [managerTracking],
        [`${MCC}:conversion_action`]: [
          action({ id: "1", name: "Compra", countingType: "ONE_PER_CLICK", ownerCustomer: `customers/${MCC}`, valueSettings: { defaultValue: 0, alwaysUseDefaultValue: true } }),
        ],
      },
    });
    // a API real recusa qualquer métrica em conta de administrador
    const original = (fake.client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(fake.client);
    const attempts: string[] = [];
    fake.client.searchStream = async (c: string, q: string) => {
      if (/metrics\./.test(q)) {
        attempts.push(q);
        assertGaqlRules(q);
        throw new Error("Google Ads API: Metrics cannot be requested for a manager account. [REQUESTED_METRICS_FOR_MANAGER]");
      }
      return original(c, q);
    };
    return { ...fake, attempts };
  };

  const { client, attempts } = build();
  const result = await call(client, "audit_conversion_tracking", { customerId: MCC, days: 30 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(attempts.length, 0, "não deveria pedir métricas numa MCC");
  const view = jsonTail(result);
  const codes = (view.alertas as Row[]).map((f) => f.codigo);
  assert.ok(codes.includes("COMPRA_UMA_POR_CLIQUE"), codes.join(", "));
  const noValue = (view.alertas as Row[]).find((f) => f.codigo === "COMPRA_SEM_VALOR");
  assert.ok(noValue, codes.join(", "));
  assert.match(String(noValue!.mensagem), /\(valor fixo zerado\)/);
  for (const skipped of ["PRIMARIA_SEM_CONVERSOES", "TAG_PARADA"]) assert.ok(!codes.includes(skipped), `${skipped} sem métricas`);
  assert.equal((view.conta as Row).mcc, true);
  assert.equal((view.conta as Row).metricas_lidas, false);
  const avisos = (view.avisos as string[]).join("\n");
  assert.match(avisos, /é uma MCC: a API não devolve métricas em conta de administrador/);
  assert.match(avisos, /auditado em cada conta cliente/);
  const row = (view.acoes as Row[])[0];
  assert.equal(row.conversoes, null, "sem métrica é null, não zero");
  assert.equal(row.todas_conversoes, null);

  const table = await call(build().client, "audit_conversion_tracking", { customerId: MCC, format: "table" });
  assert.equal(table.isError, undefined);
  assert.match(textOf(table), /\[aviso\] A conta 9998887776 é uma MCC/);
  assert.match(textOf(table), /COMPRA_UMA_POR_CLIQUE/);
});

test("audit: métricas recusadas numa conta comum viram aviso e as regras de volume não são avaliadas", async () => {
  const { client } = fakeClient({
    data: {
      [`${CID}:customer`]: [trackingRow(CID, { acceptedCustomerDataTerms: true })],
      [`${CID}:conversion_action`]: [action({ id: "1", countingType: "ONE_PER_CLICK" })],
    },
  });
  const original = (client.searchStream as (c: string, q: string) => Promise<Row[]>).bind(client);
  client.searchStream = async (c: string, q: string) => {
    if (/metrics\./.test(q)) throw new Error("Google Ads API: Internal error encountered. [INTERNAL_ERROR]");
    return original(c, q);
  };
  const result = await call(client, "audit_conversion_tracking", {});
  assert.equal(result.isError, undefined, textOf(result));
  const view = jsonTail(result);
  const codes = (view.alertas as Row[]).map((f) => f.codigo);
  assert.deepEqual(codes, ["COMPRA_UMA_POR_CLIQUE"]);
  assert.match((view.avisos as string[]).join("\n"), /Conversões do período por ação indisponíveis \(Google Ads API: Internal error/);
  assert.equal((view.conta as Row).metricas_lidas, false);
});

// ── set_account_conversion_goals ─────────────────────────────────────

function accountGoalsData(conversionCustomer = CID): Data {
  return {
    [`${CID}:customer`]: [trackingRow(conversionCustomer)],
    [`${conversionCustomer}:customer_conversion_goal`]: [accountGoal("PURCHASE", "WEBSITE", true), accountGoal("PAGE_VIEW", "WEBSITE", true)],
    [`${CID}:conversion_goal_campaign_config`]: [configRow("CUSTOMER"), configRow("CAMPAIGN", "", { id: "2", name: "Busca" })],
  };
}

test("set_account_conversion_goals: sem confirm só a prévia; com confirm grava na MCC só o que muda", async () => {
  const preview = fakeClient({ data: accountGoalsData(MCC) });
  const r1 = await call(preview.client, "set_account_conversion_goals", {
    goals: [{ category: "PAGE_VIEW", biddable: false }, { category: "PURCHASE", biddable: true }],
  });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Prévia — nada foi gravado[\s\S]*PAGE_VIEW \(WEBSITE\): lance → observação[\s\S]*Afeta 1 campanha/);
  assert.match(textOf(r1), /demais contas que usam 9998887776/);
  assert.equal(preview.calls.writes.length, 0);

  const { client, calls } = fakeClient({ data: accountGoalsData(MCC) });
  const r2 = await call(client, "set_account_conversion_goals", {
    goals: [{ category: "PAGE_VIEW", biddable: false }, { category: "PURCHASE", biddable: true }], confirm: true,
  });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].cid, MCC);
  assert.equal(calls.writes[0].resource, "customerConversionGoals");
  assert.deepEqual(calls.writes[0].operations, [{
    update: { resourceName: `customers/${MCC}/customerConversionGoals/PAGE_VIEW~WEBSITE`, biddable: false }, updateMask: "biddable",
  }]);
  assert.equal(calls.writes[0].options, undefined, "o serviço não tem partial_failure");
  assert.match(textOf(r2), /Sem mudança: PURCHASE \(WEBSITE\)/);
});

test("set_account_conversion_goals: par inexistente, sem mudança e repetido não gravam", async () => {
  for (const [goals, pattern] of [
    [[{ category: "CONTACT", origin: "CALL_FROM_ADS", biddable: true }], /não existem nas metas da conta/],
    [[{ category: "PURCHASE", biddable: true }], /nada a mudar/],
    [[{ category: "PURCHASE", biddable: true }, { category: "PURCHASE", origin: "WEBSITE", biddable: false }], /Par repetido/],
  ] as Array<[Row[], RegExp]>) {
    const { client, calls } = fakeClient({ data: accountGoalsData() });
    const result = await call(client, "set_account_conversion_goals", { goals, confirm: true });
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

// ── metas personalizadas ─────────────────────────────────────────────

function customData(conversionCustomer = CID): Data {
  return {
    [`${CID}:customer`]: [trackingRow(conversionCustomer)],
    [`${conversionCustomer}:conversion_action`]: [
      action({ id: "10", name: "Compra aprovada", type: "UPLOAD_CLICKS" }),
      action({ id: "11", name: "Compra site" }),
      action({ id: "12", name: "Antiga", status: "REMOVED" }),
    ],
    [`${conversionCustomer}:custom_conversion_goal`]: [customGoalRow("77", "Vendas", ["11"], conversionCustomer)],
    [`${CID}:conversion_goal_campaign_config`]: [configRow("CAMPAIGN", `customers/${conversionCustomer}/customConversionGoals/77`)],
  };
}

test("create_custom_conversion_goal: cria na conta de conversão com os resource names dela", async () => {
  const { client, calls } = fakeClient({ data: customData(MCC) });
  const result = await call(client, "create_custom_conversion_goal", { name: "Só aprovada", conversionActionIds: "[\"10\"]" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].cid, MCC);
  assert.equal(calls.writes[0].resource, "customConversionGoals");
  assert.deepEqual(calls.writes[0].operations[0].create, {
    name: "Só aprovada", conversionActions: [`customers/${MCC}/conversionActions/10`], status: "ENABLED",
  });
  assert.match(textOf(result), /set_campaign_goal_config .*customConversionGoalId=900/);
});

test("create_custom_conversion_goal: ação inexistente, não ENABLED, nome ou lista repetidos são recusados", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ name: "X", conversionActionIds: ["99"] }, /não existem na conta de conversão/],
    [{ name: "X", conversionActionIds: ["12"] }, /só aceita ações ENABLED/],
    [{ name: "vendas", conversionActionIds: ["10"] }, /Já existe a meta personalizada "Vendas"/],
    [{ name: "Outra", conversionActionIds: ["11"] }, /já tem exatamente essas ações/],
    [{ name: "X", conversionActionIds: ["1a"] }, /IDs devem ser numéricos/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient({ data: customData() });
    const result = await call(client, "create_custom_conversion_goal", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_custom_conversion_goal: add/remove vira a lista inteira; remoção vinculada é barrada", async () => {
  const { client, calls } = fakeClient({ data: customData() });
  const result = await call(client, "update_custom_conversion_goal", { customConversionGoalId: "77", addConversionActionIds: ["10"] });
  assert.equal(result.isError, undefined, textOf(result));
  const op = calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "conversion_actions");
  assert.deepEqual(op.update.conversionActions, [`customers/${CID}/conversionActions/11`, `customers/${CID}/conversionActions/10`]);
  assert.match(textOf(result), /Muda o lance de: PMax Loja/);

  const linked = fakeClient({ data: customData() });
  const r2 = await call(linked.client, "update_custom_conversion_goal", { customConversionGoalId: "77", remove: true, confirm: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /em uso por PMax Loja/);
  assert.equal(linked.calls.writes.length, 0);
});

test("update_custom_conversion_goal: remoção exige confirm; sem mudança não grava; combinações inválidas", async () => {
  const data = { ...customData(), [`${CID}:conversion_goal_campaign_config`]: [] };
  const preview = fakeClient({ data });
  const r1 = await call(preview.client, "update_custom_conversion_goal", { customConversionGoalId: "77", remove: true });
  assert.match(textOf(r1), /Prévia — nada foi removido/);
  assert.equal(preview.calls.writes.length, 0);

  const removed = fakeClient({ data });
  await call(removed.client, "update_custom_conversion_goal", { customConversionGoalId: "77", remove: true, confirm: true });
  assert.deepEqual(removed.calls.writes[0].operations, [{ remove: `customers/${CID}/customConversionGoals/77` }]);

  const noop = fakeClient({ data });
  const r3 = await call(noop.client, "update_custom_conversion_goal", { customConversionGoalId: "77", name: "Vendas", conversionActionIds: ["11"] });
  assert.match(textOf(r3), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);

  const both = fakeClient({ data });
  const r4 = await call(both.client, "update_custom_conversion_goal", { customConversionGoalId: "77", conversionActionIds: ["11"], addConversionActionIds: ["10"] });
  assert.equal(r4.isError, true);
  assert.equal(both.calls.queries.length, 0);
});

// ── set_campaign_goal_config ─────────────────────────────────────────

test("set_campaign_goal_config: aplica meta personalizada da MCC na conta da campanha e relê", async () => {
  const data = {
    ...customData(MCC),
    [`${CID}:conversion_goal_campaign_config`]: [configRow("CUSTOMER")],
  };
  const { client, calls } = fakeClient({ data });
  const result = await call(client, "set_campaign_goal_config", { campaignId: CAMPAIGN_ID, customConversionGoalId: "77" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].cid, CID, "ConversionGoalCampaignConfig fica na conta da campanha");
  assert.deepEqual(calls.writes[0].operations, [{
    update: { resourceName: `customers/${CID}/conversionGoalCampaignConfigs/${CAMPAIGN_ID}`, customConversionGoal: `customers/${MCC}/customConversionGoals/77` },
    updateMask: "custom_conversion_goal",
  }]);
  assert.ok(calls.queries.some((q) => q.cid === MCC && /FROM custom_conversion_goal/.test(q.query)));
  assert.match(textOf(result), /Relido na API: goal_config_level=CUSTOMER/);
  assert.match(textOf(result), /deixa de herdar as metas da conta/);
});

test("set_campaign_goal_config: reset exige confirm e mostra o que descarta; no-op e entradas inválidas", async () => {
  const base = { [`${CID}:customer`]: [trackingRow()], [`${CID}:campaign_conversion_goal`]: [campaignGoal("PURCHASE", "WEBSITE", true)] };
  const preview = fakeClient({ data: { ...base, [`${CID}:conversion_goal_campaign_config`]: [configRow("CAMPAIGN")] } });
  const r1 = await call(preview.client, "set_campaign_goal_config", { campaignId: CAMPAIGN_ID, resetToAccountDefaults: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Prévia[\s\S]*PURCHASE \(WEBSITE\): lance/);
  assert.equal(preview.calls.writes.length, 0);

  const reset = fakeClient({ data: { ...base, [`${CID}:conversion_goal_campaign_config`]: [configRow("CAMPAIGN")] } });
  await call(reset.client, "set_campaign_goal_config", { campaignId: CAMPAIGN_ID, resetToAccountDefaults: true, confirm: true });
  assert.deepEqual(reset.calls.writes[0].operations, [{
    update: { resourceName: `customers/${CID}/conversionGoalCampaignConfigs/${CAMPAIGN_ID}`, goalConfigLevel: "CUSTOMER" },
    updateMask: "goal_config_level",
  }]);

  const noop = fakeClient({ data: { ...base, [`${CID}:conversion_goal_campaign_config`]: [configRow("CUSTOMER")] } });
  const r3 = await call(noop.client, "set_campaign_goal_config", { campaignId: CAMPAIGN_ID, resetToAccountDefaults: true, confirm: true });
  assert.match(textOf(r3), /já herda as metas da conta/);
  assert.equal(noop.calls.writes.length, 0);

  for (const args of [{}, { customConversionGoalId: "77", resetToAccountDefaults: true }, { customConversionGoalId: "x" }]) {
    const invalid = fakeClient();
    const r = await call(invalid.client, "set_campaign_goal_config", { campaignId: CAMPAIGN_ID, ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(invalid.calls.queries.length, 0);
  }
});

// ── set_campaign_conversion_goals ────────────────────────────────────

test("set_campaign_conversion_goals: avisa que a campanha sai das metas da conta; aceita YOUTUBE_FOLLOW_ON_VIEWS", async () => {
  const { client, calls } = fakeClient({
    data: {
      [`*:campaign_conversion_goal`]: [campaignGoal("PURCHASE", "WEBSITE", false), campaignGoal("YOUTUBE_FOLLOW_ON_VIEWS", "YOUTUBE_HOSTED", true)],
      [`*:conversion_goal_campaign_config`]: [configRow("CUSTOMER")],
    },
  });
  const result = await call(client, "set_campaign_conversion_goals", {
    campaignId: CAMPAIGN_ID,
    goals: [{ category: "PURCHASE", biddable: true }, { category: "YOUTUBE_FOLLOW_ON_VIEWS", origin: "YOUTUBE_HOSTED", biddable: false }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].operations.length, 2);
  assert.match(textOf(result), /desligou a campanha das metas padrão da conta \(goal_config_level CUSTOMER → CAMPAIGN\)/);
  assert.match(textOf(result), /resetToAccountDefaults/);
});

// ── REST de ponta a ponta (fetch interceptado) ───────────────────────

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
  loginCustomerId: MCC,
});

test("REST: metas da conta vão para customers/{MCC}/customerConversionGoals:mutate com validateOnly", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return {};
    const query = String(body.query);
    if (/FROM customer_conversion_goal/.test(query)) return [{ results: [accountGoal("PAGE_VIEW", "WEBSITE", true)] }];
    if (/FROM customer LIMIT/.test(query)) return [{ results: [trackingRow(MCC)] }];
    return [{ results: [] }];
  });
  try {
    const handlers = register(realClient()).handlers;
    const result = await handlers.get("set_account_conversion_goals")!({
      customerId: CID, goals: [{ category: "PAGE_VIEW", biddable: false }], confirm: true, validateOnly: true,
    });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${MCC}/customerConversionGoals:mutate`), writes[0].url);
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal(writes[0].body.partialFailure, undefined);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
    assert.match(textOf(result), /DRY-RUN \(validateOnly\): metas da conta 9998887776 validadas/);
    for (const read of net.sent.filter((s) => s.url.endsWith(":searchStream"))) assertGaqlRules(String(read.body.query));
  } finally {
    net.restore();
  }
});

test("REST: update_conversion_action grava em customers/{dona}/conversionActions:mutate", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return { results: [{ resourceName: `customers/${MCC}/conversionActions/1001` }] };
    const query = String(body.query);
    if (/FROM conversion_action/.test(query)) return [{ results: [action({ ownerCustomer: `customers/${MCC}` })] }];
    if (/FROM customer LIMIT/.test(query)) return [{ results: [trackingRow(MCC)] }];
    return [{ results: [] }];
  });
  try {
    const handlers = register(realClient()).handlers;
    await handlers.get("update_conversion_action")!({ customerId: CID, conversionActionId: "1001", primary: false, confirm: true });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${MCC}/conversionActions:mutate`), writes[0].url);
    assert.deepEqual(writes[0].body.operations, [{
      update: { resourceName: `customers/${MCC}/conversionActions/1001`, primaryForGoal: false }, updateMask: "primary_for_goal",
    }]);
  } finally {
    net.restore();
  }
});
