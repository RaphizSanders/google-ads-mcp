/**
 * Lote reports: get_placement_report, get_landing_page_performance, get_network_breakdown e
 * get_mcc_performance_summary.
 *
 * O que estes testes fixam:
 * - toda query passa pelas regras de GAQL da v25 (tests/gaql-rules.ts) — inclusive os recursos
 *   de segmentação (campaign em PMax/landing_page_view) e segmentos no WHERE;
 * - entrada inválida é recusada antes de qualquer chamada;
 * - agregação, linha "Other", candidatos a exclusão no formato de exclude_placements, cruzamento
 *   com DESTINATION_NOT_WORKING, alertas por rede e totais do MCC separados por moeda;
 * - allowlist por conta (inclusive em cada conta do MCC) e nenhuma escrita, nunca.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createReadOnlyToolServer, GOOGLE_ADS_READ_TOOL_NAMES, GOOGLE_ADS_WRITE_TOOL_NAMES } from "../src/read-only.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { localIsoDate } from "../src/tool-kit.js";
import { assertGaqlRules } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const REPORT_TOOLS = ["get_placement_report", "get_landing_page_performance", "get_network_breakdown", "get_mcc_performance_summary"];

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  /** Linhas por recurso do FROM; função recebe a query e a conta. */
  rows?: Record<string, Row[] | ((query: string, customerId: string) => Row[])>;
  children?: Row[];
  /** Mensagem de erro para lançar nesta query/conta (simula a API recusando). */
  failOn?: (query: string, customerId: string) => string | undefined;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as Array<{ customerId: string; query: string }>,
    writes: [] as string[],
    listChildren: [] as Array<string | undefined>,
  };
  const base: Row = {
    isDryRun: false,
    async searchStream(customerId: string, query: string): Promise<Row[]> {
      calls.queries.push({ customerId, query });
      assertGaqlRules(query);
      const message = opts.failOn?.(query, customerId);
      if (message) throw new Error(message);
      const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
      const source = opts.rows?.[from];
      return typeof source === "function" ? source(query, customerId) : source ?? [];
    },
    async listChildAccounts(managerId?: string): Promise<Row[]> {
      calls.listChildren.push(managerId);
      return opts.children ?? [];
    },
  };
  base.withDryRun = () => client;
  // Relatório nunca grava: qualquer método de escrita fica registrado e falha
  const client: Row = new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (typeof property === "string" && /mutate|Action|updateStatus/i.test(property)) {
        return async () => {
          calls.writes.push(property);
          throw new Error("escrita chamada num relatório");
        };
      }
      return undefined;
    },
  });
  return { client, calls };
}

function register(client: unknown, opts: { allowed?: string[]; hosted?: boolean; readOnly?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { inputSchema?: Record<string, unknown> }>();
  const fakeMcp = {
    registerTool(name: string, config: { inputSchema?: Record<string, unknown> }, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  const target = opts.readOnly ? createReadOnlyToolServer(fakeMcp, true) : fakeMcp;
  registerGoogleAdsTools(target as never, () => client as never, opts.allowed ?? [], opts.hosted ?? false);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row, opts?: { allowed?: string[]; hosted?: boolean }) =>
  register(client, opts).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function jsonOf(result: Result): Row {
  const body = textOf(result);
  return JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) as Row;
}

const oneLine = (query: string) => query.replace(/\s+/g, " ").trim();
const queriesFrom = (calls: { queries: Array<{ query: string }> }, resource: string) =>
  calls.queries.map((q) => oneLine(q.query)).filter((q) => new RegExp(`\\bFROM ${resource}\\b`).test(q));

// ── Dados de posicionamento ───────────────────────────────────────────

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv"; // UC + 22

function groupRow(placement: string, displayName: string, type: string, metrics: Row, extra: Row = {}): Row {
  return {
    groupPlacementView: { placement, displayName, placementType: type, targetUrl: extra.targetUrl ?? "" },
    campaign: { id: extra.campaignId ?? "10", name: "Display Remarketing", advertisingChannelType: "DISPLAY" },
    adGroup: { id: extra.adGroupId ?? "100", name: "Grupo A" },
    ...(extra.network ? { segments: { adNetworkType: extra.network } } : {}),
    metrics,
  };
}

const m = (impressions: number, clicks: number, spend: number, conversions = 0, viewThrough = 0): Row => ({
  impressions: String(impressions),
  clicks: String(clicks),
  costMicros: String(Math.round(spend * 1_000_000)),
  conversions,
  conversionsValue: conversions * 50,
  viewThroughConversions: String(viewThrough),
  videoTrueviewViews: "0",
});

const GROUP_ROWS: Row[] = [
  groupRow("mobileapp::2-com.jogo.gratis", "Jogo Grátis", "MOBILE_APPLICATION", m(1000, 80, 30)),
  groupRow("mobileapp::2-com.jogo.gratis", "Jogo Grátis", "MOBILE_APPLICATION", m(500, 40, 15), { adGroupId: "101" }),
  groupRow("www.bomsite.com.br", "bomsite.com.br", "WEBSITE", m(5000, 50, 25, 3)),
  groupRow("parked-domain.xyz", "parked-domain.xyz", "WEBSITE", m(3000, 20, 12, 0, 2)),
  groupRow(`youtube.com::${CHANNEL_ID}`, "Galinha Pintadinha Oficial", "YOUTUBE_CHANNEL", m(2000, 2, 3), {
    targetUrl: `youtube.com/channel/${CHANNEL_ID}`,
  }),
  groupRow("Other", "Other", "UNKNOWN", m(700, 7, 5)),
  groupRow("tiny.com", "tiny.com", "WEBSITE", m(5, 0, 0.1)),
];

// ── get_placement_report ─────────────────────────────────────────────

test("placement GROUP: agrega entre grupos, separa a linha Other e lista candidatos no formato de exclude_placements", async () => {
  const { client, calls } = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  const result = await call(client, "get_placement_report", { dateRange: { since: "2026-08-01", until: "2026-08-31" } });
  assert.equal(result.isError, undefined, textOf(result));

  const [query] = queriesFrom(calls, "group_placement_view");
  assert.match(query, /SELECT group_placement_view\.placement, group_placement_view\.display_name, group_placement_view\.placement_type, group_placement_view\.target_url/);
  assert.match(query, /segments\.date BETWEEN '2026-08-01' AND '2026-08-31' AND metrics\.impressions > 0/);
  assert.match(query, /metrics\.view_through_conversions/);
  assert.match(query, /ORDER BY metrics\.cost_micros DESC LIMIT 20000$/);

  const body = jsonOf(result);
  const rows = body.rows as Row[];
  const app = rows.find((r) => r.placement === "mobileapp::2-com.jogo.gratis")!;
  assert.equal(app.impressions, 1500, "as duas linhas (grupos 100 e 101) viram uma");
  assert.equal(app.spend, 45);
  assert.equal(app.campaigns, 1);
  assert.equal(rows.some((r) => r.placement === "Other"), false, "Other não é posicionamento");
  assert.deepEqual((body.other_row as Row).impressions, 700);
  assert.equal((body.totals as Row).impressions, 11505, "totais sem a linha Other");
  assert.match(textOf(result), /Total: Other/);

  const candidates = body.candidates as Row[];
  assert.deepEqual(candidates.map((c) => c.placement), [
    "mobileapp::2-com.jogo.gratis",
    "parked-domain.xyz",
    `youtube.com::${CHANNEL_ID}`,
  ]);
  const appCandidate = candidates[0];
  assert.deepEqual(appCandidate.exclusion, { type: "MOBILE_APP", value: "2-com.jogo.gratis" });
  const reasons = appCandidate.reasons as string[];
  assert.equal(reasons.length, 2);
  assert.match(reasons[0], /app: gastou 45/);
  assert.match(reasons[1], /CTR 8% .*sem conversão/);
  assert.match((candidates[1].reasons as string[])[0], /domínio estacionado.*2 conversão\(ões\) view-through/);
  assert.match((candidates[2].reasons as string[])[0], /conteúdo infantil/);
  assert.deepEqual(body.exclusion_items, [
    { type: "MOBILE_APP", value: "2-com.jogo.gratis" },
    { type: "WEBSITE", value: "parked-domain.xyz" },
    { type: "YOUTUBE_CHANNEL", value: CHANNEL_ID },
  ]);
  // site com conversão e site minúsculo não são candidatos
  assert.equal(candidates.some((c) => c.placement === "www.bomsite.com.br" || c.placement === "tiny.com"), false);

  // conferiu as exclusões atuais (conta e campanhas dos candidatos)
  assert.equal(queriesFrom(calls, "customer_negative_criterion").length, 1);
  const [campaignCriteria] = queriesFrom(calls, "campaign_criterion");
  assert.match(campaignCriteria, /campaign_criterion\.negative = TRUE/);
  assert.match(campaignCriteria, /campaign\.id IN \(10\)/);
  const labels = body.content_exclusions as Row;
  assert.deepEqual(labels.PARKED_DOMAIN, { account: false, campaigns: [] });
  assert.match(textOf(result), /set_content_exclusions/);
  assert.equal(calls.writes.length, 0);
});

test("placement: exclusão que já existe na conta ou na campanha não volta em exclusion_items", async () => {
  const { client } = fakeClient({
    rows: {
      group_placement_view: GROUP_ROWS,
      customer_negative_criterion: [
        { customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "parked-domain.xyz" } } },
        { customerNegativeCriterion: { type: "CONTENT_LABEL", contentLabel: { type: "PARKED_DOMAIN" } } },
      ],
      campaign_criterion: [
        { campaign: { id: "10" }, campaignCriterion: { type: "YOUTUBE_CHANNEL", youtubeChannel: { channelId: CHANNEL_ID } } },
        { campaign: { id: "10" }, campaignCriterion: { type: "CONTENT_LABEL", contentLabel: { type: "BRAND_SUITABILITY_CONTENT_FOR_FAMILIES" } } },
      ],
    },
  });
  const body = jsonOf(await call(client, "get_placement_report", {}));
  const byPlacement = new Map((body.candidates as Row[]).map((c) => [c.placement, c]));
  assert.equal(byPlacement.get("parked-domain.xyz")!.already_excluded, "conta");
  assert.equal(byPlacement.get(`youtube.com::${CHANNEL_ID}`)!.already_excluded, "campanha");
  assert.match(String(byPlacement.get("parked-domain.xyz")!.suggested_action), /já excluído/);
  assert.deepEqual(body.exclusion_items, [{ type: "MOBILE_APP", value: "2-com.jogo.gratis" }]);
  const labels = body.content_exclusions as Record<string, Row>;
  assert.deepEqual(labels.PARKED_DOMAIN, { account: true, campaigns: [] });
  assert.deepEqual(labels.BRAND_SUITABILITY_CONTENT_FOR_FAMILIES, { account: false, campaigns: ["10"] });
});

