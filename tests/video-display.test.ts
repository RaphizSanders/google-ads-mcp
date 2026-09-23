/**
 * Lote video-display: relatório de vídeo, upload para o YouTube, anúncio de imagem,
 * vínculos de vídeo de criadores (DataLinkService) e as tools de Display/Vídeo que já
 * existiam (create_responsive_display_ad, create_video_campaign, create_video_ad).
 *
 * Client falso: toda query passa por assertGaqlRules (metadados reais da v25) e toda
 * escrita é registrada, para provar o que sai (e o que NÃO sai) em cada caminho.
 * O upload resumável também é testado no GoogleAdsClient real com fetch interceptado.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import {
  VIDEO_REPORT_BREAKDOWNS,
  VIDEO_REPORT_LEVELS,
  checkDownloadUrl,
  fixedChunks,
  isPrivateAddress,
  netDeps,
  parseDataLinkRef,
  parseYouTubeVideoId,
  runResumableUpload,
} from "../src/tools/video-display.js";
import { assertGaqlRules } from "./gaql-rules.js";
import { toolImplementations } from "./tool-sources.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const MIB = 1024 * 1024;

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  rows?: Record<string, Row[] | ((query: string) => Row[])>;
  dryRun?: boolean;
  mutateAdGroupAds?: (operations: Row[]) => Row;
  mutateAssets?: (operations: Row[]) => Row;
  action?: (action: string, body: Row) => Row;
  granularity?: number;
  sendChunk?: (offset: number, data: Uint8Array, finalize: boolean, attempt: number) => { status: string; body: Row | null };
  queryUpload?: () => { status: string; sizeReceived: number };
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ method: string; operations?: Row[]; action?: string; body?: Row }>,
    starts: [] as Array<{ cid: string; action: string; body: Row; size?: number }>,
    chunks: [] as Array<{ offset: number; length: number; finalize: boolean }>,
    cancels: 0,
    dryRunClones: 0,
  };
  let chunkAttempts = 0;
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun() {
      calls.dryRunClones++;
      return build(true);
    },
    async searchStream(_cid: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      if (typeof source === "function") return source(query);
      return source ?? [];
    },
    async mutateAdGroupAds(_cid: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAdGroupAds", operations });
      if (opts.mutateAdGroupAds) return opts.mutateAdGroupAds(operations);
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/adGroupAds/555~999` }] };
    },
    async mutateAssets(_cid: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "mutateAssets", operations });
      if (opts.mutateAssets) return opts.mutateAssets(operations);
      return dryRun ? {} : { results: [{ resourceName: `customers/${CID}/assets/777` }] };
    },
    async customerWriteAction(_cid: string, action: string, body: Row): Promise<Row> {
      if (dryRun) throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      calls.writes.push({ method: "customerWriteAction", action, body });
      return opts.action ? opts.action(action, body) : {};
    },
    async startResumableUpload(cid: string, action: string, body: Row, size?: number) {
      if (dryRun) throw new Error("GOOGLE_ADS_DRY_RUN: upload bloqueado");
      calls.starts.push({ cid, action, body, size });
      return { uploadUrl: "https://googleads.googleapis.com/upload/sessao-1", chunkGranularity: opts.granularity ?? 262_144 };
    },
    async sendResumableChunk(_url: string, offset: number, data: Uint8Array, finalize: boolean) {
      chunkAttempts++;
      calls.chunks.push({ offset, length: data.byteLength, finalize });
      if (opts.sendChunk) return opts.sendChunk(offset, data, finalize, chunkAttempts);
      return finalize
        ? { status: "final", body: { resourceName: `customers/${CID}/youTubeVideoUploads/4242` } }
        : { status: "active", body: null };
    },
    async queryResumableUpload() {
      return opts.queryUpload ? opts.queryUpload() : { status: "active", sizeReceived: 0 };
    },
    async cancelResumableUpload() {
      calls.cancels++;
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

const call = (client: unknown, tool: string, args: Row, opts: { allowed?: string[]; hosted?: boolean } = {}) =>
  register(client, opts).get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as Row;
}

const writesOf = (calls: { writes: unknown[] }) => calls.writes.length;

function image(id: string, width: number, height: number, extra: Row = {}): Row {
  return {
    asset: {
      id, name: `img-${id}`, type: "IMAGE", resourceName: `customers/${CID}/assets/${id}`,
      imageAsset: { fullSize: { widthPixels: String(width), heightPixels: String(height) }, ...extra },
    },
  };
}

function assetsById(list: Row[]) {
  return (query: string) => {
    const ids = (/asset\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? /asset\.id = (\d+)/.exec(query)?.[1] ?? "")
      .split(",").map((s) => s.trim());
    return list.filter((row) => ids.includes(String((row.asset as Row).id)));
  };
}

const displayGroup = (overrides: Row = {}): Row => ({
  adGroup: { id: "555", name: "Display - Remarketing", status: "ENABLED", type: "DISPLAY_STANDARD", ...overrides },
  campaign: { id: "111", name: "Display BR", status: "ENABLED", advertisingChannelType: "DISPLAY" },
});

// ══════════════════════════════════════════════════════════════════
// get_video_performance
// ══════════════════════════════════════════════════════════════════

const videoMetrics = (overrides: Row = {}): Row => ({
  impressions: "10000", clicks: "120", costMicros: "500000000", conversions: 4, conversionsValue: 800,
  videoTrueviewViews: "3100", videoTrueviewViewRate: 0.31, videoTrueviewViewRateInFeed: 0.12,
  videoTrueviewViewRateInStream: 0.35, videoTrueviewViewRateShorts: 0.05, trueviewAverageCpv: 80000,
  videoQuartileP25Rate: 0.6, videoQuartileP50Rate: 0.45, videoQuartileP75Rate: 0.3, videoQuartileP100Rate: 0.2,
  videoWatchTimeDurationMillis: "7200000", averageVideoWatchTimeDurationMillis: "12000",
  engagements: "50", engagementRate: 0.005, youtubeLikes: "7", youtubeComments: "1", youtubeShares: "2",
  ...overrides,
});

test("vídeo: CAMPAIGN padrão — métricas TrueView v22+, filtro VIDEO+DEMAND_GEN e benchmarks", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "1", name: "YT Awareness", status: "ENABLED", advertisingChannelType: "VIDEO" }, metrics: videoMetrics() }],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const result = await call(client, "get_video_performance", { days: 30 });
  assert.equal(result.isError, undefined);
  const query = calls.queries[0];
  assert.match(query, /FROM campaign/);
  for (const field of ["metrics.video_trueview_views", "metrics.video_trueview_view_rate_shorts", "metrics.trueview_average_cpv",
    "metrics.video_quartile_p100_rate", "metrics.youtube_likes", "metrics.video_watch_time_duration_millis"]) {
    assert.ok(query.includes(field), `faltou ${field}`);
  }
  assert.doesNotMatch(query, /metrics\.video_views\b|metrics\.average_cpv\b/, "nomes antigos (pré-v22) não podem aparecer");
  assert.match(query, /campaign\.advertising_channel_type IN \('VIDEO', 'DEMAND_GEN'\)/);
  assert.match(query, /metrics\.impressions > 0/);
  assert.doesNotMatch(query, /unique_users/, "alcance só com includeReach");

  const payload = jsonOf(result);
  const row = (payload.rows as Row[])[0];
  assert.equal(row.view_rate_pct, 31);
  assert.equal(row.cpv, 0.08, "trueview_average_cpv vem em micros");
  assert.equal(row.cpm, 50);
  assert.equal(row.p100_pct, 20);
  assert.equal(row.watch_time_hours, 2);
  assert.equal(row.benchmark_view_rate, "bom");
  assert.equal(row.benchmark_cpv, "bom");
  const totals = payload.totals as Row;
  assert.equal(totals.views, 3100);
  assert.equal(totals.cpv, 0.08);
});

test("vídeo: toda combinação de nível × quebra monta GAQL válido para a v25", async () => {
  for (const level of VIDEO_REPORT_LEVELS) {
    for (const breakdown of VIDEO_REPORT_BREAKDOWNS) {
      const { client, calls } = fakeClient();
      const result = await call(client, "get_video_performance", { level, breakdown, campaignId: "42", channel: "VIDEO" });
      assert.equal(result.isError, undefined, `${level}/${breakdown}: ${textOf(result)}`);
      assert.equal(calls.queries.length, 1);
      const q = calls.queries[0];
      if (level === "VIDEO_ENHANCEMENT") assert.doesNotMatch(q, /youtube_likes/, "youtube_* não existe em video_enhancement");
      if (breakdown === "SUB_NETWORK") assert.match(q, /segments\.ad_network_type, segments\.ad_sub_network_type/);
      if (breakdown === "FORMAT") assert.match(q, /segments\.ad_format_type, segments\.ad_sub_format_type/);
      assert.match(q, /campaign\.id = 42/);
      assert.match(q, /campaign\.advertising_channel_type = 'VIDEO'/);
    }
  }
});

test("vídeo: quebra por sub-rede traz a divisão Shorts × in-feed × in-stream", async () => {
  const seg = (sub: string, impressions: string, cost: string) => ({
    campaign: { id: "9", name: "DG", advertisingChannelType: "DEMAND_GEN" },
    segments: { adNetworkType: "YOUTUBE", adSubNetworkType: sub },
    metrics: videoMetrics({ impressions, costMicros: cost }),
  });
  const { client } = fakeClient({
    rows: {
      campaign: [seg("YOUTUBE_SHORTS", "6000", "300000000"), seg("YOUTUBE_INFEED", "4000", "100000000")],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const payload = jsonOf(await call(client, "get_video_performance", { breakdown: "SUB_NETWORK", channel: "DEMAND_GEN" }));
  const split = payload.split as Row[];
  assert.equal(split.length, 2);
  assert.equal(split[0].segment, "YOUTUBE / YOUTUBE_SHORTS");
  assert.equal(split[0].share_impressions_pct, 60);
  assert.equal(split[0].share_cost_pct, 75);
  assert.equal((payload.rows as Row[])[0].sub_network, "YOUTUBE_SHORTS");
});

test("vídeo: alcance só em CAMPAIGN sem quebra e até 92 dias — senão recusa sem consultar", async () => {
  for (const args of [
    { includeReach: true, level: "AD" },
    { includeReach: true, breakdown: "NETWORK" },
    { includeReach: true, days: 120 },
    { includeReach: true, dateRange: { since: "2026-01-01", until: "2026-06-30" } },
  ]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_video_performance", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0);
  }
  const { client, calls } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "1", name: "YT" }, metrics: videoMetrics({ uniqueUsers: "5000", averageImpressionFrequencyPerUser: 2.345 }) }],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const result = await call(client, "get_video_performance", { includeReach: true, dateRange: { since: "2026-06-01", until: "2026-08-31" } });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(calls.queries[0], /metrics\.unique_users, metrics\.average_impression_frequency_per_user/);
  const row = (jsonOf(result).rows as Row[])[0];
  assert.equal(row.unique_users, 5000);
  assert.equal(row.avg_frequency_per_user, 2.35);
});

test("vídeo: entrada inválida e conta fora da allowlist não consultam", async () => {
  for (const args of [{ campaignId: "12 OR 1=1" }, { limit: 0 }, { dateRange: { since: "ontem", until: "hoje" } }]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "get_video_performance", args);
    assert.equal(result.isError, true);
    assert.equal(calls.queries.length, 0);
  }
  const { client, calls } = fakeClient();
  const denied = await call(client, "get_video_performance", {}, { allowed: ["9999999999"], hosted: true });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /Access denied/);
  assert.equal(calls.queries.length, 0);
});

test("vídeo: conta fora de BRL não recebe benchmark de CPV; csv sai tabular", async () => {
  const rows = {
    campaign: [{ campaign: { id: "1", name: "YT", advertisingChannelType: "VIDEO" }, metrics: videoMetrics() }],
    customer: [{ customer: { currencyCode: "USD" } }],
  };
  const payload = jsonOf(await call(fakeClient({ rows }).client, "get_video_performance", {}));
  assert.equal((payload.rows as Row[])[0].benchmark_cpv, "sem benchmark (conta fora de BRL)");
  assert.equal(payload.currency, "USD");
  const csv = textOf(await call(fakeClient({ rows }).client, "get_video_performance", { format: "csv" }));
  assert.match(csv.split("\n")[0], /^campaign_id,campaign_name,channel/);
});

test("vídeo: amostra pequena não é classificada como bom/ruim", async () => {
  const { client } = fakeClient({
    rows: { campaign: [{ campaign: { id: "1" }, metrics: videoMetrics({ impressions: "200", videoTrueviewViews: "10" }) }] },
  });
  const row = (jsonOf(await call(client, "get_video_performance", {})).rows as Row[])[0];
  assert.equal(row.benchmark_view_rate, "amostra pequena");
  assert.equal(row.benchmark_cpv, "amostra pequena");
});

/** Linha sem vídeo: impressões e custo, nenhuma métrica de vídeo. */
const noVideoMetrics = (impressions: string): Row => ({
  impressions, clicks: "3000", costMicros: "9000000000", conversions: 40, conversionsValue: 9000,
  videoTrueviewViews: "0", videoTrueviewViewRate: 0, trueviewAverageCpv: 0,
  videoQuartileP25Rate: 0, videoQuartileP50Rate: 0, videoQuartileP75Rate: 0, videoQuartileP100Rate: 0,
});

