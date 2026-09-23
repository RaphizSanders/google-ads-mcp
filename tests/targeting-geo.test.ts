/**
 * Lote targeting-geo: segmentação geográfica e de idioma.
 *
 * O que estes testes fixam:
 * - set_campaign_languages recusa idioma em Pesquisa (removido pelo Google no fim de set/2026),
 *   limpa os legados só com confirm, resolve códigos em language_constant.code, faz replace
 *   atômico, avisa sobre PMax e roteia Demand Gen com segmentação aprimorada para os grupos;
 * - set_geo_target_type manda só as folhas que mudam no updateMask e devolve antes/depois;
 * - add_proximity_target / add_location_group_target montam o payload da v25, pulam duplicados e
 *   traduzem os erros do Google; remove_campaign_geo_targets exige confirm e protege contra
 *   "mundo todo";
 * - set_campaign_locations lê antes, só grava a diferença e mantém o que continua;
 * - get_geo_performance / get_campaign_geo_targeting / list_geo_targets montam GAQL válido.
 *
 * Toda query passa por assertGaqlRules (metadados reais da v25). O client falso filtra as linhas
 * pelo WHERE (campaign.id, tipo, IDs), para que ID inexistente seja de fato inexistente — com
 * igualdade exata, porque `=`/`IN` do GAQL diferenciam maiúsculas ('PT' não acha 'pt').
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerGoogleAdsTools } from "../src/tools.js";
import { explainCriterionError } from "../src/tools/targeting-geo.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "111";

// ── Client falso ──────────────────────────────────────────────────────

interface Write {
  resource: string;
  operations: Row[];
  options?: Row;
  dryRun: boolean;
}

interface FakeOptions {
  rows?: Record<string, Row[]>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function valueAt(row: Row, field: string): unknown {
  return field.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Row)[camel(part)] : undefined), row);
}

/** Valores de `field IN (...)` ou `field = x` no WHERE; null quando o campo não filtra. */
function whereValues(query: string, field: string): string[] | null {
  const escaped = field.replace(/\./g, "\\.");
  const inMatch = new RegExp(`${escaped}\\s+IN\\s*\\(([^)]*)\\)`).exec(query);
  if (inMatch) return inMatch[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "").replace(/\\'/g, "'"));
  const eqMatch = new RegExp(`${escaped}\\s*=\\s*('(?:\\\\.|[^'])*'|[^\\s)]+)`).exec(query);
  if (eqMatch) return [eqMatch[1].replace(/^'|'$/g, "")];
  return null;
}

const FILTER_FIELDS: Record<string, string[]> = {
  campaign: ["campaign.id"],
  campaign_criterion: ["campaign.id", "campaign_criterion.type", "campaign_criterion.resource_name"],
  geo_target_constant: ["geo_target_constant.id", "geo_target_constant.country_code", "geo_target_constant.target_type"],
  language_constant: ["language_constant.id", "language_constant.code"],
  ad_group: ["campaign.id"],
  ad_group_criterion: ["campaign.id", "ad_group_criterion.type"],
  asset_set: ["asset_set.id"],
};

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[] };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      let rows = opts.rows?.[from] ?? [];
      for (const field of FILTER_FIELDS[from] ?? []) {
        const wanted = whereValues(query, field);
        if (!wanted) continue;
        // Igualdade exata, como o GAQL: `=` e `IN` diferenciam maiúsculas em string
        // (developers.google.com/google-ads/api/docs/query/case-sensitivity).
        rows = rows.filter((row) => {
          const value = String(valueAt(row, field) ?? "");
          return wanted.some((w) => w === value);
        });
      }
      return rows;
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations, options);
      if (dryRun) return {};
      return {
        results: operations.map((op, i) => ({
          resourceName: String(op.remove ?? (op.update as Row | undefined)?.resourceName ?? `customers/${CID}/${resource}/${CAMPAIGN_ID}~90${i}`),
        })),
      };
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
    false
  );
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = body.search(/\n[[{]/);
  return JSON.parse(body.slice(start + 1)) as Row;
}

// ── Fixtures ──────────────────────────────────────────────────────────

function campaignRow(overrides: Row = {}, id = CAMPAIGN_ID): Row {
  return {
    campaign: {
      id,
      name: `Campanha ${id}`,
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE_OR_INTEREST", negativeGeoTargetType: "PRESENCE" },
      ...overrides,
    },
  };
}

function criterion(criterionId: string, type: string, fields: Row = {}, campaignId = CAMPAIGN_ID): Row {
  return {
    campaign: { id: campaignId },
    campaignCriterion: {
      resourceName: `customers/${CID}/campaignCriteria/${campaignId}~${criterionId}`,
      criterionId,
      type,
      ...fields,
    },
  };
}

const location = (criterionId: string, geoId: string, extra: Row = {}) =>
  criterion(criterionId, "LOCATION", { location: { geoTargetConstant: `geoTargetConstants/${geoId}` }, ...extra });
const language = (criterionId: string, langId: string) =>
  criterion(criterionId, "LANGUAGE", { language: { languageConstant: `languageConstants/${langId}` } });

const GEO: Row[] = [
  { geoTargetConstant: { id: "2076", name: "Brazil", canonicalName: "Brazil", targetType: "Country", countryCode: "BR", status: "ENABLED" } },
  { geoTargetConstant: { id: "20106", name: "State of Sao Paulo", canonicalName: "State of Sao Paulo,Brazil", targetType: "State", countryCode: "BR", status: "ENABLED" } },
  { geoTargetConstant: { id: "1001773", name: "Sao Paulo", canonicalName: "Sao Paulo,State of Sao Paulo,Brazil", targetType: "City", countryCode: "BR", status: "ENABLED" } },
  { geoTargetConstant: { id: "1001566", name: "Campinas", canonicalName: "Campinas,State of Sao Paulo,Brazil", targetType: "City", countryCode: "BR", status: "ENABLED" } },
];

// Códigos na forma real do language_constant: base minúscula, região maiúscula ('zh_CN').
const LANGUAGES: Row[] = [
  { languageConstant: { id: "1014", code: "pt", name: "Portuguese", targetable: true } },
  { languageConstant: { id: "1003", code: "es", name: "Spanish", targetable: true } },
  { languageConstant: { id: "1000", code: "en", name: "English", targetable: true } },
  { languageConstant: { id: "1017", code: "zh_CN", name: "Chinese (simplified)", targetable: true } },
];

// ── set_campaign_languages (item 1) ───────────────────────────────────

test("set_campaign_languages: Pesquisa é recusada sem gravar e explica o idioma do anúncio", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [campaignRow()], campaign_criterion: [language("5", "1014")], language_constant: LANGUAGES },
  });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["pt"] });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 0);
  const body = textOf(result);
  assert.match(body, /OPERATION_NOT_PERMITTED_FOR_CONTEXT/);
  assert.match(body, /idioma do próprio\s+anúncio/);
  assert.match(body, /cleanup=true/);
  assert.deepEqual((jsonOf(result).legacy_language_criteria as Row[]).map((l) => l.criterion_id), ["5"]);
  assert.ok(!calls.queries.some((q) => /FROM language_constant(?!\s+WHERE)/.test(q)), "em Pesquisa o código pedido nem é resolvido");
});

