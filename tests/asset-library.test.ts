/**
 * Lote asset-library: biblioteca de assets (imagens/vídeos com dimensões, proporção,
 * orientação, política e declaração de IA; uso por asset; upload com aiGenerated;
 * update_asset_synthetic_attestation) e locais do Perfil da Empresa (LOCATION_SYNC,
 * grupos de locais, vínculos e remoção).
 *
 * Duas camadas: handlers com um client falso que valida TODA query GAQL contra os
 * metadados reais da v25 (assertGaqlRules) e registra as escritas; e o GoogleAdsClient
 * real com fetch interceptado, para provar a rota REST e o corpo enviado.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { CHAINED_WRITE_TOOLS } from "../src/tool-kit.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import {
  classifyAspect,
  classifyUsageLink,
  containsRegex,
  normalizeImageBase64,
  parseYoutubeVideoId,
  sniffImage,
  toSignedInt64,
} from "../src/tools/asset-library.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const TOKEN = "ya29.segredo-do-perfil-da-empresa-123";

// ── Client falso ──────────────────────────────────────────────────────

type Route = Row[] | ((query: string) => Row[]);

interface FakeOptions {
  routes?: Record<string, Route>;
  dryRun?: boolean;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row | Promise<Row>;
  batchMutate?: (operations: Row[]) => Row | Promise<Row>;
  failFrom?: string;
}

interface Write {
  method: string;
  resource?: string;
  operations: Row[];
  options?: Row;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[] };
  const defaultResults = (resource: string, operations: Row[]) => ({
    results: operations.map((op, i) => ({
      resourceName: typeof op.remove === "string" ? op.remove : `customers/${CID}/${resource}/${900 + i}`,
    })),
  });
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async searchStream(_cid: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      if (opts.failFrom === from) throw new Error(`Google Ads API: falha simulada em ${from}`);
      const route = opts.routes?.[from];
      if (!route) return [];
      return typeof route === "function" ? route(query) : route;
    },
    async mutate(_cid: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options });
      if (opts.mutate) return opts.mutate(resource, operations, options);
      return dryRun ? {} : defaultResults(resource, operations);
    },
    async mutateAssets(_cid: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAssets", resource: "assets", operations });
      if (opts.mutate) return opts.mutate("assets", operations);
      return dryRun ? {} : defaultResults("assets", operations);
    },
    async batchMutate(_cid: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      return {
        mutateOperationResponses: operations.map((op, i) => {
          if (op.assetSetOperation) return { assetSetResult: { resourceName: `customers/${CID}/assetSets/777` } };
          if (op.assetSetAssetOperation) return { assetSetAssetResult: { resourceName: `customers/${CID}/assetSetAssets/777~${i}` } };
          if (op.campaignAssetSetOperation) return { campaignAssetSetResult: { resourceName: `customers/${CID}/campaignAssetSets/${i}~777` } };
          return {};
        }),
      };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, opts: { allowed?: string[]; hosted?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const fakeMcp = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, opts.allowed ?? [], opts.hosted ?? false);
  return handlers;
}

async function call(client: unknown, name: string, args: Row = {}, regOpts: { allowed?: string[]; hosted?: boolean } = {}) {
  const handler = register(client, regOpts).get(name);
  assert.ok(handler, `tool ${name} não registrada`);
  return handler({ customerId: CID, ...args });
}

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function payloadOf(result: Result): Row {
  const body = textOf(result);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(body.slice(start, end + 1)) as Row;
}

// ── Dados ─────────────────────────────────────────────────────────────

function imageRow(id: string, width: number, height: number, extra: Row = {}): Row {
  return {
    asset: {
      id,
      name: `img-${id}`,
      resourceName: `customers/${CID}/assets/${id}`,
      type: "IMAGE",
      source: "ADVERTISER",
      imageAsset: {
        fullSize: { widthPixels: String(width), heightPixels: String(height), url: `https://tpc.googlesyndication.com/simgad/${id}` },
        mimeType: "IMAGE_PNG",
        fileSize: "204800",
      },
      policySummary: { approvalStatus: "APPROVED", reviewStatus: "REVIEWED" },
      ...extra,
    },
  };
}

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const SYNC_BP: Row = {
  id: "500",
  name: "Sync Perfil",
  type: "LOCATION_SYNC",
  status: "ENABLED",
  resourceName: `customers/${CID}/assetSets/500`,
  locationSet: { locationOwnershipType: "BUSINESS_OWNER", businessProfileLocationSet: { labelFilters: ["sp"] } },
};
const SYNC_CHAIN: Row = {
  ...SYNC_BP,
  name: "Sync Redes",
  locationSet: { locationOwnershipType: "AFFILIATE", chainLocationSet: { relationshipType: "GENERAL_RETAILERS" } },
};
const GROUP: Row = {
  id: "600",
  name: "Grupo SP",
  type: "STATIC_LOCATION_GROUP",
  status: "ENABLED",
  resourceName: `customers/${CID}/assetSets/600`,
  locationGroupParentAssetSetId: "500",
};

/** Rota de asset_set: por id, LOCATION_SYNC ativo, nome duplicado, filhos e listagem. */
function assetSetRoute(sets: Row[], extra: { sameName?: Row[]; children?: Row[] } = {}): Route {
  return (query: string) => {
    if (query.includes("location_group_parent_asset_set_id =")) return (extra.children ?? []).map((assetSet) => ({ assetSet }));
    const byId = /asset_set\.id = (\d+)/.exec(query);
    if (byId) return sets.filter((s) => s.id === byId[1]).map((assetSet) => ({ assetSet }));
    if (query.includes("asset_set.name =")) return (extra.sameName ?? []).map((assetSet) => ({ assetSet }));
    if (query.includes("asset_set.type = 'LOCATION_SYNC'")) {
      return sets.filter((s) => s.type === "LOCATION_SYNC" && s.status === "ENABLED").map((assetSet) => ({ assetSet }));
    }
    return sets.map((assetSet) => ({ assetSet }));
  };
}

// ── Catálogo ──────────────────────────────────────────────────────────

test("catálogo: tools novas classificadas; create_location_sync_asset_set é encadeada", () => {
  for (const name of ["get_asset_usage", "list_location_asset_sets", "list_location_assets", "get_image_assets", "get_video_assets"]) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), `${name} deveria ser leitura`);
  }
  for (const name of [
    "update_asset_synthetic_attestation",
    "create_location_sync_asset_set",
    "link_location_asset_set",
    "create_location_group_asset_set",
    "unlink_location_asset_set",
    "remove_location_asset_set",
    "upload_image_asset",
    "upload_video_asset",
  ]) {
    assert.ok(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name as never), `${name} deveria ser escrita`);
  }
  assert.ok(CHAINED_WRITE_TOOLS.has("create_location_sync_asset_set"));
  assert.ok(!CHAINED_WRITE_TOOLS.has("create_location_group_asset_set"), "o grupo é atômico: validateOnly tem que funcionar");
});

// ── Helpers puros ─────────────────────────────────────────────────────

