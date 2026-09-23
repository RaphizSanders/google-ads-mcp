/**
 * Catálogo do lote negatives (Palavras-chave negativas em todos os níveis): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 *
 * add_negative_keyword, list_negative_keywords, remove_negative_keyword e
 * create_shared_negative_list também são registradas em negatives.ts, mas continuam
 * classificadas no núcleo (src/read-only.ts) — não entram aqui para não duplicar.
 * Nenhuma tool do lote é encadeada: o que depende de ID novo vai num único googleAds:mutate
 * atômico com IDs temporários.
 */
export const catalog = {
  read: [
    "list_shared_sets",
    "get_shared_set_members",
  ] as string[],
  write: [
    "update_shared_set_members",
    "attach_shared_set",
    "detach_shared_set",
    "add_account_negative_keywords",
    "remove_account_negative_keywords",
  ] as string[],
  chained: [] as string[],
};
