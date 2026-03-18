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

// ── Main Registration ────────────────────────────────────────────────

export function registerGoogleAdsTools(
  mcp: McpServer,
  getClient: () => GoogleAdsClient,
  allowedCustomerIds: string[]
): void {

  // ── Discovery ──────────────────────────────────────────────────────

  mcp.registerTool(
    "google_list_accounts",
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
    "google_get_account_info",
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
    "google_run_gaql",
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
    "google_get_campaign_performance",
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
    "google_get_ad_group_performance",
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
    "google_get_ad_performance",
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
    "google_get_keyword_performance",
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
    "google_get_shopping_products",
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
    "google_get_device_breakdown",
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
    "google_get_daily_trend",
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
    "google_get_geo_performance",
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
    "google_get_search_terms",
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
    "google_get_purchase_conversions",
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
    "google_compare_periods",
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
    "google_get_performance_alerts",
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
    "google_get_change_history",
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
    "google_get_ad_creatives",
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
    "google_get_image_assets",
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
    "google_get_video_assets",
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
    "google_list_conversion_actions",
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
    "google_list_negative_keywords",
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
    "google_create_campaign",
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
    "google_update_campaign",
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
    "google_update_budget",
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
    "google_create_ad_group",
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
    "google_update_ad_group",
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
    "google_create_ad",
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
    "google_update_ad_status",
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
    "google_create_keyword",
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
    "google_remove_keyword",
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
    "google_add_negative_keyword",
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
    "google_bulk_update_status",
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

  // ── Account Currency (compat) ──────────────────────────────────────

  mcp.registerTool(
    "google_get_account_currency",
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
