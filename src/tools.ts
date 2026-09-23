import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GoogleAdsClient } from "./google-ads-client.js";
import {
  AI_MAX_MATCH_SOURCES,
  ATTRIBUTION_MODEL_ALIASES,
  CHAINED_WRITE_TOOLS,
  CHANGE_EVENT_MAX_DAYS,
  CONVERSION_CATEGORIES,
  CONVERSION_CATEGORY_ALIASES,
  CONVERSION_TYPE_ALIASES,
  DATE_RANGE_DESC,
  DAYS_DESC,
  DURING_LAST_N_DAYS,
  EU_POLITICAL_DECLARATION,
  ISO_DATE,
  LISTING_GROUP_DIMENSIONS,
  LOW_BID_MICROS,
  MANUAL_BID_STRATEGIES,
  MAX_CAMPAIGN_IMAGES_PER_CALL,
  MAX_MESSAGING_RESTRICTIONS,
  MAX_MESSAGING_RESTRICTION_CHARS,
  MAX_TERM_EXCLUSIONS,
  MAX_TERM_EXCLUSION_CHARS,
  SEARCH_TERM_MATCH_SOURCES,
  VALIDATE_ONLY_BANNER,
  addMetrics,
  attributionModelSchema,
  buildChangeEventDateClause,
  buildDateClause,
  buildListingGroupCaseValue,
  checkCustomerAccess,
  conversionCategorySchema,
  conversionTypeSchema,
  dateRangeSchema,
  emptyTotals,
  ensureArray,
  explainBiddingError,
  fetchCampaignImageLinks,
  flattenObj,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  imageAspectLabel,
  isPositiveMicros,
  localIsoDate,
  metricsView,
  microsToMoney,
  money,
  num,
  parseImageAssetRef,
  partialFailureByOperation,
  resolveEnumAlias,
  round2,
  text,
  validateOnlyScope,
  withValidateOnlyParam,
} from "./tool-kit.js";
import type { MetricTotals } from "./tool-kit.js";
import { TOOL_MODULES } from "./tools/index.js";

export {
  CONVERSION_CATEGORIES,
  CONVERSION_CATEGORY_ALIASES,
  CONVERSION_TYPE_ALIASES,
  ATTRIBUTION_MODEL_ALIASES,
  conversionCategorySchema,
  conversionTypeSchema,
  attributionModelSchema,
  resolveEnumAlias,
} from "./tool-kit.js";


// ── Main Registration ────────────────────────────────────────────────