test("set_campaign_languages: limpeza dos legados em Pesquisa só com confirm, numa requisição", async () => {
  const rows = { campaign: [campaignRow()], campaign_criterion: [language("5", "1014"), language("6", "1000")], language_constant: LANGUAGES };
  const preview = fakeClient({ rows });
  const previewResult = await call(preview.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, cleanup: true });
  assert.equal(previewResult.isError, true);
  assert.match(textOf(previewResult), /prévia/);
  assert.equal(preview.calls.writes.length, 0, "sem confirm não grava");

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, cleanup: true, confirm: true });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "campaignCriteria");
  assert.deepEqual(calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~5` },
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~6` },
  ]);
  assert.equal(calls.writes[0].options, undefined, "remoção atômica, sem partialFailure");

  const empty = fakeClient({ rows: { campaign: [campaignRow()], language_constant: LANGUAGES } });
  const noop = await call(empty.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, cleanup: true, confirm: true });
  assert.match(textOf(noop), /não há critérios de idioma/);
  assert.equal(empty.calls.writes.length, 0);
});

test("set_campaign_languages: PMax resolve códigos, cria só o que falta e avisa que não vale na Pesquisa", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "PERFORMANCE_MAX" })],
      campaign_criterion: [language("5", "1014")],
      language_constant: LANGUAGES,
    },
  });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["pt", "ES"] });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations, [
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, language: { languageConstant: "languageConstants/1003" } } },
  ]);
  const body = jsonOf(result);
  assert.match(String((body.warnings as string[])[0]), /YouTube, Display, Discover e Gmail/);
  assert.deepEqual((body.after as Row[]).map((l) => l.code), ["pt", "es"]);
});

test("set_campaign_languages: código sem diferenciar maiúsculas ('PT', 'Es', 'zh-cn') resolve na forma real", async () => {
  // O fake compara com igualdade exata, como o GAQL: um `code IN ('PT')` não acharia 'pt'.
  const { client, calls } = fakeClient({
    rows: { campaign: [campaignRow({ advertisingChannelType: "PERFORMANCE_MAX" })], language_constant: LANGUAGES },
  });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["PT", "Es", "zh-cn", "pt"] });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations.map((op) => ((op.create as Row).language as Row).languageConstant), [
    "languageConstants/1014",
    "languageConstants/1003",
    "languageConstants/1017",
  ], "'PT' e 'pt' são o mesmo idioma: um critério só");
  assert.deepEqual((jsonOf(result).after as Row[]).map((l) => l.code), ["pt", "es", "zh_CN"]);
  // Nenhuma comparação de código por string no GAQL (seria case-sensitive).
  assert.ok(!calls.queries.some((q) => /language_constant\.code\s*(=|IN\b|LIKE)/i.test(q)));

  for (const code of ["ES", "ZH_CN"]) {
    const display = fakeClient({ rows: { campaign: [campaignRow({ advertisingChannelType: "DISPLAY" })], language_constant: LANGUAGES } });
    const ok = await call(display.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: [code] });
    assert.notEqual(ok.isError, true, `${code}: ${textOf(ok)}`);
    assert.equal(display.calls.writes.length, 1, code);
  }

  // Idioma que existe mas não é segmentável continua explicado como tal (a leitura não filtra targetable).
  const locked = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "DISPLAY" })],
      language_constant: [...LANGUAGES, { languageConstant: { id: "1999", code: "xx_YY", name: "Teste", targetable: false } }],
    },
  });
  const refused = await call(locked.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["XX-yy"] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Teste \(xx_YY\) não é segmentável/);
  assert.equal(locked.calls.writes.length, 0);
});

test("set_campaign_languages: adGroupIds fora de Demand Gen aprimorado é recusado — não vira escrita na campanha inteira", async () => {
  const withGroups = (overrides: Row) => ({
    campaign: [campaignRow(overrides)],
    campaign_criterion: [language("5", "1014")],
    ad_group: [{ campaign: { id: CAMPAIGN_ID }, adGroup: { id: "31", name: "Grupo A", status: "ENABLED" } }],
    language_constant: LANGUAGES,
  });
  for (const [overrides, args] of [
    [{ advertisingChannelType: "DISPLAY" }, { languageIds: ["1003"] }],
    [{ advertisingChannelType: "PERFORMANCE_MAX" }, { languageCodes: ["es"], replace: true }],
    [{ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: false } }, { languageCodes: ["es"] }],
    [{ advertisingChannelType: "SEARCH" }, { cleanup: true, confirm: true }],
  ] as Array<[Row, Row]>) {
    const { client, calls } = fakeClient({ rows: withGroups(overrides) });
    const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, adGroupIds: ["31"], ...args });
    const label = JSON.stringify({ overrides, args });
    assert.equal(result.isError, true, label);
    assert.equal(calls.writes.length, 0, `nenhuma escrita: ${label}`);
    assert.match(textOf(result), /adGroupIds só vale para Demand Gen com segmentação aprimorada/, label);
    assert.match(textOf(result), /reenvie sem adGroupIds/, label);
  }

  // Controle: a mesma chamada sem adGroupIds grava no nível da campanha, como pedido.
  const { client, calls } = fakeClient({ rows: withGroups({ advertisingChannelType: "DISPLAY" }) });
  await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageIds: ["1003"] });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "campaignCriteria");
});