test("helpers: proporção ±1%, cabeçalho de imagem, base64, YouTube e int64 do Perfil da Empresa", () => {
  assert.equal(classifyAspect(1200, 628).key, "1.91:1");
  assert.equal(classifyAspect(960, 1200).key, "4:5");
  assert.equal(classifyAspect(1080, 1920).key, "9:16");
  assert.equal(classifyAspect(1200, 300).key, "4:1");
  assert.equal(classifyAspect(1200, 1200).key, "1:1");
  assert.equal(classifyAspect(1000, 700).key, null);
  assert.equal(classifyAspect(0, 0).label, "desconhecida");

  assert.deepEqual(sniffImage(Buffer.from(pngBase64(960, 1200), "base64")), { format: "PNG", width: 960, height: 1200 });
  assert.deepEqual(sniffImage(jpegBytes(1200, 628)), { format: "JPEG", width: 1200, height: 628 });
  const gif = Buffer.alloc(13);
  gif.write("GIF89a", 0, "latin1");
  gif.writeUInt16LE(300, 6);
  gif.writeUInt16LE(300, 8);
  assert.deepEqual(sniffImage(gif), { format: "GIF", width: 300, height: 300 });
  assert.equal(sniffImage(Buffer.from("%PDF-1.4 qualquer")).format, null);

  const withPrefix = normalizeImageBase64(`data:image/png;base64,${pngBase64(10, 10)}\n`);
  assert.ok(!("error" in withPrefix) && withPrefix.base64 === pngBase64(10, 10));
  assert.ok("error" in normalizeImageBase64("não é base64!"));
  assert.ok("error" in normalizeImageBase64("data:image/png,cru"));

  assert.equal(parseYoutubeVideoId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ");
  assert.equal(parseYoutubeVideoId("youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYoutubeVideoId("https://youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(parseYoutubeVideoId("https://vimeo.com/123"), null);
  assert.equal(parseYoutubeVideoId("111"), null);

  // Doc do Google: listing ID acima de 2^63-1 vira o complemento de dois
  assert.equal(toSignedInt64("18446744073709551615"), "-1");
  assert.equal(toSignedInt64("9223372036854775808"), "-9223372036854775808");
  assert.equal(toSignedInt64("12345"), "12345");
  assert.equal(toSignedInt64("18446744073709551616"), null);
  assert.equal(toSignedInt64("abc"), null);

  // REGEXP_MATCH: metacaracteres escapados e apóstrofo preservado no literal GAQL
  assert.equal(containsRegex("Sant'Ana (v2).png"), "(?i).*Sant\\'Ana \\\\(v2\\\\)\\\\.png.*");
});

// ── get_image_assets ─────────────────────────────────────────────────

test("get_image_assets: traz dimensões, proporção, orientação, política, origem e declaração de IA", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset: [
        imageRow("11", 1200, 628, { orientation: "LANDSCAPE" }),
        imageRow("12", 960, 1200, {
          orientation: "PORTRAIT",
          policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED", policyTopicEntries: [{ topic: "TRADEMARKS_IN_AD_TEXT", type: "PROHIBITED" }] },
          fieldTypePolicySummaries: [{ assetFieldType: "MARKETING_IMAGE", assetSource: "ADVERTISER", policySummaryInfo: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED" } }],
          syntheticContentInfo: { advertiserAttestation: { status: "IS_SYNTHETIC", source: "ADVERTISER_ATTESTED" }, systemAttestation: { status: "IS_SYNTHETIC", source: "GOOGLE_GENERATED_FULLY_AUTOMATED" } },
        }),
      ],
    },
  });
  const result = await call(client, "get_image_assets");
  assert.equal(result.isError, undefined);
  const query = calls.queries[0];
  for (const field of ["asset.orientation", "asset.image_asset.full_size.width_pixels", "asset.image_asset.mime_type", "asset.policy_summary.approval_status", "asset.field_type_policy_summaries", "asset.source", "asset.synthetic_content_info.advertiser_attestation.status"]) {
    assert.match(query, new RegExp(field.replace(/\./g, "\\.")), `SELECT sem ${field}`);
  }
  assert.match(query, /WHERE asset\.type = 'IMAGE'/);
  assert.match(query, /ORDER BY asset\.id\s+LIMIT 51/, "página de 50 + 1 para saber se há mais");

  const images = payloadOf(result).images as Row[];
  assert.equal(images[0].dimensions, "1200x628");
  assert.equal(images[0].aspect_ratio, "1.91:1");
  assert.equal(images[0].ai_generated, "NAO_DECLARADO");
  assert.equal(images[0].file_size_kb, 200);
  assert.equal(images[1].aspect_ratio, "4:5");
  assert.equal(images[1].orientation, "PORTRAIT");
  assert.equal(images[1].approval_status, "DISAPPROVED");
  assert.deepEqual(images[1].policy_topics, ["TRADEMARKS_IN_AD_TEXT (PROHIBITED)"]);
  assert.equal((images[1].policy_by_field_type as Row[])[0].field_type, "MARKETING_IMAGE");
  assert.equal(images[1].ai_generated, "IS_SYNTHETIC");
  assert.equal(images[1].google_ai_detection, "IS_SYNTHETIC (GOOGLE_GENERATED_FULLY_AUTOMATED)");
  assert.equal((payloadOf(result) as Row).next_cursor, null);
});

test("get_image_assets: filtros viram WHERE; aspectRatio filtra depois, com varredura limitada", async () => {
  const { client, calls } = fakeClient({
    routes: { asset: [imageRow("11", 1200, 1200), imageRow("12", 1200, 628), imageRow("13", 960, 1200), imageRow("14", 1080, 1350)] },
  });
  const result = await call(client, "get_image_assets", {
    nameContains: "Sant'Ana (v2)",
    orientation: "PORTRAIT",
    minWidth: 600,
    mimeType: "IMAGE_PNG",
    approvalStatus: "APPROVED",
    source: "ADVERTISER",
    aiGenerated: "IS_SYNTHETIC",
    aspectRatio: "4:5",
    afterAssetId: "10",
    limit: 1,
  });
  const query = calls.queries[0];
  assert.match(query, /asset\.name REGEXP_MATCH '\(\?i\)\.\*Sant\\'Ana \\\\\(v2\\\\\)\.\*'/);
  assert.match(query, /asset\.orientation = 'PORTRAIT'/);
  assert.match(query, /asset\.image_asset\.full_size\.width_pixels >= 600/);
  assert.match(query, /asset\.image_asset\.mime_type = 'IMAGE_PNG'/);
  assert.match(query, /asset\.policy_summary\.approval_status = 'APPROVED'/);
  assert.match(query, /asset\.source = 'ADVERTISER'/);
  assert.match(query, /advertiser_attestation\.status = 'IS_SYNTHETIC'/);
  assert.match(query, /asset\.id > 10/);
  assert.match(query, /LIMIT 5000/, "com filtro local a consulta varre até o teto");
  assert.doesNotMatch(query, /4:5/, "a proporção não vai para o GAQL");

  const payload = payloadOf(result);
  assert.deepEqual((payload.images as Row[]).map((i) => i.asset_id), ["13"]);
  assert.equal(payload.next_cursor, "13", "havia outra 4:5 (14) depois da página");
});

test("get_image_assets: paginação por cursor e NAO_DECLARADO filtrado localmente", async () => {
  const rows = [imageRow("21", 100, 100), imageRow("22", 100, 100), imageRow("23", 100, 100)];
  const { client } = fakeClient({ routes: { asset: rows } });
  const page = payloadOf(await call(client, "get_image_assets", { limit: 2 }));
  assert.deepEqual((page.images as Row[]).map((i) => i.asset_id), ["21", "22"]);
  assert.equal(page.next_cursor, "22");

  const declared = [imageRow("31", 100, 100, { syntheticContentInfo: { advertiserAttestation: { status: "NOT_SYNTHETIC" } } }), imageRow("32", 100, 100)];
  const { client: c2, calls } = fakeClient({ routes: { asset: declared } });
  const onlyUndeclared = payloadOf(await call(c2, "get_image_assets", { aiGenerated: "NAO_DECLARADO" }));
  assert.deepEqual((onlyUndeclared.images as Row[]).map((i) => i.asset_id), ["32"]);
  assert.doesNotMatch(calls.queries[0], /advertiser_attestation\.status =/);
});

test("get_image_assets: includeUsage soma os vínculos por canal (visão agregada)", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset: [imageRow("41", 1200, 1200), imageRow("42", 1200, 1200)],
      channel_aggregate_asset_view: [
        { asset: { id: "41" }, channelAggregateAssetView: { advertisingChannelType: "SEARCH", fieldType: "AD_IMAGE" }, metrics: { linkedEntitiesCount: "2" } },
        { asset: { id: "41" }, channelAggregateAssetView: { advertisingChannelType: "PERFORMANCE_MAX", fieldType: "SQUARE_MARKETING_IMAGE" }, metrics: { linkedEntitiesCount: "1" } },
      ],
    },
  });
  const images = payloadOf(await call(client, "get_image_assets", { includeUsage: true })).images as Row[];
  assert.match(calls.queries[1], /FROM channel_aggregate_asset_view\s+WHERE asset\.id IN \(41, 42\)/);
  assert.equal(images[0].linked_entities, 3);
  assert.deepEqual(images[0].linked_by_channel, { SEARCH: 2, PERFORMANCE_MAX: 1 });
  assert.equal(images[0].in_use, true);
  assert.equal(images[1].in_use, false);
});

test("get_image_assets: table/csv, validação antes da API e guarda de conta", async () => {
  const { client } = fakeClient({ routes: { asset: [imageRow("51", 1200, 628)] } });
  const table = textOf(await call(client, "get_image_assets", { format: "table" }));
  assert.match(table, /aspect_ratio/);
  assert.match(table, /1200x628/);
  const csv = textOf(await call(client, "get_image_assets", { format: "csv" }));
  assert.match(csv.split("\n")[0], /^asset_id,name,resource_name,url,width,height/);

  for (const args of [{ afterAssetId: "abc" }, { limit: 0 }, { limit: 5000 }, { assetIds: ["12a"] }, { minWidth: -1 }]) {
    const { client: c, calls } = fakeClient();
    const result = await call(c, "get_image_assets", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0, `nenhuma consulta para ${JSON.stringify(args)}`);
  }
  const { client: c3, calls } = fakeClient();
  const denied = await call(c3, "get_image_assets", {}, { allowed: ["9999999999"], hosted: true });
  assert.match(textOf(denied), /Access denied/);
  assert.equal(calls.queries.length, 0);
});