test("placement: domínio excluído cobre subdomínio; falha ao conferir exclusões vira aviso, não erro", async () => {
  const covered = fakeClient({
    rows: {
      group_placement_view: [groupRow("m.parked-domain.xyz", "m.parked-domain.xyz", "WEBSITE", m(100, 5, 20))],
      customer_negative_criterion: [{ customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "www.parked-domain.xyz" } } }],
    },
  });
  const coveredBody = jsonOf(await call(covered.client, "get_placement_report", {}));
  assert.equal((coveredBody.candidates as Row[])[0].already_excluded, "conta");

  const broken = fakeClient({
    rows: { group_placement_view: GROUP_ROWS },
    failOn: (query) => (/FROM customer_negative_criterion/.test(query) ? "Google Ads API: erro qualquer" : undefined),
  });
  const result = await call(broken.client, "get_placement_report", {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /Não deu para conferir as exclusões atuais/);
  assert.equal((jsonOf(result).exclusion_items as Row[]).length, 3);
});

function detailRow(placement: string, type: string, metrics: Row, campaignId = "10"): Row {
  return {
    detailPlacementView: { placement, displayName: placement, placementType: type, targetUrl: "", groupPlacementTargetUrl: "" },
    campaign: { id: campaignId, name: "Display Remarketing", advertisingChannelType: "DISPLAY" },
    adGroup: { id: "100", name: "Grupo A" },
    metrics,
  };
}

