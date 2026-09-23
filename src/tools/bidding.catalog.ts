/**
 * Catálogo do lote bidding (Estratégias de lance, simulações, sazonalidade e datas de campanha): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "get_bid_simulations",
    "list_bidding_adjustments",
    "list_bidding_strategies",
    "get_ad_group_bid_targets",
  ] as string[],
  write: [
    "create_seasonality_adjustment",
    "create_data_exclusion",
    "update_bidding_adjustment",
    "remove_bidding_adjustments",
    "create_bidding_strategy",
    "update_bidding_strategy",
    "assign_bidding_strategy",
    "remove_bidding_strategy",
  ] as string[],
  // Nenhuma grava em passos encadeados: cada tool é um único :mutate.
  chained: [] as string[],
};