// ── get_video_assets ─────────────────────────────────────────────────

test("get_video_assets: URL vira ID no filtro, título por regex, orientação e declaração", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset: [{ asset: { id: "61", name: "vsl", type: "YOUTUBE_VIDEO", orientation: "PORTRAIT", youtubeVideoAsset: { youtubeVideoId: "dQw4w9WgXcQ", youtubeVideoTitle: "VSL" } } }],
    },
  });
  const result = await call(client, "get_video_assets", {
    youtubeVideoIds: ["https://youtu.be/dQw4w9WgXcQ"],
    titleContains: "vsl",
    orientation: "PORTRAIT",
  });
  assert.match(calls.queries[0], /asset\.type = 'YOUTUBE_VIDEO'/);
  assert.match(calls.queries[0], /youtube_video_id IN \('dQw4w9WgXcQ'\)/);
  assert.match(calls.queries[0], /youtube_video_title REGEXP_MATCH '\(\?i\)\.\*vsl\.\*'/);
  assert.match(calls.queries[0], /LIMIT 21/);
  const video = (payloadOf(result).videos as Row[])[0];
  assert.equal(video.youtube_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(video.orientation, "PORTRAIT");
  assert.equal(video.ai_generated, "NAO_DECLARADO");

  const { client: c2, calls: calls2 } = fakeClient();
  const bad = await call(c2, "get_video_assets", { youtubeVideoIds: ["vimeo.com/1"] });
  assert.equal(bad.isError, true);
  assert.equal(calls2.queries.length, 0);
});

// ── get_asset_usage ──────────────────────────────────────────────────

function usageRoutes(): Record<string, Route> {
  return {
    asset: [{ asset: { id: "71", name: "logo", type: "IMAGE", resourceName: `customers/${CID}/assets/71`, source: "ADVERTISER", policySummary: { approvalStatus: "APPROVED" } } }],
    customer_asset: [{ customerAsset: { fieldType: "BUSINESS_LOGO", status: "ENABLED", source: "ADVERTISER", resourceName: "ca1" } }],
    campaign_asset: [
      { campaign: { id: "1", name: "Pesquisa", status: "ENABLED" }, campaignAsset: { fieldType: "AD_IMAGE", status: "ENABLED", source: "ADVERTISER", resourceName: "c1" } },
      { campaign: { id: "2", name: "Antiga", status: "PAUSED" }, campaignAsset: { fieldType: "AD_IMAGE", status: "PAUSED", source: "ADVERTISER", resourceName: "c2" } },
    ],
    asset_group_asset: [{ assetGroup: { id: "9", name: "AG" }, campaign: { id: "3", name: "PMax" }, assetGroupAsset: { fieldType: "LOGO", status: "ENABLED", primaryStatus: "ELIGIBLE", resourceName: "g1" } }],
    ad_group_ad_asset_view: [{ adGroupAdAssetView: { adGroupAd: "customers/1/adGroupAds/5~6", fieldType: "MARKETING_IMAGE", enabled: true }, adGroupAd: { status: "ENABLED" }, adGroup: { id: "5" }, campaign: { id: "4" } }],
    campaign_aggregate_asset_view: (query) =>
      query.includes("segments.date")
        ? [{ campaign: { id: "1", name: "Pesquisa" }, campaignAggregateAssetView: { fieldType: "AD_IMAGE" }, metrics: { impressions: "1000", clicks: "50", costMicros: "12345678", conversions: 2.5, conversionsValue: 300 } }]
        : [{ campaign: { id: "1", name: "Pesquisa" }, campaignAggregateAssetView: { fieldType: "AD_IMAGE", assetSource: "ADVERTISER" }, metrics: { linkedEntitiesCount: "1", linkedSampleEntities: ["customers/1/campaigns/1"] } }],
  };
}

test("get_asset_usage: vínculos por nível, ativos x pausados, visão agregada e desempenho", async () => {
  const { client, calls } = fakeClient({ routes: usageRoutes() });
  const result = await call(client, "get_asset_usage", { assetId: `customers/${CID}/assets/71`, days: 7 });
  assert.equal(result.isError, undefined);
  const rn = `customers/${CID}/assets/71`;
  const byFrom = (from: string) => calls.queries.filter((q) => new RegExp(`FROM ${from}\\b`).test(q));
  assert.match(byFrom("customer_asset")[0], new RegExp(`customer_asset\\.asset = '${rn}' AND customer_asset\\.status != 'REMOVED'`));
  assert.match(byFrom("campaign_asset")[0], /campaign_asset\.status != 'REMOVED'/);
  assert.match(byFrom("ad_group_ad_asset_view")[0], /ad_group_ad\.status != 'REMOVED'/);
  assert.match(byFrom("asset_set_asset")[0], new RegExp(`asset_set_asset\\.asset = '${rn}'`));
  const aggregate = byFrom("campaign_aggregate_asset_view");
  assert.equal(aggregate.length, 2);
  assert.ok(aggregate.some((q) => /metrics\.linked_entities_count/.test(q) && !/segments\.date/.test(q)), "vínculos sem data");
  assert.ok(aggregate.some((q) => /segments\.date DURING LAST_7_DAYS/.test(q)), "desempenho no período");

  const payload = payloadOf(result);
  const summary = payload.summary as Row;
  assert.equal(summary.in_use, true);
  assert.equal(summary.active_links, 4, "conta + 1 campanha ativa + asset group + anúncio");
  assert.equal(summary.paused_links, 1);
  assert.deepEqual(summary.active_by_level, { customer: 1, campaign: 1, ad_group: 0, asset_group: 1, ads: 1, asset_set: 0 });
  assert.deepEqual(summary.paused_by_level, { customer: 0, campaign: 1, ad_group: 0, asset_group: 0, ads: 0, asset_set: 0 });
  assert.equal(summary.failed_sections, undefined);
  assert.equal((payload.aggregate_by_campaign as Row[])[0].linked_entities, 1);
  const perf = ((payload.performance as Row).by_campaign as Row[])[0];
  assert.equal(perf.cost, 12.35);
  assert.equal(perf.impressions, 1000);
  assert.match(textOf(result), /em uso: 4 vínculo\(s\) ativo\(s\)/);
});

test("get_asset_usage: asset sem vínculo, inexistente, de outra conta, seção com erro e includeRemoved", async () => {
  const { client } = fakeClient({ routes: { asset: [{ asset: { id: "72", type: "TEXT" } }] } });
  const unused = await call(client, "get_asset_usage", { assetId: "72", includePerformance: false });
  assert.match(textOf(unused), /sem uso: nenhum vínculo ativo encontrado/);
  assert.equal(payloadOf(unused).performance, undefined);

  const { client: c2, calls: calls2 } = fakeClient();
  const missing = await call(c2, "get_asset_usage", { assetId: "73" });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /não existe na conta/);
  assert.equal(calls2.queries.length, 1, "para depois de não achar o asset");

  const { client: c3, calls: calls3 } = fakeClient();
  const foreign = await call(c3, "get_asset_usage", { assetId: "customers/9999999999/assets/1" });
  assert.equal(foreign.isError, true);
  assert.equal(calls3.queries.length, 0);

  const { client: c4 } = fakeClient({ routes: usageRoutes(), failFrom: "ad_group_ad_asset_view" });
  const partial = payloadOf(await call(c4, "get_asset_usage", { assetId: "71" }));
  assert.match(String((partial.section_errors as Row).ads), /falha simulada/);
  assert.equal((partial.summary as Row).in_use, true);

  const { client: c5, calls: calls5 } = fakeClient({ routes: usageRoutes() });
  await call(c5, "get_asset_usage", { assetId: "71", includeRemoved: true, includePerformance: false });
  assert.ok(calls5.queries.every((q) => !/!= 'REMOVED'/.test(q)));
});

const usageAsset = { asset: [{ asset: { id: "71", name: "logo", type: "IMAGE", resourceName: `customers/${CID}/assets/71` } }] };
const adLink = (adStatus: string, enabled: boolean): Row => ({
  adGroupAdAssetView: { adGroupAd: `customers/${CID}/adGroupAds/5~6`, fieldType: "MARKETING_IMAGE", enabled },
  adGroupAd: { status: adStatus },
  adGroup: { id: "5" },
  campaign: { id: "4" },
});

