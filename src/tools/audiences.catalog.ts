/**
 * Catálogo do lote audiences (Públicos, remarketing e Customer Match): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "search_audience_segments",
    "get_audience_performance",
    "get_demographic_performance",
    "get_customer_match_status",
  ] as string[],
  write: [
    "update_custom_audience",
    "add_audience_segment_targeting",
    "remove_audience_segment_targeting",
    "set_targeting_mode",
    "set_optimized_targeting",
    "create_logical_user_list",
    "create_customer_match_list",
    "upload_customer_match_members",
  ] as string[],
  // upload_customer_match_members: cria o job, inclui operações no job criado e o executa
  chained: ["upload_customer_match_members"] as string[],
};