test("placement DETAIL: página ruim vira exclusão da PÁGINA; o domínio inteiro vem à parte, com aviso", async () => {
  const { client } = fakeClient({
    rows: {
      detail_placement_view: [
        detailRow("www.uol.com.br/esporte/noticia-x.htm", "WEBSITE", m(1000, 5, 25)),
        detailRow("https://Blog.Exemplo.com.br/posts/?utm_source=x#topo", "WEBSITE", m(900, 4, 20)),
        detailRow("www.portal.com/a/b/c.html", "WEBSITE", m(800, 3, 15)),
        detailRow("www.bomsite.com", "WEBSITE", m(700, 2, 12)),
      ],
    },
  });
  const result = await call(client, "get_placement_report", { view: "DETAIL" });
  assert.equal(result.isError, undefined, textOf(result));
  const body = jsonOf(result);
  const byPlacement = new Map((body.candidates as Row[]).map((c) => [c.placement, c]));

  const page = byPlacement.get("www.uol.com.br/esporte/noticia-x.htm")!;
  assert.deepEqual(page.exclusion, { type: "WEBSITE", value: "www.uol.com.br/esporte/noticia-x.htm" });
  assert.equal(page.suggested_action, "excluir (exclude_placements)");
  assert.deepEqual(page.domain_exclusion, { type: "WEBSITE", value: "www.uol.com.br" });
  assert.match(String(page.domain_exclusion_warning), /domínio INTEIRO \(www\.uol\.com\.br\), não só esta página/);
  assert.match((page.reasons as string[])[0], /^página: gastou 25/);

  // protocolo, query, fragmento e barra final saem; host em minúsculas; o caminho fica
  const blog = byPlacement.get("https://Blog.Exemplo.com.br/posts/?utm_source=x#topo")!;
  assert.deepEqual(blog.exclusion, { type: "WEBSITE", value: "blog.exemplo.com.br/posts" });
  assert.match(String(blog.exclusion_note), /parâmetros/);

  // mais de 2 níveis: a API não aceita — nada de alargar em silêncio para o domínio
  const deep = byPlacement.get("www.portal.com/a/b/c.html")!;
  assert.equal(deep.exclusion, null);
  assert.match(String(deep.suggested_action), /^revisar manualmente — a API só exclui URL com até 2 níveis/);
  assert.deepEqual(deep.domain_exclusion, { type: "WEBSITE", value: "www.portal.com" });

  // linha DETAIL sem caminho já é o domínio: não precisa de alternativa
  const bare = byPlacement.get("www.bomsite.com")!;
  assert.deepEqual(bare.exclusion, { type: "WEBSITE", value: "www.bomsite.com" });
  assert.equal("domain_exclusion" in bare, false);

  assert.deepEqual(body.exclusion_items, [
    { type: "WEBSITE", value: "www.uol.com.br/esporte/noticia-x.htm" },
    { type: "WEBSITE", value: "blog.exemplo.com.br/posts" },
    { type: "WEBSITE", value: "www.bomsite.com" },
  ], "domínio inteiro nunca entra em exclusion_items");
  assert.match(textOf(result), /DETAIL: sites saem como PÁGINA/);

  // GROUP continua no domínio (o posicionamento dessa view É o domínio)
  const group = fakeClient({ rows: { group_placement_view: [groupRow("www.uol.com.br", "uol.com.br", "WEBSITE", m(5000, 30, 40))] } });
  const groupBody = jsonOf(await call(group.client, "get_placement_report", {}));
  const groupCandidate = (groupBody.candidates as Row[])[0];
  assert.deepEqual(groupCandidate.exclusion, { type: "WEBSITE", value: "www.uol.com.br" });
  assert.equal("domain_exclusion" in groupCandidate, false);
});

test("placement: exclusão de PÁGINA existente não conta como domínio excluído; só a mesma URL fica coberta", async () => {
  // GROUP: a conta exclui só uol.com.br/esporte e a campanha só uma página — o domínio segue recebendo anúncio
  const group = fakeClient({
    rows: {
      group_placement_view: [groupRow("www.uol.com.br", "uol.com.br", "WEBSITE", m(5000, 30, 40))],
      customer_negative_criterion: [{ customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "uol.com.br/esporte" } } }],
      campaign_criterion: [
        { campaign: { id: "10" }, campaignCriterion: { type: "PLACEMENT", placement: { url: "http://www.uol.com.br/esporte/noticia-x.htm/" } } },
      ],
    },
  });
  const groupBody = jsonOf(await call(group.client, "get_placement_report", {}));
  const candidate = (groupBody.candidates as Row[])[0];
  assert.equal(candidate.already_excluded, null);
  assert.equal(candidate.suggested_action, "excluir (exclude_placements)");
  assert.deepEqual(groupBody.exclusion_items, [{ type: "WEBSITE", value: "www.uol.com.br" }]);

  // DETAIL: mesma URL (sem www/protocolo) cobre; seção não cobre página dentro dela; query diferente não cobre;
  // domínio excluído cobre até a página funda demais para excluir sozinha
  const detail = fakeClient({
    rows: {
      detail_placement_view: [
        detailRow("www.uol.com.br/esporte/noticia-x.htm", "WEBSITE", m(1000, 5, 25)),
        detailRow("www.uol.com.br/esporte/outra.htm", "WEBSITE", m(1000, 5, 24)),
        detailRow("loja.com/p?id=2", "WEBSITE", m(1000, 5, 23)),
        detailRow("www.portal.com/a/b/c.html", "WEBSITE", m(1000, 5, 22)),
      ],
      customer_negative_criterion: [
        { customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "https://uol.com.br/esporte/noticia-x.htm" } } },
        { customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "uol.com.br/esporte" } } },
        { customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "loja.com/p?id=1" } } },
        { customerNegativeCriterion: { type: "PLACEMENT", placement: { url: "portal.com" } } },
      ],
    },
  });
  const detailBody = jsonOf(await call(detail.client, "get_placement_report", { view: "DETAIL" }));
  const byPlacement = new Map((detailBody.candidates as Row[]).map((c) => [c.placement, c]));
  assert.equal(byPlacement.get("www.uol.com.br/esporte/noticia-x.htm")!.already_excluded, "conta");
  assert.equal("domain_exclusion" in byPlacement.get("www.uol.com.br/esporte/noticia-x.htm")!, false);
  assert.equal(byPlacement.get("www.uol.com.br/esporte/outra.htm")!.already_excluded, null);
  assert.equal(byPlacement.get("loja.com/p?id=2")!.already_excluded, null);
  const deep = byPlacement.get("www.portal.com/a/b/c.html")!;
  assert.equal(deep.already_excluded, "conta");
  assert.equal(deep.suggested_action, "já excluído (conta)");
  assert.deepEqual(detailBody.exclusion_items, [
    { type: "WEBSITE", value: "www.uol.com.br/esporte/outra.htm" },
    { type: "WEBSITE", value: "loja.com/p" },
  ]);
});

test("placement: filtros viram WHERE; groupBy AD_GROUP separa; limiares valem depois de agregar", async () => {
  const filtered = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  await call(filtered.client, "get_placement_report", { campaignId: "10", adGroupId: "100", placementType: "MOBILE_APPLICATION" });
  const [query] = queriesFrom(filtered.calls, "group_placement_view");
  assert.match(query, /group_placement_view\.placement_type = 'MOBILE_APPLICATION'/);
  assert.match(query, /campaign\.id = 10/);
  assert.match(query, /ad_group\.id = 100/);

  const byGroup = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  const grouped = jsonOf(await call(byGroup.client, "get_placement_report", { groupBy: "AD_GROUP" }));
  const appRows = (grouped.rows as Row[]).filter((r) => r.placement === "mobileapp::2-com.jogo.gratis");
  assert.deepEqual(appRows.map((r) => r.ad_group_id).sort(), ["100", "101"]);

  // cada linha do app tem < 1200 impressões; somadas, 1500 — o filtro é depois da soma
  const threshold = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  const kept = jsonOf(await call(threshold.client, "get_placement_report", { minImpressions: 1200, minSpend: 20 }));
  assert.deepEqual((kept.rows as Row[]).map((r) => r.placement).sort(), ["mobileapp::2-com.jogo.gratis", "www.bomsite.com.br"]);
  assert.match(queriesFrom(threshold.calls, "group_placement_view")[0], /metrics\.impressions > 0 ORDER BY/);
});

