/**
 * Lote placements-brand-safety: posicionamentos, exclusões e brand safety.
 *
 * O gap de origem: add_placement mandava toda URL como placement.url (o próprio exemplo,
 * youtube.com/channel/…, a API recusa com YOUTUBE_URL_UNSUPPORTED), só positivo e só no grupo;
 * não havia exclusão de posicionamento (grupo, campanha, conta, listas, MCC), rótulos de conteúdo,
 * inventário de vídeo, IP, visão da segmentação nem como desfazer um critério.
 *
 * Duas camadas: handlers com um client falso que valida cada GAQL contra os metadados reais da
 * v25 (assertGaqlRules) e registra as escritas; e o GoogleAdsClient real com fetch interceptado
 * (prova URL e corpo HTTP, inclusive validateOnly).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { createReadOnlyToolServer } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { parseIpBlock, parsePlacement } from "../src/tools/placements-brand-safety.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
type RowsFn = (query: string, customerId: string) => Row[];

const CID = "1234567890";
const MCC = "9998887776";
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv"; // UC + 22
const VIDEO_ID = "dQw4w9WgXcQ";

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  rows?: Record<string, Row[] | RowsFn>;
  mutate?: (resource: string, operations: Row[], customerId: string) => Row | Promise<Row>;
  batchMutate?: (operations: Row[]) => Row | Promise<Row>;
}

interface Write {
  method: string;
  customerId: string;
  resource?: string;
  operations: Row[];
  options?: Row;
  dryRun: boolean;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as Array<{ customerId: string; query: string }>, writes: [] as Write[], dryRunClones: 0 };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true);
    },
    async searchStream(customerId: string, query: string): Promise<Row[]> {
      calls.queries.push({ customerId, query });
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      return typeof source === "function" ? source(query, customerId) : source ?? [];
    },
    async mutate(customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", customerId, resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations, customerId);
      if (dryRun) return {};
      return { results: operations.map((_op, i) => ({ resourceName: `customers/${customerId}/${resource}/${i + 1}` })) };
    },
    async batchMutate(customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", customerId, operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => {
          const key = Object.keys(op)[0].replace(/Operation$/, "Result");
          return { [key]: { resourceName: `customers/${customerId}/r/${i + 1}` } };
        }),
      };
    },
    async mutateAdGroups(customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroups", customerId, operations, dryRun });
      return dryRun ? {} : { results: [{ resourceName: `customers/${customerId}/adGroups/1` }] };
    },
  });
  return { client: build(false), calls };
}

function register(client: unknown, opts: { allowed?: string[]; hosted?: boolean; readOnly?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, opts.allowed ?? [], opts.hosted ?? false);
  return handlers;
}

async function call(client: unknown, name: string, args: Row, opts: { allowed?: string[]; hosted?: boolean } = {}) {
  const handler = register(client, opts).get(name);
  assert.ok(handler, `tool ${name} não registrada`);
  return handler({ customerId: CID, ...args });
}

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

/** O bloco JSON depois do cabeçalho (objeto ou array). */
function payloadOf(result: Result): Row {
  const body = textOf(result);
  const json = body.slice(body.indexOf("\n\n") + 2).trim();
  return JSON.parse(json) as Row;
}

const campaignRow = (id: string, channel: string, extra: Row = {}) => ({
  campaign: { id, name: `Campanha ${id}`, status: "ENABLED", advertisingChannelType: channel, advertisingChannelSubType: "UNSPECIFIED", ...extra },
});
const adGroupRow = (id: string, campaignId: string, channel: string, extra: Row = {}) => ({
  adGroup: { id, name: `Grupo ${id}`, status: "ENABLED", ...extra },
  campaign: { id: campaignId, name: `Campanha ${campaignId}`, status: "ENABLED", advertisingChannelType: channel },
});
const onlyWrites = (calls: { writes: Write[] }) => calls.writes;

// ── Parser de posicionamento e IP ─────────────────────────────────────

test("parser: URL do YouTube vira canal/vídeo; @handle e URL sem ID são recusados", () => {
  const channel = parsePlacement(`https://www.youtube.com/channel/${CHANNEL_ID}`);
  assert.ok(!("error" in channel));
  assert.equal(channel.type, "YOUTUBE_CHANNEL");
  assert.deepEqual(channel.criterion, { youtubeChannel: { channelId: CHANNEL_ID } });

  for (const url of [`youtube.com/watch?v=${VIDEO_ID}`, `https://youtu.be/${VIDEO_ID}`, `https://m.youtube.com/shorts/${VIDEO_ID}`]) {
    const video = parsePlacement(url);
    assert.ok(!("error" in video), url);
    assert.equal(video.type, "YOUTUBE_VIDEO");
    assert.deepEqual(video.criterion, { youtubeVideo: { videoId: VIDEO_ID } });
  }

  // declarar WEBSITE com URL do YouTube: converte e explica por quê
  const declared = parsePlacement(`youtube.com/channel/${CHANNEL_ID}`, "WEBSITE");
  assert.ok(!("error" in declared));
  assert.equal(declared.type, "YOUTUBE_CHANNEL");
  assert.match(declared.note ?? "", /YOUTUBE_URL_UNSUPPORTED/);

  for (const bad of ["https://www.youtube.com/@marca", "youtube.com/c/Marca", "@marca", "youtube.com/playlist?list=PL1"]) {
    const result = parsePlacement(bad);
    assert.ok("error" in result, bad);
  }
  // @handle solto ou em URL: a recusa explica como achar o channel ID (não um "não parece site")
  for (const [value, declaredType] of [["https://www.youtube.com/@marca", "YOUTUBE_CHANNEL"], ["@marca", undefined], ["youtube.com/@marca", undefined]] as const) {
    const handle = parsePlacement(value, declaredType);
    assert.ok("error" in handle, value);
    assert.match(handle.error, /não converte @handle.*UC/, value);
  }
  assert.ok("error" in parsePlacement("UCcurto", "YOUTUBE_CHANNEL"));
  assert.ok("error" in parsePlacement("abc", "YOUTUBE_VIDEO"));
});

test("parser: apps (loja, mobileapp::, formato 1-/2-), categoria e sites com os limites da API", () => {
  const play = parsePlacement("https://play.google.com/store/apps/details?id=com.jogo.infantil");
  assert.ok(!("error" in play));
  assert.deepEqual(play.criterion, { mobileApplication: { appId: "2-com.jogo.infantil" } });
  const ios = parsePlacement("https://apps.apple.com/br/app/jogo/id476943146");
  assert.ok(!("error" in ios));
  assert.equal(ios.value, "1-476943146");
  const prefixed = parsePlacement("mobileapp::1-1286046770");
  assert.ok(!("error" in prefixed));
  assert.equal(prefixed.value, "1-1286046770");
  assert.ok("error" in parsePlacement("com.jogo", "MOBILE_APP"), "pacote sem o prefixo 2- é recusado");
  assert.ok(!("error" in parsePlacement("2-com.jogo", "MOBILE_APP")));

  const category = parsePlacement("60008", "MOBILE_APP_CATEGORY");
  assert.ok(!("error" in category));
  assert.deepEqual(category.criterion, { mobileAppCategory: { mobileAppCategoryConstant: "mobileAppCategoryConstants/60008" } });

  const site = parsePlacement("exemplo.com.br/noticias/");
  assert.ok(!("error" in site));
  assert.deepEqual(site.criterion, { placement: { url: "exemplo.com.br/noticias" } });
  assert.match(String((parsePlacement("site.com/a/b/c") as { error: string }).error), /até 2/);
  assert.match(String((parsePlacement("a.com, b.com") as { error: string }).error), /um posicionamento por item/);
  assert.match(String((parsePlacement("adsenseformobileapps.com") as { error: string }).error), /MOBILE_APP/);
  assert.ok("error" in parsePlacement(`site.com/${"x".repeat(260)}`));
  assert.ok("error" in parsePlacement("semponto"));
});

test("parser de IP: IPv4/IPv6, CIDR e curinga da interface; o resto é recusado", () => {
  assert.deepEqual(parseIpBlock("203.0.113.7"), { value: "203.0.113.7" });
  assert.deepEqual(parseIpBlock("203.0.113.0/24"), { value: "203.0.113.0/24" });
  assert.deepEqual(parseIpBlock("2001:DB8::/48"), { value: "2001:db8::/48" });
  const wildcard = parseIpBlock("203.0.113.*");
  assert.ok(!("error" in wildcard));
  assert.equal(wildcard.value, "203.0.113.0/24");
  for (const bad of ["999.1.1.1", "1.2.3.4/33", "abc", "1.2.3.4/24/1", "2001:db8::/129", ""]) {
    assert.ok("error" in parseIpBlock(bad), bad);
  }
});

// ── add_placement (existente, reescrita) ─────────────────────────────

