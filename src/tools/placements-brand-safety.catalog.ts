/**
 * Catálogo do lote placements-brand-safety (Posicionamentos, exclusões e brand safety): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "list_placement_exclusion_lists",
    "list_account_exclusions",
    "get_targeting_overview",
    "list_topics",
    "list_mobile_app_categories",
  ] as string[],
  write: [
    "exclude_placements",
    // atômica (googleAds:mutate com ID temporário): validateOnly funciona, não é encadeada
    "create_placement_exclusion_list",
    "update_placement_exclusion_list",
    "attach_mcc_exclusion_list",
    "remove_account_exclusions",
    "set_content_exclusions",
    "set_video_inventory_type",
    "add_ip_exclusions",
    "remove_targeting_criteria",
    "set_topic_targeting",
    "set_optimized_targeting",
  ] as string[],
  chained: [] as string[],
};
