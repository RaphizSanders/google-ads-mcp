/**
 * Catálogo do lote conversions-offline (Importação offline, ajustes de conversão, chamadas e GCLID): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [] as string[],
  write: [] as string[],
  chained: [] as string[],
};
