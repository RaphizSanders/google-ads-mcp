/**
 * Lote pmax-assets — Performance Max: criação e gestão de asset groups.
 *
 * Cobre: create_asset_group e create_pmax_campaign atômicos (um googleAds:mutate, assets
 * antes dos vínculos, regras de marca, raiz do listing group em varejo, validateOnly),
 * update_asset_group (path1/path2/URL mobile, antes/depois, sem escrita quando não muda),
 * list_asset_groups e list_asset_group_assets (motivos, cobertura, mínimos), update_asset_group_assets
 * (trocas atômicas que respeitam mínimo/máximo, confirm), update_display_ad e update_demand_gen_ad
 * (updateMask aninhado) e unlink_campaign_image_assets.
 *
 * O client falso guarda um "estado de conta" e responde às queries pelo FROM e pelos filtros;
 * toda query passa por assertGaqlRules (metadados reais da v25).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { CHAINED_WRITE_TOOLS } from "../src/tool-kit.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const CAMPAIGN_ID = "111";
const GROUP_ID = "222";
const rn = (kind: string, id: string | number) => `customers/${CID}/${kind}/${id}`;

// ── Estado de conta ───────────────────────────────────────────────────

interface Account {
  campaigns: Row[];
  groups: Row[];
  links: Row[];
  campaignAssets: Row[];
  assets: Row[];
  ads: Row[];
}

function image(id: string, width: number, height: number, name = `img-${id}`): Row {
  return { id, name, type: "IMAGE", resourceName: rn("assets", id), imageAsset: { fullSize: { widthPixels: String(width), heightPixels: String(height), url: `https://img/${id}` } } };
}
function textAsset(id: string, value: string): Row {
  return { id, type: "TEXT", resourceName: rn("assets", id), textAsset: { text: value } };
}
function video(id: string): Row {
  return { id, name: `video-${id}`, type: "YOUTUBE_VIDEO", resourceName: rn("assets", id), youtubeVideoAsset: { youtubeVideoId: `yt${id}` } };
}

/** Biblioteca: 501 paisagem, 502 quadrada, 503 retrato, 504 logo 1:1, 505 logo 4:1, 506 vídeo, 507 BN, 508/509 extras. */
function library(): Row[] {
  return [
    image("501", 1200, 628), image("502", 1200, 1200), image("503", 960, 1200), image("504", 600, 600, "logo"),
    image("505", 1200, 300, "logo-paisagem"), video("506"), textAsset("507", "Loja Exemplo"),
    image("508", 1200, 628), image("509", 1200, 1200), textAsset("510", "Descrição curta"),
    { id: "511", type: "DEMAND_GEN_CAROUSEL_CARD", resourceName: rn("assets", "511") },
  ];
}

function pmaxCampaign(overrides: Row = {}): Row {
  return {
    id: CAMPAIGN_ID, name: "PMax Leads", status: "ENABLED", advertisingChannelType: "PERFORMANCE_MAX",
    brandGuidelinesEnabled: true, ...overrides,
  };
}

function group(overrides: Row = {}): Row {
  return {
    id: GROUP_ID, name: "Grupo A", status: "ENABLED", campaignId: CAMPAIGN_ID, adStrength: "GOOD",
    primaryStatus: "ELIGIBLE", primaryStatusReasons: [], finalUrls: ["https://exemplo.com.br"], ...overrides,
  };
}

function link(groupId: string, assetId: string, fieldType: string, overrides: Row = {}): Row {
  return { groupId, assetId, fieldType, status: "ENABLED", source: "ADVERTISER", ...overrides };
}

/** Asset group completo com o mínimo: 3 títulos, 1 longo, 2 descrições (uma curta), 1 paisagem, 1 quadrada. */
function fullGroupAssets(groupId = GROUP_ID): { assets: Row[]; links: Row[] } {
  const assets = [
    textAsset("601", "Título um"), textAsset("602", "Título dois"), textAsset("603", "Título três"),
    textAsset("604", "Título longo do grupo"), textAsset("605", "Curta"),
    textAsset("606", "Uma descrição bem longa que passa de sessenta caracteres com folga no total."),
  ];
  const links = [
    link(groupId, "601", "HEADLINE"), link(groupId, "602", "HEADLINE"), link(groupId, "603", "HEADLINE"),
    link(groupId, "604", "LONG_HEADLINE"), link(groupId, "605", "DESCRIPTION"), link(groupId, "606", "DESCRIPTION"),
    link(groupId, "501", "MARKETING_IMAGE"), link(groupId, "502", "SQUARE_MARKETING_IMAGE"),
  ];
  return { assets, links };
}

function account(overrides: Partial<Account> = {}): Account {
  return { campaigns: [pmaxCampaign()], groups: [], links: [], campaignAssets: [], assets: library(), ads: [], ...overrides };
}

/** Campanha com diretrizes de marca e nome/logo já vinculados na campanha. */
function brandedCampaignAssets(campaignId = CAMPAIGN_ID): Row[] {
  return [
    { campaignId, assetId: "507", fieldType: "BUSINESS_NAME", status: "ENABLED" },
    { campaignId, assetId: "504", fieldType: "LOGO", status: "ENABLED" },
  ];
}

// ── Client falso ──────────────────────────────────────────────────────

interface FakeOptions {
  batchMutate?: (operations: Row[]) => Row;
  mutate?: (resource: string, operations: Row[]) => Row;
  /** Client já em dry-run, como no modo global GOOGLE_ADS_DRY_RUN. */
  dryRun?: boolean;
}

const inList = (query: string, field: string): string[] | null => {
  const match = new RegExp(`${field.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(query);
  return match ? match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")) : null;
};
const equals = (query: string, field: string): string | null => {
  const match = new RegExp(`${field.replace(/\./g, "\\.")} = '?([^'\\s]+)'?`).exec(query);
  return match ? match[1] : null;
};

