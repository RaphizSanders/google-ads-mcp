/**
 * Catálogo do lote conversions-core (Ações e metas de conversão): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * list_conversion_actions, create_conversion_action, update_conversion_action e
 * set_campaign_conversion_goals também são registradas no módulo, mas já estavam classificadas
 * nas listas do núcleo (src/read-only.ts) e continuam lá.
 */
export const catalog = {
  read: [
    "get_conversion_tracking_settings",
    "get_conversion_tag",
    "list_conversion_goals",
    "audit_conversion_tracking",
  ] as string[],
  write: [
    "set_account_conversion_goals",
    "create_custom_conversion_goal",
    "update_custom_conversion_goal",
    "set_campaign_goal_config",
  ] as string[],
  chained: [] as string[],
};
