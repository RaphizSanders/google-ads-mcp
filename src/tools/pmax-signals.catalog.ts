/**
 * Catálogo do lote pmax-signals (Performance Max: sinais, automação, marca, prévias e combinações): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * Nenhuma tool deste lote é encadeada: público novo + sinal, e nome da empresa novo + vínculo,
 * vão num googleAds:mutate atômico com IDs temporários, que aceita validate_only.
 * get_shareable_preview é leitura: gera um link de prévia, sem alterar a conta.
 */
export const catalog = {
  read: [
    "list_asset_group_signals",
    "get_pmax_automation_settings",
    "list_url_expansion_assets",
    "get_pmax_brand_settings",
    "get_shareable_preview",
    "get_pmax_top_combinations",
  ] as string[],
  write: [
    "create_audience",
    "update_audience",
    "manage_asset_group_signals",
    "copy_asset_group_signals",
    "set_pmax_asset_automation",
    "set_pmax_url_exclusions",
    "remove_auto_created_assets",
    "enable_pmax_brand_guidelines",
    "update_pmax_brand_assets",
  ] as string[],
  chained: [] as string[],
};
