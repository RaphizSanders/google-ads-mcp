/**
 * Lote extensions: extensões (assets vinculados), WhatsApp e formulário de lead.
 *
 * Cobre as tools novas (get_extension_performance, link_extension_assets,
 * update_extension_link_status, update_extension_asset, set_excluded_parent_extension_types,
 * list_extension_exclusions, create_brand_text_asset, create_whatsapp_message_asset,
 * create_lead_form_asset, list_lead_form_assets, list_lead_form_submissions) e as existentes
 * reescritas (list_extensions e as create_*_extension / create_structured_snippet).
 *
 * O client falso passa toda query por assertGaqlRules (metadados reais da v25) e todo
 * updateMask por assertUpdateMaskLeaves; as escritas ficam gravadas para conferir o payload.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { SNIPPET_HEADERS_BY_LOCALE, checkSnippetHeader, explainAssetError } from "../src/tools/extensions.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "111";
const AD_GROUP_ID = "222";
const CAMPAIGN_RES = `customers/${CID}/campaigns/${CAMPAIGN_ID}`;

// ── Client falso ──────────────────────────────────────────────────────

type Router = (query: string, from: string) => Row[] | undefined;

interface FakeOptions {
  route?: Router;
  dryRun?: boolean;
  batchMutate?: (operations: Row[]) => Row;
  mutate?: (resource: string, operations: Row[], options?: Row) => Row;
}

interface Write { method: string; resource?: string; operations: Row[]; options?: Row }

function fakeClient(opts: FakeOptions = {}) {
  const calls = { queries: [] as string[], writes: [] as Write[], dryRunClones: 0 };
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
      return opts.route?.(query, from) ?? [];
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      const linkKey = Object.keys(operations[1] ?? {})[0] ?? "";
      return {
        mutateOperationResponses: [
          { assetResult: { resourceName: `customers/${CID}/assets/900` } },
          { [linkKey.replace("Operation", "Result")]: { resourceName: `customers/${CID}/link/900` } },
        ],
      };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options });
      for (const op of operations) if (typeof op.updateMask === "string") assertUpdateMaskLeaves(op.updateMask);
      if (opts.mutate) return opts.mutate(resource, operations, options);
      if (dryRun) return {};
      return {
        results: operations.map((op) => ({
          resourceName: String(op.remove ?? (op.update as Row | undefined)?.resourceName ?? `customers/${CID}/${resource}/new`),
        })),
      };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown, allowed: string[] = [], hosted = false) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) =>
  register(client).handlers.get(tool)!({ customerId: CID, ...args });

const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");

function payloadOf(result: Result): Row {
  const body = textOf(result);
  const start = body.search(/\n[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start + 1, end + 1)) as Row;
}

const campaignRow = (extra: Row = {}) => ({
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa Marca", status: "ENABLED", advertisingChannelType: "SEARCH", ...extra },
});
const adGroupRow = () => ({
  adGroup: { id: AD_GROUP_ID, name: "Grupo 1", status: "ENABLED" },
  campaign: { id: CAMPAIGN_ID, name: "Pesquisa Marca", advertisingChannelType: "SEARCH" },
});

function sitelink(id: string, linkText: string, url = "https://exemplo.com.br/contato", extra: Row = {}): Row {
  return { id, type: "SITELINK", source: "ADVERTISER", finalUrls: [url], sitelinkAsset: { linkText, ...extra } };
}

const linkRow = (level: "customerAsset" | "campaignAsset" | "adGroupAsset", resourceName: string, asset: Row, extra: Row = {}): Row => ({
  [level]: { resourceName, status: "ENABLED", fieldType: "SITELINK", source: "ADVERTISER", ...extra },
  asset,
});

// ── list_extensions ───────────────────────────────────────────────────

test("list_extensions: sem filtro lê os três níveis só com tipos de extensão", async () => {
  const { client, calls } = fakeClient({
    route: (_q, from) => (from === "customer_asset"
      ? [linkRow("customerAsset", `customers/${CID}/customerAssets/5~SITELINK`, sitelink("5", "Contato"), { primaryStatus: "ELIGIBLE", primaryStatusReasons: [] })]
      : []),
  });
  const result = await call(client, "list_extensions", {});
  assert.equal(calls.queries.length, 3);
  assert.deepEqual(calls.queries.map((q) => /FROM\s+([a-z_]+)/.exec(q)?.[1]), ["customer_asset", "campaign_asset", "ad_group_asset"]);
  for (const query of calls.queries) {
    assert.match(query, /field_type IN \('SITELINK'/);
    assert.doesNotMatch(query, /'HEADLINE'|'DESCRIPTION'|'AD_IMAGE'/, "RSA/imagem só se pedidos");
    assert.match(query, /status != 'REMOVED'/);
    assert.match(query, /LIMIT 500/);
  }
  const rows = payloadOf(result) as unknown as Row[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "account");
  assert.equal(rows[0].content, "Contato → https://exemplo.com.br/contato");
  assert.equal(rows[0].link_resource_name, `customers/${CID}/customerAssets/5~SITELINK`);
});

test("list_extensions: filtros de grupo, tipo, origem e removidos entram na query", async () => {
  const { client, calls } = fakeClient();
  await call(client, "list_extensions", {
    adGroupId: AD_GROUP_ID, fieldTypes: '["HEADLINE","SITELINK"]', source: "AUTOMATICALLY_CREATED", includeRemoved: true, limit: 20,
  });
  assert.equal(calls.queries.length, 1);
  const q = calls.queries[0];
  assert.match(q, /FROM ad_group_asset/);
  assert.match(q, new RegExp(`ad_group_asset\\.ad_group = 'customers/${CID}/adGroups/${AD_GROUP_ID}'`));
  assert.match(q, /field_type IN \('HEADLINE', 'SITELINK'\)/);
  assert.match(q, /ad_group_asset\.source = 'AUTOMATICALLY_CREATED'/);
  assert.doesNotMatch(q, /status != 'REMOVED'/);
  assert.match(q, /LIMIT 20/);
});

test("list_extensions: entrada inválida é recusada antes de consultar", async () => {
  const { client, calls } = fakeClient();
  for (const args of [{ fieldTypes: '["NOPE"]' }, { adGroupId: "1 OR 1" }, { limit: 0 }, { source: "X' OR '1" }, { level: "tudo" }]) {
    const result = await call(client, "list_extensions", args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
});

test("list_extensions: allowlist hospedada nega conta de fora", async () => {
  const { client, calls } = fakeClient();
  const result = await register(client, ["9999999999"], true).handlers.get("list_extensions")!({ customerId: CID });
  assert.match(textOf(result), /Access denied/);
  assert.equal(calls.queries.length, 0);
});

// ── get_extension_performance ────────────────────────────────────────

test("get_extension_performance: inventário + métricas + cliques no próprio asset + totais por tipo", async () => {
  const good = `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~5~SITELINK`;
  const idle = `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~6~SITELINK`;
  const { client, calls } = fakeClient({
    route: (query, from) => {
      if (from === "campaign_asset" && !/metrics\./.test(query)) {
        return [
          { campaignAsset: { resourceName: good, fieldType: "SITELINK", status: "ENABLED", primaryStatus: "ELIGIBLE" }, campaign: { id: CAMPAIGN_ID, name: "C" }, asset: sitelink("5", "Contato") },
          {
            campaignAsset: {
              resourceName: idle, fieldType: "SITELINK", status: "ENABLED", primaryStatus: "NOT_ELIGIBLE",
              primaryStatusReasons: ["ASSET_DISAPPROVED"],
              primaryStatusDetails: [{ status: "NOT_ELIGIBLE", reason: "ASSET_DISAPPROVED", assetDisapproved: { offlineEvaluationErrorReasons: ["PRICE_ASSET_DESCRIPTION_REPEATS_ROW_HEADER"] } }],
            },
            campaign: { id: CAMPAIGN_ID, name: "C" },
            asset: sitelink("6", "Preços"),
          },
        ];
      }
      if (from === "campaign_asset" && /interaction_on_this_asset = TRUE/.test(query)) {
        return [{ campaignAsset: { resourceName: good }, metrics: { clicks: "40", costMicros: "80000000", conversions: 4, conversionsValue: 400 } }];
      }
      if (from === "campaign_asset") {
        return [{ campaignAsset: { resourceName: good }, metrics: { impressions: "1000", clicks: "90", costMicros: "180000000", conversions: 6, conversionsValue: 600 } }];
      }
      if (from === "asset_field_type_view") {
        return [{ assetFieldTypeView: { fieldType: "SITELINK" }, metrics: { impressions: "800", clicks: "70", costMicros: "140000000", conversions: 5, conversionsValue: 500 } }];
      }
      return [];
    },
  });
  const result = await call(client, "get_extension_performance", { dateRange: { since: "2026-08-01", until: "2026-08-31" } });
  assert.equal(result.isError, undefined);
  // 3 níveis × (inventário, todas as interações, só no asset) + asset_field_type_view
  assert.equal(calls.queries.length, 10);
  const onAsset = calls.queries.filter((q) => /interaction_on_this_asset = TRUE/.test(q));
  assert.equal(onAsset.length, 3);
  for (const q of onAsset) assert.match(q, /SELECT [a-z_]+\.resource_name, segments\.asset_interaction_target\.interaction_on_this_asset/);
  assert.ok(calls.queries.some((q) => /FROM asset_field_type_view/.test(q) && /BETWEEN '2026-08-01' AND '2026-08-31'/.test(q)));

  const payload = payloadOf(result);
  const links = payload.links as Row[];
  const top = links.find((l) => l.asset_id === "5")!;
  assert.equal(top.impressions, 1000);
  assert.equal(top.clicks, 40, "cliques no próprio asset");
  assert.equal(top.clicks_any_part_of_ad, 90);
  assert.equal(top.ctr_pct, 4);
  assert.equal(top.cost, 80);
  const bad = links.find((l) => l.asset_id === "6")!;
  assert.equal(bad.impressions, 0, "vínculo sem métrica aparece com zero");
  assert.match(String(bad.flags), /sem impressões/);
  assert.match(String(bad.flags), /reprovado/);
  assert.match(String(bad.primary_status_details), /PRICE_ASSET_DESCRIPTION_REPEATS_ROW_HEADER/);
  const byType = (payload.by_type as Row[]).find((t) => t.field_type === "SITELINK")!;
  assert.equal(byType.links, 2);
  assert.equal((byType.type_totals as Row).impressions, 800);
});

test("get_extension_performance: clickScope=all não segmenta por interação; escopo de campanha filtra certo", async () => {
  const { client, calls } = fakeClient();
  await call(client, "get_extension_performance", { campaignId: CAMPAIGN_ID, clickScope: "all", days: 7 });
  assert.equal(calls.queries.length, 7);
  assert.ok(calls.queries.every((q) => !/asset_interaction_target/.test(q)));
  const accountMetrics = calls.queries.find((q) => /FROM customer_asset/.test(q) && /metrics\./.test(q))!;
  assert.match(accountMetrics, /SELECT customer_asset\.resource_name, campaign\.id,/, "segmento no WHERE precisa estar no SELECT");
  assert.match(accountMetrics, new RegExp(`campaign\\.id = ${CAMPAIGN_ID}`));
  const accountInventory = calls.queries.find((q) => /FROM customer_asset/.test(q) && !/metrics\./.test(q))!;
  assert.doesNotMatch(accountInventory, /campaign\.id/, "o inventário da conta não é filtrado por campanha");
  const campaignMetrics = calls.queries.find((q) => /FROM campaign_asset/.test(q) && /metrics\./.test(q))!;
  assert.match(campaignMetrics, new RegExp(`campaign_asset\\.campaign = '${CAMPAIGN_RES}'`));
  assert.match(campaignMetrics, /DURING LAST_7_DAYS/);
});

test("get_extension_performance: escopo de grupo busca a campanha do grupo; grupo inexistente é erro", async () => {
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "ad_group" ? [adGroupRow()] : []) });
  await call(client, "get_extension_performance", { adGroupId: AD_GROUP_ID, level: "campaign" });
  assert.match(calls.queries[0], /FROM ad_group/);
  const metrics = calls.queries.find((q) => /FROM campaign_asset/.test(q) && /metrics\.impressions/.test(q) && !/TRUE/.test(q))!;
  assert.match(metrics, new RegExp(`campaign_asset\\.campaign = '${CAMPAIGN_RES}'`));
  assert.match(metrics, new RegExp(`ad_group\\.id = ${AD_GROUP_ID}`));
  assert.match(metrics, /SELECT campaign_asset\.resource_name, ad_group\.id,/);

  const missing = fakeClient();
  const result = await call(missing.client, "get_extension_performance", { adGroupId: AD_GROUP_ID });
  assert.equal(result.isError, true);
  assert.equal(missing.calls.queries.length, 1);
});

test("get_extension_performance: data e tipos inválidos são recusados sem consultar; grupo de outra campanha é erro", async () => {
  const { client, calls } = fakeClient();
  const r1 = await call(client, "get_extension_performance", { dateRange: { since: "2026/08/01", until: "2026-08-31" } });
  const r3 = await call(client, "get_extension_performance", { fieldTypes: ["XYZ"] });
  const r4 = await call(client, "get_extension_performance", { campaignId: "1 OR 1" });
  assert.ok(r1.isError && r3.isError && r4.isError);
  assert.equal(calls.queries.length, 0);

  const other = fakeClient({ route: (_q, from) => (from === "ad_group" ? [adGroupRow()] : []) });
  const r2 = await call(other.client, "get_extension_performance", { campaignId: "999", adGroupId: AD_GROUP_ID });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /pertence à campanha 111, não à 999/);
  assert.equal(other.calls.queries.length, 1);
});

// ── link_extension_assets ────────────────────────────────────────────

function linkRouter(extra: Router = () => undefined, assets: Row[] = [sitelink("5", "Contato")]): Router {
  return (query, from) => {
    const custom = extra(query, from);
    if (custom) return custom;
    if (from === "asset") {
      const ids = (/asset\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? "").split(",").map((s) => s.trim());
      return assets.filter((a) => ids.includes(String(a.id))).map((asset) => ({ asset }));
    }
    if (from === "campaign") {
      const ids = (/campaign\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? "").split(",").map((s) => s.trim());
      return ids.map((id) => ({ campaign: { id, name: `C${id}`, status: "ENABLED", advertisingChannelType: "SEARCH" } }));
    }
    if (from === "ad_group") {
      const ids = (/ad_group\.id IN \(([^)]*)\)/.exec(query)?.[1] ?? "").split(",").map((s) => s.trim());
      return ids.map((id) => ({ adGroup: { id, name: `G${id}`, status: "ENABLED" }, campaign: { id: CAMPAIGN_ID } }));
    }
    return [];
  };
}

test("link_extension_assets: vincula um sitelink existente em duas campanhas com partial failure", async () => {
  const { client, calls } = fakeClient({ route: linkRouter() });
  const result = await call(client, "link_extension_assets", {
    fieldType: "SITELINK", assetIds: ["5"], level: "campaign", campaignIds: ["111", "112"],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.writes.length, 1);
  const write = calls.writes[0];
  assert.equal(write.resource, "campaignAssets");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations.map((op) => op.create), [
    { campaign: `customers/${CID}/campaigns/111`, asset: `customers/${CID}/assets/5`, fieldType: "SITELINK", status: "ENABLED" },
    { campaign: `customers/${CID}/campaigns/112`, asset: `customers/${CID}/assets/5`, fieldType: "SITELINK", status: "ENABLED" },
  ]);
  const existingQuery = calls.queries.find((q) => /FROM campaign_asset/.test(q))!;
  assert.doesNotMatch(existingQuery, /status != 'REMOVED'/, "precisa ver pausados para não recriar/reativar");
  assert.equal((payloadOf(result).created as Row[]).length, 2);
});

test("link_extension_assets: conta usa CustomerAsset; vínculo existente/pausado não é recriado nem reativado", async () => {
  const { client, calls } = fakeClient({
    route: linkRouter((_q, from) => from === "customer_asset"
      ? [
          { customerAsset: { resourceName: `customers/${CID}/customerAssets/5~SITELINK`, status: "PAUSED", asset: `customers/${CID}/assets/5` } },
        ]
      : undefined, [sitelink("5", "Contato"), sitelink("6", "Loja")]),
  });
  const result = await call(client, "link_extension_assets", { fieldType: "SITELINK", assetIds: "5,6".split(","), level: "account" });
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "customerAssets");
  assert.deepEqual(calls.writes[0].operations, [
    { create: { asset: `customers/${CID}/assets/6`, fieldType: "SITELINK", status: "ENABLED" } },
  ]);
  const already = payloadOf(result).already_linked as Row[];
  assert.equal(already[0].link_status, "PAUSED");
  assert.match(String(already[0].note), /não foi reativado/);
});

test("link_extension_assets: tudo já vinculado → nenhuma escrita", async () => {
  const { client, calls } = fakeClient({
    route: linkRouter((_q, from) => from === "campaign_asset"
      ? [{ campaignAsset: { resourceName: "x", status: "ENABLED", asset: `customers/${CID}/assets/5`, campaign: CAMPAIGN_RES } }]
      : undefined),
  });
  const result = await call(client, "link_extension_assets", { fieldType: "SITELINK", assetIds: ["5"], level: "campaign", campaignIds: [CAMPAIGN_ID] });
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(result), /Nenhuma escrita foi enviada/);
});

test("link_extension_assets: nível, tipo, automático, conta e escala são barrados antes de gravar", async () => {
  const cases: Array<[Row, RegExp, number]> = [
    [{ fieldType: "LEAD_FORM", assetIds: ["5"], level: "account" }, /só pode ser vinculado em: campaign/, 0],
    [{ fieldType: "BUSINESS_NAME", assetIds: ["5"], level: "ad_group", adGroupIds: ["1"] }, /account, campaign/, 0],
    [{ fieldType: "SITELINK", assetIds: [`customers/9999999999/assets/5`], level: "account" }, /pertence à conta 9999999999/, 0],
    [{ fieldType: "SITELINK", assetIds: ["5"], level: "campaign" }, /exige campaignIds/, 0],
    [{ fieldType: "SITELINK", assetIds: ["5"], level: "campaign", campaignIds: Array.from({ length: 21 }, (_, i) => String(100 + i)) }, /confirm: true/, 0],
    [{ fieldType: "CALLOUT", assetIds: ["5"], level: "account" }, /é do tipo SITELINK; CALLOUT exige CALLOUT/, 1],
  ];
  for (const [args, pattern, queries] of cases) {
    const { client, calls } = fakeClient({ route: linkRouter() });
    const result = await call(client, "link_extension_assets", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length, queries, JSON.stringify(args));
    assert.equal(calls.writes.length, 0);
  }
  const auto = fakeClient({ route: linkRouter(undefined, [{ ...sitelink("5", "Auto"), source: "AUTOMATICALLY_CREATED" }]) });
  const result = await call(auto.client, "link_extension_assets", { fieldType: "SITELINK", assetIds: ["5"], level: "account" });
  assert.match(textOf(result), /criado automaticamente/);
  assert.equal(auto.calls.writes.length, 0);
});

test("link_extension_assets: campanha inexistente ou removida bloqueia a chamada inteira", async () => {
  const { client, calls } = fakeClient({
    route: linkRouter((_q, from) => from === "campaign" ? [{ campaign: { id: "111", name: "Velha", status: "REMOVED" } }] : undefined),
  });
  const result = await call(client, "link_extension_assets", { fieldType: "SITELINK", assetIds: ["5"], level: "campaign", campaignIds: ["111", "113"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /campanha 111 \("Velha"\) está removida/);
  assert.match(textOf(result), /campanha 113 não existe/);
  assert.equal(calls.writes.length, 0);
});

test("link_extension_assets: erro parcial vira relatório por item com explicação em PT-BR", async () => {
  const { client } = fakeClient({
    route: linkRouter(),
    mutate: () => ({
      results: [{ resourceName: "ok" }, {}],
      partialFailureError: {
        message: "falhou",
        details: [{ errors: [{ message: "Excluded", errorCode: { assetLinkError: "EXCLUDED_PARENT_FIELD_TYPE" }, location: { fieldPathElements: [{ fieldName: "operations", index: 1 }] } }] }],
      },
    }),
  });
  const result = await call(client, "link_extension_assets", { fieldType: "SITELINK", assetIds: ["5"], level: "campaign", campaignIds: ["111", "112"] });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal((payload.created as Row[]).length, 1);
  const error = (payload.errors as Row[])[0];
  assert.match(String(error.error), /set_excluded_parent_extension_types/);
});

test("link_extension_assets: mensagem (WhatsApp) respeita um ativo por entidade", async () => {
  const message = { id: "7", type: "BUSINESS_MESSAGE", source: "ADVERTISER", businessMessageAsset: { messageProvider: "WHATSAPP" } };
  const { client, calls } = fakeClient({
    route: linkRouter((query, from) => from === "customer_asset"
      ? [{ customerAsset: { resourceName: "old", status: "ENABLED", asset: `customers/${CID}/assets/3` }, asset: { businessMessageAsset: { messageProvider: "WHATSAPP" } } }]
      : undefined, [message]),
  });
  const result = await call(client, "link_extension_assets", { fieldType: "BUSINESS_MESSAGE", assetIds: ["7"], level: "account" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /o Google aceita só um/);
  assert.equal(calls.writes.length, 0);
  const query = calls.queries.find((q) => /FROM customer_asset/.test(q))!;
  assert.doesNotMatch(query, /customer_asset\.asset IN/, "precisa ver qualquer mensagem ativa, não só a do asset pedido");
});

test("link_extension_assets: validateOnly roda em dry-run e não afirma gravação", async () => {
  const { client, calls } = fakeClient({ route: linkRouter() });
  const result = await call(client, "link_extension_assets", { fieldType: "SITELINK", assetIds: ["5"], level: "account", validateOnly: true });
  assert.equal(calls.dryRunClones, 1);
  assert.match(textOf(result), /^VALIDATE-ONLY/);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): nada foi gravado. Validados: 1/);
  assert.ok("validated" in payloadOf(result));
});

// ── update_extension_link_status ─────────────────────────────────────

const campaignLinkName = (assetId: string, type = "SITELINK") => `customers/${CID}/campaignAssets/${CAMPAIGN_ID}~${assetId}~${type}`;

function statusRouter(links: Row[]): Router {
  return (query, from) => {
    if (from !== "campaign_asset" && from !== "customer_asset" && from !== "ad_group_asset") return [];
    const names = [...query.matchAll(/'(customers\/[^']+)'/g)].map((m) => m[1]);
    const key = from === "campaign_asset" ? "campaignAsset" : from === "customer_asset" ? "customerAsset" : "adGroupAsset";
    return links.filter((l) => names.includes(String(l.resourceName))).map((l) => ({ [key]: l, asset: sitelink("5", "Contato") }));
  };
}

test("update_extension_link_status: pausa um automático e reporta antes/depois", async () => {
  const name = campaignLinkName("5");
  const { client, calls } = fakeClient({ route: statusRouter([{ resourceName: name, status: "ENABLED", source: "AUTOMATICALLY_CREATED", fieldType: "SITELINK" }]) });
  const result = await call(client, "update_extension_link_status", { linkResourceNames: [name], status: "PAUSED" });
  assert.equal(result.isError, undefined);
  assert.match(calls.queries[0], /campaign_asset\.resource_name IN \(/);
  assert.equal(calls.writes[0].resource, "campaignAssets");
  assert.deepEqual(calls.writes[0].operations, [{ update: { resourceName: name, status: "PAUSED" }, updateMask: "status" }]);
  const changed = payloadOf(result).changed as Row[];
  assert.equal(changed[0].before, "ENABLED");
  assert.equal(changed[0].after, "PAUSED");
  assert.equal(changed[0].source, "AUTOMATICALLY_CREATED");
});

test("update_extension_link_status: REMOVED exige confirm e usa operação remove", async () => {
  const name = campaignLinkName("5");
  const { client, calls } = fakeClient({ route: statusRouter([{ resourceName: name, status: "PAUSED" }]) });
  const refused = await call(client, "update_extension_link_status", { linkResourceNames: [name], status: "REMOVED" });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm: true/);
  assert.equal(calls.queries.length + calls.writes.length, 0);
  await call(client, "update_extension_link_status", { linkResourceNames: [name], status: "REMOVED", confirm: true });
  assert.deepEqual(calls.writes[0].operations, [{ remove: name }]);
});

test("update_extension_link_status: mesmo status, removido e inexistente não geram escrita", async () => {
  const same = campaignLinkName("5");
  const removed = campaignLinkName("6");
  const missing = campaignLinkName("7");
  const { client, calls } = fakeClient({ route: statusRouter([{ resourceName: same, status: "ENABLED" }, { resourceName: removed, status: "REMOVED" }]) });
  const result = await call(client, "update_extension_link_status", { linkResourceNames: [same, removed, missing], status: "ENABLED" });
  assert.equal(calls.writes.length, 0);
  const payload = payloadOf(result);
  assert.equal((payload.unchanged as Row[]).length, 1);
  const errors = payload.errors as Row[];
  assert.ok(errors.some((e) => /não pode ser reativado/.test(String(e.error))));
  assert.ok(errors.some((e) => /não encontrado/.test(String(e.error))));
});

test("update_extension_link_status: resource name inválido ou de outra conta é recusado sem chamar a API", async () => {
  const { client, calls } = fakeClient();
  const r1 = await call(client, "update_extension_link_status", { linkResourceNames: [`customers/9999999999/campaignAssets/1~2~SITELINK`], status: "PAUSED" });
  const r2 = await call(client, "update_extension_link_status", { linkResourceNames: [`customers/${CID}/assets/5`], status: "PAUSED" });
  assert.match(textOf(r1), /pertence à conta 9999999999/);
  assert.match(textOf(r2), /não é um vínculo/);
  assert.equal(calls.queries.length + calls.writes.length, 0);
});

// ── update_extension_asset ───────────────────────────────────────────

function assetRouter(asset: Row, links: string[] = [campaignLinkName(String(asset.id))], currency = "BRL"): Router {
  return (query, from) => {
    if (from === "asset") return [{ asset }];
    if (from === "customer") return [{ customer: { id: CID, currencyCode: currency } }];
    if (from === "campaign_asset") return links.map((resourceName) => ({ campaignAsset: { resourceName, status: "ENABLED" } }));
    return [];
  };
}

function onlyAssetUpdate(calls: { writes: Write[] }): { update: Row; updateMask: string } {
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "assets");
  return calls.writes[0].operations[0] as { update: Row; updateMask: string };
}

test("update_extension_asset: sitelink — só as folhas que mudaram vão no updateMask", async () => {
  const { client, calls } = fakeClient({ route: assetRouter(sitelink("5", "Contato", "https://exemplo.com.br/contato", { description1: "a", description2: "b" })) });
  const result = await call(client, "update_extension_asset", {
    assetId: "5", linkText: "Fale conosco", startDate: "2026-10-01", endDate: "2026-10-31", description1: "a",
  });
  assert.equal(result.isError, undefined);
  const op = onlyAssetUpdate(calls);
  assert.equal(op.updateMask, "sitelink_asset.link_text,sitelink_asset.start_date,sitelink_asset.end_date");
  assert.deepEqual(op.update, {
    resourceName: `customers/${CID}/assets/5`,
    sitelinkAsset: { linkText: "Fale conosco", startDate: "2026-10-01", endDate: "2026-10-31" },
  });
  const changes = payloadOf(result).changes as Row[];
  assert.deepEqual(changes[0], { field: "linkText", before: "Contato", after: "Fale conosco" });
});

test("update_extension_asset: sem mudança real não grava", async () => {
  const { client, calls } = fakeClient({ route: assetRouter(sitelink("5", "Contato")) });
  const result = await call(client, "update_extension_asset", { assetId: "5", linkText: "Contato", finalUrl: "https://exemplo.com.br/contato" });
  assert.equal(calls.writes.length, 0);
  assert.match(textOf(result), /Nenhuma escrita foi enviada/);
});

test("update_extension_asset: parâmetro de outro tipo, automático, formulário e descrição sem par são recusados", async () => {
  const cases: Array<[Row, Row, RegExp]> = [
    [sitelink("5", "Contato"), { calloutText: "Frete" }, /não se aplicam: calloutText/],
    [{ ...sitelink("5", "Contato"), source: "AUTOMATICALLY_CREATED" }, { linkText: "X" }, /criado automaticamente/],
    [{ id: "5", type: "LEAD_FORM", leadFormAsset: {} }, { linkText: "X" }, /Formulário de lead: edite na interface/],
    [sitelink("5", "Contato"), { description1: "Só uma" }, /vão juntas/],
  ];
  for (const [asset, args, pattern] of cases) {
    const { client, calls } = fakeClient({ route: assetRouter(asset) });
    const result = await call(client, "update_extension_asset", { assetId: "5", ...args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
    assert.equal(calls.writes.length, 0);
  }
});

test("update_extension_asset: formato inválido é recusado antes de consultar", async () => {
  const { client, calls } = fakeClient();
  for (const args of [
    { linkText: "x".repeat(26) },
    { startDate: "2026-13-01" },
    { startDate: "2026-10-10", endDate: "2026-10-01" },
    { percentOff: 20, moneyAmountOff: 10 },
    { adSchedule: [{ dayOfWeek: "MONDAY", startHour: 10, endHour: 9 }] },
    { assetId: "abc" },
  ]) {
    const result = await call(client, "update_extension_asset", { assetId: "5", ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(calls.queries.length, 0);
});

test("update_extension_asset: promoção — percentual, valor com moeda da conta e limpeza de cupom", async () => {
  const promo = { id: "8", type: "PROMOTION", source: "ADVERTISER", finalUrls: ["https://x.com.br"], promotionAsset: { promotionTarget: "Tênis", percentOff: "100000", promotionCode: "OFF10" } };
  const a = fakeClient({ route: assetRouter(promo) });
  await call(a.client, "update_extension_asset", { assetId: "8", percentOff: 20, clearPromotionTrigger: true });
  const op = onlyAssetUpdate(a.calls);
  assert.equal(op.updateMask, "promotion_asset.percent_off,promotion_asset.promotion_code");
  assert.deepEqual(op.update.promotionAsset, { percentOff: "200000" });

  const b = fakeClient({ route: assetRouter(promo, undefined, "USD") });
  const result = await call(b.client, "update_extension_asset", { assetId: "8", moneyAmountOff: 30 });
  const op2 = onlyAssetUpdate(b.calls);
  assert.equal(op2.updateMask, "promotion_asset.money_amount_off.amount_micros,promotion_asset.money_amount_off.currency_code");
  assert.deepEqual(op2.update.promotionAsset, { moneyAmountOff: { amountMicros: "30000000", currencyCode: "USD" } });
  assert.match(textOf(result), /percentual para valor/);
});

test("update_extension_asset: preço, mensagem e horários", async () => {
  const price = { id: "9", type: "PRICE", source: "ADVERTISER", priceAsset: { type: "SERVICES", priceOfferings: [] } };
  const items = [1, 2, 3].map((i) => ({ header: `Plano ${i}`, description: `Descrição ${i}`, priceAmount: 10 * i, finalUrl: "https://x.com.br", unit: "PER_MONTH" }));
  const p = fakeClient({ route: assetRouter(price) });
  await call(p.client, "update_extension_asset", { assetId: "9", priceItems: items });
  const priceOp = onlyAssetUpdate(p.calls);
  assert.equal(priceOp.updateMask, "price_asset.price_offerings");
  assert.deepEqual((priceOp.update.priceAsset as Row).priceOfferings, items.map((i) => ({
    header: i.header, description: i.description, price: { amountMicros: String(i.priceAmount * 1_000_000), currencyCode: "BRL" }, finalUrl: i.finalUrl, unit: "PER_MONTH",
  })));

  const message = { id: "7", type: "BUSINESS_MESSAGE", source: "ADVERTISER", businessMessageAsset: { messageProvider: "WHATSAPP", starterMessage: "Oi", whatsappInfo: { countryCode: "BR", phoneNumber: "11999998888" } } };
  const m = fakeClient({ route: assetRouter(message) });
  await call(m.client, "update_extension_asset", { assetId: "7", whatsappPhoneNumber: "11911112222", starterMessage: "Oi" });
  const msgOp = onlyAssetUpdate(m.calls);
  assert.equal(msgOp.updateMask, "business_message_asset.whatsapp_info.phone_number");

  const callout = { id: "4", type: "CALLOUT", source: "ADVERTISER", calloutAsset: { calloutText: "Frete", adScheduleTargets: [{ dayOfWeek: "MONDAY", startHour: 8, startMinute: "ZERO", endHour: 18, endMinute: "ZERO" }] } };
  const same = fakeClient({ route: assetRouter(callout) });
  await call(same.client, "update_extension_asset", { assetId: "4", adSchedule: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 18 }] });
  assert.equal(same.calls.writes.length, 0, "mesma agenda não é regravada");
  const cleared = fakeClient({ route: assetRouter(callout) });
  await call(cleared.client, "update_extension_asset", { assetId: "4", clearAdSchedule: true });
  const clearOp = onlyAssetUpdate(cleared.calls);
  assert.equal(clearOp.updateMask, "callout_asset.ad_schedule_targets");
  assert.deepEqual(clearOp.update.calloutAsset, { adScheduleTargets: [] });
});

test("update_extension_asset: avisa quando o asset está em vários vínculos e respeita dry-run", async () => {
  const { client, calls } = fakeClient({
    dryRun: true,
    route: assetRouter(sitelink("5", "Contato"), [campaignLinkName("5"), `customers/${CID}/campaignAssets/112~5~SITELINK`]),
  });
  const result = await call(client, "update_extension_asset", { assetId: "5", linkText: "Novo" });
  assert.equal(calls.writes.length, 1);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.match(textOf(result), /vale para os 2 vínculos/);
});

// ── Herança (excluded_parent_asset_field_types) ─────────────────────

test("set_excluded_parent_extension_types: add, no-op, replace vazio e grupo", async () => {
  const route: Router = (_q, from) => from === "campaign"
    ? [campaignRow({ excludedParentAssetFieldTypes: ["CALLOUT"] })]
    : from === "ad_group" ? [{ adGroup: { id: AD_GROUP_ID, name: "G", status: "ENABLED", excludedParentAssetFieldTypes: [] } }] : [];
  const a = fakeClient({ route });
  const result = await call(a.client, "set_excluded_parent_extension_types", { level: "campaign", campaignId: CAMPAIGN_ID, mode: "add", fieldTypes: ["SITELINK"] });
  assert.equal(a.calls.writes[0].resource, "campaigns");
  assert.deepEqual(a.calls.writes[0].operations, [
    { update: { resourceName: CAMPAIGN_RES, excludedParentAssetFieldTypes: ["CALLOUT", "SITELINK"] }, updateMask: "excluded_parent_asset_field_types" },
  ]);
  assert.deepEqual(payloadOf(result).before, ["CALLOUT"]);

  const b = fakeClient({ route });
  const noop = await call(b.client, "set_excluded_parent_extension_types", { level: "campaign", campaignId: CAMPAIGN_ID, mode: "add", fieldTypes: ["CALLOUT"] });
  assert.equal(b.calls.writes.length, 0);
  assert.match(textOf(noop), /Nenhuma escrita/);

  const c = fakeClient({ route });
  await call(c.client, "set_excluded_parent_extension_types", { level: "campaign", campaignId: CAMPAIGN_ID, mode: "replace", fieldTypes: [] });
  assert.deepEqual((c.calls.writes[0].operations[0].update as Row).excludedParentAssetFieldTypes, []);

  const d = fakeClient({ route });
  await call(d.client, "set_excluded_parent_extension_types", { level: "ad_group", adGroupId: AD_GROUP_ID, mode: "add", fieldTypes: ["SITELINK", "CALL"] });
  assert.equal(d.calls.writes[0].resource, "adGroups");

  const e = fakeClient({ route });
  const bad = await call(e.client, "set_excluded_parent_extension_types", { level: "ad_group", campaignId: CAMPAIGN_ID, mode: "add", fieldTypes: ["SITELINK"] });
  assert.equal(bad.isError, true);
  assert.equal(e.calls.queries.length, 0);
});

test("list_extension_exclusions: só lista quem exclui alguma coisa", async () => {
  const { client } = fakeClient({
    route: (_q, from) => from === "campaign"
      ? [campaignRow({ excludedParentAssetFieldTypes: ["SITELINK"] }), { campaign: { id: "2", name: "Sem", excludedParentAssetFieldTypes: [] } }]
      : from === "ad_group" ? [{ adGroup: { id: "3", name: "G", excludedParentAssetFieldTypes: ["CALL"] }, campaign: { id: "2" } }] : [],
  });
  const result = await call(client, "list_extension_exclusions", {});
  const rows = payloadOf(result) as unknown as Row[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].excluded_from_account, ["SITELINK"]);
  assert.deepEqual(rows[1].excluded_from_parents, ["CALL"]);
});

// ── Criação atômica (nome/aviso, WhatsApp, formulário) ──────────────

test("create_brand_text_asset: nome da empresa na conta — asset + vínculo numa chamada atômica", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_brand_text_asset", { fieldType: "BUSINESS_NAME", text: "Loja Exemplo", level: "account" });
  assert.equal(result.isError, undefined);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  assert.deepEqual(calls.writes[0].operations, [
    { assetOperation: { create: { resourceName: `customers/${CID}/assets/-1`, type: "TEXT", textAsset: { text: "Loja Exemplo" } } } },
    { customerAssetOperation: { create: { asset: `customers/${CID}/assets/-1`, fieldType: "BUSINESS_NAME", status: "ENABLED" } } },
  ]);
  assert.match(textOf(result), /operação atômica/);
});

test("create_brand_text_asset: nível proibido e texto repetido não gravam", async () => {
  const a = fakeClient();
  const refused = await call(a.client, "create_brand_text_asset", { fieldType: "BUSINESS_NAME", text: "X", adGroupId: AD_GROUP_ID });
  assert.equal(refused.isError, true);
  assert.equal(a.calls.queries.length, 0);

  const b = fakeClient({
    route: (_q, from) => from === "campaign" ? [campaignRow()]
      : from === "campaign_asset" ? [{ campaignAsset: { resourceName: "l", status: "ENABLED", fieldType: "BUSINESS_NAME" }, asset: { id: "3", type: "TEXT", textAsset: { text: "Loja Exemplo" } } }] : [],
  });
  const dup = await call(b.client, "create_brand_text_asset", { fieldType: "BUSINESS_NAME", text: " Loja Exemplo ", campaignId: CAMPAIGN_ID });
  assert.equal(b.calls.writes.length, 0);
  assert.match(textOf(dup), /Nada a fazer/);
});

test("create_brand_text_asset: validateOnly de ponta a ponta manda validateOnly no googleAds:mutate", async () => {
  const sent: Array<{ url: string; body: Row }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Row;
    sent.push({ url, body });
    if (url.endsWith(":searchStream")) assertGaqlRules(String(body.query));
    return new Response(JSON.stringify(url.endsWith(":searchStream") ? [{ results: [] }] : {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GoogleAdsClient({
      credentials: { token: "t", refresh_token: "r", token_uri: "https://oauth2.googleapis.com/token", client_id: "c", client_secret: "s", expiry: "2999-01-01T00:00:00.000Z" },
      developerToken: "d",
      loginCustomerId: CID,
    });
    const result = await call(client, "create_brand_text_asset", { fieldType: "TEXT_DISCLAIMER", text: "Imagens ilustrativas.", level: "account", validateOnly: true });
    const writes = sent.filter((s) => !s.url.endsWith(":searchStream"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.equal((writes[0].body.mutateOperations as Row[]).length, 2);
    assert.match(textOf(result), /^VALIDATE-ONLY/);
    assert.match(textOf(result), /nada foi gravado/);
    assert.match(textOf(result), /TEXT_DISCLAIMER é novo/);
  } finally {
    globalThis.fetch = original;
  }
});

test("create_whatsapp_message_asset: payload do BusinessMessageAsset e vínculo de campanha", async () => {
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow()] : []) });
  const result = await call(client, "create_whatsapp_message_asset", {
    campaignId: CAMPAIGN_ID, phoneNumber: "11 99999-8888", starterMessage: "Olá! Quero um orçamento.",
    callToActionType: "GET_QUOTE", callToActionDescription: "Peça seu orçamento",
  });
  assert.equal(result.isError, undefined);
  const [assetOp, linkOp] = calls.writes[0].operations;
  assert.deepEqual((assetOp.assetOperation as Row).create, {
    resourceName: `customers/${CID}/assets/-1`,
    type: "BUSINESS_MESSAGE",
    businessMessageAsset: {
      messageProvider: "WHATSAPP",
      starterMessage: "Olá! Quero um orçamento.",
      callToAction: { callToActionSelection: "GET_QUOTE", callToActionDescription: "Peça seu orçamento" },
      whatsappInfo: { countryCode: "BR", phoneNumber: "11 99999-8888" },
    },
  });
  assert.deepEqual((linkOp.campaignAssetOperation as Row).create, { campaign: CAMPAIGN_RES, asset: `customers/${CID}/assets/-1`, fieldType: "BUSINESS_MESSAGE", status: "ENABLED" });
});

test("create_whatsapp_message_asset: outro WhatsApp ativo bloqueia; allowlist vira mensagem clara", async () => {
  const active = fakeClient({
    route: (_q, from) => from === "campaign" ? [campaignRow()]
      : from === "campaign_asset" ? [{ campaignAsset: { resourceName: "old", status: "ENABLED" }, asset: { id: "3", type: "BUSINESS_MESSAGE", businessMessageAsset: { messageProvider: "WHATSAPP", whatsappInfo: { phoneNumber: "1133334444" } } } }] : [],
  });
  const blocked = await call(active.client, "create_whatsapp_message_asset", {
    campaignId: CAMPAIGN_ID, phoneNumber: "11999998888", starterMessage: "Oi", callToActionType: "CONTACT_US", callToActionDescription: "Fale",
  });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /só um ativo/);
  assert.equal(active.calls.writes.length, 0);

  const allow = fakeClient({
    route: (_q, from) => (from === "campaign" ? [campaignRow()] : []),
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — The customer is not in the allow-list for Business message asset type."); },
  });
  const refused = await call(allow.client, "create_whatsapp_message_asset", {
    campaignId: CAMPAIGN_ID, phoneNumber: "11999998888", starterMessage: "Oi", callToActionType: "CONTACT_US", callToActionDescription: "Fale",
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Nada foi criado/);
  assert.match(textOf(refused), /gerente de contas/);

  const bad = fakeClient();
  const invalid = await call(bad.client, "create_whatsapp_message_asset", {
    level: "account", phoneNumber: "abc", countryCode: "BRA", starterMessage: "", callToActionType: "CONTACT_US", callToActionDescription: "Fale",
  });
  assert.equal(invalid.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

const leadFormArgs = (extra: Row = {}): Row => ({
  campaignId: CAMPAIGN_ID,
  businessName: "Loja Exemplo",
  headline: "Receba uma proposta",
  description: "Preencha e um consultor liga para você.",
  callToActionType: "GET_QUOTE",
  callToActionDescription: "Proposta em 24h",
  privacyPolicyUrl: "https://exemplo.com.br/privacidade",
  fields: [{ inputType: "FULL_NAME" }, { inputType: "EMAIL" }, { inputType: "PHONE_NUMBER" }],
  ...extra,
});

const leadRoute = (accepted: boolean, extra: Router = () => undefined): Router => (query, from) =>
  extra(query, from) ?? (from === "customer"
    ? [{ customer: { id: CID, ...(accepted ? { customerAgreementSetting: { acceptedLeadFormTerms: true } } : {}) } }]
    : from === "campaign" ? [campaignRow()] : []);

test("create_lead_form_asset: sem os termos aceitos não grava e explica como aceitar", async () => {
  const { client, calls } = fakeClient({ route: leadRoute(false) });
  const result = await call(client, "create_lead_form_asset", leadFormArgs());
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não aceitou os termos/);
  assert.equal(calls.queries.length, 1);
  assert.match(calls.queries[0], /customer\.customer_agreement_setting\.accepted_lead_form_terms/);
  assert.equal(calls.writes.length, 0);
});

test("create_lead_form_asset: payload com perguntas, webhook e vínculo LEAD_FORM; chave mascarada na resposta", async () => {
  const { client, calls } = fakeClient({ route: leadRoute(true) });
  const result = await call(client, "create_lead_form_asset", leadFormArgs({
    customQuestions: [{ text: "Qual o seu orçamento?", singleChoiceAnswers: ["Até R$ 10 mil", "Acima de R$ 10 mil"] }, { text: "Algum comentário?" }],
    webhookUrl: "https://crm.exemplo.com.br/google", webhookSecret: "segredo-123", webhookSchemaVersion: 3,
    desiredIntent: "HIGH_INTENT", postSubmitHeadline: "Obrigado!", postSubmitCallToActionType: "VISIT_SITE",
  }));
  assert.equal(result.isError, undefined, textOf(result));
  const [assetOp, linkOp] = calls.writes[0].operations;
  const form = ((assetOp.assetOperation as Row).create as Row).leadFormAsset as Row;
  assert.deepEqual(form.fields, [{ inputType: "FULL_NAME" }, { inputType: "EMAIL" }, { inputType: "PHONE_NUMBER" }]);
  assert.deepEqual(form.customQuestionFields, [
    { customQuestionText: "Qual o seu orçamento?", singleChoiceAnswers: { answers: ["Até R$ 10 mil", "Acima de R$ 10 mil"] } },
    { customQuestionText: "Algum comentário?" },
  ]);
  assert.deepEqual(form.deliveryMethods, [{ webhook: { advertiserWebhookUrl: "https://crm.exemplo.com.br/google", googleSecret: "segredo-123", payloadSchemaVersion: "3" } }]);
  assert.equal(form.desiredIntent, "HIGH_INTENT");
  assert.deepEqual((linkOp.campaignAssetOperation as Row).create, { campaign: CAMPAIGN_RES, asset: `customers/${CID}/assets/-1`, fieldType: "LEAD_FORM", status: "ENABLED" });
  assert.doesNotMatch(textOf(result), /segredo-123/, "a chave do webhook não volta na resposta");
});

test("create_lead_form_asset: regras do formulário são barradas antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ fields: [] }, /ao menos um campo/],
    [{ customQuestions: Array.from({ length: 6 }, (_, i) => ({ text: `P${i}` })) }, /No máximo 5/],
    [{ fields: [{ inputType: "VEHICLE_MODEL", singleChoiceAnswers: ["A", "B"] }], customQuestions: [{ text: "P" }] }, /LEGACY_QUALIFYING/],
    [{ fields: [{ inputType: "EMAIL", singleChoiceAnswers: ["A", "B"] }] }, /não aceita opções/],
    [{ customQuestions: [{ text: "P", singleChoiceAnswers: ["só uma"] }] }, /de 2 a 12 opções/],
    [{ webhookUrl: "https://crm.exemplo.com.br" }, /webhookSecret é obrigatória/],
    [{ webhookUrl: "http://crm.exemplo.com.br", webhookSecret: "x" }, /precisa ser https/],
    [{ privacyPolicyUrl: "privacidade" }, /privacyPolicyUrl inválida/],
    [{ fields: [{ inputType: "EMAIL" }, { inputType: "EMAIL" }] }, /repetido/],
  ];
  for (const [extra, pattern] of cases) {
    const { client, calls } = fakeClient({ route: leadRoute(true) });
    const result = await call(client, "create_lead_form_asset", leadFormArgs(extra));
    assert.equal(result.isError, true, JSON.stringify(extra));
    assert.match(textOf(result), pattern);
    assert.equal(calls.queries.length, 0, JSON.stringify(extra));
  }
});

test("create_lead_form_asset: imagem de fundo fora de 1200x628 e erro de termos da API", async () => {
  const image = fakeClient({
    route: leadRoute(true, (_q, from) => from === "asset" ? [{ asset: { id: "44", type: "IMAGE", imageAsset: { fullSize: { widthPixels: "1200", heightPixels: "1200" } } } }] : undefined),
  });
  const r1 = await call(image.client, "create_lead_form_asset", leadFormArgs({ backgroundImageAssetId: "44" }));
  assert.match(textOf(r1), /exatamente 1200x628/);
  assert.equal(image.calls.writes.length, 0);

  const api = fakeClient({
    route: leadRoute(true),
    batchMutate: () => { throw new Error("Google Ads API: invalid — Lead forms require that the Terms of Service have been agreed to before mutates can be executed."); },
  });
  const r2 = await call(api.client, "create_lead_form_asset", leadFormArgs());
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Recursos > Formulário de lead/);
});

test("list_lead_form_assets: termos, formulários, campanhas e chave do webhook mascarada", async () => {
  const { client } = fakeClient({
    route: (_q, from) => from === "customer" ? [{ customer: { id: CID } }]
      : from === "asset" ? [{ asset: { id: "50", name: "Form", leadFormAsset: { headline: "H", fields: [{ inputType: "EMAIL" }], deliveryMethods: [{ webhook: { advertiserWebhookUrl: "https://crm", googleSecret: "segredo" } }] } } }]
      : from === "campaign_asset" ? [{ campaignAsset: { asset: `customers/${CID}/assets/50`, status: "ENABLED", primaryStatus: "ELIGIBLE" }, campaign: { id: CAMPAIGN_ID, name: "C" } }] : [],
  });
  const result = await call(client, "list_lead_form_assets", {});
  assert.match(textOf(result), /NÃO aceitos/);
  assert.doesNotMatch(textOf(result), /segredo/);
  const payload = payloadOf(result);
  const form = (payload.forms as Row[])[0];
  assert.equal((form.campaigns as Row[])[0].campaign_id, CAMPAIGN_ID);
  assert.deepEqual(form.delivery, [{ webhook_url: "https://crm", secret: "***" }]);
});

test("list_lead_form_submissions: filtros de data/campanha, campos e máscara", async () => {
  const lead = {
    leadFormSubmissionData: {
      id: "L1", submissionDateTime: "2026-08-10 10:00:00-03:00", campaign: CAMPAIGN_RES, asset: `customers/${CID}/assets/50`, gclid: "G123",
      leadFormSubmissionFields: [{ fieldType: "FULL_NAME", fieldValue: "Maria Silva" }, { fieldType: "EMAIL", fieldValue: "maria@x.com" }],
      customLeadFormSubmissionFields: [{ questionText: "Orçamento?", fieldValue: "Até R$ 10 mil" }],
    },
    campaign: { name: "C" },
  };
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "lead_form_submission_data" ? [lead] : []) });
  const result = await call(client, "list_lead_form_submissions", { campaignId: CAMPAIGN_ID, dateRange: { since: "2026-08-01", until: "2026-08-31" } });
  const q = calls.queries[0];
  assert.match(q, /submission_date_time >= '2026-08-01 00:00:00'/);
  assert.match(q, /submission_date_time <= '2026-08-31 23:59:59'/);
  assert.match(q, new RegExp(`lead_form_submission_data\\.campaign = '${CAMPAIGN_RES}'`));
  const leads = payloadOf(result) as unknown as Row[];
  assert.deepEqual(leads[0].fields, { FULL_NAME: "Maria Silva", EMAIL: "maria@x.com" });
  assert.equal(leads[0].campaign_id, CAMPAIGN_ID);

  const masked = await call(client, "list_lead_form_submissions", { redact: true });
  assert.doesNotMatch(textOf(masked), /Maria Silva|maria@x\.com|G123/);
  const csv = await call(client, "list_lead_form_submissions", { format: "csv" });
  assert.match(textOf(csv), /field_FULL_NAME/);
  assert.match(textOf(csv), /custom_1_question/);

  const bad = await call(client, "list_lead_form_submissions", { assetId: "x" });
  assert.equal(bad.isError, true);
});

// ── create_* (existentes, reescritas) ────────────────────────────────

test("create_sitelink_extension: atômico, com datas e horários, na campanha conferida", async () => {
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow()] : []) });
  const result = await call(client, "create_sitelink_extension", {
    campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com.br/contato",
    description1: "Fale com a gente", description2: "Resposta rápida", startDate: "2026-10-01", endDate: "2026-10-31",
    adSchedule: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 18, endMinute: 30 }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const [assetOp, linkOp] = calls.writes[0].operations;
  assert.deepEqual((assetOp.assetOperation as Row).create, {
    resourceName: `customers/${CID}/assets/-1`,
    type: "SITELINK",
    finalUrls: ["https://exemplo.com.br/contato"],
    sitelinkAsset: {
      linkText: "Contato", description1: "Fale com a gente", description2: "Resposta rápida",
      startDate: "2026-10-01", endDate: "2026-10-31",
      adScheduleTargets: [{ dayOfWeek: "MONDAY", startHour: 8, startMinute: "ZERO", endHour: 18, endMinute: "THIRTY" }],
    },
  });
  assert.deepEqual((linkOp.campaignAssetOperation as Row).create, { campaign: CAMPAIGN_RES, asset: `customers/${CID}/assets/-1`, fieldType: "SITELINK", status: "ENABLED" });
  const payload = payloadOf(result);
  assert.equal(payload.asset_resource_name, `customers/${CID}/assets/900`);
});

test("create_sitelink_extension: validações antes da API (tamanho, par de descrições, nível, agenda)", async () => {
  const cases: Row[] = [
    { campaignId: CAMPAIGN_ID, linkText: "x".repeat(26), finalUrl: "https://a.com" },
    { campaignId: CAMPAIGN_ID, linkText: "Ok", finalUrl: "https://a.com", description1: "só uma" },
    { campaignId: CAMPAIGN_ID, linkText: "Ok", finalUrl: "a.com" },
    { linkText: "Ok", finalUrl: "https://a.com" },
    { level: "account", campaignId: CAMPAIGN_ID, linkText: "Ok", finalUrl: "https://a.com" },
    { campaignId: CAMPAIGN_ID, linkText: "Ok", finalUrl: "https://a.com", adSchedule: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 12 }, { dayOfWeek: "MONDAY", startHour: 11, endHour: 14 }] },
    { campaignId: CAMPAIGN_ID, linkText: "Ok", finalUrl: "https://a.com", adSchedule: [{ dayOfWeek: "MONDAY", startHour: 8, startMinute: 10, endHour: 12 }] },
  ];
  for (const args of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_sitelink_extension", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length + calls.writes.length, 0, JSON.stringify(args));
  }
});

test("create_sitelink_extension: duplicado não cria; campanha removida não grava; erro da API explica e não deixa órfão", async () => {
  const dup = fakeClient({
    route: (_q, from) => from === "campaign" ? [campaignRow()]
      : from === "campaign_asset" ? [linkRow("campaignAsset", "l", sitelink("5", "Contato"), { status: "PAUSED" })] : [],
  });
  const r1 = await call(dup.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com.br/contato" });
  assert.equal(dup.calls.writes.length, 0);
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /mesmo conteúdo pedido/);
  assert.match(textOf(r1), /continua pausado/);

  const removed = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow({ status: "REMOVED" })] : []) });
  const r2 = await call(removed.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://a.com" });
  assert.equal(r2.isError, true);
  assert.equal(removed.calls.writes.length, 0);

  const failing = fakeClient({
    route: (_q, from) => (from === "campaign" ? [campaignRow()] : []),
    batchMutate: () => { throw new Error("Google Ads API: Bad — EXCLUDED_PARENT_FIELD_TYPE"); },
  });
  const r3 = await call(failing.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://a.com" });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /Nada foi criado \(asset e vínculo vão na mesma operação atômica\)/);
  assert.match(textOf(r3), /set_excluded_parent_extension_types/);
});

test("create_sitelink_extension: resposta sem confirmação não é tratada como sucesso; dry-run não afirma gravação", async () => {
  const empty = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow()] : []), batchMutate: () => ({}) });
  const r1 = await call(empty.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://a.com" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /não confirmou/);

  const dry = fakeClient({ dryRun: true, route: (_q, from) => (from === "campaign" ? [campaignRow()] : []) });
  const r2 = await call(dry.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://a.com" });
  assert.equal(r2.isError, undefined);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\).*nada foi gravado/);
});

test("create_callout_extension: grupo de anúncios com AdGroupAsset", async () => {
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "ad_group" ? [adGroupRow()] : []) });
  const result = await call(client, "create_callout_extension", { adGroupId: AD_GROUP_ID, calloutText: "Frete Grátis" });
  assert.equal(result.isError, undefined);
  const [assetOp, linkOp] = calls.writes[0].operations;
  assert.deepEqual(((assetOp.assetOperation as Row).create as Row).calloutAsset, { calloutText: "Frete Grátis" });
  assert.deepEqual((linkOp.adGroupAssetOperation as Row).create, {
    adGroup: `customers/${CID}/adGroups/${AD_GROUP_ID}`, asset: `customers/${CID}/assets/-1`, fieldType: "CALLOUT", status: "ENABLED",
  });
  const dupQuery = calls.queries.find((q) => /FROM ad_group_asset/.test(q))!;
  assert.match(dupQuery, new RegExp(`ad_group_asset\\.ad_group = 'customers/${CID}/adGroups/${AD_GROUP_ID}'`));
});

test("create_structured_snippet: cabeçalho oficial e 3–10 valores", async () => {
  const bad = fakeClient();
  const r1 = await call(bad.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Nossas marcas", values: ["A", "B", "C"] });
  const r2 = await call(bad.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Marcas", values: ["A", "B"] });
  assert.ok(r1.isError && r2.isError);
  assert.match(textOf(r1), /lista oficial/);
  assert.equal(bad.calls.queries.length, 0);

  const ok = fakeClient({ route: (_q, from) => (from === "customer_asset" ? [] : []) });
  await call(ok.client, "create_structured_snippet", { level: "account", header: "Marcas", values: '["Nike","Adidas","Puma"]' });
  const assetCreate = (ok.calls.writes[0].operations[0].assetOperation as Row).create as Row;
  assert.deepEqual(assetCreate.structuredSnippetAsset, { header: "Marcas", values: ["Nike", "Adidas", "Puma"] });
  assert.ok("customerAssetOperation" in ok.calls.writes[0].operations[1]);
});

test("create_call_extension: conversão de chamada e horários", async () => {
  const bad = fakeClient();
  const r1 = await call(bad.client, "create_call_extension", { campaignId: CAMPAIGN_ID, phoneNumber: "1133334444", conversionActionId: "77" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION/);
  assert.equal(bad.calls.queries.length, 0);

  const { client, calls } = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow()] : []) });
  await call(client, "create_call_extension", {
    campaignId: CAMPAIGN_ID, phoneNumber: "1133334444", callConversionReportingState: "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION", conversionActionId: "77",
    adSchedule: [{ dayOfWeek: "FRIDAY", startHour: 9, endHour: 24 }],
  });
  const callAsset = ((calls.writes[0].operations[0].assetOperation as Row).create as Row).callAsset as Row;
  assert.deepEqual(callAsset, {
    phoneNumber: "1133334444", countryCode: "BR", callConversionReportingState: "USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION",
    callConversionAction: `customers/${CID}/conversionActions/77`,
    adScheduleTargets: [{ dayOfWeek: "FRIDAY", startHour: 9, startMinute: "ZERO", endHour: 24, endMinute: "ZERO" }],
  });
});

test("create_price_extension: moeda da conta, idioma e validação dos itens", async () => {
  const items = [1, 2, 3].map((i) => ({ header: `Plano ${i}`, description: `Mensal ${i}`, priceAmount: 49.9 * i, finalUrl: "https://x.com.br/p", unit: "PER_MONTH" }));
  const { client, calls } = fakeClient({ route: (_q, from) => from === "campaign" ? [campaignRow()] : from === "customer" ? [{ customer: { currencyCode: "USD" } }] : [] });
  const result = await call(client, "create_price_extension", { campaignId: CAMPAIGN_ID, priceType: "SERVICES", priceQualifier: "FROM", items });
  assert.equal(result.isError, undefined, textOf(result));
  const priceAsset = ((calls.writes[0].operations[0].assetOperation as Row).create as Row).priceAsset as Row;
  assert.equal(priceAsset.languageCode, "pt-BR");
  assert.equal(priceAsset.priceQualifier, "FROM");
  assert.deepEqual((priceAsset.priceOfferings as Row[])[0].price, { amountMicros: "49900000", currencyCode: "USD" });

  const bad = fakeClient();
  const r = await call(bad.client, "create_price_extension", {
    campaignId: CAMPAIGN_ID, priceType: "SERVICES",
    items: [{ header: "Igual", description: "igual", priceAmount: 1, finalUrl: "https://x.com" }],
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /de 3 a 8 itens/);
  assert.match(textOf(r), /não podem ser iguais/);
  assert.equal(bad.calls.queries.length, 0);
});

test("create_promotion_extension: sem janela de resgate inventada; cupom, 'até' e moeda da conta", async () => {
  const { client, calls } = fakeClient({ route: (_q, from) => from === "campaign" ? [campaignRow()] : from === "customer" ? [{ customer: { currencyCode: "BRL" } }] : [] });
  const result = await call(client, "create_promotion_extension", {
    campaignId: CAMPAIGN_ID, promotionTarget: "Tênis de corrida", moneyAmountOff: 50, upTo: true, promotionCode: "CORRE50",
    occasion: "black_friday", finalUrl: "https://exemplo.com.br/tenis", startDate: "2026-11-20", endDate: "2026-11-30",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const create = (calls.writes[0].operations[0].assetOperation as Row).create as Row;
  assert.deepEqual(create.finalUrls, ["https://exemplo.com.br/tenis"]);
  assert.deepEqual(create.promotionAsset, {
    promotionTarget: "Tênis de corrida",
    languageCode: "pt-BR",
    moneyAmountOff: { amountMicros: "50000000", currencyCode: "BRL" },
    discountModifier: "UP_TO",
    promotionCode: "CORRE50",
    occasion: "BLACK_FRIDAY",
    startDate: "2026-11-20",
    endDate: "2026-11-30",
  });
  assert.ok(!("redemptionStartDate" in (create.promotionAsset as Row)), "a janela de 90 dias não é mais inventada");
});

test("create_promotion_extension: exclusividades e ocasião inválida barradas antes da API", async () => {
  const cases: Row[] = [
    { percentOff: 10, moneyAmountOff: 5 },
    {},
    { percentOff: 10, promotionCode: "A", ordersOverAmount: 100 },
    { percentOff: 150 },
    { percentOff: 10, occasion: "DIA_DAS_MAES" },
    { percentOff: 10, redemptionStartDate: "2026-12-10", redemptionEndDate: "2026-12-01" },
  ];
  for (const extra of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_promotion_extension", { campaignId: CAMPAIGN_ID, promotionTarget: "X", finalUrl: "https://a.com", ...extra });
    assert.equal(result.isError, true, JSON.stringify(extra));
    assert.equal(calls.queries.length, 0, JSON.stringify(extra));
  }
  const { client, calls } = fakeClient({ route: (_q, from) => (from === "campaign" ? [campaignRow()] : []) });
  await call(client, "create_promotion_extension", { campaignId: CAMPAIGN_ID, promotionTarget: "X", finalUrl: "https://a.com", percentOff: 7, occasion: "NONE" });
  const promo = ((calls.writes[0].operations[0].assetOperation as Row).create as Row).promotionAsset as Row;
  assert.equal(promo.percentOff, "70000");
  assert.ok(!("occasion" in promo), "NONE não existe na API: é omitido");
});

test("create_*_extension: validateOnly segue recusado (lista de encadeadas em tool-kit) sem enviar nada", async () => {
  const { client, calls } = fakeClient();
  const result = await call(client, "create_callout_extension", { campaignId: CAMPAIGN_ID, calloutText: "Frete", validateOnly: true });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /validateOnly não é suportado/);
  assert.equal(calls.queries.length + calls.writes.length + calls.dryRunClones, 0);
});

test("tools novas de escrita ganham validateOnly; as de leitura não", () => {
  const { configs } = register(fakeClient().client);
  for (const name of ["link_extension_assets", "update_extension_link_status", "update_extension_asset", "set_excluded_parent_extension_types",
    "create_brand_text_asset", "create_whatsapp_message_asset", "create_lead_form_asset"]) {
    assert.ok("validateOnly" in (configs.get(name)!.inputSchema as Row), name);
  }
  for (const name of ["get_extension_performance", "list_extension_exclusions", "list_lead_form_assets", "list_lead_form_submissions", "list_extensions"]) {
    assert.ok(!("validateOnly" in (configs.get(name)!.inputSchema as Row)), name);
  }
});

// ── Revisão: "mesmo conteúdo" só quando o conteúdo é idêntico ─────────
// Antes, preço comparava só tipo + título/descrição e promoção só alvo + desconto + cupom: preços,
// URLs, pedido mínimo, ocasião e datas novos viravam "Nada a fazer: mesmo conteúdo" sem gravar.

const writesOf = (calls: { writes: Write[] }) => calls.writes.filter((w) => w.method === "batchMutate").length;

const brl = (amount: number) => ({ currencyCode: "BRL", amountMicros: String(Math.round(amount * 1_000_000)) });
const offering = (header: string, description: string, amount: number, finalUrl: string, extra: Row = {}): Row =>
  ({ header, description, price: brl(amount), finalUrl, ...extra });
const EXISTING_PRICE: Row = {
  type: "SERVICES",
  languageCode: "pt-BR",
  priceQualifier: "UNSPECIFIED",
  priceOfferings: [
    offering("Corte", "Masculino", 30, "https://a.com/1", { unit: "UNSPECIFIED" }),
    offering("Barba", "Completa", 20, "https://a.com/2"),
    offering("Combo", "Corte e barba", 45, "https://a.com/3"),
  ],
};
const SAME_PRICE_ITEMS: Row[] = [
  { header: "Corte", description: "Masculino", priceAmount: 30, finalUrl: "https://a.com/1" },
  { header: "Barba", description: "Completa", priceAmount: 20, finalUrl: "https://a.com/2" },
  { header: "Combo", description: "Corte e barba", priceAmount: 45, finalUrl: "https://a.com/3" },
];

/** Campanha 111 + moeda BRL + os vínculos de campanha informados. */
const extensionRoute = (links: Row[]): Router => (_q, from) =>
  from === "campaign" ? [campaignRow()]
    : from === "customer" ? [{ customer: { id: CID, currencyCode: "BRL" } }]
      : from === "campaign_asset" ? links : [];

