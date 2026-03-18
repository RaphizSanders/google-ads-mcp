import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoogleAdsClient } from "./google-ads-client.js";

const text = (s: string) => ({ type: "text" as const, text: s });

function formatJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2) ?? "null";
}

/** Convert cost_micros (string or number) to currency value */
function microsToMoney(micros: unknown): number {
  return Number(micros ?? 0) / 1_000_000;
}

/** Build GAQL date clause from dateRange or days */
function buildDateClause(dateRange?: { since: string; until: string }, days?: number): string {
  if (dateRange?.since && dateRange?.until) {
    return `segments.date BETWEEN '${dateRange.since}' AND '${dateRange.until}'`;
  }
  return `segments.date DURING LAST_${days ?? 30}_DAYS`;
}

/** Format GAQL results as table string */
function formatAsTable(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) return "(no results)";

  // Flatten nested objects
  const flat = results.map((r) => flattenObj(r));
  const keys = [...new Set(flat.flatMap(Object.keys))];

  // Calculate column widths
  const widths = keys.map((k) =>
    Math.max(k.length, ...flat.map((row) => String(row[k] ?? "").length))
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const rows = flat.map((row) =>
    keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join(" | ")
  );

  return [header, separator, ...rows].join("\n");
}

/** Format GAQL results as CSV string */
function formatAsCsv(results: Array<Record<string, unknown>>): string {
  if (results.length === 0) return "";
  const flat = results.map((r) => flattenObj(r));
  const keys = [...new Set(flat.flatMap(Object.keys))];
  const header = keys.join(",");
  const rows = flat.map((row) =>
    keys.map((k) => {
      const v = String(row[k] ?? "");
      return v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

/** Flatten nested object: { campaign: { name: "X" } } → { "campaign.name": "X" } */
function flattenObj(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenObj(v as Record<string, unknown>, key));
    } else {
      result[key] = String(v ?? "");
    }
  }
  return result;
}

/** Extract a numeric metric safely */
function num(val: unknown): number {
  return Number(val ?? 0) || 0;
}

// ── Shared schemas ───────────────────────────────────────────────────

const dateRangeSchema = z
  .object({
    since: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
    until: z.string().describe("End date YYYY-MM-DD (inclusive)"),
  })
  .optional();

const formatSchema = z
  .enum(["json", "table", "csv"])
  .optional()
  .describe("Output format. Default: json.");

const DATE_RANGE_DESC =
  "Custom date range (use this OR days, not both). since and until in YYYY-MM-DD.";

const DAYS_DESC =
  "Number of days to look back (use this OR dateRange, not both). Default: 30.";

// ── Helpers ──────────────────────────────────────────────────────────

/** Ensure value is an array — handles string-serialized arrays from some MCP clients */
function ensureArray<T>(val: T[] | string | unknown): T[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { const parsed = JSON.parse(val); if (Array.isArray(parsed)) return parsed; } catch {}
  }
  return [];
}

/** Zod schema that accepts both array and JSON string of array */
function flexArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.union([z.array(itemSchema), z.string().transform((s) => {
    try { const parsed = JSON.parse(s); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  })]);
}

function checkCustomerAccess(
  customerId: string,
  allowedIds: string[]
): ReturnType<typeof text> | null {
  if (allowedIds.length === 0) return null;
  const cid = customerId.replace(/-/g, "");
  if (!allowedIds.includes(cid)) {
    return {
      type: "text" as const,
      text: `Access denied: customer ${customerId} not in allowed list.`,
    };
  }
  return null;
}

/** Map dimension name to GAQL case_value key */
function dimensionToCaseKey(dimension: string): string {
  const map: Record<string, string> = {
    PRODUCT_BRAND: "productBrand",
    PRODUCT_CATEGORY_LEVEL1: "productCategory",
    PRODUCT_CATEGORY_LEVEL2: "productCategory",
    PRODUCT_CATEGORY_LEVEL3: "productCategory",
    PRODUCT_CATEGORY_LEVEL4: "productCategory",
    PRODUCT_CATEGORY_LEVEL5: "productCategory",
    PRODUCT_TYPE_LEVEL1: "productType",
    PRODUCT_TYPE_LEVEL2: "productType",
    PRODUCT_TYPE_LEVEL3: "productType",
    PRODUCT_TYPE_LEVEL4: "productType",
    PRODUCT_TYPE_LEVEL5: "productType",
    PRODUCT_ITEM_ID: "productItemId",
    PRODUCT_CHANNEL: "productChannel",
    PRODUCT_CUSTOM_ATTRIBUTE0: "productCustomAttribute",
    PRODUCT_CUSTOM_ATTRIBUTE1: "productCustomAttribute",
    PRODUCT_CUSTOM_ATTRIBUTE2: "productCustomAttribute",
    PRODUCT_CUSTOM_ATTRIBUTE3: "productCustomAttribute",
    PRODUCT_CUSTOM_ATTRIBUTE4: "productCustomAttribute",
  };
  return map[dimension] ?? "productBrand";
}

// ── Main Registration ────────────────────────────────────────────────