test("set_campaign_languages: replace é atômico (remove + cria na mesma requisição) e no-op não grava", async () => {
  const rows = {
    campaign: [campaignRow({ advertisingChannelType: "DISPLAY" })],
    campaign_criterion: [language("5", "1014"), language("6", "1000")],
    language_constant: LANGUAGES,
  };
  const { client, calls } = fakeClient({ rows });
  await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageIds: ["1014", "1003"], replace: true });
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~6` },
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, language: { languageConstant: "languageConstants/1003" } } },
  ]);
  assert.equal(calls.writes[0].options, undefined);

  const same = fakeClient({ rows });
  const noop = await call(same.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageIds: ["1014"] });
  assert.match(textOf(noop), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);
});

test("set_campaign_languages: entrada inválida é recusada antes de qualquer chamada", async () => {
  for (const args of [
    { campaignId: "111 OR campaign.id > 0", languageIds: ["1014"] },
    { campaignId: CAMPAIGN_ID, languageCodes: ["português"] },
    { campaignId: CAMPAIGN_ID, languageIds: ["10a4"] },
    { campaignId: CAMPAIGN_ID, cleanup: true, languageIds: ["1014"] },
    { campaignId: CAMPAIGN_ID },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_campaign_languages", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0, `nenhuma query para ${JSON.stringify(args)}`);
  }
});

test("set_campaign_languages: código inexistente é recusado; CANNOT_TARGET_LANGUAGE vem explicado", async () => {
  const rows = { campaign: [campaignRow({ advertisingChannelType: "PERFORMANCE_MAX" })], language_constant: LANGUAGES };
  const unknown = fakeClient({ rows });
  const result = await call(unknown.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["xx"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /"xx" não existe/);
  assert.equal(unknown.calls.writes.length, 0);

  const rejected = fakeClient({
    rows,
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The criterion is not allowed to be targeted for the language."); },
  });
  const err = await call(rejected.client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["es"] });
  assert.equal(err.isError, true);
  assert.match(textOf(err), /valida o idioma contra o país/);
});

test("set_campaign_languages: Demand Gen com segmentação aprimorada grava nos grupos, não na campanha", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: true } })],
      ad_group: [
        { campaign: { id: CAMPAIGN_ID }, adGroup: { id: "31", name: "Grupo A", status: "ENABLED" } },
        { campaign: { id: CAMPAIGN_ID }, adGroup: { id: "32", name: "Grupo B", status: "PAUSED" } },
      ],
      ad_group_criterion: [{
        campaign: { id: CAMPAIGN_ID },
        adGroup: { id: "31", name: "Grupo A" },
        adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/31~7`, criterionId: "7", type: "LANGUAGE", language: { languageConstant: "languageConstants/1014" } },
      }],
      language_constant: LANGUAGES,
    },
  });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["pt"] });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "adGroupCriteria");
  assert.deepEqual(calls.writes[0].operations, [
    { create: { adGroup: `customers/${CID}/adGroups/32`, language: { languageConstant: "languageConstants/1014" } } },
  ]);
  assert.equal(jsonOf(result).routed_to, "ad_group_criterion");
});

test("set_campaign_languages: validateOnly valida no client em dry-run e não afirma gravação", async () => {
  const { client, calls } = fakeClient({
    rows: { campaign: [campaignRow({ advertisingChannelType: "DISPLAY" })], language_constant: LANGUAGES },
  });
  const result = await call(client, "set_campaign_languages", { campaignId: CAMPAIGN_ID, languageCodes: ["pt"], validateOnly: true });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
});

// ── set_geo_target_type (item 40) ─────────────────────────────────────

test("set_geo_target_type: só a folha que muda vai no updateMask, com antes/depois", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()] } });
  const result = await call(client, "set_geo_target_type", { campaignId: CAMPAIGN_ID, positive: "PRESENCE", negative: "PRESENCE" });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  const { resource, operations, options } = calls.writes[0];
  assert.equal(resource, "campaigns");
  assert.deepEqual(options, { partialFailure: true });
  const op = operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "geo_target_type_setting.positive_geo_target_type", "negative já era PRESENCE: fica fora do mask");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update, { resourceName: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } });
  const changed = (jsonOf(result).changed as Row[])[0];
  assert.deepEqual(changed.before, { positive: "PRESENCE_OR_INTEREST", negative: "PRESENCE" });
  assert.deepEqual(changed.after, { positive: "PRESENCE", negative: "PRESENCE" });
});

