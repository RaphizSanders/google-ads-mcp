/**
 * Lote conversions-offline: upload_offline_conversion (reescrita), upload_conversion_adjustments,
 * upload_call_conversions, upload_offline_conversions_data_manager, get_data_manager_request_status,
 * get_conversion_upload_health, lookup_gclid, get_call_details e os métodos Data Manager do client.
 *
 * O que estes testes fixam:
 * - payload no formato REST da v25 (camelCase), enviado para a conta DONA da ação;
 * - e-mail/telefone/nome normalizados e com SHA-256 no servidor, nunca em claro na saída;
 * - toda recusa de validação acontece antes de qualquer chamada à API;
 * - retratação exige confirm; dry-run/validateOnly nunca afirma gravação;
 * - erros por linha saem do índice em "conversions"/"conversion_adjustments";
 * - toda query passa pelas regras de GAQL da v25 (tests/gaql-rules.ts).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
  parseAdsDateTime,
  parseRfc3339,
  uploadFailuresByRow,
} from "../src/tools/conversions-offline.js";
import { assertGaqlRules } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const MCC = "9990001112";
const ACTION_ID = "555";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  dryRun?: boolean;
  customers?: Record<string, Row>;
  actions?: Record<string, Row[]>;
  rows?: Record<string, Row[] | ((query: string, cid: string) => Row[])>;
  writeAction?: (cid: string, action: string, body: Row) => Row;
  dmIngest?: (body: Row) => Row;
  dmStatus?: (id: string) => Row;
}

function customer(cid: string, overrides: Row = {}, setting: Row = {}): Row {
  return {
    id: cid,
    currencyCode: "BRL",
    timeZone: "America/Sao_Paulo",
    conversionTrackingSetting: {
      googleAdsConversionCustomer: `customers/${cid}`,
      acceptedCustomerDataTerms: true,
      enhancedConversionsForLeadsEnabled: true,
      ...setting,
    },
    ...overrides,
  };
}

function action(overrides: Row = {}, owner = CID): Row {
  return {
    id: ACTION_ID,
    name: "Lead qualificado (CRM)",
    type: "UPLOAD_CLICKS",
    status: "ENABLED",
    ownerCustomer: `customers/${owner}`,
    countingType: "ONE_PER_CLICK",
    valueSettings: { alwaysUseDefaultValue: false, defaultCurrencyCode: "BRL" },
    ...overrides,
  };
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ cid: string; query: string }>,
    writes: [] as Array<{ cid: string; action: string; body: Row; dryRun: boolean }>,
    dm: [] as Array<{ body: Row; dryRun: boolean }>,
    dmStatus: [] as string[],
  };
  const customers = opts.customers ?? { [CID]: customer(CID) };
  const actions = opts.actions ?? { [CID]: [action()] };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(cid: string, query: string): Promise<Row[]> {
      calls.queries.push({ cid, query });
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      if (from === "customer") return customers[cid] ? [{ customer: customers[cid] }] : [];
      if (from === "conversion_action") {
        const id = /conversion_action\.id = (\d+)/.exec(query)?.[1];
        return (actions[cid] ?? []).filter((a) => String(a.id) === id).map((a) => ({ conversionAction: a }));
      }
      const rows = opts.rows?.[from];
      return typeof rows === "function" ? rows(query, cid) : rows ?? [];
    },
    async customerWriteAction(cid: string, act: string, body: Row): Promise<Row> {
      calls.writes.push({ cid, action: act, body, dryRun });
      if (opts.writeAction) return opts.writeAction(cid, act, body);
      if (dryRun) return {};
      const items = ((body.conversions ?? body.conversionAdjustments) as Row[]) ?? [];
      return { results: items.map(() => ({ conversionAction: "ok" })), ...(act.includes("Call") ? {} : { jobId: "4242" }) };
    },
    async dataManagerIngestEvents(body: Row): Promise<Row> {
      calls.dm.push({ body, dryRun });
      if (opts.dmIngest) return opts.dmIngest(body);
      return dryRun ? {} : { requestId: "req-123" };
    },
    async dataManagerRequestStatus(id: string): Promise<Row> {
      calls.dmStatus.push(id);
      return opts.dmStatus ? opts.dmStatus(id) : {};
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

const call = (client: unknown, tool: string, args: Row, allowed: string[] = [], hosted = false) =>
  register(client, allowed, hosted).get(tool)!({ customerId: CID, conversionActionId: ACTION_ID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

const CONV_TIME = "2026-09-01 14:30:00-03:00";
const CLICK = { gclid: "Cj0KCQjwTESTgclid_123-abc", conversionDateTime: CONV_TIME };

// ── Classificação ─────────────────────────────────────────────────────

test("catálogo: leituras e escritas do lote classificadas; upload_offline_conversion segue como escrita", () => {
  for (const name of ["get_conversion_upload_health", "lookup_gclid", "get_call_details", "get_data_manager_request_status"]) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), name);
  }
  for (const name of ["upload_offline_conversion", "upload_conversion_adjustments", "upload_call_conversions", "upload_offline_conversions_data_manager"]) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), name);
  }
  const handlers = register(fakeClient().client);
  for (const name of ["upload_offline_conversion", "upload_conversion_adjustments", "upload_call_conversions",
    "upload_offline_conversions_data_manager", "get_data_manager_request_status", "get_conversion_upload_health",
    "lookup_gclid", "get_call_details"]) {
    assert.ok(handlers.has(name), `${name} registrada`);
  }
});

// ── Normalização ──────────────────────────────────────────────────────

test("normalização: gmail perde pontos e +sufixo; outros domínios não; telefone vira E.164 só com DDI", () => {
  assert.deepEqual(normalizeEmail(" Jane.Doe+Shopping@GoogleMail.com "), { value: "janedoe@googlemail.com" });
  assert.deepEqual(normalizeEmail("user.name+NYC@Example.com"), { value: "user.name+nyc@example.com" });
  assert.ok("error" in normalizeEmail("sem-arroba.com"));
  assert.ok("error" in normalizeEmail("a@b@c.com"));
  assert.deepEqual(normalizePhone("+55 (11) 99999-8888"), { value: "+5511999998888" });
  assert.deepEqual(normalizePhone("0055 11 99999-8888"), { value: "+5511999998888" });
  assert.deepEqual(normalizePhone("(11) 99999-8888", "55"), { value: "+5511999998888" });
  assert.deepEqual(normalizePhone("011 99999-8888", "55"), { value: "+5511999998888" });
  // sem DDI e sem default: recusado (viraria +11999998888, um E.164 errado)
  assert.ok("error" in normalizePhone("(11) 99999-8888"));
  assert.ok("error" in normalizePhone("+12"));
  assert.equal(normalizeName("  D'Ávila,  Maria "), "dávila maria");
  assert.equal(parseAdsDateTime("2026-09-01 14:30:00-03:00"), Date.UTC(2026, 8, 1, 17, 30, 0));
  assert.equal(parseAdsDateTime("2026-02-30 10:00:00-03:00"), null);
  assert.equal(parseAdsDateTime("2026-09-01T14:30:00-03:00"), null);
  assert.equal(parseAdsDateTime("2026-09-01 14:30:00"), null);
});

test("normalizePhone: número que já traz o DDI sem '+' não ganha o DDI de novo; ambíguo é recusado", () => {
  // Brasil: nacional = DDD + 8/9 dígitos (10/11); com DDI 55 = 12/13
  assert.deepEqual(normalizePhone("5511999998888", "55"), { value: "+5511999998888" }, "CRM com 55 sem '+'");
  assert.deepEqual(normalizePhone("55 (11) 99999-8888", "55"), { value: "+5511999998888" });
  assert.deepEqual(normalizePhone("551133334444", "55"), { value: "+551133334444" }, "fixo com DDI sem '+'");
  assert.deepEqual(normalizePhone("(55) 99999-8888", "55"), { value: "+5555999998888" }, "DDD 55 (RS), nacional: ganha o DDI");
  assert.deepEqual(normalizePhone("(55) 3222-1111", "55"), { value: "+555532221111" }, "fixo no DDD 55");
  assert.deepEqual(normalizePhone("055 99999-8888", "55"), { value: "+5555999998888" }, "0 de tronco = nacional");
  assert.deepEqual(normalizePhone("(11) 99999-8888", "55"), { value: "+5511999998888" });
  for (const bad of ["99999-8888", "0 21 11 99999-8888", "55119999988881"]) {
    const r = normalizePhone(bad, "55");
    assert.ok("error" in r && /não é número nacional do DDI 55.*\+55/.test(r.error), `${bad}: ${JSON.stringify(r)}`);
  }
  // NANP: o "1" de tronco é o próprio DDI — os dois caminhos dão o mesmo E.164
  assert.deepEqual(normalizePhone("1 212 555 1234", "1"), { value: "+12125551234" });
  assert.deepEqual(normalizePhone("(212) 555-1234", "1"), { value: "+12125551234" });
  // Portugal
  assert.deepEqual(normalizePhone("351912345678", "351"), { value: "+351912345678" });
  assert.deepEqual(normalizePhone("912 345 678", "351"), { value: "+351912345678" });
  // DDI sem plano conhecido: começa pelo DDI e sem '+' → ambíguo; com 0 de tronco ou sem o DDI → prefixa
  const ambiguous = normalizePhone("447911123456", "44");
  assert.ok("error" in ambiguous && /ambíguo|não dá para saber/.test(ambiguous.error), JSON.stringify(ambiguous));
  assert.deepEqual(normalizePhone("07911 123456", "44"), { value: "+447911123456" });
  assert.deepEqual(normalizePhone("7911 123456", "44"), { value: "+447911123456" });
  // com '+' ou '00' nada muda
  assert.deepEqual(normalizePhone("+55 11 99999-8888", "55"), { value: "+5511999998888" });
  assert.deepEqual(normalizePhone("0055 11 99999-8888", "55"), { value: "+5511999998888" });
});

test("uploadFailuresByRow lê o índice em conversions / conversion_adjustments (não em operations)", () => {
  const partial = {
    message: "falhas",
    details: [{
      errors: [
        { errorCode: { conversionUploadError: "EVENT_NOT_FOUND" }, message: "not found", location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }, { fieldName: "gclid" }] } },
        { errorCode: { conversionAdjustmentUploadError: "CONVERSION_NOT_FOUND" }, message: "adj", location: { fieldPathElements: [{ fieldName: "conversion_adjustments", index: 0 }] } },
        { errorCode: { requestError: "X" }, message: "sem índice" },
      ],
    }],
  };
  const clicks = uploadFailuresByRow(partial, 3, ["conversions"]);
  assert.deepEqual(clicks.byIndex.get(1)?.codes, ["EVENT_NOT_FOUND"]);
  assert.equal(clicks.unattributed.length, 2);
  const adjustments = uploadFailuresByRow(partial, 3, ["conversion_adjustments", "conversionAdjustments"]);
  assert.deepEqual(adjustments.byIndex.get(0)?.codes, ["CONVERSION_NOT_FOUND"]);
});

// ── upload_offline_conversion ─────────────────────────────────────────

test("upload_offline_conversion: payload completo, hash no servidor e nada em claro na saída", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_offline_conversion", {
    conversions: [{
      ...CLICK,
      conversionValue: 350.5,
      orderId: "PED-2026-000123",
      email: ["Jane.Doe+lead@gmail.com", "contato@empresa.com.br"],
      phone: "(11) 99999-8888",
      customerType: "NEW",
      conversionEnvironment: "WEB",
      cartData: { merchantId: "123456", feedCountryCode: "br", feedLanguageCode: "PT", localTransactionCost: 10, items: [{ productId: "SKU-1", quantity: 2, unitPrice: 170.25 }] },
      customVariables: [{ id: "77", value: "vendedor-3" }],
    }],
    adUserDataConsent: "GRANTED",
    defaultPhoneCountryCode: "55",
    jobId: 99,
  });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.cid, CID);
  assert.equal(write.action, ":uploadClickConversions");
  assert.equal(write.body.partialFailure, true);
  assert.equal(write.body.jobId, 99);
  assert.equal("validateOnly" in write.body, false, "o handler não decide validateOnly — o client em dry-run decide");
  const row = (write.body.conversions as Row[])[0];
  assert.equal(row.conversionAction, `customers/${CID}/conversionActions/${ACTION_ID}`);
  assert.equal(row.conversionDateTime, CONV_TIME);
  assert.equal(row.gclid, CLICK.gclid);
  assert.equal(row.conversionValue, 350.5);
  assert.equal(row.currencyCode, "BRL", "sem moeda: usa a padrão da ação");
  assert.equal(row.orderId, "PED-2026-000123", "ID de pedido com hífens não é confundido com telefone");
  assert.deepEqual(row.userIdentifiers, [
    { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("janedoe@gmail.com") },
    { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("contato@empresa.com.br") },
    { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha("+5511999998888") },
  ]);
  assert.deepEqual(row.consent, { adUserData: "GRANTED" });
  assert.equal(row.customerType, "NEW");
  assert.equal(row.conversionEnvironment, "WEB");
  assert.deepEqual(row.cartData, {
    merchantId: "123456", feedCountryCode: "BR", feedLanguageCode: "pt", localTransactionCost: 10,
    items: [{ productId: "SKU-1", quantity: 2, unitPrice: 170.25 }],
  });
  assert.deepEqual(row.customVariables, [{ conversionCustomVariable: `customers/${CID}/conversionCustomVariables/77`, value: "vendedor-3" }]);
  const out = textOf(result);
  assert.match(out, /1 aceita\(s\), 0 recusada\(s\)/);
  assert.match(out, /job_id: 4242/);
  assert.doesNotMatch(out, /jane|empresa\.com|99999/i, "PII não volta em claro");
  assert.doesNotMatch(JSON.stringify(write.body), /jane|empresa\.com|99999-8888/i, "PII não sai em claro para a API");
});

test("upload_offline_conversion: validação recusa antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ conversions: [{ gclid: "abcdefgh12", conversionDateTime: "2026-09-01 14:30:00" }] }, /conversionDateTime inválido/],
    [{ conversions: [{ gbraid: "g1234567", wbraid: "w1234567", conversionDateTime: CONV_TIME }] }, /GBRAID_WBRAID_BOTH_SET/],
    [{ conversions: [{ conversionDateTime: CONV_TIME }] }, /sem gclid\/gbraid\/wbraid nem e-mail/],
    [{ conversions: [{ ...CLICK, email: ["a@a.com", "b@b.com", "c@c.com", "d@d.com", "e@e.com", "f@f.com"] }] }, /máximo é 5/],
    [{ conversions: [{ ...CLICK, orderId: "P1" }, { gclid: "outroGclid123", conversionDateTime: CONV_TIME, orderId: "P1" }] }, /DUPLICATE_ORDER_ID/],
    [{ conversions: [CLICK, CLICK] }, /DUPLICATE_CLICK_CONVERSION_IN_REQUEST/],
    [{ conversions: [{ ...CLICK, phone: "11 99999-8888" }] }, /sem código do país/],
    [{ conversions: [{ ...CLICK, orderId: "cliente@gmail.com" }] }, /ORDER_ID_CONTAINS_PII/],
    [{ conversions: [{ ...CLICK, conversionValue: -1 }] }, /≥ 0/],
    [{ conversions: [{ ...CLICK, currencyCode: "real" }] }, /ISO 4217/],
    [{ conversions: [{ ...CLICK, hashedEmail: "nao-e-hash" }] }, /SHA-256 em hex/],
    [{ conversions: [{ gbraid: "g1234567", conversionDateTime: CONV_TIME, customVariables: [{ id: "1", value: "x" }] }] }, /gbraid\/wbraid/],
    [{ conversions: [{ ...CLICK, conversionDateTime: "2099-01-01 10:00:00-03:00" }] }, /no futuro/],
    [{ conversions: [CLICK], jobId: 0 }, /jobId inválido/],
    [{ conversions: [CLICK], conversionActionId: "55-5" }, /conversionActionId inválido/],
    [{ conversions: [CLICK], defaultPhoneCountryCode: "BR" }, /defaultPhoneCountryCode inválido/],
    [{ conversions: [] }, /ao menos 1/],
    [{ conversions: Array.from({ length: 2001 }, () => CLICK) }, /Máximo de 2000/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_offline_conversion", args);
    assert.equal(result.isError, true, `${expected}: ${textOf(result)}`);
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length, 0, `${expected}: nenhuma leitura`);
    assert.equal(calls.writes.length, 0, `${expected}: nenhuma escrita`);
  }
});

test("upload_offline_conversion: linha só com e-mail (enhanced conversions for leads) e pré-requisitos", async () => {
  const ok = fakeClient();
  const result = await call(ok.client, "upload_offline_conversion", {
    conversions: [{ email: "lead@empresa.com.br", conversionDateTime: CONV_TIME, adUserDataConsent: "GRANTED" }],
  });
  assert.equal(result.isError, false, textOf(result));
  const row = (ok.calls.writes[0].body.conversions as Row[])[0];
  assert.equal(row.gclid, undefined);
  assert.deepEqual(row.userIdentifiers, [{ userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("lead@empresa.com.br") }]);

  // termos não aceitos na conta de conversão: recusa sem gravar
  const noTerms = fakeClient({ customers: { [CID]: customer(CID, {}, { acceptedCustomerDataTerms: false }) } });
  const refused = await call(noTerms.client, "upload_offline_conversion", {
    conversions: [{ email: "lead@empresa.com.br", conversionDateTime: CONV_TIME }],
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /termos de dados do cliente NÃO aceitos/);
  assert.equal(noTerms.calls.writes.length, 0);

  // com gclid a linha segue, mas sai um aviso
  const warn = fakeClient({ customers: { [CID]: customer(CID, {}, { enhancedConversionsForLeadsEnabled: false }) } });
  const warned = await call(warn.client, "upload_offline_conversion", { conversions: [{ ...CLICK, email: "x@y.com" }] });
  assert.equal(warned.isError, false);
  assert.match(textOf(warned), /pré-requisitos de enhanced conversions for leads não estão completos/);
  assert.match(textOf(warned), /sem adUserDataConsent/);
});

test("upload_offline_conversion: tipo, status e contagem da ação conferidos antes de gravar", async () => {
  const calls = fakeClient({ actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] } });
  const r1 = await call(calls.client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /UPLOAD_CLICKS.*upload_call_conversions/s);
  assert.equal(calls.calls.writes.length, 0);

  const hidden = fakeClient({ actions: { [CID]: [action({ status: "HIDDEN" })] } });
  const r2 = await call(hidden.client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não está ativa \(HIDDEN\)/);
  assert.equal(hidden.calls.writes.length, 0);

  const missing = fakeClient({ actions: {} });
  const r3 = await call(missing.client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /não existe na conta/);
  assert.equal(missing.calls.writes.length, 0);

  const braid = fakeClient();
  const r4 = await call(braid.client, "upload_offline_conversion", { conversions: [{ gbraid: "gbraid12345", conversionDateTime: CONV_TIME }] });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /ONE_PER_CLICK_CONVERSION_ACTION_NOT_PERMITTED_WITH_BRAID/);
  assert.equal(braid.calls.writes.length, 0);
});

test("upload_offline_conversion: acompanhamento entre contas envia pela conta de conversão (MCC) e respeita a allowlist", async () => {
  const opts: FakeOptions = {
    customers: {
      [CID]: customer(CID, {}, { googleAdsConversionCustomer: `customers/${MCC}` }),
      [MCC]: customer(MCC, { currencyCode: "USD" }),
    },
    actions: { [MCC]: [action({ valueSettings: {} }, MCC)] },
  };
  const { client, calls } = fakeClient(opts);
  const result = await call(client, "upload_offline_conversion", { conversions: [{ ...CLICK, conversionValue: 10 }] });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(calls.writes[0].cid, MCC);
  const row = (calls.writes[0].body.conversions as Row[])[0];
  assert.equal(row.conversionAction, `customers/${MCC}/conversionActions/${ACTION_ID}`);
  assert.equal(row.currencyCode, "BRL", "sem moeda na ação: a do anunciante (conta pedida)");
  assert.match(textOf(result), new RegExp(`conta de conversão ${MCC}`));

  // hospedado com allowlist só do cliente: a MCC não pode ser tocada
  const blocked = fakeClient(opts);
  const refused = await call(blocked.client, "upload_offline_conversion", { conversions: [CLICK] }, [CID], true);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /fora da allowlist/);
  assert.equal(blocked.calls.writes.length, 0);
  assert.ok(blocked.calls.queries.every((q) => q.cid === CID), "nem lê a MCC fora da allowlist");

  // conta fora da allowlist: nega antes de tudo
  const denied = fakeClient();
  const r = await call(denied.client, "upload_offline_conversion", { conversions: [CLICK] }, ["1111111111"], true);
  assert.match(textOf(r), /Access denied/);
  assert.equal(denied.calls.queries.length, 0);
});

test("upload_offline_conversion: CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE vira orientação da Data Manager", async () => {
  const { client } = fakeClient({
    writeAction: () => {
      throw new Error("Google Ads API: Request contains an invalid argument. — Customer is not allowlisted for accessing this feature.");
    },
  });
  const result = await call(client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.equal(result.isError, true);
  const out = textOf(result);
  assert.match(out, /15\/06\/2026/);
  assert.match(out, /upload_offline_conversions_data_manager/);
  assert.match(out, /auth\/datamanager/);
  assert.match(out, /Nada foi gravado/);

  // mesmo código vindo no partial failure de todas as linhas
  const partial = fakeClient({
    writeAction: () => ({
      partialFailureError: { details: [{ errors: [{ errorCode: { notAllowlistedError: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE" }, message: "x", location: { fieldPathElements: [{ fieldName: "conversions", index: 0 }] } }] }] },
      results: [{}],
    }),
  });
  const r2 = await call(partial.client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /upload_offline_conversions_data_manager/);
});

test("upload_offline_conversion: falha parcial reportada por linha, com dica", async () => {
  const { client } = fakeClient({
    writeAction: () => ({
      partialFailureError: {
        message: "1 falha",
        details: [{ errors: [{ errorCode: { conversionUploadError: "EVENT_NOT_FOUND" }, message: "The click could not be found.", location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }] } }] }],
      },
      results: [{ gclid: "a" }, {}],
      jobId: "77",
    }),
  });
  const result = await call(client, "upload_offline_conversion", {
    conversions: [CLICK, { gclid: "segundoGclid1", conversionDateTime: CONV_TIME }],
  });
  const out = textOf(result);
  assert.equal(result.isError, false, "envio parcial não é falha total");
  assert.match(out, /1 aceita\(s\), 1 recusada\(s\)/);
  assert.match(out, /envio parcial/);
  assert.match(out, /linha 2 \(gclid\): The click could not be found\. \[EVENT_NOT_FOUND → .*lookup_gclid/);
});

test("upload_offline_conversion: validateOnly e GOOGLE_ADS_DRY_RUN nunca afirmam gravação", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_offline_conversion", { conversions: [CLICK], validateOnly: true });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true, "validateOnly roda no client em dry-run");
  const out = textOf(result);
  assert.match(out, /VALIDATE-ONLY/);
  assert.match(out, /DRY-RUN \(validateOnly\): 1 conversão\(ões\) validada\(s\), nada gravado/);
  assert.doesNotMatch(out, /aceita\(s\)/);

  const env = fakeClient({ dryRun: true });
  const r2 = await call(env.client, "upload_offline_conversion", { conversions: [CLICK] });
  assert.match(textOf(r2), /nada gravado/);
  assert.equal(r2.isError, false);
});

// ── upload_conversion_adjustments ─────────────────────────────────────

const ADJ_TIME = "2026-09-05 10:00:00-03:00";

test("upload_conversion_adjustments: RETRACTION exige confirm e não lê nem grava sem ele", async () => {
  const { client, calls } = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const args = { adjustments: [{ type: "RETRACTION", orderId: "PED-1", adjustmentDateTime: ADJ_TIME }] };
  const refused = await call(client, "upload_conversion_adjustments", args);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.writes.length, 0);

  const ok = await call(client, "upload_conversion_adjustments", { ...args, confirm: true, jobId: 12 });
  assert.equal(ok.isError, false, textOf(ok));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].action, ":uploadConversionAdjustments");
  assert.deepEqual(calls.writes[0].body, {
    conversionAdjustments: [{
      conversionAction: `customers/${CID}/conversionActions/${ACTION_ID}`,
      adjustmentType: "RETRACTION",
      adjustmentDateTime: ADJ_TIME,
      orderId: "PED-1",
    }],
    partialFailure: true,
    jobId: 12,
  });
  assert.match(textOf(ok), /1 RETRACTION.*1 aceito/s);
});

test("upload_conversion_adjustments: validateOnly valida retratação sem confirm e sem gravar de verdade", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_conversion_adjustments", {
    adjustments: [{ type: "RETRACTION", gclid: "gclidRetrat123", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME }],
    validateOnly: true,
  });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true);
  const row = (calls.writes[0].body.conversionAdjustments as Row[])[0];
  assert.deepEqual(row.gclidDateTimePair, { gclid: "gclidRetrat123", conversionDateTime: CONV_TIME });
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): 1 ajuste\(s\) validado\(s\)/);
});

test("upload_conversion_adjustments: regras por tipo recusadas antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ type: "RESTATEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME }, /RESTATEMENT exige adjustedValue/],
    [{ type: "RETRACTION", orderId: "P1", adjustmentDateTime: ADJ_TIME, adjustedValue: 10 }, /não aceita adjustedValue/],
    [{ type: "RETRACTION", orderId: "P1", gclid: "gclidX12345", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME }, /GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET/],
    [{ type: "RETRACTION", adjustmentDateTime: ADJ_TIME }, /orderId ou por gclid/],
    [{ type: "RETRACTION", gclid: "gclidX12345", adjustmentDateTime: ADJ_TIME }, /conversionDateTime é obrigatório/],
    [{ type: "RETRACTION", gclid: "gclidX12345", conversionDateTime: ADJ_TIME, adjustmentDateTime: CONV_TIME }, /ADJUSTMENT_PRECEDES_CONVERSION/],
    [{ type: "ENHANCEMENT", gclid: "gclidX12345", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME, email: "a@b.com" }, /ENHANCEMENT exige orderId/],
    [{ type: "ENHANCEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME }, /exige e-mail, telefone ou endereço/],
    [{ type: "RESTATEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME, adjustedValue: 5, email: "a@b.com" }, /só ENHANCEMENT/],
    [{ type: "ENHANCEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME, address: { firstName: "Ana", countryCode: "BR" } }, /address incompleto/],
    [{ type: "RETRACTION", orderId: "P1", adjustmentDateTime: "ontem" }, /adjustmentDateTime inválido/],
  ];
  for (const [adjustment, expected] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_conversion_adjustments", { adjustments: [adjustment], confirm: true });
    assert.equal(result.isError, true, `${expected}: ${textOf(result)}`);
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length + calls.writes.length, 0, `${expected}: nada chamado`);
  }
  const dup = fakeClient();
  const r = await call(dup.client, "upload_conversion_adjustments", {
    adjustments: [
      { type: "RESTATEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME, adjustedValue: 5 },
      { type: "RESTATEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME, adjustedValue: 7 },
    ],
  });
  assert.match(textOf(r), /DUPLICATE_ADJUSTMENT_IN_REQUEST/);
  assert.equal(dup.calls.writes.length, 0);
});

test("upload_conversion_adjustments: ENHANCEMENT com endereço e RESTATEMENT com moeda no formato da API", async () => {
  const { client, calls } = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const result = await call(client, "upload_conversion_adjustments", {
    adjustments: [
      {
        type: "ENHANCEMENT", orderId: "PED-9", gclid: "gclidEnh12345", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME,
        email: "Cliente@Exemplo.com", phone: "+55 21 98888-7777",
        address: { firstName: " Maria ", lastName: "D'Ávila", street: "Av. Paulista 1000", city: "São Paulo", state: "SP", countryCode: "br", postalCode: "01310-100" },
        userAgent: "Mozilla/5.0",
      },
      { type: "RESTATEMENT", orderId: "PED-10", adjustmentDateTime: ADJ_TIME, adjustedValue: 70, currencyCode: "brl" },
    ],
  });
  assert.equal(result.isError, false, textOf(result));
  const [enh, rest] = calls.writes[0].body.conversionAdjustments as Row[];
  assert.equal(enh.adjustmentType, "ENHANCEMENT");
  assert.equal(enh.orderId, "PED-9");
  // proto v25 (GclidDateTimePair em ConversionAdjustment): "If the adjustment_type is ENHANCEMENT,
  // this value is optional but may be set in addition to the order_id"; o guia recomenda mandar o gclid.
  assert.deepEqual(enh.gclidDateTimePair, { gclid: "gclidEnh12345", conversionDateTime: CONV_TIME }, "gclid opcional junto do orderId em ENHANCEMENT");
  assert.equal(enh.userAgent, "Mozilla/5.0");
  assert.deepEqual(enh.userIdentifiers, [
    { userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("cliente@exemplo.com") },
    { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha("+5521988887777") },
    {
      userIdentifierSource: "FIRST_PARTY",
      addressInfo: {
        hashedFirstName: sha("maria"),
        hashedLastName: sha("dávila"),
        countryCode: "BR",
        postalCode: "01310-100",
        hashedStreetAddress: sha("av. paulista 1000"),
        city: "São Paulo",
        state: "SP",
      },
    },
  ]);
  assert.deepEqual(rest.restatementValue, { adjustedValue: 70, currencyCode: "BRL" });
  assert.equal(rest.userIdentifiers, undefined);
  assert.doesNotMatch(textOf(result), /maria|paulista|cliente@/i);
});

/** "yyyy-MM-dd HH:mm:ss+00:00" de um instante (para datas relativas a agora). */
function adsUtc(date: Date): string {
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`;
}

test("upload_conversion_adjustments: ENHANCEMENT com orderId + conversionDateTime sem gclid (formato do guia de enhanced conversions)", async () => {
  const { client, calls } = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const result = await call(client, "upload_conversion_adjustments", {
    adjustments: [
      { type: "ENHANCEMENT", orderId: "PED-1", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME, email: "a@b.com" },
      { type: "ENHANCEMENT", orderId: "PED-2", adjustmentDateTime: ADJ_TIME, email: "c@d.com" },
    ],
  });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(calls.writes.length, 1);
  const [withTime, withoutTime] = calls.writes[0].body.conversionAdjustments as Row[];
  assert.deepEqual(withTime, {
    conversionAction: `customers/${CID}/conversionActions/${ACTION_ID}`,
    adjustmentType: "ENHANCEMENT",
    adjustmentDateTime: ADJ_TIME,
    orderId: "PED-1",
    gclidDateTimePair: { conversionDateTime: CONV_TIME },
    userIdentifiers: [{ userIdentifierSource: "FIRST_PARTY", hashedEmail: sha("a@b.com") }],
  });
  assert.equal("gclidDateTimePair" in withoutTime, false, "sem conversionDateTime nem gclid, não manda o par");
  assert.match(textOf(result), /mais de 24 h/, "conversão de dias atrás: avisa a janela de 24 h do guia");

  // conversão de 2 h atrás: sem aviso de janela
  const recent = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const now = Date.now();
  const fresh = await call(recent.client, "upload_conversion_adjustments", {
    adjustments: [{
      type: "ENHANCEMENT", orderId: "PED-3", email: "a@b.com",
      conversionDateTime: adsUtc(new Date(now - 2 * 3_600_000)), adjustmentDateTime: adsUtc(new Date(now - 3_600_000)),
    }],
  });
  assert.equal(fresh.isError, false, textOf(fresh));
  assert.doesNotMatch(textOf(fresh), /mais de 24 h/);

  // RETRACTION/RESTATEMENT seguem: orderId OU o par completo — conversionDateTime não vai com orderId nem sozinho
  const cases: Array<[Row, RegExp]> = [
    [{ type: "RETRACTION", orderId: "P1", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME }, /GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET.*tire o conversionDateTime/],
    [{ type: "RESTATEMENT", orderId: "P1", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME, adjustedValue: 5 }, /GCLID_DATE_TIME_PAIR_AND_ORDER_ID_BOTH_SET/],
    [{ type: "RETRACTION", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME }, /conversionDateTime sem gclid/],
    [{ type: "ENHANCEMENT", orderId: "P1", conversionDateTime: "2026-02-30 10:00:00-03:00", adjustmentDateTime: ADJ_TIME, email: "a@b.com" }, /conversionDateTime inválido/],
    [{ type: "ENHANCEMENT", orderId: "P1", conversionDateTime: ADJ_TIME, adjustmentDateTime: CONV_TIME, email: "a@b.com" }, /ADJUSTMENT_PRECEDES_CONVERSION/],
    [{ type: "ENHANCEMENT", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME, email: "a@b.com" }, /ENHANCEMENT exige orderId/],
  ];
  for (const [adjustment, expected] of cases) {
    const { client: c, calls: seen } = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
    const r = await call(c, "upload_conversion_adjustments", { adjustments: [adjustment], confirm: true });
    assert.equal(r.isError, true, `${expected}: ${textOf(r)}`);
    assert.match(textOf(r), expected);
    assert.equal(seen.queries.length + seen.writes.length, 0, `${expected}: nada chamado`);
  }
});

test("upload_conversion_adjustments: ENHANCEMENT só em ação WEBPAGE (INVALID_CONVERSION_ACTION_TYPE) e um por orderId (DUPLICATE_ENHANCEMENT_IN_REQUEST)", async () => {
  const enhancement = { type: "ENHANCEMENT", orderId: "PED-1", adjustmentDateTime: ADJ_TIME, email: "a@b.com" };
  for (const type of ["UPLOAD_CLICKS", "SALESFORCE"]) {
    const { client, calls } = fakeClient({ actions: { [CID]: [action({ type })] } });
    const r = await call(client, "upload_conversion_adjustments", {
      adjustments: [{ type: "RETRACTION", orderId: "PED-0", adjustmentDateTime: ADJ_TIME }, enhancement],
      confirm: true,
    });
    assert.equal(r.isError, true, `${type}: ${textOf(r)}`);
    assert.match(textOf(r), new RegExp(`linha 2: ENHANCEMENT só vale para ações WEBPAGE \\(esta é ${type}\\) — INVALID_CONVERSION_ACTION_TYPE`));
    assert.doesNotMatch(textOf(r), /linha 1:/, "a retratação não é o problema");
    assert.ok(calls.queries.length > 0, "a checagem vem depois da leitura da ação");
    assert.equal(calls.writes.length, 0, `${type}: nada enviado`);
  }
  // RETRACTION/RESTATEMENT em UPLOAD_CLICKS continuam valendo
  const clicks = fakeClient();
  const ok = await call(clicks.client, "upload_conversion_adjustments", {
    adjustments: [{ type: "RESTATEMENT", orderId: "PED-0", adjustmentDateTime: ADJ_TIME, adjustedValue: 10 }],
  });
  assert.equal(ok.isError, false, textOf(ok));
  assert.equal(clicks.calls.writes.length, 1);

  // mesmo orderId em dois ENHANCEMENT, horários diferentes: recusado antes de qualquer chamada
  const dup = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const r = await call(dup.client, "upload_conversion_adjustments", {
    adjustments: [enhancement, { ...enhancement, adjustmentDateTime: "2026-09-05 11:00:00-03:00", email: "outro@b.com" }],
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /linha 2: ENHANCEMENT repetido para o pedido PED-1 \(também na linha 1\).*DUPLICATE_ENHANCEMENT_IN_REQUEST/);
  assert.equal(dup.calls.queries.length + dup.calls.writes.length, 0);

  // pedidos diferentes passam
  const two = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const r2 = await call(two.client, "upload_conversion_adjustments", {
    adjustments: [enhancement, { ...enhancement, orderId: "PED-2" }],
  });
  assert.equal(r2.isError, false, textOf(r2));
  assert.equal((two.calls.writes[0].body.conversionAdjustments as Row[]).length, 2);
});

test("upload_conversion_adjustments: tipo de ação, WEBPAGE sem orderId e valor padrão fixo recusados após a leitura", async () => {
  const calls = fakeClient({ actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] } });
  const r1 = await call(calls.client, "upload_conversion_adjustments", { adjustments: [{ type: "RETRACTION", orderId: "P1", adjustmentDateTime: ADJ_TIME }], confirm: true });
  assert.match(textOf(r1), /INVALID_CONVERSION_ACTION_TYPE/);
  assert.equal(calls.calls.writes.length, 0);

  const web = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const r2 = await call(web.client, "upload_conversion_adjustments", {
    adjustments: [{ type: "RETRACTION", gclid: "gclidWeb12345", conversionDateTime: CONV_TIME, adjustmentDateTime: ADJ_TIME }], confirm: true,
  });
  assert.match(textOf(r2), /MISSING_ORDER_ID_FOR_WEBPAGE/);
  assert.equal(web.calls.writes.length, 0);

  const fixed = fakeClient({ actions: { [CID]: [action({ valueSettings: { alwaysUseDefaultValue: true } })] } });
  const r3 = await call(fixed.client, "upload_conversion_adjustments", { adjustments: [{ type: "RESTATEMENT", orderId: "P1", adjustmentDateTime: ADJ_TIME, adjustedValue: 1 }] });
  assert.match(textOf(r3), /não aceita RESTATEMENT/);
  assert.equal(fixed.calls.writes.length, 0);
});

test("upload_conversion_adjustments: erro por linha em conversion_adjustments", async () => {
  const { client } = fakeClient({
    writeAction: () => ({
      partialFailureError: { details: [{ errors: [{ errorCode: { conversionAdjustmentUploadError: "CONVERSION_NOT_FOUND" }, message: "not found", location: { fieldPathElements: [{ fieldName: "conversion_adjustments", index: 0 }] } }] }] },
      results: [{}],
    }),
  });
  const result = await call(client, "upload_conversion_adjustments", { adjustments: [{ type: "RETRACTION", orderId: "P1", adjustmentDateTime: ADJ_TIME }], confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /linha 1 \(RETRACTION pedido P1\): not found \[CONVERSION_NOT_FOUND → conversão original não encontrada/);
});

// ── upload_call_conversions ───────────────────────────────────────────

const CALL = { callerId: "+55 11 3333-4444", callStartDateTime: "2026-09-01 10:00:00-03:00", conversionDateTime: "2026-09-01 10:05:00-03:00" };

test("upload_call_conversions: payload E.164 + consentimento, telefone mascarado na saída", async () => {
  const { client, calls } = fakeClient({ actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] } });
  const result = await call(client, "upload_call_conversions", {
    calls: [{ ...CALL, conversionValue: 120 }, { ...CALL, callerId: "(21) 98888-7777", adUserDataConsent: "DENIED" }],
    adUserDataConsent: "GRANTED",
    defaultPhoneCountryCode: "55",
  });
  assert.equal(result.isError, false, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.action, ":uploadCallConversions");
  assert.equal(write.body.partialFailure, true);
  assert.equal("jobId" in write.body, false, "UploadCallConversionsRequest não tem job_id");
  const [first, second] = write.body.conversions as Row[];
  assert.deepEqual(first, {
    conversionAction: `customers/${CID}/conversionActions/${ACTION_ID}`,
    callerId: "+551133334444",
    callStartDateTime: CALL.callStartDateTime,
    conversionDateTime: CALL.conversionDateTime,
    consent: { adUserData: "GRANTED" },
    conversionValue: 120,
    currencyCode: "BRL",
  });
  assert.equal(second.callerId, "+5521988887777");
  assert.deepEqual(second.consent, { adUserData: "DENIED" });
  assert.match(textOf(result), /2 aceita\(s\)/);
});

test("upload_call_conversions: recusas antes da API e tipo da ação", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ calls: [CALL] }, /sem consentimento/],
    [{ calls: [{ ...CALL, conversionDateTime: "2026-09-01 09:00:00-03:00" }], adUserDataConsent: "GRANTED" }, /anterior ao início da chamada/],
    [{ calls: [{ ...CALL, callerId: "3333-4444" }], adUserDataConsent: "GRANTED" }, /sem código do país/],
    [{ calls: [CALL, CALL], adUserDataConsent: "GRANTED" }, /DUPLICATE_CALL_CONVERSION_IN_REQUEST/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient({ actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] } });
    const result = await call(client, "upload_call_conversions", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
  const clicks = fakeClient();
  const r = await call(clicks.client, "upload_call_conversions", { calls: [CALL], adUserDataConsent: "GRANTED" });
  assert.match(textOf(r), /exige ação UPLOAD_CALLS.*upload_offline_conversion/s);
  assert.equal(clicks.calls.writes.length, 0);
});

test("upload_call_conversions: TOO_RECENT_CALL ganha a dica de espera", async () => {
  const { client } = fakeClient({
    actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] },
    writeAction: () => ({
      partialFailureError: { details: [{ errors: [{ errorCode: { conversionUploadError: "TOO_RECENT_CALL" }, message: "too recent", location: { fieldPathElements: [{ fieldName: "conversions", index: 0 }] } }] }] },
      results: [{}],
    }),
  });
  const result = await call(client, "upload_call_conversions", { calls: [CALL], adUserDataConsent: "GRANTED" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /linha 1 \(\+55113\*\*\*\*4444\).*TOO_RECENT_CALL → .*12 h/);
});

test("telefone com DDI sem '+' nas tools: hash e callerId sem DDI duplicado; ambíguo recusado antes da API", async () => {
  const clicks = fakeClient();
  const r1 = await call(clicks.client, "upload_offline_conversion", {
    conversions: [{ ...CLICK, phone: "5511999998888" }], defaultPhoneCountryCode: "55", adUserDataConsent: "GRANTED",
  });
  assert.equal(r1.isError, false, textOf(r1));
  assert.deepEqual((clicks.calls.writes[0].body.conversions as Row[])[0].userIdentifiers,
    [{ userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: sha("+5511999998888") }]);

  const calls = fakeClient({ actions: { [CID]: [action({ type: "UPLOAD_CALLS" })] } });
  const r2 = await call(calls.client, "upload_call_conversions", {
    calls: [{ ...CALL, callerId: "551133334444" }], adUserDataConsent: "GRANTED", defaultPhoneCountryCode: "55",
  });
  assert.equal(r2.isError, false, textOf(r2));
  assert.equal((calls.calls.writes[0].body.conversions as Row[])[0].callerId, "+551133334444");

  const web = fakeClient({ actions: { [CID]: [action({ type: "WEBPAGE" })] } });
  const r3 = await call(web.client, "upload_conversion_adjustments", {
    adjustments: [{ type: "ENHANCEMENT", orderId: "PED-1", adjustmentDateTime: ADJ_TIME, phone: "99999-8888" }],
    defaultPhoneCountryCode: "55",
  });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /linha 1: phone: telefone com 9 dígito\(s\)/);
  assert.equal(web.calls.queries.length + web.calls.writes.length, 0);
});

// ── Data Manager ──────────────────────────────────────────────────────

test("upload_offline_conversions_data_manager: IngestEventsRequest com destino na conta de conversão", async () => {
  const { client, calls } = fakeClient({
    customers: { [CID]: customer(CID, {}, { googleAdsConversionCustomer: `customers/${MCC}` }), [MCC]: customer(MCC) },
    actions: { [MCC]: [action({}, MCC)] },
  });
  const result = await call(client, "upload_offline_conversions_data_manager", {
    conversions: [{
      ...CLICK,
      conversionValue: 99.9,
      orderId: "LEAD-77",
      email: "Fulano.Tal@gmail.com",
      address: { firstName: "Fulano", lastName: "de Tal", countryCode: "br", postalCode: "01310-100" },
      adUserDataConsent: "GRANTED",
      customerType: "RETURNING",
      cartData: { merchantId: "123", feedLabel: "BR", items: [{ productId: "SKU", quantity: 1, unitPrice: 99.9 }] },
      customVariables: [{ name: "canal", value: "whatsapp" }],
    }],
    adUserDataConsent: "DENIED",
    eventSource: "WEB",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.dm.length, 1);
  const body = calls.dm[0].body;
  assert.deepEqual(body.destinations, [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: MCC }, productDestinationId: ACTION_ID }]);
  assert.equal(body.encoding, "HEX");
  assert.deepEqual(body.consent, { adUserData: "CONSENT_DENIED" });
  const event = (body.events as Row[])[0];
  assert.deepEqual(event, {
    eventTimestamp: "2026-09-01T14:30:00-03:00",
    adIdentifiers: { gclid: CLICK.gclid },
    userData: {
      userIdentifiers: [
        { emailAddress: sha("fulanotal@gmail.com") },
        { address: { givenName: sha("fulano"), familyName: sha("de tal"), regionCode: "BR", postalCode: "01310-100" } },
      ],
    },
    transactionId: "LEAD-77",
    conversionValue: 99.9,
    currency: "BRL",
    consent: { adUserData: "CONSENT_GRANTED" },
    userProperties: { customerType: "RETURNING" },
    eventSource: "WEB",
    cartData: { merchantId: "123", merchantFeedLabel: "BR", items: [{ merchantProductId: "SKU", quantity: "1", unitPrice: 99.9 }] },
    customVariables: [{ variable: "canal", value: "whatsapp" }],
  });
  assert.equal(calls.writes.length, 0, "não usa o UploadClickConversions");
  assert.match(textOf(result), /requestId: req-123/);
  assert.match(textOf(result), /get_data_manager_request_status/);
});

test("upload_offline_conversions_data_manager: escopo insuficiente, dry-run e validação", async () => {
  const scope = fakeClient({
    dmIngest: () => {
      throw new Error("Data Manager API: PERMISSION_DENIED (HTTP 403): Request had insufficient authentication scopes. — ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    },
  });
  const r1 = await call(scope.client, "upload_offline_conversions_data_manager", { conversions: [CLICK] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /falta o escopo https:\/\/www\.googleapis\.com\/auth\/datamanager/);

  const dry = fakeClient();
  const r2 = await call(dry.client, "upload_offline_conversions_data_manager", { conversions: [CLICK], validateOnly: true });
  assert.equal(dry.calls.dm[0].dryRun, true);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): 1 evento\(s\) validado\(s\).*nada foi gravado/s);
  assert.doesNotMatch(textOf(r2), /requestId/);

  const bad = fakeClient();
  const r3 = await call(bad.client, "upload_offline_conversions_data_manager", {
    conversions: [{ conversionDateTime: CONV_TIME, email: Array.from({ length: 11 }, (_, i) => `u${i}@x.com`) }],
  });
  assert.match(textOf(r3), /máximo é 10/);
  assert.equal(bad.calls.queries.length + bad.calls.dm.length, 0);
});

test("upload_offline_conversions_data_manager: RFC 3339 com data/hora inexistente é recusado antes da API (fast-fail recusaria o lote)", async () => {
  assert.equal(parseRfc3339("2026-09-01T14:30:00-03:00"), Date.UTC(2026, 8, 1, 17, 30, 0));
  assert.equal(parseRfc3339("2026-09-01T17:30:00.5Z"), Date.UTC(2026, 8, 1, 17, 30, 0) + 500);
  assert.equal(parseRfc3339("2024-02-29T10:00:00Z"), Date.UTC(2024, 1, 29, 10, 0, 0), "29/02 de ano bissexto existe");
  for (const bad of [
    "2026-02-30T10:00:00-03:00", "2025-02-29T10:00:00Z", "2026-04-31T10:00:00Z", "2026-13-01T10:00:00Z", "2026-00-10T10:00:00Z",
    "2026-09-01T24:00:00Z", "2026-09-01T10:60:00Z", "2026-09-01T10:00:60Z", "2026-09-01T10:00:00+15:00", "2026-09-01T10:00:00-03:60",
  ]) {
    assert.equal(parseRfc3339(bad), null, bad);
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_offline_conversions_data_manager", {
      conversions: [{ gclid: "gclidAbc12345", conversionDateTime: "2026-09-01T10:00:00-03:00" }, { gclid: "gclidAbc12345", conversionDateTime: bad }],
    });
    assert.equal(result.isError, true, `${bad}: ${textOf(result)}`);
    assert.match(textOf(result), new RegExp(`linha 2: conversionDateTime inválido \\("${bad.replace(/[.+]/g, "\\$&")}"\\)`));
    assert.equal(calls.queries.length + calls.dm.length, 0, `${bad}: nada chamado`);
  }
  const ok = fakeClient();
  const r = await call(ok.client, "upload_offline_conversions_data_manager", {
    conversions: [{ gclid: "gclidAbc12345", conversionDateTime: "2024-02-29T10:00:00.250Z" }],
  });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(((ok.calls.dm[0].body.events as Row[])[0]).eventTimestamp, "2024-02-29T10:00:00.250Z");
  const future = await call(fakeClient().client, "upload_offline_conversions_data_manager", {
    conversions: [{ gclid: "gclidAbc12345", conversionDateTime: "2099-01-01T00:00:00Z" }],
  });
  assert.match(textOf(future), /no futuro/);
});

test("get_data_manager_request_status: traduz status e oculta destinos fora da allowlist", async () => {
  const { client, calls } = fakeClient({
    dmStatus: () => ({
      requestStatusPerDestination: [
        {
          destination: { operatingAccount: { accountType: "GOOGLE_ADS", accountId: CID }, productDestinationId: ACTION_ID },
          requestStatus: "PARTIAL_SUCCESS",
          eventsIngestionStatus: { recordCount: "10" },
          errorInfo: { errorCounts: [{ reason: "PROCESSING_ERROR_REASON_INVALID_GCLID", recordCount: "2" }] },
        },
        { destination: { operatingAccount: { accountType: "GOOGLE_ADS", accountId: "7777777777" } }, requestStatus: "SUCCESS" },
      ],
    }),
  });
  const handlers = register(client, [CID], true);
  const result = await handlers.get("get_data_manager_request_status")!({ customerId: CID, requestId: "req-123" });
  const out = textOf(result);
  assert.deepEqual(calls.dmStatus, ["req-123"]);
  assert.match(out, /1 destino\(s\) ocultado\(s\)/);
  assert.match(out, /PARTIAL_SUCCESS/);
  assert.match(out, /PROCESSING_ERROR_REASON_INVALID_GCLID/);
  assert.doesNotMatch(out, /7777777777/);

  const bad = await handlers.get("get_data_manager_request_status")!({ customerId: CID, requestId: "x y&z" });
  assert.equal(bad.isError, true);
});

test("client: events:ingest vai para a Data Manager com o token, sem developer token, loginAccount e validateOnly em dry-run", async () => {
  const credentials = {
    token: "tok-abc", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token", client_id: "c", client_secret: "s",
    expiry: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  let reply: { status: number; body: unknown } = { status: 200, body: { requestId: "r1" } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({ credentials, developerToken: "dev", loginCustomerId: "999-000-1112", dryRun: true });
    const out = await client.dataManagerIngestEvents({ destinations: [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: CID } }], events: [] });
    assert.deepEqual(out, { requestId: "r1" });
    assert.equal(seen[0].url, "https://datamanager.googleapis.com/v1/events:ingest");
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer tok-abc");
    assert.equal(headers["developer-token"], undefined);
    const sent = JSON.parse(String(seen[0].init.body)) as Row;
    assert.equal(sent.validateOnly, true);
    assert.deepEqual((sent.destinations as Row[])[0].loginAccount, { accountType: "GOOGLE_ADS", accountId: MCC });

    await client.dataManagerRequestStatus("abc/123");
    assert.equal(seen[1].url, "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=abc%2F123");
    assert.equal(seen[1].init.method, "GET");

    reply = {
      status: 403,
      body: { error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    };
    await assert.rejects(() => client.dataManagerIngestEvents({ destinations: [], events: [] }), /PERMISSION_DENIED \(HTTP 403\).*ACCESS_TOKEN_SCOPE_INSUFFICIENT/);

    const readOnly = new GoogleAdsClient({ credentials, developerToken: "dev", loginCustomerId: MCC, readOnly: true });
    const before = seen.length;
    await assert.rejects(() => readOnly.dataManagerIngestEvents({ destinations: [], events: [] }), /read-only/);
    assert.equal(seen.length, before, "read-only bloqueia antes da rede");
  } finally {
    globalThis.fetch = original;
  }
});

// ── get_conversion_upload_health ──────────────────────────────────────

const CLIENT_SUMMARY = {
  offlineConversionUploadClientSummary: {
    client: "GOOGLE_ADS_API",
    status: "NEEDS_ATTENTION",
    totalEventCount: "200",
    successfulEventCount: "150",
    successRate: 0.75,
    pendingEventCount: "10",
    pendingRate: 0.05,
    lastUploadDateTime: "2026-09-22 10:00:00",
    dailySummaries: [{ uploadDate: "2026-09-22", successfulCount: "50", failedCount: "5", pendingCount: "1" }],
    jobSummaries: [{ jobId: "4242", successfulCount: "50", failedCount: "5" }],
    alerts: [
      { error: { conversionUploadError: "TOO_RECENT_EVENT" }, errorPercentage: 0.05 },
      { error: { conversionUploadError: "EVENT_NOT_FOUND" }, errorPercentage: 0.2 },
    ],
  },
};

test("get_conversion_upload_health: resume origem e ação, alertas ordenados com dica, conta de conversão incluída", async () => {
  const { client, calls } = fakeClient({
    customers: { [CID]: customer(CID, {}, { googleAdsConversionCustomer: `customers/${MCC}` }), [MCC]: customer(MCC) },
    rows: {
      offline_conversion_upload_client_summary: (_q, cid) => (cid === MCC ? [CLIENT_SUMMARY] : []),
      offline_conversion_upload_conversion_action_summary: (_q, cid) => (cid === MCC
        ? [{ offlineConversionUploadConversionActionSummary: { client: "GOOGLE_ADS_API", conversionActionId: ACTION_ID, conversionActionName: "Lead", status: "EXCELLENT", totalEventCount: "100", successfulEventCount: "99", pendingEventCount: "0", alerts: [] } }]
        : []),
    },
  });
  const result = await call(client, "get_conversion_upload_health", { conversionActionId: undefined });
  const out = textOf(result);
  assert.deepEqual([...new Set(calls.queries.filter((q) => q.query.includes("offline_conversion")).map((q) => q.cid))], [CID, MCC]);
  assert.match(out, /Precisa de atenção:/);
  assert.match(out, /conta 9990001112, origem Google Ads API.*EVENT_NOT_FOUND \(20%\)/);
  const json = JSON.parse(out.slice(out.indexOf("{"))) as { by_client: Row[]; by_conversion_action: Row[] };
  const summary = json.by_client[0];
  assert.equal(summary.success_rate_pct, 75);
  assert.equal(summary.pending_rate_pct, 5);
  assert.deepEqual((summary.alerts as Row[]).map((a) => a.code), ["EVENT_NOT_FOUND", "TOO_RECENT_EVENT"]);
  assert.match(String((summary.alerts as Row[])[0].hint), /lookup_gclid/);
  assert.deepEqual(summary.last_jobs, [{ job_id: "4242", successful: 50, failed: 5, pending: 0 }]);
  assert.equal(json.by_conversion_action[0].success_rate_pct, 99);

  // filtro por ação no WHERE e formato tabela
  const filtered = fakeClient();
  const table = await call(filtered.client, "get_conversion_upload_health", { format: "table", includeConversionCustomer: false });
  assert.ok(textOf(table).length > 0);
  const f2 = fakeClient();
  await call(f2.client, "get_conversion_upload_health", { conversionActionId: ACTION_ID });
  assert.ok(f2.calls.queries.some((q) => q.query.includes(`offline_conversion_upload_conversion_action_summary.conversion_action_id = ${ACTION_ID}`)));
  const bad = await call(fakeClient().client, "get_conversion_upload_health", { conversionActionId: "1 OR 1=1" });
  assert.equal(bad.isError, true);
});

test("get_conversion_upload_health: conta de conversão fora da allowlist não é consultada", async () => {
  const { client, calls } = fakeClient({
    customers: { [CID]: customer(CID, {}, { googleAdsConversionCustomer: `customers/${MCC}` }) },
  });
  const result = await call(client, "get_conversion_upload_health", {}, [CID], true);
  assert.match(textOf(result), /fora da allowlist/);
  assert.ok(calls.queries.every((q) => q.cid === CID));
});

// ── lookup_gclid ──────────────────────────────────────────────────────

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test("lookup_gclid: um dia por query, IN com escape, varredura para ao achar e resolve nomes de local", async () => {
  const hitDay = isoDaysAgo(3);
  const { client, calls } = fakeClient({
    rows: {
      click_view: (query) => (query.includes(`segments.date = '${hitDay}'`)
        ? [{
            clickView: {
              gclid: "gclidAchado123",
              adGroupAd: `customers/${CID}/adGroupAds/11~22`,
              keyword: `customers/${CID}/adGroupCriteria/11~33`,
              keywordInfo: { text: "seguro auto", matchType: "PHRASE" },
              locationOfPresence: { mostSpecific: "geoTargetConstants/1001773" },
              areaOfInterest: {},
              pageNumber: "1",
            },
            campaign: { id: "1", name: "Pesquisa" },
            adGroup: { id: "11", name: "Auto" },
            segments: { date: hitDay, device: "MOBILE", adNetworkType: "SEARCH", clickType: "URL_CLICKS" },
            metrics: { clicks: "1" },
          }]
        : []),
      geo_target_constant: [{ geoTargetConstant: { resourceName: "geoTargetConstants/1001773", canonicalName: "Sao Paulo,State of Sao Paulo,Brazil" } }],
    },
  });
  const result = await call(client, "lookup_gclid", { gclids: ["gclidAchado123", "gclidPendente456"], date: isoDaysAgo(1), lookbackDays: 5 });
  assert.notEqual(result.isError, true, textOf(result));
  const clickQueries = calls.queries.filter((q) => q.query.includes("FROM click_view"));
  assert.equal(clickQueries.length, 6, "procura date e os 5 dias antes (um não foi achado)");
  assert.match(clickQueries[0].query, /segments\.date = '[\d-]+'\s+AND click_view\.gclid IN \('gclidAchado123', 'gclidPendente456'\)/);
  assert.match(clickQueries[2].query, new RegExp(`segments.date = '${hitDay}'`));
  assert.match(clickQueries[3].query, /IN \('gclidPendente456'\)/, "depois de achar, só os pendentes");
  const out = textOf(result);
  assert.match(out, /1 de 2 GCLID\(s\) encontrado/);
  const json = JSON.parse(out.slice(out.indexOf("["))) as Row[];
  assert.equal(json[0].ad_id, "22");
  assert.deepEqual(json[0].keyword, { text: "seguro auto", match_type: "PHRASE", criterion: `customers/${CID}/adGroupCriteria/11~33` });
  assert.equal(json[0].location_of_presence, "Sao Paulo,State of Sao Paulo,Brazil (geoTargetConstants/1001773)");
  assert.equal(json[1].found, false);
});

test("lookup_gclid: recusa data antiga, futura, GCLID malformado e lookback fora do limite", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ gclids: "gclidValido123", date: isoDaysAgo(95) }, /90 dias/],
    [{ gclids: "gclidValido123", date: isoDaysAgo(-2) }, /futuro/],
    [{ gclids: "gclid com espaço", date: isoDaysAgo(1) }, /formato inválido/],
    [{ gclids: "gclid'OR'1'='1", date: isoDaysAgo(1) }, /formato inválido/],
    [{ gclids: "gclidValido123", date: "01/09/2026" }, /YYYY-MM-DD/],
    [{ gclids: "gclidValido123", date: isoDaysAgo(1), lookbackDays: 31 }, /entre 0 e 30/],
    [{ gclids: [], date: isoDaysAgo(1) }, /ao menos um/],
  ];
  for (const [args, expected] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "lookup_gclid", args);
    assert.equal(result.isError, true, String(expected));
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length, 0);
  }
});

// ── get_call_details ──────────────────────────────────────────────────

test("get_call_details: filtros no WHERE, perdidas e curtas no resumo", async () => {
  const callRow = (status: string, duration: string, campaign = "1") => ({
    callView: { startCallDateTime: "2026-09-20 10:00:00", endCallDateTime: "2026-09-20 10:01:00", callDurationSeconds: duration, callStatus: status, callerCountryCode: "BR", callerAreaCode: "11", callTrackingDisplayLocation: "AD", type: "HIGH_END_MOBILE_SEARCH" },
    campaign: { id: campaign, name: `Campanha ${campaign}` },
    adGroup: { id: "9", name: "Grupo" },
  });
  const { client, calls } = fakeClient({ rows: { call_view: [callRow("MISSED", "0"), callRow("RECEIVED", "20"), callRow("RECEIVED", "200", "2")] } });
  const result = await call(client, "get_call_details", {
    dateRange: { since: "2026-09-01", until: "2026-09-22" }, campaignId: "1", callStatus: "RECEIVED", minDurationSeconds: 5, maxDurationSeconds: 600, limit: 100,
  });
  const query = calls.queries[0].query;
  assert.match(query, /call_view\.start_call_date_time >= '2026-09-01 00:00:00'/);
  assert.match(query, /call_view\.start_call_date_time <= '2026-09-22 23:59:59'/);
  assert.match(query, /campaign\.id = 1/);
  assert.match(query, /call_view\.call_status = 'RECEIVED'/);
  assert.match(query, /call_view\.call_duration_seconds >= 5/);
  assert.match(query, /call_view\.call_duration_seconds <= 600/);
  assert.match(query, /ORDER BY call_view\.start_call_date_time DESC\s+LIMIT 100/);
  const out = textOf(result);
  assert.match(out, /3 chamada\(s\).*1 perdida\(s\) \(33\.33%\), 2 atendida\(s\)/s);
  const json = JSON.parse(out.slice(out.indexOf("{"))) as { summary: Row };
  assert.equal(json.summary.short_received_under_60s, 1);
  assert.equal(json.summary.avg_duration_received_s, 110);
  assert.equal((json.summary.by_campaign as Row[])[0].campaign_id, "1");

  const csv = await call(fakeClient({ rows: { call_view: [callRow("MISSED", "0")] } }).client, "get_call_details", { format: "csv" });
  assert.match(textOf(csv), /^start,end,duration_s,status/);

  for (const args of [{ minDurationSeconds: 10, maxDurationSeconds: 5 }, { limit: 0 }, { days: 0 }, { campaignId: "1 OR 1=1" }, { dateRange: { since: "2026-09-10", until: "2026-09-01" } }]) {
    const bad = fakeClient();
    const r = await call(bad.client, "get_call_details", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(bad.calls.queries.length, 0);
  }
});