test("vídeo: channel ALL — linha sem vídeo não recebe benchmark nem dilui o view rate do resumo", async () => {
  const { client, calls } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "2", name: "Search Brand", advertisingChannelType: "SEARCH" }, metrics: noVideoMetrics("90000") },
        { campaign: { id: "1", name: "Video", advertisingChannelType: "VIDEO" }, metrics: videoMetrics() },
      ],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const result = await call(client, "get_video_performance", { channel: "ALL" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(calls.queries[0], /metrics\.video_trueview_views > 0/, "ALL só traz linhas com views TrueView");
  assert.doesNotMatch(calls.queries[0], /advertising_channel_type (=|IN)/, "ALL não filtra tipo de campanha");

  const payload = jsonOf(result);
  const rows = payload.rows as Row[];
  const search = rows.find((r) => r.channel === "SEARCH")!;
  const video = rows.find((r) => r.channel === "VIDEO")!;
  assert.equal(search.benchmark_view_rate, "sem views TrueView");
  assert.equal(search.benchmark_cpv, "sem views TrueView");
  assert.equal(video.benchmark_view_rate, "bom");

  const totals = payload.totals as Row;
  assert.equal(totals.impressions, 100000, "impressões seguem somando tudo");
  assert.equal(totals.view_rate_pct, 31, "view rate só das linhas com views (não 3.1%)");
  assert.equal((totals.benchmark as Row).view_rate, "bom");
  assert.deepEqual(totals.view_rate_basis, { video_impressions: 10000, rows_with_views: 1, rows_without_views: 1 });
  assert.deepEqual(totals.quartiles_pct_aprox, { p25: 60, p50: 45, p75: 30, p100: 20 }, "quartis sem a diluição da Pesquisa");
  const header = textOf(result).split("\n").slice(0, 2).join("\n");
  assert.match(header, /3100 views \(31% — bom\)/);
  assert.doesNotMatch(header, /3\.1%|ruim/);
  assert.match(header, /1 sem views TrueView ficaram fora/);

  // Os outros canais filtram por tipo de campanha e não precisam do filtro de views
  const dflt = fakeClient();
  await call(dflt.client, "get_video_performance", {});
  assert.doesNotMatch(dflt.calls.queries[0], /video_trueview_views > 0/);
});

test("vídeo: Demand Gen só de imagem (filtro padrão) sai 'sem views TrueView' e fica fora do resumo", async () => {
  const { client } = fakeClient({
    rows: {
      campaign: [
        { campaign: { id: "3", name: "DG Imagem", advertisingChannelType: "DEMAND_GEN" }, metrics: noVideoMetrics("50000") },
        { campaign: { id: "1", name: "Video", advertisingChannelType: "VIDEO" }, metrics: videoMetrics() },
      ],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const payload = jsonOf(await call(client, "get_video_performance", {}));
  const image = (payload.rows as Row[]).find((r) => r.campaign_id === "3")!;
  assert.equal(image.benchmark_view_rate, "sem views TrueView");
  const totals = payload.totals as Row;
  assert.equal(totals.view_rate_pct, 31);
  assert.equal((totals.quartiles_pct_aprox as Row).p100, 20);
  const notes = payload.notes as string[];
  assert.ok(notes.some((n) => /1 linha\(s\) sem views TrueView/.test(n)), `nota sobre a linha sem views ausente: ${JSON.stringify(notes)}`);
});

test("vídeo: campanha mista (imagem + vídeo) — o resumo usa a base de impressões de vídeo da própria API", async () => {
  // 100 mil impressões na linha, mas a API diz 31% de view rate com 3100 views → 10 mil impressões de vídeo
  const { client } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "4", name: "DG Misto", advertisingChannelType: "DEMAND_GEN" }, metrics: videoMetrics({ impressions: "100000" }) }],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const payload = jsonOf(await call(client, "get_video_performance", {}));
  assert.equal((payload.rows as Row[])[0].benchmark_view_rate, "bom");
  const totals = payload.totals as Row;
  assert.equal(totals.view_rate_pct, 31, "não 3.1% (views ÷ todas as impressões da linha)");
  assert.equal((totals.view_rate_basis as Row).video_impressions, 10000);
  assert.equal((totals.benchmark as Row).view_rate, "bom");
  assert.deepEqual(totals.quartiles_pct_aprox, { p25: 60, p50: 45, p75: 30, p100: 20 }, "quartis na mesma base de impressões de vídeo");
});

test("vídeo: nenhuma linha com views — resumo sem view rate e sem veredito", async () => {
  const { client } = fakeClient({
    rows: {
      campaign: [{ campaign: { id: "5", name: "Bumper", advertisingChannelType: "VIDEO" }, metrics: noVideoMetrics("40000") }],
      customer: [{ customer: { currencyCode: "BRL" } }],
    },
  });
  const result = await call(client, "get_video_performance", {});
  const totals = jsonOf(result).totals as Row;
  assert.equal(totals.view_rate_pct, null);
  assert.equal(totals.cpv, null);
  assert.deepEqual(totals.benchmark, { view_rate: "sem views TrueView", cpv: "sem views TrueView" });
  assert.deepEqual(totals.quartiles_pct_aprox, { p25: null, p50: null, p75: null, p100: null });
  assert.match(textOf(result), /0 views \(sem views TrueView\)/);
  assert.doesNotMatch(textOf(result), /ruim/);
});

