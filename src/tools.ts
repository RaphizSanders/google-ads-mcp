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
        "List the Google Ads accounts under the login MCC (Manager account) — all levels.",
        "Returns id, name, currency, timezone, status, level, manager, hidden, test_account and account labels.",
        "Use this to discover which customer_id to use in other tools.",
        "",
        "Default: only ENABLED, non-manager accounts (as before). The header always counts accounts per status, so",
        "SUSPENDED / CANCELED / CLOSED clients show up there — list them with includeStatuses.",
        "includeManagers lists sub-MCCs; labelId keeps only accounts with that account label; hierarchy adds",
        "parent_manager_id (one query per sub-MCC).",
      ].join("\n"),
      inputSchema: {
        includeStatuses: flexArray(z.enum(["ENABLED", "CANCELED", "SUSPENDED", "CLOSED"])).optional().describe(
          "Status a listar. Default: ['ENABLED']. Ex.: ['SUSPENDED','CANCELED'] para achar clientes com problema."
        ),
        includeManagers: z.boolean().optional().describe("Incluir sub-MCCs (contas gerente). Default: false."),
        includeHidden: z.boolean().optional().describe("Incluir contas ocultas (hidden). Default: true."),
        labelId: z.string().optional().describe("Só contas com este rótulo de conta (ID numérico do label, do MCC do login)."),
        hierarchy: z.boolean().optional().describe("Adiciona parent_manager_id (MCC pai de cada conta). Default: false."),
        format: formatSchema,
      },
    },
    async ({ includeStatuses, includeManagers, includeHidden, labelId, hierarchy, format }) => {
      const CUSTOMER_STATUSES = ["ENABLED", "CANCELED", "SUSPENDED", "CLOSED"];
      const requested = ensureArray<string>(includeStatuses ?? []).map((s) => String(s).trim().toUpperCase());
      const wanted = new Set(requested.length ? requested : ["ENABLED"]);
      const invalid = [...wanted].filter((s) => !CUSTOMER_STATUSES.includes(s));
      if (invalid.length) {
        return { content: [text(`Status inválido: ${invalid.join(", ")}. Válidos: ${CUSTOMER_STATUSES.join(", ")}.`)], isError: true };
      }
      const label = labelId?.trim();
      if (label !== undefined && !/^\d+$/.test(label)) {
        return { content: [text(`labelId inválido: "${labelId}" — use o ID numérico do rótulo de conta.`)], isError: true };
      }

      /* A hosted run must not enumerate the whole MCC just because no
         allowlist was given, so there an empty set filters everything out.
         On stdio there is no cross-tenant surface and this tool is the
         discovery entry point — the id you would need to allowlist is
         precisely what you come here to find — so an empty set means
         "no filter". */
      const isAllowed = (id: string) =>
        allowAllCustomers ? true : allowedCustomerIdSet.size === 0 ? !hosted : allowedCustomerIdSet.has(id.replace(/-/g, ""));
      const toAccount = (r: Record<string, unknown>) => {
        const c = (r.customerClient ?? {}) as Record<string, unknown>;
        return {
          customer_id: c.id,
          name: c.descriptiveName,
          currency: c.currencyCode,
          timezone: c.timeZone,
          status: c.status,
          level: c.level !== undefined ? Number(c.level) : undefined,
          manager: c.manager,
          hidden: c.hidden,
          test_account: c.testAccount,
          labels: (c.appliedLabels as string[] | undefined) ?? [],
        } as Record<string, unknown>;
      };
      // A própria conta consultada volta com level 0 quando gerentes entram na consulta.
      const scoped = (rows: Array<Record<string, unknown>>) =>
        rows.map(toAccount).filter((a) => a.level !== 0 && isAllowed(String(a.customer_id ?? "")));

      const client = getClient();
      const onlyEnabled = wanted.size === 1 && wanted.has("ENABLED");
      /* Só ENABLED: o filtro de status continua no GAQL (como sempre). Os demais
         status vêm de uma consulta sem filtro de status, que também alimenta a
         contagem por status — é ela que mostra os clientes SUSPENSOS que antes
         simplesmente sumiam da lista. */
      const allRows = await client.listChildAccounts(undefined, { allStatuses: true, includeManagers: includeManagers === true });
      const everyStatus = scoped(allRows);
      let accounts = onlyEnabled
        ? scoped(await client.listChildAccounts(undefined, { includeManagers: includeManagers === true }))
        : everyStatus.filter((a) => wanted.has(String(a.status)));
      if (includeHidden === false) accounts = accounts.filter((a) => a.hidden !== true);
      if (label) {
        const labelResource = `customers/${client.loginCustomer}/labels/${label}`;
        accounts = accounts.filter((a) => (a.labels as string[]).includes(labelResource));
      }

      // Nomes dos rótulos de conta (são do MCC do login).
      const labelResources = [...new Set(accounts.flatMap((a) => a.labels as string[]))];
      if (labelResources.length) {
        const labelRows = await client.searchStream(client.loginCustomer, "SELECT label.resource_name, label.name FROM label");
        const names = new Map(labelRows.map((r) => {
          const l = (r.label ?? {}) as Record<string, unknown>;
          return [String(l.resourceName), String(l.name ?? "")] as [string, string];
        }));
        for (const a of accounts) a.labels = (a.labels as string[]).map((rn) => names.get(rn) || rn);
      }

      if (hierarchy) {
        /* customer_client não diz quem é o pai: busca em largura, um nível por
           MCC (customer_client.level <= 1), como no guia oficial de hierarquia. */
        const parentOf = new Map<string, string>();
        const queue = [client.loginCustomer];
        const seen = new Set(queue);
        while (queue.length && seen.size <= 100) {
          const managerId = queue.shift() as string;
          const children = await client.listChildAccounts(managerId, { allStatuses: true, includeManagers: true, maxLevel: 1 });
          for (const row of children) {
            const child = toAccount(row);
            const childId = String(child.customer_id ?? "");
            if (child.level !== 1 || !childId) continue;
            parentOf.set(childId, managerId);
            if (child.manager === true && !seen.has(childId)) {
              seen.add(childId);
              queue.push(childId);
            }
          }
        }
        for (const a of accounts) a.parent_manager_id = parentOf.get(String(a.customer_id ?? "")) ?? null;
      }

      const counts: Record<string, number> = {};
      for (const a of everyStatus) {
        if (a.manager === true) continue;
        const status = String(a.status ?? "UNSPECIFIED");
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const outside = Object.entries(counts).filter(([s]) => s !== "ENABLED" && !wanted.has(s));
      const header = [
        `${accounts.length} conta(s) encontrada(s) (status: ${[...wanted].join(", ")}${includeManagers ? ", com sub-MCCs" : ""}).`,
        `Contas (não-gerente) por status: ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(", ") || "nenhuma"}.`,
        ...(outside.length
          ? [`Atenção: ${outside.map(([s, n]) => `${n} ${s}`).join(", ")} fora da lista — use includeStatuses para vê-las ` +
              "(SUSPENDED só o suporte do Google reativa; CANCELED um admin reativa; CLOSED é permanente)."]
          : []),
      ].join("\n");
      if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(accounts)}`)] };
      if (format === "csv") return { content: [text(formatAsCsv(accounts))] };
      return {
        content: [text(`${header}\n\n${formatJson(accounts)}`)],
      };
    }
  );

  mcp.registerTool(
    "get_account_info",
    {
      description: [
        "Get details of a specific Google Ads account (name, currency, timezone, status, manager, test account).",
        "Explains non-ENABLED statuses (SUSPENDED, CANCELED, CLOSED). For auto-tagging, tracking template,",
        "conversion tracking and optimization score use get_account_settings.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (10 digits, with or without hyphens)."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (!/^\d+$/.test(customerId.replace(/-/g, ""))) {
        return { content: [text(`customerId inválido: "${customerId}" — use os 10 dígitos da conta.`)], isError: true };
      }
      const client = getClient();
      const result = await client.getCustomer(customerId);
      const customer = (result.customer ?? {}) as Record<string, unknown>;
      // Significado de cada status conforme enums/customer_status.proto (v25).
      const statusNotes: Record<string, string> = {
        CANCELED: "Conta CANCELADA: não veicula anúncios; um usuário administrador pode reativá-la.",
        SUSPENDED: "Conta SUSPENSA: não veicula anúncios e só o suporte do Google reativa (em geral pagamento ou política).",
        CLOSED: "Conta ENCERRADA: não veicula anúncios e o status é permanente (contas de teste também aparecem como CLOSED).",
      };
      const notes = [
        statusNotes[String(customer.status)],
        customer.testAccount === true ? "Conta de TESTE: não veicula anúncios reais." : undefined,
      ].filter(Boolean);
      return { content: [text(`${formatJson(result)}${notes.length ? `\n\n${notes.join("\n")}` : ""}`)] };
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
        "Não sabe o nome de um campo ou se ele combina com o FROM? Use get_gaql_fields",
        "(campos, segmentos e métricas de um recurso) e validate_gaql (confere a query antes de rodar).",
        "",
        "Monetary values are in MICROS (1,000,000 = 1 unit of currency).",
        "Divide cost_micros by 1,000,000 to get BRL/USD value.",
        "metrics.conversions = só ações primárias (include_in_conversions_metric); metrics.all_conversions = todas.",
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
      if (!/^\s*SELECT\s/i.test(query)) {
        return {
          content: [text("GAQL precisa começar com SELECT (ex.: SELECT campaign.id, campaign.name FROM campaign). Nada foi enviado.")],
          isError: true,
        };
      }
      const client = getClient();
      let results: Array<Record<string, unknown>>;
      try {
        results = await client.searchStream(customerId, query);
      } catch (err) {
        /* Erro de query (campo inexistente, incompatível com o FROM, não
           filtrável...): aponta as tools de metadados em vez de deixar o agente
           adivinhar nomes de novo. */
        const codes = ((err as { codes?: string[] }).codes ?? []);
        const queryError = codes.some((code) => code.startsWith("queryError.")) || /queryError|UNRECOGNIZED_FIELD|PROHIBITED_/i.test((err as Error).message);
        const hint = queryError
          ? "\nDica: confira a query com validate_gaql e os campos compatíveis com get_gaql_fields (resource=<recurso do FROM>)."
          : "";
        return { content: [text(`Erro: ${(err as Error).message}${hint}`)], isError: true };
      }

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
        "includeImpressionShare: true acrescenta parcela de impressões da Pesquisa, perdida por orçamento/ranking,",
        "topo e topo absoluto (\"<10%\"/\">90%\" quando a API trunca) e um diagnóstico. Para mais níveis e",
        "segmentos, use get_impression_share.",
        "Só entram campanhas com impressões no período — a que parou de veicular não aparece; use diagnose_campaigns.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (10 digits)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        status: z
          .enum(["ALL", "ENABLED", "PAUSED", "REMOVED"])
          .optional()
          .describe("Filter by status. Default: excludes REMOVED."),
        includeImpressionShare: z
          .boolean()
          .optional()
          .describe("true = inclui parcela de impressões (Pesquisa) e perdas por orçamento/ranking. Default: false."),
      },
    },
    async ({ customerId, dateRange, days, status, includeImpressionShare }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const statusClause =
        status === "ALL" ? "" : `AND campaign.status ${status ? `= '${status}'` : "!= 'REMOVED'"}`;
      // Helpers de parcela ficam no módulo do lote diagnostics (import tardio: sem mexer no topo do arquivo).
      const share = includeImpressionShare ? await import("./tools/diagnostics.js") : undefined;

      const results = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, campaign.advertising_channel_type,
                campaign.status, campaign.bidding_strategy_type,
                campaign.ai_max_setting.enable_ai_max,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.average_cpc, metrics.conversions,
                metrics.conversions_value, metrics.all_conversions,
                metrics.all_conversions_value${share ? `,
                ${share.PERFORMANCE_IS_FIELDS}` : ""}
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
          ...(share ? share.performanceImpressionShare(m) : {}),
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
      description: [
        "Get performance metrics for ad groups. Optionally filter by campaign ID.",
        "includeImpressionShare: true acrescenta parcela de impressões da Pesquisa e perdas por orçamento/ranking.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID (numeric)."),
        includeImpressionShare: z
          .boolean()
          .optional()
          .describe("true = inclui parcela de impressões (Pesquisa) e perdas por orçamento/ranking. Default: false."),
      },
    },
    async ({ customerId, dateRange, days, campaignId, includeImpressionShare }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // campaignId entra direto no GAQL: só dígitos passam
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const campaignFilter = campaignId ? `AND campaign.id = ${campaignId}` : "";
      const share = includeImpressionShare ? await import("./tools/diagnostics.js") : undefined;

      const results = await client.searchStream(
        customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status,
                campaign.name, campaign.id,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value${share ? `,
                ${share.PERFORMANCE_IS_FIELDS}` : ""}
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
          campaign_id: c?.id,
          campaign_name: c?.name,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          ctr: Math.round(num(m?.ctr) * 10000) / 100,
          conversions: conv,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
          cpa: conv > 0 ? Math.round((spend / conv) * 100) / 100 : null,
          ...(share ? share.performanceImpressionShare(m) : {}),
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
  // get_shopping_products foi movida para src/tools/retail-reporting.ts (lote retail-reporting).

  // ── Insights: Device Breakdown ─────────────────────────────────────

  // get_device_breakdown: reescrita em src/tools/bid-modifiers.ts (lote bid-modifiers).

  // ── Insights: Daily Trend ──────────────────────────────────────────

  mcp.registerTool(
    "get_daily_trend",
    {
      description: [
        "Get daily performance trend. Returns one row per day with spend, clicks, conversions, revenue.",
        "Sem campaignId = conta inteira (FROM customer); com campaignId = só a campanha (FROM campaign).",
        "granularity: DAY (padrão), WEEK, MONTH, QUARTER ou YEAR. Desde 01/06/2026 o Google só guarda dado",
        "diário/semanal por 37 meses — para períodos mais antigos use MONTH/QUARTER/YEAR com datas alinhadas ao mês.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Filter by campaign ID (numeric)."),
        granularity: z
          .enum(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"])
          .optional()
          .describe("Agrupamento das linhas. Default: DAY (segments.date)."),
      },
    },
    async ({ customerId, dateRange, days, campaignId, granularity }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      const periodField = {
        DAY: "date", WEEK: "week", MONTH: "month", QUARTER: "quarter", YEAR: "year",
      }[granularity ?? "DAY"];
      const client = getClient();
      // Dado diário/semanal só existe para os últimos 37 meses: o guarda recusa antes da API.
      const dateClause = buildDateClause(dateRange, days, { granular: periodField === "date" || periodField === "week" });

      /* customer não tem recursos atribuídos: campaign.id em FROM customer é recusado pela
         API. Com campanha, a query sai de FROM campaign, que aceita o filtro. */
      const results = await client.searchStream(
        customerId,
        campaignId
          ? `SELECT segments.${periodField}, campaign.id, campaign.name,
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${dateClause} AND campaign.id = ${campaignId}
         ORDER BY segments.${periodField}`
          : `SELECT segments.${periodField},
                metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value
         FROM customer
         WHERE ${dateClause}
         ORDER BY segments.${periodField}`
      );

      const trend = results.map((r) => {
        const s = r.segments as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const period = s?.[periodField];
        return {
          ...(periodField === "date" ? { date: period } : { period, granularity: granularity }),
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          spend: Math.round(microsToMoney(m?.costMicros) * 100) / 100,
          conversions: num(m?.conversions),
          revenue: Math.round(num(m?.conversionsValue) * 100) / 100,
        };
      });

      if (campaignId && trend.length === 0) {
        // Sem linhas: distingue campanha inexistente de campanha sem entrega no período.
        const found = await client.searchStream(
          customerId,
          `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId}`
        );
        const campaign = found[0]?.campaign as Record<string, unknown> | undefined;
        if (!campaign) {
          return { content: [text(`Campanha ${campaignId} não encontrada na conta ${customerId}.`)], isError: true };
        }
        return {
          content: [text(
            `Campanha ${campaignId} (${String(campaign.name ?? "")}, ${String(campaign.status ?? "")}) sem nenhuma ` +
              "linha de métrica no período — não veiculou. Para ver o motivo, use diagnose_campaigns.\n\n[]"
          )],
        };
      }

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
        "purchase_conversions/purchase_revenue = coluna Conversões (ações de compra primárias, as que guiam o lance);",
        "all_purchase_conversions/all_purchase_revenue = Todas as conversões (inclui ações de compra secundárias).",
        "Para ver cada ação de compra separada: get_conversions_by_action com category=PURCHASE.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        campaignId: z.string().optional().describe("Só esta campanha (ID numérico)."),
        format: formatSchema,
      },
    },
    async ({ customerId, dateRange, days, campaignId, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}". Nada foi consultado.`)], isError: true };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);

      // campaign.id na chave: nome de campanha não é único. all_conversions revela compras
      // de ações secundárias, que a coluna Conversões (metrics.conversions) não mostra.
      const results = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, segments.conversion_action_category,
                metrics.conversions, metrics.conversions_value,
                metrics.all_conversions, metrics.all_conversions_value
         FROM campaign
         WHERE ${dateClause}
           AND segments.conversion_action_category = 'PURCHASE'
           AND campaign.status != 'REMOVED'${campaignId ? `
           AND campaign.id = ${campaignId}` : ""}
         ORDER BY metrics.conversions_value DESC`
      );

      const byCampaign = new Map<string, {
        campaign_id: string; campaign_name: unknown;
        purchase_conversions: number; purchase_revenue: number;
        all_purchase_conversions: number; all_purchase_revenue: number;
      }>();
      for (const r of results) {
        const c = (r.campaign ?? {}) as Record<string, unknown>;
        const m = (r.metrics ?? {}) as Record<string, unknown>;
        const key = String(c.id ?? c.name ?? "");
        const acc = byCampaign.get(key) ?? {
          campaign_id: String(c.id ?? ""), campaign_name: c.name,
          purchase_conversions: 0, purchase_revenue: 0, all_purchase_conversions: 0, all_purchase_revenue: 0,
        };
        acc.purchase_conversions += num(m.conversions);
        acc.purchase_revenue += num(m.conversionsValue);
        acc.all_purchase_conversions += num(m.allConversions);
        acc.all_purchase_revenue += num(m.allConversionsValue);
        byCampaign.set(key, acc);
      }
      const campaigns = [...byCampaign.values()].map((c) => ({
        ...c,
        purchase_conversions: round2(c.purchase_conversions),
        purchase_revenue: round2(c.purchase_revenue),
        all_purchase_conversions: round2(c.all_purchase_conversions),
        all_purchase_revenue: round2(c.all_purchase_revenue),
      }));

      const totalConv = round2(campaigns.reduce((sum, c) => sum + c.purchase_conversions, 0));
      const totalRev = campaigns.reduce((sum, c) => sum + c.purchase_revenue, 0);
      const totalAllConv = round2(campaigns.reduce((sum, c) => sum + c.all_purchase_conversions, 0));
      const totalAllRev = campaigns.reduce((sum, c) => sum + c.all_purchase_revenue, 0);
      const secondaryNote = totalAllConv > totalConv
        ? `\nTodas as conversões de compra: ${totalAllConv} (R$ ${totalAllRev.toFixed(2)}) — ${round2(totalAllConv - totalConv)} vêm de ações de ` +
          "compra fora da coluna Conversões (secundárias). Veja get_conversions_by_action com category=PURCHASE."
        : "";
      const header = `Total: ${totalConv} compras, R$ ${totalRev.toFixed(2)} receita.${secondaryNote}`;

      if (format === "table") return { content: [text(`${header}\n\n${formatAsTable(campaigns)}`)] };
      if (format === "csv") return { content: [text(formatAsCsv(campaigns))] };
      return {
        content: [
          text(
            `${header}\n\n${formatJson(campaigns)}`
          ),
        ],
      };
    }
  );

  // ── Insights: Compare Periods ──────────────────────────────────────

  mcp.registerTool(
    "compare_periods",
    {
      description: [
        "Compare performance between two date ranges. Returns absolute and percentage deltas.",
        "campaignId opcional compara só uma campanha. Períodos que começam há mais de 37 meses precisam",
        "estar alinhados ao mês (dia 1 ao último dia) — regra de retenção do Google desde 01/06/2026.",
      ].join("\n"),
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
        campaignId: z.string().optional().describe("Compara só esta campanha (ID numérico). Default: conta inteira."),
      },
    },
    async ({ customerId, periodA, periodB, campaignId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      if (campaignId !== undefined && !/^\d+$/.test(campaignId)) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      /* Os dois períodos são obrigatórios e completos: buildDateClause cai em "últimos 30 dias"
         quando since/until vêm vazios, o que compararia outro período com o rótulo pedido. */
      for (const [label, period] of [["periodA", periodA], ["periodB", periodB]] as const) {
        if (!period?.since || !period?.until || !/^\d{4}-\d{2}-\d{2}$/.test(period.since) || !/^\d{4}-\d{2}-\d{2}$/.test(period.until)) {
          return {
            content: [text(
              `compare_periods: ${label} precisa de since e until no formato YYYY-MM-DD ` +
                `(recebido "${String(period?.since ?? "")}" → "${String(period?.until ?? "")}").`
            )],
            isError: true,
          };
        }
      }
      /* As datas iam cruas para o GAQL. buildDateClause valida o formato, a ordem e a
         retenção (período antigo só alinhado ao mês) antes de qualquer chamada. */
      let clauseA: string;
      let clauseB: string;
      try {
        clauseA = buildDateClause(periodA);
        clauseB = buildDateClause(periodB);
      } catch (err) {
        return { content: [text(`compare_periods: ${(err as Error).message}`)], isError: true };
      }
      const client = getClient();

      const query = (dateClause: string) =>
        campaignId
          ? `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM campaign
         WHERE ${dateClause} AND campaign.id = ${campaignId}`
          : `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions, metrics.conversions_value
         FROM customer
         WHERE ${dateClause}`;

      const [resA, resB] = await Promise.all([
        client.searchStream(customerId, query(clauseA)),
        client.searchStream(customerId, query(clauseB)),
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

      const campaignRow = (resA[0]?.campaign ?? resB[0]?.campaign) as Record<string, unknown> | undefined;
      const comparison = {
        ...(campaignId ? { campaign_id: campaignId, campaign_name: campaignRow?.name ?? null } : {}),
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
        "Também alerta campanhas ativas que não veiculam (primary_status NOT_ELIGIBLE/MISCONFIGURED ou sem gasto",
        "no período) e campanhas com bom ROAS perdendo parcela de impressões por orçamento.",
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
                metrics.conversions, metrics.conversions_value,
                metrics.search_budget_lost_impression_share
         FROM campaign
         WHERE ${dateClause}
           AND campaign.status = 'ENABLED'
           AND metrics.cost_micros > 0
         ORDER BY metrics.cost_micros DESC`
      );
      /* Campanha ativa que parou de veicular não tem gasto e some da query acima. O status
         primário vem sem métricas, então lista todas as ativas. */
      const servingRows = await client.searchStream(
        customerId,
        `SELECT campaign.id, campaign.name, campaign.primary_status, campaign.primary_status_reasons
         FROM campaign
         WHERE campaign.status = 'ENABLED'`
      );
      const { CAMPAIGN_REASONS } = await import("./tools/diagnostics.js");

      const alerts: Array<{ level: string; campaign: string; title: string; text: string }> = [];
      const totalSpend = results.reduce((s, r) => s + microsToMoney((r.metrics as Record<string, unknown>)?.costMicros), 0);
      const totalConv = results.reduce((s, r) => s + num((r.metrics as Record<string, unknown>)?.conversions), 0);
      const avgCpa = totalConv > 0 ? totalSpend / totalConv : 0;
      const totalValue = results.reduce((s, r) => s + num((r.metrics as Record<string, unknown>)?.conversionsValue), 0);
      const avgRoas = totalSpend > 0 ? totalValue / totalSpend : 0;

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

        // Bom retorno travado pelo orçamento (limiares de 20% e ROAS ≥ média são heurística de agência).
        const lostBudget = m?.searchBudgetLostImpressionShare === undefined ? NaN : Number(m.searchBudgetLostImpressionShare);
        if (Number.isFinite(lostBudget) && lostBudget >= 0.2 && roas >= Math.max(1, avgRoas)) {
          alerts.push({
            level: "success",
            campaign: name,
            title: `${name} — limitada pelo orçamento com bom retorno`,
            text: `Perde ${lostBudget >= 0.9 ? "mais de 90%" : `${(lostBudget * 100).toFixed(1)}%`} das impressões da Pesquisa por orçamento ` +
              `com ROAS de ${roas.toFixed(2)}x. Candidata a mais orçamento (update_budget); detalhe em get_impression_share.`,
          });
        }
      }

      const spending = new Set(results.map((r) => String((r.campaign as Record<string, unknown>)?.id)));
      for (const row of servingRows) {
        const c = row.campaign as Record<string, unknown>;
        const name = String(c?.name ?? "");
        const primary = String(c?.primaryStatus ?? "");
        const reasons = (Array.isArray(c?.primaryStatusReasons) ? c.primaryStatusReasons : []).map(String);
        const explained = reasons
          .filter((code) => CAMPAIGN_REASONS[code]?.[0] === "problema" || CAMPAIGN_REASONS[code]?.[0] === "atencao")
          .slice(0, 3)
          .map((code) => `${code}: ${CAMPAIGN_REASONS[code][1]}`);
        if (primary === "NOT_ELIGIBLE" || primary === "MISCONFIGURED") {
          alerts.push({
            level: "danger",
            campaign: name,
            title: `${name} — ativa, mas não veicula (${primary})`,
            text: `${explained.join(" ") || "Sem motivo detalhado."} Diagnóstico completo: diagnose_campaigns.`,
          });
        } else if (!spending.has(String(c?.id)) && primary !== "ENDED" && primary !== "PENDING") {
          alerts.push({
            level: "warning",
            campaign: name,
            title: `${name} — ativa e sem gasto no período`,
            text: `Status primário ${primary || "desconhecido"}. ${explained.join(" ")} Veja diagnose_campaigns.`.replace(/\s+/g, " ").trim(),
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

  // list_conversion_actions: registrada em src/tools/conversions-core.ts (lote conversions-core).

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
        "Pausa ou ativa várias campanhas, grupos de anúncios ou anúncios de uma vez.",
        "WRITE OPERATION.",
        "",
        "Lê o status atual antes de gravar: pula os que já estão no status pedido, os removidos",
        "e os que não existem nesta conta (sem escrita para eles). Envia em lotes de até 10.000",
        "operações com partial failure: um ID ruim não desfaz os outros — cada falha volta com",
        "o motivo. Até 50.000 IDs por chamada; acima disso, use create_batch_job.",
        "",
        "Em escala exige confirm: true — quando mais de 100 itens mudariam (mais de 20 ao ATIVAR,",
        "que volta a gastar na hora), a primeira chamada só devolve o plano lido (quantos mudam,",
        "quais, status antes) e não grava. Chamadas menores gravam direto, como antes.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        resourceType: z
          .enum(["campaigns", "adGroups", "adGroupAds"])
          .describe("Type of resource."),
        resourceIds: flexArray(z.string())
          .describe("IDs. Campanhas e grupos: ID numérico. Anúncios: 'adGroupId~adId'."),
        status: z.enum(["ENABLED", "PAUSED"]).describe("New status."),
        confirm: z.boolean().optional().describe(
          "true = aplica mesmo em escala. Obrigatório quando mais de 100 itens mudariam (mais de 20 com status ENABLED)."
        ),
      },
    },
    async ({ customerId, resourceType, resourceIds, status, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) {
        return { content: [text(`customerId inválido: "${customerId}". Nada foi alterado.`)], isError: true };
      }

      /* Limites da API: 10.000 operações por mutate e até 20.000 valores num IN do GAQL.
         A leitura vai em blocos de 1.000 para a query não crescer demais. */
      const MAX_IDS = 50_000;
      const MUTATE_CHUNK = 10_000;
      const READ_CHUNK = 1_000;
      const idPattern = resourceType === "adGroupAds" ? /^\d+~\d+$/ : /^\d+$/;
      const ids = [...new Set(ensureArray<string>(resourceIds).map((id) => String(id).trim()).filter(Boolean))];
      if (ids.length === 0) {
        return { content: [text("Informe ao menos um ID em resourceIds. Nada foi alterado.")], isError: true };
      }
      const badIds = ids.filter((id) => !idPattern.test(id));
      if (badIds.length > 0) {
        const expected = resourceType === "adGroupAds" ? "'adGroupId~adId' (ex.: 123~456)" : "numéricos";
        return {
          content: [text(`IDs inválidos para ${resourceType} (esperado ${expected}): ${badIds.slice(0, 50).join(", ")}` +
            `${badIds.length > 50 ? ` (+${badIds.length - 50})` : ""}. Nada foi alterado.`)],
          isError: true,
        };
      }
      if (ids.length > MAX_IDS) {
        return {
          content: [text(`${ids.length} IDs passam do limite de ${MAX_IDS} por chamada. Divida a lista ou use create_batch_job. Nada foi alterado.`)],
          isError: true,
        };
      }

      const client = getClient();
      const spec = {
        campaigns: { from: "campaign", key: "campaign" },
        adGroups: { from: "ad_group", key: "adGroup" },
        adGroupAds: { from: "ad_group_ad", key: "adGroupAd" },
      }[resourceType];
      const resourceNameOf = (id: string) => `customers/${cid}/${resourceType}/${id}`;

      // Leitura antes da escrita: o que existe, o status atual e o nome (para o relatório).
      const current = new Map<string, { status: string; name: string }>();
      for (let start = 0; start < ids.length; start += READ_CHUNK) {
        const names = ids.slice(start, start + READ_CHUNK).map((id) => `'${resourceNameOf(id)}'`).join(", ");
        const nameField = resourceType === "adGroupAds" ? "ad_group_ad.ad.name" : `${spec.from}.name`;
        const rows = await client.searchStream(customerId,
          `SELECT ${spec.from}.resource_name, ${spec.from}.status, ${nameField}
           FROM ${spec.from}
           WHERE ${spec.from}.resource_name IN (${names})`);
        for (const row of rows) {
          const entity = (row[spec.key] ?? {}) as Record<string, unknown>;
          const name = resourceType === "adGroupAds"
            ? String(((entity.ad ?? {}) as Record<string, unknown>).name ?? "")
            : String(entity.name ?? "");
          current.set(String(entity.resourceName ?? ""), { status: String(entity.status ?? ""), name });
        }
      }

      const notFound: string[] = [];
      const removed: string[] = [];
      const unchanged: string[] = [];
      const toChange: Array<{ id: string; name: string; before: string }> = [];
      for (const id of ids) {
        const found = current.get(resourceNameOf(id));
        if (!found) notFound.push(id);
        else if (found.status === "REMOVED") removed.push(id);
        else if (found.status === status) unchanged.push(id);
        else toChange.push({ id, name: found.name, before: found.status });
      }

      const dryRun = client.isDryRun;
      // Com dezenas de milhares de IDs a lista completa não cabe numa resposta: as contagens
      // do cabeçalho são exatas e cada lista mostra os primeiros itens.
      const LISTED = 500;
      const capped = <T,>(items: T[]) => items.length > LISTED ? [...items.slice(0, LISTED), `(+${items.length - LISTED} omitidos)`] : items;

      /* Aplicar em escala exige confirm (convenção do servidor para o que é difícil de
         desfazer). Ativar volta a gastar na hora, por isso o limite é menor. O corte usa o
         que de fato mudaria depois da leitura, e dry-run/validateOnly não grava — não pede. */
      const confirmAbove = status === "ENABLED" ? 20 : 100;
      if (!dryRun && confirm !== true && toChange.length > confirmAbove) {
        return {
          content: [text(
            `${toChange.length} ${resourceType} mudariam para ${status} — acima de ${confirmAbove} numa chamada a alteração exige confirm: true` +
            `${status === "ENABLED" ? " (ativar em massa volta a gastar na hora)" : ""}. Nada foi alterado.\n` +
            `Revise o plano e repita com confirm: true para aplicar. Já estavam em ${status}: ${unchanged.length} | ` +
            `Removidos (ignorados): ${removed.length} | Não encontrados: ${notFound.length}\n\n` +
            formatJson({
              to_change: capped(toChange.map((item) => ({ id: item.id, name: item.name, before: item.before, after: status }))),
              already_in_status: capped(unchanged),
              removed_skipped: capped(removed),
              not_found: capped(notFound),
            })
          )],
          isError: true,
        };
      }

      const changed: Array<Record<string, unknown>> = [];
      const errors: Array<Record<string, unknown>> = [];
      const notSent: string[] = [];
      for (let start = 0; start < toChange.length; start += MUTATE_CHUNK) {
        const chunk = toChange.slice(start, start + MUTATE_CHUNK);
        let response: Record<string, unknown>;
        try {
          response = await client.mutate(customerId, resourceType, chunk.map((item) => ({
            update: { resourceName: resourceNameOf(item.id), status },
            updateMask: "status",
          })), { partialFailure: true });
        } catch (err) {
          // Erro fora das operações (auth, cota): o lote inteiro falhou e os seguintes não vão.
          for (const item of chunk) errors.push({ id: item.id, error: (err as Error).message });
          notSent.push(...toChange.slice(start + MUTATE_CHUNK).map((item) => item.id));
          break;
        }
        const results = (response.results as Array<Record<string, unknown>>) ?? [];
        const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, chunk.length);
        chunk.forEach((item, index) => {
          const opErrors = byIndex.get(index);
          if (opErrors) errors.push({ id: item.id, name: item.name, error: opErrors.join("; ") });
          else if (!dryRun && !results[index]?.resourceName) errors.push({ id: item.id, name: item.name, error: "a API não confirmou a alteração" });
          else changed.push({ id: item.id, name: item.name, before: item.before, after: status });
        });
        for (const message of unattributed) errors.push({ error: message });
      }

      const header = dryRun
        ? `DRY-RUN (validateOnly): nada foi gravado. ${changed.length} ${resourceType} validado(s) para ${status}.`
        : `${changed.length} ${resourceType} → ${status}.`;
      return {
        content: [text(
          `${header} Já estavam em ${status}: ${unchanged.length} | Removidos (ignorados): ${removed.length} | ` +
          `Não encontrados: ${notFound.length} | Com erro: ${errors.length}` +
          `${notSent.length ? ` | Não enviados: ${notSent.length}` : ""}\n\n` +
          formatJson({
            [dryRun ? "validated" : "changed"]: capped(changed),
            already_in_status: capped(unchanged),
            removed_skipped: capped(removed),
            not_found: capped(notFound),
            errors: errors.length > 2 * LISTED ? [...errors.slice(0, 2 * LISTED), `(+${errors.length - 2 * LISTED} omitidos)`] : errors,
            ...(notSent.length ? { not_sent: capped(notSent) } : {}),
          })
        )],
        isError: errors.length > 0,
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

  // create_pmax_campaign, create_asset_group, update_asset_group e list_asset_groups ficam em
  // src/tools/pmax-assets.ts (lote pmax-assets).

  mcp.registerTool(
    "get_asset_group_performance",
    {
      description: [
        "Métricas por grupo de recursos de uma campanha PMax: gasto, impressões, cliques, conversões, receita,",
        "ROAS e CPA, com status, status principal e força do anúncio.",
        "READ OPERATION. Opcional: assetGroupId para um grupo só; format json/table/csv.",
        "Sinais do grupo: list_asset_group_signals. Combinações que mais veicularam: get_pmax_top_combinations.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("ID da campanha PMax."),
        assetGroupId: z.string().optional().describe("Só este grupo de recursos (opcional)."),
        dateRange: dateRangeSchema.describe(DATE_RANGE_DESC),
        days: z.number().optional().describe(DAYS_DESC),
        format: formatSchema,
      },
    },
    async ({ customerId, campaignId, assetGroupId, dateRange, days, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Os IDs entram direto no GAQL: só dígitos passam
      if (!/^\d+$/.test(String(campaignId).trim())) {
        return { content: [text(`campaignId deve ser numérico, recebido "${campaignId}".`)], isError: true };
      }
      if (assetGroupId !== undefined && !/^\d+$/.test(String(assetGroupId).trim())) {
        return { content: [text(`assetGroupId deve ser numérico, recebido "${assetGroupId}".`)], isError: true };
      }
      const client = getClient();
      const dateClause = buildDateClause(dateRange, days);
      const groupFilter = assetGroupId !== undefined ? `AND asset_group.id = ${String(assetGroupId).trim()}` : "";

      const results = await client.searchStream(
        customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength,
                asset_group.primary_status,
                metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.conversions, metrics.conversions_value
         FROM asset_group
         WHERE campaign.id = ${String(campaignId).trim()}
           ${groupFilter}
           AND ${dateClause}
           AND asset_group.status != 'REMOVED'
         ORDER BY metrics.cost_micros DESC`
      );

      const groups = results.map((r) => {
        const ag = r.assetGroup as Record<string, unknown>;
        const m = r.metrics as Record<string, unknown>;
        const spend = microsToMoney(m?.costMicros);
        const convValue = num(m?.conversionsValue);
        const conversions = num(m?.conversions);
        return {
          asset_group_id: ag?.id,
          name: ag?.name,
          status: ag?.status,
          primary_status: ag?.primaryStatus,
          ad_strength: ag?.adStrength,
          spend: Math.round(spend * 100) / 100,
          impressions: num(m?.impressions),
          clicks: num(m?.clicks),
          conversions: Math.round(conversions * 100) / 100,
          revenue: Math.round(convValue * 100) / 100,
          roas: spend > 0 ? Math.round((convValue / spend) * 100) / 100 : 0,
          cpa: conversions > 0 ? Math.round((spend / conversions) * 100) / 100 : null,
        };
      });

      if (format === "table") return { content: [text(formatAsTable(groups as Array<Record<string, unknown>>))] };
      if (format === "csv") return { content: [text(formatAsCsv(groups as Array<Record<string, unknown>>))] };
      return { content: [text(`${groups.length} grupo(s) de recursos.\n\n${formatJson(groups)}`)] };
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // ══ DISPLAY + VIDEO + SHOPPING + DEMAND GEN ═══════════════════════
  // ══════════════════════════════════════════════════════════════════

  // create_display_campaign: registrada em src/tools/demand-gen.ts (lote demand-gen) — atômica via
  // googleAds:mutate, com mais estratégias de lance e remarketing dinâmico de varejo.

  mcp.registerTool(
    "create_responsive_display_ad",
    {
      description: [
        "Cria um anúncio responsivo de Display (RESPONSIVE_DISPLAY_AD) num grupo de campanha DISPLAY.",
        "WRITE OPERATION — criado PAUSADO.",
        "",
        "Obrigatórios (ResponsiveDisplayAdInfo, v25): marketingImageAssets (paisagem 1.91:1, mín. 600x314) e",
        "squareMarketingImageAssets (1:1, mín. 300x300) — até 15 somadas —, headlines (1-5, até 30 caracteres),",
        "longHeadline (até 90), descriptions (1-5, até 90) e businessName (até 25).",
        "Logo é OPCIONAL: landscapeLogoAssets (4:1, mín. 512x128 — ex.: 1200x300) e squareLogoAssets (1:1, mín.",
        "128x128 — ex.: 1200x1200), até 5 somados. logoAssets (legado) é roteado pela proporção real de cada imagem.",
        "",
        "Antes de gravar confere o grupo (existe nesta conta, campanha DISPLAY) e cada imagem (existe, é IMAGE, tem a",
        "proporção ±1% e o tamanho mínimo do campo). Opcionais: youtubeVideoIds (até 5, já registrados como asset com",
        "upload_video_asset), callToAction (até 30), mainColor + accentColor (#RRGGBB, os dois juntos),",
        "allowFlexibleColor (false exige as duas cores), formatSetting (ALL_FORMATS, NON_NATIVE, NATIVE — NATIVE exige",
        "cor flexível), promoText, pricePrefix, enableAssetEnhancements e enableAutogenVideo (control_spec).",
        "Com GOOGLE_ADS_DRY_RUN/validateOnly a API só valida e nada é gravado.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("ID do grupo de anúncios (campanha DISPLAY)."),
        finalUrl: z.string().describe("URL final (http/https)."),
        headlines: flexArray(z.string()).describe("1-5 títulos curtos (até 30 caracteres)."),
        longHeadline: z.string().describe("Título longo (até 90 caracteres)."),
        descriptions: flexArray(z.string()).describe("1-5 descrições (até 90 caracteres)."),
        businessName: z.string().describe("Nome da empresa/marca (até 25 caracteres)."),
        marketingImageAssets: flexArray(z.string()).describe("Imagens paisagem 1.91:1 (mín. 600x314): IDs ou customers/{cid}/assets/{id}."),
        squareMarketingImageAssets: flexArray(z.string()).describe("Imagens quadradas 1:1 (mín. 300x300): IDs ou resource names."),
        landscapeLogoAssets: flexArray(z.string()).optional().describe("Logos paisagem 4:1 (mín. 512x128, ex.: 1200x300). Opcional."),
        squareLogoAssets: flexArray(z.string()).optional().describe("Logos quadrados 1:1 (mín. 128x128, ex.: 1200x1200). Opcional."),
        logoAssets: flexArray(z.string()).optional().describe(
          "LEGADO — logos sem proporção declarada: cada um vai para 4:1 ou 1:1 conforme a imagem real; outra proporção é recusada."
        ),
        youtubeVideoIds: flexArray(z.string()).optional().describe("Até 5 IDs de vídeo do YouTube já registrados como asset (upload_video_asset)."),
        callToAction: z.string().optional().describe("Texto do botão (call_to_action_text, até 30 caracteres)."),
        mainColor: z.string().optional().describe("Cor principal #RRGGBB (exige accentColor)."),
        accentColor: z.string().optional().describe("Cor de destaque #RRGGBB (exige mainColor)."),
        allowFlexibleColor: z.boolean().optional().describe("Permite ao Google variar as cores. Default da API: true. false exige mainColor e accentColor."),
        formatSetting: z.enum(["ALL_FORMATS", "NON_NATIVE", "NATIVE"]).optional().describe("Formatos de veiculação. Default da API: ALL_FORMATS."),
        promoText: z.string().optional().describe("Texto promocional para formatos dinâmicos (ex.: 'Frete grátis')."),
        pricePrefix: z.string().optional().describe("Prefixo de preço (ex.: 'a partir de')."),
        enableAssetEnhancements: z.boolean().optional().describe("control_spec.enable_asset_enhancements (melhorias automáticas de assets)."),
        enableAutogenVideo: z.boolean().optional().describe("control_spec.enable_autogen_video (vídeo gerado automaticamente)."),
      },
    },
    async ({
      customerId, adGroupId, finalUrl, headlines, longHeadline, descriptions, businessName,
      marketingImageAssets, squareMarketingImageAssets, landscapeLogoAssets, squareLogoAssets, logoAssets,
      youtubeVideoIds, callToAction, mainColor, accentColor, allowFlexibleColor, formatSetting, promoText, pricePrefix,
      enableAssetEnhancements, enableAutogenVideo,
    }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const fail = (message: string) => ({ content: [text(message)], isError: true });
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);
      if (!/^\d+$/.test(String(adGroupId))) return fail(`adGroupId deve ser numérico, recebido "${adGroupId}". Nada foi gravado.`);

      // 1. Textos, cores e formato — antes de qualquer chamada à API
      const problems: string[] = [];
      const clean = (list: unknown) => ensureArray<string>(list).map((s) => String(s).trim()).filter(Boolean);
      const heads = clean(headlines);
      const descs = clean(descriptions);
      const longHead = String(longHeadline ?? "").trim();
      const business = String(businessName ?? "").trim();
      if (heads.length < 1 || heads.length > 5) problems.push(`headlines: de 1 a 5 (recebidos ${heads.length}).`);
      for (const h of heads) if (h.length > 30) problems.push(`headline "${h}" tem ${h.length} caracteres (máx. 30).`);
      if (!longHead) problems.push("longHeadline é obrigatório.");
      else if (longHead.length > 90) problems.push(`longHeadline tem ${longHead.length} caracteres (máx. 90).`);
      if (descs.length < 1 || descs.length > 5) problems.push(`descriptions: de 1 a 5 (recebidas ${descs.length}).`);
      for (const d of descs) if (d.length > 90) problems.push(`description "${d}" tem ${d.length} caracteres (máx. 90).`);
      if (!business) problems.push("businessName é obrigatório.");
      else if (business.length > 25) problems.push(`businessName tem ${business.length} caracteres (máx. 25).`);
      let validUrl = false;
      try {
        validUrl = ["http:", "https:"].includes(new URL(finalUrl).protocol);
      } catch {
        validUrl = false;
      }
      if (!validUrl) problems.push(`finalUrl inválida: "${finalUrl}" (use http:// ou https://).`);
      if (callToAction !== undefined && callToAction.trim().length > 30) problems.push(`callToAction tem ${callToAction.trim().length} caracteres (máx. 30).`);
      const hex = /^#[0-9A-Fa-f]{6}$/;
      if (mainColor !== undefined && !hex.test(mainColor)) problems.push(`mainColor "${mainColor}" inválida (use #RRGGBB).`);
      if (accentColor !== undefined && !hex.test(accentColor)) problems.push(`accentColor "${accentColor}" inválida (use #RRGGBB).`);
      if ((mainColor === undefined) !== (accentColor === undefined)) problems.push("mainColor e accentColor vão juntas: informe as duas ou nenhuma.");
      if (allowFlexibleColor === false && (mainColor === undefined || accentColor === undefined)) {
        problems.push("allowFlexibleColor: false exige mainColor e accentColor (sem cores a API exige cor flexível).");
      }
      if (formatSetting === "NATIVE" && allowFlexibleColor === false) {
        problems.push("formatSetting NATIVE não aceita allowFlexibleColor: false (no nativo a cor é do publisher).");
      }

      // 2. Referências de imagem: formato e conta
      type Slot = "marketing" | "square" | "logo" | "squareLogo" | "auto";
      const requested: Array<{ slot: Slot; assetId: string; resourceName: string }> = [];
      const addRefs = (slot: Slot, list: unknown) => {
        for (const ref of clean(list)) {
          const parsed = parseImageAssetRef(ref, cid);
          if ("error" in parsed) problems.push(parsed.error);
          else requested.push({ slot, ...parsed });
        }
      };
      addRefs("marketing", marketingImageAssets);
      addRefs("square", squareMarketingImageAssets);
      addRefs("logo", landscapeLogoAssets);
      addRefs("squareLogo", squareLogoAssets);
      addRefs("auto", logoAssets);
      if (!requested.some((r) => r.slot === "marketing")) problems.push("marketingImageAssets: ao menos uma imagem paisagem 1.91:1 é obrigatória.");
      if (!requested.some((r) => r.slot === "square")) problems.push("squareMarketingImageAssets: ao menos uma imagem quadrada 1:1 é obrigatória.");
      const videoIds = [...new Set(clean(youtubeVideoIds))];
      for (const id of videoIds) if (!/^[A-Za-z0-9_-]{11}$/.test(id)) problems.push(`youtubeVideoIds: "${id}" não é ID de vídeo do YouTube (11 caracteres).`);
      if (videoIds.length > 5) problems.push(`youtubeVideoIds: no máximo 5 (recebidos ${videoIds.length}).`);
      if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}`);

      const client = getClient();

      // 3. Grupo: existe nesta conta, não removido, em campanha DISPLAY
      const groupRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
                campaign.id, campaign.name, campaign.advertising_channel_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const group = (groupRows[0]?.adGroup ?? {}) as Record<string, unknown>;
      const campaign = (groupRows[0]?.campaign ?? {}) as Record<string, unknown>;
      if (!groupRows[0]) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.`);
      if (group.status === "REMOVED") return fail(`Grupo ${adGroupId} ("${group.name}") está removido. Nada foi gravado.`);
      if (campaign.advertisingChannelType !== "DISPLAY") {
        return fail(
          `O grupo ${adGroupId} é de campanha ${campaign.advertisingChannelType} ("${campaign.name}"). ` +
          "Anúncio responsivo de Display vai em campanha DISPLAY. Nada foi gravado."
        );
      }

      // 4. Imagens: existem, são IMAGE, proporção (±1%) e tamanho mínimo do campo
      const specs = {
        marketing: { ratio: 1.91, minW: 600, minH: 314, label: "paisagem 1.91:1 (mín. 600x314)", field: "marketingImages" },
        square: { ratio: 1, minW: 300, minH: 300, label: "quadrada 1:1 (mín. 300x300)", field: "squareMarketingImages" },
        logo: { ratio: 4, minW: 512, minH: 128, label: "logo 4:1 (mín. 512x128)", field: "logoImages" },
        squareLogo: { ratio: 1, minW: 128, minH: 128, label: "logo 1:1 (mín. 128x128)", field: "squareLogoImages" },
      } as const;
      const ids = [...new Set(requested.map((r) => r.assetId))];
      const assetRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.type,
                asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
         FROM asset
         WHERE asset.id IN (${ids.join(", ")})`);
      const assets = new Map<string, Record<string, unknown>>();
      for (const row of assetRows) {
        const asset = (row.asset ?? {}) as Record<string, unknown>;
        assets.set(String(asset.id), asset);
      }
      const matches = (w: number, h: number, ratio: number) => Math.abs(w / h / ratio - 1) <= 0.01;
      const placed: Record<keyof typeof specs, string[]> = { marketing: [], square: [], logo: [], squareLogo: [] };
      const routing: Array<Record<string, unknown>> = [];
      const warnings: string[] = [];
      for (const item of requested) {
        const asset = assets.get(item.assetId);
        if (!asset) { problems.push(`asset ${item.assetId} não existe na conta ${cid}.`); continue; }
        if (asset.type !== "IMAGE") { problems.push(`asset ${item.assetId} ("${asset.name ?? ""}") é ${asset.type}, não IMAGE.`); continue; }
        const full = (((asset.imageAsset ?? {}) as Record<string, unknown>).fullSize ?? {}) as Record<string, unknown>;
        const w = num(full.widthPixels);
        const h = num(full.heightPixels);
        let slot: keyof typeof specs;
        if (item.slot === "auto") {
          if (w && h && matches(w, h, 4)) slot = "logo";
          else if (w && h && matches(w, h, 1)) slot = "squareLogo";
          else {
            problems.push(`logo ${item.assetId} tem ${w && h ? `${w}x${h}` : "dimensões desconhecidas"} — logo precisa ser 4:1 (logo_images) ou 1:1 (square_logo_images).`);
            continue;
          }
        } else {
          slot = item.slot;
        }
        const spec = specs[slot];
        if (!w || !h) {
          warnings.push(`asset ${item.assetId}: a API não informou as dimensões; a proporção ${spec.label} não foi conferida.`);
        } else if (!matches(w, h, spec.ratio) || w < spec.minW || h < spec.minH) {
          problems.push(`asset ${item.assetId} (${w}x${h}) não serve como ${spec.label}.`);
          continue;
        }
        if (!placed[slot].includes(item.resourceName)) placed[slot].push(item.resourceName);
        routing.push({ asset_id: item.assetId, dimensions: w && h ? `${w}x${h}` : undefined, field: spec.field, ...(item.slot === "auto" ? { from: "logoAssets" } : {}) });
      }
      if (placed.marketing.length + placed.square.length > 15) problems.push(`imagens de marketing (paisagem + quadradas): no máximo 15, recebidas ${placed.marketing.length + placed.square.length}.`);
      if (placed.logo.length + placed.squareLogo.length > 5) problems.push(`logos (4:1 + 1:1): no máximo 5, recebidos ${placed.logo.length + placed.squareLogo.length}.`);
      if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}`);

      // 5. Vídeos do YouTube: precisam já ser asset YOUTUBE_VIDEO da conta
      const videoAssets: string[] = [];
      if (videoIds.length) {
        const videoRows = await client.searchStream(customerId,
          `SELECT asset.id, asset.resource_name, asset.youtube_video_asset.youtube_video_id
           FROM asset
           WHERE asset.type = 'YOUTUBE_VIDEO'
             AND asset.youtube_video_asset.youtube_video_id IN (${videoIds.map((id) => `'${gaqlLiteral(id)}'`).join(", ")})`);
        const byVideo = new Map<string, string>();
        for (const row of videoRows) {
          const asset = (row.asset ?? {}) as Record<string, unknown>;
          const id = String(((asset.youtubeVideoAsset ?? {}) as Record<string, unknown>).youtubeVideoId ?? "");
          if (id && !byVideo.has(id)) byVideo.set(id, String(asset.resourceName ?? ""));
        }
        const missing = videoIds.filter((id) => !byVideo.get(id));
        if (missing.length) {
          return fail(`Vídeo(s) sem asset na conta ${cid}: ${missing.join(", ")}. Registre antes com upload_video_asset. Nada foi gravado.`);
        }
        videoAssets.push(...videoIds.map((id) => byVideo.get(id)!));
      }

      // 6. Anúncio
      const rda: Record<string, unknown> = {
        headlines: heads.map((t) => ({ text: t })),
        longHeadline: { text: longHead },
        descriptions: descs.map((t) => ({ text: t })),
        businessName: business,
        marketingImages: placed.marketing.map((asset) => ({ asset })),
        squareMarketingImages: placed.square.map((asset) => ({ asset })),
      };
      if (placed.logo.length) rda.logoImages = placed.logo.map((asset) => ({ asset }));
      if (placed.squareLogo.length) rda.squareLogoImages = placed.squareLogo.map((asset) => ({ asset }));
      if (videoAssets.length) rda.youtubeVideos = videoAssets.map((asset) => ({ asset }));
      if (callToAction?.trim()) rda.callToActionText = callToAction.trim();
      if (mainColor && accentColor) {
        rda.mainColor = mainColor;
        rda.accentColor = accentColor;
      }
      if (allowFlexibleColor !== undefined) rda.allowFlexibleColor = allowFlexibleColor;
      if (formatSetting) rda.formatSetting = formatSetting;
      if (promoText?.trim()) rda.promoText = promoText.trim();
      if (pricePrefix?.trim()) rda.pricePrefix = pricePrefix.trim();
      if (enableAssetEnhancements !== undefined || enableAutogenVideo !== undefined) {
        rda.controlSpec = {
          ...(enableAssetEnhancements !== undefined ? { enableAssetEnhancements } : {}),
          ...(enableAutogenVideo !== undefined ? { enableAutogenVideo } : {}),
        };
      }
      const adData: Record<string, unknown> = {
        adGroup: `customers/${cid}/adGroups/${adGroupId}`,
        status: "PAUSED",
        ad: { finalUrls: [finalUrl], responsiveDisplayAd: rda },
      };

      let result: Record<string, unknown>;
      try {
        result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      } catch (err) {
        return fail(`A API recusou o anúncio responsivo de Display: ${(err as Error).message}\nNada foi criado.`);
      }
      const summary = {
        ad_group: { id: String(adGroupId), name: group.name, campaign: campaign.name },
        images: routing,
        videos: videoAssets,
        warnings,
      };
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): anúncio responsivo de Display validado pela API — nada foi gravado.\n\n${formatJson(summary)}`)] };
      }
      const resource = ((result.results as Array<Record<string, unknown>>) ?? [])[0]?.resourceName;
      if (!resource) return fail(`A API não confirmou a criação (resposta sem resourceName).\n\n${formatJson(result)}`);
      return { content: [text(`Anúncio responsivo de Display criado (PAUSADO): ${resource}\n\n${formatJson(summary)}`)] };
    }
  );

  mcp.registerTool(
    "create_video_campaign",
    {
      description: [
        "NÃO CRIA CAMPANHA — a API do Google Ads não permite criar nem alterar campanhas de Vídeo: elas são só",
        "leitura e relatório (docs 'Video campaigns'; mutações respondem VideoCampaignError.MUTATE_REQUIRES_RESERVATION",
        "ou MutateError.MUTATE_NOT_ALLOWED). A tool sempre recusa, sem tocar na conta (nenhum orçamento é criado).",
        "",
        "Caminho suportado para vídeo por API: create_demand_gen_campaign — Demand Gen entrega vídeo no YouTube",
        "(in-stream, in-feed e Shorts), Discover e Gmail, com anúncio de vídeo responsivo de Demand Gen.",
        "Medir campanhas de Vídeo existentes: get_video_performance. Subir o arquivo do vídeo: upload_youtube_video.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().optional().describe("Ignorado — a campanha não é criada."),
      },
    },
    async ({ customerId }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Recusa antes de qualquer chamada: tentar criar orçamento + campanha VIDEO deixava
      // um orçamento órfão a cada tentativa, e a API recusa a campanha em todas as variantes.
      return {
        content: [
          text(
            "create_video_campaign: a API do Google Ads não permite criar nem alterar campanhas de Vídeo " +
              "(só leitura e relatório — VideoCampaignError.MUTATE_REQUIRES_RESERVATION). " +
              "Para vídeo por API use create_demand_gen_campaign (YouTube in-stream, in-feed e Shorts, Discover e Gmail). " +
              `Para medir campanhas de Vídeo existentes use get_video_performance. Nada foi alterado na conta ${customerId}.`,
          ),
        ],
        isError: true,
      };
    }
  );

  mcp.registerTool(
    "create_video_ad",
    {
      description: [
        "Cria um anúncio de vídeo responsivo (VIDEO_RESPONSIVE_AD) num grupo VIDEO_RESPONSIVE de campanha de Vídeo existente.",
        "WRITE OPERATION — criado PAUSADO.",
        "",
        "ATENÇÃO: a API trata campanhas de Vídeo como só leitura; alterar uma campanha de Vídeo sem reserva é recusado",
        "(VideoCampaignError.MUTATE_REQUIRES_RESERVATION) — a tool explica o erro quando isso acontece. Para vídeo",
        "por API o caminho suportado é Demand Gen (create_demand_gen_campaign + anúncio de vídeo de Demand Gen);",
        "grupo de Demand Gen é recusado aqui, porque lá o tipo de anúncio é outro (DEMAND_GEN_VIDEO_RESPONSIVE_AD).",
        "",
        "Antes de gravar confere: grupo existe nesta conta, é VIDEO_RESPONSIVE em campanha VIDEO; o logo é asset IMAGE",
        "1:1 (mín. 128x128). O vídeo precisa estar no YouTube (upload_youtube_video sobe o arquivo): o asset",
        "YOUTUBE_VIDEO é reaproveitado se existir, senão é criado antes do anúncio.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID (tipo VIDEO_RESPONSIVE, em campanha de Vídeo)."),
        youtubeVideoId: z.string().describe("YouTube video ID (11 caracteres). Reaproveita o asset se o vídeo já existir na conta; senão cria."),
        finalUrl: z.string().describe("Landing page URL."),
        headline: z.string().optional().describe("Headline (max 15 chars). Obrigatório na prática: a API rejeita o anúncio sem ele."),
        description: z.string().optional().describe("Description (max 70 chars). Obrigatório na prática."),
        callToAction: z.string().optional().describe("CTA text (e.g. 'Saiba mais', 'Comprar agora'). Max 10 chars. Obrigatório na prática."),
        logoAssetId: z.string().optional().describe("ID de um asset IMAGE quadrado (1:1, mín. 128x128, ex.: 1200x1200) já na conta, usado como logo — a API exige ao menos um. Ache com get_image_assets."),
        businessName: z.string().optional().describe("Nome da marca/anunciante exibido no anúncio (max 25 chars). Obrigatório na prática: a API exige business_name no responsive video ad."),
        longHeadline: z.string().optional().describe("Long headline (max 90 chars). Default: reutiliza headline."),
      },
    },
    async ({ customerId, adGroupId, youtubeVideoId, finalUrl, headline, description, callToAction, logoAssetId, businessName, longHeadline }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const fail = (message: string) => ({ content: [text(message)], isError: true });
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) return fail(`customerId inválido: "${customerId}". Nada foi gravado.`);

      // VideoResponsiveAdInfo (v25) só tem coleções — videos[], headlines[],
      // longHeadlines[], descriptions[], callToActions[], logoImages[] — e a API
      // exige ao menos um item em cada, além de ad.name. O schema mantém os
      // campos opcionais para não mudar o contrato; a exigência fica explícita aqui.
      const faltando = [!headline && "headline", !description && "description", !callToAction && "callToAction", !logoAssetId && "logoAssetId", !businessName && "businessName"].filter(Boolean);
      if (faltando.length > 0) {
        return fail(`Video responsive ad exige ${faltando.join(", ")} (a API rejeita o anúncio sem eles). Nada foi gravado.`);
      }
      const problems: string[] = [];
      if (!/^\d+$/.test(String(adGroupId))) problems.push(`adGroupId deve ser numérico, recebido "${adGroupId}".`);
      if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) problems.push(`youtubeVideoId "${youtubeVideoId}" não é ID de vídeo do YouTube (11 caracteres).`);
      const logoRef = parseImageAssetRef(String(logoAssetId), cid);
      if ("error" in logoRef) problems.push(logoRef.error);
      if (problems.length) return fail(`Nada foi gravado:\n- ${problems.join("\n- ")}`);
      const logo = logoRef as { assetId: string; resourceName: string };

      const client = getClient();

      // Leitura antes de escrever: grupo e logo conferidos ANTES de criar o asset do vídeo
      const groupRows = await client.searchStream(customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
                campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
         FROM ad_group
         WHERE ad_group.id = ${adGroupId}`);
      const group = (groupRows[0]?.adGroup ?? {}) as Record<string, unknown>;
      const campaign = (groupRows[0]?.campaign ?? {}) as Record<string, unknown>;
      if (!groupRows[0]) return fail(`Grupo de anúncios ${adGroupId} não encontrado na conta ${cid}. Nada foi gravado.`);
      if (group.status === "REMOVED") return fail(`Grupo ${adGroupId} ("${group.name}") está removido. Nada foi gravado.`);
      if (campaign.advertisingChannelType === "DEMAND_GEN") {
        return fail(
          `O grupo ${adGroupId} é de campanha Demand Gen ("${campaign.name}"). Em Demand Gen o anúncio de vídeo é ` +
          "DEMAND_GEN_VIDEO_RESPONSIVE_AD, não VIDEO_RESPONSIVE_AD — use a tool de anúncio de vídeo de Demand Gen. Nada foi gravado."
        );
      }
      if (campaign.advertisingChannelType !== "VIDEO") {
        return fail(`O grupo ${adGroupId} é de campanha ${campaign.advertisingChannelType} ("${campaign.name}"), não de Vídeo. Nada foi gravado.`);
      }
      if (group.type !== "VIDEO_RESPONSIVE") {
        return fail(`O grupo ${adGroupId} é do tipo ${group.type}; anúncio de vídeo responsivo vai em grupo VIDEO_RESPONSIVE. Nada foi gravado.`);
      }
      const logoRows = await client.searchStream(customerId,
        `SELECT asset.id, asset.name, asset.type,
                asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels
         FROM asset
         WHERE asset.id = ${logo.assetId}`);
      const logoAsset = (logoRows[0]?.asset ?? {}) as Record<string, unknown>;
      if (!logoRows[0]) return fail(`Logo: asset ${logo.assetId} não existe na conta ${cid}. Nada foi gravado.`);
      if (logoAsset.type !== "IMAGE") return fail(`Logo: asset ${logo.assetId} é ${logoAsset.type}, não IMAGE. Nada foi gravado.`);
      const logoFull = (((logoAsset.imageAsset ?? {}) as Record<string, unknown>).fullSize ?? {}) as Record<string, unknown>;
      const lw = num(logoFull.widthPixels);
      const lh = num(logoFull.heightPixels);
      if (lw && lh && (Math.abs(lw / lh - 1) > 0.01 || lw < 128 || lh < 128)) {
        return fail(`Logo: asset ${logo.assetId} tem ${lw}x${lh}; o logo do anúncio de vídeo precisa ser 1:1 (±1%) e no mínimo 128x128. Nada foi gravado.`);
      }

      // videos[].asset é um resource name de asset YOUTUBE_VIDEO — a API não aceita
      // o id do YouTube direto. Reaproveita o asset se o vídeo já existir na conta;
      // senão cria. Sem id temporário em campo aninhado, cujo suporte não é
      // documentado.
      const found = await client.searchStream(customerId,
        `SELECT asset.resource_name FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' AND asset.youtube_video_asset.youtube_video_id = '${gaqlLiteral(youtubeVideoId)}' LIMIT 1`);
      let videoAsset = (found[0]?.asset as Record<string, unknown> | undefined)?.resourceName as string | undefined;
      let createdVideoAsset = false;
      if (!videoAsset) {
        const assetResult = await client.mutateAssets(customerId, [{ create: { type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId } } }]);
        videoAsset = ((assetResult as Record<string, unknown>).results as Array<Record<string, unknown>>)?.[0]?.resourceName as string | undefined;
        createdVideoAsset = Boolean(videoAsset);
      }
      if (!videoAsset) {
        if (client.isDryRun) {
          return {
            content: [text(
              `DRY-RUN (validateOnly): o asset do vídeo ${youtubeVideoId} seria criado, mas sem ele o anúncio não pode ` +
              "ser validado (em validate_only a API não devolve o ID do asset). Nada foi gravado."
            )],
          };
        }
        return fail(`Error: não foi possível obter o asset do vídeo ${youtubeVideoId}. Nada foi gravado.`);
      }

      const videoAdInfo: Record<string, unknown> = {
        videos: [{ asset: videoAsset }],
        headlines: [{ text: headline }],
        longHeadlines: [{ text: longHeadline ?? headline }],
        descriptions: [{ text: description }],
        callToActions: [{ text: callToAction }],
        // A API exige ao menos um logo (asset IMAGE 1:1) no responsive video ad.
        logoImages: [{ asset: logo.resourceName }],
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

      let result: Record<string, unknown>;
      try {
        result = await client.mutateAdGroupAds(customerId, [{ create: adData }]);
      } catch (err) {
        const message = (err as Error).message;
        const assetNote = createdVideoAsset
          ? `\nO asset do vídeo (${videoAsset}) foi criado antes e continua na biblioteca — pode ser reutilizado.`
          : "";
        if (/MUTATE_REQUIRES_RESERVATION|without reservation|requires? (a )?reservation|MUTATE_NOT_ALLOWED|Mutates are not allowed/i.test(message)) {
          return fail(
            `A API recusou: campanhas de Vídeo não podem ser alteradas pela API sem reserva ` +
            `(VideoCampaignError.MUTATE_REQUIRES_RESERVATION). Crie o anúncio pela interface do Google Ads, ` +
            `ou use Demand Gen (create_demand_gen_campaign + anúncio de vídeo de Demand Gen) para vídeo por API.\n` +
            `Erro da API: ${message}${assetNote}`
          );
        }
        return fail(`A API recusou o anúncio de vídeo: ${message}${assetNote}`);
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): anúncio de vídeo validado pela API — nada foi gravado.`)] };
      }
      return { content: [text(`Video ad created (PAUSED) with video ${youtubeVideoId} (asset ${videoAsset}${createdVideoAsset ? ", criado agora" : ""}).\n\n${formatJson(result)}`)] };
    }
  );

  // create_shopping_campaign: lote shopping (src/tools/shopping.ts).

  // create_demand_gen_campaign: registrada em src/tools/demand-gen.ts (lote demand-gen) — atômica via
  // googleAds:mutate, com mais estratégias de lance, orçamento total e primeiro grupo.

  // ══════════════════════════════════════════════════════════════════
  // ══ TARGETING + AUDIENCES + EXTENSIONS + DELETES ══════════════════
  // ══════════════════════════════════════════════════════════════════

  mcp.registerTool(
    "list_audience_segments",
    {
      description: [
        "Lista segmentos de público. Sem type lista os Audiences (FROM audience), como antes.",
        "Com type busca também USER_LIST, AFFINITY, IN_MARKET, LIFE_EVENT, DETAILED_DEMOGRAPHIC, CUSTOM e COMBINED",
        "— o mesmo que search_audience_segments (lote audiences). Somente leitura.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Trecho do nome (LIKE)."),
        limit: z.number().optional().describe("Máximo de resultados (1–1000). Default: 50."),
        type: z.enum(["AUDIENCE", "USER_LIST", "AFFINITY", "IN_MARKET", "LIFE_EVENT", "DETAILED_DEMOGRAPHIC", "CUSTOM", "COMBINED"])
          .optional().describe("Tipo de segmento. Default: AUDIENCE."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, limit, type, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Implementação no módulo do lote audiences (src/tools/audiences.ts)
      const { searchAudienceSegments } = await import("./tools/audiences.js");
      return searchAudienceSegments(getClient(), customerId, { type: type ?? "AUDIENCE", query, limit, format });
    }
  );

  mcp.registerTool(
    "create_audience_segment",
    {
      description: [
        "Cria um segmento personalizado (custom audience) a partir de keywords, URLs e/ou apps.",
        "WRITE OPERATION — confere nome duplicado antes; membros no formato v25 (member_type + keyword/url/app).",
        "",
        "type: AUTO (default — interesses e intenção) ou SEARCH (quem pesquisou esses termos no Google).",
        "INTEREST e PURCHASE_INTENT não são aceitos em segmentos novos.",
        "Para usar: add_audience_segment_targeting com type CUSTOM_AUDIENCE (Display, Demand Gen, Vídeo).",
        "Para editar membros depois: update_custom_audience.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do segmento (único na conta, sem diferenciar maiúsculas)."),
        description: z.string().optional().describe("Descrição."),
        type: z.enum(["AUTO", "SEARCH"]).optional().describe("Default: AUTO."),
        keywords: flexArray(z.string()).optional().describe("Keywords/frases de interesse (até 10 palavras e 80 caracteres cada)."),
        urls: flexArray(z.string()).optional().describe("URLs com http(s):// de sites que o público visita (ex.: concorrentes)."),
        apps: flexArray(z.string()).optional().describe("Pacotes de apps Android que o público usa (ex.: com.empresa.app)."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const { createCustomAudience } = await import("./tools/audiences.js");
      return createCustomAudience(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "update_ad_group_targeting",
    {
      description: [
        "Adiciona um segmento de público a um grupo de anúncios.",
        "WRITE OPERATION — mesmas validações de add_audience_segment_targeting (level=adGroup), que aceita vários",
        "segmentos, nível de campanha e exclusões.",
        "",
        "O tipo sai do resource name: userLists (remarketing/Customer Match), userInterests (afinidade/no mercado),",
        "customAudiences, combinedAudiences, lifeEvents ou audiences (Audience: só Demand Gen/App com use_audience_grouped).",
        "Com um ID numérico, informe segmentType.",
        "bidModifier só é enviado se informado (1.2 = +20%). Em Pesquisa/Shopping sem restrição, o modo fica Observação.",
        "Se o targeting_setting estiver na campanha (vale para todos os grupos), a tool não troca o modo a partir do grupo:",
        "use set_targeting_mode level=campaign ou targetingMode KEEP.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        adGroupId: z.string().describe("Ad group ID."),
        audienceResourceName: z.string().describe("Resource name do segmento (ou o ID numérico com segmentType)."),
        segmentType: z.enum(["USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE", "COMBINED_AUDIENCE", "LIFE_EVENT", "AUDIENCE"])
          .optional().describe("Tipo do segmento, se não der para inferir do resource name."),
        bidModifier: z.number().optional().describe("Ajuste de lance 0.1–10 (1.0 = sem ajuste). Só se informado."),
        negative: z.boolean().optional().describe("true = exclusão."),
        targetingMode: z.enum(["OBSERVATION", "TARGETING", "KEEP"]).optional().describe("Modo da dimensão AUDIENCE do grupo (ver add_audience_segment_targeting); nunca troca o modo da campanha."),
      },
    },
    async ({ customerId, adGroupId, audienceResourceName, segmentType, bidModifier, negative, targetingMode }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const { addAudienceSegmentTargeting, inferSegmentType } = await import("./tools/audiences.js");
      const type = segmentType ?? inferSegmentType(audienceResourceName);
      if (!type) {
        return {
          content: [text(`Não identifiquei o tipo de "${audienceResourceName}". Passe o resource name completo (customers/{cid}/userLists/{id}, ` +
            `.../audiences/{id} etc.) ou informe segmentType. Nada foi alterado.`)],
          isError: true,
        };
      }
      return addAudienceSegmentTargeting(getClient(), customerId, {
        level: "adGroup",
        adGroupId,
        segments: [{ type, resourceName: audienceResourceName, negative, bidModifier }],
        targetingMode,
      });
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

  // create_conversion_action: registrada em src/tools/conversions-core.ts (lote conversions-core).

  // update_conversion_action: registrada em src/tools/conversions-core.ts (lote conversions-core).

  // ══════════════════════════════════════════════════════════════════
  // ══ P1: LISTING GROUPS + LOCATION + LANGUAGE ══════════════════════
  // ══════════════════════════════════════════════════════════════════

  // set_listing_group_filter: lote shopping (src/tools/shopping.ts).

  // set_campaign_locations e set_campaign_languages: registradas em src/tools/targeting-geo.ts (lote targeting-geo).

  // list_merchant_centers: lote shopping (src/tools/shopping.ts).

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
      description: [
        "Cria um rótulo para organizar campanhas, grupos, anúncios, palavras-chave e contas. WRITE OPERATION.",
        "backgroundColor (hex #RRGGBB ou #RGB) e description (até 200 caracteres) são opcionais.",
        "Se já existe rótulo ativo com o mesmo nome, nada é criado e o existente é devolvido — para mudar cor",
        "ou descrição use update_label. Rótulo criado numa conta de administrador (MCC) serve para rotular",
        "contas clientes (assign_label com resourceType customer).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome do rótulo (1 a 80 caracteres, único na conta)."),
        backgroundColor: z.string().optional().describe("Cor de fundo em hex, ex.: #FF9900."),
        description: z.string().optional().describe("Descrição (até 200 caracteres)."),
      },
    },
    async ({ customerId, name, backgroundColor, description }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const labelName = name.trim();
      const color = backgroundColor?.trim();
      const problems: string[] = [];
      if (labelName.length < 1 || labelName.length > 80) problems.push("name precisa ter de 1 a 80 caracteres");
      if (color !== undefined && !/^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(color)) problems.push(`backgroundColor inválida: "${backgroundColor}" (use #RRGGBB ou #RGB)`);
      if (description !== undefined && description.length > 200) problems.push("description passa de 200 caracteres");
      if (problems.length > 0) return { content: [text(`Nada foi criado:\n- ${problems.join("\n- ")}`)], isError: true };

      const client = getClient();
      const existing = await client.searchStream(customerId,
        `SELECT label.id, label.name, label.status FROM label WHERE label.name = '${gaqlLiteral(labelName)}'`);
      const active = existing.map((row) => (row.label ?? {}) as Record<string, unknown>).find((label) => label.status !== "REMOVED");
      if (active) {
        return { content: [text(`O rótulo "${labelName}" já existe (ID ${active.id}). Nada foi criado — para mudar cor ou descrição use update_label.`)] };
      }
      const create: Record<string, unknown> = { name: labelName };
      const textLabel: Record<string, unknown> = {};
      if (color) textLabel.backgroundColor = color;
      if (description) textLabel.description = description;
      if (Object.keys(textLabel).length > 0) create.textLabel = textLabel;
      let result: Record<string, unknown>;
      try {
        result = await client.mutate(customerId, "labels", [{ create }]);
      } catch (err) {
        return { content: [text(`A API recusou o rótulo "${labelName}". Nada foi criado.\nErro: ${(err as Error).message}`)], isError: true };
      }
      if (client.isDryRun) {
        return { content: [text(`Rótulo "${labelName}" — DRY-RUN (validateOnly): a API validou, nada foi gravado.`)] };
      }
      const resourceName = String((((result.results as Array<Record<string, unknown>>) ?? [])[0] ?? {}).resourceName ?? "");
      return {
        content: [text(
          `Rótulo criado: "${labelName}"${resourceName ? ` (ID ${resourceName.split("/").pop()})` : ""}.\n\n` +
          formatJson({ resource_name: resourceName || null, text_label: create.textLabel ?? null })
        )],
      };
    }
  );

  mcp.registerTool(
    "assign_label",
    {
      description: [
        "Aplica ou tira um rótulo de vários itens de uma vez. WRITE OPERATION (partial failure: um item com",
        "erro não derruba os outros; relatório por item).",
        "",
        "resourceType e formato dos IDs em resourceIds:",
        "- campaign / adGroup: ID numérico",
        "- adGroupAd: adGroupId~adId",
        "- adGroupCriterion (palavra-chave): adGroupId~criterionId — não vale para negativas",
        "- customer: IDs das CONTAS CLIENTES; customerId é a conta de administrador (MCC) dona do rótulo",
        "  (uma requisição por conta, como a API exige). Rótulo de MCC só serve para contas.",
        "action: assign (padrão) ou unassign (pede confirm: true). Itens que já estão no estado pedido não",
        "são reenviados. Máximo de 1000 itens por chamada; a API aceita até 50 rótulos por item.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID (em resourceType customer: a conta de administrador dona do rótulo)."),
        resourceType: z.enum(["campaign", "adGroup", "adGroupAd", "adGroupCriterion", "customer"]).describe("Tipo do item."),
        resourceIds: flexArray(z.string()).optional().describe("IDs dos itens (formato acima)."),
        resourceId: z.string().optional().describe("Um ID só (compatibilidade; prefira resourceIds)."),
        labelId: z.string().describe("ID do rótulo (list_labels)."),
        action: z.enum(["assign", "unassign"]).optional().describe("assign (padrão) ou unassign."),
        confirm: z.boolean().optional().describe("true para unassign."),
      },
    },
    async ({ customerId, resourceType, resourceIds, resourceId, labelId, action, confirm }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      const mode = action ?? "assign";
      const ids = [...new Set([...ensureArray<string>(resourceIds), ...(resourceId !== undefined ? [resourceId] : [])]
        .map((id) => (resourceType === "customer" ? String(id).trim().replace(/-/g, "") : String(id).trim()))
        .filter(Boolean))];
      const pattern = resourceType === "adGroupAd" || resourceType === "adGroupCriterion" ? /^\d+~\d+$/ : /^\d+$/;
      const problems: string[] = [];
      if (!/^\d+$/.test(cid)) problems.push(`customerId inválido: "${customerId}"`);
      if (!/^\d+$/.test(labelId)) problems.push(`labelId deve ser numérico (recebido "${labelId}")`);
      if (ids.length === 0) problems.push("informe resourceIds");
      if (ids.length > 1000) problems.push(`máximo de 1000 itens por chamada (recebido ${ids.length})`);
      const badIds = ids.filter((id) => !pattern.test(id));
      if (badIds.length > 0) {
        const hint = { campaign: "ID numérico", adGroup: "ID numérico", adGroupAd: "adGroupId~adId", adGroupCriterion: "adGroupId~criterionId", customer: "ID da conta" }[resourceType];
        problems.push(`IDs fora do formato ${hint}: ${badIds.join(", ")}`);
      }
      if (resourceType === "customer") {
        const denied = ids.filter((id) => checkCustomerAccess(id, allowedCustomerIds, hosted));
        if (denied.length > 0) problems.push(`contas fora da allowlist: ${denied.join(", ")}`);
      }
      if (problems.length > 0) return { content: [text(`Nada foi alterado:\n- ${problems.join("\n- ")}`)], isError: true };

      const client = getClient();
      const dryRun = client.isDryRun;
      const labelRows = await client.searchStream(customerId, `SELECT label.id, label.name, label.status FROM label WHERE label.id = ${labelId}`);
      const label = labelRows[0]?.label as Record<string, unknown> | undefined;
      if (!label) return { content: [text(`Rótulo ${labelId} não encontrado na conta ${cid}. Nada foi alterado.`)], isError: true };
      if (label.status === "REMOVED" && mode === "assign") return { content: [text(`Rótulo ${labelId} ("${label.name}") está removido e não pode ser aplicado. Nada foi alterado.`)], isError: true };
      const labelResource = `customers/${cid}/labels/${labelId}`;
      const labelLine = `Rótulo ${labelId} ("${label.name}")`;
      const done: Array<Record<string, unknown>> = [];
      const errors: Array<Record<string, unknown>> = [];
      const unchanged: string[] = [];
      const notFound: string[] = [];

      if (resourceType === "customer") {
        // Um MutateCustomerLabelsRequest só mexe numa conta: uma chamada por conta cliente.
        const plan: Array<{ id: string; linked: string | undefined }> = [];
        for (const clientId of ids) {
          try {
            const rows = await client.searchStream(clientId,
              `SELECT customer_label.resource_name, customer_label.label FROM customer_label WHERE customer_label.label = '${labelResource}'`);
            const linked = rows.map((row) => String(((row.customerLabel ?? {}) as Record<string, unknown>).resourceName ?? "")).find(Boolean);
            if ((mode === "assign") === Boolean(linked)) unchanged.push(clientId);
            else plan.push({ id: clientId, linked });
          } catch (err) {
            errors.push({ id: clientId, error: (err as Error).message });
          }
        }
        if (plan.length > 0 && mode === "unassign" && confirm !== true) {
          return { content: [text(`${labelLine} vai sair de ${plan.length} conta(s): ${plan.map((item) => item.id).join(", ")}. Nada foi alterado — repita com confirm: true.`)], isError: true };
        }
        for (const item of plan) {
          try {
            const response = await client.mutate(item.id, "customerLabels", [
              mode === "assign" ? { create: { label: labelResource } } : { remove: item.linked ?? `customers/${item.id}/customerLabels/${labelId}` },
            ]);
            const confirmed = String((((response.results as Array<Record<string, unknown>>) ?? [])[0] ?? {}).resourceName ?? "");
            if (!dryRun && !confirmed) errors.push({ id: item.id, error: "a API não confirmou a operação" });
            else done.push({ id: item.id });
          } catch (err) {
            errors.push({ id: item.id, error: (err as Error).message });
          }
        }
      } else {
        const spec = {
          campaign: { service: "campaignLabels", field: "campaign", path: "campaigns" },
          adGroup: { service: "adGroupLabels", field: "adGroup", path: "adGroups" },
          adGroupAd: { service: "adGroupAdLabels", field: "adGroupAd", path: "adGroupAds" },
          adGroupCriterion: { service: "adGroupCriterionLabels", field: "adGroupCriterion", path: "adGroupCriteria" },
        }[resourceType];
        const firsts = [...new Set(ids.map((id) => id.split("~")[0]))];
        const lasts = [...new Set(ids.map((id) => id.split("~").pop() as string))];
        const targets = new Map<string, Record<string, unknown>>();
        const links = new Map<string, string>();
        const get = (row: Record<string, unknown>, key: string) => (row[key] ?? {}) as Record<string, unknown>;
        if (resourceType === "campaign") {
          for (const row of await client.searchStream(customerId, `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id IN (${ids.join(", ")})`)) {
            targets.set(String(get(row, "campaign").id), get(row, "campaign"));
          }
          for (const row of await client.searchStream(customerId, `SELECT campaign.id, campaign_label.resource_name FROM campaign_label WHERE label.id = ${labelId} AND campaign.id IN (${ids.join(", ")})`)) {
            links.set(String(get(row, "campaign").id), String(get(row, "campaignLabel").resourceName));
          }
        } else if (resourceType === "adGroup") {
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id IN (${ids.join(", ")})`)) {
            targets.set(String(get(row, "adGroup").id), get(row, "adGroup"));
          }
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group_label.resource_name FROM ad_group_label WHERE label.id = ${labelId} AND ad_group.id IN (${ids.join(", ")})`)) {
            links.set(String(get(row, "adGroup").id), String(get(row, "adGroupLabel").resourceName));
          }
        } else if (resourceType === "adGroupAd") {
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.ad.id IN (${lasts.join(", ")}) AND ad_group.id IN (${firsts.join(", ")})`)) {
            const adGroupAd = get(row, "adGroupAd");
            targets.set(`${get(row, "adGroup").id}~${get(adGroupAd, "ad").id}`, { status: adGroupAd.status });
          }
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad_label.resource_name FROM ad_group_ad_label WHERE label.id = ${labelId} AND ad_group_ad.ad.id IN (${lasts.join(", ")})`)) {
            links.set(`${get(row, "adGroup").id}~${get(get(row, "adGroupAd"), "ad").id}`, String(get(row, "adGroupAdLabel").resourceName));
          }
        } else {
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group_criterion.criterion_id IN (${lasts.join(", ")}) AND ad_group.id IN (${firsts.join(", ")})`)) {
            const criterion = get(row, "adGroupCriterion");
            targets.set(`${get(row, "adGroup").id}~${criterion.criterionId}`, criterion);
          }
          for (const row of await client.searchStream(customerId, `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion_label.resource_name FROM ad_group_criterion_label WHERE label.id = ${labelId} AND ad_group_criterion.criterion_id IN (${lasts.join(", ")})`)) {
            links.set(`${get(row, "adGroup").id}~${get(row, "adGroupCriterion").criterionId}`, String(get(row, "adGroupCriterionLabel").resourceName));
          }
        }
        const operations: Array<Record<string, unknown>> = [];
        const planned: string[] = [];
        for (const id of ids) {
          const target = targets.get(id);
          if (!target && !(mode === "unassign" && links.has(id))) { notFound.push(id); continue; }
          if (mode === "assign") {
            if (links.has(id)) { unchanged.push(id); continue; }
            if (target?.status === "REMOVED") { errors.push({ id, error: "item removido — rótulo não pode ser aplicado" }); continue; }
            if (target?.negative === true) { errors.push({ id, error: "palavra-chave negativa não aceita rótulo (CANNOT_APPLY_LABEL_TO_NEGATIVE_AD_GROUP_CRITERION)" }); continue; }
            operations.push({ create: { [spec.field]: `customers/${cid}/${spec.path}/${id}`, label: labelResource } });
          } else {
            if (!links.has(id)) { unchanged.push(id); continue; }
            operations.push({ remove: links.get(id) });
          }
          planned.push(id);
        }
        if (operations.length > 0 && mode === "unassign" && confirm !== true) {
          return { content: [text(`${labelLine} vai sair de ${operations.length} ${resourceType}: ${planned.join(", ")}. Nada foi alterado — repita com confirm: true.`)], isError: true };
        }
        if (operations.length > 0) {
          try {
            const response = await client.mutate(customerId, spec.service, operations as unknown as import("./google-ads-client.js").MutateOperation[], { partialFailure: true });
            const results = (response.results as Array<Record<string, unknown>>) ?? [];
            const { byIndex, unattributed } = partialFailureByOperation(response.partialFailureError, operations.length);
            planned.forEach((id, index) => {
              const opErrors = byIndex.get(index);
              if (opErrors) errors.push({ id, error: opErrors.join("; ") });
              else if (!dryRun && !results[index]?.resourceName) errors.push({ id, error: "a API não confirmou a operação" });
              else done.push({ id });
            });
            for (const message of unattributed) errors.push({ error: message });
          } catch (err) {
            for (const id of planned) errors.push({ id, error: (err as Error).message });
          }
        }
      }

      const verb = mode === "assign" ? "aplicado em" : "retirado de";
      const header = dryRun
        ? `${labelLine} — DRY-RUN (validateOnly): nada foi gravado. Validados: ${done.length}`
        : `${labelLine} ${verb} ${done.length} ${resourceType}`;
      return {
        content: [text(
          `${header} | já estavam assim: ${unchanged.length} | não encontrados: ${notFound.length} | com erro: ${errors.length}\n\n` +
          formatJson({ [dryRun ? "validated" : mode === "assign" ? "assigned" : "unassigned"]: done, unchanged, not_found: notFound, errors })
        )],
        isError: errors.length > 0 || notFound.length > 0,
      };
    }
  );

  mcp.registerTool(
    "list_labels",
    {
      description: [
        "Lista os rótulos da conta com cor, descrição e quantos itens usam cada um (campanhas, grupos,",
        "anúncios, palavras-chave e contas). READ OPERATION.",
        "accounts = contas clientes com o rótulo — só rótulo de conta de administrador (MCC) vai em conta; a",
        "contagem vem de customer_client.applied_labels, consultado no MCC.",
        "Filtre relatórios por rótulo com get_label_performance e mude status em lote com",
        "update_status_by_label (ambos usam o ID do rótulo).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        includeRemoved: z.boolean().optional().describe("Inclui rótulos removidos. Padrão false."),
        withCounts: z.boolean().optional().describe("Conta os itens por rótulo (padrão true)."),
        format: formatSchema,
      },
    },
    async ({ customerId, includeRemoved, withCounts, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const client = getClient();
      const results = await client.searchStream(customerId,
        `SELECT label.id, label.name, label.status, label.text_label.background_color, label.text_label.description
         FROM label${includeRemoved ? "" : " WHERE label.status = 'ENABLED'"}
         ORDER BY label.name`);
      const counts = new Map<string, Record<string, number | null>>();
      const countKeys = ["campaigns", "ad_groups", "ads", "keywords", "accounts"] as const;
      if (withCounts !== false && results.length > 0) {
        const sources: Array<[typeof countKeys[number], string]> = [
          ["campaigns", "SELECT label.id, campaign_label.resource_name FROM campaign_label"],
          ["ad_groups", "SELECT label.id, ad_group_label.resource_name FROM ad_group_label"],
          ["ads", "SELECT label.id, ad_group_ad_label.resource_name FROM ad_group_ad_label"],
          ["keywords", "SELECT label.id, ad_group_criterion_label.resource_name FROM ad_group_criterion_label"],
          // O vínculo CustomerLabel fica na conta rotulada (customers/{cliente}/customerLabels/...), não no MCC:
          // do MCC, quem mostra os rótulos dele aplicados em cada conta é customer_client.applied_labels.
          ["accounts", "SELECT customer_client.id, customer_client.applied_labels FROM customer_client"],
        ];
        for (const [key, query] of sources) {
          let rows: Array<Record<string, unknown>> | undefined;
          try {
            rows = await client.searchStream(customerId, query);
          } catch {
            rows = undefined; // ex.: conta de administrador não tem campanhas
          }
          for (const row of results) {
            const id = String(((row.label ?? {}) as Record<string, unknown>).id ?? "");
            const entry = counts.get(id) ?? {};
            entry[key] = rows === undefined ? null : 0;
            counts.set(id, entry);
          }
          if (key === "accounts") {
            // Conta cada conta cliente uma vez por rótulo, só com rótulos desta conta (customers/{cid}/labels/{id}).
            const ownPrefix = `customers/${customerId.replace(/-/g, "")}/labels/`;
            const clientsByLabel = new Map<string, Set<string>>();
            for (const row of rows ?? []) {
              const customerClient = (row.customerClient ?? {}) as Record<string, unknown>;
              const applied = Array.isArray(customerClient.appliedLabels) ? customerClient.appliedLabels : [];
              for (const labelResource of applied.map(String).filter((resource) => resource.startsWith(ownPrefix))) {
                const id = labelResource.slice(ownPrefix.length);
                const clients = clientsByLabel.get(id) ?? new Set<string>();
                clients.add(String(customerClient.id ?? ""));
                clientsByLabel.set(id, clients);
              }
            }
            for (const [id, clients] of clientsByLabel) {
              const entry = counts.get(id);
              if (entry && entry[key] !== null) entry[key] = clients.size;
            }
            continue;
          }
          for (const row of rows ?? []) {
            const id = String(((row.label ?? {}) as Record<string, unknown>).id ?? "");
            const entry = counts.get(id);
            if (entry && entry[key] !== null) entry[key] = (entry[key] ?? 0) + 1;
          }
        }
      }
      const labels = results.map((row) => {
        const label = (row.label ?? {}) as Record<string, unknown>;
        const textLabel = (label.textLabel ?? {}) as Record<string, unknown>;
        const id = String(label.id ?? "");
        return {
          id,
          name: label.name,
          status: label.status,
          background_color: textLabel.backgroundColor ?? null,
          description: textLabel.description ?? null,
          ...(withCounts !== false ? Object.fromEntries(countKeys.map((key) => [key, counts.get(id)?.[key] ?? 0])) : {}),
        };
      });
      if (format === "table") return { content: [text(formatAsTable(labels as Array<Record<string, unknown>>))] };
      if (format === "csv") return { content: [text(formatAsCsv(labels as Array<Record<string, unknown>>))] };
      return { content: [text(`${labels.length} rótulo(s).\n\n${formatJson(labels)}`)] };
    }
  );

  // create_shared_negative_list: implementada em src/tools/negatives.ts (lote negatives).

  // ══ REMARKETING LISTS ══════════════════════════════════════════════

  mcp.registerTool(
    "list_remarketing_lists",
    {
      description: [
        "Lista as listas de público da conta (remarketing, lógicas, Customer Match...) com tamanho e status.",
        "Mostra tipo, tamanhos (Display/Pesquisa e faixas), membership_status (OPEN/CLOSED, inclusive fechadas),",
        "a regra legível das listas rule-based (com a janela de cada regra), a pré-população, a combinação das",
        "listas lógicas e a taxa de correspondência das listas de Customer Match. Somente leitura.",
        "Em rule-based/lógicas, membership_days é null: a API ignora essa duração — ela está nas regras.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        query: z.string().optional().describe("Trecho do nome (LIKE)."),
        type: z.enum(["REMARKETING", "LOGICAL", "EXTERNAL_REMARKETING", "RULE_BASED", "SIMILAR", "CRM_BASED", "LOOKALIKE"])
          .optional().describe("Filtra por tipo."),
        format: formatSchema,
      },
    },
    async ({ customerId, query, type, format }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Implementação no módulo do lote audiences (src/tools/audiences.ts)
      const { listRemarketingLists } = await import("./tools/audiences.js");
      return listRemarketingLists(getClient(), customerId, { query, type, format });
    }
  );

  mcp.registerTool(
    "add_audience_signal",
    {
      description: [
        "Adiciona UM sinal a um grupo de recursos Performance Max: um público (Audience) ou um tema de pesquisa.",
        "WRITE OPERATION.",
        "",
        "Sinais orientam o PMax sobre quem priorizar — não restringem a segmentação.",
        "- audience: vincula um público existente (ID ou customers/{cid}/audiences/{id}). O grupo aceita UM público;",
        "  se já houver outro, a tool recusa e indica manage_asset_group_signals (troca) ou update_audience (edição).",
        "- search_theme: tema de pesquisa de até 10 palavras; tema já existente não é reenviado.",
        "",
        "Confere antes que o grupo existe, é de PMax e não está removido. Para vários sinais de uma vez, remoções e",
        "relatório por item: manage_asset_group_signals. Para montar o público: create_audience.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        assetGroupId: z.string().describe("ID do grupo de recursos PMax."),
        signalType: z.enum(["audience", "search_theme"]).describe("Tipo de sinal."),
        audienceResourceName: z.string().optional().describe("Tipo 'audience': ID ou resource name do público (create_audience cria um)."),
        searchThemeText: z.string().optional().describe("Tipo 'search_theme': o tema (até 10 palavras)."),
      },
    },
    async ({ customerId, assetGroupId, signalType, audienceResourceName, searchThemeText }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Implementação no módulo do lote pmax-signals (validação, leitura antes da escrita, dry-run)
      const { addAudienceSignal } = await import("./tools/pmax-signals.js");
      return addAudienceSignal(getClient(), customerId, { assetGroupId, signalType, audienceResourceName, searchThemeText });
    }
  );

  mcp.registerTool(
    "create_audience_from_lists",
    {
      description: [
        "Cria um público (Audience) a partir de listas de público existentes (remarketing, Customer Match, GA4).",
        "WRITE OPERATION.",
        "",
        "Atalho de create_audience só com listas. Confere antes que cada lista existe na conta e que o nome não",
        "está em uso. Depois vincule como sinal com add_audience_signal ou manage_asset_group_signals.",
        "Para combinar com interesses, segmentos personalizados, demografia ou exclusões, use create_audience.",
        "Use listas já populadas (list_remarketing_lists) — lista vazia não ajuda o sinal.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome único do público."),
        userListResourceNames: flexArray(z.string()).describe("Listas: customers/{cid}/userLists/{id} ou só o ID numérico."),
      },
    },
    async ({ customerId, name, userListResourceNames }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerId.replace(/-/g, "");
      if (!/^\d+$/.test(cid)) return { content: [text(`customerId inválido: "${customerId}". Nada foi criado.`)], isError: true };
      if (ensureArray<unknown>(userListResourceNames).length === 0) {
        return { content: [text("Informe ao menos uma lista em userListResourceNames. Nada foi criado.")], isError: true };
      }
      // Implementação no módulo do lote pmax-signals (mesmo núcleo de create_audience)
      const { createAudienceCore } = await import("./tools/pmax-signals.js");
      return createAudienceCore(getClient(), cid, {
        toolName: "create_audience_from_lists",
        name,
        scope: "CUSTOMER",
        userLists: userListResourceNames,
      });
    }
  );

  mcp.registerTool(
    "create_remarketing_list",
    {
      description: [
        "Cria uma lista de remarketing por regras (visitantes do site).",
        "WRITE OPERATION — confere nome duplicado antes.",
        "",
        "Cada regra vira um operando próprio com a sua janela (lookbackDays, default membershipLifeSpan):",
        "- ruleOperator OR (default): visitou A OU B; AND: visitou A E B (cada um na sua janela).",
        "- excludeRules: cada exclusão é um operando, combinadas em OU (ex.: excluir quem comprou OU finalizou).",
        "- ruleType: URL_CONTAINS, URL_EQUALS, URL_STARTS_WITH, URL_ENDS_WITH, REFERRER_URL_CONTAINS ou",
        "  CUSTOM_PARAMETER {parameterName, operator, value} para parâmetros que a tag envia (ex.: ecomm_pagetype).",
        "  CUSTOM_EVENT foi retirado (gravava ecomm_pagetype, o que não é evento).",
        "- prepopulate (default true): inclui quem já visitou (até 30 dias, só Display); sem isso a lista começa vazia.",
        "",
        "Para combinar listas (ex.: carrinho E NÃO compradores): create_logical_user_list.",
        "Listas do GA4 sincronizam sozinhas; Customer Match: create_customer_match_list.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        name: z.string().describe("Nome da lista (único na conta)."),
        description: z.string().optional().describe("Descrição."),
        membershipLifeSpan: z.number().describe("Janela padrão de cada regra, em dias (1–540). Comuns: 30, 60, 90."),
        rules: z.array(z.object({
          ruleType: z.enum(["URL_CONTAINS", "URL_EQUALS", "URL_STARTS_WITH", "URL_ENDS_WITH", "REFERRER_URL_CONTAINS", "CUSTOM_PARAMETER", "CUSTOM_EVENT"])
            .describe("Tipo da regra."),
          value: z.string().describe("Trecho/URL, ou o valor do parâmetro."),
          parameterName: z.string().optional().describe("CUSTOM_PARAMETER: nome do parâmetro da tag."),
          operator: z.enum([
            "CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "NOT_EQUALS", "NOT_CONTAINS", "NOT_STARTS_WITH", "NOT_ENDS_WITH",
            "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL",
          ]).optional().describe("CUSTOM_PARAMETER: operador. Default: EQUALS."),
          valueType: z.enum(["STRING", "NUMBER"]).optional().describe("CUSTOM_PARAMETER: tipo do valor. Default: STRING (GREATER/LESS usam NUMBER)."),
          lookbackDays: z.number().optional().describe("Janela desta regra (1–540). Default: membershipLifeSpan."),
        })).describe("Regras de inclusão."),
        ruleOperator: z.enum(["AND", "OR"]).optional().describe("Como combinar as regras de inclusão. Default: OR."),
        excludeRules: z.array(z.object({
          ruleType: z.enum(["URL_CONTAINS", "URL_EQUALS", "URL_STARTS_WITH", "URL_ENDS_WITH", "REFERRER_URL_CONTAINS", "CUSTOM_PARAMETER", "CUSTOM_EVENT"])
            .describe("Tipo da regra de exclusão."),
          value: z.string().describe("Valor da exclusão."),
          parameterName: z.string().optional(),
          operator: z.enum([
            "CONTAINS", "EQUALS", "STARTS_WITH", "ENDS_WITH", "NOT_EQUALS", "NOT_CONTAINS", "NOT_STARTS_WITH", "NOT_ENDS_WITH",
            "GREATER_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN", "LESS_THAN_OR_EQUAL",
          ]).optional(),
          valueType: z.enum(["STRING", "NUMBER"]).optional(),
          lookbackDays: z.number().optional().describe("Janela desta exclusão. Default: excludeLifeSpan ou membershipLifeSpan."),
        })).optional().describe("Exclusões (ex.: compradores), combinadas em OU."),
        excludeLifeSpan: z.number().optional().describe("Janela padrão das exclusões (ex.: 7 = compradores dos últimos 7 dias). Default: membershipLifeSpan."),
        prepopulate: z.boolean().optional().describe("Inclui visitantes passados (REQUESTED). Default: true."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      // Implementação no módulo do lote audiences (src/tools/audiences.ts)
      const { createRemarketingList } = await import("./tools/audiences.js");
      return createRemarketingList(getClient(), customerId, args);
    }
  );

  mcp.registerTool(
    "update_remarketing_list",
    {
      description: [
        "Edita uma lista de público: nome, descrição, duração, status (OPEN/CLOSED) e elegibilidade para Pesquisa.",
        "WRITE OPERATION — lê antes, mostra antes/depois e não grava se nada muda.",
        "",
        "Duração (membershipLifeSpan) só vale para listas que não são rule-based nem lógicas (ex.: Customer Match):",
        "nas rule-based a duração é a janela de cada regra, e as regras não mudam depois de criadas — crie outra lista.",
        "Fechar (CLOSED) para de acumular membros e exige confirm: true.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userListId: z.string().describe("User list ID."),
        name: z.string().optional().describe("Novo nome."),
        description: z.string().optional().describe("Nova descrição."),
        membershipLifeSpan: z.number().optional().describe("Nova duração em dias (1–540). Não vale para rule-based/lógicas."),
        status: z.enum(["OPEN", "CLOSED"]).optional().describe("OPEN = acumula membros; CLOSED = para de acumular."),
        eligibleForSearch: z.boolean().optional().describe("Elegível para a rede de Pesquisa."),
        confirm: z.boolean().optional().describe("Obrigatório true para fechar (CLOSED)."),
      },
    },
    async ({ customerId, ...args }) => {
      const blocked = checkCustomerAccess(customerId, allowedCustomerIds, hosted);
      if (blocked) return { content: [blocked], isError: true };
      const { updateRemarketingList } = await import("./tools/audiences.js");
      return updateRemarketingList(getClient(), customerId, args);
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
      /* Lê a moeda direto da conta: getAccountCurrency cai em "BRL" quando a
         linha não vem, e aqui um "BRL" inventado seria lido como resposta. */
      const result = await client.getCustomer(customerId);
      const currency = ((result.customer ?? {}) as Record<string, unknown>).currencyCode;
      if (typeof currency !== "string" || !currency) {
        return { content: [text(`A API não devolveu a moeda da conta ${customerId} — confira o customerId e o acesso (check_api_access).`)], isError: true };
      }
      return { content: [text(currency)] };
    }
  );
  // ══════════════════════════════════════════════════════════════════
  // ══ PLANEJAMENTO, RECOMENDAÇÕES E CONVERSÕES OFFLINE ══════════════
  // ══════════════════════════════════════════════════════════════════

  // generate_keyword_ideas — implementação em src/tools/planner-recommendations.ts (lote planner-recommendations).

  // list_geo_targets: registrada em src/tools/targeting-geo.ts (lote targeting-geo).

  // list_recommendations, apply_recommendation, dismiss_recommendation — implementação em src/tools/planner-recommendations.ts (lote planner-recommendations).

  // set_campaign_conversion_goals: registrada em src/tools/conversions-core.ts (lote conversions-core).

  // upload_offline_conversion: movida para src/tools/conversions-offline.ts (lote conversions-offline).

  // get_asset_performance: registrada em src/tools/rsa-ads.ts (lote rsa-ads).

  // ── Módulos por área (src/tools/) ─────────────────────────────────
  const context = { mcp, getClient, allowedCustomerIds, hosted };
  for (const register of TOOL_MODULES) register(context);
}