function fakeClient(state: Account, opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    writes: [] as Array<{ method: string; resource?: string; operations: Row[]; options?: Row; dryRun: boolean }>,
    dryRunClones: 0,
  };
  const campaignOf = (id: string) => state.campaigns.find((c) => String(c.id) === id);
  const groupRow = (g: Row) => {
    const c = campaignOf(String(g.campaignId)) ?? {};
    return {
      assetGroup: {
        id: g.id, name: g.name, status: g.status, campaign: rn("campaigns", String(g.campaignId)), adStrength: g.adStrength,
        primaryStatus: g.primaryStatus, primaryStatusReasons: g.primaryStatusReasons, finalUrls: g.finalUrls,
        finalMobileUrls: g.finalMobileUrls, path1: g.path1, path2: g.path2, assetCoverage: g.assetCoverage,
      },
      campaign: c,
    };
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
      const notRemoved = (field: string) => query.includes(`${field} != 'REMOVED'`);
      if (from === "campaign") {
        const id = equals(query, "campaign.id");
        const name = /campaign\.name = '((?:\\.|[^'\\])*)'/.exec(query)?.[1]?.replace(/\\'/g, "'");
        return state.campaigns
          .filter((c) => (id ? String(c.id) === id : true) && (name !== undefined ? c.name === name : true))
          .filter((c) => !notRemoved("campaign.status") || c.status !== "REMOVED")
          .map((c) => ({ campaign: c }));
      }
      if (from === "asset_group") {
        const ids = inList(query, "asset_group.id") ?? (equals(query, "asset_group.id") ? [equals(query, "asset_group.id")!] : null);
        const campaignId = equals(query, "campaign.id");
        const campaignRn = /asset_group\.campaign = '([^']+)'/.exec(query)?.[1];
        return state.groups
          .filter((g) => (ids ? ids.includes(String(g.id)) : true))
          .filter((g) => (campaignId ? String(g.campaignId) === campaignId : true))
          .filter((g) => (campaignRn ? rn("campaigns", String(g.campaignId)) === campaignRn : true))
          .filter((g) => !notRemoved("asset_group.status") || g.status !== "REMOVED")
          .map(groupRow);
      }
      if (from === "asset_group_asset") {
        const ids = inList(query, "asset_group.id") ?? (equals(query, "asset_group.id") ? [equals(query, "asset_group.id")!] : null);
        const campaignId = equals(query, "campaign.id");
        const types = inList(query, "asset_group_asset.field_type");
        return state.links
          .filter((l) => (ids ? ids.includes(String(l.groupId)) : true))
          .filter((l) => (campaignId ? state.groups.some((g) => g.id === l.groupId && String(g.campaignId) === campaignId) : true))
          .filter((l) => (types ? types.includes(String(l.fieldType)) : true))
          .filter((l) => !notRemoved("asset_group_asset.status") || l.status !== "REMOVED")
          .map((l) => ({
            assetGroup: { id: l.groupId },
            assetGroupAsset: {
              resourceName: rn("assetGroupAssets", `${l.groupId}~${l.assetId}~${l.fieldType}`),
              fieldType: l.fieldType, status: l.status, source: l.source, primaryStatus: l.primaryStatus ?? "ELIGIBLE",
              primaryStatusReasons: l.primaryStatusReasons, policySummary: l.policySummary,
            },
            asset: state.assets.find((a) => a.id === l.assetId) ?? { id: l.assetId },
          }));
      }
      if (from === "campaign_asset") {
        const campaigns = inList(query, "campaign_asset.campaign") ?? [/campaign_asset\.campaign = '([^']+)'/.exec(query)?.[1]];
        const types = inList(query, "campaign_asset.field_type") ?? [equals(query, "campaign_asset.field_type")];
        return state.campaignAssets
          .filter((l) => campaigns.includes(rn("campaigns", String(l.campaignId))))
          .filter((l) => types.includes(String(l.fieldType)))
          .filter((l) => !notRemoved("campaign_asset.status") || l.status !== "REMOVED")
          .map((l) => ({
            campaignAsset: {
              campaign: rn("campaigns", String(l.campaignId)), asset: rn("assets", String(l.assetId)), fieldType: l.fieldType,
              status: l.status, resourceName: rn("campaignAssets", `${l.campaignId}~${l.assetId}~${l.fieldType}`),
            },
          }));
      }
      if (from === "asset") {
        const ids = inList(query, "asset.id") ?? [];
        return state.assets.filter((a) => ids.includes(String(a.id))).map((asset) => ({ asset }));
      }
      if (from === "ad_group_ad") {
        const id = equals(query, "ad_group_ad.ad.id");
        return state.ads
          .filter((a) => String(a.id) === id && a.status !== "REMOVED")
          .map((a) => ({
            adGroupAd: { status: a.status ?? "ENABLED", ad: { id: a.id, type: a.type, [String(a.key)]: a.info } },
            campaign: campaignOf(String(a.campaignId)) ?? { id: a.campaignId },
          }));
      }
      throw new Error(`query inesperada: ${query}`);
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.writes.push({ method: "batchMutate", operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      let next = 900;
      return {
        mutateOperationResponses: operations.map((op) => {
          const [key, body] = Object.entries(op)[0] as [string, Row];
          const resultKey = key.replace(/Operation$/, "Result");
          const created = (body.create ?? {}) as Row;
          const name = body.remove ? String(body.remove) : String(created.resourceName ?? `${key}/x`).replace(/-\d+$/, String(next++));
          return { [resultKey]: { resourceName: name } };
        }),
      };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutate", resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations);
      return dryRun ? {} : { results: operations.map((op) => ({ resourceName: String((op.update as Row)?.resourceName ?? op.remove ?? "x") })) };
    },
    async mutateAssetGroups(customerId: string, operations: Row[]) {
      return (this as { mutate: (c: string, r: string, o: Row[]) => Promise<Row> }).mutate(customerId, "assetGroups", operations);
    },
    async mutateCampaignAssets(_customerId: string, operations: Row[], options?: Row): Promise<Row> {
      calls.writes.push({ method: "mutateCampaignAssets", operations, options, dryRun });
      if (opts.mutate) return opts.mutate("campaignAssets", operations);
      return dryRun ? {} : { results: operations.map((op) => ({ resourceName: String(op.remove ?? "x") })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function register(client: unknown) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, Row>();
  const fakeMcp = {
    registerTool(name: string, config: Row, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, [], false);
  return { handlers, configs };
}

const call = (client: unknown, tool: string, args: Row) => register(client).handlers.get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
function jsonOf(result: Result): Row {
  const body = textOf(result);
  const start = Math.min(...["{", "["].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return JSON.parse(body.slice(start, end + 1)) as Row;
}
const opKinds = (operations: Row[]) => operations.map((op) => Object.keys(op)[0]);
const creates = (operations: Row[], kind: string) =>
  operations.filter((op) => op[kind] && (op[kind] as Row).create).map((op) => (op[kind] as Row).create as Row);
const writesOf = (calls: { writes: Array<{ method: string }> }) => calls.writes.length;

/** Criativo mínimo válido (sem marca). */
const CREATIVE: Row = {
  headlines: ["Tênis de corrida", "Frete grátis", "Até 10x sem juros"],
  longHeadlines: ["Os melhores tênis de corrida com frete grátis para todo o Brasil"],
  descriptions: ["Compre online com entrega rápida.", "Troca grátis em até 30 dias em todas as compras feitas no site oficial."],
  marketingImageAssets: ["501"],
  squareMarketingImageAssets: [rn("assets", "502")],
};

// ══ create_asset_group ════════════════════════════════════════════════

test("create_asset_group: um único googleAds:mutate, assets antes dos vínculos, vínculos consecutivos, sem marca no grupo (diretrizes ligadas)", async () => {
  const { client, calls } = fakeClient(account({ campaignAssets: brandedCampaignAssets() }));
  const result = await call(client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "Tênis", finalUrl: "https://exemplo.com.br/tenis", path1: "tenis", path2: "corrida",
    ...CREATIVE, portraitMarketingImageAssets: ["503"], videoAssets: ["506"], callToAction: "SHOP_NOW",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  const ops = calls.writes[0].operations;
  const kinds = opKinds(ops);
  const firstGroup = kinds.indexOf("assetGroupOperation");
  const firstLink = kinds.indexOf("assetGroupAssetOperation");
  const lastAsset = kinds.lastIndexOf("assetOperation");
  assert.ok(lastAsset < firstGroup && firstGroup < firstLink, `ordem: ${kinds.join(",")}`);
  // os vínculos são consecutivos: a API confere os mínimos depois do último da sequência
  const linkRun = kinds.slice(firstLink);
  assert.ok(linkRun.every((k) => k === "assetGroupAssetOperation"), `vínculos intercalados: ${kinds.join(",")}`);
  assert.ok(!kinds.includes("assetGroupListingGroupFilterOperation"), "sem listing group fora de varejo");
  assert.ok(!kinds.includes("campaignAssetOperation"));

  const groupCreate = creates(ops, "assetGroupOperation")[0];
  assert.equal(groupCreate.status, "PAUSED");
  assert.equal(groupCreate.campaign, rn("campaigns", CAMPAIGN_ID));
  assert.deepEqual(groupCreate.finalUrls, ["https://exemplo.com.br/tenis"]);
  assert.equal(groupCreate.path1, "tenis");
  assert.equal(groupCreate.path2, "corrida");
  assert.match(String(groupCreate.resourceName), new RegExp(`^customers/${CID}/assetGroups/-\\d+$`));

  const assetCreates = creates(ops, "assetOperation");
  assert.equal(assetCreates.length, 7, "6 textos + 1 CTA");
  assert.ok(assetCreates.every((a) => !("type" in a)), "type é OUTPUT_ONLY no Asset");
  assert.deepEqual(assetCreates.find((a) => a.callToActionAsset), { resourceName: assetCreates[6].resourceName, callToActionAsset: { callToAction: "SHOP_NOW" } });
  const tempNames = new Set(assetCreates.map((a) => a.resourceName));
  const allTemp = [...tempNames, groupCreate.resourceName];
  assert.equal(new Set(allTemp).size, allTemp.length, "IDs temporários únicos");

  const links = creates(ops, "assetGroupAssetOperation");
  assert.ok(links.every((l) => l.assetGroup === groupCreate.resourceName));
  const fields = links.map((l) => l.fieldType);
  assert.deepEqual(fields.filter((f) => f === "HEADLINE").length, 3);
  assert.ok(!fields.includes("BUSINESS_NAME") && !fields.includes("LOGO"), "com diretrizes de marca, nome/logo ficam na campanha");
  assert.ok(fields.includes("PORTRAIT_MARKETING_IMAGE") && fields.includes("YOUTUBE_VIDEO") && fields.includes("CALL_TO_ACTION_SELECTION"));
  for (const l of links.filter((l) => ["HEADLINE", "LONG_HEADLINE", "DESCRIPTION", "CALL_TO_ACTION_SELECTION"].includes(String(l.fieldType)))) {
    assert.ok(tempNames.has(String(l.asset)), "texto vincula o asset temporário criado no mesmo pedido");
  }
  assert.equal(links.find((l) => l.fieldType === "MARKETING_IMAGE")!.asset, rn("assets", "501"));
  assert.match(textOf(result), /Asset group criado \(PAUSADO\)/);
});

test("create_asset_group: diretrizes de marca DESLIGADAS exigem nome da empresa e logo no próprio asset group", async () => {
  const state = account({ campaigns: [pmaxCampaign({ brandGuidelinesEnabled: false })] });
  const missing = fakeClient(state);
  const refused = await call(missing.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /BUSINESS_NAME: 0 \(mínimo 1/);
  assert.match(textOf(refused), /LOGO: 0 \(mínimo 1/);
  assert.equal(writesOf(missing.calls), 0);

  const ok = fakeClient(state);
  const result = await call(ok.client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE,
    businessName: "Loja Exemplo", logoAssets: ["504"], landscapeLogoAssets: ["505"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = ok.calls.writes[0].operations;
  const links = creates(ops, "assetGroupAssetOperation");
  const bn = links.find((l) => l.fieldType === "BUSINESS_NAME")!;
  const bnAsset = creates(ops, "assetOperation").find((a) => a.resourceName === bn.asset)!;
  assert.deepEqual(bnAsset.textAsset, { text: "Loja Exemplo" });
  assert.equal(links.find((l) => l.fieldType === "LOGO")!.asset, rn("assets", "504"));
  assert.equal(links.find((l) => l.fieldType === "LANDSCAPE_LOGO")!.asset, rn("assets", "505"));
  assert.ok(!opKinds(ops).includes("campaignAssetOperation"));
});

test("create_asset_group: diretrizes LIGADAS e campanha já com nome/logo — logo no asset group é recusado antes de gravar", async () => {
  const { client, calls } = fakeClient(account({ campaignAssets: brandedCampaignAssets() }));
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE, logoAssets: ["504"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /diretrizes de marca LIGADAS/);
  assert.equal(writesOf(calls), 0);
});

test("create_asset_group: varejo sem assets cria o grupo vazio + raiz do listing group no mesmo pedido", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" } })] }));
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "Varejo", finalUrl: "https://loja.com.br" });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.writes[0].operations;
  assert.deepEqual(opKinds(ops), ["assetGroupOperation", "assetGroupListingGroupFilterOperation"]);
  const groupRn = creates(ops, "assetGroupOperation")[0].resourceName;
  assert.deepEqual(creates(ops, "assetGroupListingGroupFilterOperation")[0], { assetGroup: groupRn, type: "UNIT_INCLUDED", listingSource: "SHOPPING" });
  assert.ok(!calls.queries.some((q) => q.includes("FROM campaign_asset")), "grupo vazio não precisa de marca");
});

test("create_asset_group: varejo com parte dos assets é recusado (tudo ou nada)", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" } })], campaignAssets: brandedCampaignAssets() }));
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "V", finalUrl: "https://loja.com.br", headlines: ["A", "B", "C"] });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /LONG_HEADLINE: 0 \(mínimo 1/);
  assert.match(textOf(result), /sem nenhum asset .* ou com o conjunto mínimo completo/);
  assert.equal(writesOf(calls), 0);
});

test("create_asset_group: varejo com diretrizes e campanha sem nome/logo — ao ganhar assets, a marca vai na campanha no mesmo pedido", async () => {
  const state = account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" } })] });
  const refused = fakeClient(state);
  const noBrand = await call(refused.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "V", finalUrl: "https://loja.com.br", ...CREATIVE });
  assert.equal(noBrand.isError, true);
  assert.match(textOf(noBrand), /informe o nome da empresa/);
  assert.equal(writesOf(refused.calls), 0);

  const { client, calls } = fakeClient(state);
  const result = await call(client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "V", finalUrl: "https://loja.com.br", ...CREATIVE, businessNameAsset: "507", logoAssets: ["504"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.writes[0].operations;
  const kinds = opKinds(ops);
  assert.ok(kinds.indexOf("campaignAssetOperation") < kinds.indexOf("assetGroupOperation"));
  assert.deepEqual(creates(ops, "campaignAssetOperation").map((c) => [c.campaign, c.asset, c.fieldType]), [
    [rn("campaigns", CAMPAIGN_ID), rn("assets", "507"), "BUSINESS_NAME"],
    [rn("campaigns", CAMPAIGN_ID), rn("assets", "504"), "LOGO"],
  ]);
  assert.equal(kinds[kinds.length - 1], "assetGroupListingGroupFilterOperation");
});

test("create_asset_group: campanha que não é PMax (Demand Gen) é recusada sem gravar", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [pmaxCampaign({ advertisingChannelType: "DEMAND_GEN" })] }));
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /DEMAND_GEN, não PERFORMANCE_MAX/);
  assert.equal(writesOf(calls), 0);
});

