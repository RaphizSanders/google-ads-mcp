/**
 * Catálogo do lote account-auth (Autenticação, configurações da conta e metadados de campos): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "check_api_access",
    "get_account_settings",
    "get_identity_verification",
    "get_gaql_fields",
    "validate_gaql",
  ] as string[],
  write: [
    "update_account_settings",
    // Sem validate_only na API: em dry-run/validateOnly a tool não envia nada (fail-closed no código).
    "start_identity_verification",
  ] as string[],
  chained: [] as string[],
};
