/**
 * Catálogo do lote shopping (Shopping, Merchant Center e grupos de produtos): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * list_merchant_centers, create_shopping_campaign e set_listing_group_filter também são
 * registradas pelo módulo, mas já estão classificadas no núcleo (src/read-only.ts).
 * Nenhuma tool do lote grava em passos encadeados: árvore, campanha e grupo vão num único
 * googleAds:mutate com IDs temporários.
 */
export const catalog = {
  read: ["get_listing_group_tree", "get_product_group_performance"] as string[],
  write: [
    "respond_merchant_center_invitation",
    "link_merchant_center",
    "unlink_merchant_center",
    "create_shopping_product_ad",
    "set_shopping_product_groups",
    "exclude_products",
  ] as string[],
  chained: [] as string[],
};