test("create_asset_group: entrada inválida é recusada antes de qualquer chamada à API", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ campaignId: "abc" }, /campaignId deve ser numérico/],
    [{ headlines: Array.from({ length: 16 }, (_, i) => `Título ${i}`) }, /HEADLINE: 16 \(máximo 15\)/],
    [{ headlines: ["Um título com mais de trinta caracteres", "B", "C"] }, /tem 39 caracteres \(máximo 30\)/],
    [{ headlines: ["A", "A", "B"] }, /"A" repetido/],
    [{ finalUrl: "exemplo.com.br" }, /finalUrl inválida/],
    [{ path1: undefined, path2: "x" }, /path2 exige path1/],
    [{ marketingImageAssets: ["customers/9999999999/assets/501"] }, /pertence à conta 9999999999/],
    [{ businessName: "Loja", businessNameAsset: "507" }, /OU businessNameAsset/],
  ];
  for (const [override, expected] of cases) {
    const { client, calls } = fakeClient(account());
    const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE, ...override });
    assert.equal(result.isError, true, JSON.stringify(override));
    assert.match(textOf(result), expected);
    assert.equal(calls.queries.length, 0, `${JSON.stringify(override)} consultou a API`);
    assert.equal(writesOf(calls), 0);
  }
});

test("create_asset_group: mínimos da API conferidos antes de gravar (2 descrições, uma curta)", async () => {
  const oneDescription = fakeClient(account({ campaignAssets: brandedCampaignAssets() }));
  const r1 = await call(oneDescription.client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE, descriptions: ["Só uma."],
  });
  assert.match(textOf(r1), /DESCRIPTION: 1 \(mínimo 2/);
  assert.equal(writesOf(oneDescription.calls), 0);

  const noShort = fakeClient(account({ campaignAssets: brandedCampaignAssets() }));
  const r2 = await call(noShort.client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE,
    descriptions: ["Descrição longa número um que passa de sessenta caracteres com folga.", "Descrição longa número dois que também passa de sessenta caracteres."],
  });
  assert.match(textOf(r2), /SHORT_DESCRIPTION_REQUIRED/);
  assert.equal(writesOf(noShort.calls), 0);
});

test("create_asset_group: imagem na proporção errada, nome repetido e limite de 100 são recusados antes de gravar", async () => {
  const aspect = fakeClient(account({ campaignAssets: brandedCampaignAssets() }));
  const r1 = await call(aspect.client, "create_asset_group", {
    campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE, squareMarketingImageAssets: ["501"],
  });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /1200x628 .* SQUARE_MARKETING_IMAGE exige proporção 1:1/);
  assert.equal(writesOf(aspect.calls), 0);

  const dup = fakeClient(account({ groups: [group({ name: "G" })] }));
  const r2 = await call(dup.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.match(textOf(r2), /Já existe o asset group "G"/);
  assert.equal(writesOf(dup.calls), 0);

  const full = fakeClient(account({ groups: Array.from({ length: 100 }, (_, i) => group({ id: String(1000 + i), name: `G${i}` })) }));
  const r3 = await call(full.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "Novo", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.match(textOf(r3), /máximo 100/);
  assert.equal(writesOf(full.calls), 0);
});

/**
 * validateOnly por chamada nas duas tools de criação depende de CHAINED_WRITE_TOOLS (src/tool-kit.ts, fora
 * deste lote). Enquanto elas estiverem lá, o wrapper recusa sem enviar nada; quando o integrador tirá-las,
 * o mesmo teste passa a exigir o pedido atômico inteiro em dry-run. Os dois estados são seguros.
 */
async function assertPerCallValidateOnly(tool: "create_asset_group" | "create_pmax_campaign", state: Account, args: Row) {
  const { client, calls } = fakeClient(state);
  const result = await call(client, tool, { ...args, validateOnly: true });
  assert.match(textOf(result), /VALIDATE-ONLY/);
  if (CHAINED_WRITE_TOOLS.has(tool)) {
    assert.equal(result.isError, true);
    assert.match(textOf(result), new RegExp(`validateOnly não é suportado em ${tool}.*Nada foi enviado`, "s"));
    assert.equal(calls.queries.length, 0, "nada lido");
    assert.equal(writesOf(calls), 0, "nada enviado");
    return;
  }
  assert.equal(result.isError, undefined, textOf(result));
  assert.ok(calls.dryRunClones >= 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): a API validou o pedido inteiro — nada foi gravado/);
}

test("create_asset_group: validateOnly por chamada — recusado sem enviar nada enquanto estiver em CHAINED_WRITE_TOOLS", async () => {
  await assertPerCallValidateOnly("create_asset_group", account({ campaignAssets: brandedCampaignAssets() }),
    { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
});

test("create_asset_group: em dry-run (GOOGLE_ADS_DRY_RUN) valida o pedido atômico inteiro e não diz que criou", async () => {
  const { client, calls } = fakeClient(account({ campaignAssets: brandedCampaignAssets() }), { dryRun: true });
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].method, "batchMutate");
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): a API validou o pedido inteiro — nada foi gravado/);
  assert.match(textOf(result), /sem GOOGLE_ADS_DRY_RUN/);
  assert.doesNotMatch(textOf(result), /Asset group criado/);
  assert.equal((jsonOf(result).asset_group as Row).resource_name, "(validado, sem ID — nada gravado)");

  // Recusa da API em dry-run: nada gravado, sem conferir a conta
  const refused = fakeClient(account({ campaignAssets: brandedCampaignAssets() }), {
    dryRun: true,
    batchMutate: () => { throw new Error("Google Ads API: NOT_ENOUGH_LONG_HEADLINE"); },
  });
  const r2 = await call(refused.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): a API recusou — nada foi gravado/);
  assert.match(textOf(r2), /falta título longo \(LONG_HEADLINE\)/);
});

test("create_asset_group: campanha REMOVIDA é recusada sem gravar", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [pmaxCampaign({ status: "REMOVED" })], campaignAssets: brandedCampaignAssets() }));
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Campanha 111 \("PMax Leads"\) está removida\. Nada foi gravado/);
  assert.equal(writesOf(calls), 0);
  assert.ok(!calls.queries.some((q) => /FROM asset_group\b/.test(q)), "para antes de ler os asset groups");
});

