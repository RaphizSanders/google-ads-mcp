/**
 * Lote bid-modifiers: ajustes de lance (local, dispositivo, idade, gênero), programação de
 * anúncios, segmentação demográfica e de dispositivo, limite de frequência.
 *
 * O que estes testes fixam:
 * - as tools de ajuste são upserts: update + updateMask bid_modifier quando o critério existe,
 *   create quando não existe, nada quando o valor já está aplicado;
 * - set_location_bid_adjustment nunca amplia a segmentação sem confirm e nunca restringe uma
 *   campanha que veicula em todo lugar;
 * - idade/gênero recusam 0 (a API não exclui com bid_modifier 0); exclusão é critério negativo;
 * - excluir todos os valores / deixar só "desconhecido" é recusado antes da API; em PMax, excluir
 *   o único dispositivo segmentado é recusado (tirar o último positivo ampliaria o alcance);
 * - trocar positivo ↔ negativo de um critério de ID fixo (idade 503001, MOBILE 30001...) vai em
 *   duas requisições: o fake recusa, como a API, mutar o mesmo recurso duas vezes numa requisição
 *   (ID_EXISTS_IN_MULTIPLE_MUTATES); falha na segunda = "GRAVAÇÃO PARCIAL" com o estado; em
 *   validateOnly o create dependente não é enviado nem dado como validado;
 * - programação: validação de horários, limite de 6 por dia, sobreposição, replace atômico
 *   com confirm quando remove, e as tools de listar / ajustar / remover;
 * - limite de frequência: merge/replace, só Display (Vídeo recusado: a API não altera campanhas
 *   de Vídeo), remoção total com confirm;
 * - toda query passa pelas regras de GAQL da v25 (tests/gaql-rules.ts);
 * - validateOnly (dry-run) nunca diz que gravou.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { explainApiError } from "../src/tools/bid-modifiers.js";
import { catalog } from "../src/tools/bid-modifiers.catalog.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";
import { toolImplementations } from "./tool-sources.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "111";
const AD_GROUP_ID = "222";
const CAMPAIGN_RN = `customers/${CID}/campaigns/${CAMPAIGN_ID}`;
const AD_GROUP_RN = `customers/${CID}/adGroups/${AD_GROUP_ID}`;

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  campaign?: Row | null;
  adGroup?: Row | null;
  campaignCriteria?: Row[];
  adGroupCriteria?: Row[];
  adGroupBidModifiers?: Row[];
  geo?: Record<string, Row>;
  /** Linhas de métricas por recurso do FROM (customer, campaign, ad_schedule_view). */
  metricRows?: Record<string, Row[]>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
}

const searchCampaign = (overrides: Row = {}): Row => ({
  id: CAMPAIGN_ID, name: "Pesquisa Institucional", status: "ENABLED",
  advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", ...overrides,
});

function typesIn(query: string, resource: string): string[] | null {
  const match = new RegExp(`${resource}\\.type\\s*(?:=\\s*'([A-Z_]+)'|IN\\s*\\(([^)]*)\\))`).exec(query);
  if (!match) return null;
  return match[1] ? [match[1]] : match[2].match(/[A-Z_]+/g) ?? [];
}

/** Valor do critério de ID fixo (dispositivo/demografia) — é ele que define o criterion_id. */
function criterionValue(criterion: Row): string | null {
  for (const key of ["device", "ageRange", "gender", "parentalStatus", "incomeRange"]) {
    const type = (criterion[key] as Row | undefined)?.type;
    if (type) return String(type);
  }
  return null;
}

const ID_EXISTS_ERROR = "Google Ads API: Request contains an invalid argument. — ID_EXISTS_IN_MULTIPLE_MUTATES: " +
  "Cannot mutate the same resource twice in one request.";

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ resource: string; operations: Row[]; options?: Row; dryRun: boolean }>,
    dryRunClones: 0,
  };
  // Critérios de dispositivo/demografia têm criterion_id fixo: o recurso é {pai}~{id}. O registro
  // liga o resourceName das fixtures à identidade lógica (pai|valor) para o fake recusar, como a
  // API (mutate_error.proto ID_EXISTS_IN_MULTIPLE_MUTATES), duas operações no mesmo recurso.
  const identity = new Map<string, string>();
  for (const [parent, items] of [[CAMPAIGN_RN, opts.campaignCriteria], [AD_GROUP_RN, opts.adGroupCriteria]] as const) {
    for (const item of items ?? []) {
      const value = criterionValue(item);
      if (value && item.resourceName) identity.set(String(item.resourceName), `${parent}|${value}`);
    }
  }
  const identityOf = (op: Row): string | null => {
    if (typeof op.remove === "string") return identity.get(op.remove) ?? op.remove;
    const update = op.update as Row | undefined;
    if (update) return identity.get(String(update.resourceName)) ?? String(update.resourceName);
    const create = op.create as Row | undefined;
    const parent = create?.campaign ?? create?.adGroup;
    const value = create ? criterionValue(create) : null;
    return parent && value ? `${parent}|${value}` : null;
  };
  const campaign = opts.campaign === undefined ? searchCampaign() : opts.campaign;
  const adGroup = opts.adGroup === undefined
    ? { adGroup: { id: AD_GROUP_ID, name: "Grupo A", status: "ENABLED" }, campaign }
    : opts.adGroup;
  const filterCriteria = (items: Row[] | undefined, query: string, resource: string) => {
    const types = typesIn(query, resource);
    return (items ?? []).filter((c) => (!types || types.includes(String(c.type))) &&
      (!/status != 'REMOVED'/.test(query) || c.status !== "REMOVED"));
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
      if (from === "campaign") {
        if (/metrics\./.test(query)) return opts.metricRows?.campaign ?? [];
        return campaign ? [{ campaign }] : [];
      }
      if (from === "customer") return opts.metricRows?.customer ?? [];
      if (from === "ad_schedule_view") return opts.metricRows?.ad_schedule_view ?? [];
      if (from === "ad_group") return adGroup ? [adGroup] : [];
      if (from === "campaign_criterion") {
        return filterCriteria(opts.campaignCriteria, query, "campaign_criterion").map((c) => ({ campaignCriterion: c, campaign }));
      }
      if (from === "ad_group_criterion") {
        return filterCriteria(opts.adGroupCriteria, query, "ad_group_criterion")
          .map((c) => ({ adGroupCriterion: c, adGroup: (adGroup as Row | null)?.adGroup }));
      }
      if (from === "ad_group_bid_modifier") {
        return (opts.adGroupBidModifiers ?? []).map((m) => ({ adGroupBidModifier: m, adGroup: (adGroup as Row | null)?.adGroup }));
      }
      if (from === "geo_target_constant") {
        const id = /geo_target_constant\.id = (\d+)/.exec(query)?.[1] ?? "";
        return opts.geo?.[id] ? [{ geoTargetConstant: opts.geo[id] }] : [];
      }
      return [];
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ resource, operations, options, dryRun });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      const seen = new Set<string>();
      for (const op of operations) {
        const id = identityOf(op);
        if (id && seen.has(id)) throw new Error(ID_EXISTS_ERROR);
        if (id) seen.add(id);
      }
      if (opts.mutate) return opts.mutate(resource, operations, options);
      return dryRun ? {} : { results: operations.map((op, i) => ({ resourceName: String(op.remove ?? `customers/${CID}/${resource}/${i}`) })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, allowed: string[] = []) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      assert.ok(!handlers.has(name), `tool registrada duas vezes: ${name}`);
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, allowed.length > 0);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) =>
  register(client).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

const locationCriterion = (geoId: string, extra: Row = {}): Row => ({
  resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~${geoId}`,
  criterionId: geoId, type: "LOCATION", status: "ENABLED",
  location: { geoTargetConstant: `geoTargetConstants/${geoId}` }, ...extra,
});

const GEO: Record<string, Row> = {
  "2076": { id: "2076", name: "Brazil", canonicalName: "Brazil", targetType: "Country", status: "ENABLED" },
  "20106": { id: "20106", name: "State of Sao Paulo", canonicalName: "State of Sao Paulo,Brazil", parentGeoTarget: "geoTargetConstants/2076", status: "ENABLED" },
  "1001773": { id: "1001773", name: "Sao Paulo", canonicalName: "Sao Paulo,State of Sao Paulo,Brazil", parentGeoTarget: "geoTargetConstants/20106", status: "ENABLED" },
  "2620": { id: "2620", name: "Portugal", canonicalName: "Portugal", targetType: "Country", status: "ENABLED" },
};

const deviceCriterion = (device: string, criterionId: string, extra: Row = {}): Row => ({
  resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~${criterionId}`,
  criterionId, type: "DEVICE", status: "ENABLED", device: { type: device }, ...extra,
});