// ══════════════════════════════════════════════════════════════════
// upload_youtube_video + upload resumável
// ══════════════════════════════════════════════════════════════════

const b64 = (size: number) => Buffer.alloc(size, 7).toString("base64");

test("upload: base64 — abre a sessão com os metadados certos e finaliza num pedaço só", async () => {
  const { client, calls } = fakeClient({
    rows: {
      you_tube_video_upload: [{ youTubeVideoUpload: { resourceName: `customers/${CID}/youTubeVideoUploads/4242`, videoUploadId: "4242", state: "UPLOADED" } }],
    },
  });
  const result = await call(client, "upload_youtube_video", { title: "Institucional 30s", description: "Vídeo da campanha", videoBase64: b64(1000) });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.starts[0].action, "youTubeVideoUploads:create");
  assert.deepEqual(calls.starts[0].body, {
    customerId: CID,
    youTubeVideoUpload: { videoTitle: "Institucional 30s", videoDescription: "Vídeo da campanha", videoPrivacy: "UNLISTED" },
  });
  assert.equal(calls.starts[0].size, 1000);
  assert.deepEqual(calls.chunks, [{ offset: 0, length: 1000, finalize: true }]);
  assert.match(calls.queries[0], /FROM you_tube_video_upload WHERE you_tube_video_upload\.resource_name = /);
  assert.match(textOf(result), /Estado: UPLOADED/);
  assert.match(textOf(result), /upload_video_asset/);
});

test("upload: validação recusa antes de abrir sessão", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ title: "x", videoBase64: b64(10), httpsUrl: "https://videos.exemplo.com/a.mp4" }, /exatamente uma fonte/],
    [{ title: "x" }, /exatamente uma fonte/],
    [{ title: "x", videoBase64: b64(10), privacy: "PUBLIC" }, /PUBLIC só é permitido/],
    [{ title: "x", videoBase64: b64(10), channelId: "canal-da-marca" }, /channelId .* inválido/],
    [{ title: "a".repeat(101), videoBase64: b64(10) }, /até 100/],
    [{ title: "<script>", videoBase64: b64(10) }, /não pode conter < ou >/],
    [{ title: "x", videoBase64: "não é base64!" }, /base64 válido/],
    [{ title: "x", filePath: "videos/relativo.mp4" }, /precisa ser absoluto/],
    [{ title: "x", filePath: "/etc/passwd" }, /Extensão/],
    [{ title: "x", httpsUrl: "http://videos.exemplo.com/a.mp4" }, /só URL https/],
    [{ title: "x", httpsUrl: "https://127.0.0.1/a.mp4" }, /interno\/privado/],
    [{ title: "x", httpsUrl: "https://[::ffff:10.0.0.8]/a.mp4" }, /interno\/privado/],
    [{ title: "x", httpsUrl: "https://metadata.internal/a.mp4" }, /é interno/],
    [{ title: "x", httpsUrl: "https://user:senha@videos.exemplo.com/a.mp4" }, /usuário\/senha/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_youtube_video", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern, JSON.stringify(args));
    assert.equal(calls.starts.length, 0);
  }
});

test("upload: filePath é recusado no servidor hospedado; no stdio lê o arquivo em pedaços", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yt-upload-"));
  const file = join(dir, "video.mp4");
  writeFileSync(file, Buffer.alloc(5000, 1));
  try {
    const hostedRun = fakeClient();
    const refused = await call(hostedRun.client, "upload_youtube_video", { title: "x", filePath: file }, { allowed: ["*"], hosted: true });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /não é aceito no servidor hospedado/);
    assert.equal(hostedRun.calls.starts.length, 0);

    const local = fakeClient();
    const result = await call(local.client, "upload_youtube_video", { title: "x", filePath: file });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(local.calls.starts[0].size, 5000);
    assert.deepEqual(local.calls.chunks, [{ offset: 0, length: 5000, finalize: true }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upload: validateOnly/dry-run valida localmente e não abre sessão", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "upload_youtube_video", { title: "x", videoBase64: b64(10), validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /^VALIDATE-ONLY/);
  assert.match(textOf(result), /nada foi enviado ao YouTube/);
  assert.equal(calls.starts.length, 0);
});

test("upload: URL pública é baixada em streaming; host que resolve para rede interna é recusado", async () => {
  const originalLookup = netDeps.lookup;
  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  netDeps.lookup = async (host: string) =>
    host === "cdn.exemplo.com.br" ? [{ address: "203.0.113.10", family: 4 }] : [{ address: "10.1.2.3", family: 4 }];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/redireciona.mp4")) {
      return new Response(null, { status: 302, headers: { location: "https://interno.exemplo.com.br/x.mp4" } });
    }
    return new Response(Buffer.alloc(3000, 2), { status: 200, headers: { "content-type": "video/mp4", "content-length": "3000" } });
  }) as typeof fetch;
  try {
    const ok = fakeClient();
    const result = await call(ok.client, "upload_youtube_video", { title: "x", httpsUrl: "https://cdn.exemplo.com.br/v.mp4" });
    assert.equal(result.isError, undefined, textOf(result));
    assert.equal(ok.calls.starts[0].size, 3000);
    assert.equal(ok.calls.chunks[0].length, 3000);

    const internal = fakeClient();
    const refused = await call(internal.client, "upload_youtube_video", { title: "x", httpsUrl: "https://interno.exemplo.com.br/v.mp4" });
    assert.match(textOf(refused), /resolve para endereço interno \(10\.1\.2\.3\)/);
    assert.equal(internal.calls.starts.length, 0);

    const redirect = fakeClient();
    const redirected = await call(redirect.client, "upload_youtube_video", { title: "x", httpsUrl: "https://cdn.exemplo.com.br/redireciona.mp4" });
    assert.equal(redirected.isError, true);
    assert.match(textOf(redirected), /redirecionamento recusado/);
    assert.equal(redirect.calls.starts.length, 0, "nada sai para o YouTube quando o download é recusado");
  } finally {
    netDeps.lookup = originalLookup;
    globalThis.fetch = originalFetch;
  }
});

test("upload: download maior que 2 GiB ou que não é vídeo é recusado antes de abrir sessão", async () => {
  const originalLookup = netDeps.lookup;
  const originalFetch = globalThis.fetch;
  const cancelled: string[] = [];
  netDeps.lookup = async () => [{ address: "203.0.113.10", family: 4 }];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    // Corpo curto e finito (5 × 1000 bytes): se a guarda falhar o teste termina, sem baixar gigabytes
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ < 5) controller.enqueue(new Uint8Array(1000));
        else controller.close();
      },
      cancel() { cancelled.push(url); },
    });
    if (url.endsWith("/gigante.mp4")) {
      return new Response(body, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(2 * 1024 ** 3 + 1) } });
    }
    if (url.endsWith("/pagina.mp4")) {
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": "5000" } });
    }
    // Limite exato declarado; o corpo de teste é curto (o fake do client não confere o total)
    return new Response(Buffer.alloc(3000, 3), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(2 * 1024 ** 3) } });
  }) as typeof fetch;
  try {
    const big = fakeClient();
    const b = await call(big.client, "upload_youtube_video", { title: "x", httpsUrl: "https://cdn.exemplo.com.br/gigante.mp4" });
    assert.equal(b.isError, true);
    assert.match(textOf(b), /tem 2147483649 bytes; o limite desta tool é 2147483648 bytes \(2 GiB\)/);
    assert.equal(big.calls.starts.length, 0, "nenhuma sessão de upload para arquivo acima do limite");
    assert.ok(cancelled.some((u) => u.endsWith("/gigante.mp4")), "o download é cancelado");

    const html = fakeClient();
    const h = await call(html.client, "upload_youtube_video", { title: "x", httpsUrl: "https://cdn.exemplo.com.br/pagina.mp4" });
    assert.equal(h.isError, true);
    assert.match(textOf(h), /o conteúdo da URL é "text\/html", não um vídeo/);
    assert.equal(html.calls.starts.length, 0);
    assert.ok(cancelled.some((u) => u.endsWith("/pagina.mp4")), "o download que não é vídeo é cancelado");

    // No limite exato a sessão abre (o corte é > 2 GiB)
    const edge = fakeClient();
    const e = await call(edge.client, "upload_youtube_video", { title: "x", httpsUrl: "https://cdn.exemplo.com.br/limite.mp4" });
    assert.equal(e.isError, undefined, textOf(e));
    assert.equal(edge.calls.starts.length, 1);
    assert.equal(edge.calls.starts[0].size, 2 * 1024 ** 3);
  } finally {
    netDeps.lookup = originalLookup;
    globalThis.fetch = originalFetch;
  }
});