test("create_asset_group: erro da API vira dica em PT-BR e a conta é conferida (nada gravado)", async () => {
  const state = account({ campaignAssets: brandedCampaignAssets() });
  const { client } = fakeClient(state, {
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Not enough marketing image asset for a valid asset group."); },
  });
  const result = await call(client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /nada foi gravado \(pedido atômico; conferido na conta\)/);
  assert.match(textOf(result), /falta imagem paisagem \(MARKETING_IMAGE/);

  // Erro de transporte depois de gravar: o grupo existe — não pode dizer "nada gravado"
  const written = fakeClient(state, {
    batchMutate: () => { state.groups.push(group({ id: "999", name: "G" })); throw new Error("fetch failed"); },
  });
  const r2 = await call(written.client, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /existe \(id 999\)/);
});

// ══ create_pmax_campaign ══════════════════════════════════════════════

const PMAX_ARGS: Row = {
  name: "PMax Nova", dailyBudgetMicros: 50_000_000, assetGroupName: "Grupo 1", finalUrl: "https://exemplo.com.br",
  ...CREATIVE, businessName: "Loja Exemplo", logoAssets: ["504", "509"], landscapeLogoAssets: ["505"],
};

test("create_pmax_campaign: tudo num único googleAds:mutate — textos com ID temporário, todos os logos na campanha, listing group e sinal no mesmo pedido", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [] }));
  const result = await call(client, "create_pmax_campaign", {
    ...PMAX_ARGS, merchantId: "777", audienceResourceName: rn("audiences", "55"),
    brandMainColor: "#112233", brandAccentColor: "#445566", brandFontFamily: "Roboto", portraitMarketingImageAssets: ["503"], callToAction: "LEARN_MORE",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1, "nenhuma chamada separada de mutateAssets / listing group / sinal");
  const ops = calls.writes[0].operations;
  const kinds = opKinds(ops);
  assert.equal(kinds[0], "campaignBudgetOperation");
  assert.equal(kinds[1], "campaignOperation");
  const firstCampaignAsset = kinds.indexOf("campaignAssetOperation");
  assert.ok(kinds.lastIndexOf("assetOperation") < firstCampaignAsset);
  assert.ok(kinds.lastIndexOf("campaignAssetOperation") < kinds.indexOf("assetGroupOperation"));
  const linkStart = kinds.indexOf("assetGroupAssetOperation");
  const linkEnd = kinds.lastIndexOf("assetGroupAssetOperation");
  assert.ok(kinds.slice(linkStart, linkEnd + 1).every((k) => k === "assetGroupAssetOperation"));
  assert.deepEqual(kinds.slice(linkEnd + 1), [
    "assetGroupListingGroupFilterOperation", "assetGroupSignalOperation", "campaignCriterionOperation", "campaignCriterionOperation",
  ]);

  const campaign = creates(ops, "campaignOperation")[0];
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.brandGuidelinesEnabled, true);
  assert.deepEqual(campaign.brandGuidelines, { mainColor: "#112233", accentColor: "#445566", predefinedFontFamily: "Roboto" });
  assert.deepEqual(campaign.shoppingSetting, { merchantId: "777" }, "sem feedLabel = todos os feeds (nada de 'BR' forçado)");
  const campaignLinks = creates(ops, "campaignAssetOperation");
  assert.deepEqual(campaignLinks.map((c) => c.fieldType), ["BUSINESS_NAME", "LOGO", "LOGO", "LANDSCAPE_LOGO"], "todos os logos, não só o primeiro");
  assert.ok(campaignLinks.every((c) => c.campaign === campaign.resourceName));
  const bnAsset = creates(ops, "assetOperation").find((a) => a.resourceName === campaignLinks[0].asset)!;
  assert.deepEqual(bnAsset.textAsset, { text: "Loja Exemplo" });

  const groupLinks = creates(ops, "assetGroupAssetOperation").map((l) => l.fieldType);
  assert.ok(!groupLinks.includes("LOGO") && !groupLinks.includes("BUSINESS_NAME"));
  assert.ok(groupLinks.includes("PORTRAIT_MARKETING_IMAGE") && groupLinks.includes("CALL_TO_ACTION_SELECTION"));
  const signal = creates(ops, "assetGroupSignalOperation")[0];
  assert.deepEqual(signal.audience, { audience: rn("audiences", "55") });
  assert.match(textOf(result), /Campanha PMax criada \(PAUSADA\)/);
});

test("create_pmax_campaign: contagens e regras de marca conferidas antes de qualquer chamada", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ descriptions: ["Só uma curta."] }, /DESCRIPTION: 1 \(mínimo 2/],
    [{ logoAssets: ["504", "509", "501", "502", "503"], landscapeLogoAssets: ["505"] }, /somam 6 \(máximo 5\)/],
    [{ logoAssets: [] }, /ao menos um logo/],
    [{ businessName: undefined }, /exatamente um nome da empresa/],
    [{ businessNameAsset: "507" }, /OU businessNameAsset/],
    [{ brandMainColor: "#112233" }, /vão juntas/],
    [{ brandMainColor: "azul", brandAccentColor: "#445566" }, /brandMainColor deve ser hex/],
    [{ biddingStrategy: "MAXIMIZE_CONVERSIONS", targetRoas: 4 }, /targetRoas só vale com MAXIMIZE_CONVERSION_VALUE/],
    [{ audienceResourceName: rn("userLists", "9") }, /audiences\/\{id\}/],
    [{ dailyBudgetMicros: 0 }, /dailyBudgetMicros deve ser um inteiro positivo/],
    [{ feedLabel: "BR" }, /feedLabel só vale com merchantId/],
  ];
  for (const [override, expected] of cases) {
    const { client, calls } = fakeClient(account({ campaigns: [] }));
    const result = await call(client, "create_pmax_campaign", { ...PMAX_ARGS, ...override });
    assert.equal(result.isError, true, JSON.stringify(override));
    assert.match(textOf(result), expected, JSON.stringify(override));
    assert.equal(calls.queries.length, 0);
    assert.equal(writesOf(calls), 0);
  }
});

test("create_pmax_campaign: varejo sem assets de grupo dispensa nome/logo; nome de campanha repetido é recusado", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [] }));
  const result = await call(client, "create_pmax_campaign", {
    name: "Varejo", dailyBudgetMicros: 80_000_000, assetGroupName: "Todos", finalUrl: "https://loja.com.br", merchantId: "777", feedLabel: "BR",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(opKinds(calls.writes[0].operations), [
    "campaignBudgetOperation", "campaignOperation", "assetGroupOperation", "assetGroupListingGroupFilterOperation",
    "campaignCriterionOperation", "campaignCriterionOperation",
  ]);
  assert.deepEqual(creates(calls.writes[0].operations, "campaignOperation")[0].shoppingSetting, { merchantId: "777", feedLabel: "BR" });

  const dup = fakeClient(account({ campaigns: [pmaxCampaign({ name: "PMax Nova" })] }));
  const r2 = await call(dup.client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Já existe a campanha "PMax Nova"/);
  assert.equal(writesOf(dup.calls), 0);
});

test("create_pmax_campaign: validateOnly por chamada — recusado sem enviar nada enquanto estiver em CHAINED_WRITE_TOOLS", async () => {
  await assertPerCallValidateOnly("create_pmax_campaign", account({ campaigns: [] }), PMAX_ARGS);
});

test("create_pmax_campaign: em dry-run (GOOGLE_ADS_DRY_RUN) valida o pedido inteiro e resposta sem IDs não vira erro", async () => {
  const { client, calls } = fakeClient(account({ campaigns: [] }), { dryRun: true });
  const result = await call(client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\): a API validou o pedido inteiro — nada foi gravado/);
  assert.doesNotMatch(textOf(result), /Campanha PMax criada/);
  const payload = jsonOf(result);
  assert.equal(payload.dry_run, true);
  assert.equal(payload.campaign, "(validado, sem ID — nada gravado)");

  const refused = fakeClient(account({ campaigns: [] }), {
    dryRun: true,
    batchMutate: () => { throw new Error("Google Ads API: REQUIRED_LOGO_ASSET_NOT_LINKED"); },
  });
  const r2 = await call(refused.client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): a API recusou — nada foi gravado/);
  assert.match(textOf(r2), /precisa de 1 nome da empresa e ao menos 1 logo vinculados na campanha/);
  assert.equal(refused.calls.queries.filter((q) => /FROM campaign\b/.test(q)).length, 1, "em dry-run não confere a conta de novo");
});

test("create_pmax_campaign: erro da API vira dica em PT-BR; 'nada gravado' só depois de conferir a conta", async () => {
  // Recusa da API: pedido atômico, conta conferida sem a campanha
  const state = account({ campaigns: [] });
  const refused = fakeClient(state, {
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — SHORT_DESCRIPTION_REQUIRED"); },
  });
  const r1 = await call(refused.client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /A API recusou a criação — nada foi gravado \(pedido atômico; conferido na conta\)/);
  assert.match(textOf(r1), /O que fazer:\n- inclua ao menos uma descrição com até 60 caracteres/);
  assert.equal(refused.calls.queries.filter((q) => /FROM campaign\b/.test(q)).length, 2, "nome repetido antes + conferência depois");

  // Erro de transporte depois de gravar: a campanha existe — não pode dizer "nada gravado"
  const written = fakeClient(state, {
    batchMutate: () => { state.campaigns.push(pmaxCampaign({ id: "4242", name: "PMax Nova", status: "PAUSED" })); throw new Error("fetch failed"); },
  });
  const r2 = await call(written.client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /a campanha "PMax Nova" existe \(id 4242\)/);
  assert.doesNotMatch(textOf(r2), /nada foi gravado/);

  // Sem conseguir conferir: resultado incerto
  const blind = fakeClient(account({ campaigns: [] }), { batchMutate: () => { throw new Error("socket hang up"); } });
  let reads = 0;
  const search = blind.client.searchStream as (c: string, q: string) => Promise<Row[]>;
  blind.client.searchStream = async (c: string, q: string) => {
    if (/FROM campaign\b/.test(q) && reads++ > 0) throw new Error("timeout");
    return search(c, q);
  };
  const r3 = await call(blind.client, "create_pmax_campaign", PMAX_ARGS);
  assert.equal(r3.isError, true);
  assert.match(textOf(r3), /resultado INCERTO/);
  assert.doesNotMatch(textOf(r3), /nada foi gravado/);
});

// ══ update_asset_group ════════════════════════════════════════════════

