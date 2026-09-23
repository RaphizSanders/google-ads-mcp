/**
 * Catálogo do lote demand-gen (Demand Gen e remarketing dinâmico de varejo em Display): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * create_demand_gen_campaign e create_display_campaign também são registradas no módulo, mas
 * já estavam classificadas no núcleo (src/read-only.ts) e continuam lá.
 * Nenhuma tool do lote é encadeada: cada uma grava numa única requisição atômica (googleAds:mutate
 * com IDs temporários, ou um :mutate só do recurso), então o validateOnly valida tudo de uma vez.
 */
export const catalog = {
  read: ["list_demand_gen_ad_groups", "list_lookalike_segments"] as string[],
  write: [
    "create_demand_gen_ad_group",
    "update_demand_gen_ad_group",
    "set_demand_gen_ad_group_targeting",
    "create_demand_gen_ad",
    "create_lookalike_segment",
  ] as string[],
  chained: [] as string[],
};