/** criterion_id fixo de cada faixa etária (o mesmo em toda conta). */
const AGE_ID: Record<string, string> = {
  AGE_RANGE_18_24: "503001", AGE_RANGE_25_34: "503002", AGE_RANGE_35_44: "503003", AGE_RANGE_45_54: "503004",
  AGE_RANGE_55_64: "503005", AGE_RANGE_65_UP: "503006", AGE_RANGE_UNDETERMINED: "503999",
};
const ageRn = (value: string) => `customers/${CID}/adGroupCriteria/${AD_GROUP_ID}~${AGE_ID[value]}`;

const ageCriterion = (value: string, extra: Row = {}): Row => ({
  resourceName: ageRn(value),
  criterionId: AGE_ID[value], type: "AGE_RANGE", status: "ENABLED", ageRange: { type: value }, ...extra,
});

/** Critério de idade no nível de campanha (PMax). */
const campaignAgeCriterion = (value: string, extra: Row = {}): Row => ({
  resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~${AGE_ID[value]}`,
  criterionId: AGE_ID[value], type: "AGE_RANGE", status: "ENABLED", ageRange: { type: value }, ...extra,
});

const schedule = (criterionId: string, day: string, start: number, end: number, extra: Row = {}): Row => ({
  resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~${criterionId}`,
  criterionId, type: "AD_SCHEDULE", status: "ENABLED",
  adSchedule: { dayOfWeek: day, startHour: start, startMinute: "ZERO", endHour: end, endMinute: "ZERO" },
  ...extra,
});

// ── Classificação ─────────────────────────────────────────────────────

test("catálogo: tools novas classificadas, reescritas continuam no núcleo e registradas uma vez só", () => {
  const { handlers } = register(fakeClient().client);
  for (const name of catalog.read) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), `${name} em read`);
    assert.ok(handlers.has(name), `${name} registrada`);
  }
  for (const name of catalog.write) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), `${name} em write`);
    assert.ok(handlers.has(name), `${name} registrada`);
  }
  for (const name of ["set_location_bid_adjustment", "set_device_bid_adjustment", "set_age_bid_adjustment", "set_gender_bid_adjustment", "set_ad_schedule"]) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name), `${name} continua write`);
    assert.ok(handlers.has(name));
  }
  assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has("get_device_breakdown"));
  assert.deepEqual(catalog.chained, []);
  // o fonte das tools é achado pelo scanner (nome literal no registerTool)
  const slices = toolImplementations();
  for (const name of [...catalog.read, ...catalog.write, "set_age_bid_adjustment", "set_gender_bid_adjustment"]) {
    assert.match(slices.get(name) ?? "", /checkCustomerAccess\(/, `${name} sem guarda de conta`);
  }
});

test("guarda de conta: conta fora da allowlist é negada antes de qualquer query", async () => {
  const { client, calls } = fakeClient();
  const { handlers } = register(client, ["9999999999"]);
  for (const name of [...catalog.read, ...catalog.write, "set_location_bid_adjustment", "get_device_breakdown"]) {
    const result = await handlers.get(name)!({ customerId: CID, campaignId: CAMPAIGN_ID });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Access denied/, name);
  }
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.writes.length, 0);
});

// ── set_location_bid_adjustment ───────────────────────────────────────

test("local: critério existente → update só do bid_modifier, com antes/depois", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076", { bidModifier: 1.1 })] });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 1.3 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "campaignCriteria");
  assert.deepEqual(calls.writes[0].operations, [
    { update: { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~2076`, bidModifier: 1.3 }, updateMask: "bid_modifier" },
  ]);
  const body = jsonOf(result);
  assert.equal(body.operation, "update");
  assert.equal(body.before, "+10% (1.1)");
  assert.equal(body.after, "+30% (1.3)");
});

test("local: mesmo valor (float da API) não gera escrita", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076", { bidModifier: 1.2000000476837158 })] });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 1.2 });
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(calls.writes.length, 0);
});

test("local: excluído → recusa sem escrever", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076"), locationCriterion("2620", { negative: true })] });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2620", bidModifier: 1.3 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /EXCLUÍDO/);
  assert.equal(calls.writes.length, 0);
});

test("local: sub-região de um local segmentado → cria o critério sem pedir confirm", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076")], geo: GEO });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "1001773", bidModifier: 1.2 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [
    { create: { campaign: CAMPAIGN_RN, location: { geoTargetConstant: "geoTargetConstants/1001773" }, bidModifier: 1.2 } },
  ]);
  assert.match(String(jsonOf(result).reach), /sub-região de Brazil.*não muda/);
  // subiu a hierarquia: cidade → estado → país
  assert.equal(calls.queries.filter((q) => /FROM geo_target_constant/.test(q)).length, 3);
});

test("local: fora da segmentação amplia o alcance → exige confirm; com confirm cria", async () => {
  const opts = { campaignCriteria: [locationCriterion("2076")], geo: GEO };
  const first = fakeClient(opts);
  const refused = await call(first.client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2620", bidModifier: 1.2 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /AMPLIA o alcance.*confirm: true/s);
  assert.equal(first.calls.writes.length, 0);

  const second = fakeClient(opts);
  const done = await call(second.client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2620", bidModifier: 1.2, confirm: true });
  assert.equal(done.isError, undefined, textOf(done));
  assert.equal(second.calls.writes.length, 1);
  assert.match(String(jsonOf(done).reach), /AMPLIA/);
});

test("local: campanha sem segmentação geográfica (todo lugar) → recusa em vez de restringir", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [], geo: GEO });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "1001773", bidModifier: 1.2, confirm: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /restringiria a campanha/);
  assert.equal(calls.writes.length, 0);
});

test("local: dentro de área excluída → recusa", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076"), locationCriterion("20106", { negative: true })], geo: GEO });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "1001773", bidModifier: 1.2 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /dentro de um local EXCLUÍDO/);
  assert.equal(calls.writes.length, 0);
});

test("local: validação antes de qualquer chamada (faixa, 0, IDs) e PMax recusada", async () => {
  for (const args of [
    { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 0 },
    { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 11 },
    { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 0.05 },
    { campaignId: "111 OR 1=1", locationId: "2076", bidModifier: 1.2 },
    { campaignId: CAMPAIGN_ID, locationId: "abc", bidModifier: 1.2 },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_location_bid_adjustment", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0, JSON.stringify(args));
  }
  const zero = await call(fakeClient().client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 0 });
  assert.match(textOf(zero), /set_campaign_locations com negative=true/);

  const pmax = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX" }) });
  const result = await call(pmax.client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 1.2 });
  assert.equal(result.isError, true);
  assert.equal(pmax.calls.writes.length, 0);
});

test("local: Smart Bidding gera aviso; erro da API vem traduzido", async () => {
  const smart = fakeClient({ campaign: searchCampaign({ biddingStrategyType: "TARGET_CPA" }), campaignCriteria: [locationCriterion("2076")] });
  const warned = await call(smart.client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 1.2 });
  assert.match(textOf(warned), /Smart Bidding/);

  const failing = fakeClient({
    campaignCriteria: [locationCriterion("2076")],
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Bid Modifier already exists. Use SET operation to update."); },
  });
  const result = await call(failing.client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2076", bidModifier: 1.2 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /nada foi gravado[\s\S]*O que significa: O ajuste já existia/);
});

test("local: validateOnly roda em dry-run, dispensa confirm e não diz que gravou", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [locationCriterion("2076")], geo: GEO });
  const result = await call(client, "set_location_bid_adjustment", { campaignId: CAMPAIGN_ID, locationId: "2620", bidModifier: 1.2, validateOnly: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.dryRunClones, 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY[\s\S]*DRY-RUN \(validateOnly\): validado na API, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /— gravado\./);
});

// ── set_device_bid_adjustment ─────────────────────────────────────────

test("dispositivo: critério DEVICE existente → update (o bug era sempre create)", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [deviceCriterion("MOBILE", "30001", { bidModifier: 1.1 })] });
  const result = await call(client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "MOBILE", bidModifier: 1.3 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [
    { update: { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~30001`, bidModifier: 1.3 }, updateMask: "bid_modifier" },
  ]);
});

