/**
 * Lote account-admin: Administração do MCC — contas, vínculos, usuários, faturamento e
 * edição em massa.
 *
 * - Edição em massa: bulk_mutate (até 10.000 operações, partial failure, leitura antes da
 *   escrita) e BatchJobService para listas maiores (create_batch_job, get_batch_job_status,
 *   get_batch_job_results).
 * - Contas e vínculos: create_client_account, list_account_links, invite_client_account,
 *   cancel_client_invitation, set_client_link_hidden, unlink_client_account,
 *   move_client_account, respond_to_manager_invitation.
 * - Usuários: list_account_users, invite_user, change_user_role, remove_user,
 *   revoke_user_invitation, list_pending_approvals, resolve_approval.
 * - Faturamento (só contas em faturamento mensal): get_billing_status,
 *   propose_account_budget, cancel_account_budget_proposal, list_invoices,
 *   list_payments_accounts.
 *
 * Payloads e caminhos REST conferidos nos protos oficiais da v25 (services/*.proto).
 * Serviços sem validate_only no request (usuários, convites de usuário, multi-party
 * approval, batch job) são recusados em dry-run/validateOnly antes de qualquer envio.
 */
import { z } from "zod";
import type { GoogleAdsClient } from "../google-ads-client.js";
import {
  checkCustomerAccess,
  flexArray,
  formatAsCsv,
  formatAsTable,
  formatJson,
  formatSchema,
  gaqlLiteral,
  partialFailureByOperation,
  text,
} from "../tool-kit.js";
import type { ToolContext } from "../tool-kit.js";

type Row = Record<string, unknown>;
type TextContent = ReturnType<typeof text>;
type ToolResult = { content: TextContent[]; isError?: boolean };

// ── Helpers ──────────────────────────────────────────────────────────

const fail = (message: string): ToolResult => ({ content: [text(message)], isError: true });

const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

/** ID de conta só com dígitos (aceita hífens); null quando não é um ID. */
function customerIdOf(value: unknown): string | null {
  const id = str(value).trim().replace(/-/g, "");
  return /^\d+$/.test(id) ? id : null;
}

const lastSegment = (resourceName: string): string => resourceName.split("/").pop() ?? "";

const snake = (camel: string): string => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (snakeName: string): string => snakeName.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** Executa fn com no máximo `limit` chamadas em paralelo, mantendo a ordem. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

const micros = (value: unknown): number => Number(value ?? 0) || 0;
const units = (value: unknown): number => Math.round((micros(value) / 1_000_000) * 100) / 100;

/** "yyyy-MM-dd HH:mm:ss" no fuso da conta → Date aproximada (fuso do servidor). */
function parseAdsDateTime(value: unknown): Date | null {
  const s = str(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const date = new Date(s.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderRows(rows: Row[], format: string | undefined, summary: string, extra: Row = {}): string {
  if (format === "table") return `${summary}\n\n${formatAsTable(rows)}`;
  if (format === "csv") return formatAsCsv(rows);
  return `${summary}\n\n${formatJson({ ...extra, rows })}`;
}

const MAX_LISTED = 200;
function capList<T>(items: T[], max = MAX_LISTED): { items: T[]; omitted?: number } {
  return items.length > max ? { items: items.slice(0, max), omitted: items.length - max } : { items };
}

/** Erros conhecidos da API → orientação em PT-BR (a mensagem original é mantida). */
const ERROR_HINTS: Array<[RegExp, string]> = [
  [/TOO_MANY_INVITES|too many pending invit/i, "O gerente tem convites pendentes demais (limite de 20 na mesma hierarquia). Cancele os antigos com cancel_client_invitation."],
  [/TOO_MANY_MANAGERS|too many managers/i, "A conta cliente já está vinculada ao máximo de 5 gerentes."],
  [/ALREADY_INVITED|already invited/i, "Já existe convite pendente deste gerente para esta conta."],
  [/ALREADY_MANAGED|already managed/i, "A conta já é gerenciada por este gerente ou por outro gerente da mesma hierarquia."],
  [/CLIENT_OUTSIDE_TREE|not under your current hierarchy/i, "O gerente de destino precisa estar na mesma hierarquia do login (login-customer-id)."],
  [/CANNOT_HIDE_OR_UNHIDE/i, "Só vínculos ATIVOS podem ser ocultados/reexibidos."],
  [/CANNOT_UNLINK_ACCOUNT_WITHOUT_ACTIVE_USER|CANNOT_REMOVE_LAST_CLIENT_ACCOUNT_OWNER/i, "A conta cliente precisa ter ao menos um usuário ativo (dono) antes de ser desvinculada."],
  [/NO_PENDING_INVITE|no pending invit/i, "Não há convite pendente deste gerente na conta cliente."],
  [/MAX_CUSTOMER_LIMIT_REACHED|ACCOUNT_CREATION_POLICY_VIOLATION|CUSTOMER_NOT_ENABLED|not allowed to create/i, "Criar contas pela API exige um gerente com mais de US$ 1.000 de gasto e em dia com as políticas; o limite de contas do MCC também conta."],
  [/EMAIL_ADDRESS_ALREADY_HAS_ACCESS|already has access/i, "Esse e-mail já tem acesso à conta — use change_user_role."],
  [/EMAIL_ADDRESS_ALREADY_HAS_PENDING_INVITATION|already has a pending invitation/i, "Esse e-mail já tem convite pendente — revogue com revoke_user_invitation antes de reenviar."],
  [/PENDING_INVITATIONS_LIMIT_EXCEEDED/i, "A conta atingiu o limite de convites pendentes."],
  [/EMAIL_DOMAIN_POLICY_VIOLATED/i, "O domínio do e-mail não é permitido pela política de domínios da conta."],
  [/GOOGLE_CONSUMER_ACCOUNT_NOT_ALLOWED/i, "E-mails com '+' (alias) não são aceitos em convites."],
  [/LAST_ADMIN|last admin/i, "Não é possível remover/rebaixar o último administrador da conta."],
  [/DISALLOWED_ACCESS_ROLE/i, "Papel de acesso não permitido para este usuário/conta."],
  [/NOT_INVOICED_CUSTOMER|receive invoices/i, "A conta não recebe faturas: só contas em faturamento mensal (monthly invoicing) têm faturas pela API."],
  [/BILLING_SETUP_NOT_ON_MONTHLY_INVOICING|monthly invoicing/i, "A configuração de faturamento não está no faturamento mensal (monthly invoicing)."],
  [/BILLING_SETUP_NOT_APPROVED/i, "A configuração de faturamento ainda não foi aprovada."],
  [/YEAR_MONTH_TOO_OLD/i, "Faturas anteriores a janeiro de 2019 não estão disponíveis."],
  [/NON_SERVING_CUSTOMER/i, "Faturas só existem para contas de anúncio (não para contas gerente)."],
  [/PENDING_UPDATE_PROPOSAL_EXISTS/i, "Já existe uma proposta pendente para esse orçamento — aguarde a revisão ou cancele com cancel_account_budget_proposal."],
  [/OVERLAPS_EXISTING_BUDGET/i, "O período se sobrepõe a um orçamento aprovado ou proposto: só um orçamento de conta pode estar ativo por vez."],
  [/SPENDING_LIMIT_LOWER_THAN_ACCRUED_COST/i, "O novo limite é menor do que já foi gasto."],
  [/CANNOT_CREATE_BUDGET_THROUGH_API/i, "O perfil de pagamentos não permite criar orçamento pela API — crie pela interface do Google Ads."],
  [/UPDATE_IS_NO_OP/i, "A proposta não muda nada no orçamento atual."],
  [/CANNOT_END_IN_PAST|END_TIME_MUST_FOLLOW_START_TIME/i, "Datas inválidas: o fim não pode estar no passado nem antes do início."],
  [/CANNOT_REMOVE_RUNNING_BUDGET|CANNOT_END_INACTIVE_BUDGET|CANNOT_REMOVE_UNAPPROVED_BUDGET|CANNOT_END_UNAPPROVED_BUDGET/i, "END só vale para orçamento aprovado em andamento; REMOVE só antes do início."],
  [/RESULTS_NOT_READY/i, "O batch job ainda não terminou — confira com get_batch_job_status."],
  [/USER_PERMISSION_DENIED|PERMISSION_DENIED|doesn't have permission|does not have permission/i, "O login usado (login-customer-id) não tem permissão nessa conta para essa ação."],
];

function explainError(err: unknown, extraHints: Array<[RegExp, string]> = []): string {
  const message = err instanceof Error ? err.message : str(err);
  const hints = [...new Set([...extraHints, ...ERROR_HINTS].filter(([re]) => re.test(message)).map(([, hint]) => hint))];
  return hints.length ? `${message}\n→ ${hints.join("\n→ ")}` : message;
}

/** Só na criação de conta: fora dela "currency"/"time zone" na mensagem pode ser outra coisa. */
const CREATE_ACCOUNT_HINTS: Array<[RegExp, string]> = [
  [/CURRENCY_CODE|currency/i, "Código de moeda não suportado (use ISO 4217, ex.: BRL, USD)."],
  [/TIME_ZONE|time ?zone/i, "Fuso horário inválido (use o ID IANA, ex.: America/Sao_Paulo)."],
];

/**
 * Endpoint cujo request tem validate_only (createCustomerClient, customerClientLinks,
 * moveManagerLink, accountBudgetProposals). Em dry-run/validateOnly a API só valida —
 * nada é gravado — e por isso a chamada vai pelo caminho de ação sem gravação.
 * Fora do dry-run passa pelo guard de read-only de customerWriteAction.
 */
async function validatedWrite(client: GoogleAdsClient, customerId: string, action: string, body: Row): Promise<Row> {
  if (client.isDryRun) return client.customerAction<Row>(customerId, action, { ...body, validateOnly: true });
  return client.customerWriteAction<Row>(customerId, action, body);
}

const noValidateOnly = (what: string): ToolResult =>
  fail(`${what} não tem validate_only na API: em dry-run/validateOnly a chamada é recusada para não gravar de verdade. Nada foi enviado.`);

const needConfirm = (what: string, plan: unknown): ToolResult =>
  fail(`${what}\nNada foi enviado. Revise e repita com confirm: true para aplicar.\n\n${formatJson(plan)}`);

// ── Contas do MCC (modo allAccounts) ──────────────────────────────────

interface ManagedAccount {
  id: string;
  name: string;
  manager: boolean;
  level: number;
}

/**
 * Contas ativas sob um gerente (inclui o próprio, nível 0), já filtradas pela allowlist.
 * onlyAdAccounts tira os gerentes ANTES do corte em maxAccounts — senão o MCC e os
 * sub-MCCs ocupam vagas e a varredura lê menos contas de anúncio do que o pedido.
 */
async function managedAccounts(
  client: GoogleAdsClient,
  ctx: ToolContext,
  managerId: string,
  maxAccounts: number,
  options: { onlyAdAccounts?: boolean } = {}
): Promise<{ accounts: ManagedAccount[]; outsideAllowlist: number; truncated: number }> {
  const rows = await client.searchStream(managerId,
    `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager,
            customer_client.level, customer_client.status
     FROM customer_client
     WHERE customer_client.status = 'ENABLED'
     ORDER BY customer_client.level`);
  const all: ManagedAccount[] = rows.map((row) => {
    const c = obj(row.customerClient);
    return { id: str(c.id), name: str(c.descriptiveName), manager: c.manager === true, level: Number(c.level ?? 0) };
  }).filter((account) => /^\d+$/.test(account.id) && !(options.onlyAdAccounts && account.manager));
  const allowed = all.filter((account) => !checkCustomerAccess(account.id, ctx.allowedCustomerIds, ctx.hosted));
  return {
    accounts: allowed.slice(0, maxAccounts),
    outsideAllowlist: all.length - allowed.length,
    truncated: Math.max(0, allowed.length - maxAccounts),
  };
}

// ── Vínculos gerente ↔ cliente ────────────────────────────────────────

const LINK_STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "REFUSED", "CANCELED"] as const;

interface LinkInfo {
  resourceName: string;
  status: string;
  managerLinkId: string;
  hidden: boolean;
  otherCustomer: string;
}

/** Vínculos do gerente com um cliente (visão do gerente: customer_client_link). */
async function clientLinks(client: GoogleAdsClient, managerId: string, clientId: string): Promise<LinkInfo[]> {
  const rows = await client.searchStream(managerId,
    `SELECT customer_client_link.resource_name, customer_client_link.client_customer,
            customer_client_link.manager_link_id, customer_client_link.status, customer_client_link.hidden
     FROM customer_client_link
     WHERE customer_client_link.client_customer = 'customers/${clientId}'`);
  return rows.map((row) => {
    const link = obj(row.customerClientLink);
    return {
      resourceName: str(link.resourceName),
      status: str(link.status),
      managerLinkId: str(link.managerLinkId),
      hidden: link.hidden === true,
      otherCustomer: str(link.clientCustomer),
    };
  });
}

/** Vínculos do cliente com um gerente (visão do cliente: customer_manager_link). */
async function managerLinks(client: GoogleAdsClient, clientId: string, managerId?: string): Promise<LinkInfo[]> {
  const where = managerId ? `\n     WHERE customer_manager_link.manager_customer = 'customers/${managerId}'` : "";
  const rows = await client.searchStream(clientId,
    `SELECT customer_manager_link.resource_name, customer_manager_link.manager_customer,
            customer_manager_link.manager_link_id, customer_manager_link.status
     FROM customer_manager_link${where}`);
  return rows.map((row) => {
    const link = obj(row.customerManagerLink);
    return {
      resourceName: str(link.resourceName),
      status: str(link.status),
      managerLinkId: str(link.managerLinkId),
      hidden: false,
      otherCustomer: str(link.managerCustomer),
    };
  });
}

// ── Usuários ─────────────────────────────────────────────────────────

const ACCESS_ROLES = ["ADMIN", "STANDARD", "READ_ONLY", "EMAIL_ONLY"] as const;
const EMAIL = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/;

interface UserAccess {
  resourceName: string;
  userId: string;
  email: string;
  role: string;
  createdAt: string;
  inviter: string;
  passkeyEnabled: boolean;
  pendingReview: string;
}

async function readUsers(client: GoogleAdsClient, customerId: string): Promise<UserAccess[]> {
  const rows = await client.searchStream(customerId,
    `SELECT customer_user_access.resource_name, customer_user_access.user_id,
            customer_user_access.email_address, customer_user_access.access_role,
            customer_user_access.access_creation_date_time, customer_user_access.inviter_user_email_address,
            customer_user_access.passkey_enabled, customer_user_access.pending_multi_party_auth_review
     FROM customer_user_access`);
  return rows.map((row) => {
    const user = obj(row.customerUserAccess);
    return {
      resourceName: str(user.resourceName),
      userId: str(user.userId),
      email: str(user.emailAddress),
      role: str(user.accessRole),
      createdAt: str(user.accessCreationDateTime),
      inviter: str(user.inviterUserEmailAddress),
      passkeyEnabled: user.passkeyEnabled === true,
      pendingReview: str(user.pendingMultiPartyAuthReview),
    };
  });
}

interface UserInvitation {
  resourceName: string;
  invitationId: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
}

async function readInvitations(client: GoogleAdsClient, customerId: string): Promise<UserInvitation[]> {
  const rows = await client.searchStream(customerId,
    `SELECT customer_user_access_invitation.resource_name, customer_user_access_invitation.invitation_id,
            customer_user_access_invitation.email_address, customer_user_access_invitation.access_role,
            customer_user_access_invitation.invitation_status, customer_user_access_invitation.creation_date_time
     FROM customer_user_access_invitation
     WHERE customer_user_access_invitation.invitation_status = 'PENDING'`);
  return rows.map((row) => {
    const inv = obj(row.customerUserAccessInvitation);
    return {
      resourceName: str(inv.resourceName),
      invitationId: str(inv.invitationId),
      email: str(inv.emailAddress),
      role: str(inv.accessRole),
      status: str(inv.invitationStatus),
      createdAt: str(inv.creationDateTime),
    };
  });
}

/** Resposta de customerUserAccesses / customerUserAccessInvitations: gravou ou gerou revisão multi-party? */
function mpaOutcome(response: Row, doneMessage: string): { message: string; pendingReview: string; resourceName: string } {
  const result = obj(response.result);
  const pendingReview = str(result.multiPartyAuthReview);
  const resourceName = str(result.resourceName);
  if (pendingReview) {
    return {
      pendingReview,
      resourceName,
      message:
        `Aguardando aprovação multi-party: outro administrador precisa aprovar em até 20 dias ` +
        `(resolve_approval com decision=APPROVED, usando as credenciais dele). Até lá nada muda. Revisão: ${pendingReview}`,
    };
  }
  return { pendingReview, resourceName, message: doneMessage };
}

function findUser(users: UserAccess[], userId?: string, email?: string): UserAccess | undefined {
  if (userId) return users.find((user) => user.userId === userId);
  const wanted = (email ?? "").trim().toLowerCase();
  return users.find((user) => user.email.toLowerCase() === wanted);
}

// ── Faturamento ──────────────────────────────────────────────────────

const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
] as const;

const ACCOUNT_BUDGET_FIELDS = `account_budget.resource_name, account_budget.id, account_budget.name,
            account_budget.status, account_budget.billing_setup, account_budget.approved_start_date_time,
            account_budget.approved_end_date_time, account_budget.approved_end_time_type,
            account_budget.approved_spending_limit_micros, account_budget.approved_spending_limit_type,
            account_budget.adjusted_spending_limit_micros, account_budget.adjusted_spending_limit_type,
            account_budget.amount_served_micros, account_budget.total_adjustments_micros,
            account_budget.purchase_order_number, account_budget.notes,
            account_budget.pending_proposal.account_budget_proposal, account_budget.pending_proposal.proposal_type`;

interface BudgetView {
  resource_name: string;
  id: string;
  name: string;
  status: string;
  billing_setup: string;
  start: string;
  end: string;
  unlimited: boolean;
  limit: number | null;
  served: number;
  remaining: number | null;
  remaining_pct: number | null;
  days_to_end: number | null;
  phase: "ativo" | "futuro" | "encerrado" | "pendente";
  purchase_order_number: string;
  notes: string;
  pending_proposal: string;
  pending_proposal_type: string;
  raw: Row;
}

function budgetView(row: Row, now = new Date()): BudgetView {
  const b = obj(row.accountBudget);
  const pending = obj(b.pendingProposal);
  const unlimited = b.adjustedSpendingLimitType === "INFINITE" || b.approvedSpendingLimitType === "INFINITE";
  const limitMicros = b.adjustedSpendingLimitMicros ?? b.approvedSpendingLimitMicros;
  const limit = unlimited || limitMicros === undefined ? null : units(limitMicros);
  const served = units(b.amountServedMicros);
  const remaining = limit === null ? null : Math.round((limit - served) * 100) / 100;
  const start = parseAdsDateTime(b.approvedStartDateTime);
  const endForever = b.approvedEndTimeType === "FOREVER";
  const end = endForever ? null : parseAdsDateTime(b.approvedEndDateTime);
  const status = str(b.status);
  let phase: BudgetView["phase"] = "ativo";
  if (status !== "APPROVED") phase = "pendente";
  else if (start && start > now) phase = "futuro";
  else if (end && end <= now) phase = "encerrado";
  return {
    resource_name: str(b.resourceName),
    id: str(b.id),
    name: str(b.name),
    status,
    billing_setup: str(b.billingSetup),
    start: str(b.approvedStartDateTime),
    end: endForever ? "FOREVER" : str(b.approvedEndDateTime),
    unlimited,
    limit,
    served,
    remaining,
    remaining_pct: limit ? Math.round(((limit - served) / limit) * 1000) / 10 : null,
    days_to_end: end ? Math.ceil((end.getTime() - now.getTime()) / 86_400_000) : null,
    phase,
    purchase_order_number: str(b.purchaseOrderNumber),
    notes: str(b.notes),
    pending_proposal: str(pending.accountBudgetProposal),
    pending_proposal_type: str(pending.proposalType),
    raw: b,
  };
}

/** "NOW"/"FOREVER" ou data "YYYY-MM-DD[ HH:MM:SS]" → campos da proposta; null = inválido. */
function proposalTime(
  value: string,
  kind: "start" | "end"
): { field: string; value: string } | null {
  const v = value.trim().toUpperCase();
  if (kind === "start" && v === "NOW") return { field: "proposedStartTimeType", value: "NOW" };
  if (kind === "end" && v === "FOREVER") return { field: "proposedEndTimeType", value: "FOREVER" };
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/.exec(value.trim());
  if (!match || Number.isNaN(Date.parse(match[1]))) return null;
  const time = match[2] ?? (kind === "start" ? "00:00:00" : "23:59:59");
  return { field: kind === "start" ? "proposedStartDateTime" : "proposedEndDateTime", value: `${match[1]} ${time}` };
}

// ── Edição em massa ──────────────────────────────────────────────────

type BulkAction = "create" | "update" | "remove";

interface BulkResourceSpec {
  /** Recurso GAQL (FROM) e chave da linha no JSON da resposta. */
  gaql: string;
  /** Chave do MutateOperation (googleAds:mutate / batch job). */
  operationKey: string;
  actions: BulkAction[];
  /** Formato do final do resource name (depois de customers/{cid}/{recurso}/). */
  id: RegExp;
  /** O recurso tem status (REMOVED = já removido). */
  hasStatus: boolean;
}

/** Recursos aceitos na edição em massa; ações conferidas nos *Operation dos protos v25. */
const BULK_RESOURCES: Record<string, BulkResourceSpec> = {
  campaigns: { gaql: "campaign", operationKey: "campaignOperation", actions: ["create", "update", "remove"], id: /^\d+$/, hasStatus: true },
  campaignBudgets: { gaql: "campaign_budget", operationKey: "campaignBudgetOperation", actions: ["create", "update", "remove"], id: /^\d+$/, hasStatus: true },
  adGroups: { gaql: "ad_group", operationKey: "adGroupOperation", actions: ["create", "update", "remove"], id: /^\d+$/, hasStatus: true },
  adGroupAds: { gaql: "ad_group_ad", operationKey: "adGroupAdOperation", actions: ["create", "update", "remove"], id: /^\d+~\d+$/, hasStatus: true },
  ads: { gaql: "ad", operationKey: "adOperation", actions: ["update"], id: /^\d+$/, hasStatus: false },
  adGroupCriteria: { gaql: "ad_group_criterion", operationKey: "adGroupCriterionOperation", actions: ["create", "update", "remove"], id: /^\d+~\d+$/, hasStatus: true },
  campaignCriteria: { gaql: "campaign_criterion", operationKey: "campaignCriterionOperation", actions: ["create", "update", "remove"], id: /^\d+~\d+$/, hasStatus: true },
  campaignLabels: { gaql: "campaign_label", operationKey: "campaignLabelOperation", actions: ["create", "remove"], id: /^\d+~\d+$/, hasStatus: false },
  adGroupLabels: { gaql: "ad_group_label", operationKey: "adGroupLabelOperation", actions: ["create", "remove"], id: /^\d+~\d+$/, hasStatus: false },
  adGroupAdLabels: { gaql: "ad_group_ad_label", operationKey: "adGroupAdLabelOperation", actions: ["create", "remove"], id: /^\d+~\d+~\d+$/, hasStatus: false },
  adGroupCriterionLabels: { gaql: "ad_group_criterion_label", operationKey: "adGroupCriterionLabelOperation", actions: ["create", "remove"], id: /^\d+~\d+~\d+$/, hasStatus: false },
  campaignAssets: { gaql: "campaign_asset", operationKey: "campaignAssetOperation", actions: ["create", "update", "remove"], id: /^\d+~\d+~[A-Z_]+$/, hasStatus: true },
  adGroupAssets: { gaql: "ad_group_asset", operationKey: "adGroupAssetOperation", actions: ["create", "update", "remove"], id: /^\d+~\d+~[A-Z_]+$/, hasStatus: true },
};
const BULK_RESOURCE_NAMES = Object.keys(BULK_RESOURCES) as [string, ...string[]];

/** Limites da API: 10.000 operações por mutate; 20.000 valores num IN do GAQL. */
const MUTATE_LIMIT = 10_000;
const READ_CHUNK = 1_000;
/** Batch job: até 1 milhão por job; aqui o teto é o tamanho razoável de uma chamada MCP. */
const BATCH_JOB_LIMIT = 50_000;
/** Recomendação oficial: até 1.000 operações por AddBatchJobOperations. */
const BATCH_ADD_CHUNK = 1_000;

const bulkOperationSchema = z.object({
  resource: z.enum(BULK_RESOURCE_NAMES).describe("Tipo de recurso (serviço da API)."),
  action: z.enum(["create", "update", "remove"]).describe("create, update ou remove (labels: só create/remove; ads: só update)."),
  resourceName: z.string().optional().describe("update/remove: customers/{cid}/{resource}/{id} (ex.: customers/123/adGroupCriteria/456~789)."),
  fields: z.record(z.unknown()).optional().describe(
    "create/update: campos do recurso em JSON camelCase, como na API REST (ex.: {status: 'PAUSED'}, " +
    "{finalUrls: ['https://...']}, {cpcBidMicros: '1500000'}). No update, payload e updateMask levam só as folhas que mudam."
  ),
});

interface PlannedOp {
  index: number;
  resource: string;
  action: BulkAction;
  resourceName?: string;
  fields?: Row;
  /** Folhas em camelCase (update). */
  paths?: string[];
  updateMask?: string;
  outcome?: string;
  changes?: Array<{ field: string; before: unknown; after: unknown }>;
  error?: string;
}

const CAMEL_SEGMENT = /^[a-z][A-Za-z0-9]*$/;

/** Folhas de um objeto de campos (arrays e escalares são folhas). */
function leafPaths(value: Row, prefix: string, errors: string[]): string[] {
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!CAMEL_SEGMENT.test(key)) {
      errors.push(`campo "${path}" não é um nome JSON camelCase válido`);
      continue;
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      if (Object.keys(child).length === 0) {
        errors.push(`"${path}" é um objeto vazio: mensagem com subcampos não entra no updateMask (FIELD_HAS_SUBFIELDS) — informe as folhas ou use a tool específica (ex.: update_campaign para estratégia de lance)`);
        continue;
      }
      paths.push(...leafPaths(child as Row, path, errors));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** Resource names de outra conta dentro dos campos. */
function foreignReferences(value: unknown, cid: string, out: string[] = []): string[] {
  if (typeof value === "string") {
    const match = /^customers\/(\d+)\//.exec(value);
    if (match && match[1] !== cid) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) foreignReferences(item, cid, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) foreignReferences(item, cid, out);
  }
  return out;
}

/** Valida a lista inteira antes de qualquer chamada. */
function parseBulkOperations(raw: unknown[], cid: string): { ops: PlannedOp[]; errors: string[] } {
  const ops: PlannedOp[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  raw.forEach((item, index) => {
    const entry = obj(item);
    const where = `operação #${index}`;
    const resource = str(entry.resource);
    const action = str(entry.action) as BulkAction;
    const spec = BULK_RESOURCES[resource];
    if (!spec) {
      errors.push(`${where}: resource "${resource}" não suportado (use ${BULK_RESOURCE_NAMES.join(", ")})`);
      return;
    }
    if (!spec.actions.includes(action)) {
      errors.push(`${where}: ${resource} aceita só ${spec.actions.join("/")} (recebido "${action}")`);
      return;
    }
    const op: PlannedOp = { index, resource, action };
    const fields = entry.fields;
    if (action === "create" || action === "update") {
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length === 0) {
        errors.push(`${where}: ${action} precisa de fields com ao menos um campo`);
        return;
      }
      if ("resourceName" in (fields as Row)) {
        errors.push(`${where}: não ponha resourceName dentro de fields — use o parâmetro resourceName da operação`);
        return;
      }
      const foreign = foreignReferences(fields, cid);
      if (foreign.length) {
        errors.push(`${where}: fields referencia recurso de outra conta (${foreign.slice(0, 3).join(", ")})`);
        return;
      }
      op.fields = fields as Row;
    } else if (fields !== undefined && fields !== null && Object.keys(obj(fields)).length > 0) {
      errors.push(`${where}: remove não leva fields`);
      return;
    }
    if (action === "update" || action === "remove") {
      const resourceName = str(entry.resourceName).trim();
      const prefix = `customers/${cid}/${resource}/`;
      if (!resourceName.startsWith(prefix) || !spec.id.test(resourceName.slice(prefix.length))) {
        const other = /^customers\/(\d+)\//.exec(resourceName);
        errors.push(other && other[1] !== cid
          ? `${where}: ${resourceName} pertence à conta ${other[1]}, não à ${cid}`
          : `${where}: resourceName inválido "${resourceName}" (esperado ${prefix}<id> no formato ${spec.id.source})`);
        return;
      }
      if (seen.has(resourceName)) {
        errors.push(`${where}: ${resourceName} já aparece na operação #${seen.get(resourceName)} — uma operação por objeto (o resultado de duas seria imprevisível)`);
        return;
      }
      seen.set(resourceName, index);
      op.resourceName = resourceName;
    } else if (entry.resourceName !== undefined && str(entry.resourceName) !== "") {
      errors.push(`${where}: create não leva resourceName (o ID é criado pela API)`);
      return;
    }
    if (action === "update") {
      const pathErrors: string[] = [];
      const paths = leafPaths(op.fields!, "", pathErrors);
      if (pathErrors.length) {
        errors.push(...pathErrors.map((e) => `${where}: ${e}`));
        return;
      }
      op.paths = paths;
      op.updateMask = maskOf(paths);
    }
    ops.push(op);
  });
  return { ops, errors };
}

function valueAt(source: Row, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Row)[key];
  }
  return current;
}

