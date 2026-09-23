/**
 * Catálogo do lote asset-library (Biblioteca de assets e locais do Perfil da Empresa): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * get_image_assets, get_video_assets, upload_image_asset e upload_video_asset também são
 * registradas por este módulo, mas já estavam classificadas no núcleo (src/read-only.ts).
 */
export const catalog = {
  read: [
    "get_asset_usage",
    "list_location_asset_sets",
    "list_location_assets",
  ] as string[],
  write: [
    "update_asset_synthetic_attestation",
    "create_location_sync_asset_set",
    "link_location_asset_set",
    "create_location_group_asset_set",
    "unlink_location_asset_set",
    "remove_location_asset_set",
  ] as string[],
  // assetSets:mutate → customerAssetSets:mutate com o resource name criado (o googleAds:mutate
  // não aceita CustomerAssetSetOperation, então não dá para ser atômico).
  chained: ["create_location_sync_asset_set"] as string[],
};