test("dispositivo: sem critério → create sem criterionId (campo OUTPUT_ONLY); mesmo valor → nada", async () => {
  const { client, calls } = fakeClient();
  await call(client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "TABLET", bidModifier: 0.8 });
  assert.deepEqual(calls.writes[0].operations, [{ create: { campaign: CAMPAIGN_RN, device: { type: "TABLET" }, bidModifier: 0.8 } }]);

  const same = fakeClient({ campaignCriteria: [deviceCriterion("TABLET", "30002", { bidModifier: 0.8 })] });
  const result = await call(same.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "TABLET", bidModifier: 0.8 });
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const neutral = fakeClient();
  await call(neutral.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "DESKTOP", bidModifier: 1 });
  assert.equal(neutral.calls.writes.length, 0, "1.0 sem critério já é o padrão");
});

test("dispositivo: 0 exclui, mas não o último entre computador/celular/tablet", async () => {
  const ok = fakeClient();
  const excluded = await call(ok.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "TABLET", bidModifier: 0 });
  assert.equal(excluded.isError, undefined);
  assert.equal(jsonOf(excluded).after, "excluído (-100%)");

  const lastOne = fakeClient({ campaignCriteria: [deviceCriterion("DESKTOP", "30000", { bidModifier: 0 }), deviceCriterion("TABLET", "30002", { bidModifier: 0 })] });
  const refused = await call(lastOne.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "MOBILE", bidModifier: 0 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /sem veicular em computador, celular e tablet/);
  assert.equal(lastOne.calls.writes.length, 0);
});

test("dispositivo: PMax recusada (aponta set_device_targeting); faixa inválida antes da API", async () => {
  const pmax = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX" }) });
  const result = await call(pmax.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "MOBILE", bidModifier: 1.2 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /set_device_targeting/);
  assert.equal(pmax.calls.writes.length, 0);

  const bad = fakeClient();
  const outOfRange = await call(bad.client, "set_device_bid_adjustment", { campaignId: CAMPAIGN_ID, deviceType: "MOBILE", bidModifier: 12 });
  assert.equal(outOfRange.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

// ── set_age_bid_adjustment / set_gender_bid_adjustment ────────────────

test("idade/gênero: 0 é recusado (não exclui) e aponta a exclusão certa", async () => {
  for (const [tool, arg] of [["set_age_bid_adjustment", { ageRange: "AGE_RANGE_18_24" }], ["set_gender_bid_adjustment", { gender: "MALE" }]] as const) {
    const { client, calls } = fakeClient();
    const result = await call(client, tool, { adGroupId: AD_GROUP_ID, ...arg, bidModifier: 0 });
    assert.equal(result.isError, true, tool);
    assert.match(textOf(result), /set_demographic_targeting/);
    assert.equal(calls.queries.length, 0);
  }
});

test("idade: existente → update; ausente → create positivo com ajuste; excluída → recusa", async () => {
  const existing = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_25_34", { bidModifier: 1.1 })] });
  await call(existing.client, "set_age_bid_adjustment", { adGroupId: AD_GROUP_ID, ageRange: "AGE_RANGE_25_34", bidModifier: 1.4 });
  assert.deepEqual(existing.calls.writes[0].operations, [
    { update: { resourceName: ageRn("AGE_RANGE_25_34"), bidModifier: 1.4 }, updateMask: "bid_modifier" },
  ]);
  assert.equal(existing.calls.writes[0].resource, "adGroupCriteria");

  const missing = fakeClient();
  await call(missing.client, "set_gender_bid_adjustment", { adGroupId: AD_GROUP_ID, gender: "FEMALE", bidModifier: 1.2 });
  assert.deepEqual(missing.calls.writes[0].operations, [{ create: { adGroup: AD_GROUP_RN, gender: { type: "FEMALE" }, bidModifier: 1.2 } }]);

  const negative = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { negative: true })] });
  const refused = await call(negative.client, "set_age_bid_adjustment", { adGroupId: AD_GROUP_ID, ageRange: "AGE_RANGE_18_24", bidModifier: 1.2 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /excluído/);
  assert.equal(negative.calls.writes.length, 0);

  // critério REMOVED (é como a API mostra o padrão) não conta como existente
  const removed = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_35_44", { status: "REMOVED" })] });
  await call(removed.client, "set_age_bid_adjustment", { adGroupId: AD_GROUP_ID, ageRange: "AGE_RANGE_35_44", bidModifier: 1.2 });
  assert.ok(removed.calls.writes[0].operations[0].create);
});

// ── set_demographic_targeting ─────────────────────────────────────────

test("fake: como a API, recusa mutar o mesmo critério (ID fixo) duas vezes numa requisição", async () => {
  const { client } = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { bidModifier: 1.3 })] });
  await assert.rejects(
    (client as { mutate: (...args: unknown[]) => Promise<Row> }).mutate(CID, "adGroupCriteria", [
      { remove: ageRn("AGE_RANGE_18_24") },
      { create: { adGroup: AD_GROUP_RN, ageRange: { type: "AGE_RANGE_18_24" }, negative: true } },
    ]),
    /ID_EXISTS_IN_MULTIPLE_MUTATES/
  );
});

test("demografia: EXCLUDE cria negativo; positivo existente vira remove (requisição 1) + create negativo (requisição 2)", async () => {
  const fresh = fakeClient();
  await call(fresh.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["18-24", "65+"], action: "EXCLUDE" });
  assert.equal(fresh.calls.writes.length, 1, "sem troca de positivo: uma requisição só");
  assert.deepEqual(fresh.calls.writes[0].operations, [
    { create: { adGroup: AD_GROUP_RN, ageRange: { type: "AGE_RANGE_18_24" }, negative: true } },
    { create: { adGroup: AD_GROUP_RN, ageRange: { type: "AGE_RANGE_65_UP" }, negative: true } },
  ]);
  assert.equal(fresh.calls.writes[0].options, undefined, "atômico, sem partialFailure");

  // O fluxo principal da documentação: ajuste de lance existente vira exclusão. remove + create do
  // mesmo recurso (…~503001) numa requisição é ID_EXISTS_IN_MULTIPLE_MUTATES — o fake recusa.
  const positive = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { bidModifier: 1.3 }), ageCriterion("AGE_RANGE_25_34", { bidModifier: 1.1 })] });
  const result = await call(positive.client, "set_demographic_targeting", {
    adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24", "AGE_RANGE_65_UP"], action: "EXCLUDE",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(positive.calls.writes.length, 2);
  assert.deepEqual(positive.calls.writes[0].operations, [{ remove: ageRn("AGE_RANGE_18_24") }], "requisição 1: só a remoção do critério que será recriado");
  assert.deepEqual(positive.calls.writes[1].operations, [
    { create: { adGroup: AD_GROUP_RN, ageRange: { type: "AGE_RANGE_18_24" }, negative: true } },
    { create: { adGroup: AD_GROUP_RN, ageRange: { type: "AGE_RANGE_65_UP" }, negative: true } },
  ]);
  const body = jsonOf(result);
  assert.equal(body.requests, 2);
  assert.match(textOf(result), /— gravado\./);
  assert.match(JSON.stringify(body.changes), /remove \(requisição 1\) \+ create negativo \(requisição 2\)/);
});

test("demografia: requisição 2 recusada depois da 1 gravada → GRAVAÇÃO PARCIAL com o estado que ficou", async () => {
  let n = 0;
  const { client, calls } = fakeClient({
    adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { bidModifier: 1.3 })],
    mutate: (_resource, operations) => {
      n++;
      if (n === 2) throw new Error("Google Ads API: invalid — Cannot target and exclude the same criterion.");
      return { results: operations.map(() => ({})) };
    },
  });
  const result = await call(client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "EXCLUDE" });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 2);
  const out = textOf(result);
  assert.match(out, /GRAVAÇÃO PARCIAL/);
  assert.match(out, /AGE_RANGE_18_24: o ajuste positivo \(\+30% \(1\.3\)\) foi removido e a exclusão não foi criada — voltou ao padrão/);
  assert.match(out, /Repita a mesma chamada/);
  assert.match(out, /segmentar e excluir o mesmo valor/, "erro da API traduzido");
  assert.doesNotMatch(out, /nada foi gravado/i);

  // etapa 1 recusada: nada foi gravado e a etapa 2 nem é enviada
  const firstFails = fakeClient({
    adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { bidModifier: 1.3 })],
    mutate: () => { throw new Error("Google Ads API: invalid — boom"); },
  });
  const refused = await call(firstFails.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.equal(firstFails.calls.writes.length, 1);
  assert.match(textOf(refused), /nada foi gravado \(etapa 1 de 2/);
});

