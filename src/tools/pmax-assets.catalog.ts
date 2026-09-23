/**
 * Catálogo do lote pmax-assets (Performance Max: criação e gestão de asset groups): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * create_pmax_campaign, create_asset_group, update_asset_group e list_asset_groups também são
 * registradas neste módulo, mas já estão classificadas no núcleo (src/read-only.ts). As duas de
 * criação passaram a gravar num único googleAds:mutate atômico (sem passos encadeados), mas
 * continuam em CHAINED_WRITE_TOOLS (src/tool-kit.ts, fora deste lote): um catálogo de módulo só
 * acrescenta a esse conjunto, não retira. Até o integrador tirar as duas de lá, o validateOnly por
 * chamada é recusado pelo wrapper (nada é enviado); o modo dry-run global (GOOGLE_ADS_DRY_RUN) já
 * valida o pedido inteiro. Ver docs/tools/pmax-assets.md, "Pendente para o integrador".
 */
export const catalog = {
  read: ["list_asset_group_assets"] as string[],
  write: [
    "update_asset_group_assets",
    "update_display_ad",
    "update_demand_gen_ad",
    "unlink_campaign_image_assets",
  ] as string[],
  chained: [] as string[],
};