test("set_geo_target_type: no-op, enum inválido, campanha inexistente e escala sem confirm não gravam", async () => {
  const same = fakeClient({ rows: { campaign: [campaignRow({ geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" } })] } });
  const noop = await call(same.client, "set_geo_target_type", { campaignId: CAMPAIGN_ID, positive: "PRESENCE" });
  assert.match(textOf(noop), /Nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const badEnum = fakeClient({ rows: { campaign: [campaignRow()] } });
  const bad = await call(badEnum.client, "set_geo_target_type", { campaignId: CAMPAIGN_ID, positive: "SEARCH_INTEREST" });
  assert.equal(bad.isError, true);
  assert.equal(badEnum.calls.queries.length, 0);

  const missing = fakeClient({ rows: { campaign: [campaignRow()] } });
  const notFound = await call(missing.client, "set_geo_target_type", { campaignIds: [CAMPAIGN_ID, "999"], positive: "PRESENCE" });
  assert.equal(notFound.isError, true);
  assert.match(textOf(notFound), /999/);
  assert.equal(missing.calls.writes.length, 0);

  const ids = Array.from({ length: 11 }, (_, i) => String(200 + i));
  const many = fakeClient({ rows: { campaign: ids.map((id) => campaignRow({}, id)) } });
  const scale = await call(many.client, "set_geo_target_type", { campaignIds: ids, positive: "PRESENCE" });
  assert.equal(scale.isError, true);
  assert.match(textOf(scale), /confirm: true/);
  assert.equal(many.calls.writes.length, 0);
  await call(many.client, "set_geo_target_type", { campaignIds: ids, positive: "PRESENCE", confirm: true });
  assert.equal(many.calls.writes.length, 1);
  assert.equal(many.calls.writes[0].operations.length, 11);
});

test("set_geo_target_type: falha parcial é relatada por campanha", async () => {
  const { client } = fakeClient({
    rows: { campaign: [campaignRow({}, "201"), campaignRow({}, "202")] },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaigns/201` }, {}],
      partialFailureError: {
        details: [{ errors: [{
          errorCode: { contextError: "OPERATION_NOT_PERMITTED_FOR_CONTEXT" },
          message: "The operation is not allowed for the given context.",
          location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
        }] }],
      },
    }),
  });
  const result = await call(client, "set_geo_target_type", { campaignIds: ["201", "202"], positive: "PRESENCE" });
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.deepEqual((body.changed as Row[]).map((c) => c.campaign_id), ["201"]);
  assert.equal((body.errors as Row[])[0].campaign_id, "202");
  assert.match(String((body.errors as Row[])[0].error), /OPERATION_NOT_PERMITTED_FOR_CONTEXT/);
});

// ── add_proximity_target (item 84) ────────────────────────────────────

test("add_proximity_target: lat/lng em micrograus, km por padrão, ajuste de lance e ponto relido", async () => {
  // A API grava o critério; a releitura depois da escrita o encontra.
  const stored: Row[] = [];
  const { client, calls } = fakeClient({
    rows: { campaign: [campaignRow()], campaign_criterion: stored },
    mutate: (_resource, operations) => {
      operations.forEach((op, i) => stored.push(criterion(`90${i}`, "PROXIMITY", { proximity: (op.create as Row).proximity })));
      return { results: operations.map((_, i) => ({ resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~90${i}` })) };
    },
  });
  const result = await call(client, "add_proximity_target", {
    campaignId: CAMPAIGN_ID,
    targets: [{ latitude: -23.561414, longitude: -46.655881, radius: 5, bidModifier: 1.2, label: "Paulista" }],
  });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.deepEqual(calls.writes[0].operations, [{
    create: {
      campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`,
      proximity: { radius: 5, radiusUnits: "KILOMETERS", geoPoint: { latitudeInMicroDegrees: -23561414, longitudeInMicroDegrees: -46655881 } },
      bidModifier: 1.2,
    },
  }]);
  const body = jsonOf(result);
  const item = (body.created as Row[])[0];
  assert.equal(item.criterion_id, "900");
  assert.equal(item.label, "Paulista");
  assert.deepEqual(item.stored, { latitude: -23.561414, longitude: -46.655881, radius: 5, radius_units: "KILOMETERS" });
  assert.ok(calls.queries.some((q) => /campaign_criterion\.resource_name IN/.test(q)), "relê o critério criado");
  assert.match(String((body.warnings as string[])[0]), /PRESENCE/);
});

test("add_proximity_target: endereço exige país e vai no AddressInfo; alvos inválidos não chamam a API", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()] } });
  await call(client, "add_proximity_target", {
    campaignId: CAMPAIGN_ID,
    targets: [{ streetAddress: "Av. Paulista, 1000", cityName: "São Paulo", postalCode: "01310-100", provinceCode: "sp", countryCode: "br", radius: 3, radiusUnits: "MILES" }],
  });
  assert.deepEqual((calls.writes[0].operations[0] as { create: Row }).create.proximity, {
    radius: 3,
    radiusUnits: "MILES",
    address: { streetAddress: "Av. Paulista, 1000", cityName: "São Paulo", postalCode: "01310-100", provinceCode: "SP", countryCode: "BR" },
  });

  for (const target of [
    { latitude: 91, longitude: 0, radius: 5 },
    { latitude: -23.5, radius: 5 },
    { latitude: -23.5, longitude: -46.6, radius: 0 },
    { radius: 5 },
    { cityName: "São Paulo", radius: 5 },
    { latitude: -23.5, longitude: -46.6, radius: 5, bidModifier: 20 },
    { latitude: -23.5, longitude: -46.6, radius: 5, radiusUnits: "FEET" },
  ]) {
    const fake = fakeClient({ rows: { campaign: [campaignRow()] } });
    const result = await call(fake.client, "add_proximity_target", { campaignId: CAMPAIGN_ID, targets: [target] });
    assert.equal(result.isError, true, JSON.stringify(target));
    assert.equal(fake.calls.queries.length, 0, `nenhuma chamada para ${JSON.stringify(target)}`);
  }
});

test("add_proximity_target: raio idêntico existente não é recriado; erro do Google por alvo vem em PT-BR", async () => {
  const existing = criterion("800", "PROXIMITY", { proximity: { geoPoint: { latitudeInMicroDegrees: -23561414, longitudeInMicroDegrees: -46655881 }, radius: 5, radiusUnits: "KILOMETERS" } });
  const dup = fakeClient({ rows: { campaign: [campaignRow()], campaign_criterion: [existing] } });
  const noop = await call(dup.client, "add_proximity_target", { campaignId: CAMPAIGN_ID, targets: [{ latitude: -23.561414, longitude: -46.655881, radius: 5 }] });
  assert.match(textOf(noop), /nada a fazer/);
  assert.equal(dup.calls.writes.length, 0);

  const partial = fakeClient({
    rows: { campaign: [campaignRow({ geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } })] },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~901` }, {}],
      partialFailureError: {
        details: [{ errors: [{
          errorCode: { criterionError: "INVALID_PROXIMITY_ADDRESS" },
          message: "The Proximity address cannot be geocoded to a valid lat/long.",
          location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
        }] }],
      },
    }),
  });
  const result = await call(partial.client, "add_proximity_target", {
    campaignId: CAMPAIGN_ID,
    targets: [
      { latitude: -22.9, longitude: -47.06, radius: 10 },
      { streetAddress: "Rua Inexistente, 0", cityName: "Lugar Nenhum", countryCode: "BR", radius: 10 },
    ],
  });
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.equal((body.created as Row[]).length, 1);
  assert.match(String((body.errors as Row[])[0].error), /não conseguiu geocodificar/);
});