test("demografia: validateOnly na troca positivo → exclusão valida a remoção e não finge validar o create", async () => {
  const { client, calls } = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { bidModifier: 1.3 })] });
  const result = await call(client, "set_demographic_targeting", {
    adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "EXCLUDE", validateOnly: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1, "só a remoção é validada; o create dependente não é enviado");
  assert.equal(calls.writes[0].dryRun, true);
  assert.deepEqual(calls.writes[0].operations, [{ remove: ageRn("AGE_RANGE_18_24") }]);
  const out = textOf(result);
  assert.match(out, /DRY-RUN \(validateOnly\): a etapa 1 \(remoção\) foi validada/);
  assert.match(out, /a criação de AGE_RANGE_18_24 não pôde ser validad/);
  assert.doesNotMatch(out, /— gravado\./);
  assert.deepEqual(jsonOf(result).not_validated, ["AGE_RANGE_18_24"]);
});

test("demografia: INCLUDE em campanha restritiva troca exclusão por positivo em duas requisições", async () => {
  const pmax = searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSIONS" });
  const { client, calls } = fakeClient({
    campaign: pmax,
    campaignCriteria: [campaignAgeCriterion("AGE_RANGE_25_34"), campaignAgeCriterion("AGE_RANGE_18_24", { negative: true })],
  });
  const result = await call(client, "set_demographic_targeting", { campaignId: CAMPAIGN_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "INCLUDE" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 2);
  assert.deepEqual(calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~503001` }]);
  assert.deepEqual(calls.writes[1].operations, [{ create: { campaign: CAMPAIGN_RN, ageRange: { type: "AGE_RANGE_18_24" } } }]);
  assert.deepEqual(jsonOf(result).targeted_after, ["AGE_RANGE_18_24", "AGE_RANGE_25_34"]);
});

test("demografia: campanha restritiva — excluir o único positivo é recusado (não amplia)", async () => {
  const pmax = searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSIONS" });
  const { client, calls } = fakeClient({ campaign: pmax, campaignCriteria: [campaignAgeCriterion("AGE_RANGE_18_24")] });
  const result = await call(client, "set_demographic_targeting", { campaignId: CAMPAIGN_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "EXCLUDE" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /CANNOT_EXCLUDE_ALL_TARGETS/);
  assert.equal(calls.writes.length, 0);
});

test("demografia: INCLUDE remove a exclusão; já incluído não escreve", async () => {
  const excluded = fakeClient({ adGroupCriteria: [ageCriterion("AGE_RANGE_18_24", { negative: true })] });
  await call(excluded.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "INCLUDE" });
  assert.deepEqual(excluded.calls.writes[0].operations, [{ remove: ageRn("AGE_RANGE_18_24") }]);

  const already = fakeClient();
  const result = await call(already.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "INCLUDE" });
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(already.calls.writes.length, 0);
});

test("demografia: excluir tudo ou deixar só o desconhecido é recusado antes da API", async () => {
  const all = fakeClient();
  const refusedAll = await call(all.client, "set_demographic_targeting", {
    adGroupId: AD_GROUP_ID, dimension: "GENDER", values: ["MALE", "FEMALE", "UNDETERMINED"], action: "EXCLUDE",
  });
  assert.equal(refusedAll.isError, true);
  assert.match(textOf(refusedAll), /CANNOT_EXCLUDE_ALL_TARGETS/);
  assert.equal(all.calls.writes.length, 0);

  const maleExcluded: Row = {
    resourceName: `customers/${CID}/adGroupCriteria/${AD_GROUP_ID}~10`, criterionId: "10", type: "GENDER",
    status: "ENABLED", gender: { type: "MALE" }, negative: true,
  };
  const onlyUnknown = fakeClient({ adGroupCriteria: [maleExcluded] });
  const refused = await call(onlyUnknown.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "GENDER", values: ["FEMALE"], action: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /CANNOT_TARGET_ONLY_UNDETERMINED/);
  assert.equal(onlyUnknown.calls.writes.length, 0);
});

test("demografia: nível de campanha (PMax) só idade e gênero, sem ajuste de lance", async () => {
  const pmax = { campaign: searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }) };
  const age = fakeClient(pmax);
  const result = await call(age.client, "set_demographic_targeting", { campaignId: CAMPAIGN_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "EXCLUDE" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(age.calls.writes[0].resource, "campaignCriteria");
  assert.deepEqual(age.calls.writes[0].operations, [{ create: { campaign: CAMPAIGN_RN, ageRange: { type: "AGE_RANGE_18_24" }, negative: true } }]);
  assert.ok(age.calls.queries.some((q) => /FROM campaign_criterion[\s\S]*campaign_criterion\.type = 'AGE_RANGE'/.test(q)));

  const parental = fakeClient(pmax);
  const refused = await call(parental.client, "set_demographic_targeting", { campaignId: CAMPAIGN_ID, dimension: "PARENTAL_STATUS", values: ["PARENT"], action: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.equal(parental.calls.writes.length, 0);

  const bid = fakeClient(pmax);
  const refusedBid = await call(bid.client, "set_demographic_targeting", { campaignId: CAMPAIGN_ID, dimension: "AGE_RANGE", values: ["AGE_RANGE_18_24"], action: "BID_ADJUST", bidModifier: 1.2 });
  assert.equal(refusedBid.isError, true);
  assert.equal(bid.calls.writes.length, 0);
});

test("demografia: entradas inválidas são recusadas antes de qualquer chamada", async () => {
  for (const args of [
    { adGroupId: AD_GROUP_ID, campaignId: CAMPAIGN_ID, dimension: "GENDER", values: ["MALE"], action: "EXCLUDE" },
    { dimension: "GENDER", values: ["MALE"], action: "EXCLUDE" },
    { adGroupId: AD_GROUP_ID, dimension: "GENDER", values: ["HOMEM"], action: "EXCLUDE" },
    { adGroupId: AD_GROUP_ID, dimension: "GENDER", values: ["MALE"], action: "EXCLUDE", bidModifier: 1.2 },
    { adGroupId: AD_GROUP_ID, dimension: "GENDER", values: ["MALE"], action: "BID_ADJUST" },
    { adGroupId: "12a", dimension: "GENDER", values: ["MALE"], action: "EXCLUDE" },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_demographic_targeting", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0, JSON.stringify(args));
  }
});

test("demografia: renda e status parental por grupo usam os campos certos", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "INCOME_RANGE", values: ["90_UP"], action: "BID_ADJUST", bidModifier: 1.5 });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [{ create: { adGroup: AD_GROUP_RN, incomeRange: { type: "INCOME_RANGE_90_UP" }, bidModifier: 1.5 } }]);
  assert.match(textOf(result), /Renda familiar só existe em alguns países/);

  const parental = fakeClient();
  await call(parental.client, "set_demographic_targeting", { adGroupId: AD_GROUP_ID, dimension: "PARENTAL_STATUS", values: ["NOT_A_PARENT"], action: "EXCLUDE" });
  assert.deepEqual(parental.calls.writes[0].operations, [{ create: { adGroup: AD_GROUP_RN, parentalStatus: { type: "NOT_A_PARENT" }, negative: true } }]);
});

// ── set_device_targeting ──────────────────────────────────────────────

test("dispositivo (PMax): EXCLUDE cria critério negativo; INCLUDE remove; BID_ADJUST recusado", async () => {
  const pmax = { campaign: searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" }) };
  const exclude = fakeClient(pmax);
  await call(exclude.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "EXCLUDE" });
  assert.deepEqual(exclude.calls.writes[0].operations, [{ create: { campaign: CAMPAIGN_RN, device: { type: "TABLET" }, negative: true } }]);

  const include = fakeClient({ ...pmax, campaignCriteria: [deviceCriterion("TABLET", "30002", { negative: true })] });
  await call(include.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE" });
  assert.deepEqual(include.calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~30002` }]);

  const bid = fakeClient(pmax);
  const refused = await call(bid.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "BID_ADJUST", bidModifier: 1.2 });
  assert.equal(refused.isError, true);
  assert.equal(bid.calls.writes.length, 0);

  const last = fakeClient({ ...pmax, campaignCriteria: [deviceCriterion("DESKTOP", "30000", { negative: true }), deviceCriterion("TABLET", "30002", { negative: true })] });
  const refusedLast = await call(last.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.equal(refusedLast.isError, true);
  assert.equal(last.calls.writes.length, 0);
});