test("placement byNetwork: segments.ad_network_type entra no SELECT e separa as linhas", async () => {
  const { client, calls } = fakeClient({
    rows: {
      group_placement_view: [
        groupRow("www.site.com", "site.com", "WEBSITE", m(100, 1, 2, 1), { network: "CONTENT" }),
        groupRow("www.site.com", "site.com", "WEBSITE", m(50, 1, 1, 1), { network: "YOUTUBE" }),
      ],
    },
  });
  const body = jsonOf(await call(client, "get_placement_report", { byNetwork: true }));
  assert.match(queriesFrom(calls, "group_placement_view")[0], /segments\.ad_network_type/);
  assert.deepEqual((body.rows as Row[]).map((r) => r.network).sort(), ["CONTENT", "YOUTUBE"]);
});

test("placement DETAIL: vídeo do YouTube vira YOUTUBE_VIDEO pelo ID; group_target_url sai na linha", async () => {
  const { client, calls } = fakeClient({
    rows: {
      detail_placement_view: [
        {
          detailPlacementView: {
            placement: "youtube.com/video/wtLJPvx7-ys",
            displayName: "Unboxing do celular",
            placementType: "YOUTUBE_VIDEO",
            targetUrl: "youtube.com/video/wtLJPvx7-ys",
            groupPlacementTargetUrl: `youtube.com/channel/${CHANNEL_ID}`,
          },
          campaign: { id: "20", name: "Vídeo", advertisingChannelType: "VIDEO" },
          adGroup: { id: "200", name: "Grupo V" },
          metrics: m(900, 3, 15),
        },
      ],
    },
  });
  const body = jsonOf(await call(client, "get_placement_report", { view: "DETAIL" }));
  assert.match(queriesFrom(calls, "detail_placement_view")[0], /detail_placement_view\.group_placement_target_url/);
  assert.equal((body.rows as Row[])[0].group_target_url, `youtube.com/channel/${CHANNEL_ID}`);
  assert.deepEqual(body.exclusion_items, [{ type: "YOUTUBE_VIDEO", value: "wtLJPvx7-ys" }]);
});