test("add_proximity_target: dry-run valida sem reler e sem afirmar criação", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()] }, dryRun: true });
  const result = await call(client, "add_proximity_target", { campaignId: CAMPAIGN_ID, targets: [{ latitude: -23.5, longitude: -46.6, radius: 2 }] });
  assert.match(textOf(result), /DRY-RUN.*nada foi gravado/);
  assert.equal(calls.writes[0].dryRun, true);
  assert.ok(!calls.queries.some((q) => /resource_name IN/.test(q)));
  assert.deepEqual((jsonOf(result).validated as Row[]).length, 1);
});

// ── add_location_group_target (item 84) ───────────────────────────────

test("add_location_group_target: asset sets de locais, km convertido para metros", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "PERFORMANCE_MAX" })],
      asset_set: [{ assetSet: { id: "71", name: "Lojas SP", type: "STATIC_LOCATION_GROUP", status: "ENABLED" } }],
    },
  });
  const result = await call(client, "add_location_group_target", { campaignId: CAMPAIGN_ID, assetSetIds: ["71"], radius: 2.5, radiusUnits: "KILOMETERS" });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.writes[0].operations, [{
    create: {
      campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`,
      locationGroup: { radius: "2500", radiusUnits: "METERS", locationGroupAssetSets: [`customers/${CID}/assetSets/71`] },
    },
  }]);
  assert.match(textOf(result), /2\.5 KILOMETERS → 2500 METERS/);
});

test("add_location_group_target: forma ambígua, asset set errado, conta sem locais e duplicado não gravam", async () => {
  for (const args of [
    { campaignId: CAMPAIGN_ID, radius: 1000 },
    { campaignId: CAMPAIGN_ID, radius: 1000, assetSetIds: ["71"], useCustomerLocations: true },
    { campaignId: CAMPAIGN_ID, radius: -1, useCustomerLocations: true },
    { campaignId: CAMPAIGN_ID, radius: 10, radiusUnits: "FEET", useCustomerLocations: true },
  ]) {
    const fake = fakeClient();
    const result = await call(fake.client, "add_location_group_target", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(fake.calls.queries.length, 0);
  }

  const wrongType = fakeClient({ rows: { campaign: [campaignRow()], asset_set: [{ assetSet: { id: "72", name: "Feed", type: "PAGE_FEED", status: "ENABLED" } }] } });
  const wrong = await call(wrongType.client, "add_location_group_target", { campaignId: CAMPAIGN_ID, assetSetIds: ["72"], radius: 1000 });
  assert.equal(wrong.isError, true);
  assert.match(textOf(wrong), /PAGE_FEED, não um conjunto de locais/);
  assert.equal(wrongType.calls.writes.length, 0);

  const noSync = fakeClient({ rows: { campaign: [campaignRow()] } });
  const noLocations = await call(noSync.client, "add_location_group_target", { campaignId: CAMPAIGN_ID, useCustomerLocations: true, radius: 1000 });
  assert.equal(noLocations.isError, true);
  assert.match(textOf(noLocations), /LOCATION_SYNC/);
  assert.equal(noSync.calls.writes.length, 0);

  const withSync = fakeClient({
    rows: {
      campaign: [campaignRow()],
      customer_asset_set: [{ customerAssetSet: { assetSet: `customers/${CID}/assetSets/70`, status: "ENABLED" }, assetSet: { id: "70", type: "LOCATION_SYNC" } }],
      campaign_criterion: [criterion("850", "LOCATION_GROUP", { locationGroup: { radius: "1000", radiusUnits: "METERS", enableCustomerLevelLocationAssetSet: true } })],
    },
  });
  const duplicate = await call(withSync.client, "add_location_group_target", { campaignId: CAMPAIGN_ID, useCustomerLocations: true, radius: 1, radiusUnits: "KILOMETERS" });
  assert.match(textOf(duplicate), /idêntico já existe/);
  assert.equal(withSync.calls.writes.length, 0);
  await call(withSync.client, "add_location_group_target", { campaignId: CAMPAIGN_ID, useCustomerLocations: true, radius: 2, radiusUnits: "MILES" });
  assert.deepEqual((withSync.calls.writes[0].operations[0] as { create: Row }).create.locationGroup, {
    radius: "2000", radiusUnits: "MILLI_MILES", enableCustomerLevelLocationAssetSet: true,
  });
});

// ── remove_campaign_geo_targets ───────────────────────────────────────

test("remove_campaign_geo_targets: prévia sem confirm, remoção atômica com confirm", async () => {
  const rows = {
    campaign: [campaignRow()],
    campaign_criterion: [location("10", "20106"), location("11", "1001773"), criterion("12", "PROXIMITY", { proximity: { radius: 5, radiusUnits: "KILOMETERS" } })],
    geo_target_constant: GEO,
  };
  const preview = fakeClient({ rows });
  const previewResult = await call(preview.client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["11", "12"] });
  assert.equal(previewResult.isError, true);
  assert.match(textOf(previewResult), /prévia/);
  assert.equal(preview.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["11", "12"], confirm: true });
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~11` },
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~12` },
  ]);
  assert.equal(calls.writes[0].options, undefined);
  assert.equal((jsonOf(result).removed as Row[])[0].name, "Sao Paulo,State of Sao Paulo,Brazil");
});

test("remove_campaign_geo_targets: critério de fora e 'mundo todo' são recusados", async () => {
  const rows = { campaign: [campaignRow()], campaign_criterion: [location("10", "20106"), location("13", "1001566", { negative: true })], geo_target_constant: GEO };
  const foreign = fakeClient({ rows });
  const notOurs = await call(foreign.client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["99"], confirm: true });
  assert.equal(notOurs.isError, true);
  assert.match(textOf(notOurs), /99 não são critérios geográficos/);
  assert.equal(foreign.calls.writes.length, 0);

  const world = fakeClient({ rows });
  const worldwide = await call(world.client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["10"], confirm: true });
  assert.equal(worldwide.isError, true);
  assert.match(textOf(worldwide), /MUNDO TODO/);
  assert.equal(world.calls.writes.length, 0);

  const allowed = fakeClient({ rows });
  await call(allowed.client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["10"], confirm: true, allowWorldwide: true });
  assert.equal(allowed.calls.writes.length, 1);

  // Remover só a exclusão não mexe na segmentação positiva: passa sem allowWorldwide.
  const exclusion = fakeClient({ rows });
  await call(exclusion.client, "remove_campaign_geo_targets", { campaignId: CAMPAIGN_ID, criterionIds: ["13"], confirm: true });
  assert.equal(exclusion.calls.writes.length, 1);
});

// ── set_campaign_locations ────────────────────────────────────────────

test("set_campaign_locations: ID inexistente é recusado; adicionar pula o que já existe", async () => {
  const rows = { campaign: [campaignRow()], campaign_criterion: [location("10", "20106")], geo_target_constant: GEO };
  const unknown = fakeClient({ rows });
  const bad = await call(unknown.client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["20106", "99999"] });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /99999/);
  assert.equal(unknown.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["20106", "1001773"] });
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations, [
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, location: { geoTargetConstant: "geoTargetConstants/1001773" }, negative: false } },
  ]);
  const body = jsonOf(result);
  assert.deepEqual((body.already_present as Row[]).map((l) => l.id), ["20106"]);
  assert.match(String((body.warnings as string[]).join(" ")), /set_geo_target_type positive=PRESENCE/);

  const same = fakeClient({ rows });
  const noop = await call(same.client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["20106"] });
  assert.match(textOf(noop), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);
});

test("set_campaign_locations: replace mantém o que continua, remove só a mesma polaridade, numa requisição", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow()],
      campaign_criterion: [location("10", "20106", { bidModifier: 1.3 }), location("11", "2076"), location("13", "1001566", { negative: true })],
      geo_target_constant: GEO,
    },
  });
  await call(client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["20106", "1001773"], replace: true });
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~11` },
    { create: { campaign: `customers/${CID}/campaigns/${CAMPAIGN_ID}`, location: { geoTargetConstant: "geoTargetConstants/1001773" }, negative: false } },
  ], "20106 (com ajuste de lance) fica; a exclusão 13 não é tocada");
  assert.equal(calls.writes[0].options, undefined, "atômico");
});