export function registerGoogleAdsTools(
  mcp: McpServer,
  getClient: () => GoogleAdsClient,
  allowedCustomerIds: string[],
  hosted = false
): void {
  mcp = withValidateOnlyParam(mcp);
  const baseGetClient = getClient;
  getClient = () => {
    const client = baseGetClient();
    return validateOnlyScope.getStore() ? client.withDryRun() : client;
  };
  const allowAllCustomers = allowedCustomerIds.includes("*");
  const allowedCustomerIdSet = new Set(
    allowedCustomerIds.filter((id) => id !== "*").map((id) => id.replace(/-/g, ""))
  );

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
      const accounts = results
        .map((r) => {
          const c = r.customerClient as Record<string, unknown> | undefined;
          return {
            customer_id: c?.id,
            name: c?.descriptiveName,
            currency: c?.currencyCode,
            timezone: c?.timeZone,
            status: c?.status,
          };
        })
        /* A hosted run must not enumerate the whole MCC just because no
           allowlist was given, so there an empty set filters everything out.
           On stdio there is no cross-tenant surface and this tool is the
           discovery entry point — the id you would need to allowlist is
           precisely what you come here to find — so an empty set means
           "no filter". */
        .filter((account) =>
          allowAllCustomers
            ? true
            : allowedCustomerIdSet.size === 0
              ? !hosted
              : allowedCustomerIdSet.has(String(account.customer_id ?? "").replace(/-/g, ""))
        );
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const statusClause =
        status === "ALL" ? "" : `AND campaign.status ${status ? `= '${status}'` : "!= 'REMOVED'"}`;

      const results = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
                campaign.status, campaign.bidding_strategy_type,
                campaign.ai_max_setting.enable_ai_max,
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
          ai_max: Boolean((c?.aiMaxSetting as Record<string, unknown> | undefined)?.enableAiMax),
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // get_ad_performance: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ── Insights: Keyword Performance ──────────────────────────────────

  mcp.registerTool(
    "get_keyword_performance",
    {
      description: [
        "Get keyword-level performance for Search campaigns. Shows keyword text, match type, quality score, and metrics.",
        "Cada linha traz criterion_id, ad_group_id e campaign_id (para update_keyword / remove_keyword /",
        "bulk_update_keyword_status). Só lista palavras-chave com impressão no período — para ver todas,",
        "inclusive as sem impressão, use list_keywords.",
        "",
        "diagnostics=true acrescenta os componentes do Índice de Qualidade (relevância do anúncio,",
        "experiência na página, CTR esperada), status e motivos, lance efetivo, estimativas de 1ª página",
        "e a coluna fix (LP, AD, CTR, BID, VOLUME, POLICY, NEGATIVE, QS).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        adGroupId: z.string().optional().describe("Filtra por grupo de anúncios (ID numérico)."),
        diagnostics: z.boolean().optional().describe("true = inclui componentes do Índice de Qualidade, status/motivos, lances e a coluna fix."),
        limit: z.number().optional().describe("Max results. Default: 100."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, adGroupId, diagnostics, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // IDs e limit entram crus na GAQL: só dígitos / inteiro positivo passam
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      if (adGroupId !== undefined && !/^\d+$/.test(adGroupId)) {
        return { content: [text(`adGroupId deve ser numérico, recebido "${adGroupId}".`)], isError: true };
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        return { content: [text(`limit deve ser inteiro positivo (recebido ${limit}).`)], isError: true };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";
      const adGroupFilter = adGroupId ? `AND ad_group.id = ${adGroupId}` : "";
      const keywordsModule = diagnostics ? await import("./tools/keywords.js") : undefined;
      const diagnosticFields = keywordsModule ? `${keywordsModule.KEYWORD_DIAGNOSTIC_FIELDS.join(", ")},` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group_criterion.criterion_id,
                ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type,
                ad_group_criterion.quality_info.quality_score,
                ad_group_criterion.status,
                ${diagnosticFields}
                campaign.id, campaign.name, ad_group.id, ad_group.name,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value,
                metrics.average_cpc
         FROM keyword_view
         WHERE ${dateClause}
           AND ad_group_criterion.status != 'REMOVED'
           ${campaignFilter}
           ${adGroupFilter}
           AND metrics.impressions > 0
         ORDER BY metrics.cost_micros DESC
         LIMIT ${Math.min(limit ?? 100, 10_000)}`
      );

      const keywords = results.map((r) => {
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const conv = num(m?.conversions);
        const base = keywordsModule
          ? keywordsModule.keywordView(r, true)
          : (() => {
              const criterion = (r.adGroupCriterion ?? {}) as Record<string, unknown>;
              const kw = (criterion.keyword ?? {}) as Record<string, unknown>;
              const qi = (criterion.qualityInfo ?? {}) as Record<string, unknown>;
              const c = (r.campaign ?? {}) as Record<string, unknown>;
              const ag = (r.adGroup ?? {}) as Record<string, unknown>;
              return {
                criterion_id: String(criterion.criterionId ?? ""),
                ad_group_id: String(ag.id ?? ""),
                campaign_id: String(c.id ?? ""),
                keyword: kw.text,
                match_type: kw.matchType,
                quality_score: qi.qualityScore,
                campaign: c.name,
                ad_group: ag.name,
                status: criterion.status,
              };
            })();
        return {
          ...base,
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

      const fmt = format ?? "json";
      if (fmt === "table" || fmt === "csv") {
        const flat = keywords.map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Array.isArray(v) ? v.join(" | ") : v]))
        );
        return { content: [text(`${keywords.length} keyword(s).\n\n${fmt === "table" ? formatAsTable(flat) : formatAsCsv(flat)}`)] };
      }
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // get_device_breakdown: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // get_geo_performance: registrada em src/tools/targeting-geo.ts (lote targeting-geo).

  // ── Insights: Search Terms ─────────────────────────────────────────

  mcp.registerTool(
    "get_search_terms",
    {
      description: [
        "Get search terms report — actual queries that triggered your ads.",
        "Useful for finding new keyword ideas and negative keywords.",
        "",
        "Cada linha traz match_source — de onde veio o termo: ADVERTISER_PROVIDED_KEYWORD (palavra-chave",
        "do anunciante), AI_MAX_KEYWORDLESS (AI Max, sem palavra-chave, a partir do site), AI_MAX_BROAD_MATCH",
        "(AI Max expandindo a palavra-chave), DYNAMIC_SEARCH_ADS, PERFORMANCE_MAX, VERTICAL_ADS_DATA_FEED.",
        "Use matchSources para filtrar. Para a análise completa do AI Max, use get_ai_max_report.",
        "",
        "Duas visões (a resposta diz qual foi usada):",
        "- ad_group: search_term_view — por grupo de anúncios, com ad_group_id e, com includeKeyword, a",
        "  palavra-chave que acionou. NÃO inclui Performance Max.",
        "- campaign: campaign_search_term_view — por campanha, inclui Performance Max e Pesquisa, sem",
        "  grupo de anúncios nem palavra-chave (segmento de palavra-chave tira o PMax do resultado).",
        "view auto (default): usa campaign quando a campanha é PERFORMANCE_MAX ou matchSources pede",
        "PERFORMANCE_MAX; senão ad_group. Para minerar negativas com o PMax junto, use view: \"campaign\".",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID."),
        matchSources: flexArray(z.enum(SEARCH_TERM_MATCH_SOURCES)).optional().describe(
          "Filtra pela origem do termo (ex: [\"AI_MAX_KEYWORDLESS\", \"AI_MAX_BROAD_MATCH\"] = só AI Max)."
        ),
        view: z.enum(["auto", "ad_group", "campaign"]).optional().describe(
          "auto (default), ad_group (search_term_view, sem PMax) ou campaign (campaign_search_term_view, com PMax)."
        ),
        includeKeyword: z.boolean().optional().describe("Só na visão ad_group: traz a palavra-chave que acionou o termo."),
        limit: z.number().optional().describe("Max results. Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, matchSources, view, includeKeyword, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        return { content: [text(`limit deve ser inteiro positivo (recebido ${limit}).`)], isError: true };
      }
      const requestedView = view ?? "auto";
      if (!["auto", "ad_group", "campaign"].includes(requestedView)) {
        return { content: [text(`view inválida "${requestedView}": use auto, ad_group ou campaign.`)], isError: true };
      }
      // flexArray aceita string JSON sem validar os itens: confere contra o enum antes de ir para o GAQL
      const sources = matchSources === undefined ? [] : ensureArray<string>(matchSources).map(String);
      const invalidSources = sources.filter((source) => !(SEARCH_TERM_MATCH_SOURCES as readonly string[]).includes(source));
      if (invalidSources.length > 0) {
        return {
          content: [text(`matchSources inválido: ${invalidSources.join(", ")}. Use: ${SEARCH_TERM_MATCH_SOURCES.join(", ")}.`)],
          isError: true,
        };
      }
      const wantsPmaxSource = sources.includes("PERFORMANCE_MAX");
      if (requestedView === "ad_group" && wantsPmaxSource) {
        return {
          content: [text("search_term_view (view ad_group) não tem dados de Performance Max: o filtro PERFORMANCE_MAX nunca casaria. Use view: \"campaign\" (ou auto).")],
          isError: true,
        };
      }
      if (requestedView === "campaign" && includeKeyword) {
        return {
          content: [text("includeKeyword não combina com view campaign: segmento de palavra-chave tira o Performance Max do campaign_search_term_view. Use view: \"ad_group\" para ver a palavra-chave.")],
          isError: true,
        };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      // Canal da campanha: PMax só aparece em campaign_search_term_view.
      let channel: string | undefined;
      if (campaignId && requestedView !== "campaign") {
        const campRows = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.id = ${campaignId}`);
        channel = (campRows[0]?.campaign as Record<string, unknown> | undefined)?.advertisingChannelType as string | undefined;
        if (!channel) {
          return { content: [text(`Campanha ${campaignId} não encontrada na conta ${customerId}.`)], isError: true };
        }
      }
      const isPmaxCampaign = channel === "PERFORMANCE_MAX";
      if (requestedView === "ad_group" && isPmaxCampaign) {
        return {
          content: [text(`A campanha ${campaignId} é PERFORMANCE_MAX: search_term_view (view ad_group) não tem dados de PMax. Use view: "campaign" (ou auto).`)],
          isError: true,
        };
      }
      const usedView = requestedView === "campaign" || (requestedView === "auto" && (wantsPmaxSource || isPmaxCampaign))
        ? "campaign"
        : "ad_group";
      if (usedView === "campaign" && includeKeyword) {
        return {
          content: [text("includeKeyword não se aplica aqui: esta consulta usa campaign_search_term_view (Performance Max), e segmento de palavra-chave tiraria o PMax do resultado.")],
          isError: true,
        };
      }

      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";
      const sourceFilter = sources.length > 0
        ? `AND segments.search_term_match_source IN (${sources.map((source) => `'${source}'`).join(", ")})`
        : "";
      const max = Math.min(limit ?? 50, 10_000);

      const results = usedView === "campaign"
        ? await client.searchStream(
          customerId,
          `SELECT campaign_search_term_view.search_term,
                  segments.search_term_targeting_status, segments.search_term_match_source,
                  campaign.id, campaign.name, campaign.advertising_channel_type,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM campaign_search_term_view
           WHERE ${dateClause}
             ${campaignFilter}
             ${sourceFilter}
             AND metrics.impressions > 0
           ORDER BY metrics.cost_micros DESC
           LIMIT ${max}`
        )
        : await client.searchStream(
          customerId,
          `SELECT search_term_view.search_term, search_term_view.status,
                  segments.search_term_match_source,
                  ${includeKeyword ? "segments.keyword.info.text, segments.keyword.info.match_type," : ""}
                  campaign.id, campaign.name, ad_group.id, ad_group.name,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM search_term_view
           WHERE ${dateClause}
             ${campaignFilter}
             ${sourceFilter}
             AND metrics.impressions > 0
           ORDER BY metrics.cost_micros DESC
           LIMIT ${max}`
        );

      const terms = results.map((r) => {
        const c = (r.campaign ?? {}) as Record<string, unknown>;
        const ag = (r.adGroup ?? {}) as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const seg = (r.segments ?? {}) as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const common = {
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          spend: Math.round(spend * 100) / 100,
          conversions: num(m?.conversions),
          revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
        };
        if (usedView === "campaign") {
          const cstv = (r.campaignSearchTermView ?? {}) as Record<string, unknown>;
          return {
            search_term: cstv.searchTerm,
            status: seg.searchTermTargetingStatus,
            match_source: seg.searchTermMatchSource,
            campaign_id: String(c.id ?? ""),
            campaign: c.name,
            channel: c.advertisingChannelType,
            ...common,
          };
        }
        const stv = (r.searchTermView ?? {}) as Record<string, unknown>;
        const keyword = ((seg.keyword ?? {}) as Record<string, unknown>).info as Record<string, unknown> | undefined;
        return {
          search_term: stv.searchTerm,
          status: stv.status,
          match_source: seg.searchTermMatchSource,
          campaign_id: String(c.id ?? ""),
          campaign: c.name,
          ad_group_id: String(ag.id ?? ""),
          ad_group: ag.name,
          ...(includeKeyword ? { keyword: keyword?.text ?? null, keyword_match_type: keyword?.matchType ?? null } : {}),
          ...common,
        };
      });

      const viewNote = usedView === "campaign"
        ? "visão campaign (campaign_search_term_view: Pesquisa + Performance Max, por campanha, sem grupo de anúncios)"
        : "visão ad_group (search_term_view: por grupo de anúncios, sem Performance Max — use view campaign para incluir o PMax)";
      const fmt = format ?? "json";
      const body = fmt === "table" ? formatAsTable(terms) : fmt === "csv" ? formatAsCsv(terms) : formatJson(terms);
      return { content: [text(`${terms.length} search term(s) — ${viewNote}.\n\n${body}`)] };
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // get_change_history — implementação em src/tools/planner-recommendations.ts (lote planner-recommendations).

  // ── Assets: Ad Creatives ───────────────────────────────────────────

  // get_ad_creatives: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ── Assets: Image/Video Assets ─────────────────────────────────────
  // get_image_assets e get_video_assets: src/tools/asset-library.ts (lote asset-library).

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // list_negative_keywords: implementada em src/tools/negatives.ts (lote negatives).

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
        "Supported types: SEARCH, DISPLAY, PERFORMANCE_MAX, DEMAND_GEN. SHOPPING é recusado aqui (exige merchantId) — use create_shopping_campaign. VIDEO é recusado: a API não cria campanhas de vídeo novas.",
        "Bidding strategies: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS,",
        "TARGET_SPEND (Maximizar cliques — a certa para conta sem histórico de conversão), MANUAL_CPC.",
        "Orçamento e campanha são criados numa única operação atômica: ou os dois, ou nenhum.",
        "",
        "Orçamento: budgetType DAILY (padrão, dailyBudgetMicros) ou TOTAL (orçamento total do período, totalAmountMicros —",
        "exige startDateTime e endDateTime; SEARCH/PERFORMANCE_MAX até 90 dias, DEMAND_GEN até 1 ano; não vale em DISPLAY).",
        "O tipo de orçamento NÃO muda depois de criada a campanha. Com TOTAL, só estas estratégias: SEARCH — todas acima;",
        "PERFORMANCE_MAX — MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS; DEMAND_GEN — todas acima.",
        "Datas (fuso da conta): startDateTime / endDateTime em YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss; só a data = 00:00:00 no",
        "início e 23:59:59 no fim. Começar hoje: startDateTime com a data de hoje (só a data). Dia anterior a hoje é recusado.",
        "Valem também com orçamento diário (campanha com data para acabar).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Campaign name."),
        channelType: z
          .enum(["SEARCH", "DISPLAY", "SHOPPING", "PERFORMANCE_MAX", "VIDEO", "DEMAND_GEN"])
          .describe("Campaign type/channel."),
        dailyBudgetMicros: z
          .number()
          .optional()
          .describe("Orçamento DIÁRIO em MICROS (obrigatório com budgetType DAILY, o padrão). 100000000 = R$100/dia."),
        budgetType: z
          .enum(["DAILY", "TOTAL"])
          .optional()
          .describe("DAILY (padrão) ou TOTAL (orçamento total do período, CUSTOM_PERIOD). Não muda depois de criada."),
        totalAmountMicros: z
          .number()
          .optional()
          .describe("budgetType TOTAL: valor total da campanha em MICROS. 3000000000 = R$3.000 no período."),
        startDateTime: z
          .string()
          .optional()
          .describe("Início (fuso da conta): YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss. Obrigatório com TOTAL."),
        endDateTime: z
          .string()
          .optional()
          .describe("Fim (fuso da conta): YYYY-MM-DD (= 23:59:59) ou YYYY-MM-DD HH:mm:ss. Obrigatório com TOTAL."),
        biddingStrategy: z
          .enum([
            "MAXIMIZE_CONVERSIONS",
            "MAXIMIZE_CONVERSION_VALUE",
            "TARGET_CPA",
            "TARGET_ROAS",
            "TARGET_SPEND",
            "MANUAL_CPC",
          ])
          .optional()
          .describe("Bidding strategy. Default: MAXIMIZE_CONVERSIONS. TARGET_SPEND = Maximizar cliques."),
        targetCpaMicros: z
          .number()
          .optional()
          .describe("Target CPA in MICROS (only for TARGET_CPA)."),
        targetRoas: z
          .number()
          .optional()
          .describe("Target ROAS as decimal (e.g. 5.0 = 500%). Only for TARGET_ROAS."),
        cpcBidCeilingMicros: z
          .number()
          .optional()
          .describe("Teto de CPC em MICROS (só TARGET_SPEND). Ex: 3000000 = R$3,00 por clique."),
        networkSettings: z
          .object({
            targetGoogleSearch: z.boolean().optional(),
            targetSearchNetwork: z.boolean().optional(),
            targetContentNetwork: z.boolean().optional(),
          })
          .optional()
          .describe("Network targeting. Default depends on channelType: SEARCH = Google Search only; DISPLAY = Display Network only; PERFORMANCE_MAX/VIDEO/DEMAND_GEN = omitted (API default). Pass explicitly to override."),
        enableAiMax: z
          .boolean()
          .optional()
          .describe("Só SEARCH: cria a campanha com AI Max ligado. Ajustes finos depois com set_ai_max_settings."),
      },
    },
    async ({
      customerId, name, channelType, dailyBudgetMicros, biddingStrategy, targetCpaMicros, targetRoas, networkSettings, enableAiMax,
      cpcBidCeilingMicros, budgetType, totalAmountMicros, startDateTime, endDateTime,
    }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // A API do Google Ads não cria campanhas de VIDEO novas (só leitura/relatório e
      // anúncios em campanhas existentes): campaigns:mutate responde "Mutates are not
      // allowed for the requested resource". Recusar aqui evita criar o orçamento e
      // deixá-lo órfão a cada tentativa.
      if (channelType === "VIDEO") {
        return {
          content: [
            text(
              "create_campaign não cria campanhas VIDEO: a API do Google Ads não permite criar nem alterar campanhas de vídeo " +
                "(só leitura, e anúncios em ad groups VIDEO_RESPONSIVE já existentes via create_video_ad). " +
                "Para vídeo programático use create_demand_gen_campaign.",
            ),
          ],
          isError: true,
        };
      }

      // SHOPPING exige shoppingSetting.merchantId (+ feedLabel), que esta tool não coleta.
      // Recusa ANTES da Step 1 para não deixar budget órfão quando o mutate falhar.
      if (channelType === "SHOPPING") {
        return {
          content: [
            text(
              "create_campaign não cria campanhas SHOPPING: a API exige shoppingSetting.merchantId " +
                "(e feedLabel), que esta tool não recebe.\n" +
                "Use create_shopping_campaign — ela já trata merchantId, feedLabel e campaignPriority.\n" +
                "Use list_merchant_centers para descobrir os Merchant Center vinculados à conta."
            ),
          ],
          isError: true,
        };
      }

      // Valida a estratégia de lance ANTES de criar o orçamento: TARGET_CPA/ROAS sem o
      // alvo retornaria erro depois do mutate do budget e deixaria um orçamento órfão.
      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      if (strategy === "TARGET_CPA" && !targetCpaMicros) {
        return { content: [text("TARGET_CPA exige targetCpaMicros (ex: 50000000 = R$50 por conversão).")], isError: true };
      }
      if (strategy === "TARGET_ROAS" && !targetRoas) {
        return { content: [text("TARGET_ROAS exige targetRoas (ex: 5.0 = 500%).")], isError: true };
      }

      // AI Max só existe em Pesquisa (e Shopping, que esta tool não cria). Recusa antes
      // do orçamento para não deixar budget órfão.
      if (enableAiMax && channelType !== "SEARCH") {
        return {
          content: [text(`enableAiMax só vale para campanhas SEARCH (recebido ${channelType}). Nada foi criado.`)],
          isError: true,
        };
      }

      if (cpcBidCeilingMicros !== undefined) {
        if ((biddingStrategy ?? "MAXIMIZE_CONVERSIONS") !== "TARGET_SPEND") {
          return { content: [text("cpcBidCeilingMicros só vale com biddingStrategy TARGET_SPEND (Maximizar cliques). Nada foi criado.")], isError: true };
        }
        if (!isPositiveMicros(cpcBidCeilingMicros)) {
          return { content: [text(`cpcBidCeilingMicros deve ser um inteiro positivo em micros (recebido ${cpcBidCeilingMicros}). Nada foi criado.`)], isError: true };
        }
      }

      // Orçamento diário ou total (CUSTOM_PERIOD) e datas da campanha. O tipo do orçamento
      // não muda depois de criada a campanha, então tudo é conferido antes de enviar:
      // canal, estratégia permitida com orçamento total, início/fim e duração máxima.
      // Regras de data/orçamento total ficam no módulo do lote bidding (import local à tool).
      const { beforeAccountToday, checkTotalBudgetFlight, dateTimeMs, parseAdsDateTime, readAccountInfo } = await import("./tools/bidding.js");
      const budgetKind = budgetType ?? "DAILY";
      const flightProblems: string[] = [];
      const flightWarnings: string[] = [];
      if (budgetKind === "DAILY") {
        if (dailyBudgetMicros === undefined) {
          flightProblems.push("dailyBudgetMicros é obrigatório com orçamento diário (ou use budgetType TOTAL com totalAmountMicros)");
        } else if (!isPositiveMicros(dailyBudgetMicros)) {
          flightProblems.push(`dailyBudgetMicros deve ser inteiro positivo em micros (recebido ${dailyBudgetMicros})`);
        }
        if (totalAmountMicros !== undefined) flightProblems.push("totalAmountMicros só vale com budgetType TOTAL");
      } else {
        if (totalAmountMicros === undefined) flightProblems.push("budgetType TOTAL exige totalAmountMicros");
        else if (!isPositiveMicros(totalAmountMicros)) flightProblems.push(`totalAmountMicros deve ser inteiro positivo em micros (recebido ${totalAmountMicros})`);
        if (dailyBudgetMicros !== undefined) flightProblems.push("com budgetType TOTAL informe só totalAmountMicros (dailyBudgetMicros é do orçamento diário)");
      }
      const startParsed = startDateTime !== undefined ? parseAdsDateTime(startDateTime, "startOfDay") : undefined;
      const endParsed = endDateTime !== undefined ? parseAdsDateTime(endDateTime, "endOfDay") : undefined;
      for (const parsed of [startParsed, endParsed]) if (parsed && "error" in parsed) flightProblems.push(parsed.error);
      const startValue = startParsed && "value" in startParsed ? startParsed.value : undefined;
      const endValue = endParsed && "value" in endParsed ? endParsed.value : undefined;
      if (startValue && endValue && dateTimeMs(endValue) <= dateTimeMs(startValue)) {
        flightProblems.push(`endDateTime (${endValue}) precisa ser depois de startDateTime (${startValue})`);
      }
      if (budgetKind === "TOTAL") {
        const flight = checkTotalBudgetFlight(channelType, strategy, startValue, endValue);
        flightProblems.push(...flight.errors);
        flightWarnings.push(...flight.warnings);
      }
      if (flightProblems.length > 0) {
        return { content: [text(`Nada foi criado:\n- ${flightProblems.join("\n- ")}`)], isError: true };
      }
      if (startValue || endValue) {
        // As datas são no fuso da conta; a API recusa data no passado (CANNOT_SET_DATE_TO_PAST).
        // Só o dia conta: "hoje" (00:00:00, granularidade diária do proto) é começar hoje.
        const account = await readAccountInfo(client, customerId);
        const past = ([["startDateTime", startValue], ["endDateTime", endValue]] as const)
          .filter(([, value]) => value && beforeAccountToday(value, account.now))
          .map(([label, value]) => `${label} ${value}`);
        if (past.length > 0) {
          const startIsPast = startValue !== undefined && beforeAccountToday(startValue, account.now);
          const hint = !startIsPast
            ? "Use hoje ou uma data futura para o fim."
            : budgetKind === "TOTAL"
              ? `Orçamento total exige início: use a data de hoje (${account.now.slice(0, 10)}, só a data = começa hoje) ou uma data futura.`
              : `Use a data de hoje (${account.now.slice(0, 10)}, só a data = começa hoje) ou uma data futura — ou omita startDateTime ` +
                "para a campanha começar quando for ativada.";
          return {
            content: [text(
              `Nada foi criado: ${past.join(" e ")} já passou — dia anterior a hoje (agora na conta: ${account.now}, ${account.timeZone}). ${hint}`
            )],
            isError: true,
          };
        }
      }

      // Orçamento e campanha vão num único googleAds:mutate, com ID temporário para o
      // orçamento: se a campanha for recusada, o orçamento não fica órfão, e em
      // validateOnly/dry-run a API valida os dois de uma vez.
      const budgetTmp = `customers/${cid}/campaignBudgets/-1`;

      // Step 2: Create campaign
      // networkSettings precisa ser coerente com o canal. O default antigo (só
      // Google Search) ia para todos: em DISPLAY nascia uma campanha sem rede onde
      // entregar, e PERFORMANCE_MAX/VIDEO/DEMAND_GEN não aceitam restrição de rede
      // no create — para esses o campo é omitido, como fazem as tools irmãs.
      const defaultNetworkSettings: Record<string, Record<string, boolean> | undefined> = {
        SEARCH: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
        DISPLAY: { targetContentNetwork: true, targetGoogleSearch: false, targetSearchNetwork: false },
      };
      const effectiveNetworkSettings = networkSettings ?? defaultNetworkSettings[channelType];
      const campaignData: Record<string, unknown> = {
        name,
        status: "PAUSED",
        advertisingChannelType: channelType,
        campaignBudget: budgetTmp,
        containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        ...(effectiveNetworkSettings ? { networkSettings: effectiveNetworkSettings } : {}),
        ...(enableAiMax ? { aiMaxSetting: { enableAiMax: true } } : {}),
        ...(startValue ? { startDateTime: startValue } : {}),
        ...(endValue ? { endDateTime: endValue } : {}),
      };

      // Bidding strategy (alvos já validados antes do orçamento)
      if (strategy === "MAXIMIZE_CONVERSIONS") {
        campaignData.maximizeConversions = {};
      } else if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
        campaignData.maximizeConversionValue = {};
      } else if (strategy === "TARGET_CPA") {
        if (!targetCpaMicros) {
          return { content: [text("TARGET_CPA exige targetCpaMicros (ex: 50000000 = R$50 por conversão).")], isError: true };
        }
        campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      } else if (strategy === "TARGET_ROAS") {
        if (!targetRoas) {
          return { content: [text("TARGET_ROAS exige targetRoas (ex: 5.0 = 500%).")], isError: true };
        }
        campaignData.maximizeConversionValue = { targetRoas };
      } else if (strategy === "MANUAL_CPC") {
        // Enhanced CPC foi desligado em Pesquisa/Display (31/03/2025): CPC manual puro
        campaignData.manualCpc = {};
      } else if (strategy === "TARGET_SPEND") {
        campaignData.targetSpend = cpcBidCeilingMicros ? { cpcBidCeilingMicros: String(cpcBidCeilingMicros) } : {};
      }

      let batchResult: Record<string, unknown>;
      try {
        batchResult = await client.batchMutate(customerId, [
          {
            campaignBudgetOperation: {
              create: {
                resourceName: budgetTmp,
                name: `Budget — ${name}`,
                // Orçamento total: period CUSTOM_PERIOD + total_amount_micros, nunca compartilhado
                // (docs "Create campaign budgets"); o diário segue como antes.
                ...(budgetKind === "TOTAL"
                  ? { period: "CUSTOM_PERIOD", totalAmountMicros: String(totalAmountMicros) }
                  : { amountMicros: String(dailyBudgetMicros) }),
                deliveryMethod: "STANDARD",
                explicitlyShared: false,
              },
            },
          },
          { campaignOperation: { create: campaignData } },
        ]);
      } catch (err) {
        return {
          content: [text(
            "Nada foi criado (orçamento e campanha vão na mesma operação atômica).\n" +
            `Erro: ${explainBiddingError((err as Error).message, strategy)}`
          )],
          isError: true,
        };
      }
      const dryRun = client.isDryRun;
      const responses = (batchResult.mutateOperationResponses as Array<Record<string, unknown>>) ?? [];
      const campaignResourceName = (responses.find((r) => r.campaignResult)?.campaignResult as Record<string, unknown> | undefined)
        ?.resourceName as string | undefined;
      if (!dryRun && !campaignResourceName) {
        return {
          content: [text(`A API não confirmou a criação da campanha — confira na conta antes de repetir.\n\n${formatJson(batchResult)}`)],
          isError: true,
        };
      }
      const warnings: string[] = [];
      if (strategy === "TARGET_SPEND" && !cpcBidCeilingMicros) {
        warnings.push("Maximizar cliques sem teto: o Google pode pagar CPCs altos. Defina cpcBidCeilingMicros com update_campaign se precisar.");
      }
      if (strategy === "MANUAL_CPC") {
        warnings.push("CPC manual: o lance real é o de cada grupo/palavra-chave — informe cpcBidMicros no create_ad_group.");
      }
      warnings.push(...flightWarnings);
      const budgetLine = budgetKind === "TOTAL"
        ? `- Budget: R$ ${(Number(totalAmountMicros) / 1_000_000).toFixed(2)} no total (CUSTOM_PERIOD — o tipo não muda depois)\n`
        : `- Budget: R$ ${(Number(dailyBudgetMicros) / 1_000_000).toFixed(2)}/day\n`;
      const datesLine = startValue || endValue
        ? `- Datas (fuso da conta): ${startValue ?? "ao ativar"} → ${endValue ?? "sem fim"}\n`
        : "";

      return {
        content: [
          text(
            (dryRun ? `DRY-RUN (validateOnly): orçamento e campanha validados pela API — nada foi criado.\n` : `Campaign created (PAUSED):\n`) +
              `- Name: ${name}\n` +
              `- Type: ${channelType}\n` +
              budgetLine +
              datesLine +
              `- Bidding: ${strategy}${strategy === "TARGET_SPEND" && cpcBidCeilingMicros ? ` (teto ${money(cpcBidCeilingMicros)})` : ""}\n` +
              (enableAiMax ? `- AI Max: ligado (ajustes finos com set_ai_max_settings)\n` : "") +
              (campaignResourceName ? `- Resource: ${campaignResourceName}\n` : "") +
              (warnings.length ? `\nAvisos:\n- ${warnings.join("\n- ")}\n` : "") +
              (dryRun ? "" : `\nUse update_campaign to ENABLE when ready.`)
          ),
        ],
      };
    }
  );

  mcp.registerTool(
    "update_campaign",
    {
      description: [
        "Atualiza nome, status, estratégia de lance (com os parâmetros) e redes de uma campanha.",
        "WRITE OPERATION — vale na hora. Só os campos que mudam são enviados (updateMask exato).",
        "",
        "biddingStrategy: TARGET_SPEND (Maximizar cliques), MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE,",
        "TARGET_IMPRESSION_SHARE, MANUAL_CPC. Parâmetros:",
        "- cpcBidCeilingMicros: teto de CPC (TARGET_SPEND ou TARGET_IMPRESSION_SHARE)",
        "- targetCpaMicros: CPA alvo (MAXIMIZE_CONVERSIONS)",
        "- targetRoas: ROAS alvo em decimal, 5.0 = 500% (MAXIMIZE_CONVERSION_VALUE)",
        "- targetImpressionShareLocation + locationFractionMicros (TARGET_IMPRESSION_SHARE; 500000 = 50%)",
        "Sem biddingStrategy, os parâmetros ajustam a estratégia que a campanha já usa.",
        "Trocar de estratégia reinicia o aprendizado do lance automático.",
        "",
        "networkSettings: targetGoogleSearch, targetSearchNetwork (parceiros de pesquisa),",
        "targetContentNetwork (expansão para Display).",
        "",
        "Datas (fuso da conta): startDateTime (não muda depois que a campanha começou; a data de hoje = começa hoje),",
        "endDateTime (só a data = até 23:59:59) e clearEndDateTime (campanha sem fim — não vale com orçamento total).",
        "Dia anterior a hoje é recusado.",
        "Com orçamento total (CUSTOM_PERIOD) a duração continua limitada (Pesquisa/PMax/Shopping 90 dias).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID (numeric)."),
        name: z.string().optional().describe("New campaign name."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("New status."),
        biddingStrategy: z
          .enum(["TARGET_SPEND", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_IMPRESSION_SHARE", "MANUAL_CPC"])
          .optional()
          .describe("Nova estratégia de lance. TARGET_SPEND = Maximizar cliques."),
        cpcBidCeilingMicros: z.number().optional().describe("Teto de CPC em micros (TARGET_SPEND / TARGET_IMPRESSION_SHARE). 17000000 = R$17."),
        targetCpaMicros: z.number().optional().describe("CPA alvo em micros (MAXIMIZE_CONVERSIONS)."),
        targetRoas: z.number().optional().describe("ROAS alvo em decimal (MAXIMIZE_CONVERSION_VALUE). 5.0 = 500%."),
        targetImpressionShareLocation: z
          .enum(["ANYWHERE_ON_PAGE", "TOP_OF_PAGE", "ABSOLUTE_TOP_OF_PAGE"])
          .optional()
          .describe("TARGET_IMPRESSION_SHARE: onde aparecer."),
        locationFractionMicros: z.number().optional().describe("TARGET_IMPRESSION_SHARE: parcela desejada em micros (500000 = 50%, 1000000 = 100%)."),
        networkSettings: z
          .object({
            targetGoogleSearch: z.boolean().optional(),
            targetSearchNetwork: z.boolean().optional(),
            targetContentNetwork: z.boolean().optional(),
          })
          .optional()
          .describe("Redes. Só as chaves informadas mudam."),
        startDateTime: z.string().optional().describe(
          "Novo início (fuso da conta): YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss. A API não muda o início de campanha que já começou."
        ),
        endDateTime: z.string().optional().describe("Novo fim (fuso da conta): YYYY-MM-DD (= 23:59:59) ou YYYY-MM-DD HH:mm:ss."),
        clearEndDateTime: z.boolean().optional().describe("true remove a data de fim (campanha sem fim). Não vale com orçamento total."),
      },
    },
    async ({
      customerId, campaignId, name, status, biddingStrategy, cpcBidCeilingMicros, targetCpaMicros, targetRoas,
      targetImpressionShareLocation, locationFractionMicros, networkSettings, startDateTime, endDateTime, clearEndDateTime,
    }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`)], isError: true };
      }

      // Validação de entrada — antes de qualquer chamada
      const problems: string[] = [];
      for (const [label, value] of [["cpcBidCeilingMicros", cpcBidCeilingMicros], ["targetCpaMicros", targetCpaMicros]] as const) {
        if (value !== undefined && !isPositiveMicros(value)) problems.push(`${label} deve ser inteiro positivo em micros (recebido ${value})`);
      }
      if (targetRoas !== undefined && !(targetRoas > 0)) problems.push(`targetRoas deve ser maior que zero (recebido ${targetRoas})`);
      if (locationFractionMicros !== undefined && !(Number.isInteger(locationFractionMicros) && locationFractionMicros > 0 && locationFractionMicros <= 1_000_000)) {
        problems.push(`locationFractionMicros deve ficar entre 1 e 1000000 (recebido ${locationFractionMicros})`);
      }
      // Regras de data/orçamento total ficam no módulo do lote bidding (import local à tool).
      const { beforeAccountToday, checkTotalBudgetFlight, dateTimeMs, parseAdsDateTime, readAccountInfo } = await import("./tools/bidding.js");
      const startParsed = startDateTime !== undefined ? parseAdsDateTime(startDateTime, "startOfDay") : undefined;
      const endParsed = endDateTime !== undefined ? parseAdsDateTime(endDateTime, "endOfDay") : undefined;
      for (const parsed of [startParsed, endParsed]) if (parsed && "error" in parsed) problems.push(parsed.error);
      if (clearEndDateTime && endDateTime !== undefined) problems.push("use endDateTime OU clearEndDateTime, não os dois");
      if (problems.length > 0) {
        return { content: [text(`Nada foi alterado:\n- ${problems.join("\n- ")}`)], isError: true };
      }

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.start_date_time, campaign.end_date_time,
                campaign_budget.period, campaign_budget.total_amount_micros,
                campaign.bidding_strategy_type, campaign.bidding_strategy,
                campaign.target_spend.cpc_bid_ceiling_micros,
                campaign.maximize_conversions.target_cpa_micros,
                campaign.maximize_conversion_value.target_roas,
                campaign.target_cpa.target_cpa_micros,
                campaign.target_roas.target_roas,
                campaign.target_impression_share.location,
                campaign.target_impression_share.location_fraction_micros,
                campaign.target_impression_share.cpc_bid_ceiling_micros,
                campaign.network_settings.target_google_search,
                campaign.network_settings.target_search_network,
                campaign.network_settings.target_content_network
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = rows[0]?.campaign as Record<string, unknown> | undefined;
      if (!campaign) {
        return { content: [text(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi alterado.`)], isError: true };
      }
      if (campaign.status === "REMOVED") {
        return { content: [text(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi alterado.`)], isError: true };
      }

      const currentType = String(campaign.biddingStrategyType ?? "");
      const portfolio = typeof campaign.biddingStrategy === "string" && campaign.biddingStrategy !== "";
      // Estratégia padrão → campo do oneof campaign_bidding_strategy (REST camelCase, updateMask snake_case).
      // emptySwitch: o updateMask não pode nomear a mensagem (a API recusa com FIELD_HAS_SUBFIELDS);
      // para trocar de estratégia sem parâmetro, nomeia-se uma folha dela — a API zera a folha
      // e o oneof passa para a estratégia nova. TARGET_CPA/TARGET_ROAS são as estratégias
      // padrão antigas: só dá para ajustar o alvo delas, não trocar para elas.
      const STRATEGY_FIELDS: Record<string, { json: string; path: string; emptySwitch?: string }> = {
        TARGET_SPEND: { json: "targetSpend", path: "target_spend", emptySwitch: "target_spend.cpc_bid_ceiling_micros" },
        MAXIMIZE_CONVERSIONS: { json: "maximizeConversions", path: "maximize_conversions", emptySwitch: "maximize_conversions.target_cpa_micros" },
        MAXIMIZE_CONVERSION_VALUE: { json: "maximizeConversionValue", path: "maximize_conversion_value", emptySwitch: "maximize_conversion_value.target_roas" },
        TARGET_IMPRESSION_SHARE: { json: "targetImpressionShare", path: "target_impression_share" },
        MANUAL_CPC: { json: "manualCpc", path: "manual_cpc", emptySwitch: "manual_cpc.enhanced_cpc_enabled" },
        TARGET_CPA: { json: "targetCpa", path: "target_cpa" },
        TARGET_ROAS: { json: "targetRoas", path: "target_roas" },
      };
      const strategyAfter = biddingStrategy ?? (portfolio ? "PORTFOLIO" : currentType);
      const switching = biddingStrategy !== undefined && (biddingStrategy !== currentType || portfolio);

      // Cada parâmetro pertence a uma estratégia
      const params: Array<{ key: string; value: unknown; strategies: string[]; path: string; jsonValue: unknown }> = [];
      if (cpcBidCeilingMicros !== undefined) {
        params.push({ key: "cpcBidCeilingMicros", value: cpcBidCeilingMicros, strategies: ["TARGET_SPEND", "TARGET_IMPRESSION_SHARE"], path: "cpc_bid_ceiling_micros", jsonValue: String(cpcBidCeilingMicros) });
      }
      if (targetCpaMicros !== undefined) {
        params.push({ key: "targetCpaMicros", value: targetCpaMicros, strategies: ["MAXIMIZE_CONVERSIONS", "TARGET_CPA"], path: "target_cpa_micros", jsonValue: String(targetCpaMicros) });
      }
      if (targetRoas !== undefined) {
        params.push({ key: "targetRoas", value: targetRoas, strategies: ["MAXIMIZE_CONVERSION_VALUE", "TARGET_ROAS"], path: "target_roas", jsonValue: targetRoas });
      }
      if (targetImpressionShareLocation !== undefined) {
        params.push({ key: "location", value: targetImpressionShareLocation, strategies: ["TARGET_IMPRESSION_SHARE"], path: "location", jsonValue: targetImpressionShareLocation });
      }
      if (locationFractionMicros !== undefined) {
        params.push({ key: "locationFractionMicros", value: locationFractionMicros, strategies: ["TARGET_IMPRESSION_SHARE"], path: "location_fraction_micros", jsonValue: String(locationFractionMicros) });
      }
      if (params.length > 0 && strategyAfter === "PORTFOLIO") {
        return {
          content: [text(`Campanha ${campaignId} usa uma estratégia de portfólio (${campaign.biddingStrategy}). Os parâmetros ficam no portfólio; para mudar só esta campanha, informe biddingStrategy. Nada foi alterado.`)],
          isError: true,
        };
      }
      const misplaced = params.filter((param) => !param.strategies.includes(strategyAfter));
      if (misplaced.length > 0) {
        return {
          content: [text(
            `Nada foi alterado — parâmetro(s) incompatível(is) com a estratégia ${strategyAfter}:\n` +
            misplaced.map((param) => `- ${param.key} vale para ${param.strategies.join(" / ")}`).join("\n")
          )],
          isError: true,
        };
      }
      if (switching && biddingStrategy === "TARGET_IMPRESSION_SHARE" && (targetImpressionShareLocation === undefined || locationFractionMicros === undefined)) {
        return {
          content: [text("TARGET_IMPRESSION_SHARE exige targetImpressionShareLocation e locationFractionMicros. Nada foi alterado.")],
          isError: true,
        };
      }

      const update: Record<string, unknown> = { resourceName: `customers/${cid}/campaigns/${campaignId}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      const warnings: string[] = [];

      if (name !== undefined && name !== campaign.name) {
        update.name = name; mask.push("name"); changes.push({ setting: "name", before: campaign.name, after: name });
      }
      if (status !== undefined && status !== campaign.status) {
        update.status = status; mask.push("status"); changes.push({ setting: "status", before: campaign.status, after: status });
      }

      // Valor atual de cada parâmetro, para não reenviar o que já está igual
      const currentParam = (strategy: string, key: string): unknown => {
        const field = STRATEGY_FIELDS[strategy];
        if (!field) return undefined;
        const block = (campaign[field.json] ?? {}) as Record<string, unknown>;
        return block[key];
      };
      const field = STRATEGY_FIELDS[strategyAfter];
      if (switching && field) {
        const message: Record<string, unknown> = {};
        for (const param of params) message[param.key] = param.jsonValue;
        update[field.json] = message;
        if (params.length > 0) for (const param of params) mask.push(`${field.path}.${param.path}`);
        else mask.push(field.emptySwitch ?? field.path);
        changes.push({ setting: "biddingStrategy", before: portfolio ? `PORTFOLIO (${campaign.biddingStrategy})` : currentType, after: biddingStrategy });
        for (const param of params) changes.push({ setting: param.key, before: undefined, after: param.value });
        warnings.push("Troca de estratégia reinicia o período de aprendizado do lance automático.");
      } else if (field && params.length > 0) {
        const message: Record<string, unknown> = {};
        for (const param of params) {
          const before = currentParam(strategyAfter, param.key);
          if (before !== undefined && String(before) === String(param.jsonValue)) continue;
          message[param.key] = param.jsonValue;
          mask.push(`${field.path}.${param.path}`);
          changes.push({ setting: param.key, before, after: param.value });
        }
        if (Object.keys(message).length > 0) update[field.json] = message;
      }
      if (strategyAfter === "TARGET_SPEND" && cpcBidCeilingMicros === undefined && switching) {
        warnings.push("Maximizar cliques sem teto: o Google pode pagar CPCs altos. Considere cpcBidCeilingMicros.");
      }
      if (switching && biddingStrategy === "MANUAL_CPC") {
        warnings.push("CPC manual: o lance real passa a ser o de cada grupo/palavra-chave. Confira com update_ad_group / update_keyword.");
      }
      if (cpcBidCeilingMicros !== undefined && cpcBidCeilingMicros < LOW_BID_MICROS) {
        warnings.push(`Teto de CPC muito baixo (${money(cpcBidCeilingMicros)}): a campanha pode não ganhar leilões.`);
      }

      if (networkSettings) {
        const currentNetwork = (campaign.networkSettings ?? {}) as Record<string, unknown>;
        const NETWORK_PATHS: Record<string, string> = {
          targetGoogleSearch: "network_settings.target_google_search",
          targetSearchNetwork: "network_settings.target_search_network",
          targetContentNetwork: "network_settings.target_content_network",
        };
        const networkUpdate: Record<string, boolean> = {};
        for (const [key, path] of Object.entries(NETWORK_PATHS)) {
          const value = (networkSettings as Record<string, boolean | undefined>)[key];
          if (value === undefined || Boolean(currentNetwork[key]) === value) continue;
          networkUpdate[key] = value;
          mask.push(path);
          changes.push({ setting: key, before: Boolean(currentNetwork[key]), after: value });
        }
        if (Object.keys(networkUpdate).length > 0) update.networkSettings = networkUpdate;
      }

      // Datas da campanha (start_date_time / end_date_time, v23+). Só o que muda vai no updateMask;
      // limpar o fim = caminho no updateMask sem valor no objeto (o proto manda "clear this field").
      const newStart = startParsed && "value" in startParsed ? startParsed.value : undefined;
      const newEnd = endParsed && "value" in endParsed ? endParsed.value : undefined;
      const currentStart = String(campaign.startDateTime ?? "");
      const currentEnd = String(campaign.endDateTime ?? "");
      const totalBudget = (rows[0]?.campaignBudget as Record<string, unknown> | undefined)?.period === "CUSTOM_PERIOD";
      const wantsStart = newStart !== undefined && newStart !== currentStart;
      const wantsEnd = newEnd !== undefined && newEnd !== currentEnd;
      const wantsClear = clearEndDateTime === true && currentEnd !== "";
      if (wantsStart || wantsEnd || wantsClear) {
        const account = await readAccountInfo(client, customerId);
        const nowMs = dateTimeMs(account.now);
        const dateProblems: string[] = [];
        if (wantsStart) {
          if (currentStart && dateTimeMs(currentStart) <= nowMs) {
            dateProblems.push(`a campanha já começou (${currentStart}): a API não muda o início (CANNOT_MODIFY_START_DATE_IF_ALREADY_STARTED)`);
          } else if (beforeAccountToday(newStart!, account.now)) {
            // Só o dia conta: a data de hoje (00:00:00, granularidade diária) é "começa hoje".
            dateProblems.push(`startDateTime ${newStart} já passou — dia anterior a hoje (CANNOT_SET_DATE_TO_PAST); use hoje ou uma data futura`);
          }
        }
        if (wantsEnd && beforeAccountToday(newEnd!, account.now)) {
          dateProblems.push(`endDateTime ${newEnd} já passou — dia anterior a hoje (CANNOT_SET_DATE_TO_PAST)`);
        }
        if (wantsClear && totalBudget) {
          dateProblems.push("a campanha tem orçamento total (CUSTOM_PERIOD) e precisa de data de fim (END_DATE_TIME_REQUIRED_FOR_TOTAL_BUDGET)");
        }
        const effectiveStart = wantsStart ? newStart! : currentStart;
        const effectiveEnd = wantsClear ? "" : wantsEnd ? newEnd! : currentEnd;
        if (effectiveStart && effectiveEnd && dateTimeMs(effectiveEnd) <= dateTimeMs(effectiveStart)) {
          dateProblems.push(`o fim (${effectiveEnd}) precisa ser depois do início (${effectiveStart})`);
        }
        if (totalBudget && !wantsClear) {
          const flight = checkTotalBudgetFlight(String(campaign.advertisingChannelType ?? ""), undefined, effectiveStart || undefined, effectiveEnd || undefined);
          dateProblems.push(...flight.errors);
          warnings.push(...flight.warnings);
        }
        if (dateProblems.length > 0) {
          return {
            content: [text(`Campanha ${campaignId} ("${campaign.name}"): nada foi alterado (agora na conta: ${account.now}, ${account.timeZone}):\n- ${dateProblems.join("\n- ")}`)],
            isError: true,
          };
        }
        if (wantsStart) {
          update.startDateTime = newStart; mask.push("start_date_time"); changes.push({ setting: "startDateTime", before: currentStart || null, after: newStart });
        }
        if (wantsEnd) {
          update.endDateTime = newEnd; mask.push("end_date_time"); changes.push({ setting: "endDateTime", before: currentEnd || null, after: newEnd });
        }
        if (wantsClear) {
          mask.push("end_date_time"); changes.push({ setting: "endDateTime", before: currentEnd, after: null });
        }
      }

      const campaignLine = `Campanha ${campaignId} ("${campaign.name}")`;
      if (mask.length === 0) {
        return { content: [text(`${campaignLine}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`)] };
      }

      const dryRun = client.isDryRun;
      try {
        await client.mutateCampaigns(customerId, [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return {
          content: [text(
            `${campaignLine}: a API não aceitou a alteração.\nErro: ${explainBiddingError((err as Error).message, biddingStrategy)}\n\n` +
            formatJson({ attempted: changes, update_mask: mask })
          )],
          isError: true,
        };
      }
      return {
        content: [text(
          (dryRun ? `${campaignLine} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${campaignLine} — ${changes.length} alteração(ões) aplicada(s).`) +
          `\n\n${formatJson({ changes, warnings, update_mask: mask })}`
        )],
      };
    }
  );

  // ── Budget Management ──────────────────────────────────────────────

  mcp.registerTool(
    "update_budget",
    {
      description: [
        "Altera um orçamento de campanha: valor diário (amountMicros), valor total da campanha (totalAmountMicros),",
        "nome, ou torna o orçamento compartilhado (makeShared). WRITE OPERATION — vale na hora.",
        "Valores em MICROS (1000000 = R$ 1,00).",
        "",
        "Identifique o orçamento por budgetResourceName (resource name ou ID numérico) OU por campaignId (usa o",
        "orçamento da campanha). Veja os orçamentos com list_budgets.",
        "Antes de gravar, lê o orçamento: período (DAILY → amountMicros; CUSTOM_PERIOD, o orçamento total da",
        "campanha → totalAmountMicros), se é compartilhado e quais campanhas o usam.",
        "- Orçamento usado por mais de uma campanha: exige confirmShared: true (muda o gasto de todas; a resposta lista quais).",
        "- Novo valor acima do dobro do atual: exige confirm: true (pega erro de digitação nos micros).",
        "- makeShared: irreversível (compartilhado nunca volta a individual); exige confirm: true e um nome.",
        "- name: só em orçamento compartilhado (o individual herda o nome da campanha).",
        "Valor igual ao atual não grava nada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        budgetResourceName: z
          .string()
          .optional()
          .describe("Orçamento: resource name (customers/123/campaignBudgets/456) ou o ID numérico. Use isto OU campaignId."),
        campaignId: z
          .string()
          .optional()
          .describe("Alternativa: ID da campanha — altera o orçamento que ela usa (se compartilhado, pede confirmShared)."),
        amountMicros: z
          .number()
          .optional()
          .describe("Novo valor DIÁRIO médio em MICROS (orçamento DAILY). 100000000 = R$ 100/dia."),
        totalAmountMicros: z
          .number()
          .optional()
          .describe("Novo valor TOTAL da campanha em MICROS (só orçamento CUSTOM_PERIOD)."),
        name: z.string().optional().describe("Novo nome (só orçamento compartilhado, ou junto com makeShared)."),
        makeShared: z
          .boolean()
          .optional()
          .describe("true = torna o orçamento compartilhado (irreversível; exige confirm e nome)."),
        confirmShared: z
          .boolean()
          .optional()
          .describe("true = confirma mudar o valor de um orçamento usado por várias campanhas."),
        confirm: z
          .boolean()
          .optional()
          .describe("true = confirma makeShared ou um aumento acima do dobro do valor atual."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      /* A lógica mora em src/tools/budgets.ts (lote budgets), junto das outras tools de
         orçamento. Import dinâmico para não mexer no bloco de imports deste arquivo. */
      const { runUpdateBudget } = await import("./tools/budgets.js");
      return runUpdateBudget({ getClient, allowedCustomerIds, hosted }, args);
    }
  );

  // ── Ad Group Management ────────────────────────────────────────────

  mcp.registerTool(
    "create_ad_group",
    {
      description: [
        "Create an ad group within a campaign.",
        "WRITE OPERATION — created PAUSED by default.",
        "",
        "The ad group type is DERIVED from the campaign's advertising_channel_type:",
        "SEARCH = SEARCH_STANDARD, DISPLAY = DISPLAY_STANDARD,",
        "SHOPPING = SHOPPING_PRODUCT_ADS, VIDEO = VIDEO_RESPONSIVE.",
        "Other channels (e.g. DEMAND_GEN) are created without an explicit type.",
        "PERFORMANCE_MAX campaigns do NOT use ad groups — use create_asset_group.",
        "",
        "SEARCH_DYNAMIC_ADS (DSA) só é aceito em campanha SEARCH com domínio de DSA configurado",
        "(dynamic_search_ads_setting); o grupo não aceita palavras-chave positivas e este servidor não cria",
        "anúncios DSA nem alvos de página. A criação de DSA termina em jan/2027 e a automigração para",
        "AI Max começa em fev/2027 — prefira AI Max (set_ai_max_settings); inventário em audit_dsa_and_legacy.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID (numeric)."),
        name: z.string().describe("Ad group name."),
        cpcBidMicros: z
          .number()
          .optional()
          .describe("CPC do grupo em MICROS. OBRIGATÓRIO quando a campanha usa CPC manual (sem ele o grupo nasce sem lance). Ex: 2500000 = R$2,50."),
        cpmBidMicros: z
          .number()
          .optional()
          .describe("CPM do grupo em MICROS. Obrigatório quando a campanha usa CPM manual."),
        type: z
          .enum([
            "SEARCH_STANDARD",
            "SEARCH_DYNAMIC_ADS",
            "DISPLAY_STANDARD",
            "SHOPPING_PRODUCT_ADS",
            "VIDEO_RESPONSIVE",
            "VIDEO_BUMPER",
            "VIDEO_TRUE_VIEW_IN_STREAM",
            "VIDEO_TRUE_VIEW_IN_DISPLAY",
            "VIDEO_NON_SKIPPABLE_IN_STREAM",
            "VIDEO_EFFICIENT_REACH",
          ])
          .optional()
          .describe("OPTIONAL override. Default: derived from the campaign's channel type. SEARCH_DYNAMIC_ADS exige campanha SEARCH com domínio de DSA."),
      },
    },
    async ({ customerId, campaignId, name, cpcBidMicros, cpmBidMicros, type }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // campaignId entra cru na GAQL abaixo: exigir numérico impede que um valor
      // manipulado amplie o WHERE e derive o canal de outra campanha.
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text("Error: campaignId inválido — use apenas o ID numérico da campanha.")], isError: true };
      }
      // O type do ad group precisa casar com o canal da campanha — SEARCH_STANDARD dentro
      // de campanha DISPLAY/VIDEO/SHOPPING é recusado pela API. Consulta o canal antes.
      const campRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.advertising_channel_type, campaign.bidding_strategy_type,
                campaign.dynamic_search_ads_setting.domain_name
         FROM campaign WHERE campaign.id = ${campaignId} AND campaign.status != 'REMOVED'`);
      const camp = (campRows[0]?.campaign ?? {}) as Record<string, unknown>;
      const channel = camp.advertisingChannelType as string | undefined;
      if (!channel) {
        return {
          content: [text(`Campanha ${campaignId} não encontrada na conta ${customerId}.`)],
          isError: true,
        };
      }
      if (channel === "PERFORMANCE_MAX") {
        return {
          content: [text("Campanhas PERFORMANCE_MAX não têm ad groups — use create_asset_group.")],
          isError: true,
        };
      }
      // A API não altera campanhas VIDEO existentes: adGroups:mutate responde "Mutates
      // are not allowed for the requested resource" (testado). Vídeo programático é
      // Demand Gen; em campanha de vídeo criada no Google Ads, só create_video_ad
      // (anúncio em ad group VIDEO_RESPONSIVE existente) passa.
      if (channel === "VIDEO") {
        return {
          content: [text("A API do Google Ads não cria ad groups em campanhas VIDEO (nem cria/altera essas campanhas). Para vídeo programático use create_demand_gen_campaign; para anúncio num ad group VIDEO_RESPONSIVE já existente, use create_video_ad.")],
          isError: true,
        };
      }

      // Canais sem mapeamento fixo (ex.: DEMAND_GEN) ficam SEM `type`: a API atribui o padrão
      // do canal. Enviar um type errado é pior do que omitir.
      const AD_GROUP_TYPE_BY_CHANNEL: Record<string, string> = {
        SEARCH: "SEARCH_STANDARD",
        DISPLAY: "DISPLAY_STANDARD",
        SHOPPING: "SHOPPING_PRODUCT_ADS",
        VIDEO: "VIDEO_RESPONSIVE",
      };
      const adGroupType: string | undefined = type ?? AD_GROUP_TYPE_BY_CHANNEL[channel];

      // O type explícito precisa ser do mesmo canal da campanha (a API recusa, ex.: SEARCH_STANDARD em DISPLAY).
      const CHANNEL_BY_AD_GROUP_TYPE: Record<string, string> = {
        SEARCH_STANDARD: "SEARCH",
        SEARCH_DYNAMIC_ADS: "SEARCH",
        DISPLAY_STANDARD: "DISPLAY",
        SHOPPING_PRODUCT_ADS: "SHOPPING",
        VIDEO_RESPONSIVE: "VIDEO",
        VIDEO_BUMPER: "VIDEO",
        VIDEO_TRUE_VIEW_IN_STREAM: "VIDEO",
        VIDEO_TRUE_VIEW_IN_DISPLAY: "VIDEO",
        VIDEO_NON_SKIPPABLE_IN_STREAM: "VIDEO",
        VIDEO_EFFICIENT_REACH: "VIDEO",
      };
      if (type && CHANNEL_BY_AD_GROUP_TYPE[type] && CHANNEL_BY_AD_GROUP_TYPE[type] !== channel) {
        return {
          content: [text(`O tipo ${type} é de campanha ${CHANNEL_BY_AD_GROUP_TYPE[type]}, mas a campanha ${campaignId} é ${channel}. Omita type para usar o padrão do canal. Nada foi criado.`)],
          isError: true,
        };
      }
      // DSA: a API exige dynamic_search_ads_setting na campanha
      // (AdGroupError.CANNOT_ADD_ADGROUP_OF_TYPE_DSA_TO_CAMPAIGN_WITHOUT_DSA_SETTING).
      const dsaDomain = String(((camp.dynamicSearchAdsSetting ?? {}) as Record<string, unknown>).domainName ?? "").trim();
      const dsaWarnings: string[] = [];
      if (adGroupType === "SEARCH_DYNAMIC_ADS") {
        if (!dsaDomain) {
          return {
            content: [text(
              `A campanha ${campaignId} não tem domínio de Anúncios Dinâmicos de Pesquisa (dynamic_search_ads_setting.domain_name): ` +
              "a API recusa grupo SEARCH_DYNAMIC_ADS nela. Este servidor não configura DSA — e a criação de DSA termina em jan/2027, " +
              "com automigração para AI Max em fev/2027. Para cobrir buscas sem palavra-chave, use AI Max (set_ai_max_settings). Nada foi criado."
            )],
            isError: true,
          };
        }
        dsaWarnings.push(
          `Grupo DSA no domínio ${dsaDomain}: não aceita palavras-chave positivas, e os anúncios DSA e os alvos de página ` +
          "precisam ser criados na interface (este servidor não os cria). A criação de DSA termina em jan/2027 e a automigração " +
          "para AI Max começa em fev/2027 — veja audit_dsa_and_legacy."
        );
      }

      const adGroupData: Record<string, unknown> = {
        name,
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        status: "PAUSED",
      };
      if (adGroupType) {
        adGroupData.type = adGroupType;
      }

      // Lance manual sem valor faz o grupo nascer sem lance útil (o caso real: grupos com
      // R$ 0,01 e zero impressão). Nunca envia placeholder: exige o valor ou recusa.
      const biddingType = String(camp.biddingStrategyType ?? "");
      for (const [label, value] of [["cpcBidMicros", cpcBidMicros], ["cpmBidMicros", cpmBidMicros]] as const) {
        if (value !== undefined && !isPositiveMicros(value)) {
          return { content: [text(`${label} deve ser inteiro positivo em micros (recebido ${value}). Nada foi criado.`)], isError: true };
        }
      }
      if ((biddingType === "MANUAL_CPC" || biddingType === "ENHANCED_CPC") && cpcBidMicros === undefined) {
        return {
          content: [text(`A campanha ${campaignId} usa CPC manual: informe cpcBidMicros (o lance real do grupo). Nada foi criado.`)],
          isError: true,
        };
      }
      if (biddingType === "MANUAL_CPM" && cpmBidMicros === undefined) {
        return {
          content: [text(`A campanha ${campaignId} usa CPM manual: informe cpmBidMicros. Nada foi criado.`)],
          isError: true,
        };
      }
      const bidWarnings: string[] = [];
      if (cpcBidMicros !== undefined) {
        adGroupData.cpcBidMicros = String(cpcBidMicros);
        if (cpcBidMicros < LOW_BID_MICROS) bidWarnings.push(`CPC muito baixo (${money(cpcBidMicros)}): o grupo pode não ganhar leilões.`);
        if (biddingType && !MANUAL_BID_STRATEGIES.has(biddingType)) bidWarnings.push(`A campanha usa ${biddingType}: o lance automático ignora o CPC do grupo.`);
      }
      if (cpmBidMicros !== undefined) adGroupData.cpmBidMicros = String(cpmBidMicros);

      const result = await client.mutateAdGroups(customerId, [{ create: adGroupData }]);
      const warnings = [...bidWarnings, ...dsaWarnings];
      return {
        content: [
          text(
            (client.isDryRun
              ? `DRY-RUN (validateOnly): validado, nada foi gravado — ad group ${name}\n`
              : `Ad group created (PAUSED): ${name}\n`) +
              (warnings.length ? `Avisos: ${warnings.join(" ")}\n` : "") +
              `- Campaign channel: ${channel}\n` +
              `- Ad group type: ${adGroupType ?? "(default do canal)"}\n\n${formatJson(result)}`
          ),
        ],
      };
    }
  );

  mcp.registerTool(
    "update_ad_group",
    {
      description: [
        "Atualiza nome, status, lances e a correspondência de termos do AI Max de um grupo de anúncios.",
        "WRITE OPERATION — só os campos que mudam são enviados (updateMask exato).",
        "",
        "Lances (micros): cpcBidMicros (CPC do grupo — é o lance real em CPC manual e o padrão das",
        "palavras-chave sem lance próprio), cpmBidMicros (Display/Vídeo em CPM manual),",
        "targetCpaMicros (CPA alvo do grupo em estratégias de conversão).",
        "targetRoas (ROAS alvo do grupo, 4.5 = 450%): só vale com TARGET_ROAS ou Maximizar valor COM ROAS alvo, e nunca",
        "com estratégia de portfólio (a API recusa). clearTargetCpa / clearTargetRoas removem o alvo próprio do grupo",
        "(volta a valer o da campanha). A resposta traz os alvos efetivos e a origem (effective_*_source).",
        "disableSearchTermMatching (AI Max): true desliga a correspondência de termos neste grupo.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID (numeric)."),
        name: z.string().optional().describe("New name."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("New status."),
        cpcBidMicros: z.number().optional().describe("CPC do grupo em micros. 2500000 = R$2,50."),
        cpmBidMicros: z.number().optional().describe("CPM do grupo em micros (Display/Vídeo)."),
        targetCpaMicros: z.number().optional().describe("CPA alvo do grupo em micros."),
        targetRoas: z.number().optional().describe("ROAS alvo do grupo (override) em decimal: 4.5 = 450%. De 0.01 a 1000."),
        clearTargetCpa: z.boolean().optional().describe("true remove o CPA alvo próprio do grupo."),
        clearTargetRoas: z.boolean().optional().describe("true remove o ROAS alvo próprio do grupo."),
        disableSearchTermMatching: z.boolean().optional().describe(
          "AI Max: true desliga a correspondência de termos neste grupo; false religa."
        ),
      },
    },
    async ({
      customerId, adGroupId, name, status, cpcBidMicros, cpmBidMicros, targetCpaMicros, targetRoas, clearTargetCpa, clearTargetRoas,
      disableSearchTermMatching,
    }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(adGroupId)) {
        return { content: [text(`adGroupId deve ser numérico, recebido "${adGroupId}".`)], isError: true };
      }
      const problems = ([["cpcBidMicros", cpcBidMicros], ["cpmBidMicros", cpmBidMicros], ["targetCpaMicros", targetCpaMicros]] as const)
        .filter(([, value]) => value !== undefined && !isPositiveMicros(value))
        .map(([label, value]) => `${label} deve ser inteiro positivo em micros (recebido ${value})`);
      // TargetRoas.target_roas: "Value must be between 0.01 and 1000.0, inclusive" (common/bidding.proto)
      if (targetRoas !== undefined && !(targetRoas >= 0.01 && targetRoas <= 1000)) {
        problems.push(`targetRoas deve ficar entre 0.01 e 1000 (recebido ${targetRoas}; 4.5 = 450%)`);
      }
      if (clearTargetCpa && targetCpaMicros !== undefined) problems.push("use targetCpaMicros OU clearTargetCpa, não os dois");
      if (clearTargetRoas && targetRoas !== undefined) problems.push("use targetRoas OU clearTargetRoas, não os dois");
      if (problems.length > 0) {
        return { content: [text(`Nada foi alterado:\n- ${problems.join("\n- ")}`)], isError: true };
      }
      if ([name, status, cpcBidMicros, cpmBidMicros, targetCpaMicros, targetRoas, clearTargetCpa || undefined, clearTargetRoas || undefined, disableSearchTermMatching]
        .every((value) => value === undefined)) {
        return { content: [text("Error: provide at least one field.")], isError: true };
      }

      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const rows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status,
                ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, ad_group.target_cpa_micros, ad_group.target_roas,
                ad_group.effective_target_cpa_micros, ad_group.effective_target_cpa_source,
                ad_group.effective_target_roas, ad_group.effective_target_roas_source,
                ad_group.ai_max_ad_group_setting.disable_search_term_matching,
                campaign.id, campaign.bidding_strategy_type, campaign.bidding_strategy,
                campaign.maximize_conversions.target_cpa_micros,
                campaign.maximize_conversion_value.target_roas
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const adGroup = rows[0]?.adGroup as Record<string, unknown> | undefined;
      if (!adGroup) {
        return { content: [text(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi alterado.`)], isError: true };
      }
      const campaignRow = (rows[0]?.campaign ?? {}) as Record<string, unknown>;
      const strategy = String(campaignRow.biddingStrategyType ?? "");
      const portfolio = typeof campaignRow.biddingStrategy === "string" && campaignRow.biddingStrategy !== "";
      // "If the campaign is using a portfolio bidding strategy, this field cannot be set" (ad_group.proto, target_roas)
      if (targetRoas !== undefined && portfolio) {
        return {
          content: [text(
            `A campanha do grupo ${adGroupId} usa estratégia de portfólio (${campaignRow.biddingStrategy}): a API não aceita ROAS alvo por grupo. ` +
            "Mude o alvo no portfólio (update_bidding_strategy) ou passe a campanha para estratégia padrão. Nada foi alterado."
          )],
          isError: true,
        };
      }
      const currentDisable = Boolean((adGroup.aiMaxAdGroupSetting as Record<string, unknown> | undefined)?.disableSearchTermMatching);

      const update: Record<string, unknown> = { resourceName: `customers/${cid}/adGroups/${adGroupId}` };
      const fields: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      const warnings: string[] = [];
      const set = (key: string, path: string, value: unknown, before: unknown, sent: unknown = value) => {
        if (value === undefined || String(before ?? "") === String(value)) return;
        update[key] = sent;
        fields.push(path);
        changes.push({ setting: key, before, after: value });
      };
      set("name", "name", name, adGroup.name);
      set("status", "status", status, adGroup.status);
      set("cpcBidMicros", "cpc_bid_micros", cpcBidMicros, adGroup.cpcBidMicros, cpcBidMicros !== undefined ? String(cpcBidMicros) : undefined);
      set("cpmBidMicros", "cpm_bid_micros", cpmBidMicros, adGroup.cpmBidMicros, cpmBidMicros !== undefined ? String(cpmBidMicros) : undefined);
      set("targetCpaMicros", "target_cpa_micros", targetCpaMicros, adGroup.targetCpaMicros, targetCpaMicros !== undefined ? String(targetCpaMicros) : undefined);
      set("targetRoas", "target_roas", targetRoas, adGroup.targetRoas);
      // Limpar o override: caminho no updateMask sem valor no objeto (docs "Ad group level target overrides").
      if (clearTargetCpa && num(adGroup.targetCpaMicros) > 0) {
        fields.push("target_cpa_micros");
        changes.push({ setting: "targetCpaMicros", before: adGroup.targetCpaMicros, after: null });
      }
      if (clearTargetRoas && num(adGroup.targetRoas) > 0) {
        fields.push("target_roas");
        changes.push({ setting: "targetRoas", before: adGroup.targetRoas, after: null });
      }
      if (disableSearchTermMatching !== undefined && disableSearchTermMatching !== currentDisable) {
        update.aiMaxAdGroupSetting = { disableSearchTermMatching };
        fields.push("ai_max_ad_group_setting.disable_search_term_matching");
        changes.push({ setting: "disableSearchTermMatching", before: currentDisable, after: disableSearchTermMatching });
      }

      if (cpcBidMicros !== undefined && cpcBidMicros < LOW_BID_MICROS) {
        warnings.push(`CPC muito baixo (${money(cpcBidMicros)}): as palavras-chave sem lance próprio herdam esse valor e podem não ganhar leilões.`);
      }
      if (cpcBidMicros !== undefined && strategy && !MANUAL_BID_STRATEGIES.has(strategy)) {
        warnings.push(`A campanha usa ${strategy}: o lance automático ignora o CPC do grupo.`);
      }
      // Pelo proto, o CPA alvo do grupo só vale em TargetCpa ou em MaximizeConversions COM CPA alvo na campanha
      const campaignTargetCpa = num(
        ((rows[0]?.campaign as Record<string, unknown> | undefined)?.maximizeConversions as Record<string, unknown> | undefined)?.targetCpaMicros
      );
      if (targetCpaMicros !== undefined && strategy && strategy !== "TARGET_CPA" && !(strategy === "MAXIMIZE_CONVERSIONS" && campaignTargetCpa > 0)) {
        warnings.push(
          strategy === "MAXIMIZE_CONVERSIONS"
            ? "A campanha usa Maximizar conversões SEM CPA alvo: o CPA alvo do grupo é ignorado. Defina targetCpaMicros na campanha (update_campaign)."
            : `A campanha usa ${strategy}: o CPA alvo do grupo só vale em Maximizar conversões com CPA alvo.`
        );
      }
      // Pelo proto, o ROAS alvo do grupo só vale em TargetRoas ou MaximizeConversionValue COM ROAS alvo na campanha
      const campaignTargetRoas = num((campaignRow.maximizeConversionValue as Record<string, unknown> | undefined)?.targetRoas);
      if (targetRoas !== undefined && strategy && strategy !== "TARGET_ROAS" && !(strategy === "MAXIMIZE_CONVERSION_VALUE" && campaignTargetRoas > 0)) {
        warnings.push(
          strategy === "MAXIMIZE_CONVERSION_VALUE"
            ? "A campanha usa Maximizar valor SEM ROAS alvo: o ROAS alvo do grupo é ignorado. Defina targetRoas na campanha (update_campaign)."
            : `A campanha usa ${strategy}: o ROAS alvo do grupo só vale em TARGET_ROAS ou Maximizar valor com ROAS alvo.`
        );
      }
      // Alvos efetivos ANTES da mudança (read-only na API): mostram de onde vem o alvo que vale hoje.
      const effectiveBefore = {
        target_cpa: num(adGroup.effectiveTargetCpaMicros) > 0 ? money(adGroup.effectiveTargetCpaMicros) : null,
        target_cpa_source: adGroup.effectiveTargetCpaSource ?? null,
        target_roas: num(adGroup.effectiveTargetRoas) > 0 ? round2(num(adGroup.effectiveTargetRoas)) : null,
        target_roas_source: adGroup.effectiveTargetRoasSource ?? null,
      };

      if (fields.length === 0) {
        return {
          content: [text(
            `Grupo ${adGroupId}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n` +
            formatJson({ effective_targets: effectiveBefore })
          )],
        };
      }
      let result: Record<string, unknown>;
      try {
        result = await client.mutateAdGroups(customerId, [{ update, updateMask: fields.join(",") }]);
      } catch (err) {
        return {
          content: [text(
            `Grupo ${adGroupId}: a API não aceitou a alteração. Nada foi alterado.\nErro: ${(err as Error).message}\n\n` +
            formatJson({ attempted: changes, update_mask: fields })
          )],
          isError: true,
        };
      }
      const dryRun = client.isDryRun;
      return {
        content: [text(
          (dryRun ? `Grupo ${adGroupId} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `Ad group ${adGroupId} updated.`) +
          `\n\n${formatJson({ changes, warnings, update_mask: fields, effective_targets_before: effectiveBefore, result })}`
        )],
      };
    }
  );

  // ── Ad Management ──────────────────────────────────────────────────

  // create_ad: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // update_ad_status: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ── Keyword Management ─────────────────────────────────────────────

  mcp.registerTool(
    "create_keyword",
    {
      description: [
        "Add a keyword to an ad group.",
        "WRITE OPERATION.",
        "Match types: EXACT, PHRASE, BROAD.",
        "Valida antes da API (até 80 caracteres e 10 palavras, sem colchetes/aspas/+), confere o grupo e não",
        "duplica: se a palavra-chave já existe (mesmo texto e correspondência, inclusive pausada), nada é",
        "enviado. Para várias de uma vez, use add_keywords.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        keyword: z.string().describe("Keyword text (sem colchetes/aspas: a correspondência vai em matchType)."),
        matchType: z
          .enum(["EXACT", "PHRASE", "BROAD"])
          .describe("Match type."),
        cpcBidMicros: z
          .number()
          .optional()
          .describe("CPC bid in MICROS. If omitted, uses ad group default."),
        finalUrl: z.string().optional().describe("URL final própria da palavra-chave (http/https)."),
      },
    },
    async ({ customerId, adGroupId, keyword, matchType, cpcBidMicros, finalUrl }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Mesma validação, checagem do grupo, deduplicação e relatório do add_keywords (src/tools/keywords.ts).
      const { addKeywordsToAdGroup } = await import("./tools/keywords.js");
      return addKeywordsToAdGroup(getClient(), customerId, adGroupId, [{ text: keyword, matchType, cpcBidMicros, finalUrl }]);
    }
  );

  mcp.registerTool(
    "remove_keyword",
    {
      description: [
        "Remove uma palavra-chave (ou negativa) de um grupo de anúncios.",
        "WRITE OPERATION — irreversível: a palavra-chave removida não volta (seria preciso criá-la de novo,",
        "sem o histórico). Prefira pausar (update_keyword / bulk_update_keyword_status).",
        "Confere a palavra-chave na conta e exige confirm: true; sem ele, mostra o que seria removido.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        criterionId: z.string().describe("Keyword criterion ID (ver list_keywords)."),
        confirm: z.boolean().optional().describe("Precisa ser true para remover."),
      },
    },
    async ({ customerId, adGroupId, criterionId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(adGroupId) || !/^\d+$/.test(criterionId)) {
        return { content: [text("adGroupId e criterionId devem ser numéricos. Nada foi removido.")], isError: true };
      }
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.status,
                ad_group_criterion.negative, ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type, ad_group.id, ad_group.name, campaign.name
         FROM ad_group_criterion
         WHERE ad_group.id = ${adGroupId}
           AND ad_group_criterion.criterion_id = ${criterionId}`);
      const criterion = rows[0]?.adGroupCriterion as Record<string, unknown> | undefined;
      if (!criterion) {
        return { content: [text(`Palavra-chave ${criterionId} não encontrada no grupo ${adGroupId} da conta ${cid}. Nada foi removido.`)], isError: true };
      }
      if (criterion.type !== undefined && criterion.type !== "KEYWORD") {
        return { content: [text(`O critério ${criterionId} não é palavra-chave (${String(criterion.type)}): remove_keyword só remove palavras-chave. Nada foi removido.`)], isError: true };
      }
      const kw = (criterion.keyword ?? {}) as Record<string, unknown>;
      const label = `${criterion.negative ? "negativa " : ""}"${String(kw.text ?? "")}" [${String(kw.matchType ?? "")}]`;
      const where = `grupo ${String((rows[0]?.adGroup as Record<string, unknown> | undefined)?.name ?? adGroupId)} / campanha ${String((rows[0]?.campaign as Record<string, unknown> | undefined)?.name ?? "")}`;
      if (criterion.status === "REMOVED") {
        return { content: [text(`${label} já está removida. Nenhuma escrita foi enviada.`)] };
      }
      if (confirm !== true) {
        return {
          content: [text(`Vai remover ${label} (status ${String(criterion.status ?? "")}, ${where}). A remoção é irreversível — envie confirm: true para remover, ou pause em vez disso. Nada foi removido.`)],
          isError: true,
        };
      }

      const result = await client.mutateAdGroupCriteria(customerId, [
        { remove: `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}` },
      ]);
      const head = client.isDryRun
        ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.`
        : `${label} removida (${where}).`;
      return { content: [text(`${head}\n\n${formatJson(result)}`)] };
    }
  );

  mcp.registerTool(
    "update_keyword",
    {
      description: [
        "Ajusta uma palavra-chave existente sem apagá-la (mantém o histórico).",
        "WRITE OPERATION — só os campos que mudam são enviados.",
        "",
        "- cpcBidMicros: lance da palavra-chave em micros (sobrepõe o CPC do grupo)",
        "- status: ENABLED ou PAUSED",
        "- finalUrl: URL final própria da palavra-chave; \"\" remove e volta a usar a do anúncio",
        "O texto e a correspondência não mudam: para isso, crie outra e remova esta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios."),
        criterionId: z.string().describe("ID da palavra-chave (criterion_id, ver list_keywords ou get_keyword_performance)."),
        cpcBidMicros: z.number().optional().describe("Lance em micros. 2500000 = R$2,50."),
        status: z.enum(["ENABLED", "PAUSED"]).optional().describe("ENABLED ou PAUSED."),
        finalUrl: z.string().optional().describe("URL final (http/https); \"\" remove."),
      },
    },
    async ({ customerId, adGroupId, criterionId, cpcBidMicros, status, finalUrl }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(adGroupId) || !/^\d+$/.test(criterionId)) {
        return { content: [text("adGroupId e criterionId devem ser numéricos. Nada foi alterado.")], isError: true };
      }
      if (cpcBidMicros !== undefined && !isPositiveMicros(cpcBidMicros)) {
        return { content: [text(`cpcBidMicros deve ser inteiro positivo em micros (recebido ${cpcBidMicros}). Nada foi alterado.`)], isError: true };
      }
      const url = finalUrl?.trim();
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        return { content: [text(`finalUrl inválida: "${finalUrl}". Use uma URL http(s) completa, ou "" para remover.`)], isError: true };
      }
      if (cpcBidMicros === undefined && status === undefined && finalUrl === undefined) {
        return { content: [text("Informe ao menos um ajuste: cpcBidMicros, status ou finalUrl.")], isError: true };
      }

      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const rows = await client.searchStream(customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros,
                ad_group_criterion.effective_cpc_bid_micros, ad_group_criterion.final_urls,
                ad_group.id, campaign.bidding_strategy_type
         FROM ad_group_criterion
         WHERE ad_group.id = ${adGroupId}
           AND ad_group_criterion.criterion_id = ${criterionId}
           AND ad_group_criterion.type = 'KEYWORD'`);
      const criterion = rows[0]?.adGroupCriterion as Record<string, unknown> | undefined;
      if (!criterion) {
        return { content: [text(`Palavra-chave ${criterionId} não encontrada no grupo ${adGroupId} da conta ${cid}. Nada foi alterado.`)], isError: true };
      }
      const keyword = (criterion.keyword ?? {}) as Record<string, unknown>;
      const label = `"${keyword.text}" [${keyword.matchType}]`;
      if (criterion.status === "REMOVED") {
        return { content: [text(`A palavra-chave ${label} está removida. Nada foi alterado.`)], isError: true };
      }
      if (criterion.negative && (cpcBidMicros !== undefined || finalUrl !== undefined)) {
        return { content: [text(`${label} é negativa: não tem lance nem URL final. Nada foi alterado.`)], isError: true };
      }
      const strategy = String((rows[0]?.campaign as Record<string, unknown> | undefined)?.biddingStrategyType ?? "");

      const update: Record<string, unknown> = { resourceName: `customers/${cid}/adGroupCriteria/${adGroupId}~${criterionId}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      const warnings: string[] = [];
      if (cpcBidMicros !== undefined && String(criterion.cpcBidMicros ?? "") !== String(cpcBidMicros)) {
        update.cpcBidMicros = String(cpcBidMicros);
        mask.push("cpc_bid_micros");
        changes.push({ setting: "cpcBidMicros", before: criterion.cpcBidMicros ?? `(herda do grupo: ${money(criterion.effectiveCpcBidMicros)})`, after: cpcBidMicros });
      }
      if (status !== undefined && status !== criterion.status) {
        update.status = status;
        mask.push("status");
        changes.push({ setting: "status", before: criterion.status, after: status });
      }
      if (finalUrl !== undefined) {
        const before = ((criterion.finalUrls as string[]) ?? []);
        const after = url ? [url] : [];
        if (before.join("|") !== after.join("|")) {
          update.finalUrls = after;
          mask.push("final_urls");
          changes.push({ setting: "finalUrls", before, after });
        }
      }
      if (cpcBidMicros !== undefined && cpcBidMicros < LOW_BID_MICROS) {
        warnings.push(`Lance muito baixo (${money(cpcBidMicros)}): a palavra-chave pode não ganhar leilões.`);
      }
      if (cpcBidMicros !== undefined && strategy && !MANUAL_BID_STRATEGIES.has(strategy)) {
        warnings.push(`A campanha usa ${strategy}: o lance automático ignora o lance da palavra-chave.`);
      }

      if (mask.length === 0) {
        return { content: [text(`${label}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.`)] };
      }
      const result = await client.mutateAdGroupCriteria(customerId, [{ update, updateMask: mask.join(",") }]);
      const dryRun = client.isDryRun;
      return {
        content: [text(
          (dryRun ? `${label} — DRY-RUN (validateOnly): validado, nada foi gravado.` : `${label} atualizada.`) +
          `\n\n${formatJson({ changes, warnings, update_mask: mask, result })}`
        )],
      };
    }
  );

  // remove_negative_keyword: implementada em src/tools/negatives.ts (lote negatives).

  // ── Negative Keywords (WRITE) ──────────────────────────────────────

  // add_negative_keyword: implementada em src/tools/negatives.ts (lote negatives).

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

  // upload_image_asset e upload_video_asset: src/tools/asset-library.ts (lote asset-library).

  // ── Imagens em campanhas de Pesquisa (AD_IMAGE) ────────────────────

  mcp.registerTool(
    "link_campaign_image_assets",
    {
      description: [
        "Vincula imagens JÁ EXISTENTES na biblioteca a uma campanha de Pesquisa, como recurso de imagem (AD_IMAGE).",
        "WRITE OPERATION — cria só os vínculos; não altera campanha, orçamento, lances nem segmentação.",
        "",
        "Fluxo: upload_image_asset (sobe a imagem) → link_campaign_image_assets (vincula)",
        "→ list_campaign_image_assets (confirma status e análise).",
        "",
        "Antes de gravar, confere que a campanha existe nesta conta e é SEARCH, e que cada",
        "imagem existe nesta conta e é do tipo IMAGE. Vínculo que já existe não é recriado;",
        "vínculo PAUSADO fica pausado (não é reativado). Retorna criados, já existentes e erros.",
        "Com GOOGLE_ADS_DRY_RUN=true a API só valida (validateOnly) e nada é gravado.",
        "",
        "Regras do Google: ao menos uma imagem quadrada 1:1 (mín. 300x300); paisagem 1.91:1",
        "opcional (mín. 600x314); até 20 imagens por campanha. A imagem passa por análise antes de veicular.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha de Pesquisa."),
        assetResourceNames: flexArray(z.string()).describe(
          "Imagens a vincular: resource names (customers/{customerId}/assets/{assetId}) ou os IDs numéricos. Máx. 20."
        ),
      },
    },
    async ({ customerId, campaignId, assetResourceNames }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) {
        return { content: [text(`customerId inválido: "${customerId}". Nada foi gravado.`)], isError: true };
      }
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi gravado.`)], isError: true };
      }

      const refs = ensureArray<string>(assetResourceNames).map(String).filter((ref) => ref.trim());
      if (refs.length === 0) {
        return { content: [text("Informe ao menos uma imagem em assetResourceNames. Nada foi gravado.")], isError: true };
      }

      // 1. Formato e conta de cada referência — antes de qualquer chamada à API
      const invalid: string[] = [];
      const wanted = new Map<string, string>(); // assetId → resource name (repetidos viram um só)
      for (const ref of refs) {
        const parsed = parseImageAssetRef(ref, cid);
        if ("error" in parsed) invalid.push(parsed.error);
        else wanted.set(parsed.assetId, parsed.resourceName);
      }
      if (invalid.length > 0) {
        return { content: [text(`Nada foi gravado — referência(s) inválida(s):\n- ${invalid.join("\n- ")}`)], isError: true };
      }
      if (wanted.size > MAX_CAMPAIGN_IMAGES_PER_CALL) {
        return {
          content: [text(
            `No máximo ${MAX_CAMPAIGN_IMAGES_PER_CALL} imagens por chamada (o Google aceita até 20 por campanha). ` +
            `Recebidas ${wanted.size}. Nada foi gravado.`
          )],
          isError: true,
        };
      }

      const client = getClient();

      // 2. Campanha: existe nesta conta e é de Pesquisa
      const campaignRows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = campaignRows[0]?.campaign as Record<string, unknown> | undefined;
      if (!campaign) {
        return { content: [text(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi gravado.`)], isError: true };
      }
      const campaignInfo = {
        id: String(campaign.id ?? campaignId),
        name: campaign.name,
        channel: campaign.advertisingChannelType,
        status: campaign.status,
      };
      if (campaign.advertisingChannelType !== "SEARCH") {
        return {
          content: [text(
            `Campanha ${campaignId} ("${campaign.name}") é ${campaign.advertisingChannelType}, não SEARCH. ` +
            "Esta tool vincula imagem só em campanha de Pesquisa. Nada foi gravado."
          )],
          isError: true,
        };
      }
      if (campaign.status === "REMOVED") {
        return { content: [text(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi gravado.`)], isError: true };
      }

      // 3. Imagens: existem nesta conta e são do tipo IMAGE
      const assetIds = [...wanted.keys()];
      const assetRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.type,
                asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
         FROM asset
         WHERE asset.id IN (${assetIds.join(", ")})`);
      const assets = new Map<string, Record<string, unknown>>();
      for (const row of assetRows) {
        const asset = (row.asset ?? {}) as Record<string, unknown>;
        assets.set(String(asset.id), asset);
      }
      const rejected: string[] = [];
      for (const id of assetIds) {
        const asset = assets.get(id);
        if (!asset) rejected.push(`asset ${id} não existe na conta ${cid}`);
        else if (asset.type !== "IMAGE") rejected.push(`asset ${id} ("${asset.name ?? ""}") é do tipo ${asset.type}, não IMAGE`);
      }
      if (rejected.length > 0) {
        return { content: [text(`Nada foi gravado:\n- ${rejected.join("\n- ")}`)], isError: true };
      }
      const describe = (id: string) => {
        const asset = assets.get(id) ?? {};
        const full = (((asset.imageAsset as Record<string, unknown>) ?? {}).fullSize ?? {}) as Record<string, unknown>;
        const width = num(full.widthPixels);
        const height = num(full.heightPixels);
        return {
          asset_id: id,
          asset_name: asset.name,
          dimensions: width && height ? `${width}x${height}` : undefined,
          aspect: imageAspectLabel(width, height),
        };
      };

      // 4. Vínculos que já existem, em qualquer status: nada é recriado nem reativado
      const campaignResource = `customers/${cid}/campaigns/${campaignId}`;
      const existing = await fetchCampaignImageLinks(client, customerId, campaignResource);

      const alreadyLinked: Array<Record<string, unknown>> = [];
      const toCreate: Array<{ id: string; resourceName: string; previouslyRemoved: boolean }> = [];
      for (const id of assetIds) {
        const link = existing.get(id);
        if (link && link.status !== "REMOVED") {
          alreadyLinked.push({
            ...describe(id),
            link_status: link.status,
            link_resource_name: link.resourceName,
            note: link.status === "PAUSED" ? "vínculo pausado — mantido pausado, não foi reativado" : "já vinculada",
          });
        } else {
          toCreate.push({ id, resourceName: wanted.get(id)!, previouslyRemoved: Boolean(link) });
        }
      }

      const dryRun = client.isDryRun;
      const campaignLine = `Campanha ${campaignInfo.id} ("${campaignInfo.name}", SEARCH)`;
      const nextStep = dryRun
        ? "Dry-run: para gravar de verdade, rode de novo sem GOOGLE_ADS_DRY_RUN."
        : "Confirme com list_campaign_image_assets (status do vínculo e análise da imagem).";

      if (toCreate.length === 0) {
        return {
          content: [text(
            `${campaignLine}: nada a fazer — as ${alreadyLinked.length} imagem(ns) já estavam vinculadas. ` +
            "Nenhuma escrita foi enviada.\n\n" +
            formatJson({ campaign: campaignInfo, dry_run: dryRun, created: [], already_linked: alreadyLinked, errors: [] })
          )],
        };
      }

      let response: Record<string, unknown>;
      try {
        response = await client.mutateCampaignAssets(
          customerId,
          toCreate.map((item) => ({
            create: { campaign: campaignResource, asset: item.resourceName, fieldType: "AD_IMAGE", status: "ENABLED" },
          })),
          { partialFailure: true }
        );
      } catch (err) {
        const message = (err as Error).message;
        // Erro de transporte (conexão caída, 5xx sem corpo) pode acontecer DEPOIS de a
        // API gravar. Em vez de afirmar "nada foi criado", confere a conta.
        let afterError: Map<string, { status: string; resourceName: string }> | null = null;
        if (!dryRun) {
          try {
            afterError = await fetchCampaignImageLinks(client, customerId, campaignResource);
          } catch {
            afterError = null;
          }
        }
        if (!dryRun && afterError === null) {
          return {
            content: [text(
              `${campaignLine}: a requisição falhou e não foi possível conferir a conta depois — ` +
              "o resultado é INCERTO. Confira com list_campaign_image_assets antes de repetir.\n" +
              `Erro: ${message}\n\n` +
              formatJson({
                campaign: campaignInfo,
                dry_run: dryRun,
                created: [],
                already_linked: alreadyLinked,
                errors: toCreate.map((item) => ({ ...describe(item.id), error: `resultado incerto: ${message}` })),
              })
            )],
            isError: true,
          };
        }
        const confirmedAfterError = toCreate.filter((item) => afterError?.get(item.id)?.status === "ENABLED");
        const stillMissing = toCreate.filter((item) => !confirmedAfterError.includes(item));
        return {
          content: [text(
            `${campaignLine}: a requisição falhou${dryRun ? " (dry-run, nada gravado)" : "; estado conferido na conta depois do erro"}.\n` +
            `Erro: ${message}\n\n` +
            formatJson({
              campaign: campaignInfo,
              dry_run: dryRun,
              [dryRun ? "validated" : "created"]: confirmedAfterError.map((item) => ({
                ...describe(item.id),
                link_resource_name: afterError?.get(item.id)?.resourceName,
                note: "gravado apesar do erro (confirmado na conta)",
              })),
              already_linked: alreadyLinked,
              errors: stillMissing.map((item) => ({ ...describe(item.id), error: message })),
            })
          )],
          isError: true,
        };
      }

      const results = (response.results as Array<Record<string, unknown>>) ?? [];
      const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, toCreate.length);
      const created: Array<Record<string, unknown>> = [];
      const errors: Array<Record<string, unknown>> = [];
      toCreate.forEach((item, index) => {
        const opErrors = byIndex.get(index);
        if (opErrors) {
          errors.push({ ...describe(item.id), error: opErrors.join("; ") });
          return;
        }
        const linkResource = results[index]?.resourceName as string | undefined;
        if (dryRun ? unattributed.length > 0 : !linkResource) {
          // Sem confirmação: em gravação real falta o resourceName; em dry-run há
          // erro que a API não atribuiu a nenhuma operação
          errors.push({
            ...describe(item.id),
            error: dryRun ? "validação não confirmada (a API devolveu erro sem indicar a operação)" : "a API não confirmou o vínculo",
          });
          return;
        }
        created.push({
          ...describe(item.id),
          ...(linkResource ? { link_resource_name: linkResource } : {}),
          ...(item.previouslyRemoved
            ? {
                note: dryRun
                  ? "havia um vínculo removido; seria criado de novo (nada gravado)"
                  : "havia um vínculo removido para esta imagem; foi criado de novo",
              }
            : {}),
        });
      });
      for (const message of unattributed) errors.push({ error: message });

      const counts = `Já vinculadas: ${alreadyLinked.length} | Com erro: ${errors.length}`;
      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): nada foi gravado.\nValidadas pela API: ${created.length} | ${counts}`
        : `${campaignLine}\nVínculos criados: ${created.length} | ${counts}`;

      return {
        content: [text(
          `${header}\n\n` +
          formatJson({
            campaign: campaignInfo,
            dry_run: dryRun,
            [dryRun ? "validated" : "created"]: created,
            already_linked: alreadyLinked,
            errors,
          }) +
          `\n\n${nextStep}`
        )],
        isError: errors.length > 0,
      };
    }
  );

  mcp.registerTool(
    "list_campaign_image_assets",
    {
      description: [
        "Lista as imagens vinculadas a campanhas de Pesquisa (recursos de imagem, AD_IMAGE).",
        "READ OPERATION.",
        "",
        "Por imagem: ID, nome, URL, dimensões e proporção, status do vínculo (ENABLED/PAUSED),",
        "primary_status do vínculo com os motivos (ex.: PENDING + ASSET_UNDER_REVIEW) e a",
        "situação de análise/política da imagem, com os tópicos de política quando houver.",
        "",
        "Use para confirmar o resultado de link_campaign_image_assets. get_image_assets lista a",
        "biblioteca da conta; esta tool mostra o que está vinculado em cada campanha.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha. Sem ele, lista todas as campanhas da conta."),
        includeRemoved: z.boolean().optional().describe("Inclui vínculos removidos. Default: false."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, includeRemoved, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      const client = getClient();

      const filters = ["campaign_asset.field_type = 'AD_IMAGE'"];
      if (!includeRemoved) filters.push("campaign_asset.status != 'REMOVED'");
      if (campaignId) filters.push(`campaign.id = ${campaignId}`);

      const results = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name,
                asset.id, asset.name,
                asset.image_asset.full_size.url,
                asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels,
                asset.image_asset.file_size, asset.image_asset.mime_type,
                asset.policy_summary.review_status, asset.policy_summary.approval_status,
                asset.policy_summary.policy_topic_entries,
                asset.field_type_policy_summaries,
                campaign_asset.resource_name, campaign_asset.status, campaign_asset.source,
                campaign_asset.primary_status, campaign_asset.primary_status_reasons
         FROM campaign_asset
         WHERE ${filters.join(" AND ")}`);

      const rows = results.map((r) => {
        const camp = (r.campaign ?? {}) as Record<string, unknown>;
        const asset = (r.asset ?? {}) as Record<string, unknown>;
        const link = (r.campaignAsset ?? {}) as Record<string, unknown>;
        const image = (asset.imageAsset ?? {}) as Record<string, unknown>;
        const full = (image.fullSize ?? {}) as Record<string, unknown>;
        const width = num(full.widthPixels);
        const height = num(full.heightPixels);
        // Análise do uso como AD_IMAGE quando a API devolve; senão, a do asset
        const fieldPolicy = ((asset.fieldTypePolicySummaries as Array<Record<string, unknown>>) ?? [])
          .find((summary) => summary.assetFieldType === "AD_IMAGE")?.policySummaryInfo as Record<string, unknown> | undefined;
        const policy = (fieldPolicy ?? asset.policySummary ?? {}) as Record<string, unknown>;
        const topics = ((policy.policyTopicEntries as Array<Record<string, unknown>>) ?? [])
          .map((entry) => `${entry.topic ?? "?"} (${entry.type ?? "?"})`);
        return {
          campaign_id: String(camp.id ?? ""),
          campaign_name: camp.name,
          asset_id: String(asset.id ?? ""),
          asset_name: asset.name,
          url: full.url,
          dimensions: width && height ? `${width}x${height}` : undefined,
          aspect: imageAspectLabel(width, height),
          file_size: image.fileSize !== undefined ? num(image.fileSize) : undefined,
          mime_type: image.mimeType,
          link_status: link.status,
          primary_status: link.primaryStatus,
          primary_status_reasons: (link.primaryStatusReasons as string[]) ?? [],
          review_status: policy.reviewStatus,
          approval_status: policy.approvalStatus,
          policy_topics: topics,
          policy_scope: fieldPolicy ? "AD_IMAGE" : "asset",
          source: link.source,
          link_resource_name: link.resourceName,
        };
      }).sort((a, b) => a.campaign_id.localeCompare(b.campaign_id) || a.asset_id.localeCompare(b.asset_id));

      if (format === "table") return { content: [text(formatAsTable(rows as Array<Record<string, unknown>>))] };
      if (format === "csv") return { content: [text(formatAsCsv(rows as Array<Record<string, unknown>>))] };

      if (rows.length === 0) {
        return { content: [text(
          `Nenhuma imagem vinculada ${campaignId ? `à campanha ${campaignId}` : "a campanhas desta conta"}.`
        )] };
      }

      const byCampaign = new Map<string, typeof rows>();
      for (const row of rows) byCampaign.set(row.campaign_id, [...(byCampaign.get(row.campaign_id) ?? []), row]);
      const summary = [...byCampaign.entries()].map(([id, list]) => {
        const statusCounts = new Map<string, number>();
        for (const row of list) {
          const key = String(row.primary_status ?? "?");
          statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
        }
        const statuses = [...statusCounts.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
        const enabled = list.filter((row) => row.link_status === "ENABLED");
        const squareWarning = enabled.some((row) => row.aspect.startsWith("1:1"))
          ? ""
          : " — ATENÇÃO: nenhuma imagem quadrada 1:1 habilitada (o Google exige ao menos uma)";
        return `Campanha ${id} ("${list[0].campaign_name}"): ${list.length} imagem(ns) — ${statuses}${squareWarning}`;
      });

      return { content: [text(`${rows.length} vínculo(s) de imagem.\n${summary.join("\n")}\n\n${formatJson(rows)}`)] };
    }
  );

  // ── AI Max (Pesquisa e Shopping) ───────────────────────────────────

  mcp.registerTool(
    "set_ai_max_settings",
    {
      description: [
        "Liga/desliga o AI Max numa campanha e ajusta os controles dele.",
        "WRITE OPERATION — altera só as configurações informadas; não mexe em orçamento, lances,",
        "segmentação nem palavras-chave.",
        "",
        "- enableAiMax: liga/desliga o AI Max (Pesquisa e Shopping).",
        "- textCustomization: personalização de texto (TEXT_ASSET_AUTOMATION). Só Pesquisa — em Shopping",
        "  ela vem sempre ligada junto com o AI Max.",
        "- finalUrlExpansion: expansão de URL final (FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION).",
        "- termExclusions: palavras que os textos gerados não podem usar. SUBSTITUI a lista; [] limpa.",
        "  Máx. 25, até 30 caracteres cada.",
        "- messagingRestrictions: instruções do que os textos gerados não podem dizer. SUBSTITUI a lista;",
        "  [] limpa. Máx. 40, até 300 caracteres cada.",
        "",
        "A correspondência de termos é por grupo de anúncios: update_ad_group com disableSearchTermMatching.",
        "Com AI Max ligado, a API trata as palavras-chave como correspondência ampla.",
        "Valor igual ao atual não é reenviado. Com GOOGLE_ADS_DRY_RUN=true a API só valida.",
        "Para medir o efeito: get_ai_max_report.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID numérico da campanha (Pesquisa ou Shopping)."),
        enableAiMax: z.boolean().optional().describe("true liga, false desliga o AI Max."),
        textCustomization: z.boolean().optional().describe("Personalização de texto: true = OPTED_IN, false = OPTED_OUT."),
        finalUrlExpansion: z.boolean().optional().describe("Expansão de URL final: true = OPTED_IN, false = OPTED_OUT."),
        termExclusions: flexArray(z.string()).optional().describe(
          "Lista COMPLETA de termos excluídos dos textos gerados (substitui a atual; [] limpa)."
        ),
        messagingRestrictions: flexArray(z.string()).optional().describe(
          "Lista COMPLETA de restrições de mensagem (substitui a atual; [] limpa). Ex: \"não mencionar frete grátis\"."
        ),
      },
    },
    async ({ customerId, campaignId, enableAiMax, textCustomization, finalUrlExpansion, termExclusions, messagingRestrictions }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) {
        return { content: [text(`customerId inválido: "${customerId}". Nada foi alterado.`)], isError: true };
      }
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`)], isError: true };
      }

      // flexArray aceita string JSON sem validar os itens: um objeto viraria "[object Object]"
      // e substituiria a lista inteira. Só texto passa ({restrictionText} vira o texto).
      const problems: string[] = [];
      const cleanList = (value: unknown, label: string, acceptRestrictionObjects: boolean) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const entry of ensureArray<unknown>(value)) {
          const raw =
            typeof entry === "string" ? entry
            : acceptRestrictionObjects && entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).restrictionText === "string"
              ? String((entry as Record<string, unknown>).restrictionText)
              : undefined;
          if (raw === undefined) {
            problems.push(`${label}: item inválido ${JSON.stringify(entry)} — use só texto`);
            continue;
          }
          const item = raw.trim();
          if (item && !seen.has(item)) { seen.add(item); out.push(item); }
        }
        return out;
      };
      const terms = termExclusions === undefined ? undefined : cleanList(termExclusions, "termExclusions", false);
      const restrictions = messagingRestrictions === undefined ? undefined : cleanList(messagingRestrictions, "messagingRestrictions", true);

      // Limites documentados no proto — recusados antes de qualquer chamada
      if (terms && terms.length > MAX_TERM_EXCLUSIONS) {
        problems.push(`termExclusions: ${terms.length} termos (máx. ${MAX_TERM_EXCLUSIONS})`);
      }
      for (const term of terms ?? []) {
        if (term.length > MAX_TERM_EXCLUSION_CHARS) {
          problems.push(`termExclusions: "${term}" tem ${term.length} caracteres (máx. ${MAX_TERM_EXCLUSION_CHARS})`);
        }
      }
      if (restrictions && restrictions.length > MAX_MESSAGING_RESTRICTIONS) {
        problems.push(`messagingRestrictions: ${restrictions.length} restrições (máx. ${MAX_MESSAGING_RESTRICTIONS})`);
      }
      for (const restriction of restrictions ?? []) {
        if (restriction.length > MAX_MESSAGING_RESTRICTION_CHARS) {
          problems.push(`messagingRestrictions: uma restrição tem ${restriction.length} caracteres (máx. ${MAX_MESSAGING_RESTRICTION_CHARS})`);
        }
      }
      if (problems.length > 0) {
        return { content: [text(`Nada foi alterado:\n- ${problems.join("\n- ")}`)], isError: true };
      }
      if ([enableAiMax, textCustomization, finalUrlExpansion, terms, restrictions].every((value) => value === undefined)) {
        return { content: [text("Informe ao menos um ajuste (enableAiMax, textCustomization, finalUrlExpansion, termExclusions ou messagingRestrictions).")], isError: true };
      }

      const client = getClient();
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
                campaign.ai_max_setting.enable_ai_max, campaign.ai_max_setting.bundling_required,
                campaign.asset_automation_settings,
                campaign.text_guidelines.term_exclusions, campaign.text_guidelines.messaging_restrictions
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = rows[0]?.campaign as Record<string, unknown> | undefined;
      if (!campaign) {
        return { content: [text(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi alterado.`)], isError: true };
      }
      const channel = String(campaign.advertisingChannelType ?? "");
      if (channel !== "SEARCH" && channel !== "SHOPPING") {
        return {
          content: [text(`Campanha ${campaignId} ("${campaign.name}") é ${channel}. AI Max só existe em Pesquisa e Shopping. Nada foi alterado.`)],
          isError: true,
        };
      }
      if (campaign.status === "REMOVED") {
        return { content: [text(`Campanha ${campaignId} ("${campaign.name}") está removida. Nada foi alterado.`)], isError: true };
      }
      if (channel === "SHOPPING" && textCustomization !== undefined) {
        return {
          content: [text("Em Shopping a personalização de texto vem sempre ligada junto com o AI Max; não há como ajustá-la separadamente. Nada foi alterado.")],
          isError: true,
        };
      }

      const aiMax = (campaign.aiMaxSetting ?? {}) as Record<string, unknown>;
      const guidelines = (campaign.textGuidelines ?? {}) as Record<string, unknown>;
      const current = {
        enableAiMax: Boolean(aiMax.enableAiMax),
        bundlingRequired: aiMax.bundlingRequired as string | undefined,
        automation: ((campaign.assetAutomationSettings as Array<Record<string, unknown>>) ?? []).map((setting) => ({
          assetAutomationType: String(setting.assetAutomationType ?? ""),
          assetAutomationStatus: String(setting.assetAutomationStatus ?? ""),
        })),
        termExclusions: ((guidelines.termExclusions as string[]) ?? []).map(String),
        messagingRestrictions: ((guidelines.messagingRestrictions as Array<Record<string, unknown>>) ?? [])
          .map((restriction) => String(restriction.restrictionText ?? "")),
      };
      const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i]);

      const update: Record<string, unknown> = { resourceName: `customers/${cid}/campaigns/${campaignId}` };
      const mask: string[] = [];
      const changes: Array<{ setting: string; before: unknown; after: unknown }> = [];
      const unchanged: string[] = [];

      if (enableAiMax !== undefined) {
        if (enableAiMax === current.enableAiMax) {
          unchanged.push(`AI Max (${enableAiMax ? "ligado" : "desligado"})`);
        } else {
          update.aiMaxSetting = { enableAiMax };
          mask.push("ai_max_setting.enable_ai_max");
          changes.push({ setting: "AI Max", before: current.enableAiMax, after: enableAiMax });
        }
      }

      // asset_automation_settings é repetido: o updateMask substitui a lista inteira,
      // então os tipos que não estamos mexendo são reenviados como estão.
      let automation = current.automation.map((setting) => ({ ...setting }));
      let automationChanged = false;
      const automationRequests: Array<[string, boolean | undefined, string]> = [
        ["TEXT_ASSET_AUTOMATION", textCustomization, "Personalização de texto"],
        ["FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", finalUrlExpansion, "Expansão de URL final"],
      ];
      for (const [type, value, label] of automationRequests) {
        if (value === undefined) continue;
        const status = value ? "OPTED_IN" : "OPTED_OUT";
        const before = current.automation.find((setting) => setting.assetAutomationType === type)?.assetAutomationStatus;
        if (before === status) {
          unchanged.push(`${label} (${status})`);
          continue;
        }
        automation = automation
          .filter((setting) => setting.assetAutomationType !== type)
          .concat([{ assetAutomationType: type, assetAutomationStatus: status }]);
        automationChanged = true;
        changes.push({ setting: label, before: before ?? "padrão da API (não definido)", after: status });
      }
      if (automationChanged) {
        update.assetAutomationSettings = automation;
        mask.push("asset_automation_settings");
      }

      const textGuidelines: Record<string, unknown> = {};
      if (terms !== undefined) {
        if (sameList(terms, current.termExclusions)) {
          unchanged.push("Termos excluídos");
        } else {
          textGuidelines.termExclusions = terms;
          mask.push("text_guidelines.term_exclusions");
          changes.push({ setting: "Termos excluídos", before: current.termExclusions, after: terms });
        }
      }
      if (restrictions !== undefined) {
        if (sameList(restrictions, current.messagingRestrictions)) {
          unchanged.push("Restrições de mensagem");
        } else {
          textGuidelines.messagingRestrictions = restrictions.map((restrictionText) => ({
            restrictionText,
            restrictionType: "RESTRICTION_BASED_EXCLUSION",
          }));
          mask.push("text_guidelines.messaging_restrictions");
          changes.push({ setting: "Restrições de mensagem", before: current.messagingRestrictions, after: restrictions });
        }
      }
      if (Object.keys(textGuidelines).length > 0) update.textGuidelines = textGuidelines;

      const campaignLine = `Campanha ${campaignId} ("${campaign.name}", ${channel})`;
      const warnings: string[] = [];
      const aiMaxAfter = enableAiMax ?? current.enableAiMax;
      const touchesControls = automationChanged || Object.keys(textGuidelines).length > 0;
      if (!aiMaxAfter && touchesControls && current.bundlingRequired === "REQUIRED") {
        warnings.push("Esta campanha exige AI Max ligado para mudar personalização de texto e diretrizes (bundling_required = REQUIRED); a API deve recusar com AI_MAX_MUST_BE_ENABLED.");
      }
      if (enableAiMax === false && current.enableAiMax && current.bundlingRequired === "REQUIRED") {
        warnings.push("Com bundling_required = REQUIRED, desligar o AI Max também para de veicular a personalização de texto e as listas de marca desta campanha.");
      }

      if (mask.length === 0) {
        return {
          content: [text(
            `${campaignLine}: nada a mudar — os valores pedidos já estão aplicados. Nenhuma escrita foi enviada.\n\n` +
            formatJson({ unchanged, current })
          )],
        };
      }

      const dryRun = client.isDryRun;
      try {
        await client.mutateCampaigns(customerId, [{ update, updateMask: mask.join(",") }]);
      } catch (err) {
        return {
          content: [text(
            `${campaignLine}: a API não aceitou a alteração.\nErro: ${(err as Error).message}\n` +
            "Confira o estado atual antes de repetir (get_ai_max_report ou run_gaql em campaign.ai_max_setting).\n\n" +
            formatJson({ attempted: changes, update_mask: mask, warnings })
          )],
          isError: true,
        };
      }

      const header = dryRun
        ? `${campaignLine} — DRY-RUN (validateOnly): a API validou, nada foi gravado.`
        : `${campaignLine} — ${changes.length} ajuste(s) aplicado(s).`;
      return {
        content: [text(
          `${header}\n\n` +
          formatJson({ changes, unchanged, warnings, update_mask: mask }) +
          (dryRun ? "\n\nPara gravar de verdade, rode sem GOOGLE_ADS_DRY_RUN." : "\n\nMeça o efeito com get_ai_max_report.")
        )],
      };
    }
  );

  mcp.registerTool(
    "get_ai_max_report",
    {
      description: [
        "Relatório do AI Max em campanhas de Pesquisa. READ OPERATION.",
        "",
        "view='search_terms' (default): termos que vieram do AI Max — AI_MAX_KEYWORDLESS (sem palavra-chave,",
        "  a partir do site/landing pages) e AI_MAX_BROAD_MATCH (expansão da palavra-chave) —, mais um resumo",
        "  por origem comparando com os termos das palavras-chave do anunciante.",
        "view='combinations': termo × landing page × títulos que o AI Max montou",
        "  (ai_max_search_term_ad_combination_view). Título que não conversa com o termo = falta asset.",
        "view='landing_pages': URLs finais do tráfego em campanhas com AI Max, separando as definidas pelo",
        "  anunciante (ADVERTISER) das escolhidas automaticamente pela expansão de URL (AUTOMATIC).",
        "",
        "ATENÇÃO: as views se sobrepõem — nunca some métricas entre elas. Termos de baixo volume ficam fora",
        "por privacidade, então os totais ficam abaixo do total da campanha.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Filtra por campanha."),
        view: z.enum(["search_terms", "combinations", "landing_pages"]).optional().describe("Default: search_terms."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        limit: z.number().optional().describe("Máx. de linhas listadas (o resumo considera todas). Default: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, view, dateRange, days, limit, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const maxRows = Math.max(1, Math.min(Math.floor(limit ?? 50), 10000));
      const mode = view ?? "search_terms";
      const caveat = "Não some métricas entre as views do AI Max (elas se sobrepõem). Termos de baixo volume ficam fora por privacidade.";
      const render = (rows: Array<Record<string, unknown>>, header: string, extra: Record<string, unknown>) => {
        if (format === "table") return { content: [text(formatAsTable(rows))] };
        if (format === "csv") return { content: [text(formatAsCsv(rows))] };
        return { content: [text(`${header}\n${caveat}\n\n${formatJson({ ...extra, rows })}`)] };
      };

      if (mode === "combinations") {
        // campaign e ad_group são recursos atribuídos desta view: podem ir no WHERE sem estar no SELECT
        const results = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
                  ai_max_search_term_ad_combination_view.search_term,
                  ai_max_search_term_ad_combination_view.landing_page,
                  ai_max_search_term_ad_combination_view.headline,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM ai_max_search_term_ad_combination_view
           WHERE ${dateClause}
             ${campaignId ? `AND campaign.id = ${campaignId}` : ""}
           ORDER BY metrics.cost_micros DESC
           LIMIT ${maxRows}`);
        const rows = results.map((r) => {
          const combo = (r.aiMaxSearchTermAdCombinationView ?? {}) as Record<string, unknown>;
          return {
            campaign: (r.campaign as Record<string, unknown> | undefined)?.name,
            ad_group: (r.adGroup as Record<string, unknown> | undefined)?.name,
            search_term: combo.searchTerm,
            landing_page: combo.landingPage,
            headline: combo.headline,
            ...metricsView(addMetrics(emptyTotals(), r.metrics as Record<string, unknown>)),
          };
        });
        return render(rows, `${rows.length} combinação(ões) termo × landing page × título do AI Max.`, {});
      }

      if (mode === "landing_pages") {
        // campaign é recurso de SEGMENTAÇÃO em expanded_landing_page_view: todo campo dele
        // usado no WHERE também está no SELECT
        const campaignFilter = campaignId
          ? `AND campaign.id = ${campaignId}`
          : "AND campaign.ai_max_setting.enable_ai_max = TRUE";
        const results = await client.searchStream(customerId,
          `SELECT campaign.id, campaign.name, campaign.ai_max_setting.enable_ai_max,
                  expanded_landing_page_view.expanded_final_url,
                  segments.landing_page_source,
                  metrics.impressions, metrics.clicks, metrics.cost_micros,
                  metrics.conversions, metrics.conversions_value
           FROM expanded_landing_page_view
           WHERE ${dateClause}
             ${campaignFilter}`);
        const bySource = new Map<string, MetricTotals>();
        const rows = results.map((r) => {
          const source = String((r.segments as Record<string, unknown> | undefined)?.landingPageSource ?? "UNKNOWN");
          bySource.set(source, addMetrics(bySource.get(source) ?? emptyTotals(), r.metrics as Record<string, unknown>));
          return {
            campaign: (r.campaign as Record<string, unknown> | undefined)?.name,
            final_url: (r.expandedLandingPageView as Record<string, unknown> | undefined)?.expandedFinalUrl,
            source,
            costMicros: num((r.metrics as Record<string, unknown> | undefined)?.costMicros),
            ...metricsView(addMetrics(emptyTotals(), r.metrics as Record<string, unknown>)),
          };
        }).sort((a, b) => b.costMicros - a.costMicros).slice(0, maxRows).map(({ costMicros: _cost, ...row }) => row);
        const summary = Object.fromEntries([...bySource.entries()].map(([source, totals]) => [source, metricsView(totals)]));
        return render(
          rows,
          `${rows.length} URL(s) final(is). AUTOMATIC = escolhida pela expansão de URL do AI Max; ADVERTISER = definida por você.`,
          { summary_by_source: summary }
        );
      }

      // search_terms: uma consulta cobre as linhas e o resumo por origem
      const results = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, ad_group.name,
                search_term_view.search_term, segments.search_term_match_source,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM search_term_view
         WHERE ${dateClause}
           ${campaignId ? `AND campaign.id = ${campaignId}` : ""}
           AND metrics.impressions > 0`);
      const bySource = new Map<string, MetricTotals>();
      const aiMaxRows: Array<Record<string, unknown> & { costMicros: number }> = [];
      for (const r of results) {
        const source = String((r.segments as Record<string, unknown> | undefined)?.searchTermMatchSource ?? "UNKNOWN");
        const metrics = r.metrics as Record<string, unknown> | undefined;
        bySource.set(source, addMetrics(bySource.get(source) ?? emptyTotals(), metrics));
        if (!AI_MAX_MATCH_SOURCES.includes(source)) continue;
        aiMaxRows.push({
          campaign: (r.campaign as Record<string, unknown> | undefined)?.name,
          ad_group: (r.adGroup as Record<string, unknown> | undefined)?.name,
          search_term: (r.searchTermView as Record<string, unknown> | undefined)?.searchTerm,
          match_source: source,
          costMicros: num(metrics?.costMicros),
          ...metricsView(addMetrics(emptyTotals(), metrics)),
        });
      }
      const rows = aiMaxRows
        .sort((a, b) => b.costMicros - a.costMicros)
        .slice(0, maxRows)
        .map(({ costMicros: _cost, ...row }) => row);
      const summary = Object.fromEntries([...bySource.entries()].map(([source, totals]) => [source, metricsView(totals)]));
      const aiMaxTotal = AI_MAX_MATCH_SOURCES.reduce(
        (totals, source) => {
          const part = bySource.get(source);
          if (!part) return totals;
          totals.impressions += part.impressions;
          totals.clicks += part.clicks;
          totals.costMicros += part.costMicros;
          totals.conversions += part.conversions;
          totals.conversionsValue += part.conversionsValue;
          return totals;
        },
        emptyTotals()
      );
      const allTotal = [...bySource.values()].reduce((totals, part) => {
        totals.costMicros += part.costMicros;
        return totals;
      }, emptyTotals());
      const aiMaxShare = allTotal.costMicros ? round2((aiMaxTotal.costMicros / allTotal.costMicros) * 100) : 0;
      return render(
        rows,
        `${aiMaxRows.length} termo(s) vindos do AI Max (${rows.length} listado(s)). ` +
          `AI Max = ${aiMaxShare}% do gasto dos termos reportados no período.`,
        { summary_by_source: summary, ai_max_total: metricsView(aiMaxTotal) }
      );
    }
  );

  mcp.registerTool(
    "create_pmax_campaign",
    {
      description: [
        "Create a complete Performance Max campaign with budget, asset group, and all assets.",
        "WRITE OPERATION — creates a real PMax campaign in the account.",
        "Campaign is created PAUSED by default for safety.",
        "",
        "Uses atomic batch mutate (googleAds:mutate) to avoid race conditions with Brand Guidelines.",
        "",
        "IMPORTANT — Brand Guidelines (auto-enabled in API v23):",
        "- Business name + logo are linked as CAMPAIGN-level assets (not asset group)",
        "- Asset group inherits BN/logo from campaign — do NOT pass them in asset group",
        "",
        "PMax requires at minimum:",
        "- 3+ headlines (max 30 chars each)",
        "- 2+ long headlines (max 90 chars each)",
        "- 1+ description (max 90 chars each)",
        "- 1+ marketing image asset (landscape 1200x628)",
        "- 1+ square marketing image asset (1200x1200)",
        "- 1+ logo asset (square, for Brand Guidelines)",
        "- Final URL",
        "",
        "Pass image/logo resource names from upload_image_asset or get_image_assets.",
        "For e-commerce: pass merchantId to link the Merchant Center feed.",
        "Use feedLabel (e.g. 'BR') instead of salesCountry (deprecated in v23).",
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
        businessNameAsset: z.string().describe("Resource name of existing business name TEXT asset (from get_image_assets or run_gaql). Must already exist in the account."),
        marketingImageAssets: flexArray(z.string()).describe("Resource names of landscape images."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Resource names of square images."),
        logoAssets: flexArray(z.string()).describe("Resource names of logo images (square). First one is used for Brand Guidelines campaign-level."),
        videoAssets: flexArray(z.string()).optional().describe("Resource names of video assets (optional)."),
        merchantId: z.string().optional().describe("Merchant Center ID for e-commerce."),
        feedLabel: z.string().optional().describe("Feed label (e.g. 'BR'). Default: 'BR'. Replaces deprecated salesCountry."),
        audienceResourceName: z.string().optional().describe("Audience resource name for audience signal (from list_audience_segments or list_remarketing_lists)."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy, targetRoas, assetGroupName, finalUrl, headlines, longHeadlines, descriptions, businessNameAsset, marketingImageAssets, squareMarketingImageAssets, logoAssets, videoAssets, merchantId, feedLabel, audienceResourceName }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Step 1: Create text assets for headlines, long headlines, descriptions
      const textAssetOps: Array<Record<string, unknown>> = [];
      for (const h of ensureArray<string>(headlines)) {
        textAssetOps.push({ create: { type: "TEXT", textAsset: { text: h } } });
      }
      for (const lh of ensureArray<string>(longHeadlines)) {
        textAssetOps.push({ create: { type: "TEXT", textAsset: { text: lh } } });
      }
      for (const d of ensureArray<string>(descriptions)) {
        textAssetOps.push({ create: { type: "TEXT", textAsset: { text: d } } });
      }

      const textAssetResult = await client.mutateAssets(customerId, textAssetOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      const textResults = (textAssetResult as Record<string, unknown>).results as Array<Record<string, unknown>>;
      if (!textResults || textResults.length === 0) {
        return { content: [text("Error: failed to create text assets.")], isError: true };
      }

      // Step 2: Atomic batch — budget + campaign + campaign assets + asset group + asset group assets + listing group
      const budgetTmp = `customers/${cid}/campaignBudgets/-1`;
      const campTmp = `customers/${cid}/campaigns/-2`;
      const agTmp = `customers/${cid}/assetGroups/-3`;

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSION_VALUE";
      const campaignCreate: Record<string, unknown> = {
        resourceName: campTmp,
        name,
        status: "PAUSED",
        advertisingChannelType: "PERFORMANCE_MAX",
        campaignBudget: budgetTmp,
        containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
      };
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
        campaignCreate.maximizeConversionValue = targetRoas ? { targetRoas } : {};
      } else {
        campaignCreate.maximizeConversions = {};
      }
      if (merchantId) {
        campaignCreate.shoppingSetting = { merchantId: String(merchantId), feedLabel: feedLabel ?? "BR" };
      }

      const hlArr = ensureArray<string>(headlines);
      const lhArr = ensureArray<string>(longHeadlines);
      const descArr = ensureArray<string>(descriptions);
      const mktImgs = ensureArray<string>(marketingImageAssets);
      const sqImgs = ensureArray<string>(squareMarketingImageAssets);
      const logos = ensureArray<string>(logoAssets);
      const videos = videoAssets ? ensureArray<string>(videoAssets) : [];

      const ops: Array<Record<string, unknown>> = [
        // Budget
        { campaignBudgetOperation: { create: { resourceName: budgetTmp, name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } } },
        // Campaign
        { campaignOperation: { create: campaignCreate } },
        // Campaign Assets (Brand Guidelines) — BN + first logo
        { campaignAssetOperation: { create: { campaign: campTmp, asset: businessNameAsset, fieldType: "BUSINESS_NAME" } } },
        { campaignAssetOperation: { create: { campaign: campTmp, asset: logos[0], fieldType: "LOGO" } } },
        // Asset Group
        { assetGroupOperation: { create: { resourceName: agTmp, name: assetGroupName, campaign: campTmp, status: "PAUSED", finalUrls: [finalUrl] } } },
      ];

      // Asset Group Assets — text (NO BN/LOGO — inherited from campaign via Brand Guidelines)
      let idx = 0;
      for (let i = 0; i < hlArr.length; i++) {
        ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: textResults[idx++]?.resourceName, fieldType: "HEADLINE" } } });
      }
      for (let i = 0; i < lhArr.length; i++) {
        ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: textResults[idx++]?.resourceName, fieldType: "LONG_HEADLINE" } } });
      }
      for (let i = 0; i < descArr.length; i++) {
        ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: textResults[idx++]?.resourceName, fieldType: "DESCRIPTION" } } });
      }
      // Images (in asset group)
      for (const img of mktImgs) { ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: img, fieldType: "MARKETING_IMAGE" } } }); }
      for (const img of sqImgs) { ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: img, fieldType: "SQUARE_MARKETING_IMAGE" } } }); }
      // Videos
      for (const vid of videos) { ops.push({ assetGroupAssetOperation: { create: { assetGroup: agTmp, asset: vid, fieldType: "YOUTUBE_VIDEO" } } }); }
      // Listing group only for Shopping/Merchant campaigns (not required for non-shopping PMax)
      // Created separately after batch to avoid caseValue issues
      // Location + Language
      ops.push({ campaignCriterionOperation: { create: { campaign: campTmp, location: { geoTargetConstant: "geoTargetConstants/2076" }, negative: false } } });
      ops.push({ campaignCriterionOperation: { create: { campaign: campTmp, language: { languageConstant: "languageConstants/1014" } } } });

      // Execute atomic batch
      const batchResult = await client.batchMutate(customerId, ops);
      const responses = (batchResult as Record<string, unknown>).mutateOperationResponses as Array<Record<string, unknown>> | undefined;
      if (!responses) {
        return { content: [text("Error: batch mutate failed.\n" + formatJson(batchResult))], isError: true };
      }

      const campaignResourceName = (responses.find(r => (r as Record<string, unknown>).campaignResult) as Record<string, unknown> | undefined)?.campaignResult as Record<string, unknown> | undefined;
      const assetGroupResourceName = (responses.find(r => (r as Record<string, unknown>).assetGroupResult) as Record<string, unknown> | undefined)?.assetGroupResult as Record<string, unknown> | undefined;

      // Step 3: Listing group filter (separate call for Shopping PMax — requires real resource names)
      if (merchantId && assetGroupResourceName?.resourceName) {
        try {
          await client.mutateAssetGroupListingGroupFilters(customerId, [
            { create: { assetGroup: assetGroupResourceName.resourceName as string, type: "UNIT_INCLUDED", listingSource: "SHOPPING" } },
          ] as unknown as import("./google-ads-client.js").MutateOperation[]);
        } catch {
          // Non-fatal: listing group can be added manually
        }
      }

      // Step 4: Audience signal (optional, separate call — not supported in batch with temp resource names)
      let audienceInfo = "";
      if (audienceResourceName) {
        try {
          await client.mutateAssetGroupSignals(customerId, [
            { create: { assetGroup: assetGroupResourceName?.resourceName as string, audience: { audience: audienceResourceName } } },
          ]);
          audienceInfo = `\n- Audience Signal: ${audienceResourceName}`;
        } catch (e) {
          audienceInfo = `\n- Audience Signal: FAILED (${(e as Error).message.substring(0, 80)})`;
        }
      }

      return {
        content: [
          text(
            `PMax campaign created (PAUSED):\n` +
              `- Name: ${name}\n` +
              `- Budget: R$ ${(dailyBudgetMicros / 1_000_000).toFixed(2)}/day\n` +
              `- Bidding: ${strategy}${targetRoas ? ` (target ROAS: ${targetRoas}x)` : ""}\n` +
              `- Asset Group: ${assetGroupName}\n` +
              `  - ${hlArr.length} headlines, ${lhArr.length} long headlines, ${descArr.length} descriptions\n` +
              `  - ${mktImgs.length} landscape, ${sqImgs.length} square, ${logos.length} logos\n` +
              `  - ${videos.length} videos\n` +
              `  - BN + Logo via Brand Guidelines (campaign level)\n` +
              `${merchantId ? `- Merchant Center: ${merchantId} (feed: ${feedLabel ?? "BR"})\n` : ""}` +
              `- Campaign: ${campaignResourceName?.resourceName}\n` +
              `- Asset Group: ${assetGroupResourceName?.resourceName}` +
              audienceInfo +
              `\n\nUse update_campaign to ENABLE when ready.`
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
        "Each asset group needs headlines, descriptions, and images.",
        "",
        "IMPORTANT — Brand Guidelines (API v23):",
        "- Do NOT include business name or logo in the asset group — they are inherited from campaign-level assets.",
        "- Only pass headlines, long headlines, descriptions, and images.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID of existing PMax campaign."),
        name: z.string().describe("Asset group name."),
        finalUrl: z.string().describe("Final URL."),
        headlines: flexArray(z.string()).describe("3-5 headlines (max 30 chars)."),
        longHeadlines: flexArray(z.string()).describe("1-5 long headlines (max 90 chars)."),
        descriptions: flexArray(z.string()).describe("1-5 descriptions (max 90 chars)."),
        marketingImageAssets: flexArray(z.string()).describe("Resource names of landscape images."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Resource names of square images."),
        videoAssets: flexArray(z.string()).optional().describe("Resource names of videos (optional)."),
      },
    },
    async ({ customerId, campaignId, name, finalUrl, headlines, longHeadlines, descriptions, marketingImageAssets, squareMarketingImageAssets, videoAssets }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const campaignResource = `customers/${cid}/campaigns/${campaignId}`;

      const hlArr = ensureArray<string>(headlines);
      const lhArr = ensureArray<string>(longHeadlines);
      const descArr = ensureArray<string>(descriptions);
      const mktImgs = ensureArray<string>(marketingImageAssets);
      const sqImgs = ensureArray<string>(squareMarketingImageAssets);
      const videos = videoAssets ? ensureArray<string>(videoAssets) : [];

      // Create text assets
      const textOps = [
        ...hlArr.map(h => ({ create: { type: "TEXT", textAsset: { text: h } } })),
        ...lhArr.map(lh => ({ create: { type: "TEXT", textAsset: { text: lh } } })),
        ...descArr.map(d => ({ create: { type: "TEXT", textAsset: { text: d } } })),
      ];

      const textResult = await client.mutateAssets(customerId, textOps as unknown as import("./google-ads-client.js").MutateOperation[]);
      const textResults = (textResult as Record<string, unknown>).results as Array<Record<string, unknown>>;

      // Create asset group
      const agResult = await client.mutateAssetGroups(customerId, [
        { create: { name, campaign: campaignResource, status: "PAUSED", finalUrls: [finalUrl] } },
      ]);
      const agResource = ((agResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      if (!agResource) return { content: [text("Error: failed to create asset group.")], isError: true };

      // Link assets — NO BN/LOGO (inherited from campaign via Brand Guidelines)
      const linkOps: Array<Record<string, unknown>> = [];
      let idx = 0;
      for (let i = 0; i < hlArr.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "HEADLINE" } }); }
      for (let i = 0; i < lhArr.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "LONG_HEADLINE" } }); }
      for (let i = 0; i < descArr.length; i++) { linkOps.push({ create: { assetGroup: agResource, asset: textResults[idx++]?.resourceName, fieldType: "DESCRIPTION" } }); }
      for (const r of mktImgs) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "MARKETING_IMAGE" } }); }
      for (const r of sqImgs) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "SQUARE_MARKETING_IMAGE" } }); }
      if (videos.length > 0) { for (const r of videos) { linkOps.push({ create: { assetGroup: agResource, asset: r, fieldType: "YOUTUBE_VIDEO" } }); } }

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      // Valida ANTES de criar o orçamento: TARGET_CPA sem targetCpaMicros não casaria
      // com nenhum ramo, a campanha subiria sem estratégia de lance, a API rejeitaria
      // e o budget já criado ficaria órfão na conta.
      if (strategy === "TARGET_CPA" && !targetCpaMicros) {
        return { content: [text("TARGET_CPA exige targetCpaMicros (ex: 50000000 = R$50 por conversão).")], isError: true };
      }

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "DISPLAY", campaignBudget: budgetResource, containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        networkSettings: { targetContentNetwork: true, targetGoogleSearch: false, targetSearchNetwork: false },
      };
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = {};
      else if (strategy === "TARGET_CPA") campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      else if (strategy === "MANUAL_CPC") campaignData.manualCpc = {}; // sem Enhanced CPC (descontinuado)
      // else final: MAXIMIZE_CONVERSIONS (default) e qualquer valor novo do enum —
      // garante que campaignData nunca sai sem estratégia de lance.
      else campaignData.maximizeConversions = {};

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
        "Create a Video (YouTube) campaign — NÃO SUPORTADO PELA API: campaigns:mutate recusa campanhas VIDEO novas",
        "('Mutates are not allowed for the requested resource'). A tool retorna erro explicativo sem tocar na conta.",
        "Para vídeo programático use create_demand_gen_campaign. Em campanha de vídeo criada no Google Ads,",
        "só create_video_ad (anúncio em ad group VIDEO_RESPONSIVE existente) é aceito pela API.",
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
        targetCpaMicros: z.number().optional().describe("Alvo de CPA em MICROS (ex: 50000000 = R$50). Obrigatório com TARGET_CPA."),
      },
    },
    async ({ customerId, name, dailyBudgetMicros, biddingStrategy, targetCpaMicros }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      // A API do Google Ads não cria campanhas de VIDEO novas: campaigns:mutate responde
      // "Mutates are not allowed for the requested resource" em todas as variantes
      // (com/sem networkSettings, subtype VIDEO_ACTION). Recusar antes do orçamento
      // evita um budget órfão a cada tentativa.
      return {
        content: [
          text(
            "create_video_campaign: a API do Google Ads não permite criar nem alterar campanhas de vídeo " +
              "(só leitura, e anúncios em ad groups VIDEO_RESPONSIVE já existentes via create_video_ad). " +
              `Para vídeo programático use create_demand_gen_campaign. Nada foi alterado na conta ${customerId}.`,
          ),
        ],
        isError: true,
      };

      // Valida ANTES de criar o orçamento: TARGET_CPA sem alvo subia a campanha sem
      // CPA-alvo nenhum (o ramo virava MAXIMIZE_CONVERSIONS puro) e dizia sucesso.
      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      if (strategy === "TARGET_CPA" && !targetCpaMicros) {
        return { content: [text("TARGET_CPA exige targetCpaMicros (ex: 50000000 = R$50 por conversão).")], isError: true };
      }

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "VIDEO", campaignBudget: budgetResource, containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
      };
      if (strategy === "TARGET_CPA") campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      else if (strategy === "MANUAL_CPV") campaignData.manualCpv = {};
      else campaignData.maximizeConversions = {};

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
        adGroupId: z.string().describe("Ad group ID (tipo VIDEO_RESPONSIVE, em campanha Video action)."),
        youtubeVideoId: z.string().describe("YouTube video ID. Reaproveita o asset se o vídeo já existir na conta; senão cria."),
        finalUrl: z.string().describe("Landing page URL."),
        headline: z.string().optional().describe("Headline (max 15 chars). Obrigatório na prática: a API rejeita o anúncio sem ele."),
        description: z.string().optional().describe("Description (max 70 chars). Obrigatório na prática."),
        callToAction: z.string().optional().describe("CTA text (e.g. 'Saiba mais', 'Comprar agora'). Max 10 chars. Obrigatório na prática."),
        logoAssetId: z.string().optional().describe("ID de um asset IMAGE quadrado (1:1, ex.: 1200x1200) já na conta, usado como logo — a API exige ao menos um. Ache com get_image_assets."),
        businessName: z.string().optional().describe("Nome da marca/anunciante exibido no anúncio (max 25 chars). Obrigatório na prática: a API exige business_name no responsive video ad."),
        longHeadline: z.string().optional().describe("Long headline (max 90 chars). Default: reutiliza headline."),
      },
    },
    async ({ customerId, adGroupId, youtubeVideoId, finalUrl, headline, description, callToAction, logoAssetId, businessName, longHeadline }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // VideoResponsiveAdInfo (v25) só tem coleções — videos[], headlines[],
      // longHeadlines[], descriptions[], callToActions[], logoImages[] — e a API
      // exige ao menos um item em cada, além de ad.name. O schema mantém os
      // campos opcionais para não mudar o contrato; a exigência fica explícita aqui.
      const faltando = [!headline && "headline", !description && "description", !callToAction && "callToAction", !logoAssetId && "logoAssetId", !businessName && "businessName"].filter(Boolean);
      if (faltando.length > 0) {
        return { content: [text(`Video responsive ad exige ${faltando.join(", ")} (a API rejeita o anúncio sem eles).`)], isError: true };
      }

      // videos[].asset é um resource name de asset YOUTUBE_VIDEO — a API não aceita
      // o id do YouTube direto. Reaproveita o asset se o vídeo já existir na conta;
      // senão cria. Sem id temporário em campo aninhado, cujo suporte não é
      // documentado.
      const found = await client.searchStream(customerId,
        `SELECT asset.resource_name FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '${gaqlLiteral(youtubeVideoId)}' LIMIT 1`);
      let videoAsset = (found[0]?.asset as Record<string, unknown> | undefined)?.resourceName as string | undefined;
      if (!videoAsset) {
        const assetResult = await client.mutateAssets(customerId, [{ create: { type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId } } }]);
        videoAsset = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string | undefined;
      }
      if (!videoAsset) {
        return { content: [text(`Error: não foi possível obter o asset do vídeo ${youtubeVideoId}.`)], isError: true };
      }

      const videoAdInfo: Record<string, unknown> = {
        videos: [{ asset: videoAsset }],
        headlines: [{ text: headline }],
        longHeadlines: [{ text: longHeadline ?? headline }],
        descriptions: [{ text: description }],
        callToActions: [{ text: callToAction }],
        // A API exige ao menos um logo (asset IMAGE 1:1) no responsive video ad.
        logoImages: [{ asset: `customers/${cid}/assets/${logoAssetId}` }],
        // business_name é Required na v25 (nome da marca, max 25 chars) — sem ele a
        // API devolve REQUIRED no nível do video_responsive_ad, sem apontar o campo.
        businessName: { text: businessName },
      };

      const adData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: {
          // ad.name é obrigatório para responsive video ad.
          name: `Video ${youtubeVideoId} — ${headline}`,
          finalUrls: [finalUrl],
          videoResponsiveAd: videoAdInfo,
        },
      };

      const result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      return { content: [text(`Video ad created (PAUSED) with video ${youtubeVideoId} (asset ${videoAsset}).\n\n${formatJson(result)}`)] };
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
        feedLabel: z.string().optional().describe("Feed label (default: BR). Replaces deprecated salesCountry in API v23."),
        biddingStrategy: z.enum(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "MANUAL_CPC", "TARGET_ROAS"]).optional()
          .describe("Default: MAXIMIZE_CONVERSION_VALUE."),
        targetRoas: z.number().optional().describe("Target ROAS."),
        campaignPriority: z.number().optional().describe("Priority: 0 (low), 1 (medium), 2 (high). Default: 0."),
      },
    },
    async ({ customerId, name, merchantId, dailyBudgetMicros, feedLabel, biddingStrategy, targetRoas, campaignPriority }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSION_VALUE";
      // Valida ANTES de criar o orçamento: TARGET_ROAS sem targetRoas não casaria
      // com nenhum ramo, a campanha subiria sem estratégia de lance, a API rejeitaria
      // e o budget já criado ficaria órfão na conta.
      if (strategy === "TARGET_ROAS" && !targetRoas) {
        return { content: [text("TARGET_ROAS exige targetRoas (ex: 5.0 = 500%).")], isError: true };
      }

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "SHOPPING", campaignBudget: budgetResource, containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
        shoppingSetting: {
          merchantId: String(merchantId),
          feedLabel: feedLabel ?? "BR",
          campaignPriority: campaignPriority ?? 0,
        },
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
      };
      if (strategy === "MAXIMIZE_CONVERSIONS") campaignData.maximizeConversions = {};
      else if (strategy === "MANUAL_CPC") campaignData.manualCpc = {}; // sem Enhanced CPC (descontinuado)
      else if (strategy === "TARGET_ROAS") campaignData.maximizeConversionValue = { targetRoas };
      // else final: MAXIMIZE_CONVERSION_VALUE (default) e qualquer valor novo do enum —
      // garante que campaignData nunca sai sem estratégia de lance.
      else campaignData.maximizeConversionValue = targetRoas ? { targetRoas } : {};

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const strategy = biddingStrategy ?? "MAXIMIZE_CONVERSIONS";
      // Valida ANTES de criar o orçamento: TARGET_CPA sem targetCpaMicros não casaria
      // com nenhum ramo, a campanha subiria sem estratégia de lance, a API rejeitaria
      // e o budget já criado ficaria órfão na conta.
      if (strategy === "TARGET_CPA" && !targetCpaMicros) {
        return { content: [text("TARGET_CPA exige targetCpaMicros (ex: 50000000 = R$50 por conversão).")], isError: true };
      }

      const budgetResult = await client.mutateCampaignBudgets(customerId, [
        { create: { name: `Budget — ${name}`, amountMicros: String(dailyBudgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false } },
      ]);
      const budgetResource = ((budgetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;

      const campaignData: Record<string, unknown> = {
        name, status: "PAUSED", advertisingChannelType: "DEMAND_GEN", campaignBudget: budgetResource, containsEuPoliticalAdvertising: EU_POLITICAL_DECLARATION,
      };
      if (strategy === "MAXIMIZE_CONVERSION_VALUE") campaignData.maximizeConversionValue = {};
      else if (strategy === "TARGET_CPA") campaignData.maximizeConversions = { targetCpaMicros: String(targetCpaMicros) };
      // else final: MAXIMIZE_CONVERSIONS (default) e qualquer valor novo do enum —
      // garante que campaignData nunca sai sem estratégia de lance.
      else campaignData.maximizeConversions = targetCpaMicros ? { targetCpaMicros: String(targetCpaMicros) } : {};

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const nameFilter = query ? `AND audience.name LIKE '%${gaqlLiteral(query)}%'` : "";

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
        "Adiciona UM posicionamento — site, canal ou vídeo do YouTube, app ou categoria de app. WRITE OPERATION.",
        "- Grupo de anúncios (level AD_GROUP, padrão; adGroupId): segmentação (padrão) ou exclusão (negative: true).",
        "- Campanha (level CAMPAIGN; campaignId): SÓ exclusão — exige negative: true. A API não aceita posicionamento",
        "  positivo na campanha (a segmentação por posicionamento é por grupo); sem negative: true a tool recusa antes",
        "  de chamar a API. Para excluir vários ou na conta inteira: exclude_placements.",
        "",
        "type: WEBSITE, YOUTUBE_CHANNEL, YOUTUBE_VIDEO, MOBILE_APP, MOBILE_APP_CATEGORY. Sem type a tool detecta:",
        "youtube.com/channel/UC… vira YOUTUBE_CHANNEL e watch?v= / youtu.be / shorts vira YOUTUBE_VIDEO (a API",
        "recusa URL do YouTube como site: YOUTUBE_URL_UNSUPPORTED). @handle é recusado — a API não resolve handle;",
        "informe o channel ID (UC…, 24 caracteres). App: 1-<ID da App Store> ou 2-<pacote Android>, ou a URL da loja.",
        "",
        "Positivo só no grupo e só em Display, Vídeo e Demand Gen (Pesquisa recusa; PMax não aceita posicionamento — use",
        "exclude_placements level ACCOUNT). Confere que o grupo/campanha existe nesta conta; se o posicionamento já",
        "existe igual, nada é gravado; se existe com a polaridade oposta, recusa e indica o resource name para remover.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().optional().describe("Ad group ID (obrigatório com level AD_GROUP, o padrão)."),
        campaignId: z.string().optional().describe("Campaign ID (obrigatório com level CAMPAIGN)."),
        level: z.enum(["AD_GROUP", "CAMPAIGN"]).optional()
          .describe("AD_GROUP (segmentar ou excluir) ou CAMPAIGN (só excluir: negative true). Sem level: AD_GROUP; CAMPAIGN se só campaignId vier."),
        type: z.enum(["WEBSITE", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APP", "MOBILE_APP_CATEGORY"]).optional()
          .describe("Tipo do posicionamento. Sem ele, detecta pelo valor."),
        value: z.string().optional().describe("Domínio/URL, channel ID (UC…) ou URL /channel/, video ID ou URL, app ID, ID da categoria."),
        url: z.string().optional().describe("Nome antigo de value (compatibilidade). Ex.: 'exemplo.com.br'."),
        negative: z.boolean().optional()
          .describe("true = excluir em vez de segmentar (obrigatório na campanha). Default: false (segmentar, só no grupo)."),
      },
    },
    async (args) => {
      const blocked = checkCustomerAccess(args.customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // lógica e parser compartilhados com exclude_placements (lote placements-brand-safety)
      const { addPlacementTool } = await import("./tools/placements-brand-safety.js");
      return addPlacementTool(getClient, args);
    }
  );

  // list_extensions, create_sitelink_extension e create_callout_extension: src/tools/extensions.ts

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi removido.`)], isError: true };
      }
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Lê antes de remover: confirma que a campanha é desta conta, mostra o que sai e não
      // reenvia remoção de campanha já removida.
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type
         FROM campaign
         WHERE campaign.id = ${campaignId}`);
      const campaign = rows[0]?.campaign as Record<string, unknown> | undefined;
      if (!campaign) {
        return { content: [text(`Campanha ${campaignId} não encontrada na conta ${cid}. Nada foi removido.`)], isError: true };
      }
      const label = `Campanha ${campaignId} ("${campaign.name}", ${campaign.advertisingChannelType})`;
      if (campaign.status === "REMOVED") {
        return { content: [text(`${label} já está removida. Nenhuma escrita foi enviada.`)] };
      }
      let result: Record<string, unknown>;
      try {
        result = await client.mutateCampaigns(customerId, [{ remove: `customers/${cid}/campaigns/${campaignId}` }]);
      } catch (err) {
        return { content: [text(`${label}: a API recusou a remoção. Nada foi removido.\nErro: ${(err as Error).message}`)], isError: true };
      }
      if (client.isDryRun) {
        return { content: [text(`${label} — DRY-RUN (validateOnly): remoção validada, nada foi removido (status segue ${campaign.status}).`)] };
      }
      return {
        content: [text(`${label} REMOVED (status antes: ${campaign.status}). Não dá para desfazer pela API.\n\n${formatJson(result)}`)],
      };
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(adGroupId)) {
        return { content: [text(`adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi removido.`)], isError: true };
      }
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const rows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const adGroup = rows[0]?.adGroup as Record<string, unknown> | undefined;
      if (!adGroup) {
        return { content: [text(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi removido.`)], isError: true };
      }
      const campaign = (rows[0]?.campaign ?? {}) as Record<string, unknown>;
      const label = `Grupo ${adGroupId} ("${adGroup.name}", campanha ${campaign.id} "${campaign.name}")`;
      if (adGroup.status === "REMOVED") {
        return { content: [text(`${label} já está removido. Nenhuma escrita foi enviada.`)] };
      }
      let result: Record<string, unknown>;
      try {
        result = await client.mutateAdGroups(customerId, [{ remove: `customers/${cid}/adGroups/${adGroupId}` }]);
      } catch (err) {
        return { content: [text(`${label}: a API recusou a remoção. Nada foi removido.\nErro: ${(err as Error).message}`)], isError: true };
      }
      if (client.isDryRun) {
        return { content: [text(`${label} — DRY-RUN (validateOnly): remoção validada, nada foi removido (status segue ${adGroup.status}).`)] };
      }
      return { content: [text(`${label} REMOVED (status antes: ${adGroup.status}).\n\n${formatJson(result)}`)] };
    }
  );

  // delete_ad: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ══════════════════════════════════════════════════════════════════
  // ══ BID ADJUSTMENTS + AD SCHEDULE + CONVERSION ACTIONS ════════════
  // ══════════════════════════════════════════════════════════════════

  // set_device_bid_adjustment: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  // set_ad_schedule: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  mcp.registerTool(
    "create_conversion_action",
    {
      description: [
        "Create a conversion action for tracking.",
        "WRITE OPERATION.",
        "",
        "Types (aceita apelidos, traduzidos para o enum real da API):",
        "- WEBPAGE: conversões no site (requer Google tag)",
        "- UPLOAD (= UPLOAD_CLICKS): importação de conversões offline por gclid",
        "- UPLOAD_CALLS: importação de chamadas offline",
        "- PHONE_CALL (= WEBSITE_CALL): chamadas para o número exibido no site",
        "- AD_CALL: chamadas a partir do recurso de chamada do anúncio",
        "- CLICK_TO_CALL: cliques em telefone no site mobile",
        "",
        "Categorias (API atual): " + CONVERSION_CATEGORIES.join(", ") + ".",
        "Apelidos aceitos: LEAD → SUBMIT_LEAD_FORM, SIGN_UP → SIGNUP.",
        "",
        "Attribution model: DATA_DRIVEN (padrao do Google) ou LAST_CLICK. Os modelos baseados",
        "em regras (first click, linear, time decay, position based) foram desligados em 2023.",
        "Counting: ONE_PER_CLICK (leads) ou MANY_PER_CLICK (compras).",
        "",
        "O tipo é IMUTÁVEL depois de criado — use update_conversion_action para o resto.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Conversion action name (e.g. 'Purchase', 'Lead Form Submit')."),
        type: conversionTypeSchema.describe("Conversion type. IMUTÁVEL após a criação."),
        category: conversionCategorySchema.describe("Conversion category."),
        countingType: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional().describe("How to count. Default: ONE_PER_CLICK."),
        attributionModel: attributionModelSchema.optional().describe("Attribution model. Default: DATA_DRIVEN."),
        valueSetting: z.object({
          defaultValue: z.number().optional().describe("Default conversion value."),
          alwaysUseDefaultValue: z.boolean().optional().describe("True = always use default value. False = use dynamic value from tag."),
        }).optional().describe("Conversion value settings."),
        viewThroughLookbackWindowDays: z.number().optional().describe("View-through lookback window (1-30 days). Default: 1."),
        clickThroughLookbackWindowDays: z.number().optional().describe("Click-through lookback window (1-90 days). Default: 30."),
        primary: z.boolean().optional().describe("True = PRIMARY (used for bidding). False = SECONDARY (observation only). Default: true."),
        includeInConversionsMetric: z.boolean().optional().describe("Inclui esta ação na coluna 'Conversões'. Default: API decide (true)."),
        phoneCallDurationSeconds: z.number().optional().describe("Duração mínima da ligação para contar conversão (apenas tipos de chamada)."),
      },
    },
    async ({ customerId, name, type, category, countingType, attributionModel, valueSetting, viewThroughLookbackWindowDays, clickThroughLookbackWindowDays, primary, includeInConversionsMetric, phoneCallDurationSeconds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      const apiType = resolveEnumAlias(type, CONVERSION_TYPE_ALIASES);
      const apiCategory = resolveEnumAlias(category, CONVERSION_CATEGORY_ALIASES);
      const apiAttribution = resolveEnumAlias(
        attributionModel ?? "DATA_DRIVEN",
        ATTRIBUTION_MODEL_ALIASES
      );

      const convData: Record<string, unknown> = {
        name,
        type: apiType,
        category: apiCategory,
        countingType: countingType ?? "ONE_PER_CLICK",
        // data_driven_model_status é OUTPUT_ONLY — enviar causa erro na API.
        attributionModelSettings: { attributionModel: apiAttribution },
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
      if (includeInConversionsMetric !== undefined) convData.includeInConversionsMetric = includeInConversionsMetric;
      if (phoneCallDurationSeconds !== undefined) convData.phoneCallDurationSeconds = String(phoneCallDurationSeconds);

      const result = await client.mutateConversionActions(customerId, [{ create: convData }]);

      const translated: string[] = [];
      if (apiType !== type) translated.push(`type ${type} → ${apiType}`);
      if (apiCategory !== category) translated.push(`category ${category} → ${apiCategory}`);
      if (apiAttribution !== (attributionModel ?? "DATA_DRIVEN")) translated.push(`attribution ${attributionModel ?? "DATA_DRIVEN"} → ${apiAttribution}`);

      return { content: [text(
        `Conversion action created: "${name}"\n` +
        `Type: ${apiType} | Category: ${apiCategory} | Counting: ${countingType ?? "ONE_PER_CLICK"}\n` +
        `Attribution: ${apiAttribution} | Primary: ${primary !== false}\n` +
        (translated.length ? `Traduzido para a API: ${translated.join("; ")}\n` : "") +
        `\n${formatJson(result)}`
      )] };
    }
  );

  mcp.registerTool(
    "update_conversion_action",
    {
      description: [
        "Update an existing conversion action.",
        "WRITE OPERATION — só envia os campos informados (updateMask).",
        "",
        "O campo `type` é IMUTÁVEL na API: para trocar o tipo, crie outra ação.",
        "Use list_conversion_actions para descobrir o conversionActionId.",
        "",
        "Status: ENABLED (ativa), REMOVED (excluída), HIDDEN (oculta).",
        "Categorias e modelos de atribuição aceitam os mesmos apelidos de create_conversion_action.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionActionId: z.string().describe("Conversion action ID (de list_conversion_actions)."),
        name: z.string().optional().describe("Novo nome."),
        status: z.enum(["ENABLED", "REMOVED", "HIDDEN"]).optional().describe("Novo status."),
        category: conversionCategorySchema.optional().describe("Nova categoria."),
        countingType: z.enum(["ONE_PER_CLICK", "MANY_PER_CLICK"]).optional().describe("Nova contagem."),
        attributionModel: attributionModelSchema.optional().describe("Novo modelo de atribuição."),
        primary: z.boolean().optional().describe("True = PRIMARY (usada para lances). False = SECONDARY."),
        includeInConversionsMetric: z.boolean().optional().describe("Incluir na coluna 'Conversões'."),
        valueSetting: z.object({
          defaultValue: z.number().optional().describe("Valor padrão da conversão."),
          alwaysUseDefaultValue: z.boolean().optional().describe("True = sempre usar o valor padrão."),
        }).optional().describe("Configuração de valor."),
        viewThroughLookbackWindowDays: z.number().optional().describe("Janela view-through (1-30 dias)."),
        clickThroughLookbackWindowDays: z.number().optional().describe("Janela click-through (1-90 dias)."),
        phoneCallDurationSeconds: z.number().optional().describe("Duração mínima da ligação (tipos de chamada)."),
      },
    },
    async ({ customerId, conversionActionId, name, status, category, countingType, attributionModel, primary, includeInConversionsMetric, valueSetting, viewThroughLookbackWindowDays, clickThroughLookbackWindowDays, phoneCallDurationSeconds }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const updateData: Record<string, unknown> = {
        resourceName: `customers/${cid}/conversionActions/${conversionActionId}`,
      };
      const mask: string[] = [];

      if (name !== undefined) { updateData.name = name; mask.push("name"); }
      if (status !== undefined) { updateData.status = status; mask.push("status"); }
      if (category !== undefined) {
        updateData.category = resolveEnumAlias(category, CONVERSION_CATEGORY_ALIASES);
        mask.push("category");
      }
      if (countingType !== undefined) { updateData.countingType = countingType; mask.push("counting_type"); }
      if (attributionModel !== undefined) {
        updateData.attributionModelSettings = {
          attributionModel: resolveEnumAlias(attributionModel, ATTRIBUTION_MODEL_ALIASES),
        };
        mask.push("attribution_model_settings.attribution_model");
      }
      if (primary !== undefined) { updateData.primaryForGoal = primary; mask.push("primary_for_goal"); }
      if (includeInConversionsMetric !== undefined) {
        updateData.includeInConversionsMetric = includeInConversionsMetric;
        mask.push("include_in_conversions_metric");
      }
      if (valueSetting !== undefined) {
        // Mascarar "value_settings" inteiro zeraria os sub-campos nao informados
        const valueSettings: Record<string, unknown> = {};
        if (valueSetting.defaultValue !== undefined) {
          valueSettings.defaultValue = valueSetting.defaultValue;
          valueSettings.defaultCurrencyCode = await client.getAccountCurrency(customerId);
          mask.push("value_settings.default_value", "value_settings.default_currency_code");
        }
        if (valueSetting.alwaysUseDefaultValue !== undefined) {
          valueSettings.alwaysUseDefaultValue = valueSetting.alwaysUseDefaultValue;
          mask.push("value_settings.always_use_default_value");
        }
        if (Object.keys(valueSettings).length > 0) updateData.valueSettings = valueSettings;
      }
      if (viewThroughLookbackWindowDays !== undefined) {
        updateData.viewThroughLookbackWindowDays = String(viewThroughLookbackWindowDays);
        mask.push("view_through_lookback_window_days");
      }
      if (clickThroughLookbackWindowDays !== undefined) {
        updateData.clickThroughLookbackWindowDays = String(clickThroughLookbackWindowDays);
        mask.push("click_through_lookback_window_days");
      }
      if (phoneCallDurationSeconds !== undefined) {
        updateData.phoneCallDurationSeconds = String(phoneCallDurationSeconds);
        mask.push("phone_call_duration_seconds");
      }

      if (mask.length === 0) {
        return { content: [text("Nada para atualizar: informe ao menos um campo (name, status, category, ...).")], isError: true };
      }

      const result = await client.mutateConversionActions(customerId, [
        { update: updateData, updateMask: mask.join(",") },
      ]);

      return { content: [text(
        `Conversion action ${conversionActionId} atualizada.\nCampos: ${mask.join(", ")}\n\n${formatJson(result)}`
      )] };
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
        "WRITE OPERATION. Substitui a árvore atual numa única requisição atômica.",
        "Todos os filtros precisam usar a MESMA dimensão. 'Todo o resto': se houver",
        "filtro de inclusão, os demais produtos ficam EXCLUÍDOS (só o listado veicula);",
        "se só houver exclusões, os demais ficam incluídos.",
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      // assetGroupId entra cru na GAQL do remove: exigir numérico impede que um valor
      // manipulado amplie o WHERE e apague filtros de outros asset groups.
      if (!/^\d+$/.test(assetGroupId)) {
        return { content: [text("Error: assetGroupId inválido — use apenas o ID numérico do asset group.")], isError: true };
      }
      const agResource = `customers/${cid}/assetGroups/${assetGroupId}`;

      // Valida tudo ANTES de tocar na conta: buildListingGroupCaseValue lança em
      // dimensão desconhecida ou valor inválido, e irmãos sob a mesma SUBDIVISION
      // precisam compartilhar a dimensão. Se isso falhasse depois do remove, a
      // árvore antiga já teria sido apagada.
      if (filters.length === 0) {
        return { content: [text("Error: filters vazio — informe ao menos um filtro.")], isError: true };
      }
      const dimension = filters[0].dimension;
      let caseValues: Array<Record<string, unknown>>;
      let otherCaseValue: Record<string, unknown>;
      try {
        if (filters.some(f => f.dimension !== dimension)) {
          throw new Error(`Todos os filtros precisam usar a mesma dimensão sob uma SUBDIVISION (recebido: ${[...new Set(filters.map(f => f.dimension))].join(", ")}).`);
        }
        caseValues = filters.map(f => buildListingGroupCaseValue(f.dimension, f.value));
        otherCaseValue = buildListingGroupCaseValue(dimension);
      } catch (err) {
        return { content: [text(`Filtro inválido: ${(err as Error).message}`)], isError: true };
      }

      const existing = await client.searchStream(customerId,
        `SELECT asset_group_listing_group_filter.resource_name, asset_group_listing_group_filter.parent_listing_group_filter
         FROM asset_group_listing_group_filter WHERE asset_group.id = ${assetGroupId}`);
      // A API exige remover os filhos antes do pai. Ordena por profundidade (folhas
      // primeiro) a partir de parent_listing_group_filter, como no sample de PMax
      // retail do Google — senão substituir uma árvore já subdividida é recusado.
      const nodes = existing
        .map(r => r.assetGroupListingGroupFilter as Record<string, unknown> | undefined)
        .filter((n): n is Record<string, unknown> => !!n && !!n.resourceName)
        .map(n => ({ name: n.resourceName as string, parent: (n.parentListingGroupFilter as string | undefined) ?? "" }));
      const parentOf = new Map(nodes.map(n => [n.name, n.parent]));
      const depth = (name: string, seen = 0): number => {
        const p = parentOf.get(name);
        return p && seen < 50 ? 1 + depth(p, seen + 1) : 0;
      };
      const removeOps = nodes
        .sort((a, b) => depth(b.name) - depth(a.name))
        .map(n => ({ remove: n.name }));

      // Uma única requisição: a API valida a árvore ao fim de CADA request, então
      // raiz criada sem filhos, ou remove sem a árvore nova, deixariam estado
      // inválido no meio do caminho. A raiz usa id temporário (-1) e os filhos
      // apontam para ele, como nos exemplos de PMax retail do Google.
      const rootTemp = `customers/${cid}/assetGroupListingGroupFilters/${assetGroupId}~-1`;
      // "Everything else": se algum filtro é de inclusão, o resto fica de fora
      // (só o listado veicula); se todos são exclusões, o resto entra.
      const othersType = filters.some(f => f.included !== false) ? "UNIT_EXCLUDED" : "UNIT_INCLUDED";
      const ops: Array<Record<string, unknown>> = [
        ...removeOps,
        { create: { resourceName: rootTemp, assetGroup: agResource, type: "SUBDIVISION", listingSource: "SHOPPING" } },
        ...filters.map((f, i) => ({
          create: { assetGroup: agResource, parentListingGroupFilter: rootTemp, type: f.included === false ? "UNIT_EXCLUDED" : "UNIT_INCLUDED", listingSource: "SHOPPING", caseValue: caseValues[i] },
        })),
        // Mesma dimensão dos irmãos, sem valor. Sem caseValue a API lê o nó como
        // segunda raiz ("Each Listing Group tree must have a single root").
        { create: { assetGroup: agResource, parentListingGroupFilter: rootTemp, type: othersType, listingSource: "SHOPPING", caseValue: otherCaseValue } },
      ];

      const childResult = await client.mutateAssetGroupListingGroupFilters(customerId, ops as unknown as import("./google-ads-client.js").MutateOperation[]);
      return { content: [text(`Listing group filters set for asset group ${assetGroupId}:\n${filters.map(f => `${f.included === false ? "EXCLUDE" : "INCLUDE"} ${f.dimension} = "${f.value}"`).join("\n")}\nTodo o resto: ${othersType === "UNIT_EXCLUDED" ? "EXCLUÍDO (só o listado veicula)" : "INCLUÍDO"}\n\n${formatJson(childResult)}`)] };
    }
  );

  // set_campaign_locations e set_campaign_languages: registradas em src/tools/targeting-geo.ts (lote targeting-geo).

  mcp.registerTool(
    "list_merchant_centers",
    {
      description: [
        "List Merchant Center accounts linked to a Google Ads account.",
        "Uses two methods: merchant_center_link (MCC level) and campaign shopping_setting (account level).",
        "Returns merchant IDs, names, and which campaigns use them.",
      ].join("\n"),
      inputSchema: { customerId: z.string().describe("Customer ID.") },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();

      // Method 1: merchant_center_link (works for MCC-linked accounts)
      let links: Array<Record<string, unknown>> = [];
      try {
        links = await client.searchStream(customerId, `SELECT merchant_center_link.id, merchant_center_link.merchant_center_account_name, merchant_center_link.status FROM merchant_center_link`);
      } catch { /* may not be available */ }

      // Method 2: extract from campaign shopping_setting (always works if Shopping/PMax exists)
      const campaigns = await client.searchStream(customerId,
        `SELECT campaign.name, campaign.status, campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label, campaign.advertising_channel_type
         FROM campaign
         WHERE campaign.shopping_setting.merchant_id > 0`);

      const merchantIds = new Set<string>();
      const campaignsByMerchant: Record<string, Array<{ name: string; type: string; status: string }>> = {};
      for (const c of campaigns) {
        const camp = c.campaign as Record<string, unknown>;
        const setting = camp?.shoppingSetting as Record<string, unknown>;
        const mid = String(setting?.merchantId ?? "");
        if (mid) {
          merchantIds.add(mid);
          if (!campaignsByMerchant[mid]) campaignsByMerchant[mid] = [];
          campaignsByMerchant[mid].push({
            name: camp?.name as string,
            type: camp?.advertisingChannelType as string,
            status: camp?.status as string,
          });
        }
      }

      // Extract feed_label from first campaign with this merchant
      const getFeedLabel = (mid: string): string | undefined => {
        for (const c of campaigns) {
          const setting = (c.campaign as Record<string, unknown>)?.shoppingSetting as Record<string, unknown> | undefined;
          if (String(setting?.merchantId ?? "") === mid && setting?.feedLabel) return setting.feedLabel as string;
        }
        return undefined;
      };

      const result = {
        merchant_center_links: links.length > 0 ? links : "(not available at account level — use campaign method below)",
        merchants_from_campaigns: [...merchantIds].map(mid => ({
          merchant_id: mid,
          feed_label: getFeedLabel(mid),
          campaigns_using: campaignsByMerchant[mid],
        })),
      };

      const total = links.length + merchantIds.size;
      return { content: [text(`${total > 0 ? `${merchantIds.size} merchant(s) found.` : "No Merchant Center linked."}\n\n${formatJson(result)}`)] };
    }
  );

  // ══ P2: BID ADJUSTMENTS + EDIT ADS ════════════════════════════════

  // set_location_bid_adjustment: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  // set_age_bid_adjustment: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  // set_gender_bid_adjustment: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  // update_ad: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ══ P3: EXTENSIONS + LABELS + SHARED LISTS ════════════════════════

  // create_structured_snippet, create_call_extension, create_price_extension e
  // create_promotion_extension: src/tools/extensions.ts

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.status = 'ENABLED'`);
      return { content: [text(`${results.length} label(s).\n\n${formatJson(results)}`)] };
    }
  );

  // create_shared_negative_list: implementada em src/tools/negatives.ts (lote negatives).

  // ══ REMARKETING LISTS ══════════════════════════════════════════════

  mcp.registerTool(
    "list_remarketing_lists",
    {
      description: [
        "List all remarketing/audience lists in the account with size and membership details.",
        "Shows list name, type, size for display/search, membership lifespan, and membership_status (OPEN/CLOSED). Lista todas, inclusive fechadas.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Filter by name (substring match)."),
      },
    },
    async ({ customerId, query }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      // Sem filtro de status: user_list.status não existe na v25, e filtrar por
      // membership_status esconderia listas CLOSED, que são legítimas e reabríveis.
      const nameFilter = query ? `WHERE user_list.name LIKE '%${gaqlLiteral(query)}%'` : "";

      const results = await client.searchStream(customerId,
        `SELECT user_list.id, user_list.name, user_list.type,
                user_list.size_for_display, user_list.size_for_search,
                user_list.membership_life_span, user_list.description,
                user_list.membership_status, user_list.eligible_for_display,
                user_list.eligible_for_search
         FROM user_list
         ${nameFilter}
         ORDER BY user_list.size_for_display DESC`
      );

      const lists = results.map(r => {
        const ul = r.userList as Record<string, unknown>;
        return {
          id: ul?.id,
          name: ul?.name,
          type: ul?.type,
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
    "add_audience_signal",
    {
      description: [
        "Add an audience signal to a PMax asset group.",
        "WRITE OPERATION.",
        "",
        "Audience signals tell PMax which users to prioritize. They DON'T restrict targeting",
        "— PMax still finds new audiences, but starts with these as hints.",
        "",
        "Two types:",
        "1. Audience signal: link an existing Audience (from list_audience_segments) or create one from user lists",
        "2. Search theme signal: add a keyword/phrase signal",
        "",
        "For remarketing PMax: first use list_remarketing_lists to find existing populated lists,",
        "then create an Audience from them, then link as signal.",
        "",
        "IMPORTANT: Do NOT create new empty remarketing lists. Use existing populated ones.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("Asset group ID."),
        signalType: z.enum(["audience", "search_theme"]).describe("Signal type."),
        audienceResourceName: z.string().optional().describe("For 'audience' type: Audience resource name. Create with create_audience_from_lists if needed."),
        searchThemeText: z.string().optional().describe("For 'search_theme' type: keyword/phrase."),
      },
    },
    async ({ customerId, assetGroupId, signalType, audienceResourceName, searchThemeText }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");
      const agResource = `customers/${cid}/assetGroups/${assetGroupId}`;

      if (signalType === "audience" && audienceResourceName) {
        await client.mutateAssetGroupSignals(customerId, [
          { create: { assetGroup: agResource, audience: { audience: audienceResourceName } } },
        ] as unknown as import("./google-ads-client.js").MutateOperation[]);
        return { content: [text(`Audience signal linked to asset group ${assetGroupId}.\nAudience: ${audienceResourceName}`)] };
      } else if (signalType === "search_theme" && searchThemeText) {
        await client.mutateAssetGroupSignals(customerId, [
          { create: { assetGroup: agResource, searchTheme: { text: searchThemeText } } },
        ] as unknown as import("./google-ads-client.js").MutateOperation[]);
        return { content: [text(`Search theme signal added: "${searchThemeText}"\nAsset group: ${assetGroupId}`)] };
      }
      return { content: [text("Error: provide audienceResourceName for 'audience' type or searchThemeText for 'search_theme' type.")], isError: true };
    }
  );

  mcp.registerTool(
    "create_audience_from_lists",
    {
      description: [
        "Create an Audience resource from existing user lists (remarketing lists).",
        "WRITE OPERATION.",
        "",
        "Use this to combine multiple remarketing lists into one Audience,",
        "then link it as a signal to a PMax asset group with add_audience_signal.",
        "",
        "First call list_remarketing_lists to find populated lists (size > 0).",
        "Pass their resource names (customers/XXX/userLists/YYY format).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Audience name."),
        userListResourceNames: flexArray(z.string()).describe("Resource names of user lists to include."),
      },
    },
    async ({ customerId, name, userListResourceNames }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const lists = ensureArray<string>(userListResourceNames);

      const segments = lists.map(ul => ({ userList: { userList: ul } }));

      const result = await client.mutateAudiences(customerId, [
        {
          create: {
            name,
            status: "ENABLED",
            dimensions: [{ audienceSegments: { segments } }],
          },
        },
      ] as unknown as import("./google-ads-client.js").MutateOperation[]);

      const resourceName = ((result as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string;
      return { content: [text(`Audience created: "${name}"\nResource: ${resourceName}\nUser lists: ${lists.length}\n\nUse this resource name in add_audience_signal.`)] };
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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

      const listData: Record<string, unknown> = {
        name,
        membershipLifeSpan,
        membershipStatus: "OPEN",
        ruleBasedUserList: { flexibleRuleUserList: flexRule },
      };
      if (description) listData.description = description;

      // NOTE: If flexibleRuleUserList fails (v23 format change), the tool will
      // return the API error. Use GA4-based lists (created in GA4 UI) for more
      // reliable rule-based remarketing — they sync automatically to Google Ads.

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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
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
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const currency = await client.getAccountCurrency(customerId);
      return { content: [text(currency)] };
    }
  );
  // ══════════════════════════════════════════════════════════════════
  // ══ PLANEJAMENTO, RECOMENDAÇÕES E CONVERSÕES OFFLINE ══════════════
  // ══════════════════════════════════════════════════════════════════

  // generate_keyword_ideas — implementação em src/tools/planner-recommendations.ts (lote planner-recommendations).

  // list_geo_targets: registrada em src/tools/targeting-geo.ts (lote targeting-geo).

  // list_recommendations, apply_recommendation, dismiss_recommendation — implementação em src/tools/planner-recommendations.ts (lote planner-recommendations).

  mcp.registerTool(
    "set_campaign_conversion_goals",
    {
      description: [
        "Define quais categorias de conversão a campanha usa para lances (metas de conversão da campanha).",
        "WRITE OPERATION.",
        "",
        "É o que resolve o caso 'a campanha está otimizando para a conversão errada':",
        "marque biddable=true só nas categorias que devem guiar o lance (ex: PURCHASE)",
        "e biddable=false nas demais (ex: PAGE_VIEW, CONTACT).",
        "",
        "origin (fonte da conversão): WEBSITE, APP, CALL_FROM_ADS, STORE, GOOGLE_HOSTED, YOUTUBE_HOSTED.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
        goals: z.array(z.object({
          category: conversionCategorySchema.describe("Categoria de conversão."),
          origin: z.enum(["WEBSITE", "APP", "CALL_FROM_ADS", "STORE", "GOOGLE_HOSTED", "YOUTUBE_HOSTED", "LOCAL_SERVICES_ADS"]).optional().describe("Origem. Default: WEBSITE."),
          biddable: z.boolean().describe("True = usada para lances (primária). False = só observação."),
        })).describe("Metas a configurar."),
      },
    },
    async ({ customerId, campaignId, goals }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi alterado.`)], isError: true };
      }
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      // Só existem as metas (categoria × origem) que a conta tem: um par inexistente
      // dava "Resource was not found". Lê as da campanha e muta só as que existem.
      const rows = await client.searchStream(customerId,
        `SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin,
                campaign_conversion_goal.biddable
         FROM campaign_conversion_goal
         WHERE campaign.id = ${campaignId}`);
      const existing = new Map<string, boolean>();
      for (const row of rows) {
        const goal = (row.campaignConversionGoal ?? {}) as Record<string, unknown>;
        existing.set(`${goal.category}~${goal.origin}`, Boolean(goal.biddable));
      }
      if (existing.size === 0) {
        return {
          content: [text(`A campanha ${campaignId} não tem metas de conversão na conta ${cid} (ou não existe). Nada foi alterado.`)],
          isError: true,
        };
      }

      const requested = goals.map((g) => ({
        category: resolveEnumAlias(g.category, CONVERSION_CATEGORY_ALIASES),
        origin: g.origin ?? "WEBSITE",
        biddable: g.biddable,
      }));
      const unknown = requested.filter((g) => !existing.has(`${g.category}~${g.origin}`));
      if (unknown.length > 0) {
        const valid = [...existing.entries()].map(([key, biddable]) => {
          const [category, origin] = key.split("~");
          return `${category} (${origin}): ${biddable ? "lance" : "observação"}`;
        });
        return {
          content: [text(
            `Nada foi alterado — par(es) categoria/origem que não existem nesta campanha:\n` +
            unknown.map((g) => `- ${g.category} (${g.origin})`).join("\n") +
            `\n\nPares válidos da campanha ${campaignId}:\n- ${valid.join("\n- ")}`
          )],
          isError: true,
        };
      }

      const toChange = requested.filter((g) => existing.get(`${g.category}~${g.origin}`) !== g.biddable);
      const unchanged = requested.filter((g) => !toChange.includes(g)).map((g) => `${g.category} (${g.origin})`);
      if (toChange.length === 0) {
        return { content: [text(`Campanha ${campaignId}: nada a mudar — as metas já estão assim. Nenhuma escrita foi enviada.`)] };
      }
      const operations = toChange.map((g) => ({
        update: {
          resourceName: `customers/${cid}/campaignConversionGoals/${campaignId}~${g.category}~${g.origin}`,
          biddable: g.biddable,
        },
        updateMask: "biddable",
      }));
      const result = await client.mutateCampaignConversionGoals(customerId, operations);
      const dryRun = client.isDryRun;
      const summary = toChange
        .map((g) => `${g.category} (${g.origin}): ${existing.get(`${g.category}~${g.origin}`) ? "lance" : "observação"} → ${g.biddable ? "lance" : "observação"}`)
        .join("\n");
      return {
        content: [text(
          (dryRun ? `Campanha ${campaignId} — DRY-RUN (validateOnly): validado, nada foi gravado.\n` : `Metas de conversão da campanha ${campaignId} atualizadas:\n`) +
          `${summary}` + (unchanged.length ? `\nSem mudança: ${unchanged.join(", ")}` : "") +
          `\n\n${formatJson(result)}`
        )],
      };
    }
  );

  mcp.registerTool(
    "upload_offline_conversion",
    {
      description: [
        "Envia conversões offline (importação por clique) para uma ação de conversão do tipo UPLOAD.",
        "WRITE OPERATION.",
        "",
        "Cada conversão precisa de UM identificador de clique: gclid, gbraid ou wbraid.",
        "conversionDateTime precisa do fuso: 'yyyy-MM-dd HH:mm:ss+HH:MM' (ex: '2026-09-09 14:30:00-03:00').",
        "",
        "A ação de conversão precisa ser do tipo UPLOAD_CLICKS (crie com create_conversion_action type=UPLOAD).",
        "Use validateOnly: true para testar sem gravar.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        conversionActionId: z.string().describe("ID da ação de conversão (tipo UPLOAD_CLICKS)."),
        conversions: z.array(z.object({
          gclid: z.string().optional().describe("Google Click ID."),
          gbraid: z.string().optional().describe("Click ID de app/iOS (web-to-app)."),
          wbraid: z.string().optional().describe("Click ID de app/iOS (app-to-web)."),
          conversionDateTime: z.string().describe("Data/hora com fuso: 'yyyy-MM-dd HH:mm:ss+HH:MM'."),
          conversionValue: z.number().optional().describe("Valor da conversão."),
          currencyCode: z.string().optional().describe("Moeda (ex: BRL). Default: moeda da conta."),
          orderId: z.string().optional().describe("ID do pedido (evita duplicidade)."),
        })).describe("Conversões a enviar."),
        validateOnly: z.boolean().optional().describe("True = valida sem gravar. Default: false."),
      },
    },
    async ({ customerId, conversionActionId, conversions, validateOnly }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const cid = customerId.replace(/-/g, "");

      const missingId = conversions.find((c) => !c.gclid && !c.gbraid && !c.wbraid);
      if (missingId) {
        return { content: [text("Cada conversão precisa de gclid, gbraid ou wbraid.")], isError: true };
      }

      const currency = conversions.some((c) => c.conversionValue !== undefined && !c.currencyCode)
        ? await client.getAccountCurrency(customerId)
        : undefined;

      const payload = conversions.map((c) => {
        const conv: Record<string, unknown> = {
          conversionAction: `customers/${cid}/conversionActions/${conversionActionId}`,
          conversionDateTime: c.conversionDateTime,
        };
        if (c.gclid) conv.gclid = c.gclid;
        if (c.gbraid) conv.gbraid = c.gbraid;
        if (c.wbraid) conv.wbraid = c.wbraid;
        if (c.conversionValue !== undefined) {
          conv.conversionValue = c.conversionValue;
          conv.currencyCode = c.currencyCode ?? currency;
        }
        if (c.orderId) conv.orderId = c.orderId;
        return conv;
      });

      const result = await client.customerWriteAction<Record<string, unknown>>(customerId, ":uploadClickConversions", {
        conversions: payload,
        partialFailure: true,
        validateOnly: validateOnly ?? false,
      });

      const partialError = result.partialFailureError as Record<string, unknown> | undefined;
      const okCount = ((result.results as Array<Record<string, unknown>>) ?? []).filter((r) => Object.keys(r).length > 0).length;
      const dryRun = validateOnly ?? false;

      // Em validateOnly a API nao devolve results — a ausencia de erro e o sinal de sucesso
      const header = dryRun
        ? `Validação de ${payload.length} conversão(ões), nada gravado — ${partialError ? "com erros" : "todas válidas"}.`
        : `Upload de ${payload.length} conversão(ões) — ${okCount} aceita(s).`;

      return {
        content: [text(
          `${header}\n` +
          (partialError ? `Falhas parciais: ${partialError.message ?? formatJson(partialError)}\n` : "") +
          `\n${formatJson(result)}`
        )],
        isError: Boolean(partialError) || (!dryRun && okCount === 0),
      };
    }
  );

  // get_asset_performance: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ── Módulos por área (src/tools/) ─────────────────────────────────
  const context = { mcp, getClient, allowedCustomerIds, hosted };
  for (const register of TOOL_MODULES) register(context);
}
