/**
 * Catálogo do lote conversions-reporting (Regras de valor, detalhamento de conversões, lift e leads): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * Nenhuma escrita deste lote é encadeada: regra + conjunto e formulário + vínculos saem numa única
 * chamada atômica (googleAds:mutate com IDs temporários), então o validateOnly funciona em todas.
 */
export const catalog = {
  read: [
    "get_conversions_by_action",
    "get_conversion_lag",
    "list_conversion_value_rules",
    "get_value_rule_impact",
    "get_lift_results",
    "list_lead_forms",
    "get_lead_form_submissions",
  ] as string[],
  write: [
    "create_conversion_value_rule",
    "update_conversion_value_rule",
    "create_lead_form",
    "link_lead_form_to_campaigns",
  ] as string[],
  chained: [] as string[],
};
