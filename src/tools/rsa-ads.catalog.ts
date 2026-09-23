/**
 * Catálogo do lote rsa-ads (Anúncios responsivos de Pesquisa, customizadores e auditoria de anúncios): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * As tools de anúncio que vieram do núcleo e são registradas no módulo (create_ad, update_ad,
 * update_ad_status, delete_ad, get_ad_creatives, get_ad_performance, get_asset_performance)
 * continuam classificadas em src/read-only.ts.
 *
 * Nenhuma é chained: migrate_call_only_ad grava tudo numa chamada atômica com ID temporário, e
 * set_customizer_value, na troca de valor (remove + cria), trata o validateOnly por conta própria.
 */
export const catalog = {
  read: ["list_ads", "list_customizers", "list_call_only_ads"] as string[],
  write: [
    "create_customizer_attribute",
    "set_customizer_value",
    "remove_customizer_value",
    "remove_customizer_attribute",
    "migrate_call_only_ad",
  ] as string[],
  chained: [] as string[],
};
