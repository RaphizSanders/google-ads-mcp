import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerGoogleAdsPrompts(mcp: McpServer): void {
  mcp.registerPrompt(
    "weekly_review",
    {
      title: "Revisão semanal de performance",
      description:
        "Fluxo para revisar performance da conta nos últimos 7 dias e sugerir ações.",
      argsSchema: {
        customerId: z
          .string()
          .optional()
          .describe("Customer ID. Se omitido, listar contas primeiro."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Execute uma revisão semanal de performance Google Ads.",
              args.customerId
                ? `Use a conta ${args.customerId}.`
                : "Chame google_list_accounts e escolha a conta desejada.",
              "Passos:",
              "1) google_get_campaign_performance com days=7",
              "2) google_get_performance_alerts com days=7",
              "3) google_get_purchase_conversions com days=7 (para separar compras de outras conversões)",
              "4) Identifique: campanhas com ROAS < 1 (pausar?), campanhas com ROAS > 5 e impression share < 80% (escalar?)",
              "5) Resuma em linguagem natural e sugira até 5 ações concretas (ex: pausar keyword X, aumentar budget da campanha Y, adicionar negativo Z).",
            ].join(" "),
          },
        },
      ],
    })
  );

  mcp.registerPrompt(
    "compare_periods",
    {
      title: "Comparar períodos de performance",
      description:
        "Compara performance entre dois períodos e destaca o que melhorou ou piorou.",
      argsSchema: {
        customerId: z.string().describe("Customer ID."),
        periodA_since: z.string().describe("Início período recente (YYYY-MM-DD)."),
        periodA_until: z.string().describe("Fim período recente (YYYY-MM-DD)."),
        periodB_since: z.string().describe("Início período anterior (YYYY-MM-DD)."),
        periodB_until: z.string().describe("Fim período anterior (YYYY-MM-DD)."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Compare a performance da conta ${args.customerId} entre dois períodos.`,
              `Período A (recente): ${args.periodA_since} a ${args.periodA_until}.`,
              `Período B (anterior): ${args.periodB_since} a ${args.periodB_until}.`,
              "Passos:",
              "1) google_compare_periods com os dois períodos",
              "2) Analise: spend subiu/caiu? ROAS melhorou? Conversões subiram?",
              "3) Se ROAS caiu, investigue: google_get_campaign_performance em cada período",
              "4) Resuma com deltas absolutos e percentuais. Destaque tendências preocupantes.",
            ].join(" "),
          },
        },
      ],
    })
  );

  mcp.registerPrompt(
    "campaign_diagnosis",
    {
      title: "Diagnóstico de campanha",
      description: "Deep dive em uma campanha específica: config, trend, keywords, e ação recomendada.",
      argsSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().describe("Campaign ID."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Faça um diagnóstico completo da campanha ${args.campaignId} na conta ${args.customerId}.`,
              "Passos:",
              "1) google_run_gaql para buscar config da campanha (bidding, budget, status)",
              "2) google_get_daily_trend com campaignId para ver tendência diária (14 dias)",
              "3) google_get_keyword_performance com campaignId (se Search)",
              "4) google_get_search_terms com campaignId para ver termos reais",
              "5) Analise: a campanha está em fase de crescimento ou declínio? Keywords problemáticas? Termos irrelevantes?",
              "6) Recomende ação: escalar, otimizar keywords, adicionar negativos, ou pausar.",
            ].join(" "),
          },
        },
      ],
    })
  );

  mcp.registerPrompt(
    "keyword_optimization",
    {
      title: "Otimização de keywords",
      description: "Análise de keywords + search terms + sugestões de negativos.",
      argsSchema: {
        customerId: z.string().describe("Customer ID."),
        campaignId: z.string().optional().describe("Campaign ID (opcional, filtra por campanha)."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Otimize keywords para ${args.campaignId ? `campanha ${args.campaignId}` : "todas as campanhas"} da conta ${args.customerId}.`,
              "Passos:",
              "1) google_get_keyword_performance (30 dias) — identifique keywords com spend > R$50 e 0 conversões",
              "2) google_get_search_terms (30 dias) — identifique termos irrelevantes com spend",
              "3) google_list_negative_keywords — veja negativos já adicionados",
              "4) Sugira:",
              "   - Keywords para pausar (alto spend, zero conversão)",
              "   - Negativos para adicionar (termos irrelevantes gastando)",
              "   - Keywords para escalar (bom ROAS, baixo impression share)",
              "5) Liste cada ação com valores concretos (quanto se economiza, ROAS esperado).",
            ].join(" "),
          },
        },
      ],
    })
  );

  mcp.registerPrompt(
    "budget_optimization",
    {
      title: "Otimização de budget",
      description: "Realocação de budget baseada em ROAS por campanha.",
      argsSchema: {
        customerId: z.string().describe("Customer ID."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Otimize a alocação de budget da conta ${args.customerId}.`,
              "Passos:",
              "1) google_get_campaign_performance (30 dias) — todas as campanhas",
              "2) google_get_purchase_conversions (30 dias) — compras reais por campanha",
              "3) Classifique: ROAS > 5x = escalar, ROAS 1-5x = manter, ROAS < 1x = reduzir/pausar",
              "4) Proponha realocação: tirar budget de campanhas ROAS < 1x → mover para ROAS > 5x",
              "5) Calcule impacto projetado: 'se mover R$X da campanha A para B, estimamos +Y conversões'",
              "6) Liste ações ordenadas por impacto (maior economia/ganho primeiro).",
            ].join(" "),
          },
        },
      ],
    })
  );

  mcp.registerPrompt(
    "full_account_audit",
    {
      title: "Auditoria completa da conta",
      description: "Auditoria completa: overview → campanhas → keywords → search terms → alertas → relatório.",
      argsSchema: {
        customerId: z.string().describe("Customer ID."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Execute uma auditoria completa da conta Google Ads ${args.customerId}.`,
              "Passos:",
              "1) google_get_account_info — verificar currency e timezone",
              "2) google_get_campaign_performance (30 dias) — overview de campanhas",
              "3) google_get_purchase_conversions (30 dias) — separar compras reais",
              "4) google_get_performance_alerts (30 dias) — detectar problemas",
              "5) google_get_keyword_performance (30 dias) — top/worst keywords",
              "6) google_get_search_terms (30 dias) — termos irrelevantes",
              "7) google_get_device_breakdown (30 dias) — eficiência por device",
              "8) google_get_shopping_products (30 dias) — se tem Shopping/PMax",
              "9) Gere relatório consolidado com:",
              "   - Resumo executivo (3 parágrafos)",
              "   - KPIs da conta (spend, ROAS, conversões, CPA)",
              "   - Top 3 campanhas e Bottom 3",
              "   - Alertas prioritários",
              "   - Top 5 ações recomendadas (ordenadas por impacto)",
            ].join(" "),
          },
        },
      ],
    })
  );
}