test("placement PMAX: só impressões, campaign no SELECT e recusas antes de consultar", async () => {
  const { client, calls } = fakeClient({
    rows: {
      performance_max_placement_view: [
        {
          performanceMaxPlacementView: {
            placement: "abcdefghijk",
            displayName: "Músicas Infantis para Bebês",
            placementType: "YOUTUBE_VIDEO",
            targetUrl: "https://www.youtube.com/watch?v=abcdefghijk",
          },
          campaign: { id: "30", name: "PMax Loja" },
          metrics: { impressions: "3000" },
        },
        {
          performanceMaxPlacementView: { placement: "www.noticias.com", displayName: "noticias.com", placementType: "WEBSITE", targetUrl: "" },
          campaign: { id: "30", name: "PMax Loja" },
          metrics: { impressions: "1000" },
        },
      ],
    },
  });
  const result = await call(client, "get_placement_report", { view: "PMAX", campaignId: "30" });
  assert.equal(result.isError, undefined, textOf(result));
  const [query] = queriesFrom(calls, "performance_max_placement_view");
  assert.match(query, /campaign\.id, campaign\.name, metrics\.impressions FROM/);
  assert.doesNotMatch(query, /cost_micros|conversions/);
  assert.match(query, /campaign\.id = 30/);
  assert.match(query, /ORDER BY metrics\.impressions DESC/);
  const body = jsonOf(result);
  const rows = body.rows as Row[];
  assert.equal(rows[0].impressions, 3000);
  assert.equal(rows[0].impressions_share_pct, 75);
  assert.equal(rows[0].spend, undefined, "PMax não tem gasto por posicionamento");
  assert.deepEqual(body.exclusion_items, [{ type: "YOUTUBE_VIDEO", value: "abcdefghijk" }]);
  assert.match(textOf(result), /só dá impressões/);

  for (const args of [
    { adGroupId: "1" },
    { minSpend: 10 },
    { sortBy: "cost" },
    { groupBy: "AD_GROUP" },
    { placementType: "YOUTUBE_CHANNEL" },
  ]) {
    const refused = fakeClient();
    const r = await call(refused.client, "get_placement_report", { view: "PMAX", ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(textOf(r), /view=PMAX não aceita/);
    assert.equal(refused.calls.queries.length, 0);
  }
});

test("placement MANAGED: critérios da segmentação, tipo mapeado para o critério e sugestão de revisar (não excluir)", async () => {
  const { client, calls } = fakeClient({
    rows: {
      managed_placement_view: [
        {
          adGroupCriterion: { criterionId: "555", type: "PLACEMENT", status: "ENABLED", displayName: "revista.com", placement: { url: "revista.com" } },
          campaign: { id: "10", name: "Display", advertisingChannelType: "DISPLAY" },
          adGroup: { id: "100", name: "Grupo A" },
          metrics: m(4000, 30, 40),
        },
      ],
    },
  });
  const body = jsonOf(await call(client, "get_placement_report", { view: "MANAGED", placementType: "WEBSITE" }));
  const [query] = queriesFrom(calls, "managed_placement_view");
  assert.match(query, /ad_group_criterion\.placement\.url/);
  assert.match(query, /ad_group_criterion\.type = 'PLACEMENT'/);
  const row = (body.rows as Row[])[0];
  assert.equal(row.placement, "revista.com");
  assert.equal(row.placement_type, "WEBSITE");
  assert.equal(row.criterion_id, "555");
  const candidate = (body.candidates as Row[])[0];
  assert.equal(candidate.exclusion, null);
  assert.match(String(candidate.suggested_action), /revisar o critério/);
  assert.deepEqual(body.exclusion_items, []);
  assert.equal(calls.queries.length, 1, "MANAGED não consulta exclusões");

  const refused = fakeClient();
  const r = await call(refused.client, "get_placement_report", { view: "MANAGED", placementType: "GOOGLE_PRODUCTS" });
  assert.equal(r.isError, true);
  assert.equal(refused.calls.queries.length, 0);
});

test("placement: entrada inválida é recusada antes de qualquer chamada", async () => {
  const cases: Row[] = [
    { campaignId: "10 OR 1=1" },
    { adGroupId: "abc" },
    { minSpend: -1 },
    { minImpressions: Number.NaN },
    { dateRange: { since: "2026-08-31", until: "2026-08-01" } },
    { dateRange: { since: "01/08/2026", until: "2026-08-31" } },
    { days: 0 },
  ];
  for (const args of cases) {
    const { client, calls } = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
    const result = await call(client, "get_placement_report", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0, JSON.stringify(args));
  }
});

test("placement: erro de MCC da API vira explicação em PT-BR apontando a visão do MCC", async () => {
  const { client } = fakeClient({
    failOn: () =>
      "Google Ads API: Request contains an invalid argument. — Metrics cannot be requested for a manager account. " +
      "To retrieve metrics, issue separate requests against each client account under the manager account.",
  });
  const result = await call(client, "get_placement_report", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /é um MCC/);
  assert.match(textOf(result), /get_mcc_performance_summary/);
  assert.match(textOf(result), /\(API: Google Ads API/);
});

test("placement: format table e csv", async () => {
  const table = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  const tableText = textOf(await call(table.client, "get_placement_report", { format: "table" }));
  assert.match(tableText, /placement\s+\|/);
  assert.match(tableText, /mobileapp::2-com\.jogo\.gratis/);
  const csv = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
  const csvText = textOf(await call(csv.client, "get_placement_report", { format: "csv" }));
  assert.match(csvText.split("\n")[0], /^placement,display_name,placement_type/);
});

// ── get_landing_page_performance ─────────────────────────────────────

const lp = (url: string, clicks: number, spend: number, conversions: number, extra: Row = {}): Row => ({
  landingPageView: { unexpandedFinalUrl: url },
  metrics: {
    impressions: String(clicks * 20),
    clicks: String(clicks),
    costMicros: String(spend * 1_000_000),
    conversions,
    conversionsValue: conversions * 100,
    ...extra,
  },
});

const LP_ROWS: Row[] = [
  lp("https://www.loja.com.br/produto?utm_source=x", 200, 400, 10, { speedScore: "3", mobileFriendlyClicksPercentage: 0.95 }),
  lp("https://www.loja.com.br/promo", 100, 150, 1, { speedScore: "7" }),
  lp("https://www.loja.com.br/fora", 50, 80, 0),
  lp("https://m.loja.com.br/", 40, 30, 5, { speedScore: "8", mobileFriendlyClicksPercentage: 0.5 }),
];

const dnw = (adId: string, url: string, evidenceUrl: string, status = "DISAPPROVED"): Row => ({
  campaign: { id: "10", name: "Pesquisa" },
  adGroup: { id: "100" },
  adGroupAd: {
    ad: { id: adId, finalUrls: [url] },
    policySummary: {
      approvalStatus: status,
      policyTopicEntries: [
        {
          topic: "DESTINATION_NOT_WORKING",
          type: "PROHIBITED",
          evidences: [
            { destinationNotWorking: { expandedUrl: evidenceUrl, device: "ANDROID", lastCheckedDateTime: "2026-09-20 10:00:00", httpErrorCode: "404" } },
          ],
        },
      ],
    },
  },
});

const POLICY_ROWS: Row[] = [
  dnw("1", "https://loja.com.br/fora/", "https://loja.com.br/fora?gclid=abc"),
  dnw("2", "https://loja.com.br/sumiu", "https://loja.com.br/sumiu"),
  {
    campaign: { id: "10", name: "Pesquisa" },
    adGroup: { id: "100" },
    adGroupAd: {
      ad: { id: "3", finalUrls: ["https://www.loja.com.br/promo"] },
      policySummary: { approvalStatus: "APPROVED_LIMITED", policyTopicEntries: [{ topic: "TRADEMARKS_IN_AD_TEXT", type: "LIMITED" }] },
    },
  },
];

test("landing page: métricas, alertas (velocidade, conversão, mobile) e cruzamento com DESTINATION_NOT_WORKING", async () => {
  const { client, calls } = fakeClient({ rows: { landing_page_view: LP_ROWS, ad_group_ad: POLICY_ROWS } });
  const result = await call(client, "get_landing_page_performance", {});
  assert.equal(result.isError, undefined, textOf(result));

  const [query] = queriesFrom(calls, "landing_page_view");
  assert.match(query, /^SELECT landing_page_view\.unexpanded_final_url, metrics\.impressions/);
  assert.match(query, /metrics\.speed_score, metrics\.mobile_friendly_clicks_percentage, metrics\.valid_accelerated_mobile_pages_clicks_percentage/);
  assert.match(query, /metrics\.clicks > 0/);
  assert.doesNotMatch(query, /campaign\./, "sem filtro de campanha, linha por URL");
  const [policy] = queriesFrom(calls, "ad_group_ad");
  assert.match(policy, /ad_group_ad\.policy_summary\.approval_status IN \('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY'\)/);

  const body = jsonOf(result);
  assert.equal(body.avg_conv_rate_pct, 4.1);
  const rows = new Map((body.rows as Row[]).map((r) => [r.url, r]));
  const produto = rows.get("https://www.loja.com.br/produto?utm_source=x")!;
  assert.equal(produto.speed_score, 3);
  assert.equal(produto.mobile_friendly_clicks_pct, 95, "fração 0–1 vira %");
  assert.equal(produto.conv_rate_pct, 5);
  assert.deepEqual(produto.flags, ["speed_score 3/10 — página lenta no mobile"]);
  assert.match((rows.get("https://www.loja.com.br/promo")!.flags as string[])[0], /taxa de conversão 1% — menos da metade da média \(4\.1%\)/);
  const fora = rows.get("https://www.loja.com.br/fora")!.flags as string[];
  assert.match(fora[0], /50 cliques e nenhuma conversão/);
  assert.match(fora[1], /DESTINATION_NOT_WORKING em 1 anúncio/);
  assert.match((rows.get("https://m.loja.com.br/")!.flags as string[])[0], /só 50% dos cliques mobile/);

  const issues = body.destination_not_working as Row[];
  assert.deepEqual(issues.map((i) => [i.ad_id, i.in_report]), [["1", true], ["2", false]], "tópico de outra política é ignorado");
  assert.deepEqual((issues[0].evidence as Row[])[0], {
    url: "https://loja.com.br/fora?gclid=abc",
    device: "ANDROID",
    last_checked: "2026-09-20 10:00:00",
    http_error_code: "404",
  });
  assert.equal(calls.writes.length, 0);
});

test("landing page: device e campanha entram no SELECT (segmentam a view) e no WHERE", async () => {
  const { client, calls } = fakeClient({ rows: { landing_page_view: LP_ROWS, ad_group_ad: POLICY_ROWS } });
  await call(client, "get_landing_page_performance", { campaignId: "10", device: "MOBILE" });
  const [query] = queriesFrom(calls, "landing_page_view");
  assert.match(query, /SELECT landing_page_view\.unexpanded_final_url, campaign\.id, campaign\.name, segments\.device/);
  assert.match(query, /campaign\.id = 10 AND segments\.device = 'MOBILE'/);
  assert.match(queriesFrom(calls, "ad_group_ad")[0], /campaign\.id = 10/);

  const byCampaign = fakeClient({ rows: { landing_page_view: LP_ROWS } });
  await call(byCampaign.client, "get_landing_page_performance", { byCampaign: true, checkPolicy: false });
  assert.equal(byCampaign.calls.queries.length, 1, "checkPolicy=false não consulta anúncios");
  assert.match(byCampaign.calls.queries[0].query, /campaign\.id, campaign\.name/);
});

test("landing page: ordenação por speed_score põe a mais lenta primeiro; falha nas políticas vira aviso", async () => {
  const { client } = fakeClient({
    rows: { landing_page_view: LP_ROWS },
    failOn: (query) => (/FROM ad_group_ad/.test(query) ? "Google Ads API: boom" : undefined),
  });
  const result = await call(client, "get_landing_page_performance", { sortBy: "speed_score" });
  assert.equal(result.isError, undefined);
  const urls = (jsonOf(result).rows as Row[]).map((r) => r.url);
  assert.deepEqual(urls.slice(0, 3), [
    "https://www.loja.com.br/produto?utm_source=x",
    "https://www.loja.com.br/promo",
    "https://m.loja.com.br/",
  ]);
  assert.match(textOf(result), /Não deu para cruzar com as políticas/);
});

test("landing page: entrada inválida é recusada antes de qualquer chamada", async () => {
  for (const args of [{ campaignId: "x" }, { minSpeedScore: 11 }, { minClicks: -5 }, { dateRange: { since: "2026-09-10", until: "2026-09-01" } }]) {
    const { client, calls } = fakeClient({ rows: { landing_page_view: LP_ROWS } });
    const result = await call(client, "get_landing_page_performance", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0);
  }
});

// ── get_network_breakdown ─────────────────────────────────────────────

const net = (campaign: Row, network: string, spend: number, conversions: number, value = conversions * 100): Row => ({
  campaign,
  segments: { adNetworkType: network },
  metrics: { impressions: "1000", clicks: "100", costMicros: String(spend * 1_000_000), conversions, conversionsValue: value },
});

const SEARCH_ON = {
  id: "1", name: "Pesquisa Marca", status: "ENABLED", advertisingChannelType: "SEARCH",
  networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: true },
};
const PMAX = { id: "2", name: "PMax", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX", networkSettings: {} };
const SEARCH_OFF = {
  id: "3", name: "Pesquisa Genérica", status: "ENABLED", advertisingChannelType: "SEARCH",
  networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
};

const NETWORK_ROWS: Row[] = [
  net(SEARCH_ON, "SEARCH", 1000, 50),
  net(SEARCH_ON, "SEARCH_PARTNERS", 200, 2),
  net(SEARCH_ON, "CONTENT", 100, 0),
  net(PMAX, "SEARCH", 500, 10),
  net(PMAX, "CONTENT", 300, 0),
  net(PMAX, "YOUTUBE", 200, 1),
  net(SEARCH_OFF, "SEARCH", 400, 20),
  net(SEARCH_OFF, "SEARCH_PARTNERS", 60, 0),
];

test("rede: parceiros e Display piores que o Google Search geram alerta com o update_campaign certo; PMax só informa", async () => {
  const { client, calls } = fakeClient({ rows: { campaign: NETWORK_ROWS } });
  const result = await call(client, "get_network_breakdown", { days: 30 });
  assert.equal(result.isError, undefined, textOf(result));
  const [query] = queriesFrom(calls, "campaign");
  assert.match(query, /segments\.ad_network_type/);
  assert.match(query, /campaign\.network_settings\.target_search_network, campaign\.network_settings\.target_content_network/);
  assert.match(query, /segments\.date DURING LAST_30_DAYS AND metrics\.impressions > 0/);

  const body = jsonOf(result);
  const alerts = body.alerts as Row[];
  assert.equal(alerts.length, 3);
  const [partners, content, offPartners] = alerts.map((a) => String(a.alert));
  assert.match(partners, /parceiros de pesquisa: CPA 100 vs 20 no Google Search/);
  assert.match(partners, /update_campaign networkSettings\.targetSearchNetwork=false/);
  assert.match(content, /expansão para Display: 100 de gasto sem conversão \(Google Search converteu 50\)/);
  assert.match(content, /targetContentNetwork=false/);
  assert.equal(alerts[2].campaign_id, "3");
  assert.match(offPartners, /toggle já está desligado/);

  const campaigns = body.campaigns as Row[];
  const pmax = campaigns.find((c) => c.campaign_id === "2")!;
  assert.deepEqual(pmax.flags, [], "PMax não tem toggle de rede: sem alerta");
  assert.deepEqual(Object.keys(pmax.networks as Row), ["SEARCH", "CONTENT", "YOUTUBE"]);
  const account = body.account_by_network as Record<string, Row>;
  assert.equal(account.SEARCH.spend, 1900);
  assert.equal(account.SEARCH.share_of_spend_pct, round(1900 / 2760 * 100));
  assert.equal(account.SEARCH_PARTNERS.label, "Parceiros de pesquisa");
  assert.equal(calls.writes.length, 0);
});

const round = (value: number) => Math.round(value * 100) / 100;

test("rede: flagMinSpend, filtro de tipo, nível conta e tabela", async () => {
  const high = fakeClient({ rows: { campaign: NETWORK_ROWS } });
  assert.equal((jsonOf(await call(high.client, "get_network_breakdown", { flagMinSpend: 500 })).alerts as Row[]).length, 0);

  const typed = fakeClient({ rows: { campaign: NETWORK_ROWS } });
  await call(typed.client, "get_network_breakdown", { channelType: "SEARCH", campaignId: "1" });
  const [query] = queriesFrom(typed.calls, "campaign");
  assert.match(query, /campaign\.id = 1 AND campaign\.advertising_channel_type = 'SEARCH'/);

  const account = fakeClient({ rows: { campaign: NETWORK_ROWS } });
  const accountBody = jsonOf(await call(account.client, "get_network_breakdown", { level: "ACCOUNT" }));
  assert.equal(accountBody.campaigns, undefined);
  assert.ok(accountBody.account_by_network);

  const table = fakeClient({ rows: { campaign: NETWORK_ROWS } });
  const tableText = textOf(await call(table.client, "get_network_breakdown", { format: "table" }));
  assert.match(tableText, /SEARCH_PARTNERS .*targetSearchNetwork=false/);

  for (const args of [{ campaignId: "1; DROP" }, { flagMinSpend: -1 }, { days: 1.5 }]) {
    const bad = fakeClient({ rows: { campaign: NETWORK_ROWS } });
    const r = await call(bad.client, "get_network_breakdown", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(bad.calls.queries.length, 0);
  }
});

// ── get_mcc_performance_summary ──────────────────────────────────────

const child = (id: string, name: string, currency: string): Row => ({
  customerClient: { id, descriptiveName: name, currencyCode: currency, timeZone: "America/Sao_Paulo", manager: false, status: "ENABLED", level: 1 },
});
const CHILDREN = [
  child("1111111111", "Cliente A", "BRL"),
  child("2222222222", "Cliente B", "BRL"),
  child("3333333333", "Client C", "USD"),
  child("4444444444", "Cliente D", "BRL"),
];
const day = (date: string, spend: number, conversions: number, value: number): Row => ({
  segments: { date },
  metrics: { impressions: "1000", clicks: "50", costMicros: String(spend * 1_000_000), conversions, conversionsValue: value },
});
const ACCOUNT_DAYS: Record<string, Row[]> = {
  "1111111111": [day("2026-08-05", 60, 6, 300), day("2026-08-20", 40, 4, 200), day("2026-07-10", 80, 10, 600)],
  "2222222222": [day("2026-08-10", 50, 0, 0), day("2026-07-15", 40, 2, 100)],
  "3333333333": [day("2026-08-12", 30, 3, 90)],
  "4444444444": [],
};
const mccRows = (_query: string, customerId: string) => ACCOUNT_DAYS[customerId] ?? [];
const AUGUST = { dateRange: { since: "2026-08-01", until: "2026-08-31" } };

test("MCC: uma consulta por conta, período anterior de mesmo tamanho e totais separados por moeda", async () => {
  const { client, calls } = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const result = await call(client, "get_mcc_performance_summary", AUGUST);
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(calls.listChildren, [undefined], "sem managerCustomerId = MCC do login");
  assert.deepEqual(calls.queries.map((q) => q.customerId).sort(), ["1111111111", "2222222222", "3333333333", "4444444444"]);
  for (const { query } of calls.queries) {
    assert.match(oneLine(query), /FROM customer WHERE segments\.date BETWEEN '2026-07-01' AND '2026-08-31'$/);
  }

  const body = jsonOf(result);
  assert.deepEqual(body.previous_period, { since: "2026-07-01", until: "2026-07-31" });
  const totals = body.totals_by_currency as Record<string, Row>;
  assert.deepEqual(Object.keys(totals).sort(), ["BRL", "USD"]);
  assert.equal((totals.BRL.current as Row).spend, 150, "BRL = A + B + D, nunca com USD");
  assert.equal(totals.BRL.accounts, 3, "conta sem gasto entra no total");
  assert.equal((totals.USD.current as Row).spend, 30);
  assert.equal((totals.BRL.change as Row).spend_pct, 25);

  const accounts = body.accounts as Row[];
  assert.deepEqual(accounts.map((a) => a.customer_id), ["1111111111", "2222222222", "3333333333"], "D sem gasto fica fora da lista");
  const a = accounts[0];
  assert.deepEqual(a.current, { spend: 100, impressions: 2000, clicks: 100, conversions: 10, conversions_value: 500, roas: 5, cpa: 10 });
  assert.equal((a.previous as Row).spend, 80);
  assert.deepEqual(a.change, { spend_pct: 25, conversions_pct: 0, conversions_value_pct: -16.67, roas_pct: -33.33, cpa_pct: 25 });
  assert.deepEqual(a.flags, ["ROAS caiu 33.33%"]);
  assert.deepEqual(accounts[1].flags, ["gasto sem conversão no período", "ROAS caiu 100%"]);
  assert.equal((accounts[2].change as Row).spend_pct, null, "sem gasto anterior não há base");
  assert.match(textOf(result), /totais separados por moeda/);
  assert.equal(calls.writes.length, 0);
});

test("MCC: allowlist vale por conta — fora dela a conta nem é consultada nem aparece", async () => {
  const { client, calls } = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const result = await call(client, "get_mcc_performance_summary", AUGUST, { allowed: ["1111111111", "3333333333"], hosted: true });
  assert.deepEqual(calls.queries.map((q) => q.customerId).sort(), ["1111111111", "3333333333"]);
  assert.doesNotMatch(textOf(result), /Cliente B|Cliente D|2222222222|4444444444/);
  // hospedado: nem a contagem das contas de fora sai (diria quantos clientes o MCC tem além dos liberados)
  assert.doesNotMatch(textOf(result), /fora da allowlist/);

  // local (stdio) com allowlist: a contagem ajuda a diagnosticar e não cruza fronteira de cliente
  const local = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const localResult = await call(local.client, "get_mcc_performance_summary", AUGUST, { allowed: ["1111111111", "3333333333"], hosted: false });
  assert.match(textOf(localResult), /2 fora da allowlist/);
  assert.doesNotMatch(textOf(localResult), /Cliente B|Cliente D/);

  // hospedado sem allowlist: nada é consultado
  const empty = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const none = await call(empty.client, "get_mcc_performance_summary", AUGUST, { allowed: [], hosted: true });
  assert.equal(empty.calls.queries.length, 0);
  assert.match(textOf(none), /Nenhuma conta cliente ativa e liberada/);
});

test("MCC hospedado: customerIds fora da allowlist é negado antes de tudo, com a mesma resposta exista a conta ou não", async () => {
  const opts = { allowed: ["1111111111"], hosted: true };
  const children = [CHILDREN[0], CHILDREN[1]]; // 1111111111 (liberada) e 2222222222 (outro cliente do MCC)

  // 2222222222 existe sob o MCC; 9999999999 não existe — a resposta não pode diferenciar os dois
  const existing = fakeClient({ children, rows: { customer: mccRows } });
  const existingResult = await call(existing.client, "get_mcc_performance_summary", { customerIds: ["2222222222"], days: 7 }, opts);
  const missing = fakeClient({ children, rows: { customer: mccRows } });
  const missingResult = await call(missing.client, "get_mcc_performance_summary", { customerIds: ["9999999999"], days: 7 }, opts);
  for (const [result, fake, id] of [
    [existingResult, existing, "2222222222"],
    [missingResult, missing, "9999999999"],
  ] as const) {
    assert.equal(result.isError, true, id);
    assert.equal(textOf(result), `Access denied: customer ${id} not in allowed list.`);
    assert.equal(fake.calls.listChildren.length, 0, "negado antes de listar o MCC");
    assert.equal(fake.calls.queries.length, 0);
  }
  assert.equal(
    textOf(existingResult).replace("2222222222", "<id>"),
    textOf(missingResult).replace("9999999999", "<id>"),
    "existir ou não sob o MCC não muda a resposta"
  );

  // misturando liberada e negada: nega tudo, nada é consultado; o texto não cita a liberada
  const mixed = fakeClient({ children, rows: { customer: mccRows } });
  const mixedResult = await call(mixed.client, "get_mcc_performance_summary", { customerIds: ["111-111-1111", "222-222-2222"], days: 7 }, opts);
  assert.equal(mixedResult.isError, true);
  assert.equal(textOf(mixedResult), "Access denied: customer 222-222-2222 not in allowed list.");
  assert.equal(mixed.calls.queries.length + mixed.calls.listChildren.length, 0);

  // liberada que não está sob o MCC: pode dizer (a conta é do próprio chamador)
  const own = fakeClient({ children: [CHILDREN[1]], rows: { customer: mccRows } });
  const ownResult = await call(own.client, "get_mcc_performance_summary", { customerIds: ["1111111111"], days: 7 }, opts);
  assert.equal(ownResult.isError, undefined);
  assert.equal(textOf(ownResult), "Nenhuma conta cliente ativa e liberada para consultar. Não encontradas sob o MCC: 1111111111.");

  // sem customerIds: só as liberadas, sem contagem de outros clientes
  const all = fakeClient({ children, rows: { customer: mccRows } });
  const allResult = await call(all.client, "get_mcc_performance_summary", { days: 7 }, opts);
  assert.deepEqual(all.calls.queries.map((q) => q.customerId), ["1111111111"]);
  assert.doesNotMatch(textOf(allResult), /allowlist|2222222222|Cliente B/);
});

test("MCC: managerCustomerId precisa estar liberado; liberado, lista as contas dele", async () => {
  const denied = fakeClient({ children: CHILDREN });
  const r = await call(denied.client, "get_mcc_performance_summary", { managerCustomerId: "555-555-5555" }, { allowed: ["1111111111"], hosted: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Access denied/);
  assert.equal(denied.calls.listChildren.length, 0);

  const allowed = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  await call(allowed.client, "get_mcc_performance_summary", { managerCustomerId: "555-555-5555", ...AUGUST }, { allowed: ["*"], hosted: true });
  assert.deepEqual(allowed.calls.listChildren, ["5555555555"]);
});

test("MCC: erro numa conta não derruba as outras; customerIds e maxAccounts limitam as chamadas", async () => {
  const partial = fakeClient({
    children: CHILDREN,
    rows: { customer: mccRows },
    failOn: (_query, customerId) =>
      customerId === "2222222222" ? "Google Ads API: The customer account can't be accessed because it is not yet enabled or has been deactivated." : undefined,
  });
  const body = jsonOf(await call(partial.client, "get_mcc_performance_summary", AUGUST));
  const errors = body.errors as Row[];
  assert.equal(errors.length, 1);
  assert.equal(errors[0].customer_id, "2222222222");
  assert.match(String(errors[0].error), /não está ativa/);
  assert.deepEqual((body.accounts as Row[]).map((a) => a.customer_id), ["1111111111", "3333333333"]);

  const subset = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  await call(subset.client, "get_mcc_performance_summary", { customerIds: ["111-111-1111"], ...AUGUST });
  assert.deepEqual(subset.calls.queries.map((q) => q.customerId), ["1111111111"]);

  const capped = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const cappedResult = await call(capped.client, "get_mcc_performance_summary", { maxAccounts: 1, ...AUGUST });
  assert.equal(capped.calls.queries.length, 1);
  assert.equal((jsonOf(cappedResult).skipped_by_limit as Row[]).length, 3);
  assert.match(textOf(cappedResult), /3 fora do limite maxAccounts=1/);
});

test("MCC: sem comparação consulta só o período; days termina ontem; entrada inválida não chama nada", async () => {
  const noCompare = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const body = jsonOf(await call(noCompare.client, "get_mcc_performance_summary", { compareToPrevious: false, ...AUGUST }));
  assert.match(oneLine(noCompare.calls.queries[0].query), /BETWEEN '2026-08-01' AND '2026-08-31'$/);
  assert.equal(body.previous_period, undefined);
  assert.equal((body.accounts as Row[])[0].change, undefined);

  const relative = fakeClient({ children: [CHILDREN[0]], rows: { customer: mccRows } });
  await call(relative.client, "get_mcc_performance_summary", { days: 7 });
  const today = new Date();
  const shift = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return localIsoDate(d);
  };
  assert.match(oneLine(relative.calls.queries[0].query), new RegExp(`BETWEEN '${shift(14)}' AND '${shift(1)}'$`));

  for (const args of [
    { customerIds: ["abc"] },
    { managerCustomerId: "12a" },
    { maxAccounts: 0 },
    { dateRange: { since: "2026-02-30", until: "2026-03-10" } },
    { dateRange: { since: "2026-08-31", until: "2026-08-01" } },
    { days: -3 },
  ]) {
    const bad = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
    const r = await call(bad.client, "get_mcc_performance_summary", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.equal(bad.calls.queries.length + bad.calls.listChildren.length, 0, JSON.stringify(args));
  }
});

test("MCC: tabela plana por conta", async () => {
  const { client } = fakeClient({ children: CHILDREN, rows: { customer: mccRows } });
  const csv = textOf(await call(client, "get_mcc_performance_summary", { format: "csv", ...AUGUST }));
  const [header, first] = csv.split("\n");
  assert.equal(header, "customer_id,name,currency,spend,conversions,conversions_value,roas,cpa,prev_spend,prev_conversions,prev_roas,prev_cpa,spend_change_pct,cpa_change_pct,roas_change_pct,flags");
  assert.match(first, /^1111111111,Cliente A,BRL,100,/);
});

// ── Transversais ─────────────────────────────────────────────────────

test("as 4 tools são de leitura: catalogadas como read, expostas em read-only e sem validateOnly", () => {
  for (const name of REPORT_TOOLS) {
    assert.ok(GOOGLE_ADS_READ_TOOL_NAMES.has(name), `${name} fora do catálogo de leitura`);
    assert.equal(GOOGLE_ADS_WRITE_TOOL_NAMES.has(name as never), false);
  }
  const { handlers } = register(fakeClient().client, { readOnly: true });
  for (const name of REPORT_TOOLS) assert.ok(handlers.has(name), `${name} some no modo read-only`);
  const { configs } = register(fakeClient().client);
  for (const name of REPORT_TOOLS) {
    assert.equal(configs.get(name)!.inputSchema!.validateOnly, undefined, `${name} é leitura: não ganha validateOnly`);
  }
});

test("conta fora da allowlist é negada antes de qualquer chamada, em todas as tools do lote", async () => {
  for (const name of REPORT_TOOLS.filter((n) => n !== "get_mcc_performance_summary")) {
    const { client, calls } = fakeClient({ rows: { group_placement_view: GROUP_ROWS } });
    const result = await call(client, name, {}, { allowed: ["9999999999"], hosted: true });
    assert.equal(result.isError, true, name);
    assert.match(textOf(result), /Access denied/);
    assert.equal(calls.queries.length, 0, name);
  }
});