test("upload: description é medida em bytes UTF-8 (limite 5000) antes de abrir sessão", async () => {
  for (const description of ["a".repeat(5001), "é".repeat(2501)]) {
    const { client, calls } = fakeClient();
    const result = await call(client, "upload_youtube_video", { title: "x", description, videoBase64: b64(10) });
    assert.equal(result.isError, true, `${description.length} caracteres`);
    assert.match(textOf(result), /description tem 500[12] bytes; o YouTube aceita até 5000 bytes/);
    assert.equal(calls.starts.length, 0);
  }
  const ok = fakeClient();
  const r = await call(ok.client, "upload_youtube_video", { title: "x", description: "é".repeat(2500), videoBase64: b64(10) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(ok.calls.starts.length, 1, "5000 bytes exatos passam");
});

test("upload resumável: fluxo acima de maxBytes é cortado (sem Content-Length) e a sessão cancelada", async () => {
  // Tudo num pedaço só: recusado antes do primeiro envio
  const small = fakeClient();
  const one = (async function* () { yield Buffer.alloc(20, 1); })();
  await assert.rejects(runResumableUpload(small.client as never, CID, {}, one, undefined, 10), /passa do limite de 10 bytes/);
  assert.equal(small.calls.chunks.length, 0);
  assert.equal(small.calls.cancels, 1);

  // Estoura no meio: o primeiro pedaço sai, o segundo não
  const mid = fakeClient({ granularity: 1 * MIB });
  const stream = (async function* () { yield Buffer.alloc(8 * MIB, 1); yield Buffer.alloc(1 * MIB, 2); })();
  await assert.rejects(runResumableUpload(mid.client as never, CID, {}, stream, undefined, 8 * MIB + 512 * 1024), /passa do limite/);
  assert.deepEqual(mid.calls.chunks, [{ offset: 0, length: 8 * MIB, finalize: false }]);
  assert.equal(mid.calls.cancels, 1);
});

test("upload resumável: X-Goog-Upload-Size-Received fora de [offset, offset+pedaço] não é retomado — cancela", async () => {
  for (const [label, sizeReceived] of [["abaixo do offset", 4 * MIB], ["além do pedaço", 10 * MIB + 1], ["não numérico", Number.NaN]] as const) {
    const { client, calls } = fakeClient({
      granularity: 4 * MIB,
      sendChunk: (_offset, _data, finalize, attempt) => {
        if (attempt === 2) throw new Error("fetch failed");
        return finalize ? { status: "final", body: { resourceName: "r" } } : { status: "active", body: null };
      },
      queryUpload: () => ({ status: "active", sizeReceived }),
    });
    const source = (async function* () { yield Buffer.alloc(10 * MIB, 1); })();
    await assert.rejects(runResumableUpload(client as never, CID, {}, source, 10 * MIB, 2 * 1024 * MIB), /fetch failed/, label);
    assert.deepEqual(calls.chunks, [
      { offset: 0, length: 8 * MIB, finalize: false },
      { offset: 8 * MIB, length: 2 * MIB, finalize: true },
    ], `${label}: nada é reenviado a partir de um offset suspeito`);
    assert.equal(calls.cancels, 1, label);
  }
  // Sessão que o servidor já não considera ativa também não é retomada
  const { client, calls } = fakeClient({
    sendChunk: () => { throw new Error("fetch failed"); },
    queryUpload: () => ({ status: "cancelled", sizeReceived: 0 }),
  });
  await assert.rejects(runResumableUpload(client as never, CID, {}, (async function* () { yield Buffer.alloc(100); })(), 100, 1000), /fetch failed/);
  assert.equal(calls.chunks.length, 1);
  assert.equal(calls.cancels, 1);
});

test("upload resumável: pedaços múltiplos da granularidade, só o último finaliza", async () => {
  const { client, calls } = fakeClient({ granularity: 3 * MIB });
  const source = (async function* () {
    yield Buffer.alloc(4 * MIB, 1);
    yield Buffer.alloc(4 * MIB, 2);
    yield Buffer.alloc(1 * MIB, 3);
  })();
  const result = await runResumableUpload(client as never, CID, { videoTitle: "x" }, source, 9 * MIB, 2 * 1024 * MIB);
  assert.equal(result.resourceName, `customers/${CID}/youTubeVideoUploads/4242`);
  // 8 MiB alvo → múltiplo de 3 MiB = 6 MiB
  assert.deepEqual(calls.chunks, [
    { offset: 0, length: 6 * MIB, finalize: false },
    { offset: 6 * MIB, length: 3 * MIB, finalize: true },
  ]);
});

test("upload resumável: falha transitória retoma do byte que o servidor confirmou", async () => {
  const { client, calls } = fakeClient({
    granularity: 4 * MIB,
    sendChunk: (offset, _data, finalize, attempt) => {
      if (attempt === 2) throw new Error("fetch failed");
      return finalize ? { status: "final", body: { resourceName: "r" } } : { status: "active", body: null };
    },
    queryUpload: () => ({ status: "active", sizeReceived: 8 * MIB + 1234 }),
  });
  const source = (async function* () { yield Buffer.alloc(10 * MIB, 1); })();
  const result = await runResumableUpload(client as never, CID, {}, source, 10 * MIB, 2 * 1024 * MIB);
  assert.equal(result.retries, 1);
  assert.deepEqual(calls.chunks, [
    { offset: 0, length: 8 * MIB, finalize: false },
    { offset: 8 * MIB, length: 2 * MIB, finalize: true },
    { offset: 8 * MIB + 1234, length: 2 * MIB - 1234, finalize: true },
  ]);
});

test("upload resumável: erro definitivo (HTTP 4xx) cancela a sessão e a tool relata", async () => {
  const { client, calls } = fakeClient({
    sendChunk: () => { throw new Error("Google Ads API (envio do pedaço em 0, HTTP 400): vídeo inválido"); },
  });
  const result = await call(client, "upload_youtube_video", { title: "x", videoBase64: b64(100) });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /O upload não terminou: .*vídeo inválido/);
  assert.equal(calls.cancels, 1);
  assert.equal(calls.chunks.length, 1, "4xx não é repetido");
});

test("fixedChunks: último pedaço marcado e sobra menor que o tamanho", async () => {
  const parts: Array<{ size: number; last: boolean }> = [];
  const source = (async function* () { yield Buffer.alloc(5); yield Buffer.alloc(7); })();
  for await (const { data, last } of fixedChunks(source, 4)) parts.push({ size: data.byteLength, last });
  assert.deepEqual(parts, [{ size: 4, last: false }, { size: 4, last: false }, { size: 4, last: true }]);
});

test("SSRF: endereços internos reconhecidos em IPv4, IPv6 e mapeados", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "142.250.78.14", "2800:3f0:4001:80a::200e"]) assert.equal(isPrivateAddress(ip), false, ip);
  assert.match(String(await checkDownloadUrl("https://localhost/a.mp4")), /interno/);
  assert.match(String(await checkDownloadUrl("https://cdn.exemplo.com:8443/a.mp4")), /porta/);
});

// ── GoogleAdsClient real: protocolo X-Goog-Upload ─────────────────────

function realClient(flags: { readOnly?: boolean; dryRun?: boolean } = {}) {
  return new GoogleAdsClient({
    credentials: {
      token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token",
      client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z",
    },
    developerToken: "dev",
    loginCustomerId: CID,
    ...flags,
  });
}

test("client real: start/pedaço/query usam /resumable/upload/v25 e os cabeçalhos X-Goog-Upload", async () => {
  const original = globalThis.fetch;
  const sent: Array<{ url: string; method?: string; headers: Record<string, string>; body?: unknown }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body });
    if (url.includes("/resumable/upload/")) {
      return new Response("", { status: 200, headers: { "x-goog-upload-url": "https://googleads.googleapis.com/upload/abc", "x-goog-upload-chunk-granularity": "262144", "x-goog-upload-status": "active" } });
    }
    if ((init?.headers as Record<string, string>)["X-Goog-Upload-Command"] === "query") {
      return new Response("", { status: 200, headers: { "x-goog-upload-status": "active", "x-goog-upload-size-received": "524288" } });
    }
    return new Response(JSON.stringify({ resourceName: `customers/${CID}/youTubeVideoUploads/1` }), { status: 200, headers: { "x-goog-upload-status": "final" } });
  }) as typeof fetch;
  try {
    const client = realClient();
    const session = await client.startResumableUpload(CID, "youTubeVideoUploads:create", { youTubeVideoUpload: { videoTitle: "x" } }, 1000);
    assert.equal(sent[0].url, `https://googleads.googleapis.com/resumable/upload/v25/customers/${CID}/youTubeVideoUploads:create`);
    assert.equal(sent[0].headers["X-Goog-Upload-Protocol"], "resumable");
    assert.equal(sent[0].headers["X-Goog-Upload-Command"], "start");
    assert.equal(sent[0].headers["X-Goog-Upload-Header-Content-Length"], "1000");
    assert.equal(sent[0].headers["developer-token"], "dev");
    assert.deepEqual(JSON.parse(String(sent[0].body)), { youTubeVideoUpload: { videoTitle: "x" } });
    assert.deepEqual(session, { uploadUrl: "https://googleads.googleapis.com/upload/abc", chunkGranularity: 262144 });

    const done = await client.sendResumableChunk(session.uploadUrl, 0, Buffer.alloc(10), true);
    assert.equal(sent[1].method, "PUT");
    assert.equal(sent[1].headers["X-Goog-Upload-Command"], "upload, finalize");
    assert.equal(sent[1].headers["X-Goog-Upload-Offset"], "0");
    assert.equal(done.body?.resourceName, `customers/${CID}/youTubeVideoUploads/1`);

    const status = await client.queryResumableUpload(session.uploadUrl);
    assert.deepEqual(status, { status: "active", sizeReceived: 524288 });

    await assert.rejects(client.sendResumableChunk("https://evil.example.com/upload", 0, Buffer.alloc(1), true), /fora de googleads/);
    assert.equal(sent.length, 3, "o token não segue para host estranho");
  } finally {
    globalThis.fetch = original;
  }
});

