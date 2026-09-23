/**
 * Catálogo do lote retail-reporting (Relatórios de varejo, status de produtos, canais do PMax e listas de marcas): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * get_shopping_products também é registrada neste módulo (foi movida de src/tools.ts), mas
 * continua classificada como leitura em src/read-only.ts — por isso não se repete aqui.
 * Nenhuma escrita deste lote é encadeada: create_brand_list e attach_brand_list usam uma única
 * chamada atômica (googleAds:mutate com ID temporário), então o validateOnly funciona nelas.
 */
export const catalog = {
  read: [
    "get_pmax_channel_performance",
    "get_product_status",
    "get_listing_group_performance",
    "get_cart_data_sales",
    "suggest_brands",
    "list_brand_lists",
  ] as string[],
  write: [
    "create_brand_list",
    "update_brand_list",
    "attach_brand_list",
    "detach_brand_list",
  ] as string[],
  chained: [] as string[],
};
