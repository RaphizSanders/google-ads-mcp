/**
 * Catálogo do lote keywords (Palavras-chave, termos de pesquisa e DSA): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: ["list_keywords", "get_search_term_insights", "audit_dsa_and_legacy"] as string[],
  // Uma única mutação cada (partialFailure), sem passo encadeado: validateOnly funciona.
  write: ["add_keywords", "bulk_update_keyword_status"] as string[],
  chained: [] as string[],
};
