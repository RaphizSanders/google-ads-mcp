/**
 * Lote demand-gen: Demand Gen e remarketing dinâmico de varejo em Display.
 *
 * Cobre create_demand_gen_campaign e create_display_campaign (reescritas: atômicas, mais
 * lances, orçamento total, primeiro grupo, Merchant Center), create_demand_gen_ad_group,
 * update_demand_gen_ad_group, set_demand_gen_ad_group_targeting, create_demand_gen_ad,
 * create_lookalike_segment, list_demand_gen_ad_groups e list_lookalike_segments.
 *
 * O client falso passa toda query por assertGaqlRules (metadados reais da v25) e grava as
 * escritas; um bloco final usa o GoogleAdsClient real com fetch interceptado para provar o
 * corpo HTTP (googleAds:mutate + validateOnly).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GoogleAdsClient } from "../src/google-ads-client.js";
import { registerGoogleAdsTools } from "../src/tools.js";
import { assertGaqlRules, assertUpdateMaskLeaves } from "./gaql-rules.js";

type Row = Record<string, unknown>;
type Result = { content: Array<{ text?: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const CID = "1234567890";
const DG_CAMPAIGN = "700";
const DG_AD_GROUP = "800";

// ── Client falso ──────────────────────────────────────────────────────

const GEO: Record<string, Row> = {
  "2076": { id: "2076", name: "Brazil", status: "ENABLED" },
  "20106": { id: "20106", name: "State of Sao Paulo", status: "ENABLED" },
  "1001773": { id: "1001773", name: "Sao Paulo", status: "ENABLED" },
  "9999": { id: "9999", name: "Old Place", status: "REMOVAL_PLANNED" },
};
const LANGUAGES: Record<string, Row> = {
  "1014": { id: "1014", name: "Portuguese", targetable: true },
  "1000": { id: "1000", name: "English", targetable: true },
};

interface AdGroupFixture {
  adGroup: Row;
  campaign: Row;
}

interface FakeOptions {
  dryRun?: boolean;
  currency?: string;
  campaigns?: Row[];
  budgetNames?: string[];
  adGroups?: AdGroupFixture[];
  adGroupCriteria?: Row[];
  campaignCriteria?: Row[];
  assets?: Row[];
  userLists?: Row[];
  audiences?: Row[];
  merchantLinks?: string[];
  batchMutate?: (operations: Row[]) => Row;
  mutate?: (resource: string, operations: Row[]) => Row;
}

const numbersIn = (query: string, field: string): string[] => {
  const inList = new RegExp(`${field.replace(/\./g, "\\.")} IN \\(([^)]*)\\)`).exec(query);
  if (inList) return inList[1].split(",").map((v) => v.trim().replace(/'/g, ""));
  const eq = new RegExp(`${field.replace(/\./g, "\\.")} = '?([^'\\s]+)'?`).exec(query);
  return eq ? [eq[1]] : [];
};
const stringEq = (query: string, field: string): string | undefined =>
  new RegExp(`${field.replace(/\./g, "\\.")} = '((?:\\\\.|[^'\\\\])*)'`).exec(query)?.[1]?.replace(/\\(.)/g, "$1");

const RESULT_KEYS: Record<string, [string, string]> = {
  campaignBudgetOperation: ["campaignBudgetResult", "campaignBudgets"],
  campaignOperation: ["campaignResult", "campaigns"],
  adGroupOperation: ["adGroupResult", "adGroups"],
  adGroupCriterionOperation: ["adGroupCriterionResult", "adGroupCriteria"],
  campaignCriterionOperation: ["campaignCriterionResult", "campaignCriteria"],
  assetOperation: ["assetResult", "assets"],
  adGroupAdOperation: ["adGroupAdResult", "adGroupAds"],
};

function fakeClient(opts: FakeOptions = {}) {
  const calls = {
    queries: [] as string[],
    batches: [] as Array<{ operations: Row[]; dryRun: boolean }>,
    mutates: [] as Array<{ resource: string; operations: Row[]; options?: Row; dryRun: boolean }>,
  };
  const route = (query: string): Row[] => {
    const from = /\bFROM\s+([a-z_]+)/.exec(query)?.[1] ?? "";
    switch (from) {
      case "campaign": {
        const name = stringEq(query, "campaign.name");
        const list = opts.campaigns ?? [];
        if (name !== undefined) return list.filter((c) => c.name === name).map((campaign) => ({ campaign }));
        const ids = numbersIn(query, "campaign.id");
        return list.filter((c) => ids.includes(String(c.id))).map((campaign) => ({ campaign }));
      }
      case "campaign_budget": {
        const name = stringEq(query, "campaign_budget.name");
        return (opts.budgetNames ?? []).filter((n) => n === name).map((n) => ({ campaignBudget: { id: "1", name: n } }));
      }
      case "ad_group": {
        let list = opts.adGroups ?? [];
        const name = stringEq(query, "ad_group.name");
        if (name !== undefined) list = list.filter((g) => g.adGroup.name === name);
        const ids = numbersIn(query, "ad_group.id");
        if (ids.length) list = list.filter((g) => ids.includes(String(g.adGroup.id)));
        const campaigns = numbersIn(query, "campaign.id");
        if (campaigns.length) list = list.filter((g) => campaigns.includes(String(g.campaign.id)));
        if (query.includes("campaign.advertising_channel_type = 'DEMAND_GEN'")) {
          list = list.filter((g) => g.campaign.advertisingChannelType === "DEMAND_GEN");
        }
        return list.map((g) => ({ adGroup: g.adGroup, campaign: g.campaign }));
      }
      case "ad_group_criterion": {
        const ids = numbersIn(query, "ad_group.id");
        return (opts.adGroupCriteria ?? []).filter((row) => !ids.length || ids.includes(String((row.adGroup as Row).id)));
      }
      case "campaign_criterion": {
        const ids = numbersIn(query, "campaign.id");
        return (opts.campaignCriteria ?? []).filter((row) => ids.includes(String((row.campaign as Row).id)));
      }
      case "geo_target_constant":
        return numbersIn(query, "geo_target_constant.id").filter((id) => GEO[id]).map((id) => ({ geoTargetConstant: GEO[id] }));
      case "language_constant":
        return numbersIn(query, "language_constant.id").filter((id) => LANGUAGES[id]).map((id) => ({ languageConstant: LANGUAGES[id] }));
      case "asset": {
        const assets = opts.assets ?? [];
        if (query.includes("'YOUTUBE_VIDEO'")) {
          const ids = numbersIn(query, "asset.youtube_video_asset.youtube_video_id");
          return assets.filter((a) => ids.includes(String((a.youtubeVideoAsset as Row | undefined)?.youtubeVideoId))).map((asset) => ({ asset }));
        }
        if (query.includes("'CALL_TO_ACTION'")) {
          const cta = stringEq(query, "asset.call_to_action_asset.call_to_action");
          return assets.filter((a) => (a.callToActionAsset as Row | undefined)?.callToAction === cta).map((asset) => ({ asset }));
        }
        const ids = numbersIn(query, "asset.id");
        return assets.filter((a) => ids.includes(String(a.id))).map((asset) => ({ asset }));
      }
      case "user_list": {
        const lists = opts.userLists ?? [];
        if (query.includes("user_list.type = 'LOOKALIKE'")) return lists.filter((l) => l.lookalikeUserList).map((userList) => ({ userList }));
        const name = stringEq(query, "user_list.name");
        if (name !== undefined) return lists.filter((l) => l.name === name).map((userList) => ({ userList }));
        const ids = numbersIn(query, "user_list.id");
        return lists.filter((l) => ids.includes(String(l.id))).map((userList) => ({ userList }));
      }
      case "audience": {
        const ids = numbersIn(query, "audience.id");
        return (opts.audiences ?? []).filter((a) => ids.includes(String(a.id))).map((audience) => ({ audience }));
      }
      case "product_link": {
        const ids = numbersIn(query, "product_link.merchant_center.merchant_center_id");
        return (opts.merchantLinks ?? []).filter((id) => ids.includes(id)).map((id) => ({ productLink: { productLinkId: "1", merchantCenter: { merchantCenterId: id } } }));
      }
      default:
        throw new Error(`query inesperada: ${query}`);
    }
  };
  const build = (dryRun: boolean): Row => ({
    isDryRun: dryRun,
    withDryRun: () => build(true),
    async getAccountCurrency() {
      return opts.currency ?? "BRL";
    },
    async searchStream(_customerId: string, query: string): Promise<Row[]> {
      calls.queries.push(query);
      assertGaqlRules(query);
      return route(query);
    },
    async batchMutate(_customerId: string, operations: Row[]): Promise<Row> {
      calls.batches.push({ operations, dryRun });
      if (opts.batchMutate) return opts.batchMutate(operations);
      if (dryRun) return {};
      let n = 9000;
      return {
        mutateOperationResponses: operations.map((op) => {
          const key = Object.keys(op)[0];
          const [resultKey, collection] = RESULT_KEYS[key] ?? ["unknownResult", "unknown"];
          return { [resultKey]: { resourceName: `customers/${CID}/${collection}/${++n}` } };
        }),
      };
    },
    async mutate(_customerId: string, resource: string, operations: Row[], options?: Row): Promise<Row> {
      calls.mutates.push({ resource, operations, options, dryRun });
      if (opts.mutate) return opts.mutate(resource, operations);
      if (dryRun) return {};
      return { results: operations.map((_, i) => ({ resourceName: `customers/${CID}/${resource}/${5000 + i}` })) };
    },
  });
  return { client: build(opts.dryRun ?? false), calls };
}

function handlers(client: unknown, allowed: string[] = [], hosted = false) {
  const map = new Map<string, Handler>();
  const fakeMcp = { registerTool: (name: string, _config: unknown, handler: Handler) => map.set(name, handler) };
  registerGoogleAdsTools(fakeMcp as never, () => client as never, allowed, hosted);
  return map;
}

const call = (client: unknown, tool: string, args: Row) => handlers(client).get(tool)!({ customerId: CID, ...args });
const textOf = (result: Result) => result.content.map((c) => c.text ?? "").join("\n");
const opKeys = (operations: Row[]) => operations.map((op) => Object.keys(op)[0]);
const createOf = (op: Row) => (Object.values(op)[0] as Row).create as Row;
const writeCount = (calls: { batches: unknown[]; mutates: unknown[] }) => calls.batches.length + calls.mutates.length;

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dgCampaign = (overrides: Row = {}): Row => ({
  id: DG_CAMPAIGN, name: "DG Prospecção", status: "PAUSED", advertisingChannelType: "DEMAND_GEN",
  biddingStrategyType: "TARGET_CPC", demandGenCampaignSettings: { upgradedTargeting: true }, ...overrides,
});
const dgAdGroup = (overrides: Row = {}, campaign: Row = dgCampaign()): AdGroupFixture => ({
  adGroup: { id: DG_AD_GROUP, name: "Shorts 25-44", status: "ENABLED", ...overrides },
  campaign,
});
const image = (id: string, width: number, height: number): Row => ({
  id, name: `img ${id}`, type: "IMAGE", imageAsset: { fullSize: { widthPixels: width, heightPixels: height } },
});
const IMAGES = [
  image("11", 1200, 628), image("12", 1200, 1200), image("13", 960, 1200), image("14", 1080, 1920),
  image("15", 1200, 1200), image("16", 300, 60), image("17", 1200, 628), image("18", 1200, 1200),
];

// ══════════════════════════════════════════════════════════════════════
// create_demand_gen_campaign
// ══════════════════════════════════════════════════════════════════════

test("create_demand_gen_campaign: orçamento, campanha, grupo e critérios num único googleAds:mutate", async () => {
  const { client, calls } = fakeClient({ audiences: [{ id: "44", name: "Lookalike compradores", status: "ENABLED" }] });
  const result = await call(client, "create_demand_gen_campaign", {
    name: "DG Shorts",
    dailyBudgetMicros: 50_000_000,
    biddingStrategy: "TARGET_CPC",
    targetCpcMicros: 1_500_000,
    locationIds: ["2076"],
    languageIds: ["1014"],
    adGroup: { name: "Shorts", selectedChannels: ["YOUTUBE_SHORTS"], optimizedTargeting: true, audienceResourceName: `customers/${CID}/audiences/44` },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.mutates.length, 0, "nada fora do googleAds:mutate");
  assert.equal(calls.batches.length, 1);
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), [
    "campaignBudgetOperation", "campaignOperation", "adGroupOperation",
    "adGroupCriterionOperation", "adGroupCriterionOperation", "adGroupCriterionOperation",
  ]);
  const budget = createOf(ops[0]);
  assert.equal(budget.amountMicros, "50000000");
  assert.equal(budget.explicitlyShared, false);
  assert.equal(budget.resourceName, `customers/${CID}/campaignBudgets/-1`);
  const campaign = createOf(ops[1]);
  assert.equal(campaign.advertisingChannelType, "DEMAND_GEN");
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.campaignBudget, budget.resourceName);
  assert.deepEqual(campaign.targetCpc, { targetCpcMicros: "1500000" });
  assert.equal(campaign.manualCpc, undefined);
  assert.equal(campaign.maximizeConversions, undefined);
  const adGroup = createOf(ops[2]);
  assert.equal(adGroup.campaign, campaign.resourceName);
  assert.equal(adGroup.type, undefined, "Demand Gen: grupo sem type");
  assert.equal(adGroup.optimizedTargetingEnabled, true);
  const selected = ((adGroup.demandGenAdGroupSettings as Row).channelControls as Row).selectedChannels as Row;
  assert.deepEqual(selected, {
    youtubeInStream: false, youtubeInFeed: false, youtubeShorts: true, discover: false, gmail: false, display: false, maps: false,
  });
  const criteria = ops.slice(3).map(createOf);
  assert.ok(criteria.every((c) => c.adGroup === adGroup.resourceName), "critérios no grupo (upgraded targeting)");
  assert.deepEqual(criteria[0].location, { geoTargetConstant: "geoTargetConstants/2076" });
  assert.deepEqual(criteria[1].language, { languageConstant: "languageConstants/1014" });
  assert.deepEqual(criteria[2].audience, { audience: `customers/${CID}/audiences/44` });
  const out = textOf(result);
  assert.match(out, /create_demand_gen_ad com adGroupId=9003/);
  assert.doesNotMatch(out, /Next: use create_asset_group/);
});

test("create_demand_gen_campaign: orçamento total vira CUSTOM_PERIOD com data de término", async () => {
  const { client, calls } = fakeClient();
  const end = isoDaysFromToday(30);
  const result = await call(client, "create_demand_gen_campaign", {
    name: "DG Black Friday", totalBudgetMicros: 3_000_000_000, endDate: end, biddingStrategy: "TARGET_ROAS", targetRoas: 4,
    viewThroughConversionOptimization: true,
  });
  assert.equal(result.isError, undefined, textOf(result));
  const [budgetOp, campaignOp] = calls.batches[0].operations;
  const budget = createOf(budgetOp);
  assert.equal(budget.period, "CUSTOM_PERIOD");
  assert.equal(budget.totalAmountMicros, "3000000000");
  assert.equal(budget.amountMicros, undefined, "amount_micros fica vazio no CUSTOM_PERIOD");
  const campaign = createOf(campaignOp);
  assert.equal(campaign.endDateTime, `${end} 23:59:59`);
  assert.deepEqual(campaign.maximizeConversionValue, { targetRoas: 4 });
  assert.equal(campaign.viewThroughConversionOptimizationEnabled, true);
  assert.match(textOf(result), /no total \(31 dia\(s\)/);
});

test("create_demand_gen_campaign: entradas inválidas são recusadas antes de qualquer chamada", async () => {
  const cases: Array<[string, Row, RegExp]> = [
    ["dois orçamentos", { dailyBudgetMicros: 50_000_000, totalBudgetMicros: 900_000_000 }, /exatamente um/],
    ["sem orçamento", {}, /exatamente um/],
    ["total sem endDate", { totalBudgetMicros: 900_000_000 }, /exige endDate/],
    ["micros quebrados", { dailyBudgetMicros: 50_000_001 }, /múltiplo de 10000/],
    ["TARGET_CPA sem alvo", { dailyBudgetMicros: 50_000_000, biddingStrategy: "TARGET_CPA" }, /exige targetCpaMicros/],
    ["CPC alvo com outra estratégia", { dailyBudgetMicros: 50_000_000, biddingStrategy: "MAXIMIZE_CLICKS", targetCpcMicros: 1_000_000 }, /targetCpcMicros só vale com TARGET_CPC/],
    ["CPC manual", { dailyBudgetMicros: 50_000_000, biddingStrategy: "MANUAL_CPC" }, /CPC manual é recusado/],
    ["canais nas duas formas", { dailyBudgetMicros: 50_000_000, adGroup: { name: "g", channelStrategy: "ALL_CHANNELS", selectedChannels: ["GMAIL"] } }, /não os dois/],
    ["canal inexistente", { dailyBudgetMicros: 50_000_000, adGroup: { name: "g", selectedChannels: '["TIKTOK"]' } }, /canal inválido: TIKTOK/],
    ["local sem grupo", { dailyBudgetMicros: 50_000_000, locationIds: ["2076"] }, /informe adGroup/],
    ["merchant não numérico", { dailyBudgetMicros: 50_000_000, merchantId: "abc" }, /merchantId/],
    ["endDate no passado", { dailyBudgetMicros: 50_000_000, endDate: "2020-01-01" }, /já passou/],
    ["público de outra conta", { dailyBudgetMicros: 50_000_000, adGroup: { name: "g", audienceResourceName: "customers/999/audiences/1" } }, /pertence à conta 999/],
  ];
  for (const [label, args, pattern] of cases) {
    const { client, calls } = fakeClient();
    const result = await call(client, "create_demand_gen_campaign", { name: "DG", ...args });
    assert.equal(result.isError, true, label);
    assert.match(textOf(result), pattern, label);
    assert.equal(calls.queries.length + writeCount(calls), 0, `${label}: nada pode sair para a API`);
  }
});

test("create_demand_gen_campaign: mínimo de 5 USD/dia conferido em conta USD, sem escrita", async () => {
  const low = fakeClient({ currency: "USD" });
  const refused = await call(low.client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 4_000_000 });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /mínimo USD 5\.00 por dia/);
  assert.equal(writeCount(low.calls), 0);

  const total = fakeClient({ currency: "USD" });
  const totalRefused = await call(total.client, "create_demand_gen_campaign", {
    name: "DG", totalBudgetMicros: 100_000_000, endDate: isoDaysFromToday(29),
  });
  assert.equal(totalRefused.isError, true, "USD 100 em 30 dias = 3,33/dia");
  assert.equal(writeCount(total.calls), 0);

  const ok = fakeClient({ currency: "USD" });
  const accepted = await call(ok.client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 5_000_000 });
  assert.equal(accepted.isError, undefined, textOf(accepted));
  assert.equal(ok.calls.batches.length, 1);

  const brl = fakeClient({ currency: "BRL" });
  const brlResult = await call(brl.client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 10_000_000 });
  assert.equal(brlResult.isError, undefined, "sem câmbio confiável: a API confere em BRL");
  assert.match(textOf(brlResult), /5 USD\/dia no equivalente em BRL/);
});

test("create_demand_gen_campaign: erro da API vira orientação e nada fica órfão", async () => {
  const { client, calls } = fakeClient({
    batchMutate: () => {
      throw new Error("Google Ads API: Request contains an invalid argument. — Budget amount or total amount must be above this campaign's per-day minimum.");
    },
  });
  const result = await call(client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 10_000_000 });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Nada foi criado \(orçamento, campanha e grupo vão numa única operação atômica\)/);
  assert.match(textOf(result), /5 USD por dia/);
  assert.equal(calls.batches.length, 1);
  assert.equal(calls.mutates.length, 0);
});

test("create_demand_gen_campaign: dry-run e validateOnly não afirmam criação", async () => {
  const { client, calls } = fakeClient({ dryRun: true });
  const result = await call(client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 50_000_000 });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /DRY-RUN \(validateOnly\).*nada foi gravado/);
  assert.doesNotMatch(textOf(result), /criada/);
  assert.equal(calls.batches[0].dryRun, true);
});

test("create_demand_gen_campaign: sem upgraded targeting, localização e idioma vão para a campanha", async () => {
  const { client, calls } = fakeClient({ merchantLinks: [] });
  const result = await call(client, "create_demand_gen_campaign", {
    name: "DG Legado", dailyBudgetMicros: 50_000_000, upgradedTargeting: false, locationIds: ["2076"], languageIds: ["1014"],
    merchantId: "123456", feedLabel: "br",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["campaignBudgetOperation", "campaignOperation", "campaignCriterionOperation", "campaignCriterionOperation"]);
  const campaign = createOf(ops[1]);
  assert.deepEqual(campaign.demandGenCampaignSettings, { upgradedTargeting: false });
  assert.deepEqual(campaign.shoppingSetting, { merchantId: "123456", feedLabel: "BR" });
  assert.equal(createOf(ops[2]).campaign, campaign.resourceName);
  assert.match(textOf(result), /não aparece vinculado/);
});

test("create_demand_gen_campaign: nome repetido, local inexistente e orçamento órfão com o mesmo nome", async () => {
  const dup = fakeClient({ campaigns: [dgCampaign({ name: "DG" })] });
  const dupResult = await call(dup.client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 50_000_000 });
  assert.equal(dupResult.isError, true);
  assert.match(textOf(dupResult), /Já existe a campanha "DG"/);
  assert.equal(writeCount(dup.calls), 0);

  const geo = fakeClient();
  const geoResult = await call(geo.client, "create_demand_gen_campaign", {
    name: "DG", dailyBudgetMicros: 50_000_000, locationIds: ["123"], adGroup: { name: "g" },
  });
  assert.equal(geoResult.isError, true);
  assert.match(textOf(geoResult), /localização 123 não existe/);
  assert.equal(writeCount(geo.calls), 0);

  const orphan = fakeClient({ budgetNames: ["Budget — DG"] });
  const orphanResult = await call(orphan.client, "create_demand_gen_campaign", { name: "DG", dailyBudgetMicros: 50_000_000 });
  assert.equal(orphanResult.isError, undefined);
  const budgetName = String(createOf(orphan.calls.batches[0].operations[0]).name);
  assert.notEqual(budgetName, "Budget — DG");
  assert.match(budgetName, /^Budget — DG \(\d{4}-\d{2}-\d{2} /);
});

// ══════════════════════════════════════════════════════════════════════
// create_display_campaign
// ══════════════════════════════════════════════════════════════════════

const REMARKETING = { id: "555", name: "Carrinho abandonado 30d", type: "RULE_BASED", membershipStatus: "OPEN", eligibleForDisplay: true, sizeForDisplay: "12000" };

test("create_display_campaign: remarketing dinâmico de varejo numa operação atômica", async () => {
  const { client, calls } = fakeClient({ userLists: [REMARKETING], merchantLinks: ["123456"] });
  const result = await call(client, "create_display_campaign", {
    name: "Display RMKT Dinâmico", dailyBudgetMicros: 80_000_000, biddingStrategy: "MAXIMIZE_CLICKS", cpcBidCeilingMicros: 2_000_000,
    merchantId: "123456", enableLocal: true, locationIds: ["2076"],
    adGroup: { name: "Carrinho 30d", userListIds: ["555"] },
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.mutates.length, 0);
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["campaignBudgetOperation", "campaignOperation", "campaignCriterionOperation", "adGroupOperation", "adGroupCriterionOperation"]);
  const campaign = createOf(ops[1]);
  assert.equal(campaign.advertisingChannelType, "DISPLAY");
  assert.deepEqual(campaign.targetSpend, { cpcBidCeilingMicros: "2000000" });
  assert.deepEqual(campaign.shoppingSetting, { merchantId: "123456", campaignPriority: 0, enableLocal: true });
  assert.deepEqual(campaign.networkSettings, { targetContentNetwork: true, targetGoogleSearch: false, targetSearchNetwork: false });
  const adGroup = createOf(ops[3]);
  assert.equal(adGroup.type, "DISPLAY_STANDARD");
  assert.equal(adGroup.campaign, campaign.resourceName);
  assert.deepEqual(createOf(ops[4]).userList, { userList: `customers/${CID}/userLists/555` });
  assert.equal(createOf(ops[4]).adGroup, adGroup.resourceName);
  assert.match(textOf(result), /create_responsive_display_ad com adGroupId=9004 \(o anúncio responsivo puxa os produtos do feed\)/);
  assert.doesNotMatch(textOf(result), /Avisos/);
});

test("create_display_campaign: estratégias novas (TARGET_ROAS, TARGET_SPEND, MANUAL_CPM) e travas de lance", async () => {
  const roas = fakeClient();
  await call(roas.client, "create_display_campaign", { name: "D1", dailyBudgetMicros: 50_000_000, biddingStrategy: "TARGET_ROAS", targetRoas: 6 });
  assert.deepEqual(createOf(roas.calls.batches[0].operations[1]).maximizeConversionValue, { targetRoas: 6 });

  const spend = fakeClient();
  const spendResult = await call(spend.client, "create_display_campaign", { name: "D2", dailyBudgetMicros: 50_000_000, biddingStrategy: "TARGET_SPEND" });
  assert.deepEqual(createOf(spend.calls.batches[0].operations[1]).targetSpend, {});
  assert.match(textOf(spendResult), /sem teto/);

  const cpmMissing = fakeClient();
  const missing = await call(cpmMissing.client, "create_display_campaign", {
    name: "D3", dailyBudgetMicros: 50_000_000, biddingStrategy: "MANUAL_CPM", adGroup: { name: "g" },
  });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /adGroup\.cpmBidMicros/);
  assert.equal(cpmMissing.calls.queries.length + writeCount(cpmMissing.calls), 0);

  const cpm = fakeClient();
  await call(cpm.client, "create_display_campaign", {
    name: "D4", dailyBudgetMicros: 50_000_000, biddingStrategy: "MANUAL_CPM", adGroup: { name: "g", cpmBidMicros: 8_000_000 },
  });
  const ops = cpm.calls.batches[0].operations;
  assert.deepEqual(createOf(ops[1]).manualCpm, {});
  assert.equal(createOf(ops[2]).cpmBidMicros, "8000000");

  const ceiling = fakeClient();
  const ceilingResult = await call(ceiling.client, "create_display_campaign", {
    name: "D5", dailyBudgetMicros: 50_000_000, biddingStrategy: "MAXIMIZE_CONVERSIONS", cpcBidCeilingMicros: 1_000_000,
  });
  assert.equal(ceilingResult.isError, true);
  assert.equal(ceiling.calls.queries.length, 0);

  const local = fakeClient();
  const localResult = await call(local.client, "create_display_campaign", { name: "D6", dailyBudgetMicros: 50_000_000, enableLocal: true });
  assert.equal(localResult.isError, true);
  assert.match(textOf(localResult), /só valem junto com merchantId/);
});

test("create_display_campaign: lista de remarketing inexistente ou fora do Display é recusada sem escrita", async () => {
  const missing = fakeClient({ userLists: [] });
  const r1 = await call(missing.client, "create_display_campaign", { name: "D", dailyBudgetMicros: 50_000_000, adGroup: { name: "g", userListIds: ["555"] } });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /lista de remarketing 555 não encontrada/);
  assert.equal(writeCount(missing.calls), 0);

  const search = fakeClient({ userLists: [{ ...REMARKETING, eligibleForDisplay: false }] });
  const r2 = await call(search.client, "create_display_campaign", { name: "D", dailyBudgetMicros: 50_000_000, adGroup: { name: "g", userListIds: ["555"] } });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /não é elegível para Display/);
  assert.equal(writeCount(search.calls), 0);
});

test("create_display_campaign: erro da API e dry-run", async () => {
  const failing = fakeClient({ batchMutate: () => { throw new Error("Google Ads API: The operation is not allowed for the given context."); } });
  const failed = await call(failing.client, "create_display_campaign", { name: "D", dailyBudgetMicros: 50_000_000, biddingStrategy: "MANUAL_CPC" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Nada foi criado/);
  assert.match(textOf(failed), /TARGET_SPEND/, "explainBiddingError orienta a trocar CPC manual");
  assert.equal(failing.calls.mutates.length, 0);

  const dry = fakeClient({ dryRun: true });
  const dryResult = await call(dry.client, "create_display_campaign", { name: "D", dailyBudgetMicros: 50_000_000 });
  assert.match(textOf(dryResult), /DRY-RUN/);
  assert.doesNotMatch(textOf(dryResult), /criada/);
});

// ══════════════════════════════════════════════════════════════════════
// create_demand_gen_ad_group
// ══════════════════════════════════════════════════════════════════════

test("create_demand_gen_ad_group: grupo sem type, canais, lance e critérios numa operação", async () => {
  const { client, calls } = fakeClient({
    campaigns: [dgCampaign()],
    audiences: [{ id: "44", name: "LAL", status: "ENABLED" }],
  });
  const result = await call(client, "create_demand_gen_ad_group", {
    campaignId: DG_CAMPAIGN, name: "Discover + Gmail", channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS",
    targetCpcMicros: 1_200_000, locationIds: ["20106"], excludedLocationIds: ["1001773"], languageIds: ["1014"], audienceResourceName: "44",
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["adGroupOperation", ...Array(4).fill("adGroupCriterionOperation")]);
  const adGroup = createOf(ops[0]);
  assert.equal(adGroup.status, "PAUSED");
  assert.equal(adGroup.type, undefined);
  assert.equal(adGroup.campaign, `customers/${CID}/campaigns/${DG_CAMPAIGN}`);
  assert.equal(adGroup.targetCpcMicros, "1200000");
  assert.deepEqual(adGroup.demandGenAdGroupSettings, { channelControls: { channelStrategy: "ALL_OWNED_AND_OPERATED_CHANNELS" } });
  const criteria = ops.slice(1).map(createOf);
  assert.equal(criteria[1].negative, true);
  assert.deepEqual(criteria[3].audience, { audience: `customers/${CID}/audiences/44` });
  assert.doesNotMatch(textOf(result), /Avisos/);
});

test("create_demand_gen_ad_group: recusas de leitura (canal, upgraded targeting, campanha com local, nome repetido)", async () => {
  const search = fakeClient({ campaigns: [dgCampaign({ advertisingChannelType: "SEARCH" })] });
  const r1 = await call(search.client, "create_demand_gen_ad_group", { campaignId: DG_CAMPAIGN, name: "g" });
  assert.match(textOf(r1), /é SEARCH, não DEMAND_GEN — use create_ad_group/);
  assert.equal(writeCount(search.calls), 0);

  const legacy = fakeClient({ campaigns: [dgCampaign({ demandGenCampaignSettings: { upgradedTargeting: false } })] });
  const r2 = await call(legacy.client, "create_demand_gen_ad_group", { campaignId: DG_CAMPAIGN, name: "g", locationIds: ["2076"] });
  assert.match(textOf(r2), /não usa upgraded targeting/);
  assert.equal(writeCount(legacy.calls), 0);

  const mixed = fakeClient({ campaigns: [dgCampaign()], campaignCriteria: [{ campaign: { id: DG_CAMPAIGN }, campaignCriterion: { type: "LOCATION" } }] });
  const r3 = await call(mixed.client, "create_demand_gen_ad_group", { campaignId: DG_CAMPAIGN, name: "g", languageIds: ["1014"] });
  assert.match(textOf(r3), /campanha OU grupo, nunca os dois/);
  assert.equal(writeCount(mixed.calls), 0);

  const dup = fakeClient({ campaigns: [dgCampaign()], adGroups: [dgAdGroup({ name: "g" })] });
  const r4 = await call(dup.client, "create_demand_gen_ad_group", { campaignId: DG_CAMPAIGN, name: "g" });
  assert.match(textOf(r4), /Já existe o grupo "g"/);
  assert.equal(writeCount(dup.calls), 0);

  const bad = fakeClient();
  const r5 = await call(bad.client, "create_demand_gen_ad_group", { campaignId: "70 OR 1=1", name: "g" });
  assert.equal(r5.isError, true);
  assert.equal(bad.calls.queries.length, 0);
});

test("create_demand_gen_ad_group: avisa quando o lance do grupo não vale para a estratégia da campanha", async () => {
  const { client } = fakeClient({ campaigns: [dgCampaign({ biddingStrategyType: "MAXIMIZE_CONVERSIONS" })] });
  const result = await call(client, "create_demand_gen_ad_group", { campaignId: DG_CAMPAIGN, name: "g", targetCpcMicros: 1_000_000 });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /o CPC alvo do grupo só vale com TARGET_CPC/);
});

// ══════════════════════════════════════════════════════════════════════
// update_demand_gen_ad_group
// ══════════════════════════════════════════════════════════════════════

test("update_demand_gen_ad_group: canais escolhidos vão com os 7 caminhos-folha no updateMask", async () => {
  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()] });
  const result = await call(client, "update_demand_gen_ad_group", { adGroupId: DG_AD_GROUP, selectedChannels: ["YOUTUBE_SHORTS", "DISCOVER"] });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.mutates.length, 1);
  assert.equal(calls.mutates[0].resource, "adGroups");
  const op = calls.mutates[0].operations[0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  const paths = op.updateMask.split(",");
  assert.equal(paths.length, 7);
  assert.ok(paths.every((p) => p.startsWith("demand_gen_ad_group_settings.channel_controls.selected_channels.")));
  const selected = ((op.update.demandGenAdGroupSettings as Row).channelControls as Row).selectedChannels as Row;
  assert.equal(selected.youtubeShorts, true);
  assert.equal(selected.discover, true);
  assert.equal(selected.gmail, false);
  assert.match(textOf(result), /ALL_CHANNELS \(padrão\)/);
});

test("update_demand_gen_ad_group: volta para estratégia, só muda o que mudou e pula no-op", async () => {
  const selectedGroup = dgAdGroup({
    optimizedTargetingEnabled: true,
    targetCpcMicros: "1000000",
    demandGenAdGroupSettings: { channelControls: { channelConfig: "SELECTED_CHANNELS", selectedChannels: { youtubeShorts: true, discover: true } } },
  });
  const noop = fakeClient({ adGroups: [selectedGroup] });
  const same = await call(noop.client, "update_demand_gen_ad_group", {
    adGroupId: DG_AD_GROUP, selectedChannels: ["DISCOVER", "YOUTUBE_SHORTS"], optimizedTargeting: true, targetCpcMicros: 1_000_000,
  });
  assert.match(textOf(same), /nada a mudar/);
  assert.equal(noop.calls.mutates.length, 0);

  const change = fakeClient({ adGroups: [selectedGroup] });
  await call(change.client, "update_demand_gen_ad_group", {
    adGroupId: DG_AD_GROUP, channelStrategy: "ALL_CHANNELS", optimizedTargeting: false, targetCpcMicros: 1_500_000,
  });
  const op = change.calls.mutates[0].operations[0] as { update: Row; updateMask: string };
  assertUpdateMaskLeaves(op.updateMask);
  assert.deepEqual(op.updateMask.split(","), [
    "demand_gen_ad_group_settings.channel_controls.channel_strategy", "optimized_targeting_enabled", "target_cpc_micros",
  ]);
  assert.equal(op.update.optimizedTargetingEnabled, false);
  assert.equal(op.update.targetCpcMicros, "1500000");
});

test("update_demand_gen_ad_group: recusas e dry-run", async () => {
  const empty = fakeClient();
  const r1 = await call(empty.client, "update_demand_gen_ad_group", { adGroupId: DG_AD_GROUP });
  assert.match(textOf(r1), /informe ao menos um campo/);
  assert.equal(empty.calls.queries.length, 0);

  const search = fakeClient({ adGroups: [dgAdGroup({}, dgCampaign({ advertisingChannelType: "SEARCH" }))] });
  const r2 = await call(search.client, "update_demand_gen_ad_group", { adGroupId: DG_AD_GROUP, optimizedTargeting: true });
  assert.match(textOf(r2), /use update_ad_group/);
  assert.equal(search.calls.mutates.length, 0);

  const dry = fakeClient({ dryRun: true, adGroups: [dgAdGroup()] });
  const r3 = await call(dry.client, "update_demand_gen_ad_group", { adGroupId: DG_AD_GROUP, optimizedTargeting: true });
  assert.match(textOf(r3), /DRY-RUN/);
  assert.doesNotMatch(textOf(r3), /atualizado/);
});

// ══════════════════════════════════════════════════════════════════════
// set_demand_gen_ad_group_targeting
// ══════════════════════════════════════════════════════════════════════

const existingCriteria = [
  { adGroup: { id: DG_AD_GROUP }, adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/${DG_AD_GROUP}~1`, type: "LOCATION", location: { geoTargetConstant: "geoTargetConstants/2076" } } },
  { adGroup: { id: DG_AD_GROUP }, adGroupCriterion: { resourceName: `customers/${CID}/adGroupCriteria/${DG_AD_GROUP}~2`, type: "LANGUAGE", language: { languageConstant: "languageConstants/1000" } } },
];

test("set_demand_gen_ad_group_targeting: adiciona só o que falta, numa requisição atômica", async () => {
  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], adGroupCriteria: existingCriteria });
  const result = await call(client, "set_demand_gen_ad_group_targeting", {
    adGroupIds: [DG_AD_GROUP], locationIds: ["2076", "20106"], languageIds: ["1014"],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.mutates.length, 1);
  assert.equal(calls.mutates[0].resource, "adGroupCriteria");
  assert.equal(calls.mutates[0].options, undefined, "sem partialFailure: tudo ou nada");
  const creates = calls.mutates[0].operations.map((op) => op.create as Row);
  assert.deepEqual(creates.map((c) => c.location ?? c.language), [
    { geoTargetConstant: "geoTargetConstants/20106" },
    { languageConstant: "languageConstants/1014" },
  ]);
  assert.ok(creates.every((c) => c.adGroup === `customers/${CID}/adGroups/${DG_AD_GROUP}`));

  const noop = fakeClient({ adGroups: [dgAdGroup()], adGroupCriteria: existingCriteria });
  const same = await call(noop.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], locationIds: ["2076"] });
  assert.match(textOf(same), /Nada a mudar/);
  assert.equal(noop.calls.mutates.length, 0);
});

test("set_demand_gen_ad_group_targeting: replace exige confirm; com confirm remove e cria na mesma requisição", async () => {
  const preview = fakeClient({ adGroups: [dgAdGroup()], adGroupCriteria: existingCriteria });
  const r1 = await call(preview.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], languageIds: ["1014"], replace: true });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Prévia — nada foi alterado/);
  assert.match(textOf(r1), /idioma 1000/);
  assert.equal(preview.calls.mutates.length, 0);

  const applied = fakeClient({ adGroups: [dgAdGroup()], adGroupCriteria: existingCriteria });
  const r2 = await call(applied.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], languageIds: ["1014"], replace: true, confirm: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  const ops = applied.calls.mutates[0].operations;
  assert.deepEqual(ops[0], { remove: `customers/${CID}/adGroupCriteria/${DG_AD_GROUP}~2` });
  assert.deepEqual((ops[1].create as Row).language, { languageConstant: "languageConstants/1014" });
  assert.equal(ops.length, 2, "a localização (não informada) fica intacta");
});

test("set_demand_gen_ad_group_targeting: campanha inteira, público e recusas", async () => {
  const second = dgAdGroup({ id: "801", name: "Gmail" });
  const all = fakeClient({ adGroups: [dgAdGroup(), second], audiences: [{ id: "44", status: "ENABLED" }] });
  const r1 = await call(all.client, "set_demand_gen_ad_group_targeting", { campaignId: DG_CAMPAIGN, audienceResourceName: "44" });
  assert.equal(r1.isError, undefined, textOf(r1));
  assert.deepEqual(all.calls.mutates[0].operations.map((op) => (op.create as Row).adGroup), [
    `customers/${CID}/adGroups/${DG_AD_GROUP}`, `customers/${CID}/adGroups/801`,
  ]);

  const conflict = fakeClient({
    adGroups: [dgAdGroup()], audiences: [{ id: "44", status: "ENABLED" }],
    adGroupCriteria: [{ adGroup: { id: DG_AD_GROUP }, adGroupCriterion: { resourceName: "x~9", type: "AUDIENCE", audience: { audience: `customers/${CID}/audiences/33` } } }],
  });
  const r2 = await call(conflict.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], audienceResourceName: "44" });
  assert.match(textOf(r2), /já tem o público/);
  assert.equal(conflict.calls.mutates.length, 0);

  const mixed = fakeClient({ adGroups: [dgAdGroup()], campaignCriteria: [{ campaign: { id: DG_CAMPAIGN }, campaignCriterion: { type: "LANGUAGE" } }] });
  const r3 = await call(mixed.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], locationIds: ["2076"] });
  assert.match(textOf(r3), /nunca os dois/);
  assert.equal(mixed.calls.mutates.length, 0);

  const legacy = fakeClient({ adGroups: [dgAdGroup({}, dgCampaign({ demandGenCampaignSettings: { upgradedTargeting: false } }))] });
  const r4 = await call(legacy.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], locationIds: ["2076"] });
  assert.match(textOf(r4), /set_campaign_locations/);
  assert.equal(legacy.calls.mutates.length, 0);

  const nothing = fakeClient();
  const r5 = await call(nothing.client, "set_demand_gen_ad_group_targeting", { adGroupIds: [DG_AD_GROUP], locationIds: [] });
  assert.match(textOf(r5), /ao menos uma dimensão/);
  assert.equal(nothing.calls.queries.length, 0);
});

// ══════════════════════════════════════════════════════════════════════
// create_demand_gen_ad
// ══════════════════════════════════════════════════════════════════════

const MULTI_ASSET_ARGS = {
  adGroupId: DG_AD_GROUP, adType: "MULTI_ASSET", finalUrl: "https://loja.com.br/colecao",
  businessName: "Loja Exemplo", logoImages: ["15"], headlines: ["Coleção nova", "Frete grátis acima de R$ 199 hoje"],
  descriptions: ["Peças novas toda semana."], marketingImages: ["11"], squareMarketingImages: [`customers/${CID}/assets/12`],
  portraitMarketingImages: ["13"], tallPortraitMarketingImages: ["14"],
};

test("create_demand_gen_ad: multi-asset com as 4 proporções, automação e PAUSED", async () => {
  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const result = await call(client, "create_demand_gen_ad", {
    ...MULTI_ASSET_ARGS, callToActionText: "Comprar", assetAutomation: [{ type: "GENERATE_DESIGN_VERSIONS_FOR_IMAGES", status: "OPTED_OUT" }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.batches.length, 1);
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["adGroupAdOperation"]);
  const adGroupAd = createOf(ops[0]);
  assert.equal(adGroupAd.status, "PAUSED");
  assert.equal(adGroupAd.adGroup, `customers/${CID}/adGroups/${DG_AD_GROUP}`);
  assert.deepEqual(adGroupAd.adGroupAdAssetAutomationSettings, [{ assetAutomationType: "GENERATE_DESIGN_VERSIONS_FOR_IMAGES", assetAutomationStatus: "OPTED_OUT" }]);
  const ad = adGroupAd.ad as Row;
  assert.deepEqual(ad.finalUrls, ["https://loja.com.br/colecao"]);
  const info = ad.demandGenMultiAssetAd as Row;
  assert.deepEqual(info.marketingImages, [{ asset: `customers/${CID}/assets/11` }]);
  assert.deepEqual(info.squareMarketingImages, [{ asset: `customers/${CID}/assets/12` }]);
  assert.deepEqual(info.portraitMarketingImages, [{ asset: `customers/${CID}/assets/13` }]);
  assert.deepEqual(info.tallPortraitMarketingImages, [{ asset: `customers/${CID}/assets/14` }]);
  assert.deepEqual(info.logoImages, [{ asset: `customers/${CID}/assets/15` }]);
  assert.deepEqual(info.headlines, [{ text: "Coleção nova" }, { text: "Frete grátis acima de R$ 199 hoje" }]);
  assert.equal(info.businessName, "Loja Exemplo", "multi-asset: business_name é string");
  assert.equal(info.callToActionText, "Comprar");
  assert.equal(ad.demandGenVideoResponsiveAd, undefined);
  assert.equal(calls.queries.filter((q) => /FROM asset/.test(q)).length, 1, "todas as imagens numa consulta só");
});

test("create_demand_gen_ad: proporção errada, conta errada, limites de texto e campo fora do tipo", async () => {
  const wrongRatio = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const r1 = await call(wrongRatio.client, "create_demand_gen_ad", { ...MULTI_ASSET_ARGS, marketingImages: ["12"] });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /marketingImages: asset 12 tem 1200x1200 .* exige paisagem 1\.91:1/);
  assert.equal(writeCount(wrongRatio.calls), 0);

  const small = fakeClient({ adGroups: [dgAdGroup()], assets: [...IMAGES, image("19", 500, 262)] });
  const r1b = await call(small.client, "create_demand_gen_ad", { ...MULTI_ASSET_ARGS, marketingImages: ["19"] });
  assert.match(textOf(r1b), /o mínimo para paisagem 1\.91:1 é 600x314/);

  const cases: Array<[string, Row, RegExp]> = [
    ["imagem de outra conta", { squareMarketingImages: ["customers/999/assets/12"] }, /pertence à conta 999/],
    ["título longo", { headlines: ["Um título com bem mais de quarenta caracteres aqui"] }, /máximo 40/],
    ["nenhum título curto", { headlines: ["Título com trinta e poucos caracteres x"] }, /até 30 caracteres/],
    ["seis logos", { logoImages: ["15", "15", "15", "15", "15", "15"] }, /logoImages: de 1 a 5/],
    ["sem 1.91 nem 1:1", { marketingImages: [], squareMarketingImages: [] }, /exige ao menos uma imagem 1\.91:1/],
    ["card em multi-asset", { carouselCards: [{ headline: "x", squareMarketingImage: "12" }] }, /carouselCards não se aplica\(m\) a MULTI_ASSET/],
    ["automação de vídeo em multi-asset", { assetAutomation: [{ type: "GENERATE_VERTICAL_YOUTUBE_VIDEOS", status: "OPTED_OUT" }] }, /não vale para MULTI_ASSET/],
    ["URL inválida", { finalUrl: "loja.com.br" }, /finalUrl inválida/],
    ["marca longa", { businessName: "Uma marca com nome comprido demais" }, /máximo 25/],
  ];
  for (const [label, args, pattern] of cases) {
    const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
    const result = await call(client, "create_demand_gen_ad", { ...MULTI_ASSET_ARGS, ...args });
    assert.equal(result.isError, true, label);
    assert.match(textOf(result), pattern, label);
    assert.equal(calls.queries.length + writeCount(calls), 0, `${label}: recusado antes de qualquer chamada`);
  }
});

test("create_demand_gen_ad: carrossel cria os cards com IDs temporários na mesma operação do anúncio", async () => {
  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const result = await call(client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "CAROUSEL", finalUrl: "https://loja.com.br", businessName: "Loja Exemplo",
    logoImages: ["15"], headlines: ["Mais vendidos"], descriptions: ["Escolha o seu."],
    carouselCards: [
      { headline: "Tênis", marketingImage: "11", squareMarketingImage: "12", finalUrl: "https://loja.com.br/tenis" },
      { headline: "Bolsas", marketingImage: "17", squareMarketingImage: "18", callToActionText: "Ver" },
    ],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["assetOperation", "assetOperation", "adGroupAdOperation"]);
  const [card1, card2] = [createOf(ops[0]), createOf(ops[1])];
  assert.equal(card1.resourceName, `customers/${CID}/assets/-1`);
  assert.equal(card2.resourceName, `customers/${CID}/assets/-2`);
  assert.deepEqual(card1.finalUrls, ["https://loja.com.br/tenis"]);
  assert.deepEqual(card2.finalUrls, ["https://loja.com.br"], "sem URL própria, o card usa a do anúncio");
  assert.deepEqual(card1.demandGenCarouselCardAsset, {
    headline: "Tênis", marketingImageAsset: `customers/${CID}/assets/11`, squareMarketingImageAsset: `customers/${CID}/assets/12`,
  });
  assert.equal((card2.demandGenCarouselCardAsset as Row).callToActionText, "Ver");
  const info = (createOf(ops[2]).ad as Row).demandGenCarouselAd as Row;
  assert.deepEqual(info.carouselCards, [{ asset: card1.resourceName }, { asset: card2.resourceName }]);
  assert.deepEqual(info.logoImage, { asset: `customers/${CID}/assets/15` });
  assert.deepEqual(info.headline, { text: "Mais vendidos" });
  assert.equal(info.businessName, "Loja Exemplo");

  const one = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const r2 = await call(one.client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "CAROUSEL", finalUrl: "https://loja.com.br", businessName: "Loja", logoImages: ["15"],
    headlines: ["x"], descriptions: ["y"], carouselCards: [{ headline: "só um", squareMarketingImage: "12" }],
  });
  assert.match(textOf(r2), /de 2 a 10 cards/);
  assert.equal(writeCount(one.calls), 0);
});

test("create_demand_gen_ad: vídeo reaproveita asset existente, cria o que falta e o CTA na mesma operação", async () => {
  const existingVideo = { resourceName: `customers/${CID}/assets/70`, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: "AAAAAAAAAAA" } };
  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], assets: [...IMAGES, existingVideo] });
  const result = await call(client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "VIDEO_RESPONSIVE", finalUrl: "https://loja.com.br", businessName: "Loja Exemplo",
    logoImages: ["15"], youtubeVideoIds: ["AAAAAAAAAAA", "https://www.youtube.com/watch?v=BBBBBBBBBBB"],
    headlines: ["Assista"], longHeadlines: ["A coleção nova em 15 segundos"], descriptions: ["Frete grátis."],
    callToAction: "SHOP_NOW", companionBannerImage: "16", breadcrumb1: "colecao",
    assetAutomation: [{ type: "GENERATE_VERTICAL_YOUTUBE_VIDEOS", status: "OPTED_OUT" }],
  });
  assert.equal(result.isError, undefined, textOf(result));
  const ops = calls.batches[0].operations;
  assert.deepEqual(opKeys(ops), ["assetOperation", "assetOperation", "adGroupAdOperation"]);
  assert.deepEqual(createOf(ops[0]), { resourceName: `customers/${CID}/assets/-1`, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: "BBBBBBBBBBB" } });
  assert.deepEqual(createOf(ops[1]), { resourceName: `customers/${CID}/assets/-2`, type: "CALL_TO_ACTION", callToActionAsset: { callToAction: "SHOP_NOW" } });
  const adGroupAd = createOf(ops[2]);
  const info = (adGroupAd.ad as Row).demandGenVideoResponsiveAd as Row;
  assert.deepEqual(info.videos, [{ asset: `customers/${CID}/assets/70` }, { asset: `customers/${CID}/assets/-1` }]);
  assert.deepEqual(info.callToActions, [{ asset: `customers/${CID}/assets/-2` }]);
  assert.deepEqual(info.businessName, { text: "Loja Exemplo" }, "vídeo: business_name é AdTextAsset");
  assert.deepEqual(info.companionBanners, [{ asset: `customers/${CID}/assets/16` }]);
  assert.equal(info.breadcrumb1, "colecao");
  assert.deepEqual(adGroupAd.adGroupAdAssetAutomationSettings, [{ assetAutomationType: "GENERATE_VERTICAL_YOUTUBE_VIDEOS", assetAutomationStatus: "OPTED_OUT" }]);
  assert.match(textOf(result), /- Assets criados na mesma operação: vídeo BBBBBBBBBBB; CTA SHOP_NOW/);

  // Dry-run (GOOGLE_ADS_DRY_RUN) e validateOnly por chamada: nada é gravado, então os assets novos
  // aparecem como plano — nunca como "criados" (IDs temporários não existem na conta).
  const videoArgs = {
    adGroupId: DG_AD_GROUP, adType: "VIDEO_RESPONSIVE", finalUrl: "https://x.com", businessName: "Loja",
    logoImages: ["15"], youtubeVideoIds: ["BBBBBBBBBBB"], callToAction: "SHOP_NOW",
  };
  const envDry = fakeClient({ dryRun: true, adGroups: [dgAdGroup()], assets: IMAGES });
  const perCall = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  for (const [label, fake, extra] of [["dry-run", envDry, {}], ["validateOnly", perCall, { validateOnly: true }]] as const) {
    const dry = await call(fake.client, "create_demand_gen_ad", { ...videoArgs, ...extra });
    assert.equal(dry.isError, undefined, textOf(dry));
    assert.equal(fake.calls.batches[0].dryRun, true, `${label}: o batch vai com validateOnly`);
    const out = textOf(dry);
    assert.match(out, /DRY-RUN \(validateOnly\)/);
    assert.match(out, /- Assets que seriam criados na mesma operação \(nada foi gravado\): vídeo BBBBBBBBBBB; CTA SHOP_NOW/, label);
    assert.doesNotMatch(out, /Assets criados/, `${label}: não afirma criação de assets`);
    assert.doesNotMatch(out, /criado \(/, `${label}: não afirma criação do anúncio`);
  }

  const reuse = fakeClient({
    adGroups: [dgAdGroup()],
    assets: [...IMAGES, existingVideo, { resourceName: `customers/${CID}/assets/71`, type: "CALL_TO_ACTION", callToActionAsset: { callToAction: "SHOP_NOW" } }],
  });
  await call(reuse.client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "VIDEO_RESPONSIVE", finalUrl: "https://loja.com.br", businessName: "Loja",
    logoImages: ["15"], youtubeVideoIds: ["AAAAAAAAAAA"], callToAction: "SHOP_NOW",
  });
  assert.deepEqual(opKeys(reuse.calls.batches[0].operations), ["adGroupAdOperation"], "nada novo quando vídeo e CTA já existem");

  const bad = fakeClient();
  const r3 = await call(bad.client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "VIDEO_RESPONSIVE", finalUrl: "https://loja.com.br", businessName: "Loja", logoImages: ["15"], youtubeVideoIds: ["video curto"],
  });
  assert.match(textOf(r3), /não é um ID \(11 caracteres\) nem URL do YouTube/);
  assert.equal(bad.calls.queries.length, 0);

  const injected = fakeClient();
  const r4 = await call(injected.client, "create_demand_gen_ad", {
    adGroupId: DG_AD_GROUP, adType: "PRODUCT", finalUrl: "https://loja.com.br", businessName: "Loja", logoImages: ["15"],
    headlines: ["x"], descriptions: ["y"], callToAction: "SHOP_NOW' OR asset.id > 0 OR '",
  });
  assert.match(textOf(r4), /callToAction inválido/);
  assert.equal(injected.calls.queries.length, 0, "CTA fora do enum não chega à GAQL");
});

test("create_demand_gen_ad: prévia da landing page exige confirm", async () => {
  const base = {
    adGroupId: DG_AD_GROUP, adType: "VIDEO_RESPONSIVE", finalUrl: "https://loja.com.br", businessName: "Loja",
    logoImages: ["15"], youtubeVideoIds: ["AAAAAAAAAAA"],
    assetAutomation: [{ type: "GENERATE_LANDING_PAGE_PREVIEW", status: "OPTED_IN" }],
  };
  const gate = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const refused = await call(gate.client, "create_demand_gen_ad", base);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /confirm=true/);
  assert.equal(gate.calls.queries.length + writeCount(gate.calls), 0);

  const ok = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const accepted = await call(ok.client, "create_demand_gen_ad", { ...base, confirm: true });
  assert.equal(accepted.isError, undefined, textOf(accepted));
  assert.equal(ok.calls.batches.length, 1);
});

test("create_demand_gen_ad: produto exige Merchant Center; grupo de outro canal é recusado com a tool certa", async () => {
  const productArgs = {
    adGroupId: DG_AD_GROUP, adType: "PRODUCT", finalUrl: "https://loja.com.br", businessName: "Loja",
    logoImages: ["15"], headlines: ["Ofertas"], descriptions: ["Os mais vendidos."], callToAction: "BUY_NOW",
  };
  const noMerchant = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const r1 = await call(noMerchant.client, "create_demand_gen_ad", productArgs);
  assert.match(textOf(r1), /exige campanha com Merchant Center/);
  assert.equal(writeCount(noMerchant.calls), 0);

  const merchant = fakeClient({ adGroups: [dgAdGroup({}, dgCampaign({ shoppingSetting: { merchantId: "123456" } }))], assets: IMAGES });
  const r2 = await call(merchant.client, "create_demand_gen_ad", productArgs);
  assert.equal(r2.isError, undefined, textOf(r2));
  const ops = merchant.calls.batches[0].operations;
  const info = (createOf(ops[ops.length - 1]).ad as Row).demandGenProductAd as Row;
  assert.deepEqual(info.headline, { text: "Ofertas" });
  assert.deepEqual(info.description, { text: "Os mais vendidos." });
  assert.deepEqual(info.logoImage, { asset: `customers/${CID}/assets/15` });
  assert.deepEqual(info.businessName, { text: "Loja" });
  assert.deepEqual(info.callToAction, { asset: `customers/${CID}/assets/-1` });

  const search = fakeClient({ adGroups: [dgAdGroup({}, dgCampaign({ advertisingChannelType: "SEARCH" }))], assets: IMAGES });
  const r3 = await call(search.client, "create_demand_gen_ad", MULTI_ASSET_ARGS);
  assert.match(textOf(r3), /não DEMAND_GEN — use create_ad \(RSA\)/);
  assert.equal(writeCount(search.calls), 0);
});

test("create_demand_gen_ad: erro da API e validateOnly por chamada", async () => {
  const failing = fakeClient({
    adGroups: [dgAdGroup()], assets: IMAGES,
    batchMutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Too many headlines."); },
  });
  const r1 = await call(failing.client, "create_demand_gen_ad", MULTI_ASSET_ARGS);
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /Nada foi criado \(assets novos e anúncio vão numa única operação atômica\)/);

  const { client, calls } = fakeClient({ adGroups: [dgAdGroup()], assets: IMAGES });
  const r2 = await call(client, "create_demand_gen_ad", { ...MULTI_ASSET_ARGS, validateOnly: true });
  assert.equal(r2.isError, undefined, textOf(r2));
  assert.match(textOf(r2), /VALIDATE-ONLY/);
  assert.match(textOf(r2), /DRY-RUN/);
  assert.equal(calls.batches[0].dryRun, true, "validateOnly roda no client em dry-run");
});

// ══════════════════════════════════════════════════════════════════════
// create_lookalike_segment
// ══════════════════════════════════════════════════════════════════════

const SEEDS = [
  { id: "111", name: "Compradores 180d", type: "CRM_BASED", membershipStatus: "OPEN", sizeForDisplay: "4200", sizeForSearch: "5100" },
  { id: "222", name: "Checkout 30d", type: "RULE_BASED", membershipStatus: "OPEN", sizeForDisplay: "900" },
];

test("create_lookalike_segment: cria com sementes, nível e países (BR por padrão)", async () => {
  const { client, calls } = fakeClient({ userLists: SEEDS });
  const result = await call(client, "create_lookalike_segment", {
    name: "LAL compradores BALANCED", seedUserListIds: ["111", `customers/${CID}/userLists/222`], expansionLevel: "BALANCED",
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(calls.mutates.length, 1);
  assert.equal(calls.mutates[0].resource, "userLists");
  assert.deepEqual(calls.mutates[0].operations[0], {
    create: { name: "LAL compradores BALANCED", lookalikeUserList: { seedUserListIds: ["111", "222"], expansionLevel: "BALANCED", countryCodes: ["BR"] } },
  });
  const out = textOf(result);
  assert.match(out, /Só entrega em campanhas Demand Gen/);
  assert.match(out, /create_audience_from_lists/);
});

test("create_lookalike_segment: duplicado devolve o existente sem gravar; erro DUPLICATE_LOOKALIKE é traduzido", async () => {
  const twin = {
    id: "333", name: "LAL antigo", resourceName: `customers/${CID}/userLists/333`,
    lookalikeUserList: { seedUserListIds: ["222", "111"], expansionLevel: "BROAD", countryCodes: ["BR"] },
  };
  const dup = fakeClient({ userLists: [...SEEDS, twin] });
  const r1 = await call(dup.client, "create_lookalike_segment", { name: "LAL novo", seedUserListIds: ["111", "222"], expansionLevel: "BROAD", countryCodes: ["br"] });
  assert.equal(r1.isError, undefined);
  assert.match(textOf(r1), /Já existe um lookalike .*customers\/1234567890\/userLists\/333/);
  assert.equal(dup.calls.mutates.length, 0);

  const racing = fakeClient({
    userLists: SEEDS,
    mutate: () => { throw new Error("Google Ads API: Request contains an invalid argument. — Cannot create a Lookalike UserList which is a duplicate of an existing Lookalike."); },
  });
  const r2 = await call(racing.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111"], expansionLevel: "NARROW" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /Já existe um lookalike igual \(DUPLICATE_LOOKALIKE\)/);
});

test("create_lookalike_segment: sementes pequenas, inexistentes, país inválido e nome repetido", async () => {
  const small = fakeClient({ userLists: [{ id: "111", name: "Poucos", sizeForDisplay: "40" }, { id: "222", name: "Menos", sizeForDisplay: "20", sizeForSearch: "10" }] });
  const r1 = await call(small.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111", "222"], expansionLevel: "BALANCED" });
  assert.equal(r1.isError, true);
  assert.match(textOf(r1), /somam ~60 pessoa\(s\) e o lookalike exige ao menos 100/);
  assert.equal(small.calls.mutates.length, 0);

  const unknownSize = fakeClient({ userLists: [{ id: "111", name: "Nova" }] });
  const r2 = await call(unknownSize.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111"], expansionLevel: "BALANCED" });
  assert.equal(r2.isError, undefined, "tamanho desconhecido não bloqueia, só avisa");
  assert.match(textOf(r2), /Tamanho ainda não calculado/);

  const missing = fakeClient({ userLists: SEEDS });
  const r3 = await call(missing.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111", "999"], expansionLevel: "BALANCED" });
  assert.match(textOf(r3), /não encontrada\(s\) na conta 1234567890: 999/);
  assert.equal(missing.calls.mutates.length, 0);

  const country = fakeClient({ userLists: SEEDS });
  const r4 = await call(country.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111"], expansionLevel: "BALANCED", countryCodes: ["BRA"] });
  assert.match(textOf(r4), /countryCodes inválidos: BRA/);
  assert.equal(country.calls.queries.length, 0);

  const taken = fakeClient({ userLists: [...SEEDS, { id: "444", name: "LAL" }] });
  const r5 = await call(taken.client, "create_lookalike_segment", { name: "LAL", seedUserListIds: ["111"], expansionLevel: "BALANCED" });
  assert.match(textOf(r5), /Já existe uma lista chamada "LAL"/);
  assert.equal(taken.calls.mutates.length, 0);
});

// ══════════════════════════════════════════════════════════════════════
// Leituras
// ══════════════════════════════════════════════════════════════════════

test("list_demand_gen_ad_groups: canais, segmentação e lances por grupo (json e tabela)", async () => {
  const groups = [
    dgAdGroup({ optimizedTargetingEnabled: true, targetCpcMicros: "1500000" }),
    dgAdGroup({ id: "801", name: "Só Shorts", demandGenAdGroupSettings: { channelControls: { channelConfig: "SELECTED_CHANNELS", selectedChannels: { youtubeShorts: true } } } }),
    { adGroup: { id: "900", name: "Pesquisa" }, campaign: { id: "1", advertisingChannelType: "SEARCH" } },
  ];
  const { client, calls } = fakeClient({
    adGroups: groups,
    adGroupCriteria: [
      ...existingCriteria,
      { adGroup: { id: DG_AD_GROUP }, adGroupCriterion: { type: "LOCATION", negative: true, location: { geoTargetConstant: "geoTargetConstants/1001773" } } },
    ],
  });
  const result = await call(client, "list_demand_gen_ad_groups", {});
  const body = textOf(result);
  const rows = JSON.parse(body.slice(body.indexOf("["))) as Row[];
  assert.equal(rows.length, 2, "só grupos Demand Gen");
  assert.equal(rows[0].channels, "ALL_CHANNELS (padrão)");
  assert.equal(rows[0].optimized_targeting, true);
  assert.equal(rows[0].target_cpc, "R$ 1.50");
  assert.equal(rows[0].locations, "2076");
  assert.equal(rows[0].excluded_locations, "1001773");
  assert.equal(rows[0].languages, "1000");
  assert.equal(rows[1].channels, "YOUTUBE_SHORTS");
  assert.equal(calls.queries.length, 2);

  const table = await call(client, "list_demand_gen_ad_groups", { campaignId: DG_CAMPAIGN, format: "table" });
  assert.match(textOf(table), /channels/);
  const bad = await call(client, "list_demand_gen_ad_groups", { campaignId: "1 OR 1=1" });
  assert.equal(bad.isError, true);
});

test("list_lookalike_segments: sementes, nível e países", async () => {
  const { client } = fakeClient({
    userLists: [{ id: "333", name: "LAL", resourceName: `customers/${CID}/userLists/333`, sizeRangeForDisplay: "TEN_THOUSAND_TO_FIFTY_THOUSAND", eligibleForDisplay: true, lookalikeUserList: { seedUserListIds: ["111"], expansionLevel: "BROAD", countryCodes: ["BR", "PT"] } }],
  });
  const result = await call(client, "list_lookalike_segments", { format: "csv" });
  assert.match(textOf(result), /333,LAL,customers\/1234567890\/userLists\/333,BROAD,111,BR PT/);
});

test("allowlist: tools do lote negam conta fora da lista antes de consultar", async () => {
  const { client, calls } = fakeClient();
  const map = handlers(client, ["9999999999"], true);
  for (const tool of ["list_demand_gen_ad_groups", "create_demand_gen_ad", "create_lookalike_segment", "create_demand_gen_campaign"]) {
    const result = await map.get(tool)!({ customerId: CID, name: "x", adGroupId: DG_AD_GROUP });
    assert.equal(result.isError, true, tool);
    assert.match(textOf(result), /Access denied/, tool);
  }
  assert.equal(calls.queries.length + writeCount(calls), 0);
});

// ══════════════════════════════════════════════════════════════════════
// GoogleAdsClient real, fetch interceptado
// ══════════════════════════════════════════════════════════════════════

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

test("client real em dry-run: campanha Demand Gen sai num único googleAds:mutate com validateOnly", async () => {
  const net = interceptFetch((url, body) => {
    if (url.endsWith(":searchStream")) {
      assertGaqlRules(String(body.query));
      if (String(body.query).includes("FROM customer")) return [{ results: [{ customer: { currencyCode: "BRL" } }] }];
      if (String(body.query).includes("FROM geo_target_constant")) return [{ results: [{ geoTargetConstant: GEO["2076"] }] }];
      return [{ results: [] }];
    }
    return {};
  });
  try {
    const client = new GoogleAdsClient({ credentials: CREDENTIALS, developerToken: "dev", loginCustomerId: CID, dryRun: true });
    const map = handlers(client);
    const result = await map.get("create_demand_gen_campaign")!({
      customerId: CID, name: "DG", dailyBudgetMicros: 50_000_000, locationIds: ["2076"], adGroup: { name: "g" },
    });
    assert.equal(result.isError, undefined, textOf(result));
    const writes = net.calls.filter((c) => /:mutate$/.test(c.url));
    assert.equal(writes.length, 1);
    assert.ok(writes[0].url.endsWith(`/customers/${CID}/googleAds:mutate`));
    assert.equal(writes[0].body.validateOnly, true);
    assert.deepEqual(opKeys(writes[0].body.mutateOperations as Row[]), ["campaignBudgetOperation", "campaignOperation", "adGroupOperation", "adGroupCriterionOperation"]);
    assert.match(textOf(result), /nada foi gravado/);
  } finally {
    net.restore();
  }
});