/** Cópia de `source` só com as folhas em `paths` (caminhos camelCase separados por ponto). */
function pickPaths(source: Row, paths: string[]): Row {
  const out: Row = {};
  for (const path of paths) {
    const keys = path.split(".");
    let target = out;
    keys.slice(0, -1).forEach((key) => {
      if (!target[key] || typeof target[key] !== "object") target[key] = {};
      target = target[key] as Row;
    });
    target[keys[keys.length - 1]] = valueAt(source, path);
  }
  return out;
}

const maskOf = (paths: string[]): string => paths.map((path) => path.split(".").map(snake).join(".")).join(",");

/** Comparação tolerante a int64 em string (a API devolve "1500000", o usuário manda 1500000). */
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Row).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
    }
    return v;
  };
  return JSON.stringify(normalize(value)) ?? "undefined";
}

/**
 * Leitura antes da escrita para update/remove: marca não encontrados, já removidos e
 * updates sem mudança, e guarda antes/depois de cada campo. Create não tem o que ler.
 */
async function planBulk(client: GoogleAdsClient, cid: string, ops: PlannedOp[]): Promise<void> {
  const byResource = new Map<string, PlannedOp[]>();
  for (const op of ops) {
    if (op.action === "create") {
      op.outcome = "enviar";
      continue;
    }
    const group = byResource.get(op.resource);
    if (group) group.push(op);
    else byResource.set(op.resource, [op]);
  }
  for (const [resource, group] of byResource) {
    const spec = BULK_RESOURCES[resource];
    const rowKey = camel(spec.gaql);
    const fields = new Set<string>([`${spec.gaql}.resource_name`]);
    if (spec.hasStatus) fields.add(`${spec.gaql}.status`);
    for (const op of group) {
      for (const path of op.paths ?? []) fields.add(`${spec.gaql}.${path.split(".").map(snake).join(".")}`);
    }
    const current = new Map<string, Row>();
    for (const part of chunk(group, READ_CHUNK)) {
      const names = part.map((op) => `'${gaqlLiteral(op.resourceName!)}'`).join(", ");
      const rows = await client.searchStream(cid,
        `SELECT ${[...fields].join(", ")} FROM ${spec.gaql} WHERE ${spec.gaql}.resource_name IN (${names})`);
      for (const row of rows) {
        const entity = obj(row[rowKey]);
        current.set(str(entity.resourceName), entity);
      }
    }
    for (const op of group) {
      const entity = current.get(op.resourceName!);
      if (!entity) {
        op.outcome = "nao_encontrado";
        continue;
      }
      if (spec.hasStatus && entity.status === "REMOVED") {
        op.outcome = "ja_removido";
        continue;
      }
      if (op.action === "remove") {
        op.outcome = "enviar";
        continue;
      }
      const changes: PlannedOp["changes"] = [];
      for (const path of op.paths ?? []) {
        const before = valueAt(entity, path);
        const after = valueAt(op.fields!, path);
        // Campo ausente na resposta = valor desconhecido: não conta como "igual".
        if (before !== undefined && canonical(before) === canonical(after)) continue;
        changes.push({ field: path, before: before === undefined ? "(não informado pela API)" : before, after });
      }
      op.changes = changes;
      op.outcome = changes.length ? "enviar" : "sem_mudanca";
      // Só o que muda vai para o payload e o updateMask: campo já igual fica de fora,
      // e o preview (changes) mostra exatamente o que será regravado.
      if (changes.length && changes.length < (op.paths ?? []).length) {
        const changed = changes.map((change) => change.field);
        op.fields = pickPaths(op.fields!, changed);
        op.paths = changed;
        op.updateMask = maskOf(changed);
      }
    }
  }
}

function bulkPayload(op: PlannedOp): Row {
  if (op.action === "create") return { create: op.fields };
  if (op.action === "remove") return { remove: op.resourceName };
  return { update: { ...op.fields, resourceName: op.resourceName }, updateMask: op.updateMask };
}

function planSummary(ops: PlannedOp[]): Row {
  const count = (outcome: string) => ops.filter((op) => op.outcome === outcome).length;
  const byResource: Row = {};
  for (const op of ops.filter((o) => o.outcome === "enviar")) {
    const key = `${op.resource}.${op.action}`;
    byResource[key] = Number(byResource[key] ?? 0) + 1;
  }
  return {
    a_enviar: count("enviar"),
    sem_mudanca: count("sem_mudanca"),
    nao_encontrados: count("nao_encontrado"),
    ja_removidos: count("ja_removido"),
    por_recurso: byResource,
  };
}

function describeOp(op: PlannedOp): Row {
  return {
    index: op.index,
    resource: op.resource,
    action: op.action,
    ...(op.resourceName ? { resource_name: op.resourceName } : {}),
    ...(op.action === "create" ? { fields: op.fields } : {}),
    ...(op.changes?.length ? { changes: op.changes } : {}),
    ...(op.updateMask ? { update_mask: op.updateMask } : {}),
    status: op.outcome,
    ...(op.error ? { error: op.error } : {}),
  };
}