test("get_asset_usage: asset só em anúncio pausado conta 1 vínculo pausado e 0 ativo (disjuntos)", async () => {
  const { client } = fakeClient({ routes: { ...usageAsset, ad_group_ad_asset_view: [adLink("PAUSED", true)] } });
  const result = await call(client, "get_asset_usage", { assetId: "71", includePerformance: false });
  assert.equal(result.isError, undefined);
  const summary = payloadOf(result).summary as Row;
  assert.equal(summary.in_use, false);
  assert.equal(summary.active_links, 0);
  assert.equal(summary.paused_links, 1);
  assert.equal((summary.active_by_level as Row).ads, 0);
  assert.equal((summary.paused_by_level as Row).ads, 1);
  assert.match(String(summary.verdict), /só vínculos pausados/);
  assert.match(textOf(result).split("\n")[0], /sem vínculo ativo — só vínculos pausados/);
  assert.doesNotMatch(textOf(result), /em uso/);

  // Mistura: 1 anúncio ativo, 1 pausado, 1 vínculo que saiu da versão atual do anúncio
  // (enabled=false) e 1 anúncio removido (includeRemoved) — cada linha contada uma vez só.
  const { client: c2 } = fakeClient({
    routes: {
      ...usageAsset,
      ad_group_ad_asset_view: [adLink("ENABLED", true), adLink("PAUSED", true), adLink("ENABLED", false), adLink("REMOVED", true)],
    },
  });
  const mixed = payloadOf(await call(c2, "get_asset_usage", { assetId: "71", includePerformance: false, includeRemoved: true })).summary as Row;
  assert.equal(mixed.in_use, true);
  assert.equal(mixed.active_links, 1);
  assert.equal(mixed.paused_links, 1);
});

test("get_asset_usage: classifyUsageLink classifica cada vínculo uma única vez", () => {
  assert.equal(classifyUsageLink("ads", { enabled: true, ad_status: "ENABLED" }), "active");
  assert.equal(classifyUsageLink("ads", { enabled: true, ad_status: "PAUSED" }), "paused");
  assert.equal(classifyUsageLink("ads", { enabled: true, ad_status: "REMOVED" }), "inactive");
  assert.equal(classifyUsageLink("ads", { enabled: true, ad_status: null }), "inactive");
  assert.equal(classifyUsageLink("ads", { enabled: false, ad_status: "PAUSED" }), "inactive");
  assert.equal(classifyUsageLink("ads", { enabled: null, ad_status: "ENABLED" }), "inactive");
  assert.equal(classifyUsageLink("campaign", { status: "ENABLED" }), "active");
  assert.equal(classifyUsageLink("campaign", { status: "PAUSED" }), "paused");
  assert.equal(classifyUsageLink("asset_group", { status: "REMOVED" }), "inactive");
  // Anúncio PAUSED em outro nível não vira pausado por engano (o campo é só de ads).
  assert.equal(classifyUsageLink("customer", { status: "ENABLED", ad_status: "PAUSED" }), "active");
});

test("get_asset_usage: seção de vínculo com erro e nenhum ativo nas outras = indeterminado, nunca 'sem uso'", async () => {
  const routes = {
    ...usageAsset,
    campaign_asset: [{ campaign: { id: "1", name: "Pesquisa", status: "ENABLED" }, campaignAsset: { fieldType: "AD_IMAGE", status: "ENABLED", resourceName: "c1" } }],
  };
  const { client } = fakeClient({ routes, failFrom: "campaign_asset" });
  const result = await call(client, "get_asset_usage", { assetId: "71", includePerformance: false });
  assert.equal(result.isError, true, "uso desconhecido é sinalizado como erro");
  const headline = textOf(result).split("\n")[0];
  assert.doesNotMatch(headline, /sem uso/);
  assert.match(headline, /indeterminado: seções com erro \(campaign\)/);
  const payload = payloadOf(result);
  const summary = payload.summary as Row;
  assert.equal(summary.in_use, null);
  assert.deepEqual(summary.failed_sections, ["campaign"]);
  assert.match(String((payload.section_errors as Row).campaign), /falha simulada em campaign_asset/);
  assert.ok((payload.notes as string[]).some((n) => /indeterminado/.test(n)));

  // Só pausados nas seções que responderam + seção com erro: continua indeterminado.
  const { client: c2 } = fakeClient({ routes: { ...usageAsset, ad_group_ad_asset_view: [adLink("PAUSED", true)] }, failFrom: "asset_group_asset" });
  const pausedPartial = await call(c2, "get_asset_usage", { assetId: "71", includePerformance: false });
  assert.equal(pausedPartial.isError, true);
  assert.equal((payloadOf(pausedPartial).summary as Row).in_use, null);
  assert.match(textOf(pausedPartial).split("\n")[0], /indeterminado: seções com erro \(asset_group\).*1 pausado/);

  // A visão agregada também é seção de vínculo.
  const { client: c3 } = fakeClient({ routes: usageAsset, failFrom: "campaign_aggregate_asset_view" });
  const aggFailed = await call(c3, "get_asset_usage", { assetId: "71", includePerformance: false });
  assert.equal((payloadOf(aggFailed).summary as Row).in_use, null);
  assert.deepEqual((payloadOf(aggFailed).summary as Row).failed_sections, ["aggregate"]);

  // Falha só no desempenho não muda o veredito de uso.
  const { client: c4 } = fakeClient({
    routes: {
      ...usageAsset,
      campaign_aggregate_asset_view: (query) => {
        if (/segments\.date/.test(query)) throw new Error("Google Ads API: falha simulada no desempenho");
        return [];
      },
    },
  });
  const perfFailed = await call(c4, "get_asset_usage", { assetId: "71", days: 7 });
  assert.equal(perfFailed.isError, undefined);
  const perfPayload = payloadOf(perfFailed);
  assert.equal((perfPayload.summary as Row).in_use, false);
  assert.equal((perfPayload.summary as Row).failed_sections, undefined);
  assert.match(String((perfPayload.section_errors as Row).performance), /falha simulada no desempenho/);
  assert.match(textOf(perfFailed).split("\n")[0], /sem uso: nenhum vínculo ativo encontrado/);
});

// ── upload_image_asset ───────────────────────────────────────────────

test("upload_image_asset: base64 limpo, dimensões lidas do arquivo e sem declaração quando omitida", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_image_asset", { name: "Banner 4x5", imageBase64: `data:image/png;base64,${pngBase64(960, 1200)}` });
  assert.equal(result.isError, undefined);
  assert.equal(calls.writes.length, 1);
  const create = calls.writes[0].operations[0].create as Row;
  assert.deepEqual(create, { name: "Banner 4x5", type: "IMAGE", imageAsset: { data: pngBase64(960, 1200) } });
  const payload = payloadOf(result);
  assert.equal((payload.detected as Row).aspect_ratio, "4:5");
  assert.equal((payload.detected as Row).orientation, "PORTRAIT");
  assert.equal(payload.ai_generated, "NAO_DECLARADO");
  assert.match(textOf(result), /Resource: customers\/1234567890\/assets\/900/);
});

test("upload_image_asset: aiGenerated grava a declaração do anunciante (v25)", async () => {
  for (const [aiGenerated, status] of [[true, "IS_SYNTHETIC"], [false, "NOT_SYNTHETIC"]] as const) {
    const { client, calls } = fakeClient();
    await call(client, "upload_image_asset", { name: "IA", imageBase64: pngBase64(1200, 1200), aiGenerated });
    const create = calls.writes[0].operations[0].create as Row;
    assert.deepEqual(create.syntheticContentInfo, { advertiserAttestation: { status, source: "ADVERTISER_ATTESTED" } });
  }
});

test("upload_image_asset: entrada inválida não chama a API; dry-run e erro da API são relatados", async () => {
  for (const args of [{ name: "x", imageBase64: "@@@" }, { name: " ", imageBase64: pngBase64(1, 1) }, { name: "x", imageBase64: "" }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_image_asset", args);
    assert.equal(result.isError, true);
    assert.equal(calls.writes.length + calls.queries.length, 0);
  }

  const { client: dry } = fakeClient({ dryRun: true });
  const validated = await call(dry, "upload_image_asset", { name: "x", imageBase64: pngBase64(10, 10) });
  assert.match(textOf(validated), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.doesNotMatch(textOf(validated), /Imagem criada/);

  const { client: viaParam, calls: paramCalls } = fakeClient();
  const perCall = await call(viaParam, "upload_image_asset", { name: "x", imageBase64: pngBase64(10, 10), validateOnly: true });
  assert.match(textOf(perCall), /VALIDATE-ONLY/);
  assert.match(textOf(perCall), /nada foi gravado/);
  assert.equal(paramCalls.writes.length, 1);

  const { client: failing } = fakeClient({ mutate: () => { throw new Error("Google Ads API: The field attempted to be mutated is immutable"); } });
  const refused = await call(failing, "upload_image_asset", { name: "x", imageBase64: pngBase64(10, 10), aiGenerated: true });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /só é gravável a partir da v25/);
});

// ── upload_video_asset ───────────────────────────────────────────────

test("upload_video_asset: URL vira ID, confere se já existe e cria com nome e declaração", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_video_asset", { youtubeVideoId: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", name: "VSL", aiGenerated: false });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries[0], /youtube_video_id = 'dQw4w9WgXcQ'/);
  assert.deepEqual(calls.writes[0].operations[0].create, {
    type: "YOUTUBE_VIDEO",
    youtubeVideoAsset: { youtubeVideoId: "dQw4w9WgXcQ" },
    name: "VSL",
    syntheticContentInfo: { advertiserAttestation: { status: "NOT_SYNTHETIC", source: "ADVERTISER_ATTESTED" } },
  });
});