test("update_asset_group: URL mobile e path1/path2 com updateMask só do que muda, antes/depois", async () => {
  const { client, calls } = fakeClient(account({ groups: [group({ path1: "velho" })] }));
  const result = await call(client, "update_asset_group", {
    assetGroupId: GROUP_ID, finalUrl: "https://exemplo.com.br", finalMobileUrl: "https://m.exemplo.com.br", path1: "novo", path2: "sub",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.resource, "assetGroups");
  const op = write.operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "final_mobile_urls,path1,path2", "final_urls igual não entra");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update, { resourceName: rn("assetGroups", GROUP_ID), finalMobileUrls: ["https://m.exemplo.com.br"], path1: "novo", path2: "sub" });
  const payload = jsonOf(result);
  assert.deepEqual(payload.before, { final_mobile_urls: [], path1: "velho", path2: "" });
});

test("update_asset_group: sem mudança não grava; path2 sem path1, grupo inexistente e nome repetido são recusados", async () => {
  const same = fakeClient(account({ groups: [group()] }));
  const r1 = await call(same.client, "update_asset_group", { assetGroupId: GROUP_ID, status: "ENABLED", name: "Grupo A" });
  assert.match(textOf(r1), /nada a mudar/);
  assert.equal(writesOf(same.calls), 0);

  const path = fakeClient(account({ groups: [group()] }));
  const r2 = await call(path.client, "update_asset_group", { assetGroupId: GROUP_ID, path2: "x" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /path2 exige path1/);
  assert.equal(writesOf(path.calls), 0);

  const missing = fakeClient(account());
  const r3 = await call(missing.client, "update_asset_group", { assetGroupId: GROUP_ID, status: "PAUSED" });
  assert.match(textOf(r3), /não encontrado/);

  const clash = fakeClient(account({ groups: [group(), group({ id: "333", name: "Outro" })] }));
  const r4 = await call(clash.client, "update_asset_group", { assetGroupId: GROUP_ID, name: "Outro" });
  assert.match(textOf(r4), /Já existe o asset group "Outro"/);
  assert.equal(writesOf(clash.calls), 0);

  const bad = fakeClient(account());
  const r5 = await call(bad.client, "update_asset_group", { assetGroupId: "abc", status: "PAUSED" });
  assert.equal(r5.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("update_asset_group: validateOnly valida em dry-run e não diz que atualizou", async () => {
  const { client, calls } = fakeClient(account({ groups: [group()] }));
  const result = await call(client, "update_asset_group", { assetGroupId: GROUP_ID, status: "PAUSED", validateOnly: true });
  assert.equal(result.isError, undefined, textOf(result));
  assert.ok(calls.dryRunClones >= 1);
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].resource, "assetGroups");
  assert.equal(calls.writes[0].dryRun, true);
  assert.equal((calls.writes[0].operations[0] as { updateMask: string }).updateMask, "status");
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /Asset group 222 — DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(result), /atualizado/);
});

test("update_asset_group: erro da API vira dica em PT-BR, com 'nada foi gravado' (e 'validação' em dry-run)", async () => {
  const failing = { mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — DUPLICATE_NAME"); } };
  const real = fakeClient(account({ groups: [group()] }), failing);
  const r1 = await call(real.client, "update_asset_group", { assetGroupId: GROUP_ID, status: "PAUSED" });
  assert.equal(r1.isError, true);
  assert.equal(real.calls.writes.length, 1);
  assert.match(textOf(r1), /A API recusou a alteração — nada foi gravado\./);
  assert.match(textOf(r1), /O que fazer:\n- já existe um asset group com esse nome na campanha/);
  assert.doesNotMatch(textOf(r1), /atualizado/);

  const dry = fakeClient(account({ groups: [group()] }), failing);
  const r2 = await call(dry.client, "update_asset_group", { assetGroupId: GROUP_ID, status: "PAUSED", validateOnly: true });
  assert.equal(r2.isError, true);
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r2), /A API recusou a alteração \(validação, nada gravado\)/);
});

test("update_asset_group: a descrição não manda mais usar run_gaql para mutar", () => {
  const { configs } = register(fakeClient(account()).client);
  const description = String(configs.get("update_asset_group")!.description);
  assert.doesNotMatch(description, /run_gaql/);
  assert.match(description, /update_asset_group_assets/);
});

// ══ list_asset_groups / list_asset_group_assets ══════════════════════

test("list_asset_groups: motivos de status em PT-BR e itens de cobertura legíveis", async () => {
  const state = account({
    groups: [group({
      primaryStatus: "NOT_ELIGIBLE", primaryStatusReasons: ["CAMPAIGN_PAUSED"],
      assetCoverage: { adStrengthActionItems: [
        { actionItemType: "ADD_ASSET", addAssetDetails: { assetFieldType: "HEADLINE", assetCount: 3 } },
        { actionItemType: "ADD_ASSET", addAssetDetails: { assetFieldType: "YOUTUBE_VIDEO", assetCount: 1, videoAspectRatioRequirement: "VERTICAL" } },
      ] },
    })],
  });
  const { client, calls } = fakeClient(state);
  const result = await call(client, "list_asset_groups", { campaignId: CAMPAIGN_ID });
  const [first] = jsonOf(result) as unknown as Row[];
  assert.deepEqual(first.primary_status_reasons, ["CAMPAIGN_PAUSED — campanha pausada"]);
  assert.deepEqual(first.coverage_actions, ["adicionar 3 HEADLINE", "adicionar 1 YOUTUBE_VIDEO (vertical 9:16)"]);
  assert.match(calls.queries[0], /asset_group\.asset_coverage\.ad_strength_action_items/);

  const table = await call(client, "list_asset_groups", { campaignId: CAMPAIGN_ID, format: "csv" });
  assert.match(textOf(table), /coverage_actions/);
  const bad = await call(client, "list_asset_groups", { campaignId: "1 OR 1=1" });
  assert.equal(bad.isError, true);
});

test("list_asset_group_assets: contagem contra mínimo/máximo, marca contada na campanha e assets por tipo", async () => {
  const { assets, links } = fullGroupAssets();
  const state = account({
    groups: [group({ assetCoverage: { adStrengthActionItems: [{ actionItemType: "ADD_ASSET", addAssetDetails: { assetFieldType: "HEADLINE", assetCount: 2 } }] } })],
    assets: [...library(), ...assets],
    links: [...links, link(GROUP_ID, "506", "YOUTUBE_VIDEO", { source: "AUTOMATICALLY_CREATED" })],
    campaignAssets: brandedCampaignAssets(),
  });
  const { client } = fakeClient(state);
  const result = await call(client, "list_asset_group_assets", { assetGroupId: GROUP_ID });
  assert.equal(result.isError, undefined, textOf(result));
  const [report] = jsonOf(result) as unknown as Row[];
  const reqs = report.requirements as Row[];
  const byField = (f: string) => reqs.find((r) => r.field_type === f)!;
  assert.deepEqual(byField("HEADLINE"), { field_type: "HEADLINE", level: "asset group", linked: 3, min: 3, max: 15, situation: "ok" });
  assert.equal(byField("BUSINESS_NAME").level, "campanha (diretrizes de marca)");
  assert.equal(byField("BUSINESS_NAME").linked, 1);
  assert.equal(byField("LOGO").max, 5);
  assert.equal(byField("YOUTUBE_VIDEO").linked, 0, "criado automaticamente não conta para o mínimo");
  assert.equal(byField("YOUTUBE_VIDEO").automatically_created, 1);
  assert.equal(report.short_description_ok, true);
  assert.deepEqual(report.coverage_actions, ["adicionar 2 HEADLINE"]);
  assert.equal(((report.assets as Row).HEADLINE as Row[]).length, 3);

  const csv = await call(client, "list_asset_group_assets", { campaignId: CAMPAIGN_ID, format: "csv", fieldTypes: ["HEADLINE"] });
  assert.equal(textOf(csv).split("\n").length, 4, "cabeçalho + 3 títulos");
});

test("list_asset_group_assets: exige exatamente um ID numérico, sem consultar a API", async () => {
  for (const args of [{}, { assetGroupId: GROUP_ID, campaignId: CAMPAIGN_ID }, { assetGroupId: "x;DROP" }, { assetGroupId: GROUP_ID, fieldTypes: ["NOPE"] }]) {
    const { client, calls } = fakeClient(account());
    const result = await call(client, "list_asset_group_assets", args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls.queries.length, 0);
  }
});

// ══ update_asset_group_assets ═════════════════════════════════════════

function fullAccount(overrides: Partial<Account> = {}): Account {
  const { assets, links } = fullGroupAssets();
  return account({ groups: [group()], assets: [...library(), ...assets], links, campaignAssets: brandedCampaignAssets(), ...overrides });
}