const assetLink = (asset: Row, fieldType: string, extra: Row = {}): Row => ({
  campaignAsset: { resourceName: campaignLinkName(String(asset.id), fieldType), status: "ENABLED", fieldType, source: "ADVERTISER", ...extra },
  asset: { source: "ADVERTISER", ...asset },
});
const priceLink = (priceAsset: Row = EXISTING_PRICE) => assetLink({ id: "41", type: "PRICE", priceAsset }, "PRICE");

test("create_price_extension: preços/URLs/unidade/qualificador novos NÃO viram 'mesmo conteúdo' — cria e avisa do existente", async () => {
  const { client, calls } = fakeClient({ route: extensionRoute([priceLink()]) });
  const result = await call(client, "create_price_extension", {
    campaignId: CAMPAIGN_ID, priceType: "SERVICES", priceQualifier: "FROM",
    items: [
      { header: "Corte", description: "Masculino", priceAmount: 59.9, finalUrl: "https://a.com/novo/1", unit: "PER_MONTH" },
      { header: "Barba", description: "Completa", priceAmount: 39.9, finalUrl: "https://a.com/novo/2", unit: "PER_MONTH" },
      { header: "Combo", description: "Corte e barba", priceAmount: 89.9, finalUrl: "https://a.com/novo/3", unit: "PER_MONTH" },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(writesOf(calls), 1, "o recurso novo é gravado");
  assert.doesNotMatch(textOf(result), /mesmo conteúdo|Nada a fazer/);
  const payload = payloadOf(result);
  const warnings = payload.warnings as string[];
  assert.match(warnings[0], /asset 41, vínculo ENABLED/);
  assert.match(warnings[0], /continuam veiculando junto com o novo/);
  assert.match(warnings[0], /update_extension_asset/);
  const similar = ((payload.details as Row).similar_existing as Row[])[0];
  assert.equal(similar.asset_id, "41");
  const differs = similar.differs as Row[];
  assert.deepEqual(differs.find((d) => d.field === "items[0].price"), { field: "items[0].price", existing: "30", requested: "59.9" });
  assert.ok(differs.some((d) => d.field === "priceQualifier" && d.requested === "FROM"));
  assert.ok(differs.some((d) => d.field === "items[2].finalUrl"));
  assert.ok(differs.some((d) => d.field === "items[1].unit" && d.requested === "PER_MONTH"));
});

test("create_price_extension: idêntico (UNSPECIFIED ≡ ausente, micros ≡ valor) não grava e diz que é o mesmo conteúdo", async () => {
  const { client, calls } = fakeClient({ route: extensionRoute([priceLink()]) });
  const result = await call(client, "create_price_extension", { campaignId: CAMPAIGN_ID, priceType: "SERVICES", items: SAME_PRICE_ITEMS });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(writesOf(calls), 0);
  assert.match(textOf(result), /Nada a fazer: recurso de preço com o mesmo conteúdo pedido já está vinculado/);
  assert.match(textOf(result), /Nenhuma escrita foi enviada/);
});

test("create_price_extension: cada campo do conteúdo conta — mudar só um deles cria", async () => {
  const withItem = (index: number, change: Row) => SAME_PRICE_ITEMS.map((item, i) => (i === index ? { ...item, ...change } : item));
  const variations: Array<[string, Row, Row?]> = [
    ["valor", { items: withItem(1, { priceAmount: 21 }) }],
    ["moeda do item", { items: withItem(0, { currencyCode: "USD" }) }],
    ["URL do item", { items: withItem(2, { finalUrl: "https://a.com/3?promo=1" }) }],
    ["unidade", { items: withItem(0, { unit: "PER_HOUR" }) }],
    ["título", { items: withItem(0, { header: "Corte infantil" }) }],
    ["qualificador", { priceQualifier: "UP_TO" }],
    ["idioma", { languageCode: "es-419" }],
    ["moeda geral", { currencyCode: "USD" }],
    ["URL mobile só no existente", {}, { ...EXISTING_PRICE, priceOfferings: [offering("Corte", "Masculino", 30, "https://a.com/1", { finalMobileUrl: "https://m.a.com/1" }), ...(EXISTING_PRICE.priceOfferings as Row[]).slice(1)] }],
  ];
  for (const [label, change, existing] of variations) {
    const { client, calls } = fakeClient({ route: extensionRoute([priceLink(existing)]) });
    const result = await call(client, "create_price_extension", { campaignId: CAMPAIGN_ID, priceType: "SERVICES", items: SAME_PRICE_ITEMS, ...change });
    assert.equal(result.isError, undefined, `${label}: ${textOf(result)}`);
    assert.equal(writesOf(calls), 1, `${label}: deveria criar`);
    assert.match(textOf(result), /parecido/, label);
  }
});

const EXISTING_PROMO: Row = {
  id: "51", type: "PROMOTION", finalUrls: ["https://a.com/tenis"],
  promotionAsset: { promotionTarget: "Tênis", percentOff: "200000", languageCode: "pt-BR", discountModifier: "UNSPECIFIED", occasion: "UNSPECIFIED" },
};
const promoLink = (asset: Row = EXISTING_PROMO) => assetLink(asset, "PROMOTION");
const SAME_PROMO: Row = { campaignId: CAMPAIGN_ID, promotionTarget: "Tênis", percentOff: 20, finalUrl: "https://a.com/tenis" };

test("create_promotion_extension: Black Friday (pedido mínimo, ocasião, 'até', URL e datas) ao lado da permanente é criada", async () => {
  const { client, calls } = fakeClient({ route: extensionRoute([promoLink()]) });
  const result = await call(client, "create_promotion_extension", {
    ...SAME_PROMO, ordersOverAmount: 300, occasion: "BLACK_FRIDAY", upTo: true,
    finalUrl: "https://a.com/black-friday", startDate: "2026-11-20", endDate: "2026-11-30",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(writesOf(calls), 1);
  assert.doesNotMatch(textOf(result), /mesmo conteúdo|Nada a fazer/);
  const promo = ((calls.writes[0].operations[0].assetOperation as Row).create as Row).promotionAsset as Row;
  assert.deepEqual(promo.ordersOverAmount, { amountMicros: "300000000", currencyCode: "BRL" });
  const payload = payloadOf(result);
  assert.match((payload.warnings as string[])[0], /promoção\(ões\) com o mesmo alvo/);
  const differs = (((payload.details as Row).similar_existing as Row[])[0].differs as Row[]).map((d) => d.field);
  for (const field of ["ordersOverAmount", "occasion", "discountModifier", "finalUrl", "startDate", "endDate"]) {
    assert.ok(differs.includes(field), `differs deveria ter ${field}: ${differs.join(", ")}`);
  }
});

test("create_promotion_extension: idêntica não grava; cada termo diferente cria", async () => {
  const same = fakeClient({ route: extensionRoute([promoLink()]) });
  const r = await call(same.client, "create_promotion_extension", SAME_PROMO);
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(writesOf(same.calls), 0);
  assert.match(textOf(r), /Nada a fazer: promoção com o mesmo conteúdo pedido/);

  const variations: Array<[string, Row, Row?]> = [
    ["pedido mínimo", { ordersOverAmount: 300 }],
    ["cupom", { promotionCode: "TENIS20" }],
    ["ocasião", { occasion: "BLACK_FRIDAY" }],
    ["até", { upTo: true }],
    ["percentual", { percentOff: 25 }],
    ["valor em vez de %", { percentOff: undefined, moneyAmountOff: 20 }],
    ["resgate", { redemptionStartDate: "2026-11-20", redemptionEndDate: "2026-11-30" }],
    ["início", { startDate: "2026-11-20" }],
    ["fim", { endDate: "2026-11-30" }],
    ["horários", { adSchedule: [{ dayOfWeek: "FRIDAY", startHour: 0, endHour: 24 }] }],
    ["URL", { finalUrl: "https://a.com/tenis-bf" }],
    ["idioma", { languageCode: "es-419" }],
    ["termos só no existente", {}, { ...EXISTING_PROMO, promotionAsset: { ...(EXISTING_PROMO.promotionAsset as Row), termsAndConditionsText: "Válido até durar o estoque" } }],
  ];
  for (const [label, change, existing] of variations) {
    const { client, calls } = fakeClient({ route: extensionRoute([promoLink(existing)]) });
    const result = await call(client, "create_promotion_extension", { ...SAME_PROMO, ...change });
    assert.equal(result.isError, undefined, `${label}: ${textOf(result)}`);
    assert.equal(writesOf(calls), 1, `${label}: deveria criar`);
  }
});

test("create_sitelink_extension: mesmo texto e URL com outro conteúdo é recusado apontando update_extension_asset (não 'mesmo conteúdo')", async () => {
  const existing = assetLink(sitelink("5", "Contato", "https://exemplo.com.br/contato", { description1: "Fale com a gente", description2: "Resposta rápida" }), "SITELINK");
  const cases: Array<[Row, string]> = [
    [{ description1: "Atendimento 24h", description2: "Todos os dias" }, "description1, description2"],
    [{ description1: "Fale com a gente", description2: "Resposta rápida", endDate: "2026-12-31" }, "endDate"],
    [{ description1: "Fale com a gente", description2: "Resposta rápida", linkText: "CONTATO" }, "linkText"],
  ];
  for (const [change, fields] of cases) {
    const { client, calls } = fakeClient({ route: extensionRoute([existing]) });
    const result = await call(client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com.br/contato", ...change });
    assert.equal(result.isError, true, JSON.stringify(change));
    assert.equal(writesOf(calls), 0);
    assert.doesNotMatch(textOf(result), /mesmo conteúdo/);
    assert.match(textOf(result), new RegExp(`difere em: ${fields}`));
    assert.match(textOf(result), /update_extension_asset com assetId 5/);
  }
  const exact = fakeClient({ route: extensionRoute([existing]) });
  const ok = await call(exact.client, "create_sitelink_extension", {
    campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com.br/contato", description1: "Fale com a gente", description2: "Resposta rápida",
  });
  assert.equal(ok.isError, undefined);
  assert.match(textOf(ok), /mesmo conteúdo pedido/);
  assert.equal(writesOf(exact.calls), 0);

  const otherUrl = fakeClient({ route: extensionRoute([existing]) });
  await call(otherUrl.client, "create_sitelink_extension", { campaignId: CAMPAIGN_ID, linkText: "Contato", finalUrl: "https://exemplo.com.br/fale" });
  assert.equal(writesOf(otherUrl.calls), 1, "outra URL é outro sitelink");
});

test("create_callout/structured_snippet: idêntico é no-op; mesma frase/valores com outra agenda ou grafia é recusado", async () => {
  const callout = assetLink({ id: "6", type: "CALLOUT", calloutAsset: { calloutText: "Frete Grátis" } }, "CALLOUT");
  const same = fakeClient({ route: extensionRoute([callout]) });
  assert.match(textOf(await call(same.client, "create_callout_extension", { campaignId: CAMPAIGN_ID, calloutText: "Frete Grátis" })), /mesmo conteúdo pedido/);
  const dated = fakeClient({ route: extensionRoute([callout]) });
  const r1 = await call(dated.client, "create_callout_extension", { campaignId: CAMPAIGN_ID, calloutText: "Frete Grátis", endDate: "2026-12-24" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /difere em: endDate/);
  assert.equal(writesOf(same.calls) + writesOf(dated.calls), 0);

  const snippet = assetLink({ id: "7", type: "STRUCTURED_SNIPPET", structuredSnippetAsset: { header: "Marcas", values: ["Nike", "Adidas", "Puma"] } }, "STRUCTURED_SNIPPET");
  const s1 = fakeClient({ route: extensionRoute([snippet]) });
  assert.match(textOf(await call(s1.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Marcas", values: ["Nike", "Adidas", "Puma"] })), /mesmo conteúdo pedido/);
  const s2 = fakeClient({ route: extensionRoute([snippet]) });
  const r2 = await call(s2.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Marcas", values: ["NIKE", "Adidas", "Puma"] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /difere em: values/);
  const s3 = fakeClient({ route: extensionRoute([snippet]) });
  await call(s3.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Marcas", values: ["Nike", "Adidas", "Fila"] });
  assert.equal(writesOf(s1.calls) + writesOf(s2.calls), 0);
  assert.equal(writesOf(s3.calls), 1, "outros valores = outro snippet");
});

test("create_call_extension: conversão não pedida não conta; conversão/horário diferentes são recusados com o caminho certo", async () => {
  const existing = assetLink({
    id: "8", type: "CALL",
    callAsset: { countryCode: "BR", phoneNumber: "1133334444", callConversionReportingState: "USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION", callConversionAction: `customers/${CID}/conversionActions/179` },
  }, "CALL");
  const same = fakeClient({ route: extensionRoute([existing]) });
  const r1 = await call(same.client, "create_call_extension", { campaignId: CAMPAIGN_ID, phoneNumber: "(11) 3333-4444" });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.match(textOf(r1), /mesmo conteúdo pedido/);

  const conversion = fakeClient({ route: extensionRoute([existing]) });
  const r2 = await call(conversion.client, "create_call_extension", { campaignId: CAMPAIGN_ID, phoneNumber: "1133334444", callConversionReportingState: "DISABLED" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /difere em: callConversionReportingState/);
  assert.match(textOf(r2), /não é editável em update_extension_asset/);

  const schedule = fakeClient({ route: extensionRoute([existing]) });
  const r3 = await call(schedule.client, "create_call_extension", { campaignId: CAMPAIGN_ID, phoneNumber: "1133334444", adSchedule: [{ dayOfWeek: "MONDAY", startHour: 8, endHour: 18 }] });
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /difere em: adSchedule/);
  assert.match(textOf(r3), /update_extension_asset com assetId 8/);
  assert.doesNotMatch(textOf(r3), /não é editável/);
  assert.equal(writesOf(same.calls) + writesOf(conversion.calls) + writesOf(schedule.calls), 0);
});

test("create_whatsapp_message_asset: mesmo número com outra mensagem não é 'mesmo conteúdo' — bloqueia e aponta a edição", async () => {
  const existing = assetLink({
    id: "3", type: "BUSINESS_MESSAGE",
    businessMessageAsset: {
      messageProvider: "WHATSAPP", starterMessage: "Oi", whatsappInfo: { countryCode: "BR", phoneNumber: "11999998888" },
      callToAction: { callToActionSelection: "CONTACT_US", callToActionDescription: "Fale" },
    },
  }, "BUSINESS_MESSAGE");
  const args = { campaignId: CAMPAIGN_ID, phoneNumber: "11 99999-8888", callToActionType: "CONTACT_US", callToActionDescription: "Fale" };
  const same = fakeClient({ route: extensionRoute([existing]) });
  const r1 = await call(same.client, "create_whatsapp_message_asset", { ...args, starterMessage: "Oi" });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.match(textOf(r1), /mesmo conteúdo pedido/);
  const other = fakeClient({ route: extensionRoute([existing]) });
  const r2 = await call(other.client, "create_whatsapp_message_asset", { ...args, starterMessage: "Quero um orçamento" });
  assert.equal(r2.isError, true);
  assert.doesNotMatch(textOf(r2), /mesmo conteúdo/);
  assert.match(textOf(r2), /só um ativo/);
  assert.match(textOf(r2), /update_extension_asset com assetId 3/);
  assert.match(textOf(r2), /"field": "starterMessage"/);
  assert.equal(writesOf(same.calls) + writesOf(other.calls), 0);
});

// ── Revisão: cabeçalhos de snippet de todas as localidades oficiais ───

test("create_structured_snippet: aceita cabeçalhos oficiais de es-419, en-GB/en-AU e da tabela base", async () => {
  for (const header of ["Barrios", "Neighbourhoods", "Degree programmes", "Featured Hotels", "Featured hotels", "Service catalog", "Hoteles destacados", "Arredores", "Quartiers"]) {
    const { client, calls } = fakeClient({ route: extensionRoute([]) });
    const result = await call(client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header, values: ["Centro", "Norte", "Sul"] });
    assert.equal(result.isError, undefined, `${header}: ${textOf(result)}`);
    const create = (calls.writes[0].operations[0].assetOperation as Row).create as Row;
    assert.deepEqual(create.structuredSnippetAsset, { header, values: ["Centro", "Norte", "Sul"] }, header);
  }
  const decomposed = fakeClient({ route: extensionRoute([]) });
  await call(decomposed.client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Serviços", values: ["A", "B", "C"] });
  const sent = ((decomposed.calls.writes[0].operations[0].assetOperation as Row).create as Row).structuredSnippetAsset as Row;
  assert.equal(sent.header, "Serviços", "Unicode decomposto vira o texto oficial (NFC)");
});

test("create_structured_snippet / update_extension_asset: grafia errada sugere o oficial; inventado é recusado antes da API", async () => {
  const { client, calls } = fakeClient();
  const lower = await call(client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "marcas", values: ["A", "B", "C"] });
  assert.equal(lower.isError, true);
  assert.match(textOf(lower), /o Google exige o texto exato: use "Marcas"/);
  const invented = await call(client, "create_structured_snippet", { campaignId: CAMPAIGN_ID, header: "Nossas marcas", values: ["A", "B", "C"] });
  assert.match(textOf(invented), /não está na lista oficial de cabeçalhos/);
  assert.match(textOf(invented), /es-419 "Barrios"/);
  const upd = await call(client, "update_extension_asset", { assetId: "7", snippetHeader: "Bairro" });
  assert.equal(upd.isError, true);
  assert.equal(calls.queries.length + calls.writes.length, 0);

  const snippet = { id: "7", type: "STRUCTURED_SNIPPET", source: "ADVERTISER", structuredSnippetAsset: { header: "Bairros", values: ["A", "B", "C"] } };
  const ok = fakeClient({ route: assetRouter(snippet) });
  const result = await call(ok.client, "update_extension_asset", { assetId: "7", snippetHeader: "Barrios" });
  assert.equal(result.isError, undefined, textOf(result));
  const op = onlyAssetUpdate(ok.calls);
  assert.equal(op.updateMask, "structured_snippet_asset.header");
  assert.deepEqual(op.update.structuredSnippetAsset, { header: "Barrios" });
});

test("cabeçalhos de snippet: todas as 44 localidades + tabela base aceitas; erro da API explicado", () => {
  assert.equal(Object.keys(SNIPPET_HEADERS_BY_LOCALE).length, 45);
  for (const [locale, headers] of Object.entries(SNIPPET_HEADERS_BY_LOCALE)) {
    assert.ok(headers.length >= 12, locale);
    for (const header of headers) assert.ok("header" in checkSnippetHeader("header", header), `${locale}: ${header}`);
  }
  assert.deepEqual(SNIPPET_HEADERS_BY_LOCALE["pt-BR"], [
    "Marcas", "Comodidades", "Estilos", "Tipos", "Destinos", "Serviços", "Cursos", "Bairros", "Programas",
    "Cobertura do seguro", "Programas de graduação", "Hotéis em destaque", "Modelos",
  ]);
  assert.match(explainAssetError("Google Ads API: 400 — INVALID_SNIPPETS_HEADER"), /texto exato de um dos cabeçalhos oficiais/);
});