test("client real: dry-run e read-only bloqueiam o upload antes de qualquer requisição", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response("{}"); }) as typeof fetch;
  try {
    await assert.rejects(realClient({ dryRun: true }).startResumableUpload(CID, "youTubeVideoUploads:create", {}, 1), /GOOGLE_ADS_DRY_RUN/);
    await assert.rejects(realClient().withDryRun().sendResumableChunk("https://googleads.googleapis.com/u", 0, Buffer.alloc(1), true), /GOOGLE_ADS_DRY_RUN/);
    await assert.rejects(realClient({ readOnly: true }).startResumableUpload(CID, "youTubeVideoUploads:create", {}, 1), /read-only mode/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

// ══════════════════════════════════════════════════════════════════
// get_youtube_video_uploads / remove_youtube_video_upload
// ══════════════════════════════════════════════════════════════════

const upload = (id: string, state: string, videoId?: string): Row => ({
  youTubeVideoUpload: { resourceName: `customers/${CID}/youTubeVideoUploads/${id}`, videoUploadId: id, state, videoId, videoPrivacy: "UNLISTED" },
});

test("uploads: lista estado, cruza com assets e indica o próximo passo", async () => {
  const { client, calls } = fakeClient({
    rows: {
      you_tube_video_upload: [upload("1", "PROCESSED", "abcdefghijk"), upload("2", "PROCESSED", "zyxwvutsrqp"), upload("3", "UPLOADED")],
      asset: [{ asset: { resourceName: `customers/${CID}/assets/88`, youtubeVideoAsset: { youtubeVideoId: "abcdefghijk" } } }],
    },
  });
  const result = await call(client, "get_youtube_video_uploads", { state: "PROCESSED" });
  assert.match(calls.queries[0], /WHERE you_tube_video_upload\.state = 'PROCESSED'/);
  assert.match(calls.queries[1], /youtube_video_id IN \('abcdefghijk', 'zyxwvutsrqp'\)/);
  const rows = jsonOf(result) as unknown as Row[];
  assert.equal(rows[0].asset_resource_name, `customers/${CID}/assets/88`);
  assert.match(String(rows[1].next_step), /upload_video_asset/);
  assert.match(String(rows[2].next_step), /processando/);

  const bad = fakeClient();
  assert.equal((await call(bad.client, "get_youtube_video_uploads", { videoUploadId: "1 OR 1=1" })).isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("remover upload: sem confirm só prévia; com confirm chama youTubeVideoUploads:remove", async () => {
  const rows = { you_tube_video_upload: [upload("7", "PROCESSED", "abcdefghijk")] };
  const preview = fakeClient({ rows });
  const p = await call(preview.client, "remove_youtube_video_upload", { videoUploadIds: ["7"] });
  assert.equal(p.isError, true);
  assert.match(textOf(p), /Prévia — 1 vídeo\(s\) seriam APAGADOS/);
  assert.equal(writesOf(preview.calls), 0);

  const real = fakeClient({ rows, action: (_a, body) => ({ resourceNames: body.resourceNames }) });
  const r = await call(real.client, "remove_youtube_video_upload", { videoUploadIds: [`customers/${CID}/youTubeVideoUploads/7`], confirm: true });
  assert.equal(r.isError, false, textOf(r));
  assert.deepEqual(real.calls.writes, [{
    method: "customerWriteAction", action: "youTubeVideoUploads:remove",
    body: { resourceNames: [`customers/${CID}/youTubeVideoUploads/7`] },
  }]);
  assert.match(textOf(r), /1\/1 upload\(s\) removido/);
});

test("remover upload: inexistente, outra conta e dry-run não gravam", async () => {
  const missing = fakeClient({ rows: { you_tube_video_upload: [] } });
  const m = await call(missing.client, "remove_youtube_video_upload", { videoUploadIds: ["7"], confirm: true });
  assert.match(textOf(m), /não encontrado/);
  assert.equal(writesOf(missing.calls), 0);

  const foreign = fakeClient();
  const f = await call(foreign.client, "remove_youtube_video_upload", { videoUploadIds: ["customers/9999999999/youTubeVideoUploads/7"], confirm: true });
  assert.match(textOf(f), /pertence à conta 9999999999/);
  assert.equal(foreign.calls.queries.length, 0);

  const dry = fakeClient({ rows: { you_tube_video_upload: [upload("7", "PROCESSED")] } });
  const d = await call(dry.client, "remove_youtube_video_upload", { videoUploadIds: ["7"], confirm: true, validateOnly: true });
  assert.match(textOf(d), /DRY-RUN .*nada foi removido/);
  assert.equal(writesOf(dry.calls), 0);

  const apiError = fakeClient({ rows: { you_tube_video_upload: [upload("7", "PROCESSED")] }, action: () => { throw new Error("Google Ads API: denied"); } });
  const e = await call(apiError.client, "remove_youtube_video_upload", { videoUploadIds: ["7"], confirm: true });
  assert.equal(e.isError, true);
  assert.match(textOf(e), /A API recusou a remoção: Google Ads API: denied/);
});

// ══════════════════════════════════════════════════════════════════
// create_image_ad
// ══════════════════════════════════════════════════════════════════

const banner = (id: string, w: number, h: number, bytes = 40_000, mime = "IMAGE_PNG") => image(id, w, h, { fileSize: String(bytes), mimeType: mime });

test("anúncio de imagem: banner padrão vira IMAGE_AD pausado com o asset", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById([banner("301", 300, 250)]) } });
  const result = await call(client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "Banner 300x250" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(calls.writes[0].operations, [{
    create: {
      adGroup: `customers/${CID}/adGroups/555`,
      status: "PAUSED",
      ad: { name: "Banner 300x250", finalUrls: ["https://loja.com.br"], imageAd: { imageAsset: { asset: `customers/${CID}/assets/301` } } },
    },
  }]);
  const dupQuery = calls.queries.find((q) => q.includes("FROM ad_group_ad"))!;
  assert.match(dupQuery, /ad_group_ad\.ad\.image_ad\.image_asset\.asset = 'customers\/1234567890\/assets\/301'/);
  assert.match(textOf(result), /Inline rectangle/);
});

test("anúncio de imagem: tamanho fora do padrão, arquivo grande, formato e campanha errada são recusados", async () => {
  const cases: Array<[Row[], Row, RegExp]> = [
    [[banner("301", 1200, 628)], displayGroup(), /1200x628 não é tamanho padrão/],
    [[banner("301", 300, 250, 200 * 1024)], displayGroup(), /o limite é 150 KB/],
    [[banner("301", 300, 250, 1000, "IMAGE_JPEG")], { ...displayGroup(), campaign: { name: "Busca", advertisingChannelType: "SEARCH" } }, /campanha SEARCH/],
    [[{ asset: { id: "301", type: "YOUTUBE_VIDEO" } }], displayGroup(), /não IMAGE/],
    [[banner("301", 300, 250, 1000, "FLASH")], displayGroup(), /formato FLASH/],
  ];
  for (const [assets, group, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: [group], asset: assetsById(assets) } });
    const result = await call(client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "B" });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(writesOf(calls), 0);
  }
  const foreign = fakeClient();
  const f = await call(foreign.client, "create_image_ad", { adGroupId: "555", imageAsset: "customers/9999999999/assets/1", finalUrl: "https://a.com", name: "B" });
  assert.match(textOf(f), /pertence à conta/);
  assert.equal(foreign.calls.queries.length, 0);
});

test("anúncio de imagem: grupo removido ou de tipo diferente de DISPLAY_STANDARD é recusado antes de ler a imagem", async () => {
  const cases: Array<[Row, RegExp]> = [
    [displayGroup({ status: "REMOVED" }), /Grupo 555 \("Display - Remarketing"\) está removido\. Nada foi gravado/],
    [displayGroup({ type: "UNKNOWN" }), /é do tipo UNKNOWN; anúncio de imagem vai em grupo DISPLAY_STANDARD/],
    [displayGroup({ type: "VIDEO_RESPONSIVE" }), /é do tipo VIDEO_RESPONSIVE/],
  ];
  for (const [group, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: [group], asset: assetsById([banner("301", 300, 250)]) } });
    const result = await call(client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "B" });
    assert.equal(result.isError, true, JSON.stringify(group));
    assert.match(textOf(result), pattern);
    assert.equal(writesOf(calls), 0);
    assert.equal(calls.queries.length, 1, "para no grupo, sem consultar asset nem duplicata");
  }
});