test("dispositivo (PMax): excluir o ÚNICO dispositivo segmentado é recusado — não amplia para os outros", async () => {
  const pmax = searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" });
  // campanha só-celular: tirar o positivo faria ela veicular em DESKTOP, TABLET e CONNECTED_TV
  const { client, calls } = fakeClient({ campaign: pmax, campaignCriteria: [deviceCriterion("MOBILE", "30001")] });
  const result = await call(client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /segmenta SÓ MOBILE[\s\S]*ampliando o alcance[\s\S]*inclua o novo antes/);
  assert.doesNotMatch(textOf(result), /gravado/);
  assert.equal(calls.writes.length, 0);

  // o mesmo com um negativo já presente continua recusado (sobraria "todos menos MOBILE e TABLET")
  const withNegative = fakeClient({ campaign: pmax, campaignCriteria: [deviceCriterion("MOBILE", "30001"), deviceCriterion("TABLET", "30002", { negative: true })] });
  const refused = await call(withNegative.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.equal(refused.isError, true);
  assert.equal(withNegative.calls.writes.length, 0);
});

test("dispositivo (PMax): com 2+ positivos, EXCLUDE troca positivo por negativo em duas requisições", async () => {
  const pmax = searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" });
  const { client, calls } = fakeClient({ campaign: pmax, campaignCriteria: [deviceCriterion("MOBILE", "30001"), deviceCriterion("DESKTOP", "30000")] });
  const result = await call(client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 2);
  assert.deepEqual(calls.writes[0].operations, [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~30001` }]);
  assert.deepEqual(calls.writes[1].operations, [{ create: { campaign: CAMPAIGN_RN, device: { type: "MOBILE" }, negative: true } }]);
  const body = jsonOf(result);
  assert.deepEqual(body.targeted_before, ["MOBILE", "DESKTOP"]);
  assert.deepEqual(body.targeted_after, ["DESKTOP"]);
  assert.equal(body.requests, 2);

  // requisição 2 recusada: diz que o positivo saiu e a campanha segue restrita a DESKTOP
  let n = 0;
  const partial = fakeClient({
    campaign: pmax,
    campaignCriteria: [deviceCriterion("MOBILE", "30001"), deviceCriterion("DESKTOP", "30000")],
    mutate: (_r, operations) => { if (++n === 2) throw new Error("Google Ads API: invalid — boom"); return { results: operations.map(() => ({})) }; },
  });
  const failed = await call(partial.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /GRAVAÇÃO PARCIAL[\s\S]*MOBILE: o critério positivo foi removido e o negativo não foi criado; a campanha continua restrita aos outros positivos \(DESKTOP\)/);
});

test("dispositivo (PMax): INCLUDE em campanha restrita com o dispositivo excluído usa duas requisições; validateOnly não finge", async () => {
  const pmax = searchCampaign({ advertisingChannelType: "PERFORMANCE_MAX", biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE" });
  const criteria = [deviceCriterion("MOBILE", "30001"), deviceCriterion("TABLET", "30002", { negative: true })];
  const { client, calls } = fakeClient({ campaign: pmax, campaignCriteria: criteria });
  const result = await call(client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes.map((w) => w.operations), [
    [{ remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~30002` }],
    [{ create: { campaign: CAMPAIGN_RN, device: { type: "TABLET" } } }],
  ]);
  assert.deepEqual(jsonOf(result).targeted_after, ["MOBILE", "TABLET"]);

  const dry = fakeClient({ campaign: pmax, campaignCriteria: criteria });
  const validated = await call(dry.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE", validateOnly: true });
  assert.equal(validated.isError, undefined, textOf(validated));
  assert.equal(dry.calls.writes.length, 1);
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(validated), /a criação do critério TABLET não pôde ser validad/);
  assert.doesNotMatch(textOf(validated), /— gravado\./);

  // campanha sem positivos: INCLUDE só remove a exclusão (uma requisição)
  const open = fakeClient({ campaign: pmax, campaignCriteria: [deviceCriterion("TABLET", "30002", { negative: true })] });
  await call(open.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE" });
  assert.equal(open.calls.writes.length, 1);
});

test("explainApiError traduz ID_EXISTS_IN_MULTIPLE_MUTATES", () => {
  assert.match(explainApiError(ID_EXISTS_ERROR), /mesmo critério[\s\S]*duas requisições/);
});

test("dispositivo (grupo): AdGroupBidModifier — create, update e INCLUDE remove o -100%", async () => {
  const create = fakeClient();
  await call(create.client, "set_device_targeting", { adGroupId: AD_GROUP_ID, device: "MOBILE", action: "BID_ADJUST", bidModifier: 1.25 });
  assert.equal(create.calls.writes[0].resource, "adGroupBidModifiers");
  assert.deepEqual(create.calls.writes[0].operations, [{ create: { adGroup: AD_GROUP_RN, device: { type: "MOBILE" }, bidModifier: 1.25 } }]);

  const existingRn = `customers/${CID}/adGroupBidModifiers/${AD_GROUP_ID}~30001`;
  const update = fakeClient({ adGroupBidModifiers: [{ resourceName: existingRn, criterionId: "30001", bidModifier: 1.1, device: { type: "MOBILE" } }] });
  await call(update.client, "set_device_targeting", { adGroupId: AD_GROUP_ID, device: "MOBILE", action: "EXCLUDE" });
  assert.deepEqual(update.calls.writes[0].operations, [{ update: { resourceName: existingRn, bidModifier: 0 }, updateMask: "bid_modifier" }]);

  const include = fakeClient({ adGroupBidModifiers: [{ resourceName: existingRn, criterionId: "30001", bidModifier: 0, device: { type: "MOBILE" } }] });
  await call(include.client, "set_device_targeting", { adGroupId: AD_GROUP_ID, device: "MOBILE", action: "INCLUDE" });
  assert.deepEqual(include.calls.writes[0].operations, [{ remove: existingRn }]);
});