test("add_placement: chamada antiga com URL de canal do YouTube vira youtubeChannel, não placement.url", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] } });
  const result = await call(client, "add_placement", { adGroupId: "555", url: `youtube.com/channel/${CHANNEL_ID}` });
  assert.equal(result.isError, undefined, textOf(result));
  const [write] = onlyWrites(calls);
  assert.equal(write.resource, "adGroupCriteria");
  assert.deepEqual(write.operations, [{
    create: { adGroup: `customers/${CID}/adGroups/555`, negative: false, youtubeChannel: { channelId: CHANNEL_ID } },
  }]);
  assert.match(textOf(result), /convertida para YOUTUBE_CHANNEL/);
});

test("add_placement: site, negativo na campanha e mapeamento de erro da API", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("111", "VIDEO")] } });
  const result = await call(client, "add_placement", { campaignId: "111", level: "CAMPAIGN", value: "exemplo.com.br", negative: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [{
    create: { campaign: `customers/${CID}/campaigns/111`, negative: true, placement: { url: "exemplo.com.br" } },
  }]);
  assert.equal(calls.writes[0].resource, "campaignCriteria");

  const failing = fakeClient({
    rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] },
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — YouTube urls are not supported in Placement criterion."); },
  });
  const error = await call(failing.client, "add_placement", { adGroupId: "555", value: "exemplo.com.br", type: "WEBSITE" });
  assert.equal(error.isError, true);
  assert.match(textOf(error), /Dica: URL do YouTube não vale como site/);
  assert.match(textOf(error), /Nada foi gravado/);
});