test("upload_video_asset: vídeo já cadastrado não é duplicado; ID inválido não chama a API", async () => {
  const { client, calls } = fakeClient({
    routes: { asset: [{ asset: { id: "81", resourceName: `customers/${CID}/assets/81`, youtubeVideoAsset: { youtubeVideoTitle: "VSL" } } }] },
  });
  const result = await call(client, "upload_video_asset", { youtubeVideoId: "dQw4w9WgXcQ", aiGenerated: true });
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(result), /já está cadastrado nesta conta — nenhuma escrita/);
  assert.match(String(payloadOf(result).note), /update_asset_synthetic_attestation/);

  const { client: c2, calls: calls2 } = fakeClient();
  const bad = await call(c2, "upload_video_asset", { youtubeVideoId: "111" });
  assert.equal(bad.isError, true);
  assert.equal(calls2.queries.length + calls2.writes.length, 0);
});

// ── update_asset_synthetic_attestation ──────────────────────────────

function attestationRoutes(): Record<string, Route> {
  return {
    asset: [
      { asset: { id: "91", name: "a", type: "IMAGE" } },
      { asset: { id: "92", name: "b", type: "YOUTUBE_VIDEO", syntheticContentInfo: { advertiserAttestation: { status: "NOT_SYNTHETIC", source: "ADVERTISER_ATTESTED" } } } },
      { asset: { id: "93", name: "c", type: "MEDIA_BUNDLE", syntheticContentInfo: { advertiserAttestation: { status: "IS_SYNTHETIC", source: "ADVERTISER_ATTESTED" } } } },
    ],
  };
}

test("update_asset_synthetic_attestation: sem confirm mostra o plano e não grava", async () => {
  const { client, calls } = fakeClient({ routes: attestationRoutes() });
  const result = await call(client, "update_asset_synthetic_attestation", { assetIds: ["91", "92", "93"], aiGenerated: true });
  assert.equal(result.isError, true);
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(result), /Plano \(nada foi gravado\)/);
  const payload = payloadOf(result);
  assert.deepEqual((payload.to_change as Row[]).map((r) => [r.asset_id, r.before, r.after]), [["91", "NAO_DECLARADO", "IS_SYNTHETIC"], ["92", "NOT_SYNTHETIC", "IS_SYNTHETIC"]]);
  assert.deepEqual((payload.unchanged as Row[]).map((r) => r.asset_id), ["93"]);
});

test("update_asset_synthetic_attestation: com confirm grava só o que muda, updateMask em folhas, partialFailure", async () => {
  const { client, calls } = fakeClient({ routes: attestationRoutes() });
  const result = await call(client, "update_asset_synthetic_attestation", { assetIds: ["91", `customers/${CID}/assets/92`, "93"], aiGenerated: true, confirm: true });
  assert.equal(result.isError, false);
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.resource, "assets");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.equal(write.operations.length, 2);
  const [first, second] = write.operations as Array<{ update: Row; updateMask: string }>;
  assert.equal(first.updateMask, "synthetic_content_info.advertiser_attestation.status,synthetic_content_info.advertiser_attestation.source");
  assert.deepEqual(first.update, { resourceName: `customers/${CID}/assets/91`, syntheticContentInfo: { advertiserAttestation: { status: "IS_SYNTHETIC", source: "ADVERTISER_ATTESTED" } } });
  assert.equal(second.updateMask, "synthetic_content_info.advertiser_attestation.status", "a origem já era ADVERTISER_ATTESTED");
  assert.deepEqual(second.update.syntheticContentInfo, { advertiserAttestation: { status: "IS_SYNTHETIC" } });
  for (const op of write.operations) assertUpdateMaskLeaves(String(op.updateMask));
  assert.equal((payloadOf(result).changed as Row[]).length, 2);
});