test("dispositivo (grupo): campanha com -100% não pode ser sobreposta", async () => {
  const { client, calls } = fakeClient({ campaignCriteria: [deviceCriterion("MOBILE", "30001", { bidModifier: 0 })] });
  const result = await call(client, "set_device_targeting", { adGroupId: AD_GROUP_ID, device: "MOBILE", action: "BID_ADJUST", bidModifier: 1.2 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /CANNOT_OVERRIDE_OPTED_OUT/);
  assert.equal(calls.writes.length, 0);
});

test("dispositivo (campanha comum): EXCLUDE = 0, INCLUDE volta a 1.0 só se estava em 0", async () => {
  const exclude = fakeClient({ campaignCriteria: [deviceCriterion("TABLET", "30002")] });
  await call(exclude.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "EXCLUDE" });
  assert.deepEqual(exclude.calls.writes[0].operations, [
    { update: { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~30002`, bidModifier: 0 }, updateMask: "bid_modifier" },
  ]);

  const include = fakeClient({ campaignCriteria: [deviceCriterion("TABLET", "30002", { bidModifier: 0 })] });
  await call(include.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE" });
  assert.equal((include.calls.writes[0].operations[0].update as Row).bidModifier, 1);

  const noop = fakeClient({ campaignCriteria: [deviceCriterion("TABLET", "30002", { bidModifier: 1.3 })] });
  const result = await call(noop.client, "set_device_targeting", { campaignId: CAMPAIGN_ID, device: "TABLET", action: "INCLUDE" });
  assert.match(textOf(result), /já veicula/);
  assert.equal(noop.calls.writes.length, 0, "INCLUDE não apaga um ajuste que já veicula");
});

// ── set_ad_schedule ───────────────────────────────────────────────────

test("programação: slots com WEEKDAYS viram 5 creates numa requisição atômica; aviso 24/7", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "set_ad_schedule", {
    campaignId: CAMPAIGN_ID,
    slots: [{ dayOfWeek: "WEEKDAYS", startHour: 8, endHour: 18, endMinute: "THIRTY", bidModifier: 1.2 }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].options, undefined);
  const ops = calls.writes[0].operations;
  assert.equal(ops.length, 5);
  assert.deepEqual(ops[0], {
    create: {
      campaign: CAMPAIGN_RN,
      adSchedule: { dayOfWeek: "MONDAY", startHour: 8, startMinute: "ZERO", endHour: 18, endMinute: "THIRTY" },
      bidModifier: 1.2,
    },
  });
  assert.match(textOf(result), /veiculava 24\/7; agora veicula SÓ/);
});

test("programação: campos avulsos (formato antigo) continuam funcionando", async () => {
  const { client, calls } = fakeClient();
  await call(client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, dayOfWeek: "SATURDAY", startHour: 0, endHour: 24 });
  assert.deepEqual(calls.writes[0].operations, [{
    create: { campaign: CAMPAIGN_RN, adSchedule: { dayOfWeek: "SATURDAY", startHour: 0, startMinute: "ZERO", endHour: 24, endMinute: "ZERO" } },
  }]);
});

test("programação: horários inválidos são recusados antes de qualquer chamada", async () => {
  for (const slots of [
    [{ dayOfWeek: "MONDAY", startHour: 18, endHour: 8 }],
    [{ dayOfWeek: "MONDAY", startHour: 24, endHour: 24 }],
    [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 24, endMinute: "FIFTEEN" }],
    [{ dayOfWeek: "MONDAY", startHour: 8.5, endHour: 10 }],
    [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 10, bidModifier: 0 }],
    [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12 }, { dayOfWeek: "MONDAY", startHour: 11, endHour: 14 }],
    [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12, bidModifier: 1.1 }, { dayOfWeek: "MONDAY", startHour: 8, endHour: 12, bidModifier: 1.3 }],
    [],
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots });
    assert.equal(result.isError, true, JSON.stringify(slots));
    assert.equal(calls.queries.length, 0, JSON.stringify(slots));
  }
  const mixed = fakeClient();
  const both = await call(mixed.client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, dayOfWeek: "MONDAY", startHour: 8, endHour: 9, slots: [{ dayOfWeek: "MONDAY", startHour: 10, endHour: 11 }] });
  assert.equal(both.isError, true);
});

test("programação: sobreposição com horário existente é recusada; idêntico só atualiza o ajuste", async () => {
  const existing = [schedule("900", "MONDAY", 8, 12, { bidModifier: 1.1 })];
  const clash = fakeClient({ campaignCriteria: existing });
  const refused = await call(clash.client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots: [{ dayOfWeek: "MONDAY", startHour: 11, endHour: 14 }] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /sobrepõe o existente.*criterionId 900/);
  assert.equal(clash.calls.writes.length, 0);

  const same = fakeClient({ campaignCriteria: existing });
  await call(same.client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12, bidModifier: 1.5 }] });
  assert.deepEqual(same.calls.writes[0].operations, [
    { update: { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~900`, bidModifier: 1.5 }, updateMask: "bid_modifier" },
  ]);

  const noop = fakeClient({ campaignCriteria: existing });
  const result = await call(noop.client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12 }] });
  assert.match(textOf(result), /nada a mudar/);
  assert.equal(noop.calls.writes.length, 0);
});

test("programação: limite de 6 horários por dia", async () => {
  const existing = [0, 2, 4, 6, 8].map((h, i) => schedule(String(900 + i), "TUESDAY", h, h + 1));
  const { client, calls } = fakeClient({ campaignCriteria: existing });
  const result = await call(client, "set_ad_schedule", {
    campaignId: CAMPAIGN_ID,
    slots: [{ dayOfWeek: "TUESDAY", startHour: 10, endHour: 11 }, { dayOfWeek: "TUESDAY", startHour: 12, endHour: 13 }],
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Mais de 6 horários.*TUESDAY: 7/);
  assert.equal(calls.writes.length, 0);
});

test("programação: replace mantém os idênticos, remove o resto e cria os novos — com confirm, atômico", async () => {
  const existing = [schedule("900", "MONDAY", 8, 12), schedule("901", "MONDAY", 14, 18), schedule("902", "SUNDAY", 0, 24)];
  const slots = [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12 }, { dayOfWeek: "MONDAY", startHour: 13, endHour: 19 }];

  const noConfirm = fakeClient({ campaignCriteria: existing });
  const refused = await call(noConfirm.client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots, replace: true });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /removeria 2 horário/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const { client, calls } = fakeClient({ campaignCriteria: existing });
  const result = await call(client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots, replace: true, confirm: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1, "uma requisição só");
  assert.deepEqual(calls.writes[0].operations, [
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~901` },
    { remove: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~902` },
    { create: { campaign: CAMPAIGN_RN, adSchedule: { dayOfWeek: "MONDAY", startHour: 13, startMinute: "ZERO", endHour: 19, endMinute: "ZERO" } } },
  ]);
  const body = jsonOf(result);
  assert.equal((body.unchanged as Row[]).length, 1);
  assert.equal((body.removed as Row[]).length, 2);
});

test("programação: API recusa → nada gravado e erro traduzido", async () => {
  const { client } = fakeClient({
    mutate: () => { throw new Error("Google Ads API: invalid — Time interval in the AdSchedule overlaps with another AdSchedule."); },
  });
  const result = await call(client, "set_ad_schedule", { campaignId: CAMPAIGN_ID, slots: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12 }] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /nada foi gravado \(operação atômica\)[\s\S]*se sobrepõem/);
});

// ── list_ad_schedules / update_ad_schedule_bid / remove_ad_schedule ───

test("list_ad_schedules: lista com métricas do ad_schedule_view e formatos", async () => {
  const { client, calls } = fakeClient({
    campaignCriteria: [schedule("900", "MONDAY", 8, 12, { bidModifier: 1.2 })],
    metricRows: {
      ad_schedule_view: [{ campaign: { id: CAMPAIGN_ID }, campaignCriterion: { criterionId: "900" }, metrics: { impressions: "100", clicks: "10", costMicros: "50000000", conversions: 2, conversionsValue: 400 } }],
    },
  });
  const result = await call(client, "list_ad_schedules", { campaignId: CAMPAIGN_ID, withMetrics: true, days: 30 });
  const schedules = jsonOf(result).schedules as Row[];
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].window, "08:00–12:00");
  assert.equal(schedules[0].bid_modifier, "+20% (1.2)");
  assert.equal(schedules[0].cpa, 25);
  assert.equal(schedules[0].roas, 8);
  assert.ok(calls.queries.some((q) => /FROM ad_schedule_view/.test(q)));

  const table = await call(fakeClient({ campaignCriteria: [schedule("900", "MONDAY", 8, 12)] }).client, "list_ad_schedules", { campaignId: CAMPAIGN_ID, format: "table" });
  assert.match(textOf(table), /window/);
  const empty = await call(fakeClient().client, "list_ad_schedules", { campaignId: CAMPAIGN_ID });
  assert.match(textOf(empty), /sem programação \(veicula 24\/7\)/);
});

