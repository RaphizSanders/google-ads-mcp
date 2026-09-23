/**
 * Catálogo do lote targeting-geo (Segmentação geográfica e de idioma): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * get_geo_performance, list_geo_targets, set_campaign_locations e set_campaign_languages também
 * são registradas em targeting-geo.ts, mas já estão classificadas no núcleo (src/read-only.ts).
 */
export const catalog = {
  read: ["get_campaign_geo_targeting"] as string[],
  write: [
    "set_geo_target_type",
    "add_proximity_target",
    "add_location_group_target",
    "remove_campaign_geo_targets",
  ] as string[],
  // Nenhuma grava em passos dependentes: add_proximity_target só relê depois de gravar.
  chained: [] as string[],
};
