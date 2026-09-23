/**
 * Catálogo do lote diagnostics (Diagnóstico de veiculação, parcela de impressões e reprovações): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "diagnose_campaigns",
    "get_account_health",
    "get_impression_share",
    "list_policy_issues",
  ] as string[],
  /* As duas de exceção fazem uma validação prévia (validate_only, nada gravado) e depois uma
     única gravação que não depende de ID criado antes — por isso não são "chained". */
  write: [
    "request_keyword_policy_exemption",
    "request_ad_policy_exemption",
  ] as string[],
  chained: [] as string[],
};
