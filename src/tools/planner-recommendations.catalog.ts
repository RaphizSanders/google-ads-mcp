/**
 * Catálogo do lote planner-recommendations (Planejador de palavras-chave e recomendações): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * generate_keyword_ideas, list_recommendations, get_change_history (read) e apply_recommendation,
 * dismiss_recommendation (write) também moram no módulo, mas continuam classificadas no núcleo
 * (src/read-only.ts), de onde vieram.
 */
export const catalog = {
  read: [
    "get_keyword_historical_metrics",
    "forecast_search_campaign",
    "suggest_ad_group_themes",
    "generate_recommendations",
    "list_recommendation_subscriptions",
  ] as string[],
  write: [
    "set_recommendation_subscription",
  ] as string[],
  chained: [] as string[],
};