test("update_asset_synthetic_attestation: no-op, tipo não aceito, inexistente, erro parcial e dry-run", async () => {
  const { client, calls } = fakeClient({ routes: attestationRoutes() });
  const noop = await call(client, "update_asset_synthetic_attestation", { assetIds: ["93"], aiGenerated: true, confirm: true });
  assert.match(textOf(noop), /Nada a mudar/);
  assert.equal(calls.writes.length, 0);

  const { client: c2, calls: calls2 } = fakeClient({ routes: { asset: [{ asset: { id: "94", name: "t", type: "TEXT" } }] } });
  const text = await call(c2, "update_asset_synthetic_attestation", { assetIds: ["94", "95"], aiGenerated: false, confirm: true });
  assert.equal(text.isError, true);
  assert.match(textOf(text), /é TEXT/);
  assert.match(textOf(text), /asset 95 não existe/);
  assert.equal(calls2.writes.length, 0);

  const { client: c3 } = fakeClient({
    routes: attestationRoutes(),
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/assets/91` }, {}],
      partialFailureError: {
        message: "falhou",
        details: [{ errors: [{ message: "Field cannot be set.", errorCode: { fieldError: "IMMUTABLE_FIELD" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const partial = await call(c3, "update_asset_synthetic_attestation", { assetIds: ["91", "92"], aiGenerated: true, confirm: true });
  assert.equal(partial.isError, true);
  const payload = payloadOf(partial);
  assert.deepEqual((payload.changed as Row[]).map((r) => r.asset_id), ["91"]);
  assert.equal((payload.errors as Row[])[0].asset_id, "92");
  assert.match(String((payload.errors as Row[])[0].error), /só é gravável a partir da v25/);

  const { client: dry } = fakeClient({ routes: attestationRoutes(), dryRun: true });
  const validated = await call(dry, "update_asset_synthetic_attestation", { assetIds: ["91"], aiGenerated: true, confirm: true });
  assert.match(textOf(validated), /DRY-RUN \(validateOnly\): nada foi gravado\. Validadas: 1/);

  const { client: c4, calls: calls4 } = fakeClient();
  const foreign = await call(c4, "update_asset_synthetic_attestation", { assetIds: ["customers/9999999999/assets/1"], aiGenerated: true, confirm: true });
  assert.equal(foreign.isError, true);
  assert.equal(calls4.queries.length, 0);
});

// ── list_location_asset_sets / list_location_assets ─────────────────

test("list_location_asset_sets: filtros, locais ativos, vínculos e avisos do que falta", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset_set: assetSetRoute([SYNC_BP, GROUP]),
      customer_asset_set: [],
      campaign_asset_set: [],
      ad_group_asset_set: [],
      asset_set_asset: [{ assetSet: { id: "500" } }, { assetSet: { id: "500" } }, { assetSet: { id: "600" } }],
    },
  });
  const result = await call(client, "list_location_asset_sets");
  assert.match(calls.queries[0], /asset_set\.type IN \('LOCATION_SYNC', 'BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP', 'CHAIN_DYNAMIC_LOCATION_GROUP', 'STATIC_LOCATION_GROUP'\)/);
  assert.match(calls.queries[0], /asset_set\.status != 'REMOVED'/);
  const payload = payloadOf(result);
  const [sync, group] = payload.asset_sets as Row[];
  assert.equal(sync.sync_source, "BUSINESS_PROFILE");
  assert.equal(sync.ownership, "BUSINESS_OWNER");
  assert.deepEqual((sync.filters as Row).labels, ["sp"]);
  assert.equal(sync.enabled_locations, 2);
  assert.equal(group.parent_asset_set_id, "500");
  const warnings = (payload.warnings as string[]).join("\n");
  assert.match(warnings, /LOCATION_SYNC 500 não está vinculado à conta/);
  assert.match(warnings, /Grupo 600 .* não está vinculado/);

  const { client: empty } = fakeClient();
  assert.match(textOf(await call(empty, "list_location_asset_sets")), /Nenhum LOCATION_SYNC ativo/);
});

test("list_location_assets: por asset set, rótulo filtrado localmente e cursor", async () => {
  const location = (id: string, labels: string[]) => ({
    asset: { id, resourceName: `customers/${CID}/assets/${id}`, locationAsset: { placeId: `ChIJ${id}`, locationOwnershipType: "BUSINESS_OWNER", businessProfileLocations: [{ labels, storeCode: `loja-${id}`, listingId: `${id}0` }] } },
  });
  const { client, calls } = fakeClient({ routes: { asset_set_asset: [location("1", ["SP"]), location("2", ["RJ"]), location("3", ["sp", "centro"])] } });
  const result = await call(client, "list_location_assets", { assetSetId: "500", label: "sp", afterAssetId: "0" });
  assert.match(calls.queries[0], new RegExp(`asset_set_asset\\.asset_set = 'customers/${CID}/assetSets/500'`));
  assert.match(calls.queries[0], /asset\.type = 'LOCATION' AND asset\.id > 0/);
  const locations = payloadOf(result).locations as Row[];
  assert.deepEqual(locations.map((l) => l.asset_id), ["1", "3"]);
  assert.deepEqual(locations[0].store_codes, ["loja-1"]);

  const { client: c2, calls: calls2 } = fakeClient();
  assert.equal((await call(c2, "list_location_assets", { assetSetId: "x" })).isError, true);
  assert.equal(calls2.queries.length, 0);
});

// ── create_location_sync_asset_set ───────────────────────────────────

test("create_location_sync_asset_set (Perfil da Empresa): cria o LOCATION_SYNC e vincula à conta; token nunca volta", async () => {
  const { client, calls } = fakeClient({ routes: { asset_set: assetSetRoute([]) } });
  const result = await call(client, "create_location_sync_asset_set", {
    name: "Locais Perfil",
    source: "BUSINESS_PROFILE",
    ownershipType: "BUSINESS_OWNER",
    businessProfileEmail: "dono@empresa.com.br",
    businessProfileAccessToken: TOKEN,
    labelFilters: ["sp"],
    listingIds: ["18446744073709551615", "123"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes.map((w) => w.resource), ["assetSets", "customerAssetSets"]);
  assert.deepEqual(calls.writes[0].operations[0].create, {
    name: "Locais Perfil",
    type: "LOCATION_SYNC",
    locationSet: {
      locationOwnershipType: "BUSINESS_OWNER",
      businessProfileLocationSet: { httpAuthorizationToken: TOKEN, emailAddress: "dono@empresa.com.br", labelFilters: ["sp"], listingIdFilters: ["-1", "123"] },
    },
  });
  assert.deepEqual(calls.writes[1].operations[0].create, { assetSet: `customers/${CID}/assetSets/900`, customer: `customers/${CID}` });
  assert.doesNotMatch(textOf(result), new RegExp(TOKEN.replace(/\./g, "\\.")));
  assert.match(textOf(result), /list_location_assets/);
});

test("create_location_sync_asset_set: CHAIN e MAPS montam o oneof certo", async () => {
  const { client, calls } = fakeClient();
  await call(client, "create_location_sync_asset_set", {
    name: "Revendas", source: "CHAIN", ownershipType: "AFFILIATE", chainRelationshipType: "GENERAL_RETAILERS",
    chains: [{ chainId: "12345", locationAttributes: ["pickup"] }, { chainId: 678 }],
  });
  assert.deepEqual((calls.writes[0].operations[0].create as Row).locationSet, {
    locationOwnershipType: "AFFILIATE",
    chainLocationSet: { relationshipType: "GENERAL_RETAILERS", chains: [{ chainId: "12345", locationAttributes: ["pickup"] }, { chainId: "678" }] },
  });

  const { client: c2, calls: calls2 } = fakeClient();
  await call(c2, "create_location_sync_asset_set", { name: "Maps", source: "MAPS", ownershipType: "BUSINESS_OWNER", placeIds: ["ChIJN1t_tDeuEmsRUsoyG83frY4"] });
  assert.deepEqual((calls2.writes[0].operations[0].create as Row).locationSet, {
    locationOwnershipType: "BUSINESS_OWNER",
    mapsLocationSet: { mapsLocations: [{ placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4" }] },
  });
});

test("create_location_sync_asset_set: recusa sem gravar — sync ativo, nome repetido, campos misturados, sem token", async () => {
  const base = { name: "X", source: "BUSINESS_PROFILE", ownershipType: "BUSINESS_OWNER", businessProfileEmail: "a@b.com", businessProfileAccessToken: TOKEN };

  const { client, calls } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) } });
  const existing = await call(client, "create_location_sync_asset_set", base);
  assert.equal(existing.isError, true);
  assert.match(textOf(existing), /Já existe um LOCATION_SYNC ativo/);
  assert.equal(calls.writes.length, 0);

  const { client: c2, calls: calls2 } = fakeClient({ routes: { asset_set: assetSetRoute([], { sameName: [{ id: "1", type: "PAGE_FEED" }] }) } });
  const dup = await call(c2, "create_location_sync_asset_set", base);
  assert.match(textOf(dup), /Já existe um asset set ativo chamado "X"/);
  assert.equal(calls2.writes.length, 0);

  for (const args of [
    { ...base, placeIds: ["ChIJ1"] },
    { ...base, businessProfileAccessToken: undefined },
    { ...base, businessProfileEmail: "sem-arroba" },
    { ...base, listingIds: ["abc"] },
    { name: "X", source: "CHAIN", ownershipType: "AFFILIATE", chains: [{ chainId: "1" }] },
    { name: "X", source: "MAPS", ownershipType: "AFFILIATE", placeIds: [] },
  ]) {
    const { client: c, calls: cs } = fakeClient();
    const result = await call(c, "create_location_sync_asset_set", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(cs.queries.length + cs.writes.length, 0, `nada enviado para ${JSON.stringify(args)}`);
    assert.doesNotMatch(textOf(result), new RegExp(TOKEN.replace(/\./g, "\\.")));
  }
});

test("create_location_sync_asset_set: falha no vínculo, erro de OAuth mapeado, dry-run e validateOnly recusado", async () => {
  const { client } = fakeClient({
    mutate: (resource, operations) => {
      if (resource === "customerAssetSets") throw new Error(`Google Ads API: Request contains an invalid argument. — token ${TOKEN} rejeitado`);
      return { results: operations.map(() => ({ resourceName: `customers/${CID}/assetSets/555` })) };
    },
  });
  const linkFailed = await call(client, "create_location_sync_asset_set", {
    name: "X", source: "MAPS", ownershipType: "BUSINESS_OWNER", placeIds: ["ChIJ1"],
    businessProfileAccessToken: undefined,
  });
  assert.equal(linkFailed.isError, true);
  assert.match(textOf(linkFailed), /Asset set criado \(customers\/1234567890\/assetSets\/555\), mas o vínculo com a conta FALHOU/);
  assert.match(textOf(linkFailed), /link_location_asset_set \(assetSetId=555, level=CUSTOMER\)/);

  const { client: c2 } = fakeClient({
    mutate: () => { throw new Error(`Google Ads API: Request contains an invalid argument. — The Google Business Profile OAuth info is invalid. (${TOKEN})`); },
  });
  const oauth = await call(c2, "create_location_sync_asset_set", {
    name: "X", source: "BUSINESS_PROFILE", ownershipType: "BUSINESS_OWNER", businessProfileEmail: "a@b.com", businessProfileAccessToken: TOKEN,
  });
  assert.match(textOf(oauth), /escopo https:\/\/www\.googleapis\.com\/auth\/business\.manage/);
  assert.doesNotMatch(textOf(oauth), new RegExp(TOKEN.replace(/\./g, "\\.")), "o token some mesmo se a API ecoar");
  assert.match(textOf(oauth), /\[token omitido\]/);

  const { client: dry, calls: dryCalls } = fakeClient({ dryRun: true });
  const validated = await call(dry, "create_location_sync_asset_set", { name: "X", source: "MAPS", ownershipType: "BUSINESS_OWNER", placeIds: ["ChIJ1"] });
  assert.match(textOf(validated), /DRY-RUN .* nada foi gravado/);
  assert.deepEqual(dryCalls.writes.map((w) => w.resource), ["assetSets"], "o passo 2 depende do ID e não é enviado");

  const { client: c3, calls: calls3 } = fakeClient();
  const refused = await call(c3, "create_location_sync_asset_set", { name: "X", source: "MAPS", ownershipType: "BUSINESS_OWNER", placeIds: ["ChIJ1"], validateOnly: true });
  assert.match(textOf(refused), /validateOnly não é suportado em create_location_sync_asset_set/);
  assert.equal(calls3.queries.length + calls3.writes.length, 0);
});

// ── link_location_asset_set ──────────────────────────────────────────

test("link_location_asset_set: LOCATION_SYNC na conta; já vinculado é no-op", async () => {
  const { client, calls } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) } });
  const result = await call(client, "link_location_asset_set", { assetSetId: "500", level: "CUSTOMER" });
  assert.equal(result.isError, false);
  assert.equal(calls.writes[0].resource, "customerAssetSets");
  assert.deepEqual(calls.writes[0].operations, [{ create: { assetSet: `customers/${CID}/assetSets/500`, customer: `customers/${CID}` } }]);
  assert.deepEqual(calls.writes[0].options, { partialFailure: true });

  const { client: c2, calls: calls2 } = fakeClient({
    routes: { asset_set: assetSetRoute([SYNC_BP]), customer_asset_set: [{ customerAssetSet: { resourceName: `customers/${CID}/customerAssetSets/500`, status: "ENABLED" } }] },
  });
  const noop = await call(c2, "link_location_asset_set", { assetSetId: "500", level: "CUSTOMER" });
  assert.match(textOf(noop), /Nada a fazer/);
  assert.equal(calls2.writes.length, 0);
});

test("link_location_asset_set: grupo em campanhas pula vínculo existente e recusa campanha removida/tipo errado", async () => {
  const routes = {
    asset_set: assetSetRoute([SYNC_BP, GROUP]),
    campaign: [
      { campaign: { id: "1", name: "Local", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" } },
      { campaign: { id: "2", name: "Busca", status: "ENABLED", advertisingChannelType: "SEARCH" } },
    ],
    campaign_asset_set: [{ campaign: { id: "1", name: "Local" }, campaignAssetSet: { resourceName: `customers/${CID}/campaignAssetSets/1~600`, status: "ENABLED" } }],
  };
  const { client, calls } = fakeClient({ routes });
  const result = await call(client, "link_location_asset_set", { assetSetId: "600", level: "CAMPAIGN", campaignIds: ["1", "2"] });
  assert.equal(calls.writes[0].resource, "campaignAssetSets");
  assert.deepEqual(calls.writes[0].operations, [{ create: { campaign: `customers/${CID}/campaigns/2`, assetSet: `customers/${CID}/assetSets/600` } }]);
  assert.equal((payloadOf(result).skipped as Row[]).length, 1);

  const { client: c2, calls: calls2 } = fakeClient({ routes: { ...routes, campaign: [{ campaign: { id: "3", name: "Velha", status: "REMOVED" } }] } });
  const removed = await call(c2, "link_location_asset_set", { assetSetId: "600", level: "CAMPAIGN", campaignIds: ["3"] });
  assert.match(textOf(removed), /está removida/);
  assert.equal(calls2.writes.length, 0);

  for (const args of [
    { assetSetId: "500", level: "CAMPAIGN", campaignIds: ["1"] },
    { assetSetId: "600", level: "CUSTOMER" },
    { assetSetId: "600", level: "CAMPAIGN" },
    { assetSetId: "600", level: "CAMPAIGN", campaignIds: ["1"], adGroupIds: ["2"] },
  ]) {
    const { client: c, calls: cs } = fakeClient({ routes });
    const refused = await call(c, "link_location_asset_set", args);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.equal(cs.writes.length, 0);
  }
});

test("link_location_asset_set: erro por item mapeado (canal incompatível) e grupos de anúncios", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset_set: assetSetRoute([GROUP]),
      ad_group: [{ adGroup: { id: "11", name: "G1", status: "ENABLED" }, campaign: { id: "1" } }, { adGroup: { id: "12", name: "G2", status: "ENABLED" }, campaign: { id: "1" } }],
    },
    mutate: () => ({
      results: [{ resourceName: `customers/${CID}/adGroupAssetSets/11~600` }, {}],
      partialFailureError: {
        details: [{ errors: [{ message: "Advertising channel type cannot be attached to the asset set due to channel-based restrictions.", location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const result = await call(client, "link_location_asset_set", { assetSetId: "600", level: "AD_GROUP", adGroupIds: ["11", "12"] });
  assert.equal(result.isError, true);
  assert.equal(calls.writes[0].resource, "adGroupAssetSets");
  const payload = payloadOf(result);
  assert.equal((payload.linked as Row[]).length, 1);
  assert.match(String((payload.errors as Row[])[0].error), /tipo de campanha não aceita/);
});

// ── create_location_group_asset_set ──────────────────────────────────

test("create_location_group_asset_set STATIC: uma mutação atômica com ID temporário, locais e campanhas", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset_set: assetSetRoute([SYNC_BP]),
      asset_set_asset: [
        { asset: { id: "41" }, assetSetAsset: { status: "ENABLED" } },
        { asset: { id: "42" }, assetSetAsset: { status: "ENABLED" } },
      ],
      campaign: [{ campaign: { id: "1", name: "PMax Lojas", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX" } }],
    },
  });
  const result = await call(client, "create_location_group_asset_set", { name: "Lojas SP", groupType: "STATIC", locationAssetIds: ["41", "42"], campaignIds: ["1"] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const temp = `customers/${CID}/assetSets/-1`;
  assert.deepEqual(calls.writes[0].operations, [
    { assetSetOperation: { create: { resourceName: temp, name: "Lojas SP", type: "STATIC_LOCATION_GROUP", locationGroupParentAssetSetId: "500" } } },
    { assetSetAssetOperation: { create: { assetSet: temp, asset: `customers/${CID}/assets/41` } } },
    { assetSetAssetOperation: { create: { assetSet: temp, asset: `customers/${CID}/assets/42` } } },
    { campaignAssetSetOperation: { create: { campaign: `customers/${CID}/campaigns/1`, assetSet: temp } } },
  ]);
  const membership = calls.queries.find((q) => q.includes("FROM asset_set_asset"))!;
  assert.match(membership, new RegExp(`asset_set_asset\\.asset_set = 'customers/${CID}/assetSets/500' AND asset\\.id IN \\(41, 42\\)`));
  assert.equal(payloadOf(result).asset_set_id, "777");
});

test("create_location_group_asset_set: dinâmico do Perfil da Empresa e de redes; pai incompatível é recusado", async () => {
  const { client, calls } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) } });
  await call(client, "create_location_group_asset_set", { name: "SP", groupType: "BUSINESS_PROFILE_DYNAMIC", labelFilters: ["sp"], listingIds: ["18446744073709551615"], businessName: "Loja X" });
  assert.deepEqual(((calls.writes[0].operations[0] as Row).assetSetOperation as Row).create, {
    resourceName: `customers/${CID}/assetSets/-1`,
    name: "SP",
    type: "BUSINESS_PROFILE_DYNAMIC_LOCATION_GROUP",
    locationGroupParentAssetSetId: "500",
    businessProfileLocationGroup: { dynamicBusinessProfileLocationGroupFilter: { labelFilters: ["sp"], listingIdFilters: ["-1"], businessNameFilter: { businessName: "Loja X", filterType: "EXACT" } } },
  });

  const { client: c2, calls: calls2 } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_CHAIN]) } });
  await call(c2, "create_location_group_asset_set", { name: "Rede", groupType: "CHAIN_DYNAMIC", chains: [{ chainId: "99" }] });
  assert.deepEqual((((calls2.writes[0].operations[0] as Row).assetSetOperation as Row).create as Row).chainLocationGroup, { dynamicChainLocationGroupFilters: [{ chainId: "99" }] });

  const { client: c3, calls: calls3 } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_CHAIN]) } });
  const mismatch = await call(c3, "create_location_group_asset_set", { name: "SP", groupType: "BUSINESS_PROFILE_DYNAMIC", labelFilters: ["sp"] });
  assert.match(textOf(mismatch), /sincroniza redes/);
  assert.equal(calls3.writes.length, 0);
});

test("create_location_group_asset_set: recusa sem gravar — local fora do pai, sem LOCATION_SYNC, filtros errados; dry-run", async () => {
  const { client, calls } = fakeClient({
    routes: { asset_set: assetSetRoute([SYNC_BP]), asset_set_asset: [{ asset: { id: "41" }, assetSetAsset: { status: "REMOVED" } }] },
  });
  const outside = await call(client, "create_location_group_asset_set", { name: "SP", groupType: "STATIC", locationAssetIds: ["41", "43"] });
  assert.match(textOf(outside), /fora do LOCATION_SYNC 500 .*: 41, 43/);
  assert.equal(calls.writes.length, 0);

  const { client: c2, calls: calls2 } = fakeClient();
  const noSync = await call(c2, "create_location_group_asset_set", { name: "SP", groupType: "STATIC", locationAssetIds: ["41"] });
  assert.match(textOf(noSync), /não tem LOCATION_SYNC ativo/);
  assert.equal(calls2.writes.length, 0);

  for (const args of [
    { name: "SP", groupType: "STATIC" },
    { name: "SP", groupType: "BUSINESS_PROFILE_DYNAMIC" },
    { name: "SP", groupType: "CHAIN_DYNAMIC", labelFilters: ["x"], chains: [{ chainId: "1" }] },
    { name: "", groupType: "STATIC", locationAssetIds: ["1"] },
    { name: "SP", groupType: "STATIC", locationAssetIds: ["1"], parentAssetSetId: "abc" },
  ]) {
    const { client: c, calls: cs } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) } });
    const refused = await call(c, "create_location_group_asset_set", args);
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.equal(cs.queries.length + cs.writes.length, 0, `nada enviado para ${JSON.stringify(args)}`);
  }

  const { client: dry } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) }, dryRun: true });
  const validated = await call(dry, "create_location_group_asset_set", { name: "SP", groupType: "BUSINESS_PROFILE_DYNAMIC", labelFilters: ["sp"] });
  assert.match(textOf(validated), /DRY-RUN .* nada foi gravado/);
});

// ── unlink / remove ──────────────────────────────────────────────────

test("unlink_location_asset_set: exige confirm; remove só os vínculos ativos lidos da conta", async () => {
  const routes = {
    asset_set: assetSetRoute([GROUP]),
    campaign_asset_set: [{ campaign: { id: "1", name: "Local" }, campaignAssetSet: { resourceName: `customers/${CID}/campaignAssetSets/1~600`, status: "ENABLED" } }],
  };
  const { client, calls } = fakeClient({ routes });
  const plan = await call(client, "unlink_location_asset_set", { assetSetId: "600", level: "CAMPAIGN", campaignIds: ["1", "2"] });
  assert.equal(plan.isError, true);
  assert.match(textOf(plan), /Plano \(nada foi gravado\)/);
  assert.equal(calls.writes.length, 0);

  const { client: c2, calls: calls2 } = fakeClient({ routes });
  const done = await call(c2, "unlink_location_asset_set", { assetSetId: "600", level: "CAMPAIGN", campaignIds: ["1", "2"], confirm: true });
  assert.equal(done.isError, false);
  assert.deepEqual(calls2.writes[0], {
    method: "mutate",
    resource: "campaignAssetSets",
    operations: [{ remove: `customers/${CID}/campaignAssetSets/1~600` }],
    options: { partialFailure: true },
  });
  assert.equal((payloadOf(done).skipped as Row[])[0].campaign_id, "2");

  const { client: c3, calls: calls3 } = fakeClient({ routes: { asset_set: assetSetRoute([SYNC_BP]) } });
  const nothing = await call(c3, "unlink_location_asset_set", { assetSetId: "500", level: "CUSTOMER", confirm: true });
  assert.match(textOf(nothing), /Nada a desvincular/);
  assert.equal(calls3.writes.length, 0);
});

test("remove_location_asset_set: recusa com vínculos ou filhos ativos, exige confirm e remove", async () => {
  const { client, calls } = fakeClient({
    routes: {
      asset_set: assetSetRoute([SYNC_BP], { children: [GROUP] }),
      customer_asset_set: [{ customerAssetSet: { resourceName: `customers/${CID}/customerAssetSets/500`, status: "ENABLED" } }],
    },
  });
  const blocked = await call(client, "remove_location_asset_set", { assetSetId: "500", confirm: true });
  assert.equal(blocked.isError, true);
  const blockers = payloadOf(blocked).blockers as Row;
  assert.equal(blockers.customer, true);
  assert.equal((blockers.child_groups as Row[])[0].asset_set_id, "600");
  assert.equal(calls.writes.length, 0);

  const { client: c2, calls: calls2 } = fakeClient({ routes: { asset_set: assetSetRoute([GROUP]) } });
  const plan = await call(c2, "remove_location_asset_set", { assetSetId: "600" });
  assert.match(textOf(plan), /Plano \(nada foi gravado\)/);
  assert.equal(calls2.writes.length, 0);

  const { client: c3, calls: calls3 } = fakeClient({ routes: { asset_set: assetSetRoute([GROUP]) } });
  const removed = await call(c3, "remove_location_asset_set", { assetSetId: "600", confirm: true });
  assert.equal(removed.isError, undefined);
  assert.deepEqual(calls3.writes[0].operations, [{ remove: `customers/${CID}/assetSets/600` }]);
  assert.equal(calls3.writes[0].resource, "assetSets");

  const { client: c4, calls: calls4 } = fakeClient({ routes: { asset_set: assetSetRoute([{ ...GROUP, status: "REMOVED" }]) } });
  assert.match(textOf(await call(c4, "remove_location_asset_set", { assetSetId: "600", confirm: true })), /já está removido/);
  assert.equal(calls4.writes.length, 0);

  const { client: c5, calls: calls5 } = fakeClient({ routes: { asset_set: assetSetRoute([{ ...GROUP, type: "PAGE_FEED" }]) } });
  assert.match(textOf(await call(c5, "remove_location_asset_set", { assetSetId: "600", confirm: true })), /não de locais/);
  assert.equal(calls5.writes.length, 0);
});

// ── GoogleAdsClient real, fetch interceptado ─────────────────────────

const CREDENTIALS = {
  token: "test-token",
  refresh_token: "test-refresh",
  token_uri: "https://oauth2.googleapis.com/token",
  client_id: "test-client",
  client_secret: "test-secret",
  expiry: "2999-01-01T00:00:00.000Z",
};

function interceptFetch(respond: (url: string, body: Row) => unknown) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify(respond(url, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function realClient(flags: { dryRun?: boolean } = {}) {
  return new GoogleAdsClient({ credentials: CREDENTIALS, developerToken: "dev", loginCustomerId: CID, ...flags });
}

test("client real: LOCATION_SYNC vai em assetSets:mutate e o vínculo em customerAssetSets:mutate (v25)", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      assertGaqlRules(String(body.query));
      return [{ results: [] }];
    }
    if (url.endsWith("/assetSets:mutate")) return { results: [{ resourceName: `customers/${CID}/assetSets/321` }] };
    return { results: [{ resourceName: `customers/${CID}/customerAssetSets/321` }] };
  });
  try {
    const result = await call(realClient(), "create_location_sync_asset_set", { name: "Maps", source: "MAPS", ownershipType: "BUSINESS_OWNER", placeIds: ["ChIJ1"] });
    assert.equal(result.isError, undefined, textOf(result));
    const writes = net.calls.filter((c) => c.url.endsWith(":mutate"));
    assert.deepEqual(writes.map((w) => w.url), [
      `https://googleads.googleapis.com/v25/customers/${CID}/assetSets:mutate`,
      `https://googleads.googleapis.com/v25/customers/${CID}/customerAssetSets:mutate`,
    ]);
    assert.equal((writes[1].body.operations as Row[])[0].create && ((writes[1].body.operations as Row[])[0].create as Row).assetSet, `customers/${CID}/assetSets/321`);
  } finally {
    net.restore();
  }
});

