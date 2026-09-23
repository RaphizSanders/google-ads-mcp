/**
 * Catálogo do lote reports (Relatórios de posicionamento, landing page, redes e visão do MCC): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "get_placement_report",
    "get_landing_page_performance",
    "get_network_breakdown",
    "get_mcc_performance_summary",
  ] as string[],
  write: [] as string[],
  chained: [] as string[],
};
