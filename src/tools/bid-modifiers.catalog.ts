/**
 * Catálogo do lote bid-modifiers (Ajustes de lance, programação e demografia): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * As seis tools reescritas neste módulo (set_location_bid_adjustment, set_device_bid_adjustment,
 * set_age_bid_adjustment, set_gender_bid_adjustment, set_ad_schedule e get_device_breakdown) já
 * são classificadas no núcleo (src/read-only.ts) e por isso não se repetem aqui. Nenhuma tool do
 * lote é encadeada no sentido acima (nenhum passo usa um ID criado por outro). Quase toda escrita é
 * uma única requisição (atômica ou com partialFailure); a exceção é trocar positivo ↔ negativo de
 * um critério de ID fixo em set_demographic_targeting / set_device_targeting (PMax): remove numa
 * requisição, create na seguinte (a API recusa mutar o mesmo recurso duas vezes numa requisição).
 * Em validateOnly a remoção é validada e o create dependente não é enviado — a resposta avisa.
 */
export const catalog = {
  read: [
    "list_ad_schedules",
    "get_time_performance",
    "list_bid_modifiers",
    "get_frequency_report",
  ] as string[],
  write: [
    "update_ad_schedule_bid",
    "remove_ad_schedule",
    "set_demographic_targeting",
    "set_device_targeting",
    "set_frequency_cap",
  ] as string[],
  chained: [] as string[],
};