test("client real: declaração de IA em assets:mutate com partialFailure e validateOnly no dry-run", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      assertGaqlRules(String(body.query));
      return [{ results: [{ asset: { id: "91", name: "a", type: "IMAGE" } }] }];
    }
    return {};
  });
  try {
    const result = await call(realClient({ dryRun: true }), "update_asset_synthetic_attestation", { assetIds: ["91"], aiGenerated: true, confirm: true });
    const write = net.calls.find((c) => c.url.endsWith("/assets:mutate"))!;
    assert.equal(write.url, `https://googleads.googleapis.com/v25/customers/${CID}/assets:mutate`);
    assert.equal(write.body.validateOnly, true);
    assert.equal(write.body.partialFailure, true);
    assert.deepEqual((write.body.operations as Row[])[0], {
      update: { resourceName: `customers/${CID}/assets/91`, syntheticContentInfo: { advertiserAttestation: { status: "IS_SYNTHETIC", source: "ADVERTISER_ATTESTED" } } },
      updateMask: "synthetic_content_info.advertiser_attestation.status,synthetic_content_info.advertiser_attestation.source",
    });
    assert.match(textOf(result), /DRY-RUN/);
  } finally {
    net.restore();
  }
});

test("client real: grupo de locais é um googleAds:mutate atômico com mutateOperations", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      const query = String(body.query);
      assertGaqlRules(query);
      if (query.includes("FROM asset_set") && query.includes("'LOCATION_SYNC'")) return [{ results: [{ assetSet: SYNC_BP }] }];
      return [{ results: [] }];
    }
    return { mutateOperationResponses: [{ assetSetResult: { resourceName: `customers/${CID}/assetSets/888` } }] };
  });
  try {
    const result = await call(realClient(), "create_location_group_asset_set", { name: "SP", groupType: "BUSINESS_PROFILE_DYNAMIC", labelFilters: ["sp"] });
    assert.equal(result.isError, undefined, textOf(result));
    const write = net.calls.find((c) => c.url.endsWith("googleAds:mutate"))!;
    assert.equal(write.url, `https://googleads.googleapis.com/v25/customers/${CID}/googleAds:mutate`);
    assert.equal((write.body.mutateOperations as Row[]).length, 1);
    assert.match(textOf(result), /assetSets\/888/);
  } finally {
    net.restore();
  }
});