test("add_placement: entrada inválida e @handle são recusados antes de qualquer chamada", async () => {
  for (const args of [
    { adGroupId: "555", url: "https://www.youtube.com/@marca" },
    { adGroupId: "55x", url: "exemplo.com" },
    { url: "exemplo.com" }, // AD_GROUP sem adGroupId
    { adGroupId: "555", value: "a.com", url: "b.com" },
    { adGroupId: "555" },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "add_placement", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("add_placement: positivo em Pesquisa e qualquer coisa em PMax são recusados; repetido é no-op; oposto é conflito", async () => {
  const search = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "SEARCH")] } });
  const r1 = await call(search.client, "add_placement", { adGroupId: "555", value: "exemplo.com" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /CANNOT_TARGET_PLACEMENTS_FOR_SEARCH_CAMPAIGNS/);
  assert.equal(search.calls.writes.length, 0);

  const pmax = fakeClient({ rows: { campaign: [campaignRow("111", "PERFORMANCE_MAX")] } });
  const r2 = await call(pmax.client, "add_placement", { campaignId: "111", value: "exemplo.com", negative: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /exclude_placements.*ACCOUNT/);
  assert.equal(pmax.calls.writes.length, 0);

  const existing = [{ adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/555~9`, criterionId: "9", type: "PLACEMENT", negative: false, placement: { url: "https://Exemplo.com/" } } }];
  const same = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")], ad_group_criterion: existing } });
  const r3 = await call(same.client, "add_placement", { adGroupId: "555", value: "exemplo.com" });
  assert.equal(r3.isError, undefined);
  assert.match(textOf(r3), /já está segmentado/);
  assert.equal(same.calls.writes.length, 0);

  const opposite = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")], ad_group_criterion: existing } });
  const r4 = await call(opposite.client, "add_placement", { adGroupId: "555", value: "exemplo.com", negative: true });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /remove_targeting_criteria \(customers\/1234567890\/adGroupCriteria\/555~9\)/);
  assert.equal(opposite.calls.writes.length, 0);
});

test("add_placement: posicionamento POSITIVO na campanha é recusado antes de qualquer chamada (a API só aceita exclusão)", async () => {
  // Guia de critérios, "Campaign criteria": PlacementInfo "can only be configured as negative"; YouTubeChannel/Video,
  // MobileAppCategory "Only negative criteria are supported at the campaign level".
  const values = [
    "exemplo.com.br",
    `youtube.com/channel/${CHANNEL_ID}`,
    `youtu.be/${VIDEO_ID}`,
    "mobileapp::2-com.jogo.kids",
    { type: "MOBILE_APP_CATEGORY", value: "60008" },
  ];
  for (const value of values) {
    const placement = typeof value === "string" ? { value } : value;
    for (const extra of [{ level: "CAMPAIGN" }, {}, { level: "CAMPAIGN", negative: false }]) {
      // {} = só campaignId: não pode mais virar "CAMPAIGN + positivo" em silêncio
      const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("111", "DISPLAY")] } });
      const args = { campaignId: "111", ...placement, ...extra };
      const result = await call(client, "add_placement", args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(textOf(result), /só pode ser EXCLUSÃO/, JSON.stringify(args));
      assert.match(textOf(result), /level AD_GROUP com adGroupId/);
      assert.match(textOf(result), /negative: true/);
      assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
    }
  }

  // campanha VIDEO com canal/vídeo do YouTube (o cenário da revisão): também recusado sem chamada
  for (const value of [`youtube.com/channel/${CHANNEL_ID}`, `youtu.be/${VIDEO_ID}`]) {
    const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("111", "VIDEO")] } });
    const result = await call(client, "add_placement", { level: "CAMPAIGN", campaignId: "111", value });
    assert.equal(result.isError, true);
    assert.equal(calls.writes.length, 0);
  }

  // só campaignId + negative: true continua sendo a exclusão na campanha
  const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("111", "DISPLAY")] } });
  const ok = await call(client, "add_placement", { campaignId: "111", value: `youtube.com/channel/${CHANNEL_ID}`, negative: true });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal(calls.writes[0].resource, "campaignCriteria");
  assert.deepEqual(calls.writes[0].operations, [{
    create: { campaign: `customers/${CID}/campaigns/111`, negative: true, youtubeChannel: { channelId: CHANNEL_ID } },
  }]);

  // no grupo o positivo segue valendo
  const adGroup = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] } });
  const positive = await call(adGroup.client, "add_placement", { campaignId: "111", adGroupId: "555", value: "exemplo.com.br" });
  assert.equal(positive.isError, undefined, textOf(positive));
  assert.equal(adGroup.calls.writes[0].resource, "adGroupCriteria");
  assert.equal((adGroup.calls.writes[0].operations[0].create as Row).negative, false);
});

test("add_placement e set_topic_targeting: a descrição não anuncia segmentação positiva na campanha", () => {
  const configs = new Map<string, { description?: string; inputSchema?: Record<string, { description?: string }> }>();
  registerGoogleAdsTools({ registerTool(name: string, config: never) { configs.set(name, config); } } as never, () => ({}) as never, [], false);
  const add = configs.get("add_placement");
  assert.ok(add?.description);
  assert.doesNotMatch(add.description, /numa campanha \(level CAMPAIGN\), como segmentação/);
  assert.match(add.description, /Campanha \(level CAMPAIGN; campaignId\): SÓ exclusão/);
  const topic = configs.get("set_topic_targeting");
  assert.match(topic?.description ?? "", /level CAMPAIGN exige negative: true/);
  const update = configs.get("update_placement_exclusion_list");
  assert.doesNotMatch(update?.description ?? "", /create_placement_exclusion_list \(attachToAccount\)/);
  assert.ok(update?.inputSchema && "attachToAccount" in update.inputSchema && "detachFromAccount" in update.inputSchema);
});

test("add_placement: validateOnly roda no client em dry-run e não diz que gravou", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] } });
  const result = await call(client, "add_placement", { adGroupId: "555", value: "exemplo.com", validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /adicionado/);
});

// ── exclude_placements ───────────────────────────────────────────────

test("exclude_placements ACCOUNT: converte cada tipo, pula o que já existe e grava com partialFailure", async () => {
  const { client, calls } = fakeClient({
    rows: {
      customer_negative_criterion: [{ customerNegativeCriterion: { resourceName: `customers/${CID}/customerNegativeCriteria/7`, id: "7", type: "PLACEMENT", placement: { url: "lixo.com" } } }],
    },
  });
  const result = await call(client, "exclude_placements", {
    level: "ACCOUNT",
    items: [
      `https://www.youtube.com/channel/${CHANNEL_ID}`,
      { value: `https://youtu.be/${VIDEO_ID}` },
      { type: "MOBILE_APP", value: "https://play.google.com/store/apps/details?id=com.jogo.kids" },
      "http://lixo.com/",
      "noticias.com.br",
      "noticias.com.br", // repetido na própria chamada
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const [write] = calls.writes;
  assert.equal(write.resource, "customerNegativeCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations.map((op) => op.create), [
    { youtubeChannel: { channelId: CHANNEL_ID } },
    { youtubeVideo: { videoId: VIDEO_ID } },
    { mobileApplication: { appId: "2-com.jogo.kids" } },
    { placement: { url: "noticias.com.br" } },
  ]);
  const payload = payloadOf(result);
  assert.equal((payload.excluded as Row[]).length, 4);
  assert.deepEqual((payload.already_excluded as Row[]).map((r) => r.criterion_id), ["7"]);
  assert.deepEqual(payload.repeated_in_request, ["noticias.com.br"]);
});

test("exclude_placements: validação antes de qualquer chamada (nível, IDs, itens)", async () => {
  for (const args of [
    { level: "CAMPAIGN", items: ["a.com"] },
    { level: "ACCOUNT", campaignId: "111", items: ["a.com"] },
    { level: "AD_GROUP", adGroupId: "abc", items: ["a.com"] },
    { level: "ACCOUNT", items: ["a.com", "@handle"] },
    { level: "ACCOUNT", items: [{ type: "FOO", value: "a.com" }] },
    { level: "ACCOUNT", items: [] },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "exclude_placements", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("exclude_placements: PMax na campanha é recusado com o caminho da conta; positivo existente vira conflito", async () => {
  const pmax = fakeClient({ rows: { campaign: [campaignRow("111", "PERFORMANCE_MAX")] } });
  const r1 = await call(pmax.client, "exclude_placements", { level: "CAMPAIGN", campaignId: "111", items: ["a.com"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Use o nível ACCOUNT/);
  assert.equal(pmax.calls.writes.length, 0);

  const conflict = fakeClient({
    rows: {
      ad_group: [adGroupRow("555", "111", "DISPLAY")],
      ad_group_criterion: [{ adGroupCriterion: { resourceName: "x", criterionId: "3", type: "PLACEMENT", negative: false, placement: { url: "a.com" } } }],
    },
  });
  const r2 = await call(conflict.client, "exclude_placements", { level: "AD_GROUP", adGroupId: "555", items: ["a.com"] });
  assert.equal(r2.isError, true);
  assert.equal(conflict.calls.writes.length, 0);
  assert.match(textOf(r2), /segmentação POSITIVA/);
});

test("exclude_placements: erro por item (partialFailure) é mapeado com dica e o resto segue", async () => {
  const { client } = fakeClient({
    rows: { campaign: [campaignRow("111", "DISPLAY")] },
    mutate: (_resource, operations) => ({
      results: operations.map((_op, i) => (i === 1 ? {} : { resourceName: `customers/${CID}/campaignCriteria/111~${i}` })),
      partialFailureError: {
        details: [{ errors: [{
          errorCode: { criterionError: "PLACEMENT_IS_NOT_AVAILABLE_FOR_TARGETING_OR_EXCLUSION" },
          message: "Indicates the domain is blocked.",
          location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] },
        }] }],
      },
    }),
  });
  const result = await call(client, "exclude_placements", { level: "CAMPAIGN", campaignId: "111", items: ["a.com", "b.com", "c.com"] });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal((payload.excluded as Row[]).length, 2);
  const errors = payload.errors as Row[];
  assert.equal(errors[0].value, "b.com");
  assert.match(String(errors[0].error), /Dica: O Google não aceita esse domínio/);
});

test("exclude_placements: limite de 65.000 na conta e validateOnly", async () => {
  const many = Array.from({ length: 65_000 }, (_v, i) => ({ customerNegativeCriterion: { id: String(i), type: "PLACEMENT", placement: { url: `s${i}.com` } } }));
  const full = fakeClient({ rows: { customer_negative_criterion: many } });
  const r1 = await call(full.client, "exclude_placements", { level: "ACCOUNT", items: ["novo.com"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /limite de 65000/);
  assert.equal(full.calls.writes.length, 0);

  const dry = fakeClient();
  const r2 = await call(dry.client, "exclude_placements", { level: "ACCOUNT", items: ["novo.com"], validateOnly: true });
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r2), /DRY-RUN/);
  assert.ok("validated" in payloadOf(r2));
});

// ── Listas de exclusão ───────────────────────────────────────────────

test("create_placement_exclusion_list: uma requisição atômica com ID temporário, itens, campanhas e conta", async () => {
  const { client, calls } = fakeClient({
    rows: {
      customer: [{ customer: { id: CID, manager: false } }],
      shared_set: [{ sharedSet: { id: "1", name: "Outra", status: "ENABLED" } }],
      campaign: [campaignRow("111", "DISPLAY")],
    },
  });
  const result = await call(client, "create_placement_exclusion_list", {
    name: "Brand safety", items: ["lixo.com", `youtube.com/watch?v=${VIDEO_ID}`], attachCampaignIds: ["111"], attachToAccount: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const { method, operations } = calls.writes[0];
  assert.equal(method, "batchMutate");
  const temp = `customers/${CID}/sharedSets/-1`;
  assert.deepEqual(operations, [
    { sharedSetOperation: { create: { resourceName: temp, name: "Brand safety", type: "NEGATIVE_PLACEMENTS" } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, placement: { url: "lixo.com" } } } },
    { sharedCriterionOperation: { create: { sharedSet: temp, youtubeVideo: { videoId: VIDEO_ID } } } },
    { campaignSharedSetOperation: { create: { campaign: `customers/${CID}/campaigns/111`, sharedSet: temp } } },
    { customerNegativeCriterionOperation: { create: { placementList: { sharedSet: temp } } } },
  ]);
  assert.equal(payloadOf(result).shared_set, `customers/${CID}/r/1`);
});

test("create_placement_exclusion_list: nome repetido, limite de listas, MCC com campanha e campanha inexistente são recusados", async () => {
  const cases: Array<[FakeOptions["rows"], Row, RegExp]> = [
    [{ shared_set: [{ sharedSet: { id: "9", name: "Brand safety", status: "ENABLED" } }] }, {}, /Já existe a lista/],
    [{ shared_set: Array.from({ length: 20 }, (_v, i) => ({ sharedSet: { id: String(i), name: `L${i}` } })) }, {}, /limite 20/],
    [{ customer: [{ customer: { manager: true } }] }, { attachToAccount: true }, /attach_mcc_exclusion_list/],
    [{ campaign: [] }, { attachCampaignIds: ["111"] }, /campanha 111 não existe/],
  ];
  for (const [rows, extra, pattern] of cases) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "create_placement_exclusion_list", { name: "Brand safety", items: ["a.com"], ...extra });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
  const { client, calls } = fakeClient();
  const invalid = await call(client, "create_placement_exclusion_list", { name: "", items: ["a.com"] });
  assert.equal(invalid.isError, true);
  assert.equal(calls.queries.length, 0);
});

test("create_placement_exclusion_list: validateOnly valida a requisição atômica e erro da API ganha dica", async () => {
  const dry = fakeClient();
  const r1 = await call(dry.client, "create_placement_exclusion_list", { name: "L", items: ["a.com"], validateOnly: true });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r1), /nada foi criado/);

  const failing = fakeClient({ batchMutate: () => { throw new Error("Google Ads API: DUPLICATE_NAME"); } });
  const r2 = await call(failing.client, "create_placement_exclusion_list", { name: "L", items: ["a.com"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Dica: Já existe uma lista ativa/);
  assert.match(textOf(r2), /Nada foi criado \(requisição atômica\)/);
});

const LIST_ROWS = {
  shared_set: [{ sharedSet: { id: "77", name: "Lista", type: "NEGATIVE_PLACEMENTS", status: "ENABLED", memberCount: "2" }, customer: { manager: false } }],
  shared_criterion: [
    { sharedCriterion: { resourceName: `customers/${CID}/sharedCriteria/77~1`, type: "PLACEMENT", placement: { url: "velho.com" } } },
    { sharedCriterion: { resourceName: `customers/${CID}/sharedCriteria/77~2`, type: "YOUTUBE_CHANNEL", youtubeChannel: { channelId: CHANNEL_ID } } },
  ],
  campaign: [campaignRow("111", "DISPLAY"), campaignRow("222", "DISPLAY")],
  campaign_shared_set: [{ campaignSharedSet: { resourceName: `customers/${CID}/campaignSharedSets/222~77`, campaign: `customers/${CID}/campaigns/222`, status: "ENABLED" } }],
};

test("update_placement_exclusion_list: adiciona só o que falta; remover e desaplicar exigem confirm", async () => {
  const noConfirm = fakeClient({ rows: LIST_ROWS });
  const r1 = await call(noConfirm.client, "update_placement_exclusion_list", {
    sharedSetId: "77", addItems: ["novo.com", "velho.com"], removeItems: [`youtube.com/channel/${CHANNEL_ID}`], detachCampaignIds: ["222"],
  });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: LIST_ROWS });
  const r2 = await call(client, "update_placement_exclusion_list", {
    sharedSetId: "77", addItems: ["novo.com", "velho.com"], removeItems: [`youtube.com/channel/${CHANNEL_ID}`],
    attachCampaignIds: ["111"], detachCampaignIds: ["222"], confirm: true,
  });
  assert.notEqual(r2.isError, true, textOf(r2));
  const [items, links] = calls.writes;
  assert.equal(items.resource, "sharedCriteria");
  assert.deepEqual(items.operations, [
    { create: { sharedSet: `customers/${CID}/sharedSets/77`, placement: { url: "novo.com" } } },
    { remove: `customers/${CID}/sharedCriteria/77~2` },
  ]);
  assert.equal(links.resource, "campaignSharedSets");
  assert.deepEqual(links.operations, [
    { create: { campaign: `customers/${CID}/campaigns/111`, sharedSet: `customers/${CID}/sharedSets/77` } },
    { remove: `customers/${CID}/campaignSharedSets/222~77` },
  ]);
  assert.equal((payloadOf(r2).already_in_list as Row[]).length, 1);
});

test("update_placement_exclusion_list: lista de outro tipo é recusada e sem mudança nada é gravado", async () => {
  const wrong = fakeClient({ rows: { shared_set: [{ sharedSet: { id: "77", name: "Negativas", type: "NEGATIVE_KEYWORDS", status: "ENABLED" } }] } });
  const r1 = await call(wrong.client, "update_placement_exclusion_list", { sharedSetId: "77", addItems: ["a.com"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /NEGATIVE_KEYWORDS/);
  assert.equal(wrong.calls.writes.length, 0);

  const same = fakeClient({ rows: LIST_ROWS });
  const r2 = await call(same.client, "update_placement_exclusion_list", { sharedSetId: "77", addItems: ["velho.com"], attachCampaignIds: ["222"] });
  assert.equal(r2.isError, undefined);
  assert.match(textOf(r2), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);
});

/** Lista existente (criada antes sem attachToAccount ou na interface) e o critério PLACEMENT_LIST da conta. */
function accountListRows(attached: boolean, manager = false): FakeOptions["rows"] {
  return {
    shared_set: [{ sharedSet: { id: "77", name: "Brand safety", type: "NEGATIVE_PLACEMENTS", status: "ENABLED", memberCount: "2" }, customer: { manager } }],
    shared_criterion: LIST_ROWS.shared_criterion,
    customer_negative_criterion: [
      // lista de MCC aplicada na conta: não pode ser confundida com a lista 77
      { customerNegativeCriterion: { resourceName: `customers/${CID}/customerNegativeCriteria/40`, id: "40", placementList: { sharedSet: `customers/${MCC}/sharedSets/77` } } },
      ...(attached
        ? [{ customerNegativeCriterion: { resourceName: `customers/${CID}/customerNegativeCriteria/41`, id: "41", placementList: { sharedSet: `customers/${CID}/sharedSets/77` } } }]
        : []),
    ],
  };
}

test("update_placement_exclusion_list attachToAccount: lista existente vai para a conta inteira (PMax); já aplicada é no-op", async () => {
  // o cenário da revisão: create recusa o nome repetido e aponta para update — que agora tem o caminho da conta
  const create = fakeClient({ rows: { ...accountListRows(false), customer: [{ customer: { id: CID, manager: false } }] } });
  const refused = await call(create.client, "create_placement_exclusion_list", { name: "Brand safety", items: ["a.com"], attachToAccount: true });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /update_placement_exclusion_list com sharedSetId 77.*attachToAccount/s);
  assert.equal(create.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows: accountListRows(false) });
  const result = await call(client, "update_placement_exclusion_list", { sharedSetId: "77", attachToAccount: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const [write] = calls.writes;
  assert.equal(write.resource, "customerNegativeCriteria");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [{ create: { placementList: { sharedSet: `customers/${CID}/sharedSets/77` } } }]);
  const payload = payloadOf(result);
  assert.deepEqual(payload.account, { attached_before: false, attached_after: true });
  assert.deepEqual(payload.applied, [{ action: "attach_to_account", resource_name: `customers/${CID}/customerNegativeCriteria/1` }]);
  assert.ok(calls.queries.some((q) => /FROM customer_negative_criterion/.test(q.query) && /'PLACEMENT_LIST'/.test(q.query)));

  // já aplicada na conta: nada é gravado
  const same = fakeClient({ rows: accountListRows(true) });
  const noop = await call(same.client, "update_placement_exclusion_list", { sharedSetId: "77", attachToAccount: true });
  assert.equal(noop.isError, undefined, textOf(noop));
  assert.match(textOf(noop), /nada a mudar/);
  assert.deepEqual(payloadOf(noop).account, { attached_before: true, criterion_id: "41", attached_after: true });
  assert.equal(same.calls.writes.length, 0);

  // junto com itens: itens e conta gravados, cada um no seu serviço
  const mixed = fakeClient({ rows: accountListRows(false) });
  const both = await call(mixed.client, "update_placement_exclusion_list", { sharedSetId: "77", addItems: ["novo.com"], attachToAccount: true });
  assert.equal(both.isError, undefined, textOf(both));
  assert.deepEqual(mixed.calls.writes.map((w) => w.resource), ["sharedCriteria", "customerNegativeCriteria"]);
});

test("update_placement_exclusion_list detachFromAccount: exige confirm, remove o critério certo e é no-op se não está na conta", async () => {
  const noConfirm = fakeClient({ rows: accountListRows(true) });
  const r1 = await call(noConfirm.client, "update_placement_exclusion_list", { sharedSetId: "77", detachFromAccount: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  assert.match(textOf(r1), /tirar a lista da conta inteira/);
  assert.equal(noConfirm.calls.writes.length, 0);
  assert.equal(payloadOf(r1).would_detach_from_account, `customers/${CID}/customerNegativeCriteria/41`);

  const { client, calls } = fakeClient({ rows: accountListRows(true) });
  const r2 = await call(client, "update_placement_exclusion_list", { sharedSetId: "77", detachFromAccount: true, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "customerNegativeCriteria");
  // só o critério da lista 77 desta conta — nunca o da lista de MCC (40)
  assert.deepEqual(calls.writes[0].operations, [{ remove: `customers/${CID}/customerNegativeCriteria/41` }]);
  assert.deepEqual(payloadOf(r2).account, { attached_before: true, criterion_id: "41", attached_after: false });

  const notAttached = fakeClient({ rows: accountListRows(false) });
  const r3 = await call(notAttached.client, "update_placement_exclusion_list", { sharedSetId: "77", detachFromAccount: true, confirm: true });
  assert.equal(r3.isError, undefined, textOf(r3));
  assert.match(textOf(r3), /nada a mudar/);
  assert.equal(notAttached.calls.writes.length, 0);

  // validateOnly dispensa o confirm e grava só no client em dry-run
  const dry = fakeClient({ rows: accountListRows(true) });
  const r4 = await call(dry.client, "update_placement_exclusion_list", { sharedSetId: "77", detachFromAccount: true, validateOnly: true });
  assert.equal(r4.isError, undefined, textOf(r4));
  assert.ok(dry.calls.writes.length === 1 && dry.calls.writes[0].dryRun);
  assert.match(textOf(r4), /DRY-RUN \(validateOnly\)/);
  assert.doesNotMatch(textOf(r4), /mudança\(s\) aplicada/);
});

test("update_placement_exclusion_list conta: attach+detach juntos, MCC e erro da API são recusados/relatados", async () => {
  const both = fakeClient({ rows: accountListRows(false) });
  const r1 = await call(both.client, "update_placement_exclusion_list", { sharedSetId: "77", attachToAccount: true, detachFromAccount: true, confirm: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /ao mesmo tempo/);
  assert.equal(both.calls.queries.length + both.calls.writes.length, 0);

  const manager = fakeClient({ rows: accountListRows(false, true) });
  const r2 = await call(manager.client, "update_placement_exclusion_list", { sharedSetId: "77", attachToAccount: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /attach_mcc_exclusion_list/);
  assert.equal(manager.calls.writes.length, 0);

  const failing = fakeClient({
    rows: accountListRows(false),
    mutate: () => { throw new Error("Google Ads API: PLACEMENT_LIST_SHARED_SET_DOES_NOT_EXIST"); },
  });
  const r3 = await call(failing.client, "update_placement_exclusion_list", { sharedSetId: "77", attachToAccount: true });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /nível da conta não gravado/);
  assert.match(textOf(r3), /Dica: A lista não existe ou foi removida/);
});

test("list_placement_exclusion_lists: tamanho, campanhas, conta e itens", async () => {
  const { client } = fakeClient({
    rows: {
      shared_set: [{ sharedSet: { id: "77", name: "Lista", memberCount: "2", referenceCount: "1", resourceName: `customers/${CID}/sharedSets/77` } }],
      campaign_shared_set: [{ campaign: { id: "222", name: "Display" }, campaignSharedSet: { sharedSet: `customers/${CID}/sharedSets/77` } }],
      customer_negative_criterion: [
        { customerNegativeCriterion: { id: "5", placementList: { sharedSet: `customers/${CID}/sharedSets/77` } } },
        { customerNegativeCriterion: { id: "6", placementList: { sharedSet: `customers/${MCC}/sharedSets/3` } } },
      ],
      shared_criterion: LIST_ROWS.shared_criterion,
    },
  });
  const result = await call(client, "list_placement_exclusion_lists", { includeItems: true });
  const payload = payloadOf(result);
  const [list] = payload.lists as Row[];
  assert.equal(list.attached_to_account, true);
  assert.deepEqual(list.campaigns, [{ campaign_id: "222", campaign_name: "Display" }]);
  assert.equal((list.placements as Row[]).length, 2);
  assert.deepEqual(payload.manager_lists_applied_to_account, [`customers/${MCC}/sharedSets/3`]);
});

// ── attach_mcc_exclusion_list ────────────────────────────────────────

function mccRows(): FakeOptions["rows"] {
  return {
    customer: [{ customer: { id: MCC, manager: true, descriptiveName: "Agência" } }],
    shared_set: [{ sharedSet: { id: "3", name: "Brand safety agência", type: "NEGATIVE_PLACEMENTS", status: "ENABLED", memberCount: "900" } }],
    customer_client: [
      { customerClient: { id: "1111111111", descriptiveName: "Cliente A", status: "ENABLED" } },
      { customerClient: { id: "2222222222", descriptiveName: "Cliente B", status: "ENABLED" } },
    ],
    customer_negative_criterion: (_query: string, customerId: string) =>
      customerId === "2222222222"
        ? [{ customerNegativeCriterion: { placementList: { sharedSet: `customers/${MCC}/sharedSets/3` } } }]
        : [],
  };
}

test("attach_mcc_exclusion_list: grava placement_list da MCC em cada cliente; quem já tem é pulado", async () => {
  const { client, calls } = fakeClient({ rows: mccRows() });
  const result = await call(client, "attach_mcc_exclusion_list", {
    managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["111-111-1111", "2222222222"], confirm: true,
  });
  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].customerId, "1111111111");
  assert.equal(calls.writes[0].resource, "customerNegativeCriteria");
  assert.deepEqual(calls.writes[0].operations, [{ create: { placementList: { sharedSet: `customers/${MCC}/sharedSets/3` } } }]);
  const clients = payloadOf(result).clients as Row[];
  assert.deepEqual(clients.map((c) => c.status), ["attached", "already_attached"]);
});

test("attach_mcc_exclusion_list: sem confirm, conta não-MCC, fora da hierarquia e allowlist são recusados sem gravar", async () => {
  const noConfirm = fakeClient({ rows: mccRows() });
  const r1 = await call(noConfirm.client, "attach_mcc_exclusion_list", { managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["1111111111"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /confirm: true/);
  assert.equal(noConfirm.calls.writes.length, 0);

  const notManager = fakeClient({ rows: { ...mccRows(), customer: [{ customer: { id: MCC, manager: false } }] } });
  const r2 = await call(notManager.client, "attach_mcc_exclusion_list", { managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["1111111111"], confirm: true });
  assert.match(textOf(r2), /não é gerente/);
  assert.equal(notManager.calls.writes.length, 0);

  const outside = fakeClient({ rows: mccRows() });
  const r3 = await call(outside.client, "attach_mcc_exclusion_list", { managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["3333333333"], confirm: true });
  assert.match(textOf(r3), /fora da hierarquia/);
  assert.equal(outside.calls.writes.length, 0);

  const guarded = fakeClient({ rows: mccRows() });
  const r4 = await call(guarded.client, "attach_mcc_exclusion_list",
    { managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["1111111111"], confirm: true },
    { allowed: [MCC], hosted: true });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /Access denied: customer 1111111111/);
  assert.equal(guarded.calls.queries.length + guarded.calls.writes.length, 0);
});

// ── Conteúdo, inventário de vídeo e IP ───────────────────────────────

test("set_content_exclusions: ADD na campanha cria só os rótulos que faltam, como negativos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow("111", "VIDEO")],
      campaign_criterion: [{ campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/111~1`, contentLabel: { type: "TRAGEDY" } } }],
    },
  });
  const result = await call(client, "set_content_exclusions", {
    level: "CAMPAIGN", campaignId: "111", labels: ["TRAGEDY", "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES"],
  });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [{
    create: { campaign: `customers/${CID}/campaigns/111`, negative: true, contentLabel: { type: "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES" } },
  }]);
  assert.deepEqual(payloadOf(result).after, ["BRAND_SUITABILITY_CONTENT_FOR_FAMILIES", "TRAGEDY"]);
});

test("set_content_exclusions: REPLACE na conta remove só com confirm; sem mudança não grava; PMax e rótulo inválido recusados", async () => {
  const rows = { customer_negative_criterion: [{ customerNegativeCriterion: { resourceName: `customers/${CID}/customerNegativeCriteria/4`, contentLabel: { type: "PROFANITY" } } }] };
  const gated = fakeClient({ rows });
  const r1 = await call(gated.client, "set_content_exclusions", { level: "ACCOUNT", labels: ["JUVENILE"], mode: "REPLACE" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /PROFANITY/);
  assert.equal(gated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  await call(client, "set_content_exclusions", { level: "ACCOUNT", labels: ["JUVENILE"], mode: "REPLACE", confirm: true });
  assert.equal(calls.writes[0].resource, "customerNegativeCriteria");
  assert.deepEqual(calls.writes[0].operations, [
    { create: { contentLabel: { type: "JUVENILE" } } },
    { remove: `customers/${CID}/customerNegativeCriteria/4` },
  ]);

  const same = fakeClient({ rows });
  const r3 = await call(same.client, "set_content_exclusions", { level: "ACCOUNT", labels: ["PROFANITY"] });
  assert.match(textOf(r3), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const pmax = fakeClient({ rows: { campaign: [campaignRow("111", "PERFORMANCE_MAX")] } });
  const r4 = await call(pmax.client, "set_content_exclusions", { level: "CAMPAIGN", campaignId: "111", labels: ["JUVENILE"] });
  assert.equal(r4.isError, true);
  assert.equal(pmax.calls.writes.length, 0);

  const bad = fakeClient();
  const r5 = await call(bad.client, "set_content_exclusions", { level: "ACCOUNT", labels: ["GAMBLING"] });
  assert.equal(r5.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("set_video_inventory_type: antes/depois, confirm, no-op e googleAds:mutate com customerOperation", async () => {
  const rows = { customer: [{ customer: { id: CID, descriptiveName: "Loja", videoBrandSafetySuitability: "EXPANDED_INVENTORY" } }] };
  const gated = fakeClient({ rows });
  const r1 = await call(gated.client, "set_video_inventory_type", { suitability: "LIMITED" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /EXPANDED_INVENTORY para LIMITED_INVENTORY/);
  assert.equal(gated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const r2 = await call(client, "set_video_inventory_type", { suitability: "LIMITED", confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.deepEqual(calls.writes[0].operations, [{
    customerOperation: {
      update: { resourceName: `customers/${CID}`, videoBrandSafetySuitability: "LIMITED_INVENTORY" },
      updateMask: "video_brand_safety_suitability",
    },
  }]);
  assertUpdateMaskLeaves("video_brand_safety_suitability");

  const same = fakeClient({ rows });
  const r3 = await call(same.client, "set_video_inventory_type", { suitability: "EXPANDED_INVENTORY", confirm: true });
  assert.match(textOf(r3), /já é EXPANDED_INVENTORY/);
  assert.equal(same.calls.writes.length, 0);

  const dry = fakeClient({ rows });
  const r4 = await call(dry.client, "set_video_inventory_type", { suitability: "STANDARD", validateOnly: true });
  assert.equal(dry.calls.writes[0].dryRun, true, "validateOnly dispensa confirm e não grava");
  assert.match(textOf(r4), /DRY-RUN/);
});

test("add_ip_exclusions: campanha de Pesquisa, curinga vira CIDR, existente é pulado", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [campaignRow("111", "SEARCH")],
      campaign_criterion: [{ campaignCriterion: { ipBlock: { ipAddress: "203.0.113.7" } } }],
    },
  });
  const result = await call(client, "add_ip_exclusions", { level: "CAMPAIGN", campaignId: "111", ips: ["203.0.113.7", "198.51.100.*", "2001:db8::1"] });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(calls.writes[0].operations.map((op) => op.create), [
    { campaign: `customers/${CID}/campaigns/111`, negative: true, ipBlock: { ipAddress: "198.51.100.0/24" } },
    { campaign: `customers/${CID}/campaigns/111`, negative: true, ipBlock: { ipAddress: "2001:db8::1" } },
  ]);
  assert.equal((payloadOf(result).already_excluded as Row[]).length, 1);
});

test("add_ip_exclusions: Vídeo/PMax na campanha, IP inválido e limite de 500 são recusados; conta usa customerNegativeCriteria", async () => {
  for (const channel of ["VIDEO", "PERFORMANCE_MAX"]) {
    const { client, calls } = fakeClient({ rows: { campaign: [campaignRow("111", channel)] } });
    const result = await call(client, "add_ip_exclusions", { level: "CAMPAIGN", campaignId: "111", ips: ["203.0.113.7"] });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /level ACCOUNT/);
    assert.equal(calls.writes.length, 0);
  }
  const smart = fakeClient({ rows: { campaign: [campaignRow("111", "DISPLAY", { advertisingChannelSubType: "DISPLAY_SMART_CAMPAIGN" })] } });
  assert.equal((await call(smart.client, "add_ip_exclusions", { level: "CAMPAIGN", campaignId: "111", ips: ["203.0.113.7"] })).isError, true);

  const invalid = fakeClient();
  const r1 = await call(invalid.client, "add_ip_exclusions", { level: "ACCOUNT", ips: ["203.0.113.7", "1.2.3.4/40"] });
  assert.equal(r1.isError, true);
  assert.equal(invalid.calls.queries.length, 0);

  const existing = Array.from({ length: 499 }, (_v, i) => ({ customerNegativeCriterion: { ipBlock: { ipAddress: `10.0.${Math.floor(i / 250)}.${i % 250}` } } }));
  const full = fakeClient({ rows: { customer_negative_criterion: existing } });
  const r2 = await call(full.client, "add_ip_exclusions", { level: "ACCOUNT", ips: ["203.0.113.7", "203.0.113.8"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /limite de 500/);
  assert.equal(full.calls.writes.length, 0);

  const account = fakeClient();
  await call(account.client, "add_ip_exclusions", { level: "ACCOUNT", ips: ["203.0.113.7"] });
  assert.equal(account.calls.writes[0].resource, "customerNegativeCriteria");
  assert.deepEqual(account.calls.writes[0].operations, [{ create: { ipBlock: { ipAddress: "203.0.113.7" } } }]);
});

// ── Exclusões da conta: listar e remover ─────────────────────────────

test("list_account_exclusions: agrupa por tipo, mostra inventário de vídeo e nomeia listas", async () => {
  const { client, calls } = fakeClient({
    rows: {
      customer_negative_criterion: [
        { customerNegativeCriterion: { id: "1", type: "PLACEMENT", resourceName: `customers/${CID}/customerNegativeCriteria/1`, placement: { url: "lixo.com" } } },
        { customerNegativeCriterion: { id: "2", type: "IP_BLOCK", ipBlock: { ipAddress: "203.0.113.7" } } },
        { customerNegativeCriterion: { id: "3", type: "PLACEMENT_LIST", placementList: { sharedSet: `customers/${CID}/sharedSets/77` } } },
        { customerNegativeCriterion: { id: "4", type: "PLACEMENT_LIST", placementList: { sharedSet: `customers/${MCC}/sharedSets/3` } } },
      ],
      customer: [{ customer: { videoBrandSafetySuitability: "STANDARD_INVENTORY" } }],
      shared_set: [{ sharedSet: { resourceName: `customers/${CID}/sharedSets/77`, name: "Lista", memberCount: "12" } }],
    },
  });
  const result = await call(client, "list_account_exclusions", {});
  const payload = payloadOf(result);
  assert.equal(payload.video_brand_safety_suitability, "STANDARD_INVENTORY");
  assert.deepEqual(payload.counts, { PLACEMENT: 1, IP_BLOCK: 1, PLACEMENT_LIST: 2 });
  const lists = (payload.by_type as Record<string, Row[]>).PLACEMENT_LIST;
  assert.equal(lists[0].name, "Lista (12 itens)");
  assert.equal(lists[1].name, `lista da MCC ${MCC}`);

  await call(client, "list_account_exclusions", { type: "IP_BLOCK", format: "table" });
  assert.ok(calls.queries.some((q) => /customer_negative_criterion\.type = 'IP_BLOCK'/.test(q.query)));
});

test("remove_account_exclusions: confirm, resource name de outra conta e remoção com partialFailure", async () => {
  const rows = { customer_negative_criterion: [{ customerNegativeCriterion: { id: "7", type: "PLACEMENT", resourceName: `customers/${CID}/customerNegativeCriteria/7`, placement: { url: "a.com" } } }] };
  const foreign = fakeClient({ rows });
  const r1 = await call(foreign.client, "remove_account_exclusions", { resourceNames: ["customers/5555555555/customerNegativeCriteria/7"], confirm: true });
  assert.equal(r1.isError, true);
  assert.equal(foreign.calls.queries.length, 0);

  const gated = fakeClient({ rows });
  const r2 = await call(gated.client, "remove_account_exclusions", { criterionIds: ["7", "8"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /confirm: true/);
  assert.equal(gated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const r3 = await call(client, "remove_account_exclusions", { criterionIds: ["7", "8"], confirm: true });
  assert.notEqual(r3.isError, true, textOf(r3));
  assert.deepEqual(calls.writes[0].operations, [{ remove: `customers/${CID}/customerNegativeCriteria/7` }]);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.deepEqual(payloadOf(r3).not_found, ["8"]);
});

// ── Visão da segmentação e desfazer ──────────────────────────────────

test("get_targeting_overview: configurações, critérios agrupados, ajustes de lance, listas e grupos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: {
        id: "111", name: "Display", advertisingChannelType: "DISPLAY",
        geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" },
        targetingSetting: { targetRestrictions: [{ targetingDimension: "AUDIENCE", bidOnly: true }] },
        networkSettings: { targetContentNetwork: true },
      } }],
      campaign_criterion: [
        { campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/111~2076`, criterionId: "2076", type: "LOCATION", negative: false, displayName: "Brazil", location: { geoTargetConstant: "geoTargetConstants/2076" } } },
        { campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/111~30001`, criterionId: "30001", type: "DEVICE", bidModifier: 0.5, displayName: "Mobile" } },
      ],
      campaign_shared_set: [{ sharedSet: { id: "77", name: "Lista", type: "NEGATIVE_PLACEMENTS", memberCount: "3" } }],
      customer_negative_criterion: [{ customerNegativeCriterion: { type: "PLACEMENT" } }],
      ad_group: [{ adGroup: { id: "555", name: "G", optimizedTargetingEnabled: true } }],
      ad_group_criterion: [{ adGroup: { id: "555" }, adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/555~9`, type: "TOPIC", displayName: "/Autos" } }],
    },
  });
  const result = await call(client, "get_targeting_overview", { campaignId: "111" });
  const payload = payloadOf(result);
  const criteria = payload.campaign_criteria as Record<string, Row[]>;
  assert.equal(criteria.LOCATION[0].display_name, "Brazil");
  assert.equal(criteria.LOCATION[0].resource_name, `customers/${CID}/campaignCriteria/111~2076`);
  assert.deepEqual(payload.bid_modifiers, [{ type: "DEVICE", display_name: "Mobile", bid_modifier: 0.5, resource_name: `customers/${CID}/campaignCriteria/111~30001` }]);
  assert.deepEqual((payload.settings as Row).geo_target_type, { positiveGeoTargetType: "PRESENCE" });
  assert.deepEqual(payload.account_level_exclusions, { PLACEMENT: 1 });
  const [group] = payload.ad_groups as Row[];
  assert.equal(group.optimized_targeting_enabled, true);
  assert.equal(((group.criteria as Record<string, Row[]>).TOPIC)[0].display_name, "/Autos");
  assert.ok(calls.queries.some((q) => /campaign_criterion\.type != 'KEYWORD'/.test(q.query)));

  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_targeting_overview", { campaignId: "x" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("remove_targeting_criteria: valida conta, tipo e existência; confirma; avisa quando some o último local; remove atômico", async () => {
  const rows = {
    campaign_criterion: (query: string) => /resource_name IN/.test(query)
      ? [{ campaign: { id: "111" }, campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/111~2076`, type: "LOCATION", negative: false, status: "ENABLED", displayName: "Brazil" } }]
      : [{ campaign: { id: "111" }, campaignCriterion: { resourceName: `customers/${CID}/campaignCriteria/111~2076`, type: "LOCATION" } }],
    ad_group_criterion: [{ adGroup: { id: "555" }, campaign: { id: "111" }, adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/555~9`, type: "TOPIC", negative: false, status: "ENABLED" } }],
  };
  for (const names of [
    ["customers/5555555555/campaignCriteria/1~2"],
    [`customers/${CID}/customerNegativeCriteria/4`],
    ["qualquer coisa"],
  ]) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "remove_targeting_criteria", { resourceNames: names, confirm: true });
    assert.equal(result.isError, true, names[0]);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
  const keyword = fakeClient({ rows: { ad_group_criterion: [{ adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/555~1`, type: "KEYWORD", status: "ENABLED" } }] } });
  const r1 = await call(keyword.client, "remove_targeting_criteria", { resourceNames: [`customers/${CID}/adGroupCriteria/555~1`], confirm: true });
  assert.match(textOf(r1), /remove_keyword/);
  assert.equal(keyword.calls.writes.length, 0);

  const names = [`customers/${CID}/campaignCriteria/111~2076`, `customers/${CID}/adGroupCriteria/555~9`];
  const gated = fakeClient({ rows });
  const r2 = await call(gated.client, "remove_targeting_criteria", { resourceNames: names });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /TODOS os países/);
  assert.equal(gated.calls.writes.length, 0);

  const { client, calls } = fakeClient({ rows });
  const r3 = await call(client, "remove_targeting_criteria", { resourceNames: names, confirm: true });
  assert.equal(r3.isError, undefined, textOf(r3));
  assert.equal(calls.writes[0].method, "batchMutate");
  assert.deepEqual(calls.writes[0].operations, [
    { campaignCriterionOperation: { remove: names[0] } },
    { adGroupCriterionOperation: { remove: names[1] } },
  ]);
});

// ── Display: tópicos, categorias e segmentação otimizada ─────────────

test("list_topics e list_mobile_app_categories: filtro sem caixa/acento e por pai", async () => {
  const { client } = fakeClient({
    rows: {
      topic_constant: [
        { topicConstant: { id: "13", path: ["Autos & Vehicles"] } },
        { topicConstant: { id: "47", path: ["Autos & Vehicles", "Motor Vehicles"], topicConstantParent: "topicConstants/13" } },
        { topicConstant: { id: "66", path: ["Pets & Animals"] } },
      ],
      mobile_app_category_constant: [
        { mobileAppCategoryConstant: { id: 60008, name: "Games" } },
        { mobileAppCategoryConstant: { id: 60009, name: "Kids" } },
      ],
    },
  });
  const topics = payloadOf(await call(client, "list_topics", { query: "AUTOS" })) as unknown as Row[];
  assert.deepEqual(topics.map((t) => t.topic_id), ["13", "47"]);
  const children = payloadOf(await call(client, "list_topics", { parentId: "13" })) as unknown as Row[];
  assert.deepEqual(children.map((t) => t.topic_id), ["47"]);
  const categories = payloadOf(await call(client, "list_mobile_app_categories", { query: "kid" })) as unknown as Row[];
  assert.deepEqual(categories, [{ category_id: "60009", name: "Kids" }]);
});

test("set_topic_targeting: valida tópicos, pula repetido, recusa oposto e cria topicConstant com a polaridade pedida", async () => {
  const rows = {
    ad_group: [adGroupRow("555", "111", "DISPLAY")],
    topic_constant: [{ topicConstant: { id: "13", path: ["Autos & Vehicles"] } }, { topicConstant: { id: "66", path: ["Pets & Animals"] } }, { topicConstant: { id: "70", path: ["News"] } }],
    ad_group_criterion: [
      { adGroupCriterion: { negative: true, topic: { topicConstant: "topicConstants/66" } } },
      { adGroupCriterion: { negative: false, topic: { topicConstant: "topicConstants/70" } } },
    ],
  };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_topic_targeting", { level: "AD_GROUP", adGroupId: "555", topicIds: ["13", "66", "70"], negative: true });
  assert.notEqual(result.isError, true, textOf(result));
  assert.deepEqual(calls.writes[0].operations, [{
    create: { adGroup: `customers/${CID}/adGroups/555`, negative: true, topic: { topicConstant: "topicConstants/13" } },
  }]);
  const payload = payloadOf(result);
  assert.equal((payload.already_present as Row[]).length, 1);
  assert.equal((payload.conflicts as Row[]).length, 1);

  const unknown = fakeClient({ rows: { ...rows, topic_constant: [] } });
  const r2 = await call(unknown.client, "set_topic_targeting", { level: "AD_GROUP", adGroupId: "555", topicIds: ["13"] });
  assert.match(textOf(r2), /inexistente/);
  assert.equal(unknown.calls.writes.length, 0);

  const bad = fakeClient();
  const r3 = await call(bad.client, "set_topic_targeting", { level: "CAMPAIGN", campaignId: "111", topicIds: ["x"], negative: true });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /topicIds devem ser numéricos/);
  assert.equal(bad.calls.queries.length, 0);
});

test("set_topic_targeting: tópico POSITIVO na campanha é recusado antes de qualquer chamada; exclusão na campanha grava negative", async () => {
  // TopicInfo: "Only negative criteria are supported at the campaign level."
  const rows = {
    campaign: [campaignRow("111", "DISPLAY")],
    topic_constant: [{ topicConstant: { id: "66", path: ["Pets & Animals"] } }],
  };
  for (const extra of [{}, { negative: false }]) {
    const { client, calls } = fakeClient({ rows });
    const result = await call(client, "set_topic_targeting", { level: "CAMPAIGN", campaignId: "111", topicIds: ["66"], ...extra });
    assert.equal(result.isError, true, JSON.stringify(extra));
    assert.match(textOf(result), /tópico só pode ser EXCLUSÃO/);
    assert.match(textOf(result), /level AD_GROUP com adGroupId/);
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(extra));
  }

  const { client, calls } = fakeClient({ rows });
  const ok = await call(client, "set_topic_targeting", { level: "CAMPAIGN", campaignId: "111", topicIds: ["66"], negative: true });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal(calls.writes[0].resource, "campaignCriteria");
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });
  assert.deepEqual(calls.writes[0].operations, [{
    create: { campaign: `customers/${CID}/campaigns/111`, negative: true, topic: { topicConstant: "topicConstants/66" } },
  }]);
});

test("set_optimized_targeting: updateMask só com folhas que mudam, no-op e canal errado", async () => {
  const rows = { ad_group: [adGroupRow("555", "111", "DISPLAY", { optimizedTargetingEnabled: true, excludeDemographicExpansion: false })] };
  const { client, calls } = fakeClient({ rows });
  const result = await call(client, "set_optimized_targeting", { adGroupId: "555", enabled: false, excludeDemographicExpansion: false });
  assert.equal(result.isError, undefined, textOf(result));
  const [write] = calls.writes;
  assert.equal(write.method, "mutateAdGroups");
  assert.deepEqual(write.operations, [{ update: { resourceName: `customers/${CID}/adGroups/555`, optimizedTargetingEnabled: false }, updateMask: "optimized_targeting_enabled" }]);
  assertUpdateMaskLeaves(String(write.operations[0].updateMask));

  const same = fakeClient({ rows });
  const r2 = await call(same.client, "set_optimized_targeting", { adGroupId: "555", enabled: true });
  assert.match(textOf(r2), /nada a mudar/);
  assert.equal(same.calls.writes.length, 0);

  const search = fakeClient({ rows: { ad_group: [adGroupRow("555", "111", "SEARCH")] } });
  const r3 = await call(search.client, "set_optimized_targeting", { adGroupId: "555", enabled: true });
  assert.equal(r3.isError, true);
  assert.equal(search.calls.writes.length, 0);
});

test("set_optimized_targeting: ampliar alcance exige confirm (prévia sem gravar); desligar grava direto", async () => {
  const off = { ad_group: [adGroupRow("555", "111", "DEMAND_GEN", { optimizedTargetingEnabled: false, excludeDemographicExpansion: true })] };
  const preview = fakeClient({ rows: off });
  const r1 = await call(preview.client, "set_optimized_targeting", { adGroupId: "555", enabled: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Confirmação necessária.*fora dos públicos escolhidos/s);
  assert.equal(preview.calls.writes.length, 0);

  const confirmed = fakeClient({ rows: off });
  const r2 = await call(confirmed.client, "set_optimized_targeting", { adGroupId: "555", enabled: true, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(confirmed.calls.writes.length, 1);

  const on = { ad_group: [adGroupRow("555", "111", "DEMAND_GEN", { optimizedTargetingEnabled: true, excludeDemographicExpansion: true })] };
  const demographic = fakeClient({ rows: on });
  const r3 = await call(demographic.client, "set_optimized_targeting", { adGroupId: "555", excludeDemographicExpansion: false });
  assert.match(textOf(r3), /com expansão demográfica/);
  assert.equal(demographic.calls.writes.length, 0);

  const narrowing = fakeClient({ rows: on });
  const r4 = await call(narrowing.client, "set_optimized_targeting", { adGroupId: "555", enabled: false });
  assert.equal(r4.isError, undefined, textOf(r4));
  assert.equal(narrowing.calls.writes.length, 1, "restringir não pede confirmação");
});

test("remove_targeting_criteria: idioma em Pesquisa sai como limpeza (nota), sem aviso de 'todos os idiomas'", async () => {
  const name = `customers/${CID}/campaignCriteria/111~1014`;
  const { client } = fakeClient({
    rows: {
      campaign_criterion: [{
        campaign: { id: "111", advertisingChannelType: "SEARCH" },
        campaignCriterion: { resourceName: name, type: "LANGUAGE", negative: false, status: "ENABLED", displayName: "Portuguese" },
      }],
    },
  });
  const result = await call(client, "remove_targeting_criteria", { resourceNames: [name], confirm: true });
  const payload = payloadOf(result);
  assert.deepEqual(payload.warnings, []);
  assert.match(String((payload.notes as string[])[0]), /não é mais usado/);

  const overview = fakeClient({
    rows: {
      campaign: [campaignRow("111", "SEARCH")],
      campaign_criterion: [{ campaignCriterion: { resourceName: name, type: "LANGUAGE", displayName: "Portuguese" } }],
    },
  });
  const view = payloadOf(await call(overview.client, "get_targeting_overview", { campaignId: "111", includeAdGroups: false }));
  assert.match(String((view.notes as string[])[0]), /remove_targeting_criteria/);
  assert.equal(view.ad_groups, undefined);
});

// ── Todas as escritas do lote: validateOnly e erro da API ────────────

/** Um cenário que chegaria a gravar, por tool de escrita do lote (sem confirm). */
const WRITE_SCENARIOS: Array<{ name: string; rows: FakeOptions["rows"]; args: Row }> = [
  { name: "add_placement", rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] }, args: { adGroupId: "555", value: "a.com" } },
  { name: "exclude_placements", rows: {}, args: { level: "ACCOUNT", items: ["a.com"] } },
  { name: "create_placement_exclusion_list", rows: {}, args: { name: "L", items: ["a.com"] } },
  { name: "update_placement_exclusion_list", rows: LIST_ROWS, args: { sharedSetId: "77", removeItems: ["velho.com"] } },
  { name: "attach_mcc_exclusion_list", rows: mccRows(), args: { managerCustomerId: MCC, sharedSetId: "3", clientCustomerIds: ["1111111111"] } },
  {
    name: "remove_account_exclusions",
    rows: { customer_negative_criterion: [{ customerNegativeCriterion: { id: "7", type: "PLACEMENT", resourceName: `customers/${CID}/customerNegativeCriteria/7` } }] },
    args: { criterionIds: ["7"] },
  },
  { name: "set_content_exclusions", rows: {}, args: { level: "ACCOUNT", labels: ["JUVENILE"] } },
  { name: "set_video_inventory_type", rows: { customer: [{ customer: { videoBrandSafetySuitability: "EXPANDED_INVENTORY" } }] }, args: { suitability: "LIMITED" } },
  { name: "add_ip_exclusions", rows: {}, args: { level: "ACCOUNT", ips: ["203.0.113.7"] } },
  {
    name: "remove_targeting_criteria",
    rows: { ad_group_criterion: [{ adGroup: { id: "555" }, campaign: { id: "111" }, adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/555~9`, type: "TOPIC", status: "ENABLED" } }] },
    args: { resourceNames: [`customers/${CID}/adGroupCriteria/555~9`] },
  },
  {
    name: "set_topic_targeting",
    rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")], topic_constant: [{ topicConstant: { id: "13", path: ["Autos & Vehicles"] } }] },
    args: { level: "AD_GROUP", adGroupId: "555", topicIds: ["13"] },
  },
  { name: "set_optimized_targeting", rows: { ad_group: [adGroupRow("555", "111", "DISPLAY")] }, args: { adGroupId: "555", enabled: true } },
];

test("validateOnly em todas as escritas do lote: grava só no client em dry-run, dispensa confirm e avisa no topo", async () => {
  const { MODULE_CHAINED_WRITE_TOOLS } = await import("../src/tools/catalogs.js");
  for (const scenario of WRITE_SCENARIOS) {
    assert.ok(!MODULE_CHAINED_WRITE_TOOLS.includes(scenario.name), `${scenario.name} não pode ser encadeada`);
    const { client, calls } = fakeClient({ rows: scenario.rows });
    const result = await call(client, scenario.name, { ...scenario.args, validateOnly: true });
    assert.notEqual(result.isError, true, `${scenario.name}: ${textOf(result)}`);
    assert.ok(calls.writes.length > 0, `${scenario.name} não validou nada`);
    assert.ok(calls.writes.every((write) => write.dryRun), `${scenario.name} gravou fora do dry-run`);
    assert.match(result.content[0].text ?? "", /^VALIDATE-ONLY/, scenario.name);
    assert.match(textOf(result), /DRY-RUN \(validateOnly\)/, scenario.name);
  }
});

test("erro da API em todas as escritas do lote: vira erro claro, nunca sucesso", async () => {
  const boom = () => { throw new Error("Google Ads API: Request contains an invalid argument. — The field is not allowed."); };
  for (const scenario of WRITE_SCENARIOS) {
    const { client, calls } = fakeClient({ rows: scenario.rows, mutate: boom, batchMutate: boom });
    const originalAdGroups = client.mutateAdGroups as (...args: unknown[]) => Promise<Row>;
    client.mutateAdGroups = async (...args: unknown[]) => { await originalAdGroups(...args); return boom(); };
    const result = await call(client, scenario.name, { ...scenario.args, confirm: true });
    assert.equal(result.isError, true, `${scenario.name}: ${textOf(result)}`);
    assert.match(textOf(result), /invalid argument/, scenario.name);
    assert.ok(calls.writes.length > 0, scenario.name);
  }
});

// ── Catálogo, read-only e allowlist ──────────────────────────────────

test("read-only expõe as leituras do lote e esconde as escritas; leitura respeita a allowlist", async () => {
  const handlers = register(fakeClient().client, { readOnly: true });
  for (const name of ["list_account_exclusions", "list_placement_exclusion_lists", "get_targeting_overview", "list_topics", "list_mobile_app_categories"]) {
    assert.ok(handlers.has(name), name);
  }
  for (const name of ["exclude_placements", "add_placement", "remove_targeting_criteria", "set_video_inventory_type", "attach_mcc_exclusion_list"]) {
    assert.ok(!handlers.has(name), name);
  }
  const { client, calls } = fakeClient();
  const denied = await call(client, "list_account_exclusions", { customerId: "5555555555" }, { allowed: [CID], hosted: true });
  assert.equal(denied.isError, true);
  assert.equal(calls.queries.length, 0);
});

// ── GoogleAdsClient real com fetch interceptado ──────────────────────

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

test("ponta a ponta: exclude_placements na conta vai para customerNegativeCriteria:mutate com partialFailure e validateOnly", async () => {
  const net = interceptFetch((url) => (url.endsWith(":searchStream") ? [{ results: [] }] : {}));
  try {
    const client = realClient();
    const result = await register(client).get("exclude_placements")!({
      customerId: CID, level: "ACCOUNT", items: [`youtube.com/channel/${CHANNEL_ID}`], validateOnly: true,
    });
    const writes = net.sent.filter((s) => s.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/customerNegativeCriteria:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal(writes[0].body.partialFailure, true);
    assert.deepEqual(writes[0].body.operations, [{ create: { youtubeChannel: { channelId: CHANNEL_ID } } }]);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
    assert.equal(client.isDryRun, false);
  } finally {
    net.restore();
  }
});

test("ponta a ponta: lista e inventário de vídeo vão para googleAds:mutate (atômico); sem dry-run não há validateOnly", async () => {
  const net = interceptFetch((url, body) => {
    if (!url.endsWith(":searchStream")) return { mutateOperationResponses: [{ sharedSetResult: { resourceName: `customers/${CID}/sharedSets/5` } }] };
    const query = String(body.query);
    if (/FROM customer\b/.test(query)) return [{ results: [{ customer: { manager: false, videoBrandSafetySuitability: "EXPANDED_INVENTORY" } }] }];
    return [{ results: [] }];
  });
  try {
    const handlers = register(realClient());
    await handlers.get("create_placement_exclusion_list")!({ customerId: CID, name: "L", items: ["a.com"], validateOnly: true });
    await handlers.get("create_placement_exclusion_list")!({ customerId: CID, name: "L2", items: ["a.com"] });
    await handlers.get("set_video_inventory_type")!({ customerId: CID, suitability: "LIMITED", validateOnly: true });
    const writes = net.sent.filter((s) => s.url.endsWith("googleAds:mutate"));
    assert.equal(writes.length, 3);
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal(writes[1].body.validateOnly, undefined);
    assert.equal(((writes[0].body.mutateOperations as Row[])[0].sharedSetOperation as Row) !== undefined, true);
    assert.equal(writes[2].body.validateOnly, true);
    assert.ok((writes[2].body.mutateOperations as Row[])[0].customerOperation);
  } finally {
    net.restore();
  }
});