/** Índices em ordem crescente → trechos compactos ("0-4,7,9-12"). Nunca corta a lista. */
function toRanges(indices: number[]): string {
  const parts: string[] = [];
  let start = -1;
  let prev = -1;
  for (const index of indices) {
    if (start >= 0 && index === prev + 1) {
      prev = index;
      continue;
    }
    if (start >= 0) parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = index;
  }
  if (start >= 0) parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}

/**
 * Mapa "posição entre as operações enviadas ao batch job" → "posição na lista original",
 * em trechos contíguos "enviadaIni-enviadaFim:entradaIni" (ex.: "0-399:600,400:1001" =
 * enviadas 0..399 são as entradas 600..999 e a enviada 400 é a entrada 1001).
 */
function buildIndexMap(inputIndices: number[]): string {
  const parts: string[] = [];
  let sentStart = 0;
  for (let sent = 0; sent < inputIndices.length; sent++) {
    const next = sent + 1;
    if (next < inputIndices.length && inputIndices[next] === inputIndices[sent] + 1) continue;
    const input = inputIndices[sentStart];
    parts.push(`${sentStart === sent ? sentStart : `${sentStart}-${sent}`}:${input}`);
    sentStart = next;
  }
  return parts.join(",");
}

/** Lê o mapa de buildIndexMap; null = formato inválido (trechos fora de ordem ou com buraco). */
function parseIndexMap(map: string): { size: number; inputOf: (sent: number) => number | undefined } | null {
  const segments: Array<{ from: number; to: number; input: number }> = [];
  let expected = 0;
  for (const part of map.replace(/\s+/g, "").split(",")) {
    const match = /^(\d+)(?:-(\d+))?:(\d+)$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from !== expected || to < from) return null;
    segments.push({ from, to, input: Number(match[3]) });
    expected = to + 1;
  }
  if (!segments.length) return null;
  return {
    size: expected,
    inputOf: (sent) => {
      const segment = segments.find((s) => sent >= s.from && sent <= s.to);
      return segment ? segment.input + (sent - segment.from) : undefined;
    },
  };
}

/** Operações puladas agrupadas por motivo, com os índices da lista original em trechos. */
function skippedByOutcome(ops: PlannedOp[]): Row {
  const groups: Record<string, number[]> = {};
  for (const op of ops) {
    if (op.outcome === "enviar") continue;
    (groups[op.outcome ?? "?"] ??= []).push(op.index);
  }
  return Object.fromEntries(Object.entries(groups).map(([outcome, indices]) => [outcome, { total: indices.length, indices: toRanges(indices) }]));
}

/** Resultado de uma operação de batch job: erro (status) ou resource name criado/alterado. */
function batchResultView(result: Row): Row {
  const status = obj(result.status);
  const response = obj(result.mutateOperationResponse);
  const inner = Object.values(response).map(obj)[0] ?? {};
  const messages: string[] = [];
  for (const detail of (status.details as Row[] | undefined) ?? []) {
    for (const err of (detail.errors as Row[] | undefined) ?? []) {
      const codes = Object.entries(obj(err.errorCode)).map(([k, v]) => `${k}.${str(v)}`);
      messages.push(`${str(err.message)}${codes.length ? ` [${codes.join(", ")}]` : ""}`);
    }
  }
  if (!messages.length && status.message) messages.push(str(status.message));
  return {
    operation_index: Number(result.operationIndex ?? 0),
    ok: messages.length === 0 && (status.code === undefined || Number(status.code) === 0),
    ...(inner.resourceName ? { resource_name: str(inner.resourceName) } : {}),
    ...(messages.length ? { errors: messages } : {}),
  };
}

// ── Registro ─────────────────────────────────────────────────────────