test("set_campaign_locations: local do outro lado (segmentado x excluído) é recusado sem gravar", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow()], campaign_criterion: [location("10", "20106")], geo_target_constant: GEO } });
  const result = await call(client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["20106"], negative: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /CANNOT_TARGET_AND_EXCLUDE/);
  assert.equal(calls.writes.length, 0);
});

test("set_campaign_locations: Demand Gen com segmentação aprimorada vai para os grupos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: true } })],
      ad_group: [{ campaign: { id: CAMPAIGN_ID }, adGroup: { id: "31", name: "Grupo A", status: "ENABLED" } }],
      geo_target_constant: GEO,
    },
  });
  const result = await call(client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["2076"] });
  assert.notEqual(result.isError, true);
  assert.equal(calls.writes[0].resource, "adGroupCriteria");
  assert.deepEqual(calls.writes[0].operations, [
    { create: { adGroup: `customers/${CID}/adGroups/31`, location: { geoTargetConstant: "geoTargetConstants/2076" }, negative: false } },
  ]);

  const foreign = fakeClient({
    rows: { campaign: [campaignRow({ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: true } })], ad_group: [], geo_target_constant: GEO },
  });
  const refused = await call(foreign.client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["2076"], adGroupIds: ["77"] });
  assert.equal(refused.isError, true);
  assert.equal(foreign.calls.writes.length, 0);
});

test("set_campaign_locations: adGroupIds fora de Demand Gen aprimorado é recusado — não vira escrita na campanha inteira", async () => {
  const rows = (overrides: Row) => ({
    campaign: [campaignRow(overrides)],
    ad_group: [{ campaign: { id: CAMPAIGN_ID }, adGroup: { id: "31", name: "Grupo A", status: "ENABLED" } }],
    geo_target_constant: GEO,
  });
  for (const overrides of [
    { advertisingChannelType: "SEARCH" },
    { advertisingChannelType: "PERFORMANCE_MAX" },
    { advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: false } },
  ]) {
    const { client, calls } = fakeClient({ rows: rows(overrides) });
    const result = await call(client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["2076"], adGroupIds: ["31"] });
    assert.equal(result.isError, true, JSON.stringify(overrides));
    assert.equal(calls.writes.length, 0, `nenhuma escrita: ${JSON.stringify(overrides)}`);
    assert.match(textOf(result), /adGroupIds só vale para Demand Gen com segmentação aprimorada/);
    assert.match(textOf(result), /TODOS os grupos/);
  }
  const dg = fakeClient({ rows: rows({ advertisingChannelType: "DEMAND_GEN" }) });
  assert.match(textOf(await call(dg.client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["2076"], adGroupIds: ["31"] })), /sem segmentação aprimorada/);

  // Controle: Demand Gen aprimorado com adGroupIds grava só no grupo pedido.
  const upgraded = fakeClient({ rows: rows({ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: true } }) });
  const ok = await call(upgraded.client, "set_campaign_locations", { campaignId: CAMPAIGN_ID, locationIds: ["2076"], adGroupIds: ["31"] });
  assert.notEqual(ok.isError, true, textOf(ok));
  assert.equal(upgraded.calls.writes[0].resource, "adGroupCriteria");
});

// ── get_geo_performance (item 60) ─────────────────────────────────────