export function registerGoogleAdsTools(
  mcp: McpServer,
  getClient: () => GoogleAdsClient,
  allowedCustomerIds: string[]
): void {

  // ── Discovery ──────────────────────────────────────────────────────

  mcp.registerTool(
    "list_accounts",
    {
      description: [
        "List all Google Ads accounts accessible from the MCC (Manager account).",
        "Returns child accounts with id, name, currency, timezone, and status.",
        "Use this to discover which customer_id to use in other tools.",
      ].join("\n"),
      inputSchema: {},
    },
    async () => {
      const client = getClient();
      const results = await client.listChildAccounts();
      const accounts = results.map((r) => {
        const c = r.customerClient as Record<string, unknown> | undefined;
        return {
          customer_id: c?.id,
          name: c?.descriptiveName,
          currency: c?.currencyCode,
          timezone: c?.timeZone,
          status: c?.status,
        };
      });
      return {
        content: [text(`${accounts.length} conta(s) encontrada(s).\n\n${formatJson(accounts)}`)],
      };
    }
  );

  mcp.registerTool(
    "get_account_info",
    {
      description:
        "Get details of a specific Google Ads account (name, currency, timezone, status).",
      inputSchema: {
        customerId: z.string().describe("Customer ID (10 digits, with or without hyphens)."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const result = await client.getCustomer(customerId);
      return { content: [text(formatJson(result))] };
    }
  );

  // ── Core: GAQL Runner ──────────────────────────────────────────────

  mcp.registerTool(
    "run_gaql",
    {
      description: [
        "Execute a raw GAQL (Google Ads Query Language) query.",
        "This is the most flexible tool — use it for any custom query.",
        "",
        "Common GAQL resources: campaign, ad_group, ad_group_ad, keyword_view,",
        "shopping_performance_view, geographic_view, age_range_view, gender_view,",
        "search_term_view, customer, ad_group_criterion, campaign_criterion.",
        "",
        "Monetary values are in MICROS (1,000,000 = 1 unit of currency).",
        "Divide cost_micros by 1,000,000 to get BRL/USD value.",
        "",
        "Example:",
        "SELECT campaign.name, metrics.cost_micros, metrics.conversions",
        "FROM campaign",
        "WHERE segments.date BETWEEN '2026-03-01' AND '2026-03-15'",
        "  AND campaign.status != 'REMOVED'",
        "ORDER BY metrics.cost_micros DESC",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (10 digits)."),
        query: z.string().describe("GAQL query string."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId, query);

      const fmt = format ?? "json";
      let output: string;
      if (fmt === "table") {
        output = formatAsTable(results);
      } else if (fmt === "csv") {
        output = formatAsCsv(results);
      } else {
        output = formatJson(results);
      }

      return {
        content: [text(`${results.length} resultado(s).\n\n${output}`)],
      };
    }
  );

  // ── Insights: Campaign Performance ─────────────────────────────────

  mcp.registerTool(
    "get_campaign_performance",
    {
      description: [
        "Get performance metrics for all campaigns in an account.",
        "Returns: campaign name, type, status, spend, impressions, clicks, CTR, CPC,",
        "conversions, conversions_value, ROAS, and cost per conversion.",
        "",
        "Monetary values (spend, CPC, CPA) are already converted from micros to currency.",
        "ROAS = conversions_value / spend.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (10 digits)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        status: z
          .enum(["ALL", "ENABLED", "PAUSED", "REMOVED"])
          .optional()
          .describe("Filter by status. Default: excludes REMOVED."),
      },
    },
    async ({ customerId, dateRange, days, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const statusClause =
        status === "ALL" ? "" : `AND campaign.status ${status ? `= '${status}'` : "!= 'REMOVED'"}`;

      const results = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
                campaign.status, campaign.bidding_strategy_type,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.average_cpc, metrics.conversions,
                metrics.conversions_value, metrics.all_conversions,
                metrics.all_conversions_value
         FROM campaign
         WHERE ${dateClause} ${statusClause}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC`
      );

      const campaigns = results.map((r) => {
        const c = r.campaign as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const convValue = num(m?.conversionsValue);
        return {
          campaign_id: c?.id,
          name: c?.name,
          type: c?.advertisingChannelType,
          status: c?.status,
          bidding: c?.biddingStrategyType,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          cpc: Math.round(microsToMoney(m?.averageCpc) * 100) / 100,
          conversions: conv,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
          cpa: conv > 0 ? Math.round((spend / conv) * 100) / 100 : null,
        };
      });

      return {
        content: [text(`${campaigns.length} campanha(s).\n\n${formatJson(campaigns)}`)],
      };
    }
  );

  // ── Insights: Ad Group Performance ─────────────────────────────────

  mcp.registerTool(
    "get_ad_group_performance",
    {
      description:
        "Get performance metrics for ad groups. Optionally filter by campaign ID.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
      },
    },
    async ({ customerId, dateRange, days, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status,
                campaign.name, campaign.id,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM ad_group
         WHERE ${dateClause}
           AND ad_group.status != 'REMOVED'
           ${campaignFilter}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC`
      );

      const groups = results.map((r) => {
        const ag = r.adGroup as Record<string, unknown>;
        const c = r.campaign as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const convValue = num(m?.conversionsValue);
        return {
          ad_group_id: ag?.id,
          ad_group_name: ag?.name,
          campaign_name: c?.name,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          conversions: conv,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
          cpa: conv > 0 ? Math.round((spend / conv) * 100) / 100 : null,
        };
      });

      return { content: [text(`${groups.length} ad group(s).\n\n${formatJson(groups)}`)] };
    }
  );

  // ── Insights: Ad Performance ───────────────────────────────────────

  mcp.registerTool(
    "get_ad_performance",
    {
      description:
        "Get performance metrics for ads. Optionally filter by campaign ID.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, dateRange, days, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type,
                ad_group_ad.status, ad_group.name, campaign.name,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM ad_group_ad
         WHERE ${dateClause}
           AND ad_group_ad.status != 'REMOVED'
           ${campaignFilter}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT ${limit ?? 50}`
      );

      const ads = results.map((r) => {
        const ad = (r.adGroupAd as Record<string, unknown>)?.ad as Record<string, unknown> | undefined;
        const ag = r.adGroup as Record<string, unknown>;
        const c = r.campaign as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const convValue = num(m?.conversionsValue);
        return {
          ad_id: ad?.id,
          ad_name: ad?.name,
          ad_type: ad?.type,
          ad_group_name: ag?.name,
          campaign_name: c?.name,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          conversions: conv,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
        };
      });

      return { content: [text(`${ads.length} ad(s).\n\n${formatJson(ads)}`)] };
    }
  );

  // ── Insights: Keyword Performance ──────────────────────────────────

  mcp.registerTool(
    "get_keyword_performance",
    {
      description:
        "Get keyword-level performance for Search campaigns. Shows keyword text, match type, quality score, and metrics.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        limit: z.number().optional().describe("Max results. Default: 100."),
      },
    },
    async ({ customerId, dateRange, days, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group_criterion.quality_info.quality_score,
                ad_group_criterion.status,
                campaign.name, ad_group.name,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value,
                metrics.average_cpc
         FROM keyword_view
         WHERE ${dateClause}
           AND ad_group_criterion.status != 'REMOVED'
           ${campaignFilter}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT ${limit ?? 100}`
      );

      const keywords = results.map((r) => {
        const kw = (r.adGroupCriterion as Record<string, unknown>)?.keyword as Record<string, unknown> | undefined;
        const qi = (r.adGroupCriterion as Record<string, unknown>)?.qualityInfo as Record<string, unknown> | undefined;
        const c = r.campaign as Record<string, unknown>;
        const ag = r.adGroup as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        return {
          keyword: kw?.text,
          match_type: kw?.matchType,
          quality_score: qi?.qualityScore,
          campaign: c?.name,
          ad_group: ag?.name,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          cpc: Math.round(microsToMoney(m?.averageCpc) * 100) / 100,
          conversions: conv,
          revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
          roas: spend > 0 ? Math.round((num(m?.conversionsValue) / spend) * 100) / 100 : 0,
        };
      });

      return { content: [text(`${keywords.length} keyword(s).\n\n${formatJson(keywords)}`)] };
    }
  );

  // ── Insights: Shopping Products ────────────────────────────────────

  mcp.registerTool(
    "get_shopping_products",
    {
      description: [
        "Get product-level performance from Shopping/PMax campaigns.",
        "Uses shopping_performance_view. Returns product title, item_id, and metrics.",
        "Monetary values already converted from micros.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        orderBy: z
          .enum(["spend", "revenue", "clicks", "conversions"])
          .optional()
          .describe("Sort order. Default: revenue (conversions_value DESC)."),
        limit: z.number().optional().describe("Max results. Default: 20."),
      },
    },
    async ({ customerId, dateRange, days, orderBy, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const orderMap: Record<string, string> = {
        spend: "metrics.cost_micros DESC",
        revenue: "metrics.conversions_value DESC",
        clicks: "metrics.clicks DESC",
        conversions: "metrics.conversions DESC",
      };
      const order = orderMap[orderBy ?? "revenue"];

      const results = await client.searchStream(
        customerId,
        `SELECT segments.product_title, segments.product_item_id,
                metrics.clicks, metrics.impressions, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM shopping_performance_view
         WHERE ${dateClause}
         ORDER BY ${order}
         LIMIT ${limit ?? 20}`
      );

      const products = results.map((r) => {
        const s = r.segments as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const convValue = num(m?.conversionsValue);
        return {
          title: s?.productTitle,
          item_id: s?.productItemId,
          clicks: num(m?.clicks),
          impressions: num(m?.impressions),
          spend: Math.round(spend * 100) / 100,
          conversions: conv,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
        };
      });

      return { content: [text(`${products.length} produto(s).\n\n${formatJson(products)}`)] };
    }
  );

  // ── Insights: Device Breakdown ─────────────────────────────────────

  mcp.registerTool(
    "get_device_breakdown",
    {
      description: "Get performance metrics broken down by device (MOBILE, DESKTOP, TABLET, etc.).",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT segments.device,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value, metrics.ctr
         FROM customer
         WHERE ${dateClause}`
      );

      const devices = results.map((r) => {
        const s = r.segments as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const convValue = num(m?.conversionsValue);
        return {
          device: s?.device,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          spend: Math.round(spend * 100) / 100,
          conversions: num(m?.conversions),
          revenue: Math.round(convValue * 100) / 100,
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
        };
      });

      return { content: [text(formatJson(devices))] };
    }
  );

  // ── Insights: Daily Trend ──────────────────────────────────────────

  mcp.registerTool(
    "get_daily_trend",
    {
      description: "Get daily performance trend. Returns one row per day with spend, clicks, conversions, revenue.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
      },
    },
    async ({ customerId, dateRange, days, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT segments.date,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM customer
         WHERE ${dateClause} ${campaignFilter}
         ORDER BY segments.date`
      );

      const trend = results.map((r) => {
        const s = r.segments as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        return {
          date: s?.date,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          spend: Math.round(microsToMoney(m?.costMicros) * 100) / 100,
          conversions: num(m?.conversions),
          revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
        };
      });

      return { content: [text(formatJson(trend))] };
    }
  );

  // ── Insights: Geo Performance ──────────────────────────────────────

  mcp.registerTool(
    "get_geo_performance",
    {
      description: "Get performance broken down by geographic location (country, region).",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Max results. Default: 30."),
      },
    },
    async ({ customerId, dateRange, days, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT geographic_view.country_criterion_id,
                geographic_view.location_type,
                campaign_criterion.location.geo_target_constant,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM geographic_view
         WHERE ${dateClause}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT ${limit ?? 30}`
      );

      return { content: [text(`${results.length} location(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Insights: Search Terms ─────────────────────────────────────────

  mcp.registerTool(
    "get_search_terms",
    {
      description: [
        "Get search terms report — actual queries that triggered your ads.",
        "Useful for finding new keyword ideas and negative keywords.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, dateRange, days, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT search_term_view.search_term, search_term_view.status,
                campaign.name, ad_group.name,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM search_term_view
         WHERE ${dateClause}
           ${campaignFilter}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT ${limit ?? 50}`
      );

      const terms = results.map((r) => {
        const stv = r.searchTermView as Record<string, unknown>;
        const c = r.campaign as Record<string, unknown>;
        const ag = r.adGroup as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        return {
          search_term: stv?.searchTerm,
          status: stv?.status,
          campaign: c?.name,
          ad_group: ag?.name,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          spend: Math.round(spend * 100) / 100,
          conversions: num(m?.conversions),
          revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
        };
      });

      return { content: [text(`${terms.length} search term(s).\n\n${formatJson(terms)}`)] };
    }
  );

  // ── Insights: Purchase Conversions ─────────────────────────────────

  mcp.registerTool(
    "get_purchase_conversions",
    {
      description: [
        "Get PURCHASE-only conversions per campaign.",
        "Filters by segments.conversion_action_category = 'PURCHASE'.",
        "Use this to get true e-commerce purchase count (not all conversions).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT campaign.name, segments.conversion_action_category,
                metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${dateClause}
           AND segments.conversion_action_category = 'PURCHASE'
           AND campaign.status != 'REMOVED'
         ORDER BY metrics.conversions_value DESC`
      );

      const campaigns = results.map((r) => {
        const c = r.campaign as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        return {
          campaign_name: c?.name,
          purchase_conversions: num(m?.conversions),
          purchase_revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
        };
      });

      const totalConv = campaigns.reduce((sum, c) => sum + c.purchase_conversions, 0);
      const totalRev = campaigns.reduce((sum, c) => sum + c.purchase_revenue, 0);

      return {
        content: [
          text(
            `Total: ${totalConv} compras, R$ ${totalRev.toFixed(2)} receita.\n\n${formatJson(campaigns)}`
          ),
        ],
      };
    }
  );

  // ── Insights: Compare Periods ──────────────────────────────────────

  mcp.registerTool(
    "compare_periods",
    {
      description: "Compare performance between two date ranges. Returns absolute and percentage deltas.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        periodA: z
          .object({
            since: z.string().describe("Start date YYYY-MM-DD."),
            until: z.string().describe("End date YYYY-MM-DD."),
          })
          .describe("Recent period."),
        periodB: z
          .object({
            since: z.string().describe("Start date YYYY-MM-DD."),
            until: z.string().describe("End date YYYY-MM-DD."),
          })
          .describe("Previous period."),
      },
    },
    async ({ customerId, periodA, periodB }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const query = (since: string, until: string) =>
        `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM customer
         WHERE segments.date BETWEEN '${since}' AND '${until}'`;

      const [resA, resB] = await Promise.all([
        client.searchStream(customerId, query(periodA.since, periodA.until)),
        client.searchStream(customerId, query(periodB.since, periodB.until)),
      ]);

      const extract = (res: Array<Record<string, unknown>>) => {
        const m = (res[0]?.metrics ?? {}) as Record<string, unknown>;
        return {
          spend: microsToMoney(m.costMicros),
          impressions: num(m.impressions),
          clicks: num(m.clicks),
          ctr: num(m.ctr),
          conversions: num(m.conversions),
          revenue: num(m.conversionsValue),
        };
      };

      const a = extract(resA);
      const b = extract(resB);

      const delta = (va: number, vb: number) => ({
        current: Math.round(va * 100) / 100,
        previous: Math.round(vb * 100) / 100,
        change: Math.round((va - vb) * 100) / 100,
        change_pct: vb > 0 ? Math.round(((va - vb) / vb) * 10000) / 100 : null,
      });

      const comparison = {
        periodA: `${periodA.since} → ${periodA.until}`,
        periodB: `${periodB.since} → ${periodB.until}`,
        spend: delta(a.spend, b.spend),
        impressions: delta(a.impressions, b.impressions),
        clicks: delta(a.clicks, b.clicks),
        conversions: delta(a.conversions, b.conversions),
        revenue: delta(a.revenue, b.revenue),
        roas: {
          current: a.spend > 0 ? Math.round((a.revenue / a.spend) * 100) / 100 : 0,
          previous: b.spend > 0 ? Math.round((b.revenue / b.spend) * 100) / 100 : 0,
        },
      };

      return { content: [text(formatJson(comparison))] };
    }
  );

  // ── Insights: Performance Alerts ───────────────────────────────────

  mcp.registerTool(
    "get_performance_alerts",
    {
      description: [
        "Detect performance anomalies: campaigns with ROAS < 1, high spend with no conversions,",
        "or CPA significantly above average. Returns actionable alerts.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT campaign.name, campaign.id,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${dateClause}
           AND campaign.status = 'ENABLED'
           AND metrics.cost_micros > 0
         ORDER BY metrics.cost_micros DESC`
      );

      const alerts: Array<{ level: string; campaign: string; title: string; text: string }> = [];
      const totalSpend = results.reduce((s, r) => s + microsToMoney((r.metrics as Record<string, unknown>)?.costMicros), 0);
      const totalConv = results.reduce((s, r) => s + num((r.metrics as Record<string, unknown>)?.conversions), 0);
      const avgCpa = totalConv > 0 ? totalSpend / totalConv : 0;

      for (const r of results) {
        const c = r.campaign as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const convValue = num(m?.conversionsValue);
        const roas = spend > 0 ? convValue / spend : 0;
        const cpa = conv > 0 ? spend / conv : null;
        const name = String(c?.name ?? "");
        const spendPct = totalSpend > 0 ? (spend / totalSpend) * 100 : 0;

        if (roas < 1 && spendPct > 5) {
          alerts.push({
            level: "danger",
            campaign: name,
            title: `${name} — retorno negativo`,
            text: `ROAS de ${roas.toFixed(2)}x com R$ ${spend.toFixed(2)} investidos (${spendPct.toFixed(1)}% do total).`,
          });
        } else if (conv === 0 && spend > 100) {
          alerts.push({
            level: "warning",
            campaign: name,
            title: `${name} — sem conversões`,
            text: `R$ ${spend.toFixed(2)} investidos sem nenhuma conversão.`,
          });
        } else if (cpa && avgCpa > 0 && cpa > avgCpa * 3 && conv < 10) {
          alerts.push({
            level: "warning",
            campaign: name,
            title: `${name} — CPA elevado`,
            text: `CPA de R$ ${cpa.toFixed(2)} (${(cpa / avgCpa).toFixed(1)}x a média) com ${conv} conversões.`,
          });
        } else if (roas > 15 && spend > totalSpend * 0.03) {
          alerts.push({
            level: "success",
            campaign: name,
            title: `${name} — alta performance`,
            text: `ROAS de ${roas.toFixed(2)}x. Potencial de escala.`,
          });
        }
      }

      return { content: [text(`${alerts.length} alerta(s).\n\n${formatJson(alerts)}`)] };
    }
  );

  // ── Insights: Change History ───────────────────────────────────────

  mcp.registerTool(
    "get_change_history",
    {
      description: "Get recent account change history (who changed what and when).",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Max results. Default: 25."),
      },
    },
    async ({ customerId, dateRange, days, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT change_event.change_date_time, change_event.change_resource_type,
                change_event.changed_fields, change_event.client_type,
                change_event.user_email, change_event.old_resource,
                change_event.new_resource, campaign.name
         FROM change_event
         WHERE ${dateClause}
         ORDER BY change_event.change_date_time DESC
         LIMIT ${limit ?? 25}`
      );

      return { content: [text(`${results.length} change(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Assets: Ad Creatives ───────────────────────────────────────────

  mcp.registerTool(
    "get_ad_creatives",
    {
      description:
        "Get ad creative details: headlines, descriptions, final URLs, and display URL for responsive search ads.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type,
                ad_group_ad.ad.responsive_search_ad.headlines,
                ad_group_ad.ad.responsive_search_ad.descriptions,
                ad_group_ad.ad.final_urls, ad_group_ad.ad.display_url,
                ad_group_ad.status, campaign.name, ad_group.name
         FROM ad_group_ad
         WHERE ad_group_ad.status != 'REMOVED'
           ${campaignFilter}
         LIMIT ${limit ?? 50}`
      );

      return { content: [text(`${results.length} creative(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Assets: Image Assets ───────────────────────────────────────────

  mcp.registerTool(
    "get_image_assets",
    {
      description: "Get image assets from the account's asset library with download URLs.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const results = await client.searchStream(
        customerId,
        `SELECT asset.id, asset.name, asset.type, asset.image_asset.full_size.url,
                asset.image_asset.file_size, asset.resource_name
         FROM asset
         WHERE asset.type = 'IMAGE'
         LIMIT ${limit ?? 50}`
      );

      return { content: [text(`${results.length} image asset(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Assets: Video Assets ───────────────────────────────────────────

  mcp.registerTool(
    "get_video_assets",
    {
      description: "Get YouTube video assets linked to the account.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        limit: z.number().optional().describe("Max results. Default: 20."),
      },
    },
    async ({ customerId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const results = await client.searchStream(
        customerId,
        `SELECT asset.id, asset.name, asset.type,
                asset.youtube_video_asset.youtube_video_id,
                asset.youtube_video_asset.youtube_video_title,
                asset.resource_name
         FROM asset
         WHERE asset.type = 'YOUTUBE_VIDEO'
         LIMIT ${limit ?? 20}`
      );

      return { content: [text(`${results.length} video asset(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Conversions ────────────────────────────────────────────────────

  mcp.registerTool(
    "list_conversion_actions",
    {
      description: "List all conversion actions configured in the account.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const results = await client.searchStream(
        customerId,
        `SELECT conversion_action.id, conversion_action.name,
                conversion_action.type, conversion_action.category,
                conversion_action.status, conversion_action.primary_for_goal,
                conversion_action.counting_type
         FROM conversion_action
         ORDER BY conversion_action.name`
      );

      return { content: [text(`${results.length} conversion action(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ── Negative Keywords (READ) ───────────────────────────────────────

  mcp.registerTool(
    "list_negative_keywords",
    {
      description: "List negative keywords for a campaign or all campaigns.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filter by campaign ID. If omitted, lists all."),
        limit: z.number().optional().describe("Max results. Default: 100."),
      },
    },
    async ({ customerId, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT campaign_criterion.keyword.text,
                campaign_criterion.keyword.match_type,
                campaign.name, campaign.id
         FROM campaign_criterion
         WHERE campaign_criterion.type = 'KEYWORD'
           AND campaign_criterion.negative = true
           ${campaignFilter}
         LIMIT ${limit ?? 100}`
      );

      return { content: [text(`${results.length} negative keyword(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ WRITE OPERATIONS ═════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════

  // ── Campaign Management ────────────────────────────────────────────

  mcp.registerTool(
    "create_campaign",
    {
      description: [
        "Create a new Google Ads campaign with budget.",
        "WRITE OPERATION — creates a real campaign in the account.",
        "Campaign is created PAUSED by default for safety.",
        "",
        "Steps: 1) Creates a campaign budget, 2) Creates the campaign linked to it.",
        "Budget is in MICROS (1,000,000 = R$1.00 / $1.00).",
        "",
        "Supported types: SEARCH, DISPLAY, SHOPPING, PERFORMANCE_MAX, VIDEO, DEMAND_GEN.",
        "Bidding strategies: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS, MANUAL_CPC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        channelType: z
          .enum(["SEARCH", "DISPLAY", "SHOPPING", "PERFORMANCE_MAX", "VIDEO", "DEMAND_GEN"])
          .describe("Campaign type/channel."),
        dailyBudgetMicros: z
          .number()
          .describe("Daily budget in MICROS. Example: 100000000 = R$100/day."),
        biddingStrategy: z
          .enum([
            "MAXIMIZE_CONVERSIONS",
            "MAXIMIZE_CONVERSION_VALUE",
            "TARGET_CPA",
            "TARGET_ROAS",
            "MANUAL_CPC",
          ])
          .optional()
          .describe("Bidding strategy. Default: MAXIMIZE_CONVERSIONS."),
        targetCpaMicros: z
          .number()
          .optional()
          .describe("Target CPA in MICROS (only for TARGET_CPA)."),
        targetRoas: z
          .number()
          .optional()
          .describe("Target ROAS as decimal (e.g. 5.0 = 500%). Only for TARGET_ROAS."),
        networkSettings: z
          .object({
            targetGoogleSearch: z.boolean().optional(),
            targetSearchNetwork: z.boolean().optional(),
            targetContentNetwork: z.boolean().optional(),
          })
          .optional()
          .describe("Network targeting. Default: Google Search only."),
      },
    },
    async ({ customerId, name, channelType, dailyBudgetMicros, biddingStrategy, targetCpaMicros, targetRoas, networkSettings }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Step 1: Create budget
      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        {
          create: {
            name: `Budget — ${name}`,
            amountMicros: String(dailyBudgetMicros),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      ]);

      const budgetResults = (budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const budgetResourceName = budgetResults?.[0]?.resourceName as string;
      if (!budgetResourceName) {
        return { content: [text("Error: failed to create budget.")], isError: true };
      }

      // Step 2: Create campaign
      const campaignData: Record<string, unknown> = {
        name,
        status: "PAUSED",
        advertisingChannelType: channelType,
        campaignBudget: budgetResourceName,
        containsEuPoliticalAdvertising: 3,
        networkSettings: networkSettings ?? {
          targetGoogleSearch: true,
          targetSearchNetwork: false,
          targetContentNetwork: false,
        },
      };

      // Bidding strategy
      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      if (strategy === "MAXIMIZE_CONVERSIONS") {
        campaignData.maximizeConversions = {};
      } else if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
        campaignData.maximizeConversionValue = {};
      } else if (strategy === "TARGET_CPA" && targetCpaMicros) {
        campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      } else if (strategy === "TARGET_ROAS" && targetRoas) {
        campaignData.maximizeConversionValue = { targetRoas };
      } else if (strategy === "MANUAL_CPC") {
        campaignData.manualCpc = { enhancedCpcEnabled: true };
      }

      const campaignResult = await client.mutateCampaigns(customerId, [
        { create: campaignData },
      ]);

      const campaignResults = (campaignResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const campaignResourceName = campaignResults?.[0]?.resourceName as string;

      return {
        content: [
          text(
            `Campaign created (PAUSED):\n` +
              `- Name: ${name}\n` +
              `- Type: ${channelType}\n` +
              `- Budget: R$ ${(dailyBudgetMicros / 1_000_000).toFixed(2)}/day\n` +
              `- Bidding: ${strategy}\n` +
              `- Resource: ${campaignResourceName}\n\n` +
              `Use google_update_campaign to ENABLE when ready.`
          ),
        ],
      };
    }
  );

  mcp.registerTool(
    "update_campaign",
    {
      description: [
        "Update a campaign's settings (name, status, bidding strategy).",
        "WRITE OPERATION — changes take effect immediately.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID (numeric)."),
        name: z.string().optional().describe("New campaign name."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("New status."),
      },
    },
    async ({ customerId, campaignId, name, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const update: Record<string, unknown> = {
        resourceName: `customers/${cid}/campaigns/${campaignId}`,
      };
      const fields: string[] = [];
      if (name) { update.name = name; fields.push("name"); }
      if (status) { update.status = status; fields.push("status"); }

      if (fields.length === 0) {
        return { content: [text("Error: provide at least one field to update.")], isError: true };
      }

      const result = await client.mutateCampaigns(customerId, [
        { update, updateMask: fields.join(",") },
      ]);

      return {
        content: [text(`Campaign ${campaignId} updated: ${fields.join(", ")}.\n\n${formatJson(result)}`)],
      };
    }
  );

  // ── Budget Management ──────────────────────────────────────────────

  mcp.registerTool(
    "update_budget",
    {
      description: [
        "Update a campaign's daily budget.",
        "WRITE OPERATION — changes take effect immediately.",
        "Budget amount is in MICROS (1,000,000 = R$1.00).",
        "",
        "To find the budget resource name, use google_run_gaql:",
        "SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = {campaignId}",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        budgetResourceName: z
          .string()
          .describe("Budget resource name (e.g. customers/123/campaignBudgets/456)."),
        amountMicros: z
          .number()
          .describe("New daily budget in MICROS. 100000000 = R$100/day."),
      },
    },
    async ({ customerId, budgetResourceName, amountMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const result = await client.mutateCampaignBudgets(customerId, [
        {
          update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
          updateMask: "amount_micros",
        },
      ]);

      return {
        content: [
          text(
            `Budget updated to R$ ${(amountMicros / 1_000_000).toFixed(2)}/day.\n\n${formatJson(result)}`
          ),
        ],
      };
    }
  );

  // ── Ad Group Management ────────────────────────────────────────────

  mcp.registerTool(
    "create_ad_group",
    {
      description: [
        "Create an ad group within a campaign.",
        "WRITE OPERATION — created PAUSED by default.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID (numeric)."),
        name: z.string().describe("Ad group name."),
        cpcBidMicros: z
          .number()
          .optional()
          .describe("Default CPC bid in MICROS. Only for MANUAL_CPC campaigns."),
      },
    },
    async ({ customerId, campaignId, name, cpcBidMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const adGroupData: Record<string, unknown> = {
        name,
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        status: "PAUSED",
        type: "SEARCH_STANDARD",
      };

      if (cpcBidMicros) {
        adGroupData.cpcBidMicros = String(cpcBidMicros);
      }

      const result = await client.mutateAdGroups(customerId, [{ create: adGroupData }]);
      return { content: [text(`Ad group created (PAUSED): ${name}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "update_ad_group",
    {
      description: "Update an ad group's name or status.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID (numeric)."),
        name: z.string().optional().describe("New name."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("New status."),
      },
    },
    async ({ customerId, adGroupId, name, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const update: Record<string, unknown> = {
        resourceName: `customers/${cid}/adGroups/${adGroupId}`,
      };
      const fields: string[] = [];
      if (name) { update.name = name; fields.push("name"); }
      if (status) { update.status = status; fields.push("status"); }

      if (fields.length === 0) {
        return { content: [text("Error: provide at least one field.")], isError: true };
      }

      const result = await client.mutateAdGroups(customerId, [
        { update, updateMask: fields.join(",") },
      ]);
      return { content: [text(`Ad group ${adGroupId} updated.\n\n${formatJson(result)}`)] };
    }
  );

  // ── Ad Management ──────────────────────────────────────────────────

  mcp.registerTool(
    "create_ad",
    {
      description: [
        "Create a Responsive Search Ad (RSA) in an ad group.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "Requires 3-15 headlines (max 30 chars each) and 2-4 descriptions (max 90 chars each).",
        "Google will test combinations automatically.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        finalUrl: z.string().describe("Landing page URL."),
        headlines: z
          .array(z.string())
          .describe("3-15 headlines (max 30 chars each)."),
        descriptions: z
          .array(z.string())
          .describe("2-4 descriptions (max 90 chars each)."),
        path1: z.string().optional().describe("Display URL path 1 (max 15 chars)."),
        path2: z.string().optional().describe("Display URL path 2 (max 15 chars)."),
      },
    },
    async ({ customerId, adGroupId, finalUrl, headlines, descriptions, path1, path2 }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const adData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: {
          finalUrls: [finalUrl],
          responsiveSearchAd: {
            headlines: headlines.map((h) => ({ text: h })),
            descriptions: descriptions.map((d) => ({ text: d })),
            ...(path1 && { path1 }),
            ...(path2 && { path2 }),
          },
        },
      };

      const result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      return {
        content: [
          text(
            `RSA created (PAUSED) with ${headlines.length} headlines and ${descriptions.length} descriptions.\n\n${formatJson(result)}`
          ),
        ],
      };
    }
  );

  mcp.registerTool(
    "update_ad_status",
    {
      description: "Pause or enable an ad.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        adId: z.string().describe("Ad ID."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("New status."),
      },
    },
    async ({ customerId, adGroupId, adId, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroupAds(customerId, [
        {
          update: {
            resourceName: `customers/${cid}/adGroupAds/${adGroupId}~${adId}`,
            status,
          },
          updateMask: "status",
        },
      ]);

      return { content: [text(`Ad ${adId} status → ${status}.\n\n${formatJson(result)}`)] };
    }
  );

  // ── Keyword Management ─────────────────────────────────────────────

  mcp.registerTool(
    "create_keyword",
    {
      description: [
        "Add a keyword to an ad group.",
        "WRITE OPERATION.",
        "Match types: EXACT, PHRASE, BROAD.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        keyword: z.string().describe("Keyword text."),
        matchType: z
          .enum(["EXACT", "PHRASE", "BROAD"])
          .describe("Match type."),
        cpcBidMicros: z
          .number()
          .optional()
          .describe("CPC bid in MICROS. If omitted, uses ad group default."),
      },
    },
    async ({ customerId, adGroupId, keyword, matchType, cpcBidMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const criterionData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "ENABLED",
        keyword: { text: keyword, matchType },
        ...(cpcBidMicros && { cpcBidMicros: String(cpcBidMicros) }),
      };

      const result = await client.mutateAdGroupCriteria(customerId, [
        { create: criterionData },
      ]);

      return {
        content: [text(`Keyword added: [${matchType}] "${keyword}"\n\n${formatJson(result)}`)],
      };
    }
  );

  mcp.registerTool(
    "remove_keyword",
    {
      description: "Remove a keyword from an ad group.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        criterionId: z.string().describe("Keyword criterion ID."),
      },
    },
    async ({ customerId, adGroupId, criterionId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroupCriteria(customerId, [
        { remove: `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}` },
      ]);

      return { content: [text(`Keyword ${criterionId} removed.\n\n${formatJson(result)}`)] };
    }
  );

  // ── Negative Keywords (WRITE) ──────────────────────────────────────

  mcp.registerTool(
    "add_negative_keyword",
    {
      description: "Add a negative keyword to a campaign.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        keyword: z.string().describe("Negative keyword text."),
        matchType: z.enum(["EXACT", "PHRASE", "BROAD"]).describe("Match type."),
      },
    },
    async ({ customerId, campaignId, keyword, matchType }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateCampaignCriteria(customerId, [
        {
          create: {
            campaign: `customers/${cid}/campaigns/${campaignId}`,
            negative: true,
            keyword: { text: keyword, matchType },
          },
        },
      ]);

      return {
        content: [text(`Negative keyword added: -[${matchType}] "${keyword}"\n\n${formatJson(result)}`)],
      };
    }
  );

  // ── Bulk Operations ────────────────────────────────────────────────

  mcp.registerTool(
    "bulk_update_status",
    {
      description: [
        "Pause or enable multiple campaigns, ad groups, or ads at once.",
        "WRITE OPERATION.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceType: z
          .enum(["campaigns", "adGroups", "adGroupAds"])
          .describe("Type of resource."),
        resourceIds: z
          .array(z.string())
          .describe("Array of resource IDs. For ads, use 'adGroupId~adId' format."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("New status."),
      },
    },
    async ({ customerId, resourceType, resourceIds, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const operations = resourceIds.map((id) => ({
        update: {
          resourceName: `customers/${cid}/${resourceType}/${id}`,
          status,
        },
        updateMask: "status",
      }));

      const result = await client.mutate(customerId, resourceType, operations);

      return {
        content: [
          text(`${resourceIds.length} ${resourceType} → ${status}.\n\n${formatJson(result)}`),
        ],
      };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ PMAX + ASSET GROUPS + UPLOAD ══════════════════════════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "upload_image_asset",
    {
      description: [
        "Upload an image (base64) to the account's asset library.",
        "WRITE OPERATION — creates a reusable image asset.",
        "Returns the asset resource_name to use in asset groups or ads.",
        "",
        "Supported formats: JPG, PNG, GIF. Max 5MB.",
        "Recommended sizes: 1200x628 (landscape), 1200x1200 (square), 1200x1200 (logo).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Asset name (descriptive, e.g. 'Banner Março 2026')."),
        imageBase64: z.string().describe("Image file content as base64 string."),
      },
    },
    async ({ customerId, name, imageBase64 }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const result = await client.mutateAssets(customerId, [
        {
          create: {
            name,
            type: "IMAGE",
            imageAsset: { data: imageBase64 },
          },
        },
      ]);

      const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined;
      const resourceName = results?.[0]?.resourceName as string;

      return {
        content: [text(`Image asset created: ${name}\nResource: ${resourceName}\n\n${formatJson(result)}`)],
      };
    }
  );

  mcp.registerTool(
    "upload_video_asset",
    {
      description: [
        "Link a YouTube video as an asset in the account.",
        "WRITE OPERATION — creates a reusable video asset.",
        "The video must already be uploaded to YouTube.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        youtubeVideoId: z.string().describe("YouTube video ID (e.g. 'dQw4w9WgXcQ')."),
      },
    },
    async ({ customerId, youtubeVideoId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const result = await client.mutateAssets(customerId, [
        {
          create: {
            type: "YOUTUBE_VIDEO",
            youtubeVideoAsset: { youtubeVideoId },
          },
        },
      ]);

      const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined;
      const resourceName = results?.[0]?.resourceName as string;

      return {
        content: [text(`Video asset linked: ${youtubeVideoId}\nResource: ${resourceName}\n\n${formatJson(result)}`)],
      };
    }
  );

  mcp.registerTool(
    "create_pmax_campaign",
    {
      description: [
        "Create a complete Performance Max campaign with budget and asset group.",
        "WRITE OPERATION — creates a real PMax campaign in the account.",
        "Campaign is created PAUSED by default for safety.",
        "",
        "PMax requires at minimum:",
        "- 3+ headlines (max 30 chars each)",
        "- 2+ long headlines (max 90 chars each)",
        "- 1+ description (max 90 chars each)",
        "- 1+ marketing image asset (landscape 1200x628 recommended)",
        "- 1+ square marketing image asset (1200x1200)",
        "- 1+ logo asset (1200x1200)",
        "- Final URL",
        "",
        "Pass image/logo/video resource names from upload_image_asset or get_image_assets.",
        "For e-commerce: pass merchantId to link the Merchant Center feed.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        dailyBudgetMicros: z.number().describe("Daily budget in MICROS (1000000 = R$1)."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]).optional()
          .describe("Bidding strategy. Default: MAXIMIZE_CONVERSION_VALUE."),
        targetRoas: z.number().optional().describe("Target ROAS (e.g. 5.0 = 500%). Only for MAXIMIZE_CONVERSION_VALUE."),
        assetGroupName: z.string().describe("Name for the asset group."),
        finalUrl: z.string().describe("Final URL (landing page)."),
        headlines: flexArray(z.string()).describe("3-5 headlines (max 30 chars each)."),
        longHeadlines: flexArray(z.string()).describe("1-5 long headlines (max 90 chars each)."),
        descriptions: flexArray(z.string()).describe("1-5 descriptions (max 90 chars each)."),
        businessName: z.string().describe("Business name shown in ads."),
        marketingImageAssets: flexArray(z.string()).describe("Resource names of landscape images (from upload_image_asset)."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Resource names of square images."),
        logoAssets: flexArray(z.string()).describe("Resource names of logo images."),
        videoAssets: flexArray(z.string()).optional().describe("Resource names of video assets (optional)."),
        merchantId: z.string().optional().describe("Merchant Center ID for e-commerce (links product feed)."),
        salesCountry: z.string().optional().describe("Sales country code (e.g. 'BR'). Required with merchantId."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy, targetRoas, assetGroupName, finalUrl, headlines, longHeadlines, descriptions, businessName, marketingImageAssets, squareMarketingImageAssets, logoAssets, videoAssets, merchantId, salesCountry }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Step 1: Create budget
      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        {
          create: {
            name: `Budget — ${name}`,
            amountMicros: String(dailyBudgetMicros),
            deliveryMethod: "STANDARD",
            explicitlyShared: false,
          },
        },
      ]);
      const budgetResults = (budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const budgetResourceName = budgetResults?.[0]?.resourceName as string;
      if (!budgetResourceName) {
        return { content: [text("Error: failed to create budget.")], isError: true };
      }

      // Step 2: Create campaign
      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSION_VALUE";
      const campaignData: Record<string, unknown> = {
        name,
        status: "PAUSED",
        advertisingChannelType: "PERFORMANCE_MAX",
        campaignBudget: budgetResourceName,
        containsEuPoliticalAdvertising: 3,
      };
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
        campaignData.maximizeConversionValue = targetRoas ? { targetRoas } : {};
      } else {
        campaignData.maximizeConversions = {};
      }
      if (merchantId) {
        campaignData.shoppingSetting = {
          merchantId: String(merchantId),
          salesCountry: salesCountry ?? "BR",
        };
      }

      const campaignResult = await client.mutateCampaigns(customerId, [{ create: campaignData }]);
      const campaignResults = (campaignResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const campaignResourceName = campaignResults?.[0]?.resourceName as string;
      if (!campaignResourceName) {
        return { content: [text("Error: failed to create campaign.")], isError: true };
      }

      // Step 3: Create asset group
      const assetGroupData: Record<string, unknown> = {
        name: assetGroupName,
        campaign: campaignResourceName,
        status: "PAUSED",
        finalUrls: [finalUrl],
      };

      const assetGroupResult = await client.mutateAssetGroups(customerId, [{ create: assetGroupData }]);
      const assetGroupResults = (assetGroupResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const assetGroupResourceName = assetGroupResults?.[0]?.resourceName as string;
      if (!assetGroupResourceName) {
        return { content: [text("Error: failed to create asset group.")], isError: true };
      }

      // Step 4: Create text assets (headlines, long headlines, descriptions) and link them
      const textAssetOps: Array<Record<string, unknown>> = [];

      for (const h of headlines) {
        textAssetOps.push({ create: { name: h.substring(0, 30), type: "TEXT", textAsset: { text: h } } });
      }
      for (const lh of longHeadlines) {
        textAssetOps.push({ create: { name: lh.substring(0, 30), type: "TEXT", textAsset: { text: lh } } });
      }
      for (const d of descriptions) {
        textAssetOps.push({ create: { name: d.substring(0, 30), type: "TEXT", textAsset: { text: d } } });
      }

      // Add business name asset
      textAssetOps.push({ create: { name: `BN: ${businessName}`, type: "TEXT", textAsset: { text: businessName } } });

      const textAssetResult = await client.mutateAssets(customerId, textAssetOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      const textAssetResults = (textAssetResult as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined;

      if (!textAssetResults || textAssetResults.length === 0) {
        return { content: [text("Error: failed to create text assets.")], isError: true };
      }

      // Step 5: Link ALL assets to asset group
      const linkOps: Array<Record<string, unknown>> = [];
      let idx = 0;

      // Headlines
      for (let i = 0; i < headlines.length; i++) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: textAssetResults[idx]?.resourceName,
            fieldType: "HEADLINE",
          },
        });
        idx++;
      }
      // Long headlines
      for (let i = 0; i < longHeadlines.length; i++) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: textAssetResults[idx]?.resourceName,
            fieldType: "LONG_HEADLINE",
          },
        });
        idx++;
      }
      // Descriptions
      for (let i = 0; i < descriptions.length; i++) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: textAssetResults[idx]?.resourceName,
            fieldType: "DESCRIPTION",
          },
        });
        idx++;
      }
      // Business name
      linkOps.push({
        create: {
          assetGroup: assetGroupResourceName,
          asset: textAssetResults[idx]?.resourceName,
          fieldType: "BUSINESS_NAME",
        },
      });

      // Marketing images (landscape)
      for (const imgRes of marketingImageAssets) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: imgRes,
            fieldType: "MARKETING_IMAGE",
          },
        });
      }
      // Square marketing images
      for (const imgRes of squareMarketingImageAssets) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: imgRes,
            fieldType: "SQUARE_MARKETING_IMAGE",
          },
        });
      }
      // Logos
      for (const logoRes of logoAssets) {
        linkOps.push({
          create: {
            assetGroup: assetGroupResourceName,
            asset: logoRes,
            fieldType: "LOGO",
          },
        });
      }
      // Videos (optional)
      if (videoAssets) {
        for (const vidRes of videoAssets) {
          linkOps.push({
            create: {
              assetGroup: assetGroupResourceName,
              asset: vidRes,
              fieldType: "YOUTUBE_VIDEO",
            },
          });
        }
      }

      await client.mutateAssetGroupAssets(customerId, linkOps as unknown as import("./google-ads-client.js").MutateOperation[]);

      // Step 6: Create listing group filter (required for PMax — "all products" by default)
      await client.mutateAssetGroupListingGroupFilters(customerId, [
        {
          create: {
            assetGroup: assetGroupResourceName,
            type: "UNIT_INCLUDED",
            listingSource: merchantId ? "SHOPPING" : "WEBPAGE",
          },
        },
      ] as unknown as import("./google-ads-client.js").MutateOperation[]);

      return {
        content: [
          text(
            `PMax campaign created (PAUSED):\n` +
              `- Name: ${name}\n` +
              `- Budget: R$ ${(dailyBudgetMicros / 1_000_000).toFixed(2)}/day\n` +
              `- Bidding: ${strategy}${targetRoas ? ` (target ROAS: ${targetRoas}x)` : ""}\n` +
              `- Asset Group: ${assetGroupName}\n` +
              `  - ${headlines.length} headlines, ${longHeadlines.length} long headlines, ${descriptions.length} descriptions\n` +
              `  - ${marketingImageAssets.length} landscape images, ${squareMarketingImageAssets.length} square images, ${logoAssets.length} logos\n` +
              `  - ${videoAssets?.length ?? 0} videos\n` +
              `${merchantId ? `- Merchant Center: ${merchantId} (${salesCountry ?? "BR"})\n` : ""}` +
              `- Campaign: ${campaignResourceName}\n` +
              `- Asset Group: ${assetGroupResourceName}\n\n` +
              `Use update_campaign to ENABLE when ready.`
          ),
        ],
      };
    }
  );

  mcp.registerTool(
    "create_asset_group",
    {
      description: [
        "Create a new asset group for an existing PMax or Demand Gen campaign.",
        "WRITE OPERATION — adds an asset group to a campaign.",
        "",
        "Use this to add additional asset groups to a PMax campaign (e.g. different product lines).",
        "Each asset group needs its own set of text assets (headlines, descriptions) and image/video assets.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID of existing PMax campaign."),
        name: z.string().describe("Asset group name."),
        finalUrl: z.string().describe("Final URL."),
        headlines: flexArray(z.string()).describe("3-5 headlines (max 30 chars)."),
        longHeadlines: flexArray(z.string()).describe("1-5 long headlines (max 90 chars)."),
        descriptions: flexArray(z.string()).describe("1-5 descriptions (max 90 chars)."),
        businessName: z.string().describe("Business name."),
        marketingImageAssets: flexArray(z.string()).describe("Resource names of landscape images."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Resource names of square images."),
        logoAssets: flexArray(z.string()).describe("Resource names of logos."),
        videoAssets: flexArray(z.string()).optional().describe("Resource names of videos (optional)."),
      },
    },
    async ({ customerId, campaignId, name, finalUrl, headlines, longHeadlines, descriptions, businessName, marketingImageAssets, squareMarketingImageAssets, logoAssets, videoAssets }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const campaignResource = `customers/${cid}/campaigns/${campaignId}`;

      // Create asset group
      const agResult = await client.mutateAssetGroups(customerId, [
        { create: { name, campaign: campaignResource, status: "PAUSED", finalUrls: [finalUrl] } },
      ]);
      const agResults = (agResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      const agResource = agResults?.[0]?.resourceName as string;
      if (!agResource) {
        return { content: [text("Error: failed to create asset group.")], isError: true };
      }

      // Create text assets
      const textOps = [
        ...headlines.map(h => ({ create: { name: h.substring(0, 30), type: "TEXT", textAsset: { text: h } } })),
        ...longHeadlines.map(lh => ({ create: { name: lh.substring(0, 30), type: "TEXT", textAsset: { text: lh } } })),
        ...descriptions.map(d => ({ create: { name: d.substring(0, 30), type: "TEXT", textAsset: { text: d } } })),
        { create: { name: `BN: ${businessName}`, type: "TEXT", textAsset: { text: businessName } } },
      ];

      const textResult = await client.mutateAssets(customerId, textOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      const textResults = (textResult as Record<string, unknown>).results as Array<Record<string, unknown>>;

      // Link assets
      const linkOps: Array<Record<string, unknown>> = [];
      let idx = 0;
      for (let i = 0; i < headlines.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "HEADLINE" } }); }
      for (let i = 0; i < longHeadlines.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "LONG_HEADLINE" } }); }
      for (let i = 0; i < descriptions.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "DESCRIPTION" } }); }
      linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx]?.resourceName, fieldType: "BUSINESS_NAME" } });

      for (const r of marketingImageAssets) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "MARKETING_IMAGE" } }); }
      for (const r of squareMarketingImageAssets) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "SQUARE_MARKETING_IMAGE" } }); }
      for (const r of logoAssets) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "LOGO" } }); }
      if (videoAssets) { for (const r of videoAssets) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "YOUTUBE_VIDEO" } }); } }

      await client.mutateAssetGroupAssets(customerId, linkOps as unknown as import("./google-ads-client.js").MutateOperation[]);

      return {
        content: [text(`Asset group created (PAUSED): ${name}\nResource: ${agResource}\nAssets linked: ${linkOps.length}`)],
      };
    }
  );

  mcp.registerTool(
    "update_asset_group",
    {
      description: [
        "Update an asset group's name, status, or final URL.",
        "WRITE OPERATION — changes take effect immediately.",
        "",
        "To change assets (images, texts), use create_asset_group to create a new one,",
        "or use run_gaql to find existing asset links and mutate them directly.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("Asset group ID."),
        name: z.string().optional().describe("New name."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("New status."),
        finalUrl: z.string().optional().describe("New final URL."),
      },
    },
    async ({ customerId, assetGroupId, name, status, finalUrl }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const update: Record<string, unknown> = {
        resourceName: `customers/${cid}/assetGroups/${assetGroupId}`,
      };
      const fields: string[] = [];
      if (name) { update.name = name; fields.push("name"); }
      if (status) { update.status = status; fields.push("status"); }
      if (finalUrl) { update.finalUrls = [finalUrl]; fields.push("final_urls"); }

      if (fields.length === 0) {
        return { content: [text("Error: provide at least one field to update.")], isError: true };
      }

      const result = await client.mutateAssetGroups(customerId, [
        { update, updateMask: fields.join(",") },
      ]);

      return { content: [text(`Asset group ${assetGroupId} updated: ${fields.join(", ")}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "list_asset_groups",
    {
      description: "List asset groups for a PMax campaign with status and ad strength.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
      },
    },
    async ({ customerId, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const results = await client.searchStream(
        customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.status,
                asset_group.ad_strength, asset_group.primary_status,
                asset_group.final_urls
         FROM asset_group
         WHERE campaign.id = ${campaignId}
           AND asset_group.status != 'REMOVED'`
      );

      const groups = results.map((r) => {
        const ag = r.assetGroup as Record<string, unknown>;
        return {
          asset_group_id: ag?.id,
          name: ag?.name,
          status: ag?.status,
          ad_strength: ag?.adStrength,
          primary_status: ag?.primaryStatus,
          final_urls: ag?.finalUrls,
        };
      });

      return { content: [text(`${groups.length} asset group(s).\n\n${formatJson(groups)}`)] };
    }
  );

  mcp.registerTool(
    "get_asset_group_performance",
    {
      description: "Get performance metrics for asset groups in a PMax campaign.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
      },
    },
    async ({ customerId, campaignId, dateRange, days }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      const results = await client.searchStream(
        customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.ad_strength,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.conversions, metrics.conversions_value
         FROM asset_group
         WHERE campaign.id = ${campaignId}
           AND ${dateClause}
           AND asset_group.status != 'REMOVED'
         ORDER BY metrics.cost_micros DESC`
      );

      const groups = results.map((r) => {
        const ag = r.assetGroup as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const convValue = num(m?.conversionsValue);
        return {
          asset_group_id: ag?.id,
          name: ag?.name,
          ad_strength: ag?.adStrength,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          conversions: num(m?.conversions),
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
        };
      });

      return { content: [text(`${groups.length} asset group(s).\n\n${formatJson(groups)}`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ DISPLAY + VIDEO + SHOPPING + DEMAND GEN ═══════════════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "create_display_campaign",
    {
      description: [
        "Create a Display campaign with targeting.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "Display campaigns show banner ads on Google Display Network (GDN).",
        "After creating, use create_responsive_display_ad to add ads.",
        "Targeting is set at ad group level (audiences, topics, placements).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        dailyBudgetMicros: z.number().describe("Daily budget in MICROS."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "MANUAL_CPC"]).optional()
          .describe("Default: MAXIMIZE_CONVERSIONS."),
        targetCpaMicros: z.number().optional().describe("Target CPA in MICROS."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy, targetCpaMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "DISPLAY", campaignBudget: budgetResource, containsEuPoliticalAdvertising: 3,
        networkSettings: { targetContentNetwork: true, targetGoogleSearch: false, targetSearchNetwork: false },
      };
      if (strategy === "MAXIMIZE_CONVERSIONS") campaignData.maximizeConversions = {};
      else if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = {};
      else if (strategy === "TARGET_CPA" && targetCpaMicros) campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      else if (strategy === "MANUAL_CPC") campaignData.manualCpc = { enhancedCpcEnabled: true };

      const result = await client.mutateCampaigns(customerId, [{ create: campaignData }]);
      const resource = ((result as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      return { content: [text(`Display campaign created (PAUSED): ${name}\nResource: ${resource}\nNext: create an ad group, then create_responsive_display_ad.`)] };
    }
  );

  mcp.registerTool(
    "create_responsive_display_ad",
    {
      description: [
        "Create a Responsive Display Ad in an ad group.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "Requires landscape image, square image, logo, headlines, long headline, descriptions.",
        "Google will auto-generate combinations for different placements.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        finalUrl: z.string().describe("Landing page URL."),
        headlines: flexArray(z.string()).describe("1-5 headlines (max 30 chars)."),
        longHeadline: z.string().describe("Long headline (max 90 chars)."),
        descriptions: flexArray(z.string()).describe("1-5 descriptions (max 90 chars)."),
        businessName: z.string().describe("Business name."),
        marketingImageAssets: flexArray(z.string()).describe("Resource names of landscape images."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Resource names of square images."),
        logoAssets: flexArray(z.string()).describe("Resource names of logos."),
      },
    },
    async ({ customerId, adGroupId, finalUrl, headlines, longHeadline, descriptions, businessName, marketingImageAssets, squareMarketingImageAssets, logoAssets }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const adData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: {
          finalUrls: [finalUrl],
          responsiveDisplayAd: {
            headlines: headlines.map(h => ({ text: h })),
            longHeadline: { text: longHeadline },
            descriptions: descriptions.map(d => ({ text: d })),
            businessName,
            marketingImages: marketingImageAssets.map(r => ({ asset: r })),
            squareMarketingImages: squareMarketingImageAssets.map(r => ({ asset: r })),
            logoImages: logoAssets.map(r => ({ asset: r })),
          },
        },
      };

      const result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      return { content: [text(`Responsive Display Ad created (PAUSED).\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "create_video_campaign",
    {
      description: [
        "Create a Video (YouTube) campaign.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "After creating, use create_video_ad to add video ads.",
        "Supports in-stream (skippable), bumper (6s non-skippable), and video discovery.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        dailyBudgetMicros: z.number().describe("Daily budget in MICROS."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "TARGET_CPA", "MANUAL_CPV"]).optional()
          .describe("Default: MAXIMIZE_CONVERSIONS. MANUAL_CPV for awareness."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "VIDEO", campaignBudget: budgetResource, containsEuPoliticalAdvertising: 3,
      };
      if (strategy === "MAXIMIZE_CONVERSIONS") campaignData.maximizeConversions = {};
      else if (strategy === "TARGET_CPA") campaignData.maximizeConversions = {};
      else if (strategy === "MANUAL_CPV") campaignData.manualCpv = {};

      const result = await client.mutateCampaigns(customerId, [{ create: campaignData }]);
      const resource = ((result as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      return { content: [text(`Video campaign created (PAUSED): ${name}\nResource: ${resource}\nNext: create ad group → create_video_ad.`)] };
    }
  );

  mcp.registerTool(
    "create_video_ad",
    {
      description: [
        "Create a video ad (YouTube) in an ad group.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "The video must already be on YouTube. Use upload_video_asset first if needed.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        youtubeVideoId: z.string().describe("YouTube video ID."),
        finalUrl: z.string().describe("Landing page URL."),
        headline: z.string().optional().describe("Ad headline (for in-feed/discovery)."),
        description: z.string().optional().describe("Ad description."),
        callToAction: z.string().optional().describe("CTA text (e.g. 'Saiba mais', 'Comprar agora'). Max 10 chars."),
      },
    },
    async ({ customerId, adGroupId, youtubeVideoId, finalUrl, headline, description, callToAction }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const videoAdInfo: Record<string, unknown> = {
        video: { youtubeVideoId },
      };
      if (headline) videoAdInfo.headline = { text: headline };
      if (description) videoAdInfo.description1 = { text: description };
      if (callToAction) videoAdInfo.callToAction = { text: callToAction };

      const adData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: {
          finalUrls: [finalUrl],
          videoResponsiveAd: videoAdInfo,
        },
      };

      const result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      return { content: [text(`Video ad created (PAUSED) with video ${youtubeVideoId}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "create_shopping_campaign",
    {
      description: [
        "Create a standard Shopping campaign linked to Merchant Center.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "Requires a Merchant Center account linked to the Google Ads account.",
        "Products are pulled automatically from the Merchant Center feed.",
        "Use product filters to control which products appear.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        merchantId: z.string().describe("Merchant Center ID."),
        dailyBudgetMicros: z.number().describe("Daily budget in MICROS."),
        salesCountry: z.string().optional().describe("Sales country (default: BR)."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MANUAL_CPC", "TARGET_ROAS"]).optional()
          .describe("Default: MAXIMIZE_CONVERSION_VALUE."),
        targetRoas: z.number().optional().describe("Target ROAS."),
        campaignPriority: z.number().optional().describe("Priority: 0 (low), 1 (medium), 2 (high). Default: 0."),
      },
    },
    async ({ customerId, name, merchantId, dailyBudgetMicros, salesCountry, biddingStrategy, targetRoas, campaignPriority }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSION_VALUE";
      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "SHOPPING", campaignBudget: budgetResource, containsEuPoliticalAdvertising: 3,
        shoppingSetting: {
          merchantId: String(merchantId),
          salesCountry: salesCountry ?? "BR",
          campaignPriority: campaignPriority ?? 0,
        },
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
      };
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = targetRoas ? { targetRoas } : {};
      else if (strategy === "MAXIMIZE_CONVERSIONS") campaignData.maximizeConversions = {};
      else if (strategy === "MANUAL_CPC") campaignData.manualCpc = { enhancedCpcEnabled: true };
      else if (strategy === "TARGET_ROAS" && targetRoas) campaignData.maximizeConversionValue = { targetRoas };

      const result = await client.mutateCampaigns(customerId, [{ create: campaignData }]);
      const resource = ((result as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      return { content: [text(`Shopping campaign created (PAUSED): ${name}\nMerchant: ${merchantId}\nResource: ${resource}`)] };
    }
  );

  mcp.registerTool(
    "create_demand_gen_campaign",
    {
      description: [
        "Create a Demand Gen campaign (Discovery + Gmail + YouTube Shorts).",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "Demand Gen uses asset groups (like PMax). After creating the campaign,",
        "use create_asset_group to add asset groups with images and texts.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        dailyBudgetMicros: z.number().describe("Daily budget in MICROS."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA"]).optional()
          .describe("Default: MAXIMIZE_CONVERSIONS."),
        targetCpaMicros: z.number().optional().describe("Target CPA in MICROS."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy, targetCpaMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "DEMAND_GEN", campaignBudget: budgetResource, containsEuPoliticalAdvertising: 3,
      };
      if (strategy === "MAXIMIZE_CONVERSIONS") campaignData.maximizeConversions = targetCpaMicros ? { targetCpaMicros: String(targetCpaMicros) } : {};
      else if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = {};
      else if (strategy === "TARGET_CPA" && targetCpaMicros) campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };

      const result = await client.mutateCampaigns(customerId, [{ create: campaignData }]);
      const resource = ((result as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      return { content: [text(`Demand Gen campaign created (PAUSED): ${name}\nResource: ${resource}\nNext: use create_asset_group to add asset groups.`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ TARGETING + AUDIENCES + EXTENSIONS + DELETES ══════════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "list_audience_segments",
    {
      description: "List available audience segments (custom, in-market, affinity) for targeting.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Search by name (substring match)."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, query, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const nameFilter = query ? `AND audience.name LIKE '%${query}%'` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT audience.id, audience.name, audience.status, audience.description
         FROM audience
         WHERE audience.status = 'ENABLED' ${nameFilter}
         LIMIT ${limit ?? 50}`
      );

      return { content: [text(`${results.length} audience(s).\n\n${formatJson(results)}`)] };
    }
  );

  mcp.registerTool(
    "create_audience_segment",
    {
      description: [
        "Create a custom audience segment based on keywords, URLs, or apps.",
        "WRITE OPERATION.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Audience name."),
        keywords: flexArray(z.string()).optional().describe("Interest keywords (e.g. ['marketing digital', 'e-commerce'])."),
        urls: flexArray(z.string()).optional().describe("URLs of sites your audience visits."),
      },
    },
    async ({ customerId, name, keywords, urls }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const members: Array<Record<string, unknown>> = [];
      if (keywords) {
        for (const kw of keywords) {
          members.push({ keywordInfo: { text: kw, matchType: "BROAD" } });
        }
      }
      if (urls) {
        for (const url of urls) {
          members.push({ urlInfo: { url } });
        }
      }

      const result = await client.mutate(customerId, "customAudiences", [
        {
          create: {
            name,
            type: "AUTO",
            status: "ENABLED",
            members,
          },
        },
      ]);

      return { content: [text(`Custom audience created: ${name}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "update_ad_group_targeting",
    {
      description: [
        "Add audience targeting to an ad group.",
        "WRITE OPERATION — adds an audience criterion.",
        "",
        "Use list_audience_segments to find audience IDs.",
        "Bid modifier: 1.0 = no adjustment, 1.5 = +50%, 0.5 = -50%.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        audienceResourceName: z.string().describe("Audience resource name (from list_audience_segments)."),
        bidModifier: z.number().optional().describe("Bid modifier. Default: 1.0 (no adjustment)."),
      },
    },
    async ({ customerId, adGroupId, audienceResourceName, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroupCriteria(customerId, [
        {
          create: {
            adGroup: `customers/${cid}/adGroups/${adGroupId}`,
            audience: { audience: audienceResourceName },
            bidModifier: bidModifier ?? 1.0,
          },
        },
      ]);

      return { content: [text(`Audience targeting added to ad group ${adGroupId}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "add_placement",
    {
      description: [
        "Add a placement (website, app, or YouTube channel) to an ad group.",
        "WRITE OPERATION — for Display and Video campaigns.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        url: z.string().describe("Placement URL (e.g. 'youtube.com/channel/xxx' or 'example.com')."),
      },
    },
    async ({ customerId, adGroupId, url }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroupCriteria(customerId, [
        {
          create: {
            adGroup: `customers/${cid}/adGroups/${adGroupId}`,
            placement: { url },
          },
        },
      ]);

      return { content: [text(`Placement added: ${url}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "list_extensions",
    {
      description: "List ad extensions (sitelinks, callouts, structured snippets) for a campaign or account.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        limit: z.number().optional().describe("Max results. Default: 50."),
      },
    },
    async ({ customerId, campaignId, limit }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT asset.id, asset.name, asset.type,
                asset.sitelink_asset.description1, asset.sitelink_asset.description2,
                asset.sitelink_asset.link_text, asset.sitelink_asset.final_urls,
                asset.callout_asset.callout_text,
                asset.structured_snippet_asset.header, asset.structured_snippet_asset.values,
                campaign_asset.campaign, campaign_asset.field_type
         FROM campaign_asset
         WHERE campaign_asset.status != 'REMOVED'
           ${campaignFilter}
         LIMIT ${limit ?? 50}`
      );

      return { content: [text(`${results.length} extension(s).\n\n${formatJson(results)}`)] };
    }
  );

  mcp.registerTool(
    "create_sitelink_extension",
    {
      description: [
        "Create a sitelink extension and link it to a campaign.",
        "WRITE OPERATION.",
        "",
        "Sitelinks add additional links below your ad (up to 4 visible).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        linkText: z.string().describe("Sitelink text (max 25 chars)."),
        finalUrl: z.string().describe("Sitelink URL."),
        description1: z.string().optional().describe("Description line 1 (max 35 chars)."),
        description2: z.string().optional().describe("Description line 2 (max 35 chars)."),
      },
    },
    async ({ customerId, campaignId, linkText, finalUrl, description1, description2 }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Create sitelink asset
      const assetData: Record<string, unknown> = {
        type: "SITELINK",
        finalUrls: [finalUrl],
        sitelinkAsset: {
          linkText,
          ...(description1 && { description1 }),
          ...(description2 && { description2 }),
        },
      };

      const assetResult = await client.mutateAssets(customerId, [{ create: assetData }]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      // Link to campaign
      await client.mutateCampaignAssets(customerId, [
        {
          create: {
            campaign: `customers/${cid}/campaigns/${campaignId}`,
            asset: assetResource,
            fieldType: "SITELINK",
          },
        },
      ] as unknown as import("./google-ads-client.js").MutateOperation[]);

      return { content: [text(`Sitelink created: "${linkText}" → ${finalUrl}\nLinked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "create_callout_extension",
    {
      description: [
        "Create a callout extension and link it to a campaign.",
        "WRITE OPERATION.",
        "",
        "Callouts add short text highlights (e.g. 'Frete Grátis', 'Parcelamos em 12x').",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        calloutText: z.string().describe("Callout text (max 25 chars)."),
      },
    },
    async ({ customerId, campaignId, calloutText }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const assetResult = await client.mutateAssets(customerId, [
        { create: { type: "CALLOUT", calloutAsset: { calloutText } } },
      ]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      await client.mutateCampaignAssets(customerId, [
        {
          create: {
            campaign: `customers/${cid}/campaigns/${campaignId}`,
            asset: assetResource,
            fieldType: "CALLOUT",
          },
        },
      ] as unknown as import("./google-ads-client.js").MutateOperation[]);

      return { content: [text(`Callout created: "${calloutText}"\nLinked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "delete_campaign",
    {
      description: [
        "Delete a campaign (sets status to REMOVED).",
        "WRITE OPERATION — campaign stops delivering.",
        "Cannot be undone via API. Use sparingly — prefer pausing.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        confirm: z.boolean().describe("Must be true to confirm deletion."),
      },
    },
    async ({ customerId, campaignId, confirm }) => {
      if (!confirm) return { content: [text("Error: set confirm: true to proceed.")], isError: true };
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateCampaigns(customerId, [
        { remove: `customers/${cid}/campaigns/${campaignId}` },
      ]);

      return { content: [text(`Campaign ${campaignId} REMOVED.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "delete_ad_group",
    {
      description: "Delete an ad group (sets status to REMOVED). Prefer pausing.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        confirm: z.boolean().describe("Must be true."),
      },
    },
    async ({ customerId, adGroupId, confirm }) => {
      if (!confirm) return { content: [text("Error: set confirm: true.")], isError: true };
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroups(customerId, [
        { remove: `customers/${cid}/adGroups/${adGroupId}` },
      ]);

      return { content: [text(`Ad group ${adGroupId} REMOVED.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "delete_ad",
    {
      description: "Delete an ad (sets status to REMOVED). Prefer pausing.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        adId: z.string().describe("Ad ID."),
        confirm: z.boolean().describe("Must be true."),
      },
    },
    async ({ customerId, adGroupId, adId, confirm }) => {
      if (!confirm) return { content: [text("Error: set confirm: true.")], isError: true };
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const result = await client.mutateAdGroupAds(customerId, [
        { remove: `customers/${cid}/adGroupAds/${adGroupId}~${adId}` },
      ]);

      return { content: [text(`Ad ${adId} REMOVED.\n\n${formatJson(result)}`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ BID ADJUSTMENTS + AD SCHEDULE + CONVERSION ACTIONS ════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "set_device_bid_adjustment",
    {
      description: [
        "Set bid adjustment for a specific device type on a campaign.",
        "WRITE OPERATION — changes take effect immediately.",
        "",
        "Bid modifier: 1.0 = no adjustment, 1.5 = +50% bid, 0.5 = -50% bid, 0 = exclude device.",
        "Example: set mobile to 1.3 to bid 30% more on mobile devices.",
        "",
        "Device types: MOBILE, DESKTOP, TABLET, CONNECTED_TV.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        deviceType: z.enum(["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV"]).describe("Device type."),
        bidModifier: z.number().describe("Bid modifier. 1.0 = no change, 1.5 = +50%, 0.5 = -50%, 0 = exclude."),
      },
    },
    async ({ customerId, campaignId, deviceType, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Map device type to criterion ID (Google Ads uses fixed IDs)
      const deviceMap: Record<string, number> = {
        MOBILE: 30001,
        DESKTOP: 30000,
        TABLET: 30002,
        CONNECTED_TV: 30004,
      };
      const criterionId = deviceMap[deviceType];
      const resourceName = `customers/${cid}/campaignCriteria/${campaignId}~${criterionId}`;

      const result = await client.mutateCampaignCriteria(customerId, [
        {
          create: {
            campaign: `customers/${cid}/campaigns/${campaignId}`,
            criterionId: String(criterionId),
            device: { type: deviceType },
            bidModifier,
          },
        },
      ]);

      const pctStr = bidModifier === 0 ? "EXCLUDED" : `${((bidModifier - 1) * 100).toFixed(0)}%`;
      return { content: [text(`Device bid adjustment set: ${deviceType} → ${pctStr} (modifier: ${bidModifier})\nCampaign: ${campaignId}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "set_ad_schedule",
    {
      description: [
        "Set ad schedule (day/time targeting) for a campaign.",
        "WRITE OPERATION — ads will only show during specified time windows.",
        "",
        "Days: MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY.",
        "Hours: 0-24 in 15-minute increments (startHour:startMinute to endHour:endMinute).",
        "",
        "Example: weekdays 8am-6pm = call 5 times with MONDAY-FRIDAY, startHour=8, endHour=18.",
        "Optional bid modifier per schedule: 1.2 = bid 20% more during this time.",
        "",
        "To show ads 24/7 (default), don't set any schedule.",
        "To remove a schedule, delete the criterion via run_gaql.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        dayOfWeek: z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).describe("Day of the week."),
        startHour: z.number().describe("Start hour (0-23)."),
        startMinute: z.enum(["ZERO", "FIFTEEN", "THIRTY", "FORTY_FIVE"]).optional().describe("Start minute. Default: ZERO."),
        endHour: z.number().describe("End hour (1-24). Use 24 for midnight."),
        endMinute: z.enum(["ZERO", "FIFTEEN", "THIRTY", "FORTY_FIVE"]).optional().describe("End minute. Default: ZERO."),
        bidModifier: z.number().optional().describe("Bid modifier for this time slot. Default: 1.0."),
      },
    },
    async ({ customerId, campaignId, dayOfWeek, startHour, startMinute, endHour, endMinute, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const scheduleData: Record<string, unknown> = {
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        adSchedule: {
          dayOfWeek,
          startHour,
          startMinute: startMinute ?? "ZERO",
          endHour,
          endMinute: endMinute ?? "ZERO",
        },
      };
      if (bidModifier !== undefined) scheduleData.bidModifier = bidModifier;

      const result = await client.mutateCampaignCriteria(customerId, [{ create: scheduleData }]);

      return { content: [text(`Ad schedule set: ${dayOfWeek} ${startHour}:00-${endHour}:00 (bid modifier: ${bidModifier ?? 1.0})\nCampaign: ${campaignId}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "create_conversion_action",
    {
      description: [
        "Create a conversion action for tracking.",
        "WRITE OPERATION.",
        "",
        "Types:",
        "- WEBPAGE: tracks conversions on your website (requires Google tag)",
        "- UPLOAD: for offline conversion uploads",
        "- PHONE_CALL: tracks phone calls",
        "",
        "Categories: PURCHASE, ADD_TO_CART, BEGIN_CHECKOUT, LEAD, SIGN_UP, SUBSCRIBE_PAID, PAGE_VIEW, DEFAULT.",
        "",
        "Attribution model: DATA_DRIVEN (recommended), LAST_CLICK, FIRST_CLICK, LINEAR, TIME_DECAY, POSITION_BASED.",
        "Counting: ONE_PER_CLICK (leads) or MANY_PER_CLICK (purchases).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Conversion action name (e.g. 'Purchase', 'Lead Form Submit')."),
        type: z.enum(["WEBPAGE", "UPLOAD", "PHONE_CALL"]).describe("Conversion type."),
        category: z.enum(["PURCHASE", "ADD_TO_CART", "BEGIN_CHECKOUT", "LEAD", "SIGN_UP", "SUBSCRIBE_PAID", "PAGE_VIEW", "DEFAULT"]).describe("Conversion category."),
        countingType: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional().describe("How to count. Default: ONE_PER_CLICK."),
        attributionModel: z.enum(["DATA_DRIVEN", "LAST_CLICK", "FIRST_CLICK", "LINEAR", "TIME_DECAY", "POSITION_BASED"]).optional().describe("Attribution model. Default: DATA_DRIVEN."),
        valueSetting: z.object({
          defaultValue: z.number().optional().describe("Default conversion value."),
          alwaysUseDefaultValue: z.boolean().optional().describe("True = always use default value. False = use dynamic value from tag."),
        }).optional().describe("Conversion value settings."),
        viewThroughLookbackWindowDays: z.number().optional().describe("View-through lookback window (1-30 days). Default: 1."),
        clickThroughLookbackWindowDays: z.number().optional().describe("Click-through lookback window (1-90 days). Default: 30."),
        primary: z.boolean().optional().describe("True = PRIMARY (used for bidding). False = SECONDARY (observation only). Default: true."),
      },
    },
    async ({ customerId, name, type, category, countingType, attributionModel, valueSetting, viewThroughLookbackWindowDays, clickThroughLookbackWindowDays, primary }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const convData: Record<string, unknown> = {
        name,
        type,
        category,
        countingType: countingType ?? "ONE_PER_CLICK",
        attributionModelSettings: {
          attributionModel: attributionModel ?? "GOOGLE_ADS_LAST_CLICK",
          dataDrivenModelStatus: attributionModel === "DATA_DRIVEN" ? "AVAILABLE" : undefined,
        },
        status: "ENABLED",
        primaryForGoal: primary !== false,
      };

      if (valueSetting) {
        convData.valueSettings = {
          defaultValue: valueSetting.defaultValue ?? 0,
          alwaysUseDefaultValue: valueSetting.alwaysUseDefaultValue ?? false,
          defaultCurrencyCode: await client.getAccountCurrency(customerId),
        };
      }

      if (viewThroughLookbackWindowDays) convData.viewThroughLookbackWindowDays = String(viewThroughLookbackWindowDays);
      if (clickThroughLookbackWindowDays) convData.clickThroughLookbackWindowDays = String(clickThroughLookbackWindowDays);

      const result = await client.mutate(customerId, "conversionActions", [{ create: convData }]);

      return { content: [text(`Conversion action created: "${name}"\nType: ${type} | Category: ${category} | Counting: ${countingType ?? "ONE_PER_CLICK"}\nPrimary: ${primary !== false}\n\n${formatJson(result)}`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ P1: LISTING GROUPS + LOCATION + LANGUAGE ══════════════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "set_listing_group_filter",
    {
      description: [
        "Set product filters for a PMax asset group (listing group subdivisions).",
        "WRITE OPERATION.",
        "",
        "Dimensions: PRODUCT_BRAND, PRODUCT_CATEGORY_LEVEL1..5, PRODUCT_TYPE_LEVEL1..5,",
        "PRODUCT_ITEM_ID, PRODUCT_CHANNEL, PRODUCT_CUSTOM_ATTRIBUTE0..4.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("Asset group ID."),
        filters: z.array(z.object({
          dimension: z.string().describe("Dimension key (e.g. 'PRODUCT_BRAND')."),
          value: z.string().describe("Dimension value."),
          included: z.boolean().optional().describe("True=include, False=exclude. Default: true."),
        })).describe("Array of product filters."),
      },
    },
    async ({ customerId, assetGroupId, filters }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const agResource = `customers/${cid}/assetGroups/${assetGroupId}`;

      const existing = await client.searchStream(customerId,
        `SELECT asset_group_listing_group_filter.resource_name FROM asset_group_listing_group_filter WHERE asset_group.id = ${assetGroupId}`);
      if (existing.length > 0) {
        const removeOps = existing.map(r => ({ remove: (r.assetGroupListingGroupFilter as Record<string, unknown>)?.resourceName as string }));
        await client.mutateAssetGroupListingGroupFilters(customerId, removeOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      }

      const rootResult = await client.mutateAssetGroupListingGroupFilters(customerId,
        [{ create: { assetGroup: agResource, type: "SUBDIVISION", listingSource: "SHOPPING" } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      const rootResource = ((rootResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const childOps: Array<Record<string, unknown>> = filters.map(f => ({
        create: { assetGroup: agResource, parentListingGroupFilter: rootResource, type: f.included === false ? "UNIT_EXCLUDED" : "UNIT_INCLUDED", listingSource: "SHOPPING", caseValue: { [dimensionToCaseKey(f.dimension)]: { value: f.value } } },
      }));
      childOps.push({ create: { assetGroup: agResource, parentListingGroupFilter: rootResource, type: "UNIT_INCLUDED", listingSource: "SHOPPING" } });

      const childResult = await client.mutateAssetGroupListingGroupFilters(customerId, childOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Listing group filters set for asset group ${assetGroupId}:\n${filters.map(f => `${f.included === false ? "EXCLUDE" : "INCLUDE"} ${f.dimension} = "${f.value}"`).join("\n")}\n\n${formatJson(childResult)}`)] };
    }
  );

  mcp.registerTool(
    "set_campaign_locations",
    {
      description: [
        "Set geographic targeting for a campaign.",
        "WRITE OPERATION.",
        "",
        "Common IDs: Brazil=2076, São Paulo state=20106, São Paulo city=1001773, Portugal=2620, USA=2840.",
        "Find IDs: run_gaql SELECT geo_target_constant.id, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.name LIKE '%São Paulo%'",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        locationIds: flexArray(z.string()).describe("geo_target_constant IDs."),
        negative: z.boolean().optional().describe("True=exclude. Default: false."),
      },
    },
    async ({ customerId, campaignId, locationIds: rawLocationIds, negative }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const locationIds = ensureArray<string>(rawLocationIds);
      const ops = locationIds.map(locId => ({ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, location: { geoTargetConstant: `geoTargetConstants/${locId}` }, negative: negative ?? false } }));
      const result = await client.mutateCampaignCriteria(customerId, ops as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`${negative ? "Excluded" : "Targeted"} ${locationIds.length} location(s) for campaign ${campaignId}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "set_campaign_languages",
    {
      description: [
        "Set language targeting for a campaign. WRITE OPERATION.",
        "Common IDs: Portuguese=1014, English=1000, Spanish=1003.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        languageIds: flexArray(z.string()).describe("language_constant IDs."),
      },
    },
    async ({ customerId, campaignId, languageIds: rawLangIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const languageIds = ensureArray<string>(rawLangIds);
      const ops = languageIds.map(langId => ({ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, language: { languageConstant: `languageConstants/${langId}` } } }));
      const result = await client.mutateCampaignCriteria(customerId, ops as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Set ${languageIds.length} language(s) for campaign ${campaignId}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "list_merchant_centers",
    {
      description: "List Merchant Center accounts linked to a Google Ads account.",
      inputSchema: { customerId: z.string().describe("Customer ID.") },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId, `SELECT merchant_center_link.id, merchant_center_link.merchant_center_account_name, merchant_center_link.status FROM merchant_center_link`);
      return { content: [text(`${results.length} Merchant Center link(s).\n\n${formatJson(results)}`)] };
    }
  );

  // ══ P2: BID ADJUSTMENTS + EDIT ADS ════════════════════════════════

  mcp.registerTool(
    "set_location_bid_adjustment",
    {
      description: "Set bid adjustment for a location on a campaign. WRITE OPERATION. Use set_campaign_locations first.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        locationId: z.string().describe("geo_target_constant ID."),
        bidModifier: z.number().describe("Bid modifier (1.0=no change, 1.3=+30%)."),
      },
    },
    async ({ customerId, campaignId, locationId, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const result = await client.mutateCampaignCriteria(customerId, [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, location: { geoTargetConstant: `geoTargetConstants/${locationId}` }, bidModifier } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Location bid: ${locationId} → ${bidModifier}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "set_age_bid_adjustment",
    {
      description: "Set bid adjustment for age range on an ad group. WRITE OPERATION.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        ageRange: z.enum(["AGE_RANGE_18_24","AGE_RANGE_25_34","AGE_RANGE_35_44","AGE_RANGE_45_54","AGE_RANGE_55_64","AGE_RANGE_65_UP","AGE_RANGE_UNDETERMINED"]).describe("Age range."),
        bidModifier: z.number().describe("Bid modifier. 0=exclude."),
      },
    },
    async ({ customerId, adGroupId, ageRange, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const result = await client.mutateAdGroupCriteria(customerId, [{ create: { adGroup: `customers/${cid}/adGroups/${adGroupId}`, ageRange: { type: ageRange }, bidModifier } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Age bid: ${ageRange} → ${bidModifier}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "set_gender_bid_adjustment",
    {
      description: "Set bid adjustment for gender on an ad group. WRITE OPERATION.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        gender: z.enum(["MALE","FEMALE","UNDETERMINED"]).describe("Gender."),
        bidModifier: z.number().describe("Bid modifier. 0=exclude."),
      },
    },
    async ({ customerId, adGroupId, gender, bidModifier }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const result = await client.mutateAdGroupCriteria(customerId, [{ create: { adGroup: `customers/${cid}/adGroups/${adGroupId}`, gender: { type: gender }, bidModifier } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Gender bid: ${gender} → ${bidModifier}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "update_ad",
    {
      description: [
        "Update an RSA's headlines, descriptions, or final URL. WRITE OPERATION.",
        "Pass only fields to change. Ads are updated via the ads resource.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adId: z.string().describe("Ad ID."),
        finalUrl: z.string().optional().describe("New final URL."),
        headlines: flexArray(z.string()).optional().describe("New headlines (3-15). Replaces all."),
        descriptions: flexArray(z.string()).optional().describe("New descriptions (2-4). Replaces all."),
        path1: z.string().optional().describe("New path 1."),
        path2: z.string().optional().describe("New path 2."),
      },
    },
    async ({ customerId, adId, finalUrl, headlines, descriptions, path1, path2 }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const updateFields: string[] = [];
      const adUpdate: Record<string, unknown> = { resourceName: `customers/${cid}/ads/${adId}` };
      if (finalUrl) { adUpdate.finalUrls = [finalUrl]; updateFields.push("final_urls"); }
      if (headlines) { adUpdate.responsiveSearchAd = { ...(adUpdate.responsiveSearchAd as Record<string, unknown> ?? {}), headlines: headlines.map(h => ({ text: h })) }; updateFields.push("responsive_search_ad.headlines"); }
      if (descriptions) { adUpdate.responsiveSearchAd = { ...(adUpdate.responsiveSearchAd as Record<string, unknown> ?? {}), descriptions: descriptions.map(d => ({ text: d })) }; updateFields.push("responsive_search_ad.descriptions"); }
      if (path1) { adUpdate.path1 = path1; updateFields.push("path1"); }
      if (path2) { adUpdate.path2 = path2; updateFields.push("path2"); }
      if (updateFields.length === 0) return { content: [text("Error: provide at least one field.")], isError: true };
      const result = await client.mutate(customerId, "ads", [{ update: adUpdate, updateMask: updateFields.join(",") }]);
      return { content: [text(`Ad ${adId} updated: ${updateFields.join(", ")}.\n\n${formatJson(result)}`)] };
    }
  );

  // ══ P3: EXTENSIONS + LABELS + SHARED LISTS ════════════════════════

  mcp.registerTool(
    "create_structured_snippet",
    {
      description: "Create structured snippet extension. WRITE OPERATION. Headers: Brands, Styles, Types, Models, etc.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        header: z.string().describe("Header (e.g. 'Marcas')."),
        values: flexArray(z.string()).describe("3-10 values."),
      },
    },
    async ({ customerId, campaignId, header, values }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const assetResult = await client.mutateAssets(customerId, [{ create: { type: "STRUCTURED_SNIPPET", structuredSnippetAsset: { header, values } } }]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      await client.mutateCampaignAssets(customerId, [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, fieldType: "STRUCTURED_SNIPPET" } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Structured snippet: ${header}: ${values.join(", ")}\nLinked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "create_call_extension",
    {
      description: "Create call extension (phone number). WRITE OPERATION.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        phoneNumber: z.string().describe("Phone (e.g. '+5511999999999')."),
        countryCode: z.string().optional().describe("Default: BR."),
      },
    },
    async ({ customerId, campaignId, phoneNumber, countryCode }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const assetResult = await client.mutateAssets(customerId, [{ create: { type: "CALL", callAsset: { phoneNumber, countryCode: countryCode ?? "BR" } } }]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      await client.mutateCampaignAssets(customerId, [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, fieldType: "CALL" } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Call extension: ${phoneNumber}\nLinked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "create_price_extension",
    {
      description: "Create price extension. WRITE OPERATION. Types: PRODUCT_CATEGORIES, BRANDS, SERVICES, etc.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        priceType: z.string().describe("Price type."),
        items: z.array(z.object({
          header: z.string(), description: z.string(), priceAmount: z.number(),
          currencyCode: z.string().optional(), finalUrl: z.string(), unit: z.string().optional(),
        })).describe("3-8 price items."),
      },
    },
    async ({ customerId, campaignId, priceType, items }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const priceOfferings = items.map(i => ({ header: i.header, description: i.description, price: { amountMicros: String(Math.round(i.priceAmount * 1_000_000)), currencyCode: i.currencyCode ?? "BRL" }, finalUrl: i.finalUrl, ...(i.unit && { unit: i.unit }) }));
      const assetResult = await client.mutateAssets(customerId, [{ create: { type: "PRICE", priceAsset: { type: priceType, priceOfferings } } }]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      await client.mutateCampaignAssets(customerId, [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, fieldType: "PRICE" } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Price extension (${priceType}) with ${items.length} items. Linked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "create_promotion_extension",
    {
      description: "Create promotion extension. WRITE OPERATION. Occasions: BLACK_FRIDAY, CHRISTMAS, CARNIVAL, NONE.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        promotionTarget: z.string().describe("What's promoted (e.g. 'Frete Grátis')."),
        percentOff: z.number().optional().describe("Percent off (e.g. 20)."),
        moneyAmountOff: z.number().optional().describe("Money off in currency."),
        occasion: z.string().optional().describe("Default: NONE."),
        finalUrl: z.string().describe("Landing page."),
      },
    },
    async ({ customerId, campaignId, promotionTarget, percentOff, moneyAmountOff, occasion, finalUrl }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const promoData: Record<string, unknown> = { promotionTarget, discountModifier: "NONE", occasion: occasion ?? "NONE", redemptionStartDate: new Date().toISOString().split("T")[0], redemptionEndDate: new Date(Date.now() + 90*24*60*60*1000).toISOString().split("T")[0] };
      if (percentOff) promoData.percentOff = percentOff * 10000;
      if (moneyAmountOff) promoData.moneyAmountOff = { amountMicros: String(Math.round(moneyAmountOff * 1_000_000)), currencyCode: "BRL" };
      const assetResult = await client.mutateAssets(customerId, [{ create: { type: "PROMOTION", promotionAsset: promoData, finalUrls: [finalUrl] } }]);
      const assetResource = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      await client.mutateCampaignAssets(customerId, [{ create: { campaign: `customers/${cid}/campaigns/${campaignId}`, asset: assetResource, fieldType: "PROMOTION" } }] as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Promotion: "${promotionTarget}"${percentOff ? ` ${percentOff}% off` : ""}. Linked to campaign ${campaignId}.`)] };
    }
  );

  mcp.registerTool(
    "create_label",
    {
      description: "Create a label for organizing campaigns/ad groups/ads.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Label name."),
      },
    },
    async ({ customerId, name }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const result = await client.mutate(customerId, "labels", [{ create: { name } }]);
      return { content: [text(`Label created: "${name}"\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "assign_label",
    {
      description: "Assign a label to a campaign, ad group, or ad. WRITE OPERATION.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceType: z.enum(["campaign","adGroup","adGroupAd"]).describe("Resource type."),
        resourceId: z.string().describe("Resource ID."),
        labelId: z.string().describe("Label ID."),
      },
    },
    async ({ customerId, resourceType, resourceId, labelId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const resMap: Record<string, string> = { campaign: "campaignLabels", adGroup: "adGroupLabels", adGroupAd: "adGroupAdLabels" };
      const pathMap: Record<string, string> = { campaign: "campaigns", adGroup: "adGroups", adGroupAd: "adGroupAds" };
      const result = await client.mutate(customerId, resMap[resourceType], [{ create: { [resourceType]: `customers/${cid}/${pathMap[resourceType]}/${resourceId}`, label: `customers/${cid}/labels/${labelId}` } }]);
      return { content: [text(`Label ${labelId} → ${resourceType} ${resourceId}.\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "list_labels",
    {
      description: "List all labels in the account.",
      inputSchema: { customerId: z.string().describe("Customer ID.") },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.status = 'ENABLED'`);
      return { content: [text(`${results.length} label(s).\n\n${formatJson(results)}`)] };
    }
  );

  mcp.registerTool(
    "create_shared_negative_list",
    {
      description: "Create shared negative keyword list. WRITE OPERATION. Can attach to multiple campaigns.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("List name."),
        keywords: z.array(z.object({ text: z.string(), matchType: z.enum(["EXACT","PHRASE","BROAD"]) })).describe("Keywords."),
        campaignIds: flexArray(z.string()).optional().describe("Campaign IDs to attach."),
      },
    },
    async ({ customerId, name, keywords, campaignIds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const setResult = await client.mutate(customerId, "sharedSets", [{ create: { name, type: "NEGATIVE_KEYWORDS" } }]);
      const setResource = ((setResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      const kwOps = keywords.map(kw => ({ create: { sharedSet: setResource, keyword: { text: kw.text, matchType: kw.matchType } } }));
      await client.mutate(customerId, "sharedCriteria", kwOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      if (campaignIds && campaignIds.length > 0) {
        const attachOps = campaignIds.map(cmpId => ({ create: { campaign: `customers/${cid}/campaigns/${cmpId}`, sharedSet: setResource } }));
        await client.mutate(customerId, "campaignSharedSets", attachOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      }
      return { content: [text(`Shared list "${name}" with ${keywords.length} keywords.${campaignIds ? ` Attached to ${campaignIds.length} campaign(s).` : ""}\nResource: ${setResource}`)] };
    }
  );

  // ══ REMARKETING LISTS ══════════════════════════════════════════════

  mcp.registerTool(
    "list_remarketing_lists",
    {
      description: [
        "List all remarketing/audience lists in the account with size and membership details.",
        "Shows list name, type, size for display/search, membership lifespan, and status.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Filter by name (substring match)."),
      },
    },
    async ({ customerId, query }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const nameFilter = query ? `AND user_list.name LIKE '%${query}%'` : "";

      const results = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name, user_list.type, user_list.status,
                user_list.size_for_display, user_list.size_for_search,
                user_list.membership_life_span, user_list.description,
                user_list.membership_status, user_list.eligible_for_display,
                user_list.eligible_for_search
         FROM user_list
         WHERE user_list.status != 'REMOVED' ${nameFilter}
         ORDER BY user_list.size_for_display DESC`
      );

      const lists = results.map(r => {
        const ul = r.userList as Record<string, unknown>;
        return {
          id: ul?.id,
          name: ul?.name,
          type: ul?.type,
          status: ul?.status,
          size_display: ul?.sizeForDisplay,
          size_search: ul?.sizeForSearch,
          membership_days: ul?.membershipLifeSpan,
          membership_status: ul?.membershipStatus,
          eligible_display: ul?.eligibleForDisplay,
          eligible_search: ul?.eligibleForSearch,
          description: ul?.description,
        };
      });

      return { content: [text(`${lists.length} remarketing list(s).\n\n${formatJson(lists)}`)] };
    }
  );

  mcp.registerTool(
    "create_remarketing_list",
    {
      description: [
        "Create a rule-based remarketing list.",
        "WRITE OPERATION.",
        "",
        "Rule types:",
        "- URL contains: match visitors who visited pages containing a string",
        "- URL equals: match visitors who visited an exact URL",
        "- Custom combination: combine multiple rules with AND/OR",
        "",
        "For GA4-based lists, create in GA4 and they sync automatically.",
        "For CRM/customer match lists, use Google Ads UI (requires hashed data upload).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("List name."),
        description: z.string().optional().describe("List description."),
        membershipLifeSpan: z.number().describe("Days a user stays in the list (1-540). Common: 30, 60, 90."),
        rules: z.array(z.object({
          ruleType: z.enum(["URL_CONTAINS", "URL_EQUALS", "CUSTOM_EVENT"]).describe("Rule type."),
          value: z.string().describe("Value to match (URL string or event name)."),
        })).describe("Rules for list membership."),
        ruleOperator: z.enum(["AND", "OR"]).optional().describe("How to combine rules. Default: OR."),
        excludeRules: z.array(z.object({
          ruleType: z.enum(["URL_CONTAINS", "URL_EQUALS", "CUSTOM_EVENT"]).describe("Rule type to exclude."),
          value: z.string().describe("Value to match for exclusion."),
        })).optional().describe("Exclusion rules (e.g. exclude purchasers)."),
        excludeLifeSpan: z.number().optional().describe("Days for exclusion rule (e.g. 7 = exclude purchasers from last 7 days)."),
      },
    },
    async ({ customerId, name, description, membershipLifeSpan, rules, ruleOperator, excludeRules, excludeLifeSpan }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const makeRuleItem = (r: unknown) => {
        const rule = r as Record<string, string>;
        const op = rule.ruleType === "URL_CONTAINS" ? "CONTAINS" : "EQUALS";
        const fieldName = rule.ruleType === "CUSTOM_EVENT" ? "ecomm_pagetype" : "url__";
        return { name: fieldName, stringRuleItem: { operator: op, value: rule.value } };
      };

      const inclusiveRuleItems = ensureArray(rules).map(makeRuleItem);

      const flexRule: Record<string, unknown> = {
        inclusiveRuleOperator: (ruleOperator ?? "OR") === "AND" ? "AND" : "OR",
        inclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: inclusiveRuleItems }] } }],
      };

      if (excludeRules && ensureArray(excludeRules).length > 0) {
        const exclusiveRuleItems = ensureArray(excludeRules).map(makeRuleItem);
        flexRule.exclusiveOperands = [{
          rule: { ruleItemGroups: [{ ruleItems: exclusiveRuleItems }] },
          ...(excludeLifeSpan && { lookbackWindowDays: excludeLifeSpan }),
        }];
      }

      const ruleBasedUserList = { flexibleRuleUserList: flexRule };

      const listData: Record<string, unknown> = {
        name,
        membershipLifeSpan,
        membershipStatus: "OPEN",
        ruleBasedUserList,
      };
      if (description) listData.description = description;

      const result = await client.mutateUserLists(customerId, [{ create: listData }]);
      const results = (result as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined;
      const resourceName = results?.[0]?.resourceName as string;

      return { content: [text(`Remarketing list created: "${name}"\nMembership: ${membershipLifeSpan} days\nRules: ${ensureArray(rules).length} inclusion, ${ensureArray(excludeRules).length} exclusion\nResource: ${resourceName}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "update_remarketing_list",
    {
      description: [
        "Update an existing remarketing list (name, description, membership lifespan).",
        "WRITE OPERATION.",
        "",
        "Note: Rules cannot be changed after creation. To change rules, create a new list.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userListId: z.string().describe("User list ID."),
        name: z.string().optional().describe("New name."),
        description: z.string().optional().describe("New description."),
        membershipLifeSpan: z.number().optional().describe("New membership lifespan in days (1-540)."),
        status: z.enum(["OPEN", "CLOSED"]).optional().describe("OPEN = accepting new members, CLOSED = no new members."),
      },
    },
    async ({ customerId, userListId, name, description, membershipLifeSpan, status }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const update: Record<string, unknown> = {
        resourceName: `customers/${cid}/userLists/${userListId}`,
      };
      const fields: string[] = [];

      if (name) { update.name = name; fields.push("name"); }
      if (description) { update.description = description; fields.push("description"); }
      if (membershipLifeSpan) { update.membershipLifeSpan = membershipLifeSpan; fields.push("membership_life_span"); }
      if (status) { update.membershipStatus = status; fields.push("membership_status"); }

      if (fields.length === 0) {
        return { content: [text("Error: provide at least one field to update.")], isError: true };
      }

      const result = await client.mutateUserLists(customerId, [
        { update, updateMask: fields.join(",") },
      ]);

      return { content: [text(`Remarketing list ${userListId} updated: ${fields.join(", ")}.\n\n${formatJson(result)}`)] };
    }
  );

  // ── Account Currency (compat) ──────────────────────────────────────

  mcp.registerTool(
    "get_account_currency",
    {
      description: "Get the currency code for a Google Ads account.",
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const currency = await client.getAccountCurrency(customerId);
      return { content: [text(currency)] };
    }
  );
}