test("update_ad_schedule_bid: partialFailure por item, pula iguais, aponta não encontrados", async () => {
  const existing = [schedule("900", "MONDAY", 8, 12, { bidModifier: 1.2 }), schedule("901", "TUESDAY", 8, 12)];
  const { client, calls } = fakeClient({
    campaignCriteria: existing,
    mutate: () => ({
      results: [{}],
      partialFailureError: { details: [{ errors: [{ message: "Cannot set bid modifier for this criterion type.", errorCode: { criterionError: "CANNOT_BID_MODIFY_CRITERION_TYPE" }, location: { fieldPathElements: [{ fieldName: "operations", index: 0 }] } }] }] },
    }),
  });
  const result = await call(client, "update_ad_schedule_bid", {
    campaignId: CAMPAIGN_ID,
    updates: [{ criterionId: "900", bidModifier: 1.2 }, { criterionId: "901", bidModifier: 0.8 }, { criterionId: "777", bidModifier: 1.1 }],
  });
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.deepEqual(calls.writes[0].operations, [
    { update: { resourceName: `customers/${CID}/campaignCriteria/${CAMPAIGN_ID}~901`, bidModifier: 0.8 }, updateMask: "bid_modifier" },
  ]);
  assert.equal(result.isError, true);
  const body = jsonOf(result);
  assert.deepEqual(body.not_found, ["777"]);
  assert.equal((body.unchanged as Row[]).length, 1);
  assert.match(String((body.errors as Row[])[0].error), /Este tipo de campanha não aceita ajuste/);

  const bad = fakeClient();
  const refused = await call(bad.client, "update_ad_schedule_bid", { campaignId: CAMPAIGN_ID, criterionIds: ["900"], bidModifier: 0 });
  assert.equal(refused.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("remove_ad_schedule: exige confirm; remover todos avisa que volta a 24/7", async () => {
  const existing = [schedule("900", "MONDAY", 8, 12), schedule("901", "TUESDAY", 8, 12)];
  const gate = fakeClient({ campaignCriteria: existing });
  const refused = await call(gate.client, "remove_ad_schedule", { campaignId: CAMPAIGN_ID, all: true });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /removeria 2 horário[\s\S]*veicular 24\/7[\s\S]*confirm: true/);
  assert.equal(gate.calls.writes.length, 0);

  const { client, calls } = fakeClient({ campaignCriteria: existing });
  const result = await call(client, "remove_ad_schedule", { campaignId: CAMPAIGN_ID, all: true, confirm: true });
  assert.equal(result.isError, false);
  assert.deepEqual(calls.writes[0].operations.map((op) => op.remove), existing.map((s) => s.resourceName));
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.match(textOf(result), /veicular 24\/7/);

  const some = fakeClient({ campaignCriteria: existing });
  const partial = await call(some.client, "remove_ad_schedule", { campaignId: CAMPAIGN_ID, criterionIds: ["901", "555"], confirm: true });
  assert.deepEqual(some.calls.writes[0].operations, [{ remove: existing[1].resourceName }]);
  assert.deepEqual(jsonOf(partial).not_found, ["555"]);

  const dry = fakeClient({ campaignCriteria: existing });
  const validated = await call(dry.client, "remove_ad_schedule", { campaignId: CAMPAIGN_ID, criterionIds: ["900"], validateOnly: true });
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(validated), /DRY-RUN \(validateOnly\): nada foi removido/);
});

// ── get_time_performance ──────────────────────────────────────────────

test("get_time_performance: grade 7×24, parcela de impressões e horários fracos/fortes", async () => {
  const cell = (day: string, hour: number, cost: number, conv: number, value = 0, is?: number) => ({
    segments: { dayOfWeek: day, hour },
    metrics: { impressions: "1000", clicks: "100", costMicros: String(cost * 1_000_000), conversions: conv, conversionsValue: value, ...(is ? { searchImpressionShare: is } : {}) },
  });
  const { client, calls } = fakeClient({
    metricRows: {
      customer: [
        cell("MONDAY", 9, 100, 10, 0, 0.5),
        cell("MONDAY", 10, 100, 1),
        cell("TUESDAY", 3, 60, 0),
        cell("WEDNESDAY", 20, 40, 4),
      ],
    },
  });
  const result = await call(client, "get_time_performance", { days: 30 });
  assert.match(calls.queries[0], /SELECT segments\.day_of_week, segments\.hour,[\s\S]*FROM customer/);
  const body = jsonOf(result);
  const totals = body.totals as Row;
  assert.equal(totals.cpa, 20); // 300 / 15
  const grid = (body.grid as Row).rows as Record<string, Array<number | null>>;
  assert.equal(grid.MONDAY[9], 10);
  assert.equal(grid.MONDAY[10], 100);
  assert.equal(grid.SUNDAY[0], null);
  const weak = (body.weak as Row[]).map((w) => w.when);
  assert.deepEqual(weak, ["MONDAY 10h", "TUESDAY 03h"]);
  const strong = (body.strong as Row[]).map((w) => w.when);
  assert.deepEqual(strong, ["MONDAY 09h", "WEDNESDAY 20h"]);

  const hour = fakeClient({ metricRows: { campaign: [{ segments: { hour: 9 }, metrics: { impressions: "1000", clicks: "10", costMicros: "10000000", conversions: 1, searchImpressionShare: 0.25 } }] } });
  const byHour = await call(hour.client, "get_time_performance", { campaignId: CAMPAIGN_ID, dimension: "HOUR", format: "csv" });
  assert.match(hour.calls.queries[0], /FROM campaign[\s\S]*campaign\.id = 111/);
  assert.match(textOf(byHour), /search_is_pct/);
  assert.match(textOf(byHour), /,25,/);

  const bad = fakeClient();
  await assert.rejects(call(bad.client, "get_time_performance", { dateRange: { since: "2026-01-01' OR 1=1", until: "2026-01-31" } }), /dateRange inválido/);
  assert.equal(bad.calls.queries.length, 0);
});

// ── list_bid_modifiers / get_device_breakdown ─────────────────────────

test("list_bid_modifiers: campanha e grupos, com exclusões e ajustes", async () => {
  const { client, calls } = fakeClient({
    campaignCriteria: [
      deviceCriterion("MOBILE", "30001", { bidModifier: 1.2 }),
      locationCriterion("2076", { displayName: "Brazil", bidModifier: 1.1 }),
      schedule("900", "MONDAY", 8, 12),
      { type: "AGE_RANGE", criterionId: "503001", negative: true, ageRange: { type: "AGE_RANGE_18_24" }, status: "ENABLED" },
    ],
    adGroupCriteria: [ageCriterion("AGE_RANGE_65_UP", { bidModifier: 0.7 })],
    adGroupBidModifiers: [{ criterionId: "30000", bidModifier: 0, device: { type: "DESKTOP" } }],
  });
  const result = await call(client, "list_bid_modifiers", { campaignId: CAMPAIGN_ID });
  const body = jsonOf(result);
  const level = body.campaign_level as Record<string, Row[]>;
  assert.equal(level.devices[0].bid_modifier, "+20% (1.2)");
  assert.match(String(level.locations[0].value), /Brazil/);
  assert.equal(level.ad_schedules.length, 1);
  assert.equal(level.demographics[0].bid_modifier, "excluído");
  const groups = body.ad_groups as Array<{ entries: Row[] }>;
  assert.equal(groups[0].entries.length, 2);
  assert.equal(calls.queries.length, 4);
});

test("get_device_breakdown: conta (FROM customer) e campanha (FROM campaign + ajuste atual)", async () => {
  const rows = [
    { segments: { device: "MOBILE" }, metrics: { impressions: "1000", clicks: "100", costMicros: "300000000", conversions: 10, conversionsValue: 1200 } },
    { segments: { device: "DESKTOP" }, metrics: { impressions: "500", clicks: "50", costMicros: "100000000", conversions: 5, conversionsValue: 600 } },
  ];
  const account = fakeClient({ metricRows: { customer: rows } });
  const accountResult = JSON.parse(textOf(await call(account.client, "get_device_breakdown", { days: 30 }))) as Row[];
  assert.match(account.calls.queries[0], /FROM customer/);
  assert.doesNotMatch(account.calls.queries[0], /campaign\.id/);
  assert.equal(accountResult[0].device, "MOBILE");
  assert.equal(accountResult[0].cpa, 30);
  assert.equal(accountResult[0].spend_share_pct, 75);
  assert.equal(accountResult[0].ctr, 10);
  assert.equal(accountResult[0].roas, 4);

  const campaign = fakeClient({ metricRows: { campaign: rows }, campaignCriteria: [deviceCriterion("MOBILE", "30001", { bidModifier: 0.8 })] });
  const campaignResult = JSON.parse(textOf(await call(campaign.client, "get_device_breakdown", { campaignId: CAMPAIGN_ID, days: 7 }))) as Row[];
  assert.match(campaign.calls.queries[0], /FROM campaign[\s\S]*campaign\.id = 111/);
  assert.equal(campaignResult[0].bid_adjustment, "-20% (0.8)");
  assert.equal(campaignResult[1].bid_adjustment, "sem ajuste (1.0)");

  const bad = await call(fakeClient().client, "get_device_breakdown", { campaignId: "1 OR 1=1" });
  assert.equal(bad.isError, true);
});

// ── set_frequency_cap / get_frequency_report ──────────────────────────

const displayCampaign = (caps: Row[] = []) => searchCampaign({ advertisingChannelType: "DISPLAY", frequencyCaps: caps });
const apiCap = (eventType: string, timeUnit: string, cap: number, level = "CAMPAIGN", timeLength = 1) => ({ key: { level, eventType, timeUnit, timeLength }, cap });

test("frequência: MERGE lê os atuais e troca só a chave pedida; updateMask frequency_caps", async () => {
  const { client, calls } = fakeClient({ campaign: displayCampaign([apiCap("IMPRESSION", "DAY", 3), apiCap("IMPRESSION", "WEEK", 10)]) });
  const result = await call(client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 5 }] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].resource, "campaigns");
  const op = calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "frequency_caps");
  assert.deepEqual(op.update, { resourceName: CAMPAIGN_RN, frequencyCaps: [apiCap("IMPRESSION", "DAY", 5), apiCap("IMPRESSION", "WEEK", 10)] });
  assert.match(textOf(result), /3 impressão\(ões\) por dia/);
});