export function registerAccountAdminTools(ctx: ToolContext): void {
  // ══ Edição em massa ══════════════════════════════════════════════

  ctx.mcp.registerTool(
    "bulk_mutate",
    {
      description: [
        "Edição em massa genérica: até 10.000 operações (create/update/remove) de vários tipos",
        "numa chamada — trocar UTMs/URLs finais de anúncios, lances de palavras-chave, status,",
        "aplicar/remover labels. WRITE OPERATION.",
        "",
        "Fluxo: 1) chame com preview (padrão) — a tool lê o estado atual de cada objeto e mostra",
        "antes/depois, o que não existe nesta conta e o que já está igual (pulado, sem escrita);",
        "2) repita com preview: false e confirm: true para gravar. Grava por tipo de recurso com",
        "partial failure: uma operação ruim não desfaz as outras — cada falha volta com o motivo.",
        "",
        "fields vai em JSON camelCase como na API REST; no update, payload e updateMask levam só as",
        "folhas cujo valor atual é diferente (o update_mask do preview é o que será enviado).",
        "Objeto vazio (ex.: {manualCpc: {}}) é recusado: estratégia de lance → update_campaign.",
        "Acima de 10.000 operações → create_batch_job. Uma operação por objeto por chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        operations: flexArray(bulkOperationSchema).describe("Operações (até 10.000)."),
        preview: z.boolean().optional().describe("true (padrão): só mostra o plano, sem gravar. false: grava (exige confirm: true)."),
        confirm: z.boolean().optional().describe("Precisa ser true junto com preview: false para gravar."),
      },
    },
    async ({ customerId, operations, preview, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const raw = Array.isArray(operations) ? operations : [];
      if (raw.length === 0) return fail("Informe ao menos uma operação. Nada foi enviado.");
      if (raw.length > MUTATE_LIMIT) {
        return fail(`${raw.length} operações passam do limite de ${MUTATE_LIMIT} por chamada (limite do mutate da API). Use create_batch_job. Nada foi enviado.`);
      }
      const { ops, errors } = parseBulkOperations(raw, cid);
      if (errors.length) {
        return fail(`Operações inválidas — nada foi enviado:\n- ${errors.slice(0, 50).join("\n- ")}${errors.length > 50 ? `\n(+${errors.length - 50} erros)` : ""}`);
      }
      const applying = preview === false;
      if (applying && confirm !== true) {
        return fail("Para gravar envie preview: false e confirm: true. Rode antes sem preview: false para revisar o plano. Nada foi enviado.");
      }

      const client = ctx.getClient();
      try {
        await planBulk(client, cid, ops);
      } catch (err) {
        return fail(`Não foi possível ler o estado atual dos objetos (confira os nomes dos campos em fields — são os do recurso na v25): ${explainError(err)}\nNada foi enviado.`);
      }
      const toSend = ops.filter((op) => op.outcome === "enviar");
      const summary = planSummary(ops);
      const listed = capList(ops.map(describeOp));

      if (!applying) {
        return {
          content: [text(
            `PREVIEW — nada foi gravado. ${toSend.length} operação(ões) a enviar de ${ops.length}.\n` +
            "Para gravar: repita com preview: false e confirm: true.\n\n" +
            formatJson({ resumo: summary, operacoes: listed.items, ...(listed.omitted ? { omitidas_da_lista: listed.omitted } : {}) })
          )],
        };
      }
      if (toSend.length === 0) {
        return { content: [text(`Nada a gravar: nenhuma operação muda algo nesta conta.\n\n${formatJson({ resumo: summary, operacoes: listed.items, ...(listed.omitted ? { omitidas_da_lista: listed.omitted } : {}) })}`)] };
      }

      const dryRun = client.isDryRun;
      const groups = new Map<string, PlannedOp[]>();
      for (const op of toSend) {
        const group = groups.get(op.resource);
        if (group) group.push(op);
        else groups.set(op.resource, [op]);
      }
      const unattributed: string[] = [];
      let interrupted = "";
      for (const [resource, group] of groups) {
        if (interrupted) {
          for (const op of group) { op.outcome = "nao_enviado"; op.error = interrupted; }
          continue;
        }
        let response: Row;
        try {
          response = await client.mutate(cid, resource, group.map(bulkPayload), { partialFailure: true });
        } catch (err) {
          const message = explainError(err);
          for (const op of group) { op.outcome = "erro"; op.error = message; }
          interrupted = `não enviado: a chamada de ${resource} falhou antes (${message.split("\n")[0]})`;
          continue;
        }
        const results = (response.results as Row[] | undefined) ?? [];
        const { byIndex, unattributed: loose } = partialFailureByOperation(response.partialFailureError, group.length);
        unattributed.push(...loose);
        group.forEach((op, index) => {
          const opErrors = byIndex.get(index);
          if (opErrors) { op.outcome = "erro"; op.error = opErrors.join("; "); }
          else if (!dryRun && !results[index]?.resourceName) { op.outcome = "erro"; op.error = "a API não confirmou a operação"; }
          else op.outcome = dryRun ? "validado" : "aplicado";
        });
      }
      const failed = ops.filter((op) => op.outcome === "erro" || op.outcome === "nao_enviado");
      const done = ops.filter((op) => op.outcome === "aplicado" || op.outcome === "validado");
      const finalList = capList(ops.map(describeOp));
      return {
        content: [text(
          (dryRun ? `DRY-RUN (validateOnly): nada foi gravado. ${done.length} operação(ões) validada(s)` : `${done.length} operação(ões) aplicada(s)`) +
          ` | Com erro/não enviadas: ${failed.length} | Sem mudança: ${summary.sem_mudanca} | Não encontradas: ${summary.nao_encontrados} | Já removidas: ${summary.ja_removidos}\n\n` +
          formatJson({
            erros: failed.slice(0, 500).map(describeOp),
            ...(failed.length > 500 ? { erros_omitidos_da_lista: failed.length - 500 } : {}),
            ...(unattributed.length ? { erros_sem_operacao: unattributed } : {}),
            operacoes: finalList.items,
            ...(finalList.omitted ? { omitidas_da_lista: finalList.omitted } : {}),
          })
        )],
        isError: failed.length > 0 || unattributed.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "create_batch_job",
    {
      description: [
        "Edição em massa acima de 10.000 operações via BatchJobService (assíncrono). WRITE OPERATION.",
        "Mesmo formato de operations do bulk_mutate. A tool lê o estado atual (pula não encontrados,",
        "já removidos e updates sem mudança), cria o job, envia as operações em blocos de 1.000",
        "(sequence token) e dispara a execução. Acompanhe com get_batch_job_status e leia o resultado",
        "com get_batch_job_results.",
        "",
        "Fluxo: preview (padrão) mostra o plano; preview: false + confirm: true cria e executa.",
        "Batch job NÃO tem validate_only: em dry-run/validateOnly a tool recusa. Operações que já",
        "rodaram não são desfeitas (o job roda com partial failure). Até 50.000 operações por chamada.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        operations: flexArray(bulkOperationSchema).describe("Operações (até 50.000)."),
        executionLimitSeconds: z.number().int().positive().optional().describe("Tempo máximo de execução; o job é cancelado depois disso."),
        preview: z.boolean().optional().describe("true (padrão): só mostra o plano. false: cria e executa (exige confirm: true)."),
        confirm: z.boolean().optional().describe("Precisa ser true junto com preview: false."),
      },
    },
    async ({ customerId, operations, executionLimitSeconds, preview, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const raw = Array.isArray(operations) ? operations : [];
      if (raw.length === 0) return fail("Informe ao menos uma operação. Nada foi enviado.");
      if (raw.length > BATCH_JOB_LIMIT) {
        return fail(`${raw.length} operações passam do limite de ${BATCH_JOB_LIMIT} por chamada. Divida em mais de um job. Nada foi enviado.`);
      }
      const { ops, errors } = parseBulkOperations(raw, cid);
      if (errors.length) {
        return fail(`Operações inválidas — nada foi enviado:\n- ${errors.slice(0, 50).join("\n- ")}${errors.length > 50 ? `\n(+${errors.length - 50} erros)` : ""}`);
      }
      const applying = preview === false;
      if (applying && confirm !== true) {
        return fail("Para criar e executar o job envie preview: false e confirm: true. Nada foi enviado.");
      }
      const client = ctx.getClient();
      if (applying && client.isDryRun) return noValidateOnly("BatchJobService");

      try {
        await planBulk(client, cid, ops);
      } catch (err) {
        return fail(`Não foi possível ler o estado atual dos objetos: ${explainError(err)}\nNada foi enviado.`);
      }
      const toSend = ops.filter((op) => op.outcome === "enviar");
      // Completo e compacto (trechos de índices): nunca cortado, para dar para mapear os resultados.
      const skipped = skippedByOutcome(ops);
      const summary = planSummary(ops);
      if (!applying) {
        const listed = capList(ops.map(describeOp));
        return {
          content: [text(
            `PREVIEW — nada foi criado. ${toSend.length} operação(ões) iriam para o batch job de ${ops.length}.\n` +
            "Para criar e executar: repita com preview: false e confirm: true.\n\n" +
            formatJson({ resumo: summary, operacoes: listed.items, ...(listed.omitted ? { omitidas_da_lista: listed.omitted } : {}) })
          )],
        };
      }
      if (toSend.length === 0) {
        return { content: [text(`Nada a enviar: nenhuma operação muda algo nesta conta. Nenhum job foi criado.\n\n${formatJson({ resumo: summary, puladas: skipped })}`)] };
      }

      // 1) cria o job
      let jobResourceName: string;
      try {
        const created = await client.customerWriteAction<Row>(cid, "batchJobs:mutate", {
          operation: { create: executionLimitSeconds ? { metadata: { executionLimitSeconds } } : {} },
        });
        jobResourceName = str(obj(created.result).resourceName);
      } catch (err) {
        return fail(`Falha ao criar o batch job: ${explainError(err)}\nNada foi enviado.`);
      }
      const jobId = lastSegment(jobResourceName);
      if (!/^\d+$/.test(jobId)) return fail(`A API não devolveu o batch job criado (${jobResourceName || "vazio"}). Nada foi executado.`);

      // 2) envia as operações em blocos, encadeando o sequence token
      const mutateOperations = toSend.map((op) => ({ [BULK_RESOURCES[op.resource].operationKey]: bulkPayload(op) }));
      let sequenceToken = "";
      let total = 0;
      for (const part of chunk(mutateOperations, BATCH_ADD_CHUNK)) {
        try {
          const added = await client.customerWriteAction<Row>(cid, `batchJobs/${jobId}:addOperations`, {
            ...(sequenceToken ? { sequenceToken } : {}),
            mutateOperations: part,
          });
          sequenceToken = str(added.nextSequenceToken);
          total = Number(added.totalOperations ?? total + part.length);
        } catch (err) {
          // Job pendente e incompleto: remove para não ser executado pela metade por engano.
          let cleanup = "o job pendente foi removido";
          try {
            await client.customerWriteAction(cid, "batchJobs:mutate", { operation: { remove: jobResourceName } });
          } catch (removeErr) {
            cleanup = `não foi possível remover o job pendente (${(removeErr as Error).message}); ele não roda sem RunBatchJob e some em 7 dias`;
          }
          return fail(`Falha ao enviar operações ao batch job ${jobResourceName} (${total} enviadas até aqui): ${explainError(err)}\nNada foi executado; ${cleanup}.`);
        }
      }

      // 3) executa
      let operationName = "";
      try {
        const run = await client.customerWriteAction<Row>(cid, `batchJobs/${jobId}:run`, {});
        operationName = str(run.name);
      } catch (err) {
        return fail(`As ${total} operações foram enviadas ao job ${jobResourceName}, mas a execução falhou: ${explainError(err)}\nO job continua pendente (não roda sozinho).`);
      }
      const indexMap = buildIndexMap(toSend.map((op) => op.index));
      return {
        content: [text(
          `Batch job ${jobId} criado e em execução: ${total} operação(ões) enviada(s) de ${ops.length}.\n` +
          `Acompanhe com get_batch_job_status (batchJobId: ${jobId}) e leia o resultado com get_batch_job_results quando o status for DONE.\n` +
          "operation_index nos resultados = posição entre as operações ENVIADAS, não na sua lista. Guarde mapa_indices e passe em " +
          "get_batch_job_results (indexMap) — cada resultado volta com input_index, a posição na lista original. " +
          "Formato: \"enviadaIni-enviadaFim:entradaIni\" por trecho contíguo.\n\n" +
          formatJson({
            batch_job: jobResourceName,
            long_running_operation: operationName,
            resumo: summary,
            mapa_indices: indexMap,
            puladas: skipped,
          })
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "get_batch_job_status",
    {
      description: [
        "Status de batch jobs (BatchJobService): PENDING, RUNNING ou DONE, progresso e contagem de",
        "operações. Sem batchJobId lista os jobs mais recentes da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        batchJobId: z.string().optional().describe("ID do batch job (o número no fim do resource name)."),
        limit: z.number().int().positive().max(100).optional().describe("Quantos jobs listar sem batchJobId. Padrão: 20."),
      },
    },
    async ({ customerId, batchJobId, limit }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (batchJobId !== undefined && !/^\d+$/.test(batchJobId.trim())) return fail(`batchJobId deve ser numérico, recebido "${batchJobId}".`);
      const client = ctx.getClient();
      const where = batchJobId ? `WHERE batch_job.id = ${batchJobId.trim()}` : "";
      const rows = await client.searchStream(cid,
        `SELECT batch_job.resource_name, batch_job.id, batch_job.status, batch_job.long_running_operation,
                batch_job.metadata.creation_date_time, batch_job.metadata.start_date_time,
                batch_job.metadata.completion_date_time, batch_job.metadata.estimated_completion_ratio,
                batch_job.metadata.operation_count, batch_job.metadata.executed_operation_count,
                batch_job.metadata.execution_limit_seconds
         FROM batch_job
         ${where}
         ORDER BY batch_job.id DESC
         LIMIT ${batchJobId ? 1 : limit ?? 20}`);
      const jobs = rows.map((row) => {
        const job = obj(row.batchJob);
        const meta = obj(job.metadata);
        return {
          id: str(job.id),
          status: str(job.status),
          progress_pct: meta.estimatedCompletionRatio !== undefined ? Math.round(Number(meta.estimatedCompletionRatio) * 1000) / 10 : null,
          operation_count: Number(meta.operationCount ?? 0),
          executed_operation_count: Number(meta.executedOperationCount ?? 0),
          created: str(meta.creationDateTime),
          started: str(meta.startDateTime),
          completed: str(meta.completionDateTime),
          execution_limit_seconds: meta.executionLimitSeconds ?? null,
          resource_name: str(job.resourceName),
          long_running_operation: str(job.longRunningOperation),
        };
      });
      if (batchJobId && jobs.length === 0) return fail(`Batch job ${batchJobId} não encontrado na conta ${cid}.`);
      const hint = jobs.some((job) => job.status === "DONE") ? "\nJobs DONE: leia com get_batch_job_results." : "";
      return { content: [text(`${jobs.length} batch job(s).${hint}\n\n${formatJson(jobs)}`)] };
    }
  );

  ctx.mcp.registerTool(
    "get_batch_job_results",
    {
      description: [
        "Resultados de um batch job concluído (DONE): por operação, o resource name gravado ou os",
        "erros. Paginado (até 1.000 por página; use pageToken). onlyErrors filtra as falhas.",
        "operation_index é a posição entre as operações ENVIADAS ao job; passe o mapa_indices que",
        "create_batch_job devolveu em indexMap para receber input_index (posição na sua lista).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        batchJobId: z.string().describe("ID do batch job."),
        pageSize: z.number().int().positive().max(1000).optional().describe("Resultados por página (máx. 1.000, padrão 1.000)."),
        pageToken: z.string().optional().describe("nextPageToken da página anterior."),
        onlyErrors: z.boolean().optional().describe("true = lista só as operações com erro."),
        indexMap: z.string().optional().describe("mapa_indices devolvido por create_batch_job (ex.: \"0-399:600,400:1001\"): cada resultado ganha input_index."),
      },
    },
    async ({ customerId, batchJobId, pageSize, pageToken, onlyErrors, indexMap }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const jobId = batchJobId.trim();
      if (!/^\d+$/.test(jobId)) return fail(`batchJobId deve ser numérico, recebido "${batchJobId}".`);
      const map = indexMap !== undefined && indexMap.trim() !== "" ? parseIndexMap(indexMap) : undefined;
      if (map === null) {
        return fail("indexMap inválido: use exatamente o mapa_indices devolvido por create_batch_job (trechos \"enviadaIni-enviadaFim:entradaIni\" em ordem, começando em 0).");
      }
      const client = ctx.getClient();
      const rows = await client.searchStream(cid,
        `SELECT batch_job.id, batch_job.status, batch_job.metadata.estimated_completion_ratio,
                batch_job.metadata.operation_count
         FROM batch_job
         WHERE batch_job.id = ${jobId}`);
      const job = obj(rows[0]?.batchJob);
      if (!rows.length) return fail(`Batch job ${jobId} não encontrado na conta ${cid}.`);
      if (job.status !== "DONE") {
        const ratio = obj(job.metadata).estimatedCompletionRatio;
        return fail(`O batch job ${jobId} ainda não terminou (status ${str(job.status)}${ratio !== undefined ? `, ${Math.round(Number(ratio) * 100)}%` : ""}). ` +
          "Os resultados só existem com status DONE — confira com get_batch_job_status.");
      }
      const operationCount = Number(obj(job.metadata).operationCount ?? 0);
      if (map && operationCount > 0 && map.size !== operationCount) {
        return fail(`indexMap cobre ${map.size} operação(ões), mas o batch job ${jobId} tem ${operationCount}: o mapa é de outro job. ` +
          "Use o mapa_indices devolvido na criação deste job (ou repita sem indexMap).");
      }
      let response: Row;
      try {
        response = await client.customerGet<Row>(cid, `batchJobs/${jobId}:listResults`, {
          pageSize: pageSize ?? 1000,
          pageToken: pageToken || undefined,
        });
      } catch (err) {
        return fail(`Falha ao ler os resultados: ${explainError(err)}`);
      }
      const results = ((response.results as Row[] | undefined) ?? []).map(batchResultView).map((result) =>
        map ? { operation_index: result.operation_index, input_index: map.inputOf(Number(result.operation_index)) ?? null, ...result } : result);
      const withErrors = results.filter((result) => !result.ok);
      const shown = onlyErrors ? withErrors : results;
      const next = str(response.nextPageToken);
      return {
        content: [text(
          `Batch job ${jobId}: ${results.length} resultado(s) nesta página — ${results.length - withErrors.length} ok, ${withErrors.length} com erro.` +
          `${next ? `\nHá mais páginas: repita com pageToken: "${next}".` : ""}` +
          (map ? "" : "\noperation_index = posição entre as operações ENVIADAS (as puladas na criação não contam): passe indexMap com o mapa_indices de create_batch_job para ver input_index.") +
          "\n\n" +
          formatJson({ next_page_token: next || null, results: shown })
        )],
      };
    }
  );

  // ══ Contas e vínculos do MCC ═════════════════════════════════════

  ctx.mcp.registerTool(
    "create_client_account",
    {
      description: [
        "Cria uma conta cliente nova sob um MCC (CustomerService.CreateCustomerClient). WRITE OPERATION.",
        "Moeda e fuso horário são IMUTÁVEIS depois de criados — a tool mostra os dois e só cria",
        "com confirm: true. Recusa nome duplicado sob o mesmo MCC (allowDuplicateName libera).",
        "A API só permite a gerentes com mais de US$ 1.000 de gasto e em dia com as políticas.",
        "A conta nasce sem faturamento e sem campanhas.",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID do MCC que vai gerenciar a conta nova."),
        name: z.string().describe("Nome da conta (até 255 caracteres)."),
        currencyCode: z.string().optional().describe("Moeda ISO 4217. Padrão: BRL. IMUTÁVEL."),
        timeZone: z.string().optional().describe("Fuso IANA. Padrão: America/Sao_Paulo. IMUTÁVEL."),
        trackingUrlTemplate: z.string().optional().describe("Modelo de acompanhamento da conta (ex.: {lpurl}?utm_source=google)."),
        finalUrlSuffix: z.string().optional().describe("Sufixo de URL final da conta (ex.: utm_medium=cpc)."),
        allowDuplicateName: z.boolean().optional().describe("true = cria mesmo se já houver conta com esse nome sob o MCC."),
        confirm: z.boolean().optional().describe("Precisa ser true para criar."),
      },
    },
    async ({ managerCustomerId, name, currencyCode, timeZone, trackingUrlTemplate, finalUrlSuffix, allowDuplicateName, confirm }) => {
      const blocked = checkCustomerAccess(managerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const managerId = customerIdOf(managerCustomerId);
      if (!managerId) return fail(`managerCustomerId inválido: "${managerCustomerId}". Nada foi criado.`);
      const descriptiveName = name.trim();
      if (!descriptiveName || descriptiveName.length > 255) return fail("name precisa ter de 1 a 255 caracteres. Nada foi criado.");
      const currency = (currencyCode ?? "BRL").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return fail(`currencyCode inválido: "${currencyCode}" (use ISO 4217, ex.: BRL). Nada foi criado.`);
      const zone = (timeZone ?? "America/Sao_Paulo").trim();
      if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(zone)) return fail(`timeZone inválido: "${timeZone}" (use o ID IANA, ex.: America/Sao_Paulo). Nada foi criado.`);
      if (trackingUrlTemplate !== undefined && !/^(\{lpurl\}|https?:\/\/)/i.test(trackingUrlTemplate.trim())) {
        return fail("trackingUrlTemplate precisa começar com {lpurl} ou com http(s)://. Nada foi criado.");
      }
      if (finalUrlSuffix !== undefined && /^[?&]/.test(finalUrlSuffix.trim())) {
        return fail("finalUrlSuffix vai sem '?' ou '&' no começo (ex.: utm_medium=cpc). Nada foi criado.");
      }
      const customerClient: Row = {
        descriptiveName,
        currencyCode: currency,
        timeZone: zone,
        ...(trackingUrlTemplate ? { trackingUrlTemplate: trackingUrlTemplate.trim() } : {}),
        ...(finalUrlSuffix ? { finalUrlSuffix: finalUrlSuffix.trim() } : {}),
      };

      const client = ctx.getClient();
      const managerRows = await client.searchStream(managerId,
        "SELECT customer.id, customer.descriptive_name, customer.manager, customer.status FROM customer LIMIT 1");
      const manager = obj(managerRows[0]?.customer);
      if (!managerRows.length) return fail(`Conta ${managerId} não encontrada ou sem acesso. Nada foi criado.`);
      if (manager.manager !== true) return fail(`A conta ${managerId} (${str(manager.descriptiveName)}) não é um MCC — contas só podem ser criadas sob um gerente. Nada foi criado.`);
      const sameName = await client.searchStream(managerId,
        `SELECT customer_client.id, customer_client.descriptive_name, customer_client.status
         FROM customer_client
         WHERE customer_client.descriptive_name = '${gaqlLiteral(descriptiveName)}'`);
      if (sameName.length && allowDuplicateName !== true) {
        const existing = sameName.map((row) => ({ id: str(obj(row.customerClient).id), status: str(obj(row.customerClient).status) }));
        return fail(`Já existe conta com o nome "${descriptiveName}" sob o MCC ${managerId}: ${formatJson(existing)}\n` +
          "Nada foi criado. Para criar mesmo assim, envie allowDuplicateName: true.");
      }
      const plan = { gerente: `${managerId} (${str(manager.descriptiveName)})`, conta_nova: customerClient, imutaveis: { moeda: currency, fuso: zone } };
      if (confirm !== true) {
        return needConfirm(`Criar a conta "${descriptiveName}" em ${currency} / ${zone}? Moeda e fuso NÃO podem ser alterados depois.`, plan);
      }
      let response: Row;
      try {
        response = await validatedWrite(client, managerId, ":createCustomerClient", { customerClient });
      } catch (err) {
        return fail(`Falha ao criar a conta: ${explainError(err, CREATE_ACCOUNT_HINTS)}`);
      }
      if (client.isDryRun) {
        return { content: [text(`DRY-RUN (validateOnly): a API validou a criação — nenhuma conta foi criada.\n\n${formatJson(plan)}`)] };
      }
      const resourceName = str(response.resourceName);
      const newId = lastSegment(resourceName);
      if (!/^\d+$/.test(newId)) return fail(`A API não confirmou a criação (resposta sem resource name) — confira em list_accounts antes de repetir.\n\n${formatJson(response)}`);
      const allowlistNote = ctx.hosted && !ctx.allowedCustomerIds.includes("*")
        ? `\nAtenção: a conta ${newId} não está em ALLOWED_CUSTOMER_IDS — inclua para operá-la por este servidor.` : "";
      return {
        content: [text(
          `Conta criada: ${newId} ("${descriptiveName}", ${currency}, ${zone}) sob o MCC ${managerId}.\n` +
          "Próximos passos: configurar faturamento na interface, convidar usuários (invite_user) e criar campanhas." +
          allowlistNote + `\n\n${formatJson({ resource_name: resourceName, ...plan })}`
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "list_account_links",
    {
      description: [
        "Vínculos entre gerente e contas. view=clients (padrão): contas que o MCC gerencia ou",
        "convidou, com status (ACTIVE, PENDING, CANCELED, REFUSED, INACTIVE) e se estão ocultas —",
        "mostra convites pendentes esquecidos (limite de 20 pendentes na hierarquia). view=managers:",
        "gerentes de uma conta cliente (limite de 5).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("view=clients: ID do MCC. view=managers: ID da conta cliente."),
        view: z.enum(["clients", "managers"]).optional().describe("clients (padrão) ou managers."),
        status: z.enum(LINK_STATUSES).optional().describe("Filtra por status do vínculo."),
        format: formatSchema,
      },
    },
    async ({ customerId, view, status, format }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const client = ctx.getClient();
      const counts: Row = {};
      // Como em list_accounts: no modo hospedado, conta fora de ALLOWED_CUSTOMER_IDS não
      // aparece (nem ID, nem nome, nem status) — só a quantidade ocultada.
      const visible = (id: string) => !checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
      const hiddenNote = (count: number, what: string) => count
        ? `\n${count} vínculo(s) com ${what} fora de ALLOWED_CUSTOMER_IDS ocultado(s) (não entram na lista nem nas contagens).`
        : "";
      if ((view ?? "clients") === "managers") {
        const rows = await client.searchStream(cid,
          `SELECT customer_manager_link.resource_name, customer_manager_link.manager_customer,
                  customer_manager_link.manager_link_id, customer_manager_link.status
           FROM customer_manager_link${status ? `\n           WHERE customer_manager_link.status = '${status}'` : ""}`);
        const all = rows.map((row) => {
          const link = obj(row.customerManagerLink);
          return {
            manager_customer_id: lastSegment(str(link.managerCustomer)),
            status: str(link.status),
            manager_link_id: str(link.managerLinkId),
            resource_name: str(link.resourceName),
          };
        });
        const links = all.filter((link) => visible(link.manager_customer_id));
        for (const link of links) counts[link.status] = Number(counts[link.status] ?? 0) + 1;
        // O limite de 5 gerentes vale para todos os vínculos ativos, inclusive os ocultados.
        const active = all.filter((link) => link.status === "ACTIVE").length;
        const warning = active >= 5 ? "\nAtenção: a conta já tem 5 gerentes ativos (limite da API)." : "";
        return {
          content: [text(renderRows(links, format,
            `Conta ${cid}: ${links.length} vínculo(s) com gerentes ${formatJson(counts)}.${warning}${hiddenNote(all.length - links.length, "gerentes")}`))],
        };
      }

      const rows = await client.searchStream(cid,
        `SELECT customer_client_link.resource_name, customer_client_link.client_customer,
                customer_client_link.manager_link_id, customer_client_link.status, customer_client_link.hidden
         FROM customer_client_link${status ? `\n         WHERE customer_client_link.status = '${status}'` : ""}`);
      const names = new Map<string, Row>();
      for (const row of await client.searchStream(cid,
        `SELECT customer_client.client_customer, customer_client.descriptive_name, customer_client.manager,
                customer_client.status, customer_client.level
         FROM customer_client
         WHERE customer_client.level <= 1`)) {
        const c = obj(row.customerClient);
        names.set(str(c.clientCustomer), c);
      }
      const allLinks = rows.map((row) => obj(row.customerClientLink));
      const links = allLinks
        .filter((link) => visible(lastSegment(str(link.clientCustomer))))
        .map((link) => {
          const info = names.get(str(link.clientCustomer)) ?? {};
          return {
            client_customer_id: lastSegment(str(link.clientCustomer)),
            name: str(info.descriptiveName),
            link_status: str(link.status),
            hidden: link.hidden === true,
            is_manager: info.manager === true,
            account_status: str(info.status),
            manager_link_id: str(link.managerLinkId),
            resource_name: str(link.resourceName),
          };
        });
      const hiddenCount = allLinks.length - links.length;
      for (const link of links) counts[link.link_status] = Number(counts[link.link_status] ?? 0) + 1;
      const pending = Number(counts.PENDING ?? 0);
      const warning = pending >= 15
        ? `\nAtenção: ${pending} convites pendentes — o limite é 20 na mesma hierarquia. Cancele os esquecidos com cancel_client_invitation.`
        : pending > 0 ? `\n${pending} convite(s) pendente(s) aguardando o cliente aceitar.` : "";
      const limitNote = hiddenCount && pending > 0 ? " Convites para contas ocultadas também contam no limite de 20." : "";
      return {
        content: [text(renderRows(links, format,
          `MCC ${cid}: ${links.length} vínculo(s) ${formatJson(counts)}.${warning}${hiddenNote(hiddenCount, "contas")}${limitNote}`))],
      };
    }
  );

  ctx.mcp.registerTool(
    "invite_client_account",
    {
      description: [
        "Convida uma conta existente para ser gerenciada pelo MCC (cria o vínculo PENDING).",
        "WRITE OPERATION. O cliente precisa aceitar: na interface (Admin > Acesso e segurança >",
        "Gerentes) ou com respond_to_manager_invitation se este login tiver acesso à conta cliente.",
        "Não faz nada se a conta já é gerenciada ou já tem convite pendente deste MCC.",
        "Limites: 20 convites pendentes na hierarquia; 5 gerentes por conta.",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID do MCC que convida."),
        clientCustomerId: z.string().describe("ID da conta convidada."),
      },
    },
    async ({ managerCustomerId, clientCustomerId }) => {
      for (const id of [managerCustomerId, clientCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const managerId = customerIdOf(managerCustomerId);
      const clientId = customerIdOf(clientCustomerId);
      if (!managerId || !clientId) return fail("managerCustomerId e clientCustomerId precisam ser IDs numéricos. Nada foi enviado.");
      if (managerId === clientId) return fail("Uma conta não pode gerenciar a si mesma. Nada foi enviado.");
      const client = ctx.getClient();
      const links = await clientLinks(client, managerId, clientId);
      const active = links.find((link) => link.status === "ACTIVE");
      if (active) return { content: [text(`A conta ${clientId} já é gerenciada pelo MCC ${managerId} (vínculo ACTIVE). Nada foi enviado.`)] };
      const pending = links.find((link) => link.status === "PENDING");
      if (pending) {
        return { content: [text(`Já existe convite pendente do MCC ${managerId} para ${clientId} (${pending.resourceName}). Nada foi enviado. Para refazer, cancele com cancel_client_invitation.`)] };
      }
      const pendingTotal = (await client.searchStream(managerId,
        `SELECT customer_client_link.resource_name FROM customer_client_link WHERE customer_client_link.status = 'PENDING'`)).length;
      const warning = pendingTotal >= 20
        ? `\nAtenção: o MCC já tem ${pendingTotal} convites pendentes (limite de 20 na hierarquia) — a API deve recusar.` : "";
      let response: Row;
      try {
        response = await validatedWrite(client, managerId, "customerClientLinks:mutate", {
          operation: { create: { clientCustomer: `customers/${clientId}`, status: "PENDING" } },
        });
      } catch (err) {
        return fail(`Falha ao convidar: ${explainError(err)}${warning}`);
      }
      if (client.isDryRun) return { content: [text(`DRY-RUN (validateOnly): convite validado, nada foi enviado.${warning}`)] };
      const resourceName = str(obj(response.result).resourceName);
      if (!resourceName) return fail(`A API não confirmou o convite — confira com list_account_links antes de repetir.\n\n${formatJson(response)}`);
      return {
        content: [text(
          `Convite enviado: MCC ${managerId} → conta ${clientId} (PENDING).\n` +
          "O cliente precisa aceitar na interface (Admin > Acesso e segurança > Gerentes) ou via respond_to_manager_invitation." +
          `${warning}\n\n${formatJson({ resource_name: resourceName, manager_link_id: lastSegment(resourceName).split("~")[1] ?? "" })}`
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "cancel_client_invitation",
    {
      description: [
        "Cancela um convite PENDING do MCC para uma conta (status CANCELED). WRITE OPERATION.",
        "Não faz nada se não houver convite pendente. Dá para convidar de novo depois.",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID do MCC que enviou o convite."),
        clientCustomerId: z.string().describe("ID da conta convidada."),
      },
    },
    async ({ managerCustomerId, clientCustomerId }) => {
      for (const id of [managerCustomerId, clientCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const managerId = customerIdOf(managerCustomerId);
      const clientId = customerIdOf(clientCustomerId);
      if (!managerId || !clientId) return fail("managerCustomerId e clientCustomerId precisam ser IDs numéricos. Nada foi enviado.");
      const client = ctx.getClient();
      const links = await clientLinks(client, managerId, clientId);
      const pending = links.find((link) => link.status === "PENDING");
      if (!pending) {
        const statuses = links.map((link) => link.status).join(", ") || "nenhum vínculo";
        return { content: [text(`Não há convite pendente do MCC ${managerId} para ${clientId} (status atual: ${statuses}). Nada foi enviado.`)] };
      }
      try {
        await validatedWrite(client, managerId, "customerClientLinks:mutate", {
          operation: { update: { resourceName: pending.resourceName, status: "CANCELED" }, updateMask: "status" },
        });
      } catch (err) {
        return fail(`Falha ao cancelar o convite: ${explainError(err)}`);
      }
      return {
        content: [text(client.isDryRun
          ? `DRY-RUN (validateOnly): cancelamento validado, nada foi gravado (${pending.resourceName}).`
          : `Convite cancelado: MCC ${managerId} → conta ${clientId} (PENDING → CANCELED).`)],
      };
    }
  );

  ctx.mcp.registerTool(
    "set_client_link_hidden",
    {
      description: [
        "Oculta ou reexibe uma conta cliente na lista do MCC (campo hidden do vínculo). WRITE OPERATION.",
        "Só vale para vínculo ATIVO; não muda acesso nem veiculação. Não faz nada se já estiver assim.",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID do MCC."),
        clientCustomerId: z.string().describe("ID da conta cliente."),
        hidden: z.boolean().describe("true = ocultar; false = reexibir."),
      },
    },
    async ({ managerCustomerId, clientCustomerId, hidden }) => {
      for (const id of [managerCustomerId, clientCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const managerId = customerIdOf(managerCustomerId);
      const clientId = customerIdOf(clientCustomerId);
      if (!managerId || !clientId) return fail("managerCustomerId e clientCustomerId precisam ser IDs numéricos. Nada foi enviado.");
      const client = ctx.getClient();
      const links = await clientLinks(client, managerId, clientId);
      const active = links.find((link) => link.status === "ACTIVE");
      if (!active) return fail(`A conta ${clientId} não tem vínculo ATIVO com o MCC ${managerId} — só vínculos ativos podem ser ocultados. Nada foi enviado.`);
      if (active.hidden === hidden) {
        return { content: [text(`A conta ${clientId} já está ${hidden ? "oculta" : "visível"} no MCC ${managerId}. Nada foi enviado.`)] };
      }
      try {
        await validatedWrite(client, managerId, "customerClientLinks:mutate", {
          operation: { update: { resourceName: active.resourceName, hidden }, updateMask: "hidden" },
        });
      } catch (err) {
        return fail(`Falha ao alterar a visibilidade: ${explainError(err)}`);
      }
      return {
        content: [text(client.isDryRun
          ? `DRY-RUN (validateOnly): alteração validada, nada foi gravado.`
          : `Conta ${clientId} agora está ${hidden ? "oculta" : "visível"} no MCC ${managerId} (antes: ${active.hidden ? "oculta" : "visível"}).`)],
      };
    }
  );

  ctx.mcp.registerTool(
    "unlink_client_account",
    {
      description: [
        "Desvincula uma conta cliente de um gerente (vínculo ACTIVE → INACTIVE, pela visão do",
        "cliente). WRITE OPERATION — difícil de desfazer: religar exige novo convite e aceite do",
        "cliente. Exige confirm: true. A conta precisa ter ao menos um usuário ativo próprio.",
        "Se o gerente desvinculado for o login deste servidor, a conta sai do alcance dele.",
      ].join("\n"),
      inputSchema: {
        managerCustomerId: z.string().describe("ID do gerente a desvincular."),
        clientCustomerId: z.string().describe("ID da conta cliente."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ managerCustomerId, clientCustomerId, confirm }) => {
      for (const id of [managerCustomerId, clientCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const managerId = customerIdOf(managerCustomerId);
      const clientId = customerIdOf(clientCustomerId);
      if (!managerId || !clientId) return fail("managerCustomerId e clientCustomerId precisam ser IDs numéricos. Nada foi enviado.");
      const client = ctx.getClient();
      const links = await managerLinks(client, clientId, managerId);
      const active = links.find((link) => link.status === "ACTIVE");
      if (!active) {
        const statuses = links.map((link) => link.status).join(", ") || "nenhum vínculo";
        return { content: [text(`A conta ${clientId} não tem vínculo ATIVO com o gerente ${managerId} (status: ${statuses}). Nada foi enviado.`)] };
      }
      const plan = { conta: clientId, gerente: managerId, vinculo: active.resourceName, antes: "ACTIVE", depois: "INACTIVE" };
      if (confirm !== true) {
        return needConfirm(`Desvincular a conta ${clientId} do gerente ${managerId}? Religar exige novo convite e aceite do cliente.`, plan);
      }
      let response: Row;
      try {
        response = await client.mutate(clientId, "customerManagerLinks", [
          { update: { resourceName: active.resourceName, status: "INACTIVE" }, updateMask: "status" },
        ]);
      } catch (err) {
        return fail(`Falha ao desvincular: ${explainError(err)}`);
      }
      if (client.isDryRun) return { content: [text(`DRY-RUN (validateOnly): desvínculo validado, nada foi gravado.\n\n${formatJson(plan)}`)] };
      const results = (response.results as Row[] | undefined) ?? [];
      if (!results[0]?.resourceName) return fail(`A API não confirmou o desvínculo — confira com list_account_links.\n\n${formatJson(response)}`);
      return { content: [text(`Conta ${clientId} desvinculada do gerente ${managerId} (ACTIVE → INACTIVE).\n\n${formatJson(plan)}`)] };
    }
  );

  ctx.mcp.registerTool(
    "move_client_account",
    {
      description: [
        "Move uma conta cliente de um gerente para outro na mesma hierarquia (MoveManagerLink:",
        "desativa o vínculo antigo e ativa o novo numa operação). WRITE OPERATION. Exige confirm: true.",
        "O gerente de destino precisa estar sob o mesmo MCC do login deste servidor.",
      ].join("\n"),
      inputSchema: {
        clientCustomerId: z.string().describe("ID da conta a mover."),
        fromManagerCustomerId: z.string().describe("ID do gerente atual."),
        toManagerCustomerId: z.string().describe("ID do novo gerente."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ clientCustomerId, fromManagerCustomerId, toManagerCustomerId, confirm }) => {
      for (const id of [clientCustomerId, fromManagerCustomerId, toManagerCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const clientId = customerIdOf(clientCustomerId);
      const fromId = customerIdOf(fromManagerCustomerId);
      const toId = customerIdOf(toManagerCustomerId);
      if (!clientId || !fromId || !toId) return fail("Os três IDs precisam ser numéricos. Nada foi enviado.");
      if (fromId === toId) return { content: [text(`Origem e destino são o mesmo gerente (${fromId}). Nada foi enviado.`)] };
      if (toId === clientId) return fail("A conta não pode gerenciar a si mesma. Nada foi enviado.");
      const client = ctx.getClient();
      const links = await managerLinks(client, clientId);
      const current = links.find((link) => link.status === "ACTIVE" && lastSegment(link.otherCustomer) === fromId);
      if (links.some((link) => link.status === "ACTIVE" && lastSegment(link.otherCustomer) === toId)) {
        return { content: [text(`A conta ${clientId} já está vinculada ao gerente ${toId}. Nada foi enviado.`)] };
      }
      if (!current) return fail(`A conta ${clientId} não tem vínculo ATIVO com o gerente ${fromId}. Nada foi enviado.`);
      const plan = { conta: clientId, de: fromId, para: toId, vinculo_atual: current.resourceName };
      if (confirm !== true) return needConfirm(`Mover a conta ${clientId} do gerente ${fromId} para ${toId}?`, plan);
      let response: Row;
      try {
        response = await validatedWrite(client, clientId, "customerManagerLinks:moveManagerLink", {
          previousCustomerManagerLink: current.resourceName,
          newManager: `customers/${toId}`,
        });
      } catch (err) {
        return fail(`Falha ao mover: ${explainError(err)}`);
      }
      if (client.isDryRun) return { content: [text(`DRY-RUN (validateOnly): movimentação validada, nada foi gravado.\n\n${formatJson(plan)}`)] };
      const resourceName = str(response.resourceName);
      if (!resourceName) return fail(`A API não confirmou a movimentação — confira com list_account_links.\n\n${formatJson(response)}`);
      return { content: [text(`Conta ${clientId} movida do gerente ${fromId} para ${toId}.\n\n${formatJson({ ...plan, novo_vinculo: resourceName })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "respond_to_manager_invitation",
    {
      description: [
        "Aceita (ACTIVE) ou recusa (REFUSED) o convite PENDING de um gerente, pela conta cliente.",
        "WRITE OPERATION. Autentica com login-customer-id = conta cliente, então o usuário OAuth deste",
        "servidor precisa ter acesso direto à conta cliente. Aceitar dá ao gerente controle da conta.",
        "Exige confirm: true.",
      ].join("\n"),
      inputSchema: {
        clientCustomerId: z.string().describe("ID da conta cliente que recebeu o convite."),
        managerCustomerId: z.string().describe("ID do gerente que convidou."),
        decision: z.enum(["ACCEPT", "REFUSE"]).describe("ACCEPT = aceitar; REFUSE = recusar."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ clientCustomerId, managerCustomerId, decision, confirm }) => {
      for (const id of [clientCustomerId, managerCustomerId]) {
        const blocked = checkCustomerAccess(id, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
      }
      const clientId = customerIdOf(clientCustomerId);
      const managerId = customerIdOf(managerCustomerId);
      if (!clientId || !managerId) return fail("clientCustomerId e managerCustomerId precisam ser IDs numéricos. Nada foi enviado.");
      const client = ctx.getClient().withLoginCustomerId(clientId);
      let links: LinkInfo[];
      try {
        links = await managerLinks(client, clientId, managerId);
      } catch (err) {
        return fail(`Não foi possível ler os vínculos autenticando como a conta ${clientId}: ${explainError(err)}\n` +
          "O usuário OAuth deste servidor precisa ter acesso direto à conta cliente. Nada foi enviado.");
      }
      const pending = links.find((link) => link.status === "PENDING");
      if (!pending) {
        const statuses = links.map((link) => link.status).join(", ") || "nenhum vínculo";
        return { content: [text(`Não há convite pendente do gerente ${managerId} na conta ${clientId} (status: ${statuses}). Nada foi enviado.`)] };
      }
      const newStatus = decision === "ACCEPT" ? "ACTIVE" : "REFUSED";
      const plan = { conta: clientId, gerente: managerId, vinculo: pending.resourceName, antes: "PENDING", depois: newStatus };
      if (confirm !== true) {
        return needConfirm(decision === "ACCEPT"
          ? `Aceitar o gerente ${managerId} na conta ${clientId}? Ele passa a controlar a conta.`
          : `Recusar o convite do gerente ${managerId} para a conta ${clientId}?`, plan);
      }
      let response: Row;
      try {
        response = await client.mutate(clientId, "customerManagerLinks", [
          { update: { resourceName: pending.resourceName, status: newStatus }, updateMask: "status" },
        ]);
      } catch (err) {
        return fail(`Falha ao responder o convite: ${explainError(err)}`);
      }
      if (client.isDryRun) return { content: [text(`DRY-RUN (validateOnly): resposta validada, nada foi gravado.\n\n${formatJson(plan)}`)] };
      if (!((response.results as Row[] | undefined) ?? [])[0]?.resourceName) {
        return fail(`A API não confirmou a resposta — confira com list_account_links (view=managers).\n\n${formatJson(response)}`);
      }
      return { content: [text(`Convite ${decision === "ACCEPT" ? "aceito" : "recusado"}: conta ${clientId} ↔ gerente ${managerId} (PENDING → ${newStatus}).\n\n${formatJson(plan)}`)] };
    }
  );

  // ══ Usuários e aprovações ════════════════════════════════════════

  ctx.mcp.registerTool(
    "list_account_users",
    {
      description: [
        "Auditoria de acesso: usuários com acesso direto à conta (papel, quem convidou, desde",
        "quando, passkey) e convites pendentes. Sinaliza ADMINs, usuários sem passkey e mudanças",
        "aguardando aprovação multi-party. allAccounts=true varre as contas sob um MCC (offboarding:",
        "quem ainda é ADMIN em qual cliente). Acesso herdado via gerente não aparece aqui.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Conta a auditar (obrigatório sem allAccounts)."),
        allAccounts: z.boolean().optional().describe("true = todas as contas ativas sob managerCustomerId (inclui o próprio MCC)."),
        managerCustomerId: z.string().optional().describe("MCC de partida quando allAccounts=true."),
        email: z.string().optional().describe("Filtra por um e-mail (ex.: offboarding de uma pessoa)."),
        onlyIssues: z.boolean().optional().describe("true = só ADMINs, usuários sem passkey e pendências."),
        includeInvitations: z.boolean().optional().describe("Lista convites pendentes (padrão: true)."),
        maxAccounts: z.number().int().positive().max(500).optional().describe("Máximo de contas em allAccounts. Padrão: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, allAccounts, managerCustomerId, email, onlyIssues, includeInvitations, maxAccounts, format }) => {
      const client = ctx.getClient();
      let accounts: ManagedAccount[];
      let scopeNote = "";
      if (allAccounts) {
        if (!managerCustomerId) return fail("allAccounts=true exige managerCustomerId (o MCC de partida).");
        const blocked = checkCustomerAccess(managerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const managerId = customerIdOf(managerCustomerId);
        if (!managerId) return fail(`managerCustomerId inválido: "${managerCustomerId}".`);
        const scope = await managedAccounts(client, ctx, managerId, maxAccounts ?? 50);
        accounts = scope.accounts;
        if (scope.outsideAllowlist) scopeNote += ` ${scope.outsideAllowlist} conta(s) fora da allowlist ignorada(s).`;
        if (scope.truncated) scopeNote += ` ${scope.truncated} conta(s) além de maxAccounts não lida(s).`;
      } else {
        if (!customerId) return fail("Informe customerId (ou allAccounts=true com managerCustomerId).");
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const cid = customerIdOf(customerId);
        if (!cid) return fail(`customerId inválido: "${customerId}".`);
        accounts = [{ id: cid, name: "", manager: false, level: 0 }];
      }
      const wanted = email?.trim().toLowerCase();
      const errors: Row[] = [];
      const perAccount = await mapLimit(accounts, 5, async (account) => {
        try {
          const users = await readUsers(client, account.id);
          const invitations = includeInvitations === false ? [] : await readInvitations(client, account.id);
          return { account, users, invitations };
        } catch (err) {
          errors.push({ customer_id: account.id, name: account.name, error: explainError(err) });
          return { account, users: [] as UserAccess[], invitations: [] as UserInvitation[] };
        }
      });
      const rows: Row[] = [];
      for (const { account, users, invitations } of perAccount) {
        for (const user of users) {
          if (wanted && user.email.toLowerCase() !== wanted) continue;
          // EMAIL_ONLY é destinatário de e-mail, não login: passkey não se aplica.
          const needsPasskey = user.role !== "EMAIL_ONLY";
          const flags = [
            user.role === "ADMIN" ? "ADMIN" : "",
            needsPasskey && !user.passkeyEnabled ? "SEM_PASSKEY" : "",
            user.pendingReview ? "APROVACAO_PENDENTE" : "",
          ].filter(Boolean);
          if (onlyIssues && flags.length === 0) continue;
          rows.push({
            customer_id: account.id, account_name: account.name, type: "usuario", user_id: user.userId,
            email: user.email, role: user.role, passkey: user.passkeyEnabled, invited_by: user.inviter,
            since: user.createdAt, flags: flags.join(" "), pending_review: user.pendingReview,
          });
        }
        for (const inv of invitations) {
          if (wanted && inv.email.toLowerCase() !== wanted) continue;
          rows.push({
            customer_id: account.id, account_name: account.name, type: "convite_pendente", user_id: "",
            invitation_id: inv.invitationId, email: inv.email, role: inv.role, since: inv.createdAt,
            flags: inv.role === "ADMIN" ? "CONVITE_ADMIN" : "CONVITE",
          });
        }
      }
      const users = rows.filter((row) => row.type === "usuario");
      const summary = {
        contas: accounts.length,
        usuarios: users.length,
        admins: users.filter((row) => row.role === "ADMIN").length,
        admins_sem_passkey: users.filter((row) => row.role === "ADMIN" && row.passkey !== true).length,
        sem_passkey: users.filter((row) => String(row.flags).includes("SEM_PASSKEY")).length,
        aprovacoes_pendentes: users.filter((row) => row.pending_review).length,
        convites_pendentes: rows.length - users.length,
        contas_com_erro: errors.length,
      };
      const header = `Acesso de usuários — ${formatJson(summary).replace(/\s+/g, " ")}.${scopeNote}` +
        (errors.length ? `\nContas com erro de leitura: ${errors.map((e) => e.customer_id).join(", ")}.` : "");
      return {
        content: [text(renderRows(rows, format, header, { resumo: summary, ...(errors.length ? { erros: errors } : {}) }))],
        isError: errors.length > 0 && errors.length === accounts.length,
      };
    }
  );

  ctx.mcp.registerTool(
    "invite_user",
    {
      description: [
        "Convida um e-mail para acessar a conta com um papel (ADMIN, STANDARD, READ_ONLY, EMAIL_ONLY).",
        "WRITE OPERATION. Exige confirm: true. Não faz nada se o e-mail já tem acesso ou convite",
        "pendente. Pode gerar aprovação multi-party (outro ADMIN aprova com resolve_approval).",
        "A API não tem validate_only para convites: em dry-run/validateOnly a tool recusa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        emailAddress: z.string().describe("E-mail a convidar."),
        accessRole: z.enum(ACCESS_ROLES).describe("Papel de acesso."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, emailAddress, accessRole, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const emailValue = emailAddress.trim();
      if (!EMAIL.test(emailValue)) return fail(`E-mail inválido: "${emailAddress}". Nada foi enviado.`);
      const client = ctx.getClient();
      if (client.isDryRun) return noValidateOnly("CustomerUserAccessInvitationService (convite de usuário)");
      const users = await readUsers(client, cid);
      const existing = findUser(users, undefined, emailValue);
      if (existing) {
        return { content: [text(`${emailValue} já tem acesso à conta ${cid} como ${existing.role}. Nada foi enviado. Para mudar o papel use change_user_role.`)] };
      }
      const invitations = await readInvitations(client, cid);
      const pending = invitations.find((inv) => inv.email.toLowerCase() === emailValue.toLowerCase());
      if (pending) {
        return { content: [text(`${emailValue} já tem convite pendente (${pending.role}, desde ${pending.createdAt}). Nada foi enviado. Para trocar o papel, revogue com revoke_user_invitation e convide de novo.`)] };
      }
      const plan = { conta: cid, email: emailValue, papel: accessRole };
      if (confirm !== true) {
        return needConfirm(`Convidar ${emailValue} como ${accessRole} na conta ${cid}?${accessRole === "ADMIN" ? " ADMIN controla usuários e faturamento." : ""}`, plan);
      }
      let response: Row;
      try {
        response = await client.customerWriteAction<Row>(cid, "customerUserAccessInvitations:mutate", {
          operation: { create: { emailAddress: emailValue, accessRole } },
        });
      } catch (err) {
        return fail(`Falha ao convidar: ${explainError(err)}`);
      }
      const outcome = mpaOutcome(response, `Convite enviado para ${emailValue} (${accessRole}). A pessoa precisa aceitar pelo e-mail; o status pode levar até 24 h para mudar e o convite expira em 20 dias.`);
      if (!outcome.pendingReview && !outcome.resourceName) return fail(`A API não confirmou o convite — confira com list_account_users.\n\n${formatJson(response)}`);
      return { content: [text(`${outcome.message}\n\n${formatJson({ ...plan, resource_name: outcome.resourceName || null, multi_party_auth_review: outcome.pendingReview || null })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "change_user_role",
    {
      description: [
        "Muda o papel de um usuário na conta (ADMIN, STANDARD, READ_ONLY, EMAIL_ONLY). WRITE OPERATION.",
        "Identifique por userId ou emailAddress (list_account_users). Exige confirm: true. Recusa",
        "rebaixar o último ADMIN. Pode gerar aprovação multi-party. Sem validate_only na API:",
        "recusada em dry-run/validateOnly.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userId: z.string().optional().describe("user_id do usuário."),
        emailAddress: z.string().optional().describe("E-mail do usuário (alternativa ao userId)."),
        accessRole: z.enum(ACCESS_ROLES).describe("Novo papel."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, userId, emailAddress, accessRole, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      if (!userId && !emailAddress) return fail("Informe userId ou emailAddress. Nada foi enviado.");
      if (userId && !/^\d+$/.test(userId.trim())) return fail(`userId deve ser numérico, recebido "${userId}". Nada foi enviado.`);
      const client = ctx.getClient();
      if (client.isDryRun) return noValidateOnly("CustomerUserAccessService (papel de usuário)");
      const users = await readUsers(client, cid);
      const user = findUser(users, userId?.trim(), emailAddress);
      if (!user) return fail(`Usuário ${userId ?? emailAddress} não tem acesso direto à conta ${cid}. Nada foi enviado.`);
      if (user.role === accessRole) return { content: [text(`${user.email} já é ${accessRole} na conta ${cid}. Nada foi enviado.`)] };
      if (user.role === "ADMIN" && users.filter((u) => u.role === "ADMIN").length === 1) {
        return fail(`${user.email} é o único ADMIN da conta ${cid}: rebaixá-lo deixaria a conta sem administrador. Promova outro usuário antes. Nada foi enviado.`);
      }
      const plan = { conta: cid, usuario: user.email, user_id: user.userId, antes: user.role, depois: accessRole };
      if (user.pendingReview) {
        return fail(`${user.email} já tem uma mudança aguardando aprovação multi-party (${user.pendingReview}). Resolva antes com resolve_approval. Nada foi enviado.`);
      }
      if (confirm !== true) return needConfirm(`Mudar ${user.email} de ${user.role} para ${accessRole} na conta ${cid}?`, plan);
      let response: Row;
      try {
        response = await client.customerWriteAction<Row>(cid, "customerUserAccesses:mutate", {
          operation: { update: { resourceName: user.resourceName, accessRole }, updateMask: "access_role" },
        });
      } catch (err) {
        return fail(`Falha ao mudar o papel: ${explainError(err)}`);
      }
      const outcome = mpaOutcome(response, `Papel de ${user.email} alterado: ${user.role} → ${accessRole}.`);
      if (!outcome.pendingReview && !outcome.resourceName) return fail(`A API não confirmou a mudança — confira com list_account_users.\n\n${formatJson(response)}`);
      return { content: [text(`${outcome.message}\n\n${formatJson({ ...plan, multi_party_auth_review: outcome.pendingReview || null })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "remove_user",
    {
      description: [
        "Remove o acesso de um usuário à conta (offboarding). WRITE OPERATION — para voltar é preciso",
        "novo convite. Identifique por userId ou emailAddress. Exige confirm: true. Recusa remover o",
        "último ADMIN. Pode gerar aprovação multi-party. Recusada em dry-run/validateOnly.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        userId: z.string().optional().describe("user_id do usuário."),
        emailAddress: z.string().optional().describe("E-mail do usuário (alternativa ao userId)."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, userId, emailAddress, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      if (!userId && !emailAddress) return fail("Informe userId ou emailAddress. Nada foi enviado.");
      if (userId && !/^\d+$/.test(userId.trim())) return fail(`userId deve ser numérico, recebido "${userId}". Nada foi enviado.`);
      const client = ctx.getClient();
      if (client.isDryRun) return noValidateOnly("CustomerUserAccessService (remoção de usuário)");
      const users = await readUsers(client, cid);
      const user = findUser(users, userId?.trim(), emailAddress);
      if (!user) return { content: [text(`Usuário ${userId ?? emailAddress} não tem acesso direto à conta ${cid}. Nada foi enviado.`)] };
      if (user.role === "ADMIN" && users.filter((u) => u.role === "ADMIN").length === 1) {
        return fail(`${user.email} é o único ADMIN da conta ${cid}: removê-lo deixaria a conta sem administrador. Nada foi enviado.`);
      }
      const plan = { conta: cid, usuario: user.email, user_id: user.userId, papel: user.role };
      if (confirm !== true) return needConfirm(`Remover o acesso de ${user.email} (${user.role}) da conta ${cid}?`, plan);
      let response: Row;
      try {
        response = await client.customerWriteAction<Row>(cid, "customerUserAccesses:mutate", { operation: { remove: user.resourceName } });
      } catch (err) {
        return fail(`Falha ao remover: ${explainError(err)}`);
      }
      const outcome = mpaOutcome(response, `Acesso de ${user.email} removido da conta ${cid}.`);
      if (!outcome.pendingReview && !outcome.resourceName) return fail(`A API não confirmou a remoção — confira com list_account_users.\n\n${formatJson(response)}`);
      return { content: [text(`${outcome.message}\n\n${formatJson({ ...plan, multi_party_auth_review: outcome.pendingReview || null })}`)] };
    }
  );

  ctx.mcp.registerTool(
    "revoke_user_invitation",
    {
      description: [
        "Revoga um convite de usuário PENDING (por invitationId ou emailAddress). WRITE OPERATION.",
        "Exige confirm: true. Recusada em dry-run/validateOnly (a API não tem validate_only).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        invitationId: z.string().optional().describe("ID do convite (list_account_users)."),
        emailAddress: z.string().optional().describe("E-mail convidado (alternativa ao invitationId)."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, invitationId, emailAddress, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      if (!invitationId && !emailAddress) return fail("Informe invitationId ou emailAddress. Nada foi enviado.");
      if (invitationId && !/^\d+$/.test(invitationId.trim())) return fail(`invitationId deve ser numérico, recebido "${invitationId}". Nada foi enviado.`);
      const client = ctx.getClient();
      if (client.isDryRun) return noValidateOnly("CustomerUserAccessInvitationService (revogar convite)");
      const invitations = await readInvitations(client, cid);
      const invitation = invitationId
        ? invitations.find((inv) => inv.invitationId === invitationId.trim())
        : invitations.find((inv) => inv.email.toLowerCase() === (emailAddress ?? "").trim().toLowerCase());
      if (!invitation) return { content: [text(`Não há convite pendente ${invitationId ?? emailAddress} na conta ${cid}. Nada foi enviado.`)] };
      const plan = { conta: cid, email: invitation.email, papel: invitation.role, invitation_id: invitation.invitationId };
      if (confirm !== true) return needConfirm(`Revogar o convite de ${invitation.email} (${invitation.role})?`, plan);
      let response: Row;
      try {
        response = await client.customerWriteAction<Row>(cid, "customerUserAccessInvitations:mutate", { operation: { remove: invitation.resourceName } });
      } catch (err) {
        return fail(`Falha ao revogar: ${explainError(err)}`);
      }
      const outcome = mpaOutcome(response, `Convite de ${invitation.email} revogado.`);
      if (!outcome.pendingReview && !outcome.resourceName) return fail(`A API não confirmou a revogação — confira com list_account_users.\n\n${formatJson(response)}`);
      return { content: [text(`${outcome.message}\n\n${formatJson(plan)}`)] };
    }
  );

  ctx.mcp.registerTool(
    "list_pending_approvals",
    {
      description: [
        "Pedidos de aprovação multi-party (MPA) da conta: convites, mudanças de papel e remoções",
        "de usuário que aguardam um segundo ADMIN. Expiram em 20 dias. Padrão: só PENDING.",
        "Resolva com resolve_approval.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        status: z.enum(["PENDING", "APPROVED", "REJECTED", "REVOKED", "EXPIRED", "ALL"]).optional().describe("Filtro de status. Padrão: PENDING."),
      },
    },
    async ({ customerId, status }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      const filter = status ?? "PENDING";
      const client = ctx.getClient();
      const rows = await client.searchStream(cid,
        `SELECT multi_party_auth_review.resource_name, multi_party_auth_review.multi_party_auth_review_id,
                multi_party_auth_review.creation_date_time, multi_party_auth_review.request_user_email,
                multi_party_auth_review.operation_type, multi_party_auth_review.justification,
                multi_party_auth_review.target_resource, multi_party_auth_review.review_status,
                multi_party_auth_review.approval_date_time,
                multi_party_auth_review.customer_user_access_review.old_customer_user_access,
                multi_party_auth_review.customer_user_access_review.new_customer_user_access,
                multi_party_auth_review.customer_user_access_invitation_review.new_customer_user_access_invitation
         FROM multi_party_auth_review${filter === "ALL" ? "" : `\n         WHERE multi_party_auth_review.review_status = '${filter}'`}`);
      const reviews = rows.map((row) => {
        const review = obj(row.multiPartyAuthReview);
        const accessReview = obj(review.customerUserAccessReview);
        const invitationReview = obj(review.customerUserAccessInvitationReview);
        return {
          review_id: str(review.multiPartyAuthReviewId),
          status: str(review.reviewStatus),
          operation: str(review.operationType),
          target: str(review.targetResource),
          requested_by: str(review.requestUserEmail),
          created: str(review.creationDateTime),
          justification: str(review.justification),
          old_access: str(accessReview.oldCustomerUserAccess) || null,
          new_access: Object.keys(obj(accessReview.newCustomerUserAccess)).length ? accessReview.newCustomerUserAccess : null,
          new_invitation: Object.keys(obj(invitationReview.newCustomerUserAccessInvitation)).length ? invitationReview.newCustomerUserAccessInvitation : null,
          resource_name: str(review.resourceName),
        };
      });
      return {
        content: [text(`${reviews.length} pedido(s) de aprovação multi-party (${filter}) na conta ${cid}.` +
          `${reviews.length && filter === "PENDING" ? "\nResolva com resolve_approval (APPROVED/REJECTED por outro ADMIN; REVOKED pelo solicitante)." : ""}\n\n${formatJson(reviews)}`)],
      };
    }
  );

  ctx.mcp.registerTool(
    "resolve_approval",
    {
      description: [
        "Resolve um pedido de aprovação multi-party: APPROVED ou REJECTED (por outro ADMIN, não quem",
        "pediu) ou REVOKED (só quem pediu). WRITE OPERATION. Exige confirm: true. A API não tem",
        "validate_only: recusada em dry-run/validateOnly.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        reviewId: z.string().describe("review_id (list_pending_approvals) ou o resource name completo."),
        decision: z.enum(["APPROVED", "REJECTED", "REVOKED"]).describe("Decisão."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, reviewId, decision, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const ref = reviewId.trim();
      const match = /^customers\/(\d+)\/multiPartyAuthReviews\/(\d+)$/.exec(ref);
      if (match && match[1] !== cid) return fail(`${ref} pertence à conta ${match[1]}, não à ${cid}. Nada foi enviado.`);
      const id = match ? match[2] : ref;
      if (!/^\d+$/.test(id)) return fail(`reviewId inválido: "${reviewId}". Nada foi enviado.`);
      const client = ctx.getClient();
      if (client.isDryRun) return noValidateOnly("MultiPartyAuthReviewService");
      const rows = await client.searchStream(cid,
        `SELECT multi_party_auth_review.resource_name, multi_party_auth_review.review_status,
                multi_party_auth_review.operation_type, multi_party_auth_review.target_resource,
                multi_party_auth_review.request_user_email
         FROM multi_party_auth_review
         WHERE multi_party_auth_review.multi_party_auth_review_id = ${id}`);
      const review = obj(rows[0]?.multiPartyAuthReview);
      if (!rows.length) return fail(`Pedido de aprovação ${id} não encontrado na conta ${cid}. Nada foi enviado.`);
      if (review.reviewStatus !== "PENDING") {
        return { content: [text(`O pedido ${id} não está pendente (status ${str(review.reviewStatus)}). Nada foi enviado.`)] };
      }
      const plan = {
        conta: cid, review: str(review.resourceName), operacao: str(review.operationType),
        alvo: str(review.targetResource), pedido_por: str(review.requestUserEmail), decisao: decision,
      };
      if (confirm !== true) return needConfirm(`Resolver o pedido ${id} como ${decision}?`, plan);
      let response: Row;
      try {
        response = await client.customerWriteAction<Row>(cid, "multiPartyAuthReview:resolve", {
          operations: [{ multiPartyAuthReview: str(review.resourceName), newStatus: decision }],
        });
      } catch (err) {
        return fail(`Falha ao resolver: ${explainError(err)}`);
      }
      const item = obj(((response.resultOrError as Row[] | undefined) ?? [])[0]);
      if (item.partialFailureError) {
        const { unattributed, byIndex } = partialFailureByOperation(item.partialFailureError, 1);
        return fail(`A API recusou a resolução: ${[...(byIndex.get(0) ?? []), ...unattributed].join("; ")}\n\n${formatJson(plan)}`);
      }
      const result = obj(item.result);
      if (!result.multiPartyAuthReview) return fail(`A API não confirmou a resolução — confira com list_pending_approvals.\n\n${formatJson(response)}`);
      return { content: [text(`Pedido ${id} resolvido como ${decision}.\n\n${formatJson({ ...plan, resultado: result })}`)] };
    }
  );

  // ══ Faturamento ══════════════════════════════════════════════════

  ctx.mcp.registerTool(
    "get_billing_status",
    {
      description: [
        "Situação de faturamento: configuração de pagamento (billing setup) e orçamento da conta",
        "(account budget) — limite aprovado/ajustado, valor já veiculado, saldo restante e data de",
        "fim. Alerta quando o saldo fica abaixo de alertBelowPercent ou o fim está a alertDaysToEnd",
        "dias (quando o orçamento acaba, TODOS os anúncios param). Só contas em faturamento mensal",
        "têm orçamento de conta; em pré-pago/cartão a API não expõe saldo. allAccounts=true varre o MCC.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().optional().describe("Conta (obrigatório sem allAccounts)."),
        allAccounts: z.boolean().optional().describe("true = contas de anúncio ativas sob managerCustomerId."),
        managerCustomerId: z.string().optional().describe("MCC de partida quando allAccounts=true."),
        alertBelowPercent: z.number().min(0).max(100).optional().describe("Alerta com saldo abaixo deste % do limite. Padrão: 20."),
        alertDaysToEnd: z.number().int().min(0).optional().describe("Alerta quando faltam até N dias para o fim. Padrão: 7."),
        maxAccounts: z.number().int().positive().max(500).optional().describe("Máximo de contas de anúncio lidas em allAccounts (MCC e sub-MCCs não contam). Padrão: 50."),
        format: formatSchema,
      },
    },
    async ({ customerId, allAccounts, managerCustomerId, alertBelowPercent, alertDaysToEnd, maxAccounts, format }) => {
      const client = ctx.getClient();
      let accounts: ManagedAccount[];
      let scopeNote = "";
      if (allAccounts) {
        if (!managerCustomerId) return fail("allAccounts=true exige managerCustomerId (o MCC de partida).");
        const blocked = checkCustomerAccess(managerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const managerId = customerIdOf(managerCustomerId);
        if (!managerId) return fail(`managerCustomerId inválido: "${managerCustomerId}".`);
        // Gerentes não têm faturamento: saem antes do corte em maxAccounts (não ocupam vaga).
        const scope = await managedAccounts(client, ctx, managerId, maxAccounts ?? 50, { onlyAdAccounts: true });
        accounts = scope.accounts;
        if (scope.outsideAllowlist) scopeNote += ` ${scope.outsideAllowlist} conta(s) de anúncio fora da allowlist ignorada(s).`;
        if (scope.truncated) scopeNote += ` ${scope.truncated} conta(s) de anúncio além de maxAccounts não lida(s).`;
      } else {
        if (!customerId) return fail("Informe customerId (ou allAccounts=true com managerCustomerId).");
        const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blocked) return { content: [blocked], isError: true };
        const cid = customerIdOf(customerId);
        if (!cid) return fail(`customerId inválido: "${customerId}".`);
        accounts = [{ id: cid, name: "", manager: false, level: 0 }];
      }
      const pctLimit = alertBelowPercent ?? 20;
      const daysLimit = alertDaysToEnd ?? 7;
      const now = new Date();
      const results = await mapLimit(accounts, 5, async (account) => {
        try {
          const customer = obj((await client.searchStream(account.id,
            "SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1"))[0]?.customer);
          const setups = (await client.searchStream(account.id,
            `SELECT billing_setup.resource_name, billing_setup.id, billing_setup.status,
                    billing_setup.payments_account, billing_setup.payments_account_info.payments_account_id,
                    billing_setup.payments_account_info.payments_account_name,
                    billing_setup.payments_account_info.payments_profile_id,
                    billing_setup.payments_account_info.payments_profile_name,
                    billing_setup.start_date_time, billing_setup.end_date_time, billing_setup.end_time_type
             FROM billing_setup`)).map((row) => {
            const setup = obj(row.billingSetup);
            const info = obj(setup.paymentsAccountInfo);
            return {
              id: str(setup.id), status: str(setup.status),
              payments_account_id: str(info.paymentsAccountId), payments_account_name: str(info.paymentsAccountName),
              payments_profile_id: str(info.paymentsProfileId), payments_profile_name: str(info.paymentsProfileName),
              start: str(setup.startDateTime), end: setup.endTimeType === "FOREVER" ? "FOREVER" : str(setup.endDateTime),
            };
          });
          const budgets = (await client.searchStream(account.id,
            `SELECT ${ACCOUNT_BUDGET_FIELDS}
             FROM account_budget
             WHERE account_budget.status != 'CANCELLED'`)).map((row) => budgetView(row, now));
          const active = budgets.find((budget) => budget.phase === "ativo");
          const next = budgets.find((budget) => budget.phase === "futuro");
          const alerts: string[] = [];
          if (!budgets.length) {
            alerts.push(setups.length
              ? "Sem orçamento de conta: a conta não usa faturamento mensal (ou não há orçamento) — saldo pré-pago/cartão não é exposto pela API."
              : "Sem configuração de faturamento visível pela API.");
          } else if (!active) {
            alerts.push(next ? `Nenhum orçamento em vigor agora — o próximo começa em ${next.start}. Os anúncios ficam parados até lá.`
              : "Nenhum orçamento de conta em vigor: os anúncios da conta ficam parados.");
          } else {
            if (active.remaining_pct !== null && active.remaining_pct < pctLimit) {
              alerts.push(`Saldo do orçamento da conta em ${active.remaining_pct}% (${active.remaining} ${str(customer.currencyCode)} restantes) — abaixo de ${pctLimit}%.`);
            }
            if (active.days_to_end !== null && active.days_to_end <= daysLimit) {
              alerts.push(`O orçamento da conta termina em ${active.days_to_end} dia(s) (${active.end})${next ? `; o próximo começa em ${next.start}` : " e não há próximo orçamento aprovado"}.`);
            }
            if (active.pending_proposal) alerts.push(`Proposta ${active.pending_proposal_type} pendente de revisão: ${active.pending_proposal}.`);
          }
          const strip = (budget?: BudgetView) => {
            if (!budget) return null;
            const { raw, ...view } = budget;
            void raw;
            return view;
          };
          return {
            customer_id: account.id,
            name: str(customer.descriptiveName) || account.name,
            currency: str(customer.currencyCode),
            alerts,
            active_budget: strip(active),
            next_budget: strip(next),
            billing_setups: setups,
            other_budgets: budgets.filter((budget) => budget !== active && budget !== next).map(strip),
          };
        } catch (err) {
          return { customer_id: account.id, name: account.name, error: explainError(err), alerts: [] as string[] };
        }
      });
      const withAlerts = results.filter((result) => result.alerts.length > 0);
      const failed = results.filter((result) => "error" in result);
      const header = `Faturamento de ${results.length} conta(s): ${withAlerts.length} com alerta, ${failed.length} com erro.${scopeNote}`;
      if (format === "table" || format === "csv") {
        const flat = results.map((result) => {
          const active = obj((result as Row).active_budget);
          return {
            customer_id: result.customer_id, name: result.name, currency: str((result as Row).currency),
            limit: active.unlimited ? "ILIMITADO" : str(active.limit), served: str(active.served),
            remaining: str(active.remaining), remaining_pct: str(active.remaining_pct), end: str(active.end),
            days_to_end: str(active.days_to_end), alerts: result.alerts.join(" | "), error: str((result as Row).error),
          };
        });
        return { content: [text(format === "csv" ? formatAsCsv(flat) : `${header}\n\n${formatAsTable(flat)}`)] };
      }
      return {
        content: [text(`${header}\n\n${formatJson(results)}`)],
        isError: failed.length > 0 && failed.length === results.length,
      };
    }
  );

  ctx.mcp.registerTool(
    "propose_account_budget",
    {
      description: [
        "Proposta de orçamento de conta (account budget) — só contas em faturamento mensal.",
        "WRITE OPERATION. Exige confirm: true. A proposta passa por revisão do Google (em geral < 1 h).",
        "- CREATE: novo orçamento (billingSetupId, name, limite, início NOW/data, fim FOREVER/data).",
        "  Só um orçamento pode estar ativo: o novo precisa começar depois do fim do atual.",
        "- UPDATE: muda nome, limite, fim (e início, se não começou) de accountBudgetId; só envia o",
        "  que mudou. Não faz nada se tudo já for igual.",
        "- END: encerra agora o orçamento em andamento (os anúncios param).",
        "- REMOVE: remove um orçamento aprovado que ainda não começou.",
        "Valores em micros da moeda da conta. Datas 'YYYY-MM-DD HH:MM:SS' no fuso da conta.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        proposalType: z.enum(["CREATE", "UPDATE", "END", "REMOVE"]).describe("Tipo de proposta."),
        billingSetupId: z.string().optional().describe("CREATE: ID do billing setup (get_billing_status). Se omitido e houver só um aprovado, usa ele."),
        accountBudgetId: z.string().optional().describe("UPDATE/END/REMOVE: ID do orçamento de conta."),
        name: z.string().optional().describe("Nome do orçamento (obrigatório no CREATE)."),
        spendingLimitMicros: z.number().int().nonnegative().optional().describe("Limite de gasto em micros (1.000.000 = 1 unidade da moeda)."),
        unlimitedSpending: z.boolean().optional().describe("true = limite ilimitado (INFINITE), no lugar de spendingLimitMicros."),
        startDateTime: z.string().optional().describe("CREATE/UPDATE: 'NOW' ou 'YYYY-MM-DD[ HH:MM:SS]'. Padrão no CREATE: NOW."),
        endDateTime: z.string().optional().describe("'FOREVER' ou 'YYYY-MM-DD[ HH:MM:SS]'. Obrigatório no CREATE."),
        purchaseOrderNumber: z.string().optional().describe("Número do pedido de compra (aparece na fatura)."),
        notes: z.string().optional().describe("Observações."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, proposalType, billingSetupId, accountBudgetId, name, spendingLimitMicros, unlimitedSpending, startDateTime, endDateTime, purchaseOrderNumber, notes, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      if (spendingLimitMicros !== undefined && unlimitedSpending === true) return fail("Use spendingLimitMicros OU unlimitedSpending, não os dois. Nada foi enviado.");
      for (const [label, value] of [["billingSetupId", billingSetupId], ["accountBudgetId", accountBudgetId]] as const) {
        if (value !== undefined && !/^\d+$/.test(value.trim())) return fail(`${label} deve ser numérico, recebido "${value}". Nada foi enviado.`);
      }
      const start = startDateTime !== undefined ? proposalTime(startDateTime, "start") : undefined;
      if (start === null) return fail(`startDateTime inválido: "${startDateTime}" (use NOW ou YYYY-MM-DD[ HH:MM:SS]). Nada foi enviado.`);
      const end = endDateTime !== undefined ? proposalTime(endDateTime, "end") : undefined;
      if (end === null) return fail(`endDateTime inválido: "${endDateTime}" (use FOREVER ou YYYY-MM-DD[ HH:MM:SS]). Nada foi enviado.`);
      if (start?.field === "proposedStartDateTime" && end?.field === "proposedEndDateTime" && end.value <= start.value) {
        return fail("endDateTime precisa ser depois de startDateTime. Nada foi enviado.");
      }
      // A API recusa início/fim no passado; a data é comparada por dia (fuso do servidor ≈ fuso da conta).
      const today = new Date();
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      for (const [label, time] of [["startDateTime", start], ["endDateTime", end]] as const) {
        if (time && /DateTime$/.test(time.field) && time.value.slice(0, 10) < todayIso) {
          return fail(`${label} ${time.value} está no passado (hoje é ${todayIso}). Use ${label === "startDateTime" ? "NOW" : "uma data futura"}. Nada foi enviado.`);
        }
      }
      const limitField: Row | undefined = unlimitedSpending === true
        ? { proposedSpendingLimitType: "INFINITE" }
        : spendingLimitMicros !== undefined ? { proposedSpendingLimitMicros: String(spendingLimitMicros) } : undefined;

      const client = ctx.getClient();
      const currency = str(obj((await client.searchStream(cid, "SELECT customer.currency_code FROM customer LIMIT 1"))[0]?.customer).currencyCode);
      const money = (m: unknown) => `${units(m).toFixed(2)} ${currency}`;
      let proposal: Row;
      let updateMask: string | undefined;
      let plan: Row;
      const warnings: string[] = [];

      if (proposalType === "CREATE") {
        if (!name?.trim()) return fail("CREATE exige name (todo orçamento de conta precisa de nome). Nada foi enviado.");
        if (!limitField) return fail("CREATE exige spendingLimitMicros ou unlimitedSpending: true. Nada foi enviado.");
        if (!end) return fail("CREATE exige endDateTime ('FOREVER' ou uma data). Nada foi enviado.");
        if (accountBudgetId) return fail("CREATE não usa accountBudgetId. Nada foi enviado.");
        const setups = (await client.searchStream(cid,
          `SELECT billing_setup.resource_name, billing_setup.id, billing_setup.status,
                  billing_setup.payments_account_info.payments_account_name
           FROM billing_setup`)).map((row) => obj(row.billingSetup));
        const approved = setups.filter((setup) => setup.status === "APPROVED" || setup.status === "APPROVED_HELD");
        const setup = billingSetupId
          ? setups.find((s) => str(s.id) === billingSetupId.trim())
          : approved.length === 1 ? approved[0] : undefined;
        if (!setup) {
          return fail(billingSetupId
            ? `Billing setup ${billingSetupId} não encontrado na conta ${cid}. Nada foi enviado.`
            : `Informe billingSetupId: a conta tem ${approved.length} billing setup(s) aprovado(s) (${approved.map((s) => str(s.id)).join(", ") || "nenhum"}). Nada foi enviado.`);
        }
        if (setup.status === "CANCELLED") return fail(`O billing setup ${str(setup.id)} está cancelado. Nada foi enviado.`);
        const active = (await client.searchStream(cid,
          `SELECT ${ACCOUNT_BUDGET_FIELDS} FROM account_budget WHERE account_budget.status = 'APPROVED'`))
          .map((row) => budgetView(row)).find((budget) => budget.phase === "ativo");
        if (active) {
          warnings.push(`Já há um orçamento em vigor (${active.id}, fim ${active.end}): o novo precisa começar depois do fim dele, senão a API recusa (OVERLAPS_EXISTING_BUDGET).`);
        }
        proposal = {
          billingSetup: str(setup.resourceName),
          proposalType: "CREATE",
          proposedName: name.trim(),
          [(start ?? { field: "proposedStartTimeType" }).field]: (start ?? { value: "NOW" }).value,
          [end.field]: end.value,
          ...limitField,
          ...(purchaseOrderNumber ? { proposedPurchaseOrderNumber: purchaseOrderNumber.trim() } : {}),
          ...(notes ? { proposedNotes: notes.trim() } : {}),
        };
        plan = {
          tipo: "CREATE", conta: cid, billing_setup: str(setup.resourceName), nome: name.trim(),
          inicio: (start ?? { value: "NOW" }).value, fim: end.value,
          limite: unlimitedSpending ? "ILIMITADO" : money(spendingLimitMicros),
        };
      } else {
        if (!accountBudgetId) return fail(`${proposalType} exige accountBudgetId (get_billing_status mostra o ID). Nada foi enviado.`);
        if (billingSetupId) return fail(`${proposalType} não usa billingSetupId. Nada foi enviado.`);
        const rows = await client.searchStream(cid,
          `SELECT ${ACCOUNT_BUDGET_FIELDS} FROM account_budget WHERE account_budget.id = ${accountBudgetId.trim()}`);
        if (!rows.length) return fail(`Orçamento de conta ${accountBudgetId} não encontrado na conta ${cid}. Nada foi enviado.`);
        const budget = budgetView(rows[0]);
        if (budget.pending_proposal) {
          return fail(`O orçamento ${budget.id} já tem proposta ${budget.pending_proposal_type} pendente (${budget.pending_proposal}). ` +
            "Aguarde a revisão ou cancele com cancel_account_budget_proposal. Nada foi enviado.");
        }
        if (proposalType === "END" || proposalType === "REMOVE") {
          if (name || limitField || start || end || purchaseOrderNumber || notes) {
            return fail(`${proposalType} não leva outros campos (a API exige updateMask vazio). Nada foi enviado.`);
          }
          if (budget.status !== "APPROVED") return fail(`O orçamento ${budget.id} não está aprovado (status ${budget.status}). Nada foi enviado.`);
          if (proposalType === "END" && budget.phase !== "ativo") {
            return fail(`END só encerra orçamento em andamento; o ${budget.id} está ${budget.phase}. ${budget.phase === "futuro" ? "Use REMOVE." : ""} Nada foi enviado.`);
          }
          if (proposalType === "REMOVE" && budget.phase !== "futuro") {
            return fail(`REMOVE só vale antes do início; o orçamento ${budget.id} está ${budget.phase}. ${budget.phase === "ativo" ? "Use END para encerrar agora." : ""} Nada foi enviado.`);
          }
          proposal = { proposalType, accountBudget: budget.resource_name };
          plan = {
            tipo: proposalType, conta: cid, orcamento: `${budget.id} (${budget.name})`,
            efeito: proposalType === "END" ? "encerra agora — os anúncios da conta param" : "remove o orçamento futuro",
            limite: budget.unlimited ? "ILIMITADO" : `${budget.limit} ${currency}`, gasto: `${budget.served} ${currency}`,
          };
        } else {
          const changes: Row[] = [];
          const masks: string[] = [];
          proposal = { proposalType: "UPDATE", accountBudget: budget.resource_name };
          if (name !== undefined && name.trim() !== budget.name) {
            proposal.proposedName = name.trim();
            masks.push("proposed_name");
            changes.push({ campo: "nome", antes: budget.name, depois: name.trim() });
          }
          if (limitField) {
            const same = unlimitedSpending ? budget.unlimited
              : !budget.unlimited && str(budget.raw.approvedSpendingLimitMicros) === String(spendingLimitMicros);
            if (!same) {
              Object.assign(proposal, limitField);
              masks.push("proposed_spending_limit");
              changes.push({ campo: "limite", antes: budget.unlimited ? "ILIMITADO" : money(budget.raw.approvedSpendingLimitMicros), depois: unlimitedSpending ? "ILIMITADO" : money(spendingLimitMicros) });
              if (spendingLimitMicros !== undefined && units(spendingLimitMicros) < budget.served) {
                warnings.push(`O novo limite (${money(spendingLimitMicros)}) é menor que o já veiculado (${budget.served} ${currency}) — a API recusa ou fixa no valor gasto.`);
              }
            }
          }
          if (end && end.value !== (budget.end === "FOREVER" ? "FOREVER" : budget.end)) {
            proposal[end.field] = end.value;
            masks.push("proposed_end_time");
            changes.push({ campo: "fim", antes: budget.end, depois: end.value });
          }
          if (start) {
            if (budget.phase !== "futuro") return fail(`O orçamento ${budget.id} já começou: o início não pode mudar. Nada foi enviado.`);
            if (start.value !== budget.start) {
              proposal[start.field] = start.value;
              masks.push("proposed_start_time");
              changes.push({ campo: "inicio", antes: budget.start, depois: start.value });
            }
          }
          if (purchaseOrderNumber !== undefined && purchaseOrderNumber.trim() !== budget.purchase_order_number) {
            proposal.proposedPurchaseOrderNumber = purchaseOrderNumber.trim();
            masks.push("proposed_purchase_order_number");
            changes.push({ campo: "pedido_de_compra", antes: budget.purchase_order_number, depois: purchaseOrderNumber.trim() });
          }
          if (notes !== undefined && notes.trim() !== budget.notes) {
            proposal.proposedNotes = notes.trim();
            masks.push("proposed_notes");
            changes.push({ campo: "observacoes", antes: budget.notes, depois: notes.trim() });
          }
          if (masks.length === 0) {
            return { content: [text(`Nada a mudar no orçamento ${budget.id}: os valores pedidos já estão aplicados. Nada foi enviado.`)] };
          }
          updateMask = masks.join(",");
          plan = { tipo: "UPDATE", conta: cid, orcamento: `${budget.id} (${budget.name})`, mudancas: changes, update_mask: updateMask };
        }
      }
      if (warnings.length) plan.avisos = warnings;
      if (confirm !== true) return needConfirm(`Enviar a proposta ${proposalType} de orçamento de conta?`, plan);
      let response: Row;
      try {
        response = await validatedWrite(client, cid, "accountBudgetProposals:mutate", {
          operation: { create: proposal, ...(updateMask ? { updateMask } : {}) },
        });
      } catch (err) {
        return fail(`Falha ao enviar a proposta: ${explainError(err)}\n\n${formatJson(plan)}`);
      }
      if (client.isDryRun) return { content: [text(`DRY-RUN (validateOnly): proposta validada, nada foi enviado.\n\n${formatJson(plan)}`)] };
      const resourceName = str(obj(response.result).resourceName);
      if (!resourceName) return fail(`A API não confirmou a proposta — confira com get_billing_status.\n\n${formatJson(response)}`);
      return {
        content: [text(
          `Proposta ${proposalType} enviada (${resourceName}). O Google revisa antes de aplicar (em geral < 1 h); acompanhe com get_billing_status.\n\n` +
          formatJson(plan)
        )],
      };
    }
  );

  ctx.mcp.registerTool(
    "cancel_account_budget_proposal",
    {
      description: [
        "Cancela uma proposta de orçamento de conta ainda PENDING (remove a proposta). WRITE OPERATION.",
        "Exige confirm: true. Propostas já aprovadas não podem ser canceladas — use propose_account_budget.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        proposalId: z.string().describe("ID da proposta (get_billing_status mostra a pendente)."),
        confirm: z.boolean().optional().describe("Precisa ser true."),
      },
    },
    async ({ customerId, proposalId, confirm }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}". Nada foi enviado.`);
      const owner = /^customers\/(\d+)\//.exec(proposalId.trim());
      if (owner && owner[1] !== cid) return fail(`${proposalId} pertence à conta ${owner[1]}, não à ${cid}. Nada foi enviado.`);
      const id = lastSegment(proposalId.trim());
      if (!/^\d+$/.test(id)) return fail(`proposalId deve ser numérico, recebido "${proposalId}". Nada foi enviado.`);
      const client = ctx.getClient();
      const rows = await client.searchStream(cid,
        `SELECT account_budget_proposal.resource_name, account_budget_proposal.id, account_budget_proposal.status,
                account_budget_proposal.proposal_type, account_budget_proposal.account_budget,
                account_budget_proposal.proposed_name
         FROM account_budget_proposal
         WHERE account_budget_proposal.id = ${id}`);
      if (!rows.length) return fail(`Proposta ${id} não encontrada na conta ${cid}. Nada foi enviado.`);
      const proposal = obj(rows[0].accountBudgetProposal);
      if (proposal.status !== "PENDING") {
        return { content: [text(`A proposta ${id} não está pendente (status ${str(proposal.status)}) — não há o que cancelar. Nada foi enviado.`)] };
      }
      const plan = { conta: cid, proposta: str(proposal.resourceName), tipo: str(proposal.proposalType), nome: str(proposal.proposedName) };
      if (confirm !== true) return needConfirm(`Cancelar a proposta ${id} (${str(proposal.proposalType)})?`, plan);
      try {
        await validatedWrite(client, cid, "accountBudgetProposals:mutate", { operation: { remove: str(proposal.resourceName) } });
      } catch (err) {
        return fail(`Falha ao cancelar a proposta: ${explainError(err)}`);
      }
      return {
        content: [text(client.isDryRun
          ? `DRY-RUN (validateOnly): cancelamento validado, nada foi gravado.\n\n${formatJson(plan)}`
          : `Proposta ${id} cancelada.\n\n${formatJson(plan)}`)],
      };
    }
  );

  ctx.mcp.registerTool(
    "list_invoices",
    {
      description: [
        "Faturas de um mês (InvoiceService) — só contas em faturamento mensal. Valores, impostos,",
        "ajustes, vencimento, link do PDF e, com granular=true, o custo por campanha (útil para",
        "refaturar o cliente). Com faturamento consolidado a fatura cobre todas as contas do mesmo",
        "perfil. Se o gerente pagador não for o login deste servidor, informe payingManagerCustomerId.",
        "O PDF (pdf_url) exige o token OAuth para baixar; a tool não baixa.",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Conta de anúncio (não gerente)."),
        year: z.number().int().min(2019).describe("Ano de emissão (a partir de 2019)."),
        month: z.number().int().min(1).max(12).describe("Mês de emissão (1-12)."),
        billingSetupId: z.string().optional().describe("Billing setup; se omitido, usa os aprovados da conta."),
        granular: z.boolean().optional().describe("true = inclui o custo por campanha e itens detalhados."),
        payingManagerCustomerId: z.string().optional().describe("Gerente pagador (vira o login-customer-id da chamada)."),
      },
    },
    async ({ customerId, year, month, billingSetupId, granular, payingManagerCustomerId }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (payingManagerCustomerId !== undefined) {
        const blockedManager = checkCustomerAccess(payingManagerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blockedManager) return { content: [blockedManager], isError: true };
        if (!customerIdOf(payingManagerCustomerId)) return fail(`payingManagerCustomerId inválido: "${payingManagerCustomerId}".`);
      }
      if (year > new Date().getFullYear()) return fail(`Ano ${year} no futuro.`);
      if (billingSetupId !== undefined && !/^\d+$/.test(billingSetupId.trim())) return fail(`billingSetupId deve ser numérico, recebido "${billingSetupId}".`);
      const client = ctx.getClient();
      let setups: string[];
      if (billingSetupId) {
        setups = [`customers/${cid}/billingSetups/${billingSetupId.trim()}`];
      } else {
        setups = (await client.searchStream(cid,
          `SELECT billing_setup.resource_name, billing_setup.status FROM billing_setup WHERE billing_setup.status = 'APPROVED'`))
          .map((row) => str(obj(row.billingSetup).resourceName)).filter(Boolean);
        if (!setups.length) {
          return fail(`A conta ${cid} não tem billing setup aprovado visível pela API — faturas só existem no faturamento mensal (monthly invoicing).`);
        }
      }
      const scoped = payingManagerCustomerId ? client.withLoginCustomerId(customerIdOf(payingManagerCustomerId)!) : client;
      const invoices: Row[] = [];
      const errors: Row[] = [];
      for (const billingSetup of setups) {
        try {
          const response = await scoped.customerGet<Row>(cid, "invoices", {
            billingSetup,
            issueYear: String(year),
            issueMonth: MONTHS[month - 1],
            includeGranularLevelInvoiceDetails: granular ? true : undefined,
          });
          invoices.push(...((response.invoices as Row[] | undefined) ?? []));
        } catch (err) {
          errors.push({ billing_setup: billingSetup, error: explainError(err) });
        }
      }
      /* Fatura consolidada cobre todas as contas do perfil de pagamentos. No modo
         hospedado, as contas fora de ALLOWED_CUSTOMER_IDS não aparecem uma a uma (nem ID,
         nem nome, nem orçamento): viram um único total "outras contas", que fecha a conta
         com o total da fatura. O PDF traz o detalhe dessas contas, então o link sai. */
      const visibleCustomer = (summary: Row) =>
        !checkCustomerAccess(lastSegment(str(summary.customer)), ctx.allowedCustomerIds, ctx.hosted);
      let hiddenSummaries = 0;
      const views = invoices.map((invoice) => {
        const summaries = (invoice.accountBudgetSummaries as Row[] | undefined) ?? [];
        const shown = summaries.filter(visibleCustomer);
        const others = summaries.filter((summary) => !visibleCustomer(summary));
        hiddenSummaries += others.length;
        const sum = (key: string) => Math.round(others.reduce((acc, summary) => acc + units(summary[key]), 0) * 100) / 100;
        return {
          id: str(invoice.id),
          type: str(invoice.type),
          issue_date: str(invoice.issueDate),
          due_date: str(invoice.dueDate),
          service_period: `${str(obj(invoice.serviceDateRange).startDate)} → ${str(obj(invoice.serviceDateRange).endDate)}`,
          currency: str(invoice.currencyCode),
          subtotal: units(invoice.subtotalAmountMicros),
          tax: units(invoice.taxAmountMicros),
          total: units(invoice.totalAmountMicros),
          adjustments_total: units(invoice.adjustmentsTotalAmountMicros),
          regulatory_costs_total: units(invoice.regulatoryCostsTotalAmountMicros),
          payments_account_id: str(invoice.paymentsAccountId),
          billing_setup: str(invoice.billingSetup),
          pdf_url: others.length ? null : str(invoice.pdfUrl),
          corrected_invoice: str(invoice.correctedInvoice) || null,
          ...(others.length ? {
            outras_contas_fora_da_allowlist: {
              orcamentos: others.length,
              subtotal: sum("subtotalAmountMicros"),
              tax: sum("taxAmountMicros"),
              total: sum("totalAmountMicros"),
              served: sum("servedAmountMicros"),
            },
          } : {}),
          account_budgets: shown.map((summary) => ({
            customer_id: lastSegment(str(summary.customer)),
            account: str(summary.customerDescriptiveName),
            budget: str(summary.accountBudgetName),
            purchase_order: str(summary.purchaseOrderNumber),
            subtotal: units(summary.subtotalAmountMicros),
            tax: units(summary.taxAmountMicros),
            total: units(summary.totalAmountMicros),
            served: units(summary.servedAmountMicros),
            ...(granular ? {
              campaigns: ((summary.campaignSummaries as Row[] | undefined) ?? []).map((campaign) => ({
                campaign: str(campaign.campaignDescription),
                amount: units(campaign.amountMicros),
                quantity: Number(campaign.quantity ?? 0),
                unit: str(campaign.unitOfMeasure),
              })),
            } : {}),
          })),
        };
      });
      const header = `${views.length} fatura(s) de ${String(month).padStart(2, "0")}/${year} para a conta ${cid}.` +
        (errors.length ? ` ${errors.length} billing setup(s) com erro.` : "") +
        (views.length && !granular ? " Para o custo por campanha, repita com granular: true." : "") +
        (hiddenSummaries
          ? `\n${hiddenSummaries} orçamento(s) de contas fora de ALLOWED_CUSTOMER_IDS agrupado(s) em outras_contas_fora_da_allowlist (sem ID, nome ou campanhas); ` +
            "o pdf_url dessas faturas foi omitido porque o PDF detalha essas contas."
          : "");
      return {
        content: [text(`${header}\n\n${formatJson({ invoices: views, ...(errors.length ? { erros: errors } : {}) })}`)],
        isError: views.length === 0 && errors.length > 0,
      };
    }
  );

  ctx.mcp.registerTool(
    "list_payments_accounts",
    {
      description: [
        "Contas de pagamento (payments accounts) visíveis entre o login e a conta: ID, nome, moeda,",
        "perfil de pagamentos e gerente pagador. Usado para configurar faturamento consolidado.",
        "O resultado depende do login-customer-id (payingManagerCustomerId para trocar).",
      ].join("\n"),
      inputSchema: {
        customerId: z.string().describe("Customer ID."),
        payingManagerCustomerId: z.string().optional().describe("Gerente a usar como login-customer-id."),
      },
    },
    async ({ customerId, payingManagerCustomerId }) => {
      const blocked = checkCustomerAccess(customerId, ctx.allowedCustomerIds, ctx.hosted);
      if (blocked) return { content: [blocked], isError: true };
      const cid = customerIdOf(customerId);
      if (!cid) return fail(`customerId inválido: "${customerId}".`);
      if (payingManagerCustomerId !== undefined) {
        const blockedManager = checkCustomerAccess(payingManagerCustomerId, ctx.allowedCustomerIds, ctx.hosted);
        if (blockedManager) return { content: [blockedManager], isError: true };
        if (!customerIdOf(payingManagerCustomerId)) return fail(`payingManagerCustomerId inválido: "${payingManagerCustomerId}".`);
      }
      const client = ctx.getClient();
      const scoped = payingManagerCustomerId ? client.withLoginCustomerId(customerIdOf(payingManagerCustomerId)!) : client;
      let response: Row;
      try {
        response = await scoped.customerGet<Row>(cid, "paymentsAccounts");
      } catch (err) {
        return fail(`Falha ao listar as contas de pagamento: ${explainError(err)}`);
      }
      const accounts = ((response.paymentsAccounts as Row[] | undefined) ?? []).map((account) => ({
        payments_account_id: str(account.paymentsAccountId),
        name: str(account.name),
        currency: str(account.currencyCode),
        payments_profile_id: str(account.paymentsProfileId),
        secondary_payments_profile_id: str(account.secondaryPaymentsProfileId) || null,
        paying_manager_customer_id: lastSegment(str(account.payingManagerCustomer)) || null,
        resource_name: str(account.resourceName),
      }));
      return {
        content: [text(`${accounts.length} conta(s) de pagamento visível(is) para a conta ${cid}.` +
          `${accounts.length === 0 ? " Sem nenhuma: a conta não usa faturamento mensal ou o login não é o gerente pagador." : ""}\n\n${formatJson(accounts)}`)],
      };
    }
  );
}