test("get_geo_performance: cidade, presença e campanha — segmento no SELECT e nomes resolvidos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      geographic_view: [{
        campaign: { id: CAMPAIGN_ID, name: "Leads SP" },
        geographicView: { countryCriterionId: "2076", locationType: "LOCATION_OF_PRESENCE" },
        segments: { geoTargetCity: "geoTargetConstants/1001566" },
        metrics: { impressions: "1000", clicks: "50", costMicros: "100000000", conversions: 4, conversionsValue: 0 },
      }],
      geo_target_constant: GEO,
    },
  });
  const result = await call(client, "get_geo_performance", { granularity: "city", basis: "presence", campaignId: CAMPAIGN_ID, days: 30 });
  const query = calls.queries[0];
  assert.match(query, /FROM geographic_view/);
  assert.match(query, /segments\.geo_target_city/);
  assert.match(query, /geographic_view\.location_type = 'LOCATION_OF_PRESENCE'/);
  assert.match(query, /campaign\.id = 111/);
  const row = (jsonOf(result).rows as Row[])[0];
  assert.equal(row.location_id, "1001566");
  assert.equal(row.location_name, "Campinas");
  assert.equal(row.country, "Brazil");
  assert.equal(row.basis, "presença");
  assert.equal(row.cpa, 25);
});

test("get_geo_performance: conta inteira, usuário, locais segmentados e distância", async () => {
  const account = fakeClient();
  await call(account.client, "get_geo_performance", { level: "account", granularity: "state" });
  assert.doesNotMatch(account.calls.queries[0], /campaign\./);
  assert.match(account.calls.queries[0], /segments\.geo_target_state/);

  const user = fakeClient({
    rows: { user_location_view: [{ userLocationView: { countryCriterionId: "2076", targetingLocation: false }, metrics: { impressions: "10" } }], geo_target_constant: GEO },
  });
  const userResult = await call(user.client, "get_geo_performance", { view: "user_location" });
  assert.match(user.calls.queries[0], /FROM user_location_view/);
  assert.equal((jsonOf(userResult).rows as Row[])[0].targeted_location, false);

  const targeted = fakeClient({
    rows: {
      location_view: [{
        campaign: { id: CAMPAIGN_ID, name: "Leads SP", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" } },
        campaignCriterion: { criterionId: "10", type: "LOCATION", bidModifier: 1.2, location: { geoTargetConstant: "geoTargetConstants/20106" } },
        metrics: { impressions: "5", clicks: "1", costMicros: "2000000" },
      }],
      geo_target_constant: GEO,
    },
  });
  const targetedResult = await call(targeted.client, "get_geo_performance", { view: "targeted" });
  assert.match(targeted.calls.queries[0], /FROM location_view/);
  assert.match(targeted.calls.queries[0], /campaign_criterion\.bid_modifier/);
  const tRow = (jsonOf(targetedResult).rows as Row[])[0];
  assert.equal(tRow.bid_modifier, 1.2);
  assert.equal(tRow.location_name, "State of Sao Paulo,Brazil");
  assert.equal(tRow.criterion_id, "10");

  const distance = fakeClient();
  const distanceResult = await call(distance.client, "get_geo_performance", { view: "distance", campaignId: CAMPAIGN_ID });
  assert.match(distance.calls.queries[0], /FROM distance_view/);
  assert.match(textOf(distanceResult), /cumulativas/);
});

test("get_geo_performance: entrada inválida não consulta; csv sai tabular", async () => {
  for (const args of [{ campaignId: "1 OR 1=1" }, { limit: 0 }, { granularity: "bairro" }, { dateRange: { since: "2026-01-01' OR", until: "2026-01-31" } }]) {
    const fake = fakeClient();
    const result = await call(fake.client, "get_geo_performance", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(fake.calls.queries.length, 0);
  }
  const csv = fakeClient({
    rows: { geographic_view: [{ geographicView: { countryCriterionId: "2076", locationType: "AREA_OF_INTEREST" }, metrics: { impressions: "3" } }], geo_target_constant: GEO },
  });
  const result = await call(csv.client, "get_geo_performance", { level: "account", format: "csv" });
  assert.match(textOf(result), /^country,basis,location_id/);
});

// ── get_campaign_geo_targeting (item 40: mostrar a configuração) ──────

test("get_campaign_geo_targeting: configuração, nomes, idiomas legados e avisos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        campaignRow(),
        campaignRow({ advertisingChannelType: "DISPLAY", geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE", negativeGeoTargetType: "PRESENCE" } }, "112"),
      ],
      campaign_criterion: [
        location("10", "20106", { bidModifier: 1.3 }),
        location("13", "1001566", { negative: true }),
        language("5", "1014"),
        criterion("14", "PROXIMITY", { proximity: { geoPoint: { latitudeInMicroDegrees: -23500000, longitudeInMicroDegrees: -46600000 }, radius: 5, radiusUnits: "KILOMETERS" } }),
      ],
      geo_target_constant: GEO,
      language_constant: LANGUAGES,
    },
  });
  const result = await call(client, "get_campaign_geo_targeting", {});
  const report = JSON.parse(textOf(result).slice(textOf(result).indexOf("["))) as Row[];
  const search = report.find((c) => c.campaign_id === CAMPAIGN_ID)!;
  assert.deepEqual(search.geo_target_type, { positive: "PRESENCE_OR_INTEREST", negative: "PRESENCE" });
  assert.equal((search.targeted_locations as Row[])[0].name, "State of Sao Paulo,Brazil");
  assert.equal((search.targeted_locations as Row[])[0].bid_modifier, 1.3);
  assert.equal((search.excluded_locations as Row[])[0].location_id, "1001566");
  assert.equal((search.proximity as Row[])[0].latitude, -23.5);
  assert.equal((search.languages as Row[])[0].code, "pt");
  const warnings = (search.warnings as string[]).join(" ");
  assert.match(warnings, /Idiomas legados em Pesquisa/);
  assert.match(warnings, /PRESENCE_OR_INTEREST/);
  const display = report.find((c) => c.campaign_id === "112")!;
  assert.match((display.warnings as string[]).join(" "), /mundo todo/);
  assert.ok(calls.queries.every((q) => q.length > 0));
});