test("update_asset_group_assets: troca atômica — cria o texto, vincula os novos e só depois remove, num googleAds:mutate", async () => {
  const { client, calls } = fakeClient(fullAccount());
  const result = await call(client, "update_asset_group_assets", {
    assetGroupIds: [GROUP_ID],
    add: [{ fieldType: "MARKETING_IMAGE", asset: "508" }, { fieldType: "HEADLINE", text: "Novo título" }],
    remove: [{ fieldType: "MARKETING_IMAGE", asset: "501" }],
    confirm: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes.length, 1);
  const ops = calls.writes[0].operations;
  assert.deepEqual(opKinds(ops), ["assetOperation", "assetGroupAssetOperation", "assetGroupAssetOperation", "assetGroupAssetOperation"]);
  const textRn = creates(ops, "assetOperation")[0].resourceName;
  const linkCreates = creates(ops, "assetGroupAssetOperation");
  assert.deepEqual(linkCreates.map((l) => [l.asset, l.fieldType]), [[rn("assets", "508"), "MARKETING_IMAGE"], [textRn, "HEADLINE"]]);
  assert.ok(linkCreates.every((l) => l.assetGroup === rn("assetGroups", GROUP_ID)));
  assert.deepEqual((ops[3].assetGroupAssetOperation as Row).remove, rn("assetGroupAssets", `${GROUP_ID}~501~MARKETING_IMAGE`));
});

test("update_asset_group_assets: remoção que deixaria o grupo abaixo do mínimo é recusada antes de gravar", async () => {
  const cases: Array<[Row, RegExp]> = [
    [{ remove: [{ fieldType: "MARKETING_IMAGE", asset: "501" }] }, /MARKETING_IMAGE ficaria com 0 \(mínimo 1\)/],
    [{ remove: [{ fieldType: "HEADLINE", asset: "601" }] }, /HEADLINE ficaria com 2 \(mínimo 3\)/],
    [{ remove: [{ fieldType: "DESCRIPTION", asset: "605" }], add: [{ fieldType: "DESCRIPTION", text: "Outra descrição comprida que passa com folga do limite de sessenta." }] },
      /única descrição com até 60/],
    [{ add: Array.from({ length: 13 }, (_, i) => ({ fieldType: "HEADLINE", text: `Extra ${i}` })) }, /HEADLINE ficaria com 16 \(máximo 15\)/],
    [{ add: [{ fieldType: "BUSINESS_NAME", text: "Outra Loja" }] }, /diretrizes de marca LIGADAS/],
    [{ add: [{ fieldType: "SQUARE_MARKETING_IMAGE", asset: "501" }] }, /exige proporção 1:1/],
  ];
  for (const [override, expected] of cases) {
    const { client, calls } = fakeClient(fullAccount());
    const result = await call(client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], confirm: true, ...override });
    assert.equal(result.isError, true, JSON.stringify(override));
    assert.match(textOf(result), expected);
    assert.equal(writesOf(calls), 0, JSON.stringify(override));
  }
});

test("update_asset_group_assets: remoção sem confirm mostra o plano e não grava; só adição num grupo grava direto", async () => {
  const preview = fakeClient(fullAccount());
  const r1 = await call(preview.client, "update_asset_group_assets", {
    assetGroupIds: [GROUP_ID], add: [{ fieldType: "MARKETING_IMAGE", asset: "508" }], remove: [{ fieldType: "MARKETING_IMAGE", asset: "501" }],
  });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /NADA foi gravado/);
  assert.equal(writesOf(preview.calls), 0);

  const addOnly = fakeClient(fullAccount());
  const r2 = await call(addOnly.client, "update_asset_group_assets", { assetGroupIds: GROUP_ID, add: [{ fieldType: "PORTRAIT_MARKETING_IMAGE", asset: "503" }] });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(addOnly.calls.writes.length, 1);
});

test("update_asset_group_assets: o que já está vinculado não é reenviado (sem escrita)", async () => {
  const { client, calls } = fakeClient(fullAccount());
  const result = await call(client, "update_asset_group_assets", {
    assetGroupIds: [GROUP_ID], add: [{ fieldType: "MARKETING_IMAGE", asset: "501" }, { fieldType: "HEADLINE", text: "Título um" }],
  });
  assert.match(textOf(result), /Nada a mudar/);
  assert.equal(writesOf(calls), 0);
});

test("update_asset_group_assets: vários asset groups exigem confirm e compartilham o asset de texto criado", async () => {
  const one = fullGroupAssets(GROUP_ID);
  const two = fullGroupAssets("333");
  const state = account({
    groups: [group(), group({ id: "333", name: "Grupo B" })],
    assets: [...library(), ...one.assets], links: [...one.links, ...two.links], campaignAssets: brandedCampaignAssets(),
  });
  const args = { assetGroupIds: [GROUP_ID, "333"], add: [{ fieldType: "HEADLINE", text: "Oferta da semana" }] };
  const preview = fakeClient(state);
  const r1 = await call(preview.client, "update_asset_group_assets", args);
  assert.match(textOf(r1), /exigem confirm: true/);
  assert.equal(writesOf(preview.calls), 0);

  const { client, calls } = fakeClient(state);
  const r2 = await call(client, "update_asset_group_assets", { ...args, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  const ops = calls.writes[0].operations;
  assert.deepEqual(opKinds(ops), ["assetOperation", "assetGroupAssetOperation", "assetGroupAssetOperation"]);
  const textRn = creates(ops, "assetOperation")[0].resourceName;
  assert.deepEqual(creates(ops, "assetGroupAssetOperation").map((l) => [l.assetGroup, l.asset]), [
    [rn("assetGroups", GROUP_ID), textRn], [rn("assetGroups", "333"), textRn],
  ]);
});

test("update_asset_group_assets: grupo de varejo sem assets só aceita o conjunto mínimo completo", async () => {
  const state = account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" }, brandGuidelinesEnabled: false })], groups: [group()] });
  const partial = fakeClient(state);
  const r1 = await call(partial.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add: [{ fieldType: "HEADLINE", text: "Só um" }] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /hoje sem assets/);
  assert.equal(writesOf(partial.calls), 0);

  const full = fakeClient(state);
  const add = [
    ...["Um", "Dois", "Três"].map((t) => ({ fieldType: "HEADLINE", text: t })),
    { fieldType: "LONG_HEADLINE", text: "Título longo" },
    { fieldType: "DESCRIPTION", text: "Curta." }, { fieldType: "DESCRIPTION", text: "Outra curta." },
    { fieldType: "MARKETING_IMAGE", asset: "501" }, { fieldType: "SQUARE_MARKETING_IMAGE", asset: "502" },
    { fieldType: "BUSINESS_NAME", asset: "507" }, { fieldType: "LOGO", asset: "504" },
  ];
  const r2 = await call(full.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(creates(full.calls.writes[0].operations, "assetGroupAssetOperation").length, 10);
});

test("update_asset_group_assets: varejo com diretrizes de marca e campanha sem nome/logo — primeiro envio de assets é recusado", async () => {
  const add = [
    ...["Um", "Dois", "Três"].map((t) => ({ fieldType: "HEADLINE", text: t })),
    { fieldType: "LONG_HEADLINE", text: "Título longo" },
    { fieldType: "DESCRIPTION", text: "Curta." }, { fieldType: "DESCRIPTION", text: "Outra curta." },
    { fieldType: "MARKETING_IMAGE", asset: "501" }, { fieldType: "SQUARE_MARKETING_IMAGE", asset: "502" },
  ];
  const noBrand = fakeClient(account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" } })], groups: [group()] }));
  const r1 = await call(noBrand.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /ainda não tem nome da empresa e logo/);
  assert.equal(writesOf(noBrand.calls), 0);

  const branded = fakeClient(account({ campaigns: [pmaxCampaign({ shoppingSetting: { merchantId: "777" } })], groups: [group()], campaignAssets: brandedCampaignAssets() }));
  const r2 = await call(branded.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.equal(branded.calls.writes.length, 1);
});

test("update_asset_group_assets: remover vínculo criado automaticamente avisa que a API pode recusar", async () => {
  const state = fullAccount();
  state.links.push(link(GROUP_ID, "602", "DESCRIPTION", { source: "AUTOMATICALLY_CREATED" }));
  const { client } = fakeClient(state);
  const result = await call(client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], remove: [{ fieldType: "DESCRIPTION", asset: "602" }] });
  assert.match(textOf(result), /criado automaticamente pelo Google/);
});

test("update_asset_group_assets: erro na escrita confere a conta — só diz 'nada gravado' quando nada mudou", async () => {
  const rejected = fakeClient(fullAccount(), {
    batchMutate: () => { throw new Error("Google Ads API: The image asset provided is not within the dimension constraints."); },
  });
  const r1 = await call(rejected.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add: [{ fieldType: "MARKETING_IMAGE", asset: "508" }] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /nada foi gravado \(pedido atômico; conferido na conta\)/);
  assert.match(textOf(r1), /fora das dimensões mínimas/);

  const state = fullAccount();
  const written = fakeClient(state, {
    batchMutate: () => { state.links.push(link(GROUP_ID, "508", "MARKETING_IMAGE")); throw new Error("fetch failed"); },
  });
  const r2 = await call(written.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add: [{ fieldType: "MARKETING_IMAGE", asset: "508" }] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /os vínculos mudaram na conta/);
});

test("update_asset_group_assets: validateOnly valida sem confirm, em dry-run", async () => {
  const { client, calls } = fakeClient(fullAccount());
  const result = await call(client, "update_asset_group_assets", {
    assetGroupIds: [GROUP_ID], add: [{ fieldType: "MARKETING_IMAGE", asset: "508" }], remove: [{ fieldType: "MARKETING_IMAGE", asset: "501" }], validateOnly: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /nada foi gravado/);
});

test("update_asset_group_assets: entrada inválida e grupo inexistente não chegam à escrita", async () => {
  const bad = fakeClient(fullAccount());
  const r1 = await call(bad.client, "update_asset_group_assets", { assetGroupIds: [GROUP_ID], add: [{ fieldType: "HEADLINE", text: "x", asset: "501" }] });
  assert.match(textOf(r1), /exatamente um entre asset, text e callToAction/);
  assert.equal(bad.calls.queries.length, 0);

  const missing = fakeClient(fullAccount());
  const r2 = await call(missing.client, "update_asset_group_assets", { assetGroupIds: ["999"], add: [{ fieldType: "HEADLINE", text: "x" }] });
  assert.match(textOf(r2), /asset group 999 não existe/);
  assert.equal(writesOf(missing.calls), 0);
});

// ══ update_display_ad / update_demand_gen_ad ══════════════════════════

function displayAd(info: Row = {}): Row {
  return {
    id: "700", type: "RESPONSIVE_DISPLAY_AD", key: "responsiveDisplayAd", campaignId: CAMPAIGN_ID,
    info: {
      marketingImages: [{ asset: rn("assets", "501") }], squareMarketingImages: [{ asset: rn("assets", "502") }],
      headlines: [{ text: "Título" }], longHeadline: { text: "Título longo" }, descriptions: [{ text: "Descrição" }],
      businessName: "Loja", allowFlexibleColor: true, ...info,
    },
  };
}

test("update_display_ad: trocar imagem manda só a lista nova com updateMask aninhado", async () => {
  const { client, calls } = fakeClient(account({ ads: [displayAd()] }));
  const result = await call(client, "update_display_ad", {
    adId: "700",
    removeAssets: [{ field: "MARKETING_IMAGES", asset: "501" }], addAssets: [{ field: "MARKETING_IMAGES", asset: rn("assets", "508") }],
    longHeadline: "Novo título longo",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const write = calls.writes[0];
  assert.equal(write.resource, "ads");
  const op = write.operations[0] as { update: Row; updateMask: string };
  assert.equal(op.updateMask, "responsive_display_ad.marketing_images,responsive_display_ad.long_headline.text");
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.update, {
    resourceName: rn("ads", "700"),
    responsiveDisplayAd: { marketingImages: [{ asset: rn("assets", "508") }], longHeadline: { text: "Novo título longo" } },
  });
  const payload = jsonOf(result);
  assert.deepEqual((payload.before as Row).MARKETING_IMAGES, [rn("assets", "501")]);
  assert.deepEqual((payload.after as Row).MARKETING_IMAGES, [rn("assets", "508")]);
});

test("update_display_ad: sem mudança não grava; proporção, cores e tipo de anúncio errados são recusados", async () => {
  const same = fakeClient(account({ ads: [displayAd()] }));
  const r1 = await call(same.client, "update_display_ad", { adId: "700", addAssets: [{ field: "MARKETING_IMAGES", asset: "501" }], businessName: "Loja" });
  assert.match(textOf(r1), /nada a mudar/);
  assert.equal(writesOf(same.calls), 0);

  const aspect = fakeClient(account({ ads: [displayAd()] }));
  const r2 = await call(aspect.client, "update_display_ad", { adId: "700", addAssets: [{ field: "MARKETING_IMAGES", asset: "502" }] });
  assert.match(textOf(r2), /MARKETING_IMAGES exige proporção 1.91:1/);
  assert.equal(writesOf(aspect.calls), 0);

  const color = fakeClient(account({ ads: [displayAd()] }));
  const r3 = await call(color.client, "update_display_ad", { adId: "700", mainColor: "#112233" });
  assert.match(textOf(r3), /mainColor e accentColor vão juntas/);
  assert.equal(writesOf(color.calls), 0);

  const imageAd = fakeClient(account({ ads: [{ id: "701", type: "IMAGE_AD", key: "imageAd", info: {}, campaignId: CAMPAIGN_ID }] }));
  const r4 = await call(imageAd.client, "update_display_ad", { adId: "701", headlines: ["X"] });
  assert.match(textOf(r4), /AdService não permite editar .*ImageAd/);
  assert.equal(writesOf(imageAd.calls), 0);

  const empty = fakeClient(account({ ads: [displayAd()] }));
  const r5 = await call(empty.client, "update_display_ad", { adId: "700", removeAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "502" }] });
  assert.match(textOf(r5), /SQUARE_MARKETING_IMAGES: ficaria com 0 \(mínimo 1\)/);
  assert.equal(writesOf(empty.calls), 0);
});

test("update_demand_gen_ad: multi-asset e carrossel com caminhos certos; campo de outro formato é recusado", async () => {
  const multi = {
    id: "800", type: "DEMAND_GEN_MULTI_ASSET_AD", key: "demandGenMultiAssetAd", campaignId: CAMPAIGN_ID,
    info: { marketingImages: [{ asset: rn("assets", "501") }], logoImages: [{ asset: rn("assets", "504") }], headlines: [{ text: "A" }], descriptions: [{ text: "D" }] },
  };
  const carousel = {
    id: "801", type: "DEMAND_GEN_CAROUSEL_AD", key: "demandGenCarouselAd", campaignId: CAMPAIGN_ID,
    info: { headline: { text: "Velho" }, carouselCards: [{ asset: rn("assets", "511") }, { asset: rn("assets", "512") }] },
  };
  const { client, calls } = fakeClient(account({ ads: [multi, carousel] }));
  const r1 = await call(client, "update_demand_gen_ad", {
    adId: "800", addAssets: [{ field: "PORTRAIT_MARKETING_IMAGES", asset: "503" }], headlines: ["A", "B"],
  });
  assert.equal(r1.isError, undefined, textOf(r1));
  const op1 = calls.writes[0].operations[0] as { update: Row; updateMask: string };
  assert.equal(op1.updateMask, "demand_gen_multi_asset_ad.portrait_marketing_images,demand_gen_multi_asset_ad.headlines");
  assert.deepEqual((op1.update.demandGenMultiAssetAd as Row).headlines, [{ text: "A" }, { text: "B" }]);

  const r2 = await call(client, "update_demand_gen_ad", { adId: "801", headline: "Novo" });
  assert.equal(r2.isError, undefined, textOf(r2));
  const op2 = calls.writes[1].operations[0] as { update: Row; updateMask: string };
  assert.equal(op2.updateMask, "demand_gen_carousel_ad.headline.text");
  assertUpdateMaskLeaves(op2.updateMask);
  assert.deepEqual(op2.update.demandGenCarouselAd, { headline: { text: "Novo" } });

  const r3 = await call(client, "update_demand_gen_ad", { adId: "800", addAssets: [{ field: "VIDEOS", asset: "506" }] });
  assert.match(textOf(r3), /VIDEOS não existe em DEMAND_GEN_MULTI_ASSET_AD/);
  const r4 = await call(client, "update_demand_gen_ad", { adId: "800", headline: "x" });
  assert.match(textOf(r4), /headline não se aplica a DEMAND_GEN_MULTI_ASSET_AD/);
  assert.equal(calls.writes.length, 2);
});

/** n imagens fictícias já no anúncio (não são relidas: só os assets novos são conferidos na API). */
const existingImages = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ asset: rn("assets", `${prefix}${i}`) }));

