/**
 * Catálogo do lote budgets (Orçamentos, ritmo de gasto e grupos de campanhas): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * Nenhuma tool daqui é chained: create_shared_budget e create_campaign_group criam o recurso
 * e ligam as campanhas num único googleAds:mutate (ID temporário), que aceita validateOnly.
 * update_budget (núcleo, já classificada em read-only.ts) também tem a lógica neste módulo.
 */
export const catalog = {
  read: [
    "list_budgets",
    "get_budget_pacing",
    "get_campaign_group_performance",
  ] as string[],
  write: [
    "create_shared_budget",
    "assign_budget",
    "remove_budget",
    "create_campaign_group",
    "update_campaign_group",
    "remove_campaign_group",
    "assign_campaign_group",
  ] as string[],
  chained: [] as string[],
};