test("frequência: igual ao atual não escreve; cap 0 em MERGE remove; REPLACE [] exige confirm", async () => {
  const current = [apiCap("IMPRESSION", "DAY", 3)];
  const same = fakeClient({ campaign: displayCampaign(current) });
  const noop = await call(same.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 3 }] });
  assert.match(textOf(noop), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const gate = fakeClient({ campaign: displayCampaign(current) });
  const refused = await call(gate.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 0 }] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /removeria todos os limites/);
  assert.equal(gate.calls.writes.length, 0);

  const clear = fakeClient({ campaign: displayCampaign(current) });
  await call(clear.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [], mode: "REPLACE", confirm: true });
  assert.deepEqual((clear.calls.writes[0].operations[0] as { update: Row }).update.frequencyCaps, []);
});

test("frequência: canais e combinações não suportadas são recusados antes de escrever", async () => {
  const demandGen = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "DEMAND_GEN" }) });
  const dg = await call(demandGen.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 3 }] });
  assert.equal(dg.isError, true);
  assert.match(textOf(dg), /Demand Gen/);

  const search = fakeClient({ campaign: searchCampaign() });
  const onSearch = await call(search.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 3 }] });
  assert.equal(onSearch.isError, true);
  assert.match(textOf(onSearch), /só grava limite de frequência em campanhas Display/);
  assert.equal(demandGen.calls.writes.length + search.calls.writes.length, 0);

  // eventType é opcional (IMPRESSION) e o nível pode ser grupo/anúncio em Display
  const display = fakeClient({ campaign: displayCampaign() });
  const ok = await call(display.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ timeUnit: "WEEK", cap: 2, level: "AD_GROUP" }] });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.deepEqual((display.calls.writes[0].operations[0] as { update: Row }).update.frequencyCaps, [apiCap("IMPRESSION", "WEEK", 2, "AD_GROUP")]);

  for (const caps of [[{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 2.5 }], [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 2 }, { eventType: "IMPRESSION", timeUnit: "DAY", cap: 4 }], [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 2, timeLength: 0 }]]) {
    const bad = fakeClient({ campaign: displayCampaign() });
    const result = await call(bad.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps });
    assert.equal(result.isError, true, JSON.stringify(caps));
    assert.equal(bad.calls.queries.length, 0, JSON.stringify(caps));
  }
});

test("frequência: Vídeo é recusado antes de escrever — a API não altera campanhas de Vídeo", async () => {
  // developers.google.com/google-ads/api/docs/video/overview: "You cannot create new Video campaigns
  // or update existing Video campaigns using the Google Ads API."
  const video = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "VIDEO", frequencyCaps: [apiCap("IMPRESSION", "WEEK", 5)] }) });
  const refused = await call(video.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "WEEK", cap: 2 }] });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /é de Vídeo: a API do Google Ads não cria nem altera campanhas de Vídeo[\s\S]*interface do Google Ads[\s\S]*get_frequency_report/);
  assert.equal(video.calls.writes.length, 0);

  const dry = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "VIDEO", frequencyCaps: [] }) });
  const validated = await call(dry.client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "WEEK", cap: 2 }], validateOnly: true });
  assert.equal(validated.isError, true, "nem em validateOnly: a API recusaria");
  assert.equal(dry.calls.writes.length, 0);

  // VIDEO_VIEW (evento que só existe em Vídeo) é recusado antes de qualquer chamada, com o motivo
  for (const campaign of [displayCampaign(), searchCampaign({ advertisingChannelType: "VIDEO", frequencyCaps: [] })]) {
    const { client, calls } = fakeClient({ campaign });
    const result = await call(client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "VIDEO_VIEW", timeUnit: "WEEK", cap: 2 }] });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /VIDEO_VIEW só existe em campanhas de Vídeo[\s\S]*não cria nem altera campanhas de Vídeo/);
    assert.equal(calls.queries.length, 0);
    assert.equal(calls.writes.length, 0);
  }

  // o schema publicado não oferece VIDEO_VIEW e a descrição não promete Vídeo
  const { configs } = register(fakeClient().client);
  type Parser = { safeParse: (value: unknown) => { success: boolean } };
  const config = configs.get("set_frequency_cap") as { description: string; inputSchema: Record<string, Parser> };
  assert.equal(config.inputSchema.caps.safeParse([{ eventType: "VIDEO_VIEW", timeUnit: "WEEK", cap: 2 }]).success, false);
  assert.equal(config.inputSchema.caps.safeParse([{ eventType: "IMPRESSION", timeUnit: "WEEK", cap: 2 }]).success, true);
  assert.doesNotMatch(config.description, /Vídeo: IMPRESSION/);
  assert.match(config.description, /Vídeo: recusado/);
});

test("get_frequency_report: Vídeo continua na leitura, com nota de que só muda na interface", async () => {
  const { client, calls } = fakeClient({ campaign: searchCampaign({ advertisingChannelType: "VIDEO", frequencyCaps: [apiCap("IMPRESSION", "WEEK", 5)] }) });
  const result = await call(client, "get_frequency_report", { days: 14 });
  const body = jsonOf(result);
  assert.equal(((body.campaigns as Row[])[0]).frequency_caps, "5 impressão(ões) por semana, por campanha");
  assert.match(JSON.stringify(body.notes), /Campanhas de Vídeo: os limites são só leitura/);
  assert.equal(calls.writes.length, 0);
});

test("frequência: validateOnly valida sem gravar", async () => {
  const { client, calls } = fakeClient({ campaign: displayCampaign() });
  const result = await call(client, "set_frequency_cap", { campaignId: CAMPAIGN_ID, caps: [{ eventType: "IMPRESSION", timeUnit: "DAY", cap: 4 }], validateOnly: true });
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY[\s\S]*nada foi gravado/);
});

test("get_frequency_report: métricas de alcance respeitam as janelas de 31 e 92 dias", async () => {
  const withPlus = fakeClient({ campaign: displayCampaign([apiCap("IMPRESSION", "DAY", 3)]) });
  await call(withPlus.client, "get_frequency_report", { days: 30 });
  assert.ok(withPlus.calls.queries.some((q) => /unique_users_two_plus/.test(q)));

  const noPlus = fakeClient({ campaign: displayCampaign() });
  const mid = await call(noPlus.client, "get_frequency_report", { days: 60 });
  assert.ok(noPlus.calls.queries.some((q) => /metrics\.unique_users,/.test(q)));
  assert.ok(!noPlus.calls.queries.some((q) => /unique_users_two_plus/.test(q)));
  assert.match(textOf(mid), /até 31 dias/);

  const tooLong = fakeClient({ campaign: displayCampaign() });
  const long = await call(tooLong.client, "get_frequency_report", { days: 120 });
  assert.ok(!tooLong.calls.queries.some((q) => /unique_users/.test(q)));
  assert.match(textOf(long), /até 92 dias/);

  const reach = fakeClient({
    campaign: displayCampaign([apiCap("IMPRESSION", "DAY", 3)]),
    metricRows: { campaign: [{ campaign: { id: CAMPAIGN_ID }, metrics: { impressions: "900", uniqueUsers: "300", averageImpressionFrequencyPerUser: 3, uniqueUsersTwoPlus: "120" } }] },
  });
  const report = jsonOf(await call(reach.client, "get_frequency_report", { campaignId: CAMPAIGN_ID, days: 14 }));
  const row = (report.campaigns as Row[])[0];
  assert.equal(row.frequency_caps, "3 impressão(ões) por dia, por campanha");
  assert.equal(row.unique_users, 300);
  assert.equal(row.users_2_plus, 120);
});