test("update_display_ad: MARKETING + SQUARE somam no máximo 15 e logos no máximo 5 (limites do proto)", async () => {
  // 7 + 7 = 14: a 15ª imagem entra
  const at14 = fakeClient(account({ ads: [displayAd({ marketingImages: existingImages("81", 7), squareMarketingImages: existingImages("82", 7) })] }));
  const r1 = await call(at14.client, "update_display_ad", { adId: "700", addAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "509" }] });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.equal(writesOf(at14.calls), 1);

  // 8 + 7 = 15: a 16ª é recusada antes de gravar
  const at15 = fakeClient(account({ ads: [displayAd({ marketingImages: existingImages("81", 8), squareMarketingImages: existingImages("82", 7) })] }));
  const r2 = await call(at15.client, "update_display_ad", { adId: "700", addAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "509" }] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /MARKETING_IMAGES \+ SQUARE_MARKETING_IMAGES: ficaria com 16 \(máximo 15 somando as listas\)/);
  assert.equal(writesOf(at15.calls), 0);

  // Trocar (remove + add) com 15 não passa do limite
  const swap = fakeClient(account({ ads: [displayAd({ marketingImages: existingImages("81", 8), squareMarketingImages: [...existingImages("82", 6), { asset: rn("assets", "502") }] })] }));
  const r3 = await call(swap.client, "update_display_ad", {
    adId: "700", removeAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "502" }], addAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "509" }],
  });
  assert.equal(r3.isError, undefined, textOf(r3));

  // Logos: 3 paisagem + 2 quadrados = 5; o 6º é recusado
  const logos = fakeClient(account({ ads: [displayAd({ logoImages: existingImages("83", 3), squareLogoImages: existingImages("84", 2) })] }));
  const r4 = await call(logos.client, "update_display_ad", { adId: "700", addAssets: [{ field: "SQUARE_LOGO_IMAGES", asset: "504" }] });
  assert.equal(r4.isError, true);
  assert.match(textOf(r4), /LOGO_IMAGES \+ SQUARE_LOGO_IMAGES: ficaria com 6 \(máximo 5 somando as listas\)/);
  assert.equal(writesOf(logos.calls), 0);
});

test("update_display_ad: erro da API vira dica em PT-BR e 'nada foi gravado'; validateOnly não diz que atualizou", async () => {
  const failing = { mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — ASPECT_RATIO_NOT_ALLOWED"); } };
  const refused = fakeClient(account({ ads: [displayAd()] }), failing);
  const r1 = await call(refused.client, "update_display_ad", { adId: "700", addAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "509" }] });
  assert.equal(r1.isError, true);
  assert.equal(refused.calls.writes.length, 1);
  assert.match(textOf(r1), /A API recusou a alteração do anúncio 700 — nada foi gravado\./);
  assert.match(textOf(r1), /O que fazer:\n- proporção da imagem não aceita no campo/);
  assert.doesNotMatch(textOf(r1), /atualizado/);

  const dryFail = fakeClient(account({ ads: [displayAd()] }), failing);
  const r2 = await call(dryFail.client, "update_display_ad", { adId: "700", headlines: ["Novo"], validateOnly: true });
  assert.equal(r2.isError, true);
  assert.equal(dryFail.calls.writes[0].dryRun, true);
  assert.match(textOf(r2), /A API recusou a alteração do anúncio 700 \(validação, nada gravado\)/);

  const dry = fakeClient(account({ ads: [displayAd()] }));
  const r3 = await call(dry.client, "update_display_ad", { adId: "700", headlines: ["Novo"], validateOnly: true });
  assert.equal(r3.isError, undefined, textOf(r3));
  assert.equal(dry.calls.writes[0].dryRun, true);
  assert.match(textOf(r3), /anúncio display responsivo 700 — DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  assert.doesNotMatch(textOf(r3), /atualizado/);
});