test("anúncio de imagem: mesmo banner e URL no grupo é no-op; dry-run e erro da API relatados", async () => {
  const existing = { adGroupAd: { status: "PAUSED", ad: { id: "900", finalUrls: ["https://loja.com.br"] } } };
  const dup = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById([banner("301", 728, 90)]), ad_group_ad: [existing] } });
  const d = await call(dup.client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "B" });
  assert.match(textOf(d), /Nenhuma escrita foi enviada/);
  assert.equal(writesOf(dup.calls), 0);

  const dry = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById([banner("301", 728, 90)]) } });
  const r = await call(dry.client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "B", validateOnly: true });
  assert.match(textOf(r), /DRY-RUN .*nada foi gravado/);

  const failing = fakeClient({
    rows: { ad_group: [displayGroup()], asset: assetsById([banner("301", 728, 90)]) },
    mutateAdGroupAds: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The image is not valid."); },
  });
  const e = await call(failing.client, "create_image_ad", { adGroupId: "555", imageAsset: "301", finalUrl: "https://loja.com.br", name: "B" });
  assert.equal(e.isError, true);
  assert.match(textOf(e), /A API recusou o anúncio de imagem: .*image is not valid/);
});

// ══════════════════════════════════════════════════════════════════
// Vínculos de vídeo do YouTube (DataLinkService)
// ══════════════════════════════════════════════════════════════════

const link = (status: string, videoId = "abcdefghijk"): Row => ({
  dataLink: {
    resourceName: `customers/${CID}/dataLinks/11~22`, productLinkId: "11", dataLinkId: "22", type: "VIDEO", status,
    youtubeVideo: { videoId, channelId: "UCK8sQmJBp8GCxrOtXWBpyEA" },
  },
});

test("vínculos: lista só VIDEO, filtra status e orienta a ação", async () => {
  const { client, calls } = fakeClient({ rows: { data_link: [link("PENDING_APPROVAL")] } });
  const result = await call(client, "list_youtube_video_links", { status: "PENDING_APPROVAL" });
  assert.match(calls.queries[0], /WHERE data_link\.type = 'VIDEO' AND data_link\.status = 'PENDING_APPROVAL'/);
  const rows = jsonOf(result) as unknown as Row[];
  assert.equal(rows[0].video_url, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.match(String(rows[0].next_step), /ACCEPT/);
});

test("pedido de vínculo: extrai o ID da URL, exige confirm e envia dataLinks:create", async () => {
  assert.equal(parseYouTubeVideoId("https://youtu.be/abcdefghijk?t=3"), "abcdefghijk");
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/shorts/abcdefghijk"), "abcdefghijk");
  assert.equal(parseYouTubeVideoId("https://www.youtube.com/watch?v=abcdefghijk&t=2s"), "abcdefghijk");
  assert.equal(parseYouTubeVideoId("https://vimeo.com/123"), null);

  const preview = fakeClient();
  const p = await call(preview.client, "request_youtube_video_link", { video: "https://youtu.be/abcdefghijk" });
  assert.equal(p.isError, true);
  assert.match(textOf(p), /compartilha o nome e o ID desta conta/);
  assert.equal(writesOf(preview.calls), 0);
  assert.match(preview.calls.queries[0], /data_link\.youtube_video\.video_id = 'abcdefghijk'/);

  const real = fakeClient({ action: () => ({ resourceName: `customers/${CID}/dataLinks/11~22` }) });
  const r = await call(real.client, "request_youtube_video_link", {
    video: "abcdefghijk", channelId: "UCK8sQmJBp8GCxrOtXWBpyEA", brandChannelId: "UCaaaaaaaaaaaaaaaaaaaaaa", confirm: true,
  });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(real.calls.writes, [{
    method: "customerWriteAction", action: "dataLinks:create",
    body: { dataLink: { youtubeVideo: { videoId: "abcdefghijk", channelId: "UCK8sQmJBp8GCxrOtXWBpyEA" }, youtubeLinkMetadata: { brandChannelId: "UCaaaaaaaaaaaaaaaaaaaaaa" } } },
  }]);
});

test("pedido de vínculo: vínculo ativo é no-op; dry-run e erro de permissão não gravam", async () => {
  const active = fakeClient({ rows: { data_link: [link("REQUESTED")] } });
  const a = await call(active.client, "request_youtube_video_link", { video: "abcdefghijk", confirm: true });
  assert.match(textOf(a), /já tem vínculo REQUESTED/);
  assert.equal(writesOf(active.calls), 0);

  const dry = fakeClient({ rows: { data_link: [link("REJECTED")] } });
  const d = await call(dry.client, "request_youtube_video_link", { video: "abcdefghijk", confirm: true, validateOnly: true });
  assert.match(textOf(d), /DRY-RUN .*nada foi enviado/);
  assert.equal(writesOf(dry.calls), 0);

  const denied = fakeClient({ action: () => { throw new Error("Google Ads API: The caller does not have permission — PERMISSION_DENIED"); } });
  const e = await call(denied.client, "request_youtube_video_link", { video: "abcdefghijk", confirm: true });
  assert.equal(e.isError, true);
  assert.match(textOf(e), /DataLinkError\.PERMISSION_DENIED/);

  const bad = fakeClient();
  const b = await call(bad.client, "request_youtube_video_link", { video: "curto", confirm: true });
  assert.equal(b.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("responder vínculo: ACCEPT atualiza para ENABLED; REMOVE usa dataLinks:remove com confirm", async () => {
  const accept = fakeClient({ rows: { data_link: [link("PENDING_APPROVAL")] }, action: () => ({ resourceName: `customers/${CID}/dataLinks/11~22` }) });
  const a = await call(accept.client, "respond_youtube_video_link", { link: "11~22", action: "ACCEPT" });
  assert.equal(a.isError, undefined, textOf(a));
  assert.match(accept.calls.queries[0], /data_link\.product_link_id = 11 AND data_link\.data_link_id = 22/);
  assert.deepEqual(accept.calls.writes, [{
    method: "customerWriteAction", action: "dataLinks:update",
    body: { resourceName: `customers/${CID}/dataLinks/11~22`, dataLinkStatus: "ENABLED" },
  }]);

  const removeNoConfirm = fakeClient({ rows: { data_link: [link("ENABLED")] } });
  const p = await call(removeNoConfirm.client, "respond_youtube_video_link", { link: `customers/${CID}/dataLinks/11~22`, action: "REMOVE" });
  assert.match(textOf(p), /Prévia/);
  assert.equal(writesOf(removeNoConfirm.calls), 0);

  const remove = fakeClient({ rows: { data_link: [link("ENABLED")] }, action: () => ({ resourceName: `customers/${CID}/dataLinks/11~22` }) });
  await call(remove.client, "respond_youtube_video_link", { link: "11~22", action: "REMOVE", confirm: true });
  assert.deepEqual(remove.calls.writes, [{
    method: "customerWriteAction", action: "dataLinks:remove", body: { resourceName: `customers/${CID}/dataLinks/11~22` },
  }]);

  const revoke = fakeClient({ rows: { data_link: [link("REQUESTED")] }, action: () => ({ resourceName: "x" }) });
  await call(revoke.client, "respond_youtube_video_link", { link: "11~22", action: "REVOKE", confirm: true });
  assert.equal((revoke.calls.writes[0].body as Row).dataLinkStatus, "REVOKED");
});

test("responder vínculo: REJECT e REVOKE sem confirm só mostram a prévia; com confirm mandam o status certo", async () => {
  for (const [action, from, to] of [["REJECT", "PENDING_APPROVAL", "REJECTED"], ["REVOKE", "REQUESTED", "REVOKED"]] as const) {
    const preview = fakeClient({ rows: { data_link: [link(from)] }, action: () => ({ resourceName: `customers/${CID}/dataLinks/11~22` }) });
    const p = await call(preview.client, "respond_youtube_video_link", { link: "11~22", action });
    assert.equal(p.isError, true, action);
    assert.match(textOf(p), /^Prévia — .*não tem volta\. Nada foi alterado/, action);
    assert.match(textOf(p), new RegExp(`status ${from} → ${to}`), action);
    assert.equal(writesOf(preview.calls), 0, `${action} sem confirm não pode gravar`);

    const notTrue = fakeClient({ rows: { data_link: [link(from)] } });
    const n = await call(notTrue.client, "respond_youtube_video_link", { link: "11~22", action, confirm: false });
    assert.match(textOf(n), /^Prévia/, `${action} com confirm: false`);
    assert.equal(writesOf(notTrue.calls), 0);

    const applied = fakeClient({ rows: { data_link: [link(from)] }, action: () => ({ resourceName: `customers/${CID}/dataLinks/11~22` }) });
    const a = await call(applied.client, "respond_youtube_video_link", { link: "11~22", action, confirm: true });
    assert.equal(a.isError, undefined, textOf(a));
    assert.deepEqual(applied.calls.writes, [{
      method: "customerWriteAction", action: "dataLinks:update",
      body: { resourceName: `customers/${CID}/dataLinks/11~22`, dataLinkStatus: to },
    }]);
  }
});

test("responder vínculo: status incompatível, já no alvo, inexistente e outra conta não gravam", async () => {
  const wrong = fakeClient({ rows: { data_link: [link("REQUESTED")] } });
  const w = await call(wrong.client, "respond_youtube_video_link", { link: "11~22", action: "ACCEPT" });
  assert.match(textOf(w), /só vale a partir de PENDING_APPROVAL/);
  assert.equal(writesOf(wrong.calls), 0);

  const same = fakeClient({ rows: { data_link: [link("ENABLED")] } });
  const s = await call(same.client, "respond_youtube_video_link", { link: "11~22", action: "ACCEPT" });
  assert.match(textOf(s), /já está ENABLED/);
  assert.equal(writesOf(same.calls), 0);

  const missing = fakeClient({ rows: { data_link: [] } });
  assert.match(textOf(await call(missing.client, "respond_youtube_video_link", { link: "11~22", action: "ACCEPT" })), /não encontrado/);

  const foreign = fakeClient();
  const f = await call(foreign.client, "respond_youtube_video_link", { link: "customers/9999999999/dataLinks/11~22", action: "ACCEPT" });
  assert.match(textOf(f), /pertence à conta 9999999999/);
  assert.equal(foreign.calls.queries.length, 0);
  assert.ok("error" in parseDataLinkRef("11-22", CID), "11-22 não é referência de vínculo válida");

  const dry = fakeClient({ rows: { data_link: [link("PENDING_APPROVAL")] } });
  const d = await call(dry.client, "respond_youtube_video_link", { link: "11~22", action: "ACCEPT", validateOnly: true });
  assert.match(textOf(d), /DRY-RUN .*nada foi alterado/);
  assert.equal(writesOf(dry.calls), 0);
});

// ══════════════════════════════════════════════════════════════════
// create_responsive_display_ad (item 12)
// ══════════════════════════════════════════════════════════════════

const rdaBase = {
  adGroupId: "555", finalUrl: "https://loja.com.br", headlines: ["Tênis em oferta"], longHeadline: "Tênis de corrida com frete grátis",
  descriptions: ["Compre online"], businessName: "Loja X", marketingImageAssets: ["101"], squareMarketingImageAssets: ["102"],
};
const rdaAssets = [image("101", 1200, 628), image("102", 1200, 1200), image("201", 1200, 1200), image("202", 1200, 300), image("203", 800, 600)];

function rdaOf(calls: { writes: Array<{ operations?: Row[] }> }): Row {
  return ((calls.writes[0].operations![0].create as Row).ad as Row).responsiveDisplayAd as Row;
}

test("RDA: logo quadrado 1200x1200 vai para square_logo_images, 4:1 para logo_images (logoAssets legado)", async () => {
  const { client, calls } = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById(rdaAssets) } });
  const result = await call(client, "create_responsive_display_ad", { ...rdaBase, logoAssets: ["201", "202"] });
  assert.equal(result.isError, undefined, textOf(result));
  const rda = rdaOf(calls);
  assert.deepEqual(rda.squareLogoImages, [{ asset: `customers/${CID}/assets/201` }]);
  assert.deepEqual(rda.logoImages, [{ asset: `customers/${CID}/assets/202` }]);
  assert.deepEqual(rda.marketingImages, [{ asset: `customers/${CID}/assets/101` }]);
  assert.equal((calls.writes[0].operations![0].create as Row).status, "PAUSED");
});

test("RDA: logo é opcional; campos novos (vídeo, CTA, cores, formato, promo, control_spec) vão no payload", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [displayGroup()],
      asset: (query: string) => query.includes("YOUTUBE_VIDEO")
        ? [{ asset: { resourceName: `customers/${CID}/assets/900`, youtubeVideoAsset: { youtubeVideoId: "abcdefghijk" } } }]
        : assetsById(rdaAssets)(query),
    },
  });
  const result = await call(client, "create_responsive_display_ad", {
    ...rdaBase, youtubeVideoIds: ["abcdefghijk"], callToAction: "Compre agora", mainColor: "#112233", accentColor: "#FFFFFF",
    allowFlexibleColor: false, formatSetting: "NON_NATIVE", promoText: "Frete grátis", pricePrefix: "a partir de", enableAssetEnhancements: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const rda = rdaOf(calls);
  assert.equal(rda.logoImages, undefined);
  assert.equal(rda.squareLogoImages, undefined);
  assert.deepEqual(rda.youtubeVideos, [{ asset: `customers/${CID}/assets/900` }]);
  assert.equal(rda.callToActionText, "Compre agora");
  assert.equal(rda.mainColor, "#112233");
  assert.equal(rda.accentColor, "#FFFFFF");
  assert.equal(rda.allowFlexibleColor, false);
  assert.equal(rda.formatSetting, "NON_NATIVE");
  assert.equal(rda.promoText, "Frete grátis");
  assert.equal(rda.pricePrefix, "a partir de");
  assert.deepEqual(rda.controlSpec, { enableAssetEnhancements: true });
  assert.equal(rda.businessName, "Loja X");
});

