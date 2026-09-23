/**
 * Catálogo do lote conversions-offline (Importação offline, ajustes de conversão, chamadas e GCLID): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * upload_offline_conversion também é registrada neste módulo, mas já estava classificada
 * como escrita na lista do núcleo (src/read-only.ts), por isso não se repete aqui.
 */
export const catalog = {
  read: [
    "get_conversion_upload_health",
    "lookup_gclid",
    "get_call_details",
    "get_data_manager_request_status",
  ] as string[],
  write: [
    "upload_conversion_adjustments",
    "upload_call_conversions",
    "upload_offline_conversions_data_manager",
  ] as string[],
  // Todas gravam numa chamada só (upload com partial_failure ou events:ingest): validateOnly funciona.
  chained: [] as string[],
};
