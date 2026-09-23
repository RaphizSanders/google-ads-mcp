/**
 * Catálogo do lote account-admin (Administração do MCC: contas, vínculos, usuários, faturamento e edição em massa): toda tool nova do módulo precisa estar em read
 * (só leitura) ou write (grava na conta). Em chained, as de escrita que gravam em passos
 * encadeados (o segundo usa o ID criado no primeiro) — nelas o validateOnly é recusado.
 */
export const catalog = {
  read: [
    "get_batch_job_status",
    "get_batch_job_results",
    "list_account_links",
    "list_account_users",
    "list_pending_approvals",
    "get_billing_status",
    "list_invoices",
    "list_payments_accounts",
  ] as string[],
  write: [
    "bulk_mutate",
    "create_batch_job",
    "create_client_account",
    "invite_client_account",
    "cancel_client_invitation",
    "set_client_link_hidden",
    "unlink_client_account",
    "move_client_account",
    "respond_to_manager_invitation",
    "invite_user",
    "change_user_role",
    "remove_user",
    "revoke_user_invitation",
    "resolve_approval",
    "propose_account_budget",
    "cancel_account_budget_proposal",
  ] as string[],
  /* create_batch_job cria o job e envia as operações ao ID criado; o BatchJobService
     também não tem validate_only. */
  chained: ["create_batch_job"] as string[],
};