test("RDA: proporção errada, cores incompletas, NATIVE sem cor flexível e vídeo sem asset são recusados sem gravar", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ logoAssets: ["203"] }, /logo 203 tem 800x600/],
    [{ marketingImageAssets: ["102"] }, /102 \(1200x1200\) não serve como paisagem 1\.91:1/],
    [{ squareLogoAssets: ["202"] }, /202 \(1200x300\) não serve como logo 1:1/],
    [{ mainColor: "#112233" }, /mainColor e accentColor vão juntas/],
    [{ allowFlexibleColor: false }, /allowFlexibleColor: false exige/],
    [{ formatSetting: "NATIVE", allowFlexibleColor: false, mainColor: "#000000", accentColor: "#FFFFFF" }, /NATIVE não aceita/],
    [{ headlines: ["x".repeat(31)] }, /máx\. 30/],
    [{ squareMarketingImageAssets: [] }, /ao menos uma imagem quadrada/],
    [{ youtubeVideoIds: ["abcdefghijk"] }, /sem asset na conta/],
  ];
  for (const [args, pattern] of cases) {
    const { client, calls } = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById(rdaAssets) } });
    const result = await call(client, "create_responsive_display_ad", { ...rdaBase, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern, JSON.stringify(args));
    assert.equal(writesOf(calls), 0);
  }
});

const range = (prefix: number, count: number) => Array.from({ length: count }, (_, i) => String(prefix + i));
const videoIdList = (count: number) => Array.from({ length: count }, (_, i) => `video${String(i).padStart(6, "0")}`);

test("RDA: limites de 15 imagens de marketing e 5 logos (somados) são conferidos antes de gravar", async () => {
  const pool = [
    ...rdaAssets,
    ...range(300, 8).map((id) => image(id, 1200, 628)),
    ...range(320, 8).map((id) => image(id, 1200, 1200)),
    ...range(400, 3).map((id) => image(id, 1200, 300)),
    ...range(420, 3).map((id) => image(id, 1200, 1200)),
  ];
  const run = async (args: Row) => {
    const { client, calls } = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById(pool) } });
    return { result: await call(client, "create_responsive_display_ad", { ...rdaBase, ...args }), calls };
  };

  const tooMany = await run({ marketingImageAssets: range(300, 8), squareMarketingImageAssets: range(320, 8) });
  assert.equal(tooMany.result.isError, true);
  assert.match(textOf(tooMany.result), /imagens de marketing \(paisagem \+ quadradas\): no máximo 15, recebidas 16/);
  assert.equal(writesOf(tooMany.calls), 0);

  const fifteen = await run({ marketingImageAssets: range(300, 8), squareMarketingImageAssets: range(320, 7) });
  assert.equal(fifteen.result.isError, undefined, textOf(fifteen.result));
  assert.equal((rdaOf(fifteen.calls).marketingImages as Row[]).length + (rdaOf(fifteen.calls).squareMarketingImages as Row[]).length, 15);

  const sixLogos = await run({ landscapeLogoAssets: range(400, 3), squareLogoAssets: range(420, 3) });
  assert.equal(sixLogos.result.isError, true);
  assert.match(textOf(sixLogos.result), /logos \(4:1 \+ 1:1\): no máximo 5, recebidos 6/);
  assert.equal(writesOf(sixLogos.calls), 0);

  // logoAssets legado entra na mesma conta depois de roteado
  const legacy = await run({ landscapeLogoAssets: range(400, 3), logoAssets: range(420, 3) });
  assert.match(textOf(legacy.result), /no máximo 5, recebidos 6/);
  assert.equal(writesOf(legacy.calls), 0);

  const fiveLogos = await run({ landscapeLogoAssets: range(400, 3), squareLogoAssets: range(420, 2) });
  assert.equal(fiveLogos.result.isError, undefined, textOf(fiveLogos.result));
  assert.equal((rdaOf(fiveLogos.calls).logoImages as Row[]).length, 3);
  assert.equal((rdaOf(fiveLogos.calls).squareLogoImages as Row[]).length, 2);
});

test("RDA: mais de 5 youtubeVideoIds é recusado sem consultar a API; 5 passam", async () => {
  const six = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById(rdaAssets) } });
  const r = await call(six.client, "create_responsive_display_ad", { ...rdaBase, youtubeVideoIds: videoIdList(6) });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /youtubeVideoIds: no máximo 5 \(recebidos 6\)/);
  assert.equal(six.calls.queries.length + writesOf(six.calls), 0);

  const ids = videoIdList(5);
  const five = fakeClient({
    rows: {
      ad_group: [displayGroup()],
      asset: (query: string) => query.includes("YOUTUBE_VIDEO")
        ? ids.map((id, i) => ({ asset: { resourceName: `customers/${CID}/assets/90${i}`, youtubeVideoAsset: { youtubeVideoId: id } } }))
        : assetsById(rdaAssets)(query),
    },
  });
  const ok = await call(five.client, "create_responsive_display_ad", { ...rdaBase, youtubeVideoIds: ids });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal((rdaOf(five.calls).youtubeVideos as Row[]).length, 5);
});