test("get_campaign_geo_targeting: Demand Gen com segmentação aprimorada lista local e idioma por grupo", async () => {
  const { client } = fakeClient({
    rows: {
      campaign: [campaignRow({ advertisingChannelType: "DEMAND_GEN", demandGenCampaignSettings: { upgradedTargeting: true } })],
      ad_group_criterion: [{
        campaign: { id: CAMPAIGN_ID },
        adGroup: { id: "31", name: "Grupo A" },
        adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/31~8`, criterionId: "8", type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/2076" } },
      }],
      geo_target_constant: GEO,
    },
  });
  const result = await call(client, "get_campaign_geo_targeting", { campaignId: CAMPAIGN_ID });
  const report = JSON.parse(textOf(result).slice(textOf(result).indexOf("["))) as Row[];
  const targeting = report[0].ad_group_targeting as Row[];
  assert.equal(targeting[0].ad_group_id, "31");
  assert.equal(targeting[0].name, "Brazil");
  assert.doesNotMatch((report[0].warnings as string[]).join(" "), /mundo todo/);
});

// ── list_geo_targets ──────────────────────────────────────────────────

test("list_geo_targets: resolve IDs, escapa o nome e valida o país", async () => {
  const ids = fakeClient({ rows: { geo_target_constant: GEO } });
  const result = await call(ids.client, "list_geo_targets", { ids: ["2076", "5"] });
  assert.match(textOf(result), /1 de 2 ID\(s\) resolvido\(s\)\. Não encontrados: 5/);
  assert.match(ids.calls.queries[0], /geo_target_constant\.id IN \(2076, 5\)/);

  const byName = fakeClient();
  await call(byName.client, "list_geo_targets", { query: "Sant'Ana", countryCode: "br" });
  assert.match(byName.calls.queries[0], /LIKE '%Sant\\'Ana%'/);
  assert.match(byName.calls.queries[0], /country_code = 'BR'/);

  for (const args of [{ query: "x", countryCode: "BRA" }, {}, { ids: ["abc"] }, { query: "x", limit: 5000 }]) {
    const fake = fakeClient();
    const bad = await call(fake.client, "list_geo_targets", args);
    assert.equal(bad.isError, true, JSON.stringify(args));
    assert.equal(fake.calls.queries.length, 0);
  }
});

test("list_geo_targets: mais de 1000 IDs é recusado antes da query; 1000 IDs válidos não viram 'não encontrados'", async () => {
  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => String(1_000_000 + i));
  const table = idsOf(1001).map((id) => ({ geoTargetConstant: { id, name: `Local ${id}`, canonicalName: `Local ${id},Brazil`, targetType: "City", countryCode: "BR", status: "ENABLED" } }));

  const tooMany = fakeClient({ rows: { geo_target_constant: table } });
  const refused = await call(tooMany.client, "list_geo_targets", { ids: idsOf(1001) });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /no máximo 1000 IDs.*recebidos 1001/);
  assert.equal(tooMany.calls.queries.length, 0, "nada consultado");

  const full = fakeClient({ rows: { geo_target_constant: table } });
  const result = await call(full.client, "list_geo_targets", { ids: idsOf(1000) });
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /^1000 de 1000 ID\(s\) resolvido\(s\)\.\n/);
  assert.doesNotMatch(textOf(result), /Não encontrados/);
  assert.equal(whereValues(full.calls.queries[0], "geo_target_constant.id")?.length, 1000);

  // Com filtro de tipo, o ID que existe mas é de outro tipo não é chamado de inexistente.
  const filtered = fakeClient({ rows: { geo_target_constant: GEO } });
  const typed = await call(filtered.client, "list_geo_targets", { ids: ["2076", "1001773"], targetType: "City" });
  assert.match(filtered.calls.queries[0], /target_type = 'City'/);
  assert.match(textOf(typed), /fora dos filtros countryCode\/targetType/);
});

// ── Guarda de conta, catálogo e erros ─────────────────────────────────

test("guarda de conta: conta fora da allowlist não consulta nem grava", async () => {
  for (const tool of ["get_geo_performance", "get_campaign_geo_targeting", "set_geo_target_type", "add_proximity_target", "set_campaign_languages"]) {
    const { client, calls } = fakeClient();
    const result = await register(client, ["9999999999"]).handlers.get(tool)!({ customerId: CID, campaignId: CAMPAIGN_ID, positive: "PRESENCE" });
    assert.equal(result.isError, true, tool);
    assert.match(textOf(result), /Access denied/);
    assert.equal(calls.queries.length + calls.writes.length, 0, tool);
  }
});

test("tools de escrita do lote ganham validateOnly; as de leitura não", () => {
  const { configs } = register(fakeClient().client);
  for (const tool of ["set_geo_target_type", "add_proximity_target", "add_location_group_target", "remove_campaign_geo_targets", "set_campaign_locations", "set_campaign_languages"]) {
    assert.ok("validateOnly" in (configs.get(tool)!.inputSchema as Row), tool);
  }
  for (const tool of ["get_campaign_geo_targeting", "get_geo_performance", "list_geo_targets"]) {
    assert.ok(!("validateOnly" in (configs.get(tool)!.inputSchema as Row)), tool);
  }
});

test("explainCriterionError traduz os códigos de proximidade, idioma e contexto", () => {
  assert.match(explainCriterionError("Distance for the radius for the proximity criterion is invalid."), /INVALID_PROXIMITY_RADIUS\)/);
  assert.match(explainCriterionError("[criterionError.INVALID_PROXIMITY_RADIUS_UNITS]"), /KILOMETERS ou MILES/);
  assert.match(explainCriterionError("The operation is not allowed for the given context."), /OPERATION_NOT_PERMITTED_FOR_CONTEXT\): o recurso não é configurável/);
  assert.match(explainCriterionError("x [criterionError.INVALID_LOCATION_GROUP_RADIUS]"), /incremento/);
  assert.equal(explainCriterionError("outro erro"), "outro erro");
});
