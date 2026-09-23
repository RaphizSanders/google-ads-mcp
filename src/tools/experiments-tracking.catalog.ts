/**
 * Catálogo do lote experiments-tracking (Experimentos, rastreamento de URL, rótulos e aquisição de clientes): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * Nenhuma tool deste lote é chained: create_experiment grava tudo num googleAds:mutate atômico
 * com IDs temporários. set_new_customer_acquisition e graduate_experiment só encadeiam num caso
 * (meta/orçamento novo) e tratam o validateOnly nesse caso dentro da própria tool — validam o
 * primeiro passo e dizem que o segundo não foi validado, ou recusam sem enviar nada.
 */
export const catalog = {
  read: [
    "get_lifecycle_goals",
    "get_new_vs_returning_performance",
    "list_experiments",
    "get_experiment_results",
    "list_campaign_drafts",
    "get_tracking_settings",
    "get_label_performance",
  ] as string[],
  write: [
    "set_new_customer_acquisition",
    "tag_user_list_customer_type",
    "create_experiment",
    "schedule_experiment",
    "end_experiment",
    "promote_experiment",
    "graduate_experiment",
    "update_experiment_campaign",
    "create_campaign_draft",
    "promote_campaign_draft",
    "set_tracking",
    "update_label",
    "remove_label",
    "update_status_by_label",
  ] as string[],
  chained: [] as string[],
};