test("RDA: asset que não é IMAGE (ex.: YOUTUBE_VIDEO) é recusado em qualquer campo de imagem", async () => {
  const video = { asset: { id: "900", name: "vídeo", type: "YOUTUBE_VIDEO", resourceName: `customers/${CID}/assets/900` } };
  for (const args of [{ squareLogoAssets: ["900"] }, { landscapeLogoAssets: ["900"] }, { marketingImageAssets: ["101", "900"] }]) {
    const { client, calls } = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById([...rdaAssets, video]) } });
    const result = await call(client, "create_responsive_display_ad", { ...rdaBase, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), /asset 900 \("vídeo"\) é YOUTUBE_VIDEO, não IMAGE/, JSON.stringify(args));
    assert.equal(writesOf(calls), 0);
  }
});

test("RDA: grupo fora de DISPLAY recusado; dry-run relata validação; erro da API mapeado", async () => {
  const search = fakeClient({ rows: { ad_group: [{ ...displayGroup(), campaign: { name: "Busca", advertisingChannelType: "SEARCH" } }], asset: assetsById(rdaAssets) } });
  const s = await call(search.client, "create_responsive_display_ad", rdaBase);
  assert.match(textOf(s), /campanha SEARCH/);
  assert.equal(writesOf(search.calls), 0);

  const dry = fakeClient({ rows: { ad_group: [displayGroup()], asset: assetsById(rdaAssets) } });
  const d = await call(dry.client, "create_responsive_display_ad", { ...rdaBase, validateOnly: true });
  assert.equal(dry.calls.writes.length, 1, "em validateOnly a mutação vai com validate_only");
  assert.match(textOf(d), /DRY-RUN .*nada foi gravado/);

  const failing = fakeClient({
    rows: { ad_group: [displayGroup()], asset: assetsById(rdaAssets) },
    mutateAdGroupAds: () => { throw new Error("Google Ads API: invalid — ASPECT_RATIO_NOT_ALLOWED"); },
  });
  const e = await call(failing.client, "create_responsive_display_ad", rdaBase);
  assert.equal(e.isError, true);
  assert.match(textOf(e), /A API recusou o anúncio responsivo de Display: .*ASPECT_RATIO_NOT_ALLOWED/);
});

// ══════════════════════════════════════════════════════════════════
// create_video_campaign / create_video_ad (item 26)
// ══════════════════════════════════════════════════════════════════

test("create_video_campaign: recusa sempre, aponta Demand Gen e não tem código morto de criação", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_video_campaign", { name: "YT" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /create_demand_gen_campaign/);
  assert.equal(calls.writes.length + calls.queries.length, 0);
  const source = toolImplementations().get("create_video_campaign")!;
  assert.doesNotMatch(source, /mutateCampaignBudgets|mutateCampaigns|Supports in-stream/);
  assert.match(source, /NÃO CRIA CAMPANHA/);
});

const videoGroup = (channel: string, type = "VIDEO_RESPONSIVE"): Row => ({
  adGroup: { id: "700", name: "Vídeo", status: "ENABLED", type },
  campaign: { id: "70", name: "Campanha", status: "ENABLED", advertisingChannelType: channel },
});
const videoAdArgs = {
  adGroupId: "700", youtubeVideoId: "abcdefghijk", finalUrl: "https://loja.com.br", headline: "Oferta",
  description: "Compre já", callToAction: "Comprar", logoAssetId: "201", businessName: "Loja X",
};

test("create_video_ad: grupo de Demand Gen ou de outro tipo é recusado antes de criar qualquer asset", async () => {
  for (const group of [videoGroup("DEMAND_GEN", "UNSPECIFIED"), videoGroup("DISPLAY", "DISPLAY_STANDARD"), videoGroup("VIDEO", "VIDEO_BUMPER")]) {
    const { client, calls } = fakeClient({ rows: { ad_group: [group], asset: assetsById(rdaAssets) } });
    const result = await call(client, "create_video_ad", videoAdArgs);
    assert.equal(result.isError, true);
    assert.equal(writesOf(calls), 0);
  }
  const dg = fakeClient({ rows: { ad_group: [videoGroup("DEMAND_GEN")] } });
  assert.match(textOf(await call(dg.client, "create_video_ad", videoAdArgs)), /DEMAND_GEN_VIDEO_RESPONSIVE_AD/);

  const badLogo = fakeClient({ rows: { ad_group: [videoGroup("VIDEO")], asset: assetsById(rdaAssets) } });
  const l = await call(badLogo.client, "create_video_ad", { ...videoAdArgs, logoAssetId: "202" });
  assert.match(textOf(l), /precisa ser 1:1/);
  assert.equal(writesOf(badLogo.calls), 0);
});

test("create_video_ad: MUTATE_REQUIRES_RESERVATION vira explicação clara com a alternativa Demand Gen", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [videoGroup("VIDEO")],
      asset: (query: string) => query.includes("YOUTUBE_VIDEO") ? [] : assetsById(rdaAssets)(query),
    },
    mutateAdGroupAds: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Cannot modify the video campaign without reservation."); },
  });
  const result = await call(client, "create_video_ad", videoAdArgs);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /MUTATE_REQUIRES_RESERVATION/);
  assert.match(textOf(result), /Demand Gen/);
  assert.match(textOf(result), /continua na biblioteca/, "avisa que o asset do vídeo criado antes ficou");
  assert.deepEqual(calls.writes.map((w) => w.method), ["mutateAssets", "mutateAdGroupAds"]);
});

test("create_video_ad: com asset existente só cria o anúncio, com o logo e o vídeo certos", async () => {
  const { client, calls } = fakeClient({
    rows: {
      ad_group: [videoGroup("VIDEO")],
      asset: (query: string) => query.includes("YOUTUBE_VIDEO")
        ? [{ asset: { resourceName: `customers/${CID}/assets/900` } }]
        : assetsById(rdaAssets)(query),
    },
  });
  const result = await call(client, "create_video_ad", videoAdArgs);
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.writes.map((w) => w.method), ["mutateAdGroupAds"]);
  const info = (((calls.writes[0].operations![0].create as Row).ad as Row).videoResponsiveAd) as Row;
  assert.deepEqual(info.videos, [{ asset: `customers/${CID}/assets/900` }]);
  assert.deepEqual(info.logoImages, [{ asset: `customers/${CID}/assets/201` }]);
});

test("create_video_ad: logo que não é IMAGE é recusado antes de criar o asset do vídeo", async () => {
  const video = { asset: { id: "900", name: "vídeo", type: "YOUTUBE_VIDEO", resourceName: `customers/${CID}/assets/900` } };
  const { client, calls } = fakeClient({ rows: { ad_group: [videoGroup("VIDEO")], asset: assetsById([...rdaAssets, video]) } });
  const result = await call(client, "create_video_ad", { ...videoAdArgs, logoAssetId: "900" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Logo: asset 900 é YOUTUBE_VIDEO, não IMAGE\. Nada foi gravado/);
  assert.equal(writesOf(calls), 0, "nem o asset do vídeo nem o anúncio");
  assert.ok(!calls.queries.some((q) => q.includes("youtube_video_asset.youtube_video_id")), "para antes de procurar o vídeo");
});

// ══════════════════════════════════════════════════════════════════
// Classificação e guarda de conta
// ══════════════════════════════════════════════════════════════════

test("tools novas: leitura sem validateOnly, escrita com; todas checam a conta", async () => {
  const configs = new Map<string, Row>();
  registerGoogleAdsTools({ registerTool: (n: string, c: Row) => configs.set(n, c) } as never, () => ({}) as never, [], false);
  for (const name of ["get_video_performance", "get_youtube_video_uploads", "list_youtube_video_links"]) {
    assert.ok(!("validateOnly" in (configs.get(name)!.inputSchema as Row)), name);
  }
  for (const name of ["upload_youtube_video", "remove_youtube_video_upload", "create_image_ad", "request_youtube_video_link", "respond_youtube_video_link"]) {
    assert.ok("validateOnly" in (configs.get(name)!.inputSchema as Row), name);
  }
  const slices = toolImplementations();
  for (const name of ["upload_youtube_video", "remove_youtube_video_upload", "create_image_ad", "request_youtube_video_link", "respond_youtube_video_link"]) {
    assert.match(slices.get(name)!, /checkCustomerAccess\(/, name);
  }
  for (const tool of ["create_image_ad", "remove_youtube_video_upload", "respond_youtube_video_link"]) {
    const { client, calls } = fakeClient();
    const denied = await call(client, tool, { adGroupId: "1", imageAsset: "1", finalUrl: "https://a.com", name: "n", videoUploadIds: ["1"], link: "1~2", action: "ACCEPT", confirm: true }, { allowed: ["9999999999"], hosted: true });
    assert.match(textOf(denied), /Access denied/);
    assert.equal(calls.queries.length + calls.writes.length, 0);
  }
});