test("update_demand_gen_ad: imagens do multi-asset somam no máximo 20; erro da API vira dica e 'nada foi gravado'", async () => {
  const multi = (images: Row) => ({
    id: "800", type: "DEMAND_GEN_MULTI_ASSET_AD", key: "demandGenMultiAssetAd", campaignId: CAMPAIGN_ID,
    info: { logoImages: [{ asset: rn("assets", "504") }], headlines: [{ text: "A" }], descriptions: [{ text: "D" }], ...images },
  });
  // 10 + 9 = 19: a 20ª entra
  const at19 = fakeClient(account({ ads: [multi({ marketingImages: existingImages("81", 10), squareMarketingImages: existingImages("82", 9) })] }));
  const r1 = await call(at19.client, "update_demand_gen_ad", { adId: "800", addAssets: [{ field: "PORTRAIT_MARKETING_IMAGES", asset: "503" }] });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.equal(writesOf(at19.calls), 1);

  // 10 + 10 = 20: a 21ª (retrato) é recusada antes de gravar
  const at20 = fakeClient(account({ ads: [multi({ marketingImages: existingImages("81", 10), squareMarketingImages: existingImages("82", 10) })] }));
  const r2 = await call(at20.client, "update_demand_gen_ad", { adId: "800", addAssets: [{ field: "PORTRAIT_MARKETING_IMAGES", asset: "503" }] });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /MARKETING \+ SQUARE \+ PORTRAIT \+ TALL_PORTRAIT: ficaria com 21 \(máximo 20 somando as listas\)/);
  assert.equal(writesOf(at20.calls), 0);

  const refused = fakeClient(account({ ads: [multi({ marketingImages: [{ asset: rn("assets", "501") }] })] }), {
    mutate: () => { throw new Error("Google Ads API: FIELD_HAS_SUBFIELDS"); },
  });
  const r3 = await call(refused.client, "update_demand_gen_ad", { adId: "800", headlines: ["A", "B"] });
  assert.equal(r3.isError, true);
  assert.equal(refused.calls.writes.length, 1);
  assert.match(textOf(r3), /A API recusou a alteração do anúncio 800 — nada foi gravado\./);
  assert.match(textOf(r3), /O que fazer:\n- updateMask nomeou uma mensagem inteira/);
});

// ══ unlink_campaign_image_assets ══════════════════════════════════════

function searchWithImages(): Account {
  return account({
    campaigns: [pmaxCampaign({ advertisingChannelType: "SEARCH" })],
    campaignAssets: [
      { campaignId: CAMPAIGN_ID, assetId: "502", fieldType: "AD_IMAGE", status: "ENABLED" },
      { campaignId: CAMPAIGN_ID, assetId: "509", fieldType: "AD_IMAGE", status: "PAUSED" },
    ],
  });
}

test("unlink_campaign_image_assets: sem confirm mostra o plano; com confirm remove com partial failure", async () => {
  const preview = fakeClient(searchWithImages());
  const r1 = await call(preview.client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["502"] });
  assert.match(textOf(r1), /NADA foi gravado/);
  assert.equal(writesOf(preview.calls), 0);

  const { client, calls } = fakeClient(searchWithImages());
  const r2 = await call(client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["502", rn("assets", "509"), "501"], confirm: true });
  assert.equal(r2.isError, false, textOf(r2));
  const write = calls.writes[0];
  assert.equal(write.method, "mutateCampaignAssets");
  assert.deepEqual(write.options, { partialFailure: true });
  assert.deepEqual(write.operations, [
    { remove: rn("campaignAssets", `${CAMPAIGN_ID}~502~AD_IMAGE`) },
    { remove: rn("campaignAssets", `${CAMPAIGN_ID}~509~AD_IMAGE`) },
  ]);
  const payload = jsonOf(r2);
  assert.equal((payload.removed as Row[]).length, 2);
  assert.deepEqual((payload.not_linked as Row[]).map((r) => r.asset_id), ["501"]);
});

test("unlink_campaign_image_assets: nada vinculado não grava; referência de outra conta é recusada sem consultar", async () => {
  const none = fakeClient(searchWithImages());
  const r1 = await call(none.client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["501"], confirm: true });
  assert.match(textOf(r1), /Nenhuma escrita foi enviada/);
  assert.equal(writesOf(none.calls), 0);

  const foreign = fakeClient(searchWithImages());
  const r2 = await call(foreign.client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["customers/9999999999/assets/502"], confirm: true });
  assert.equal(r2.isError, true);
  assert.equal(foreign.calls.queries.length, 0);

  const partial = fakeClient(searchWithImages(), {
    mutate: () => ({
      results: [{}, { resourceName: "ok" }],
      partialFailureError: { details: [{ errors: [{ message: "Resource not found.", location: { fieldPathElements: [{ fieldName: "operations", index: 0 }] } }] }] },
    }),
  });
  const r3 = await call(partial.client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["502", "509"], confirm: true });
  assert.equal(r3.isError, true);
  const payload = jsonOf(r3);
  assert.equal((payload.errors as Row[])[0].asset_id, "502");
  assert.equal((payload.removed as Row[])[0].asset_id, "509");
});

test("unlink_campaign_image_assets: validateOnly valida sem confirm, em dry-run, e não diz que removeu", async () => {
  const { client, calls } = fakeClient(searchWithImages());
  const result = await call(client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["502", "509"], validateOnly: true });
  assert.equal(result.isError, false, textOf(result));
  assert.ok(calls.dryRunClones >= 1);
  assert.equal(calls.writes.length, 1, "validateOnly não para no plano: a API valida as remoções");
  assert.equal(calls.writes[0].method, "mutateCampaignAssets");
  assert.equal(calls.writes[0].dryRun, true);
  assert.match(textOf(result), /VALIDATE-ONLY/);
  assert.match(textOf(result), /Campanha 111 — DRY-RUN \(validateOnly\): nada foi gravado\. Validadas: 2 \| Com erro: 0/);
  assert.doesNotMatch(textOf(result), /vínculos? removidos?/);
  const payload = jsonOf(result);
  assert.equal(payload.dry_run, true);
  assert.equal((payload.validated as Row[]).length, 2);
  assert.equal(payload.removed, undefined);

  // Recusa da API em validateOnly: nada gravado
  const refused = fakeClient(searchWithImages(), { mutate: () => { throw new Error("Google Ads API: Resource not found."); } });
  const r2 = await call(refused.client, "unlink_campaign_image_assets", { campaignId: CAMPAIGN_ID, assetResourceNames: ["502"], confirm: true, validateOnly: true });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /DRY-RUN \(validateOnly\): a API recusou — nada foi gravado/);
});

// ══ Client real: corpo HTTP em dry-run ════════════════════════════════

const CREDENTIALS = {
  token: "test-token", refresh_token: "test-refresh", token_uri: "https://oauth2.googleapis.com/token",
  client_id: "test-client", client_secret: "test-secret", expiry: "2999-01-01T00:00:00.000Z",
};

function interceptFetch(respond: (url: string, body: Row) => unknown | Promise<unknown>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Row }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : {};
    calls.push({ url, body });
    return new Response(JSON.stringify(await respond(url, body)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Client real (fetch interceptado) cujas leituras respondem pelo estado de conta do client falso. */
function realDryRunClient(state: Account) {
  const { client: fake } = fakeClient(state);
  const search = fake.searchStream as (customerId: string, query: string) => Promise<Row[]>;
  const net = interceptFetch(async (url, body) =>
    url.endsWith(":searchStream") ? [{ results: await search(CID, String(body.query)) }] : {}
  );
  const real = new GoogleAdsClient({ credentials: CREDENTIALS, developerToken: "dev", loginCustomerId: CID, dryRun: true });
  return { real, net };
}

test("dry-run de ponta a ponta: create_asset_group envia UM googleAds:mutate com validateOnly e mutateOperations", async () => {
  const { real, net } = realDryRunClient(account({ campaignAssets: brandedCampaignAssets() }));
  try {
    const result = await call(real, "create_asset_group", { campaignId: CAMPAIGN_ID, name: "G", finalUrl: "https://exemplo.com.br", ...CREATIVE });
    assert.equal(result.isError, undefined, textOf(result));
    const writes = net.calls.filter((c) => c.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.ok(Array.isArray(writes[0].body.mutateOperations));
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    net.restore();
  }
});

test("dry-run de ponta a ponta: update_display_ad chama ads:mutate com validateOnly e updateMask aninhado", async () => {
  const { real, net } = realDryRunClient(account({ ads: [displayAd()] }));
  try {
    const result = await call(real, "update_display_ad", { adId: "700", addAssets: [{ field: "SQUARE_MARKETING_IMAGES", asset: "509" }] });
    assert.equal(result.isError, undefined, textOf(result));
    const writes = net.calls.filter((c) => c.url.endsWith(":mutate"));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/ads:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    const op = (writes[0].body.operations as Row[])[0];
    assert.equal(op.updateMask, "responsive_display_ad.square_marketing_images");
    assert.match(textOf(result), /DRY-RUN \(validateOnly\): validado, nada foi gravado/);
  } finally {
    net.restore();
  }
});
