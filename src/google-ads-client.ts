/**
 * Cliente para Google Ads API (REST).
 * Versão da API configurável via GOOGLE_ADS_API_VERSION env var (default: v25).
 * Auth: OAuth 2.0 de usuário (refresh token) ou service account (JWT assinado
 * localmente), com auto-refresh e sem dependências Google.
 *
 * Developer token: desde 09/09/2026 o header `developer-token` é opcional e
 * ignorado pela API — o nível de acesso (Test, Explorer, Basic, Standard) é do
 * projeto Google Cloud dono do OAuth client. O header só vai quando o token foi
 * configurado; a Google anunciou que uma versão major futura vai recusá-lo.
 */

import { createHash, createSign } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v25";
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

export const GOOGLE_ADS_OAUTH_SCOPE = "https://www.googleapis.com/auth/adwords";
/** Escopo da Data Manager API (conversões offline e Customer Match pelo caminho novo). */
export const DATA_MANAGER_OAUTH_SCOPE = "https://www.googleapis.com/auth/datamanager";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Página do projeto Cloud onde se pede acesso Explorer/Basic/Standard. */
export const CLOUD_ADS_API_OVERVIEW_URL = "https://console.cloud.google.com/google/ads-apis/overview";

export interface GoogleAdsCredentials {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  expiry?: string;
}

/**
 * Chave JSON de service account (o arquivo baixado do Cloud Console). Acesso
 * direto: o e-mail da service account é adicionado como usuário da conta ou do
 * MCC no Google Ads (Admin > Acesso e segurança) — sem delegação de domínio.
 */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  private_key_id?: string;
}

export interface GoogleAdsClientConfig {
  credentialsPath?: string;
  credentials?: GoogleAdsCredentials;
  /** Alternativa ao OAuth de usuário: não depende da conta de um funcionário. */
  serviceAccount?: ServiceAccountKey;
  /** Opcional desde 09/09/2026 (header ignorado pela API). Só é enviado quando definido. */
  developerToken?: string;
  loginCustomerId: string;
  readOnly?: boolean;
  /* Dry-run: envia validateOnly=true nos endpoints :mutate, de modo que a API
     valide o payload inteiro (campos, enums, updateMask, dependências) e
     devolva os mesmos erros de uma gravação real, sem alterar a conta.
     Desligado por padrão — com dryRun=false o comportamento é o de antes. */
  dryRun?: boolean;
}

export interface MutateOperation {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  remove?: string;
  updateMask?: string;
}

/** Filtros de listChildAccounts. Sem opções, o comportamento é o de sempre: só contas ENABLED e não-gerente. */
export interface ListChildAccountsOptions {
  /** Traz todos os status (ENABLED, CANCELED, SUSPENDED, CLOSED) em vez de só ENABLED. */
  allStatuses?: boolean;
  /** Inclui contas gerente (MCC), inclusive a própria conta consultada (level 0). */
  includeManagers?: boolean;
  /** customer_client.level <= maxLevel (1 = a própria conta + filhos diretos). */
  maxLevel?: number;
}

/** Operação única de CustomerService.MutateCustomer (só update existe para customer). */
export interface CustomerOperation {
  update: Record<string, unknown>;
  updateMask: string;
}

/**
 * Erro da Google Ads API com os códigos estruturados (ex.:
 * "authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION"). A mensagem já
 * traz a explicação em PT-BR quando o código é conhecido; `codes` permite que
 * uma tool trate um caso específico sem depender do texto.
 */
export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly codes: string[],
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

/**
 * Explicação em PT-BR, com o que fazer, para os erros de acesso mais comuns.
 * Chave: "<categoria>.<VALOR>" como vem em errors[].errorCode.
 */
const API_ERROR_HINTS: Record<string, string> = {
  "authorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION":
    "O projeto do Google Cloud dono do OAuth client só tem acesso Test (contas de teste). Desde 09/09/2026 o nível de " +
    "acesso é do projeto Cloud, não do developer token: peça acesso Explorer, Basic ou Standard na página \"Google Ads API " +
    `Overview\" do projeto no Cloud Console (${CLOUD_ADS_API_OVERVIEW_URL}).`,
  "authorizationError.DEVELOPER_TOKEN_NOT_APPROVED":
    "Erro de nível de acesso. Desde 09/09/2026 o developer token é opcional e ignorado: o acesso vem do projeto Cloud do " +
    `OAuth client — confira/solicite o nível em ${CLOUD_ADS_API_OVERVIEW_URL} e remova GOOGLE_ADS_DEVELOPER_TOKEN.`,
  "authorizationError.DEVELOPER_TOKEN_PROHIBITED":
    "O developer token enviado não combina com o projeto Cloud. Desde 09/09/2026 o token é opcional: remova " +
    "GOOGLE_ADS_DEVELOPER_TOKEN e deixe o acesso vir do projeto Cloud do OAuth client.",
  "authorizationError.DEVELOPER_TOKEN_NOT_ON_ALLOWLIST":
    "O developer token não está na allowlist deste recurso. Desde 09/09/2026 o token é opcional: remova " +
    "GOOGLE_ADS_DEVELOPER_TOKEN; se o serviço for restrito a allowlist, só o representante Google libera.",
  "authenticationError.DEVELOPER_TOKEN_INVALID":
    "Developer token inválido. Ele é opcional desde 09/09/2026 — remova GOOGLE_ADS_DEVELOPER_TOKEN da configuração.",
  "authorizationError.USER_PERMISSION_DENIED":
    "O usuário do OAuth (ou a service account) não tem acesso a esta conta, ou GOOGLE_ADS_LOGIN_CUSTOMER_ID não é um MCC " +
    "que a gerencia (o header login-customer-id precisa ser o gerente da conta consultada).",
  "authorizationError.INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION":
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID não gerencia esta conta: use o MCC ao qual ela está vinculada.",
  "authorizationError.ACTION_NOT_PERMITTED":
    "O usuário/service account não tem permissão para esta ação na conta (ex.: acesso só de leitura ou faturamento). " +
    "Peça nível Padrão ou Administrador em Admin > Acesso e segurança da conta Google Ads.",
  "authorizationError.ACTION_NOT_PERMITTED_FOR_SUSPENDED_ACCOUNT":
    "A conta está SUSPENSA: a API não permite a ação. Resolva a suspensão (pagamento ou política) na interface do Google Ads.",
  "authorizationError.CUSTOMER_NOT_ENABLED":
    "A conta não está ativa (cancelada, suspensa, encerrada ou ainda não habilitada). Veja o status em list_accounts com " +
    "includeStatuses.",
  "authorizationError.PROJECT_DISABLED":
    "A Google Ads API não está habilitada no projeto Google Cloud do OAuth client. Ative-a em APIs e serviços do projeto.",
  "authorizationError.SERVICE_ACCESS_DENIED":
    "O projeto não tem acesso a este serviço. Alguns serviços são restritos a allowlist (ReachPlanService, " +
    "AudienceInsightsService, BenchmarksService, ContentCreatorInsightsService, IncentiveService) ou beta fechado " +
    "(AssetGenerationService) — só o representante Google libera.",
  "authorizationError.MISSING_TOS":
    "Os termos de serviço da Google Ads API não foram aceitos para esta credencial.",
  "authenticationError.TWO_STEP_VERIFICATION_NOT_ENROLLED":
    "A conta Google que autorizou o acesso não tem verificação em duas etapas (2SV). A Google Ads API exige 2SV dos " +
    "usuários desde 21/04/2026: ative em https://www.google.com/landing/2step e tente de novo — ou use uma service " +
    "account (GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH/JSON), que não depende da conta de uma pessoa.",
  "authenticationError.ADVANCED_PROTECTION_NOT_ENROLLED":
    "Um administrador da conta Google Ads passou a exigir Proteção Avançada: ative em " +
    "https://landing.google.com/advancedprotection na conta Google que autorizou o acesso.",
  "authenticationError.NOT_ADS_USER":
    "A conta Google do OAuth (ou a service account) não é usuária de nenhuma conta Google Ads. Para service account, " +
    "adicione o e-mail dela em Admin > Acesso e segurança da conta ou do MCC.",
  "authenticationError.OAUTH_TOKEN_REVOKED":
    "O acesso OAuth foi revogado: gere um novo refresh token (a conta precisa ter 2SV ativo).",
  "authenticationError.OAUTH_TOKEN_INVALID": "Token OAuth inválido: gere um novo refresh token.",
  "authenticationError.OAUTH_TOKEN_DISABLED": "Token OAuth desativado: gere um novo refresh token.",
  "authenticationError.GOOGLE_ACCOUNT_DELETED":
    "A conta Google que autorizou o acesso foi excluída. Use outra conta ou uma service account.",
  "authenticationError.CUSTOMER_NOT_FOUND": "Não existe conta Google Ads com esse ID — confira o customerId.",
  "quotaError.RESOURCE_EXHAUSTED":
    "Cota da API esgotada. O limite diário de operações é do projeto Google Cloud (Explorer: 2.880/dia em contas de " +
    "produção; Basic: 15.000/dia; Standard: sem limite diário) — espace as chamadas ou peça nível maior em " +
    `${CLOUD_ADS_API_OVERVIEW_URL}.`,
};

/** Explicações PT-BR para os códigos de erro conhecidos (sem repetição). */
export function explainApiErrorCodes(codes: string[]): string[] {
  return [...new Set(codes.map((code) => API_ERROR_HINTS[code]).filter((hint): hint is string => Boolean(hint)))];
}

/** Dica para falhas do endpoint de token (refresh token de usuário ou JWT de service account). */
function explainTokenFailure(body: string, serviceAccount: boolean): string {
  if (/invalid_grant/.test(body)) {
    return serviceAccount
      ? " — a service account foi recusada (chave revogada/excluída ou relógio do servidor fora de hora)."
      : " — o refresh token expirou ou foi revogado: gere um novo (desde 21/04/2026 a conta Google precisa ter " +
          "verificação em duas etapas).";
  }
  if (/invalid_client|unauthorized_client/.test(body)) {
    return " — client_id/client_secret (ou a chave da service account) não são aceitos pelo projeto Cloud.";
  }
  return "";
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * JWT de service account (RS256) para o fluxo server-to-server do OAuth:
 * iss = e-mail da service account, scope = adwords + datamanager, aud = endpoint
 * de token, exp no máximo 1 h depois de iat. Service account não passa por tela de
 * consentimento: pedir os dois escopos é o que deixa as tools da Data Manager API
 * funcionarem com o mesmo token (só adwords → 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT).
 */
export function buildServiceAccountAssertion(key: ServiceAccountKey, nowSeconds: number, tokenUri?: string): string {
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = {
    iss: key.client_email,
    scope: `${GOOGLE_ADS_OAUTH_SCOPE} ${DATA_MANAGER_OAUTH_SCOPE}`,
    aud: tokenUri ?? key.token_uri ?? DEFAULT_TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(input).sign(key.private_key);
  return `${input}.${base64url(signature)}`;
}

export type GoogleAdsAuthMode = "oauth_user" | "service_account";

type TokenState = { token?: string; expiresAt?: number; inflight?: Promise<void> };

/* getClient() cria um client por chamada de tool. Para service account o
   access token vive só em memória; sem este cache cada tool pediria um token
   novo ao endpoint OAuth. Chave: e-mail + hash da chave privada. */
const SERVICE_ACCOUNT_TOKEN_STATES = new Map<string, TokenState>();

export class GoogleAdsClient {
  private credentials?: GoogleAdsCredentials;
  private credentialsPath?: string;
  private serviceAccount?: ServiceAccountKey;
  /* Estado de token compartilhado com os clones de withDryRun (Object.create):
     muta-se o objeto, nunca se reatribui a propriedade. inflight evita que
     chamadas paralelas (varredura de várias contas) renovem o token juntas. */
  private tokenState: TokenState = {};
  private developerToken?: string;
  private loginCustomerId: string;
  private readOnly: boolean;
  private dryRun: boolean;

  constructor(config: GoogleAdsClientConfig) {
    this.credentialsPath = config.credentialsPath;
    this.developerToken = config.developerToken?.trim() ? config.developerToken.trim() : undefined;
    this.loginCustomerId = config.loginCustomerId.replace(/-/g, "");
    this.readOnly = config.readOnly ?? false;
    this.dryRun = config.dryRun ?? false;

    const sources = [config.credentials, config.credentialsPath, config.serviceAccount].filter(Boolean).length;
    if (config.serviceAccount && sources > 1) {
      throw new Error("Use OAuth de usuário OU service account, não os dois.");
    }
    if (config.serviceAccount) {
      if (!config.serviceAccount.client_email || !config.serviceAccount.private_key) {
        throw new Error("Service account sem client_email ou private_key.");
      }
      this.serviceAccount = { ...config.serviceAccount };
      const cacheKey = `${this.serviceAccount.client_email}|${createHash("sha256").update(this.serviceAccount.private_key).digest("hex")}`;
      const shared = SERVICE_ACCOUNT_TOKEN_STATES.get(cacheKey) ?? {};
      SERVICE_ACCOUNT_TOKEN_STATES.set(cacheKey, shared);
      this.tokenState = shared;
    } else if (config.credentials) {
      this.credentials = { ...config.credentials };
    } else if (config.credentialsPath) {
      const raw = readFileSync(config.credentialsPath, "utf8");
      this.credentials = JSON.parse(raw) as GoogleAdsCredentials;
    } else {
      throw new Error("Google Ads credentials are required");
    }
  }

  // ── Configuração (sem segredos) ──────────────────────────────────────

  /** Como a chamada se autentica: refresh token de usuário ou service account. */
  get authMode(): GoogleAdsAuthMode {
    return this.serviceAccount ? "service_account" : "oauth_user";
  }

  /** E-mail da service account (é o que se adiciona como usuário no Google Ads). */
  get serviceAccountEmail(): string | undefined {
    return this.serviceAccount?.client_email;
  }

  /** Há developer token configurado? (opcional e ignorado pela API desde 09/09/2026) */
  get hasDeveloperToken(): boolean {
    return Boolean(this.developerToken);
  }

  /** MCC enviado no header login-customer-id. */
  get loginCustomer(): string {
    return this.loginCustomerId;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  get apiVersion(): string {
    return API_VERSION;
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  private isTokenExpired(): boolean {
    if (!this.credentials?.expiry) return true;
    const expiry = new Date(this.credentials.expiry).getTime();
    // Refresh 5 minutes before expiry
    return Date.now() > expiry - 5 * 60 * 1000;
  }

  private async refreshServiceAccountToken(): Promise<void> {
    const key = this.serviceAccount as ServiceAccountKey;
    const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
    const assertion = buildServiceAccountAssertion(key, Math.floor(Date.now() / 1000), tokenUri);
    const res = await fetch(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth da service account falhou (HTTP ${res.status}): ${text}${explainTokenFailure(text, true)}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    // Só em memória: o token de service account é barato de gerar e não vai para disco.
    this.tokenState.token = data.access_token;
    this.tokenState.expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
  }

  private async refreshToken(): Promise<void> {
    if (this.serviceAccount) return this.refreshServiceAccountToken();
    const credentials = this.credentials as GoogleAdsCredentials;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    });

    const res = await fetch(credentials.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth refresh failed (HTTP ${res.status}): ${text}${explainTokenFailure(text, false)}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    credentials.token = data.access_token;
    credentials.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

    // Persist refreshed token.
    //
    // Escrita ATOMICA: grava num temporario no MESMO diretorio e renomeia.
    // writeFileSync direto trunca o arquivo antes de gravar, e esse arquivo e
    // compartilhado por varios processos — dois MCCs, e Claude Code e Codex ao
    // mesmo tempo — que expiram juntos e portanto renovam juntos. Um leitor que
    // caisse na janela do truncamento leria JSON vazio; pior, uma gravacao
    // interrompida ali levaria o refresh_token junto, exigindo reautenticar na
    // mao. rename(2) e atomico no POSIX: quem le ve o arquivo antigo inteiro ou
    // o novo inteiro, nunca um pedaco.
    if (this.credentialsPath) {
      const tmp = `${this.credentialsPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(tmp, JSON.stringify(credentials, null, 2), { mode: 0o600 });
        renameSync(tmp, this.credentialsPath);
      } catch {
        // Non-fatal: token will be refreshed again next time
        try {
          unlinkSync(tmp);
        } catch {
          // temporario ja saiu (ou nunca chegou a existir)
        }
      }
    }
  }

  private needsRefresh(): boolean {
    if (!this.serviceAccount) return this.isTokenExpired();
    const { token, expiresAt } = this.tokenState;
    return !token || !expiresAt || Date.now() > expiresAt - 5 * 60 * 1000;
  }

  private async getAccessToken(): Promise<string> {
    if (this.needsRefresh()) {
      // Uma renovação por vez: chamadas paralelas esperam a mesma promessa.
      if (!this.tokenState.inflight) {
        this.tokenState.inflight = this.refreshToken().finally(() => {
          this.tokenState.inflight = undefined;
        });
      }
      await this.tokenState.inflight;
    }
    return this.serviceAccount ? (this.tokenState.token as string) : (this.credentials as GoogleAdsCredentials).token;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      // Opcional e ignorado pela API desde 09/09/2026: só vai quando foi configurado.
      ...(this.developerToken ? { "developer-token": this.developerToken } : {}),
      "login-customer-id": this.loginCustomerId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  // ── Core Request ─────────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    attempt: number = 0
  ): Promise<T> {
    const headers = await this.getHeaders();

    const fetchOpts: RequestInit = {
      method,
      headers,
    };
    if (body) {
      fetchOpts.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);

    // Rate limit / quota handling
    if (res.status === 429 || res.status === 503) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(method, url, body, attempt + 1);
      }
    }

    // Safe JSON parse
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(
        `Google Ads API: unexpected response (HTTP ${res.status}, not JSON). This usually means a temporary outage — try again.`
      );
    }

    /* googleAds:searchStream devolve o corpo como ARRAY de lotes, e um erro vem
       como [{ error: {...} }]. Um array não tem .error, então a checagem abaixo
       passava batido: searchStream não achava .results em lote nenhum e a tool
       reportava "0 resultados". Query inválida virava dado vazio silencioso —
       num relatório isso lê como "0 conversões", não como falha. Normalizar
       aqui trata as duas formas com o mesmo caminho de erro. */
    const errorFromBatch = Array.isArray(data)
      ? (data as Array<Record<string, unknown>>).find((batch) => batch && batch.error)?.error
      : undefined;

    // Google-specific error handling
    const dataObj = (errorFromBatch ? { error: errorFromBatch } : (data ?? {})) as Record<string, unknown>;
    if (dataObj.error) {
      const err = dataObj.error as Record<string, unknown>;
      const status = (err.status as string) ?? "";
      const code = err.code as number | undefined;
      const message = (err.message as string) ?? `HTTP ${res.status}`;

      // RESOURCE_EXHAUSTED = rate limit
      if ((status === "RESOURCE_EXHAUSTED" || code === 429) && attempt < MAX_RETRIES) {
        const waitMs = RETRY_BASE_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.request<T>(method, url, body, attempt + 1);
      }

      // Extract detailed errors if available
      const details = (err.details as Array<Record<string, unknown>>) ?? [];
      const detailErrors = details
        .filter((d) => d.errors)
        .flatMap((d) => (d.errors as Array<Record<string, unknown>>) ?? []);
      const errorDetails = detailErrors.map((e) => (e.message as string) ?? "").filter(Boolean);
      /* errorCode vem como { authorizationError: "USER_PERMISSION_DENIED" }: vira
         "authorizationError.USER_PERMISSION_DENIED" para a tool tratar o caso
         sem depender do texto, e para a dica em PT-BR abaixo. */
      const codes = detailErrors.flatMap((e) =>
        Object.entries((e.errorCode as Record<string, unknown>) ?? {}).map(([kind, value]) => `${kind}.${String(value)}`)
      );
      const hints = explainApiErrorCodes(codes);

      const detailStr = errorDetails.length > 0 ? ` — ${errorDetails.join("; ")}` : "";
      const hintStr = hints.length > 0 ? `\nComo resolver: ${hints.join(" ")}` : "";
      throw new GoogleAdsApiError(`Google Ads API: ${message}${detailStr}${hintStr}`, codes, res.status);
    }

    /* Não-2xx sem `error` no corpo (página JSON de proxy/LB, `[]` ou `{}` de um
       5xx após as tentativas) voltaria como dado e viraria "0 resultados". */
    if (!res.ok) {
      throw new Error(`Google Ads API: HTTP ${res.status} sem detalhe de erro — ${JSON.stringify(data).slice(0, 200)}`);
    }

    return data as T;
  }

  // ── GAQL Queries (READ) ──────────────────────────────────────────────

  /**
   * Execute a GAQL query via searchStream (single response, no pagination needed).
   * Returns flattened array of result objects.
   */
  async searchStream(
    customerId: string,
    query: string
  ): Promise<Array<Record<string, unknown>>> {
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}/googleAds:searchStream`;
    const response = await this.request<Array<{ results?: Array<Record<string, unknown>> }>>(
      "POST",
      url,
      { query }
    );

    // searchStream returns array of batches, each with results[]
    const allResults: Array<Record<string, unknown>> = [];
    if (Array.isArray(response)) {
      for (const batch of response) {
        if (batch.results) {
          allResults.push(...batch.results);
        }
      }
    }
    return allResults;
  }

  /**
   * Execute a GAQL query via search (paginated).
   * Auto-paginates and returns all results.
   */
  async search(
    customerId: string,
    query: string,
    pageSize: number = 10000
  ): Promise<Array<Record<string, unknown>>> {
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}/googleAds:search`;
    const allResults: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;

    do {
      const body: Record<string, unknown> = { query, pageSize };
      if (pageToken) body.pageToken = pageToken;

      const response = await this.request<{
        results?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      }>("POST", url, body);

      if (response.results) {
        allResults.push(...response.results);
      }
      pageToken = response.nextPageToken;
    } while (pageToken);

    return allResults;
  }

  // ── Account Discovery ────────────────────────────────────────────────

  /** List all customer IDs accessible by the token. */
  async listAccessibleCustomers(): Promise<string[]> {
    const url = `${API_BASE}/customers:listAccessibleCustomers`;
    const response = await this.request<{ resourceNames?: string[] }>("GET", url);
    return (response.resourceNames ?? []).map((rn) => rn.replace("customers/", ""));
  }

  /** Get customer details (name, currency, timezone, status, test account). */
  async getCustomer(customerId: string): Promise<Record<string, unknown>> {
    const results = await this.searchStream(customerId, `
      SELECT customer.id, customer.descriptive_name, customer.currency_code,
             customer.time_zone, customer.manager, customer.status,
             customer.test_account
      FROM customer
      LIMIT 1
    `);
    return results[0] ?? {};
  }

  /**
   * List client accounts of an MCC (customer_client: todos os níveis abaixo dele).
   * Sem opções: só contas ENABLED e não-gerente, como sempre foi. Com
   * allStatuses/includeManagers aparecem as suspensas, canceladas, encerradas e
   * os sub-MCCs — sem isso um cliente SUSPENSO simplesmente some da lista.
   */
  async listChildAccounts(
    mccId?: string,
    options: ListChildAccountsOptions = {}
  ): Promise<Array<Record<string, unknown>>> {
    const cid = mccId ?? this.loginCustomerId;
    const conditions: string[] = [];
    if (!options.includeManagers) conditions.push("customer_client.manager = false");
    if (!options.allStatuses) conditions.push("customer_client.status = 'ENABLED'");
    if (options.maxLevel !== undefined) {
      if (!Number.isInteger(options.maxLevel) || options.maxLevel < 0) {
        throw new Error(`maxLevel inválido: ${options.maxLevel}`);
      }
      conditions.push(`customer_client.level <= ${options.maxLevel}`);
    }
    return this.searchStream(cid, `
      SELECT customer_client.id, customer_client.descriptive_name,
             customer_client.currency_code, customer_client.time_zone,
             customer_client.manager, customer_client.status,
             customer_client.level, customer_client.hidden,
             customer_client.test_account, customer_client.applied_labels,
             customer_client.client_customer
      FROM customer_client
      ${conditions.length ? `WHERE ${conditions.join("\n        AND ")}` : ""}
      ORDER BY customer_client.descriptive_name
    `);
  }

  // ── Mutations (WRITE) ────────────────────────────────────────────────

  /** Dry-run ligado? As tools usam isso para relatar "validado, nada gravado"
      em vez de ler um parâmetro próprio que pode divergir da env. */
  get isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * Cópia deste client com dry-run ligado (validateOnly), para uma chamada só.
   * Compartilha credenciais e o estado do token com o original; read-only continua
   * valendo, porque só o dry-run é sobrescrito.
   */
  withDryRun(): GoogleAdsClient {
    const clone = Object.create(this) as GoogleAdsClient;
    clone.dryRun = true;
    return clone;
  }

  private assertWriteAllowed(): void {
    if (this.readOnly) {
      throw new Error("Google Ads MCP is running in read-only mode; mutation blocked.");
    }
  }

  /** Generic mutate for any resource type. */
  async mutate(
    customerId: string,
    resource: string,
    operations: MutateOperation[],
    options: { partialFailure?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    this.assertWriteAllowed();
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}/${resource}:mutate`;
    return this.request<Record<string, unknown>>("POST", url, {
      operations,
      // partialFailure: as operações válidas são aplicadas e as recusadas voltam
      // em partialFailureError, com o índice de cada uma
      ...(options.partialFailure ? { partialFailure: true } : {}),
      ...(this.dryRun ? { validateOnly: true } : {}),
    });
  }

  async mutateCampaignBudgets(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaignBudgets", operations);
  }

  async mutateCampaigns(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaigns", operations);
  }

  async mutateAdGroups(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "adGroups", operations);
  }

  async mutateAdGroupAds(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "adGroupAds", operations);
  }

  async mutateAdGroupCriteria(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "adGroupCriteria", operations);
  }

  async mutateCampaignCriteria(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaignCriteria", operations);
  }

  async mutateAssets(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "assets", operations);
  }

  async mutateCampaignAssetSets(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaignAssetSets", operations);
  }

  async mutateCampaignAssets(
    customerId: string,
    operations: MutateOperation[],
    options?: { partialFailure?: boolean }
  ) {
    return this.mutate(customerId, "campaignAssets", operations, options);
  }

  async mutateAssetGroups(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "assetGroups", operations);
  }

  async mutateAssetGroupAssets(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "assetGroupAssets", operations);
  }

  async mutateAssetGroupListingGroupFilters(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "assetGroupListingGroupFilters", operations);
  }

  async mutateAssetGroupSignals(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "assetGroupSignals", operations);
  }

  async mutateAudiences(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "audiences", operations);
  }

  async mutateUserLists(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "userLists", operations);
  }

  async mutateConversionActions(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "conversionActions", operations);
  }

  async mutateCampaignConversionGoals(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaignConversionGoals", operations);
  }

  /**
   * Call a read-style custom endpoint that is not a `:mutate`.
   * Ex: `:generateKeywordIdeas` (POST, mas não altera a conta).
   */
  async customerAction<T = Record<string, unknown>>(
    customerId: string,
    action: string,
    body: unknown
  ): Promise<T> {
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}${action.startsWith(":") ? "" : "/"}${action}`;
    return this.request<T>("POST", url, body);
  }

  /**
   * Call a custom endpoint that MUTATES the account.
   * Ex: `recommendations:apply`, `:uploadClickConversions`.
   * Passa pelo mesmo guard de read-only que `mutate`.
   */
  async customerWriteAction<T = Record<string, unknown>>(
    customerId: string,
    action: string,
    body: unknown
  ): Promise<T> {
    this.assertWriteAllowed();
    /* Dry-run tem que ser fail-closed. Só os endpoints de upload de conversão
       aceitam validateOnly; recommendations:apply/dismiss não têm o campo e
       gravariam de verdade — para esses a chamada é recusada em dry-run. */
    if (this.dryRun) {
      const supportsValidateOnly = [":uploadClickConversions", ":uploadCallConversions", ":uploadConversionAdjustments"]
        .some((suffix) => action.endsWith(suffix));
      if (!supportsValidateOnly) {
        throw new Error(`GOOGLE_ADS_DRY_RUN: ${action} não aceita validateOnly — mutação bloqueada em dry-run.`);
      }
      if (body && typeof body === "object" && !Array.isArray(body)) {
        body = { ...(body as Record<string, unknown>), validateOnly: true };
      }
    }
    return this.customerAction<T>(customerId, action, body);
  }

  /**
   * Atomic batch mutate across multiple resource types.
   * Uses googleAds:mutate endpoint — essential for PMax creation
   * where campaign assets must exist before asset group validation.
   */
  async batchMutate(
    customerId: string,
    mutateOperations: Array<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    this.assertWriteAllowed();
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}/googleAds:mutate`;
    return this.request<Record<string, unknown>>("POST", url, {
      mutateOperations,
      ...(this.dryRun ? { validateOnly: true } : {}),
    });
  }

  // ── Convenience Methods ──────────────────────────────────────────────

  /** Get account currency code. */
  async getAccountCurrency(customerId: string): Promise<string> {
    const customer = await this.getCustomer(customerId);
    const c = customer.customer as Record<string, unknown> | undefined;
    return (c?.currencyCode as string) ?? "BRL";
  }

  /** Update status of a single resource. */
  async updateStatus(
    customerId: string,
    resource: string,
    resourceName: string,
    status: "ENABLED" | "PAUSED" | "REMOVED"
  ): Promise<Record<string, unknown>> {
    return this.mutate(customerId, resource, [
      {
        update: { resourceName, status },
        updateMask: "status",
      },
    ]);
  }

  // ── lote experiments-tracking ──
  /* customerGet (GET de leitura sob customers/{cid}, ex.: experiments/{id}:listExperimentAsyncErrors)
     é o único definido no fim da classe (seção account-admin) — três lotes precisaram do mesmo método. */

  // ── lote conversions-offline ──

  /* Data Manager API (datamanager.googleapis.com/v1): o caminho que o Google indica
     para importação offline depois da restrição de 15/06/2026 no UploadClickConversions.
     Usa o MESMO token: OAuth de usuário precisa ter sido consentido também com o escopo
     https://www.googleapis.com/auth/datamanager (só adwords recebe 403, escopo
     insuficiente); service account já pede os dois escopos no JWT. Não usa developer token nem login-customer-id: a conta de
     login vai em destinations[].loginAccount, preenchida aqui com a do login quando
     ausente (o equivalente do header login-customer-id). */
  private static readonly DATA_MANAGER_BASE = "https://datamanager.googleapis.com/v1";

  /** POST events:ingest. Grava (bloqueado em read-only); em dry-run vai com validateOnly. */
  async dataManagerIngestEvents(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertWriteAllowed();
    const destinations = ((body.destinations as Array<Record<string, unknown>>) ?? []).map((destination) =>
      destination.loginAccount
        ? destination
        : { ...destination, loginAccount: { accountType: "GOOGLE_ADS", accountId: this.loginCustomerId } }
    );
    return this.dataManagerRequest<Record<string, unknown>>("POST", "events:ingest", {
      ...body,
      destinations,
      ...(this.dryRun ? { validateOnly: true } : {}),
    });
  }

  /** GET requestStatus:retrieve — status de um events:ingest (leitura). */
  async dataManagerRequestStatus(requestId: string): Promise<Record<string, unknown>> {
    return this.dataManagerRequest<Record<string, unknown>>(
      "GET",
      `requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`
    );
  }

  private async dataManagerRequest<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    attempt: number = 0
  ): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${GoogleAdsClient.DATA_MANAGER_BASE}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
      return this.dataManagerRequest<T>(method, path, body, attempt + 1);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Data Manager API: resposta inesperada (HTTP ${res.status}, não é JSON).`);
    }
    const err = (data as Record<string, unknown> | null)?.error as Record<string, unknown> | undefined;
    if (err) {
      const details = (err.details as Array<Record<string, unknown>>) ?? [];
      const reasons = details.map((d) => d.reason).filter(Boolean) as string[];
      const violations = details
        .flatMap((d) => (d.fieldViolations as Array<Record<string, unknown>>) ?? [])
        .map((v) => `${String(v.field ?? "")}: ${String(v.description ?? "")}`);
      const extra = [...reasons, ...violations];
      throw new Error(
        `Data Manager API: ${String(err.status ?? "")} (HTTP ${String(err.code ?? res.status)}): ` +
          `${String(err.message ?? "sem mensagem")}${extra.length ? ` — ${extra.join("; ")}` : ""}`
      );
    }
    if (!res.ok) {
      throw new Error(`Data Manager API: HTTP ${res.status} sem detalhe de erro — ${JSON.stringify(data).slice(0, 200)}`);
    }
    return data as T;
  }

  // ── lote video-display ──
  //
  // Upload resumável (protocolo X-Goog-Upload), usado pelo YouTubeVideoUploadService:
  // POST https://googleads.googleapis.com/resumable/upload/<versão>/customers/{cid}/youTubeVideoUploads:create.
  // A base de URL (/resumable/upload/) e os cabeçalhos X-Goog-Upload-* não passam pelo
  // request() genérico, que só fala JSON e não lê cabeçalhos de resposta. O endpoint não
  // tem validate_only: em dry-run as três chamadas são recusadas (fail-closed).

  private assertResumableAllowed(what: string): void {
    this.assertWriteAllowed();
    if (this.dryRun) {
      throw new Error(`GOOGLE_ADS_DRY_RUN: ${what} (upload resumável) não aceita validateOnly — upload bloqueado em dry-run.`);
    }
  }

  /** A URL de upload vem num cabeçalho da API; o token só segue para o host do Google Ads. */
  private assertUploadUrl(uploadUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(uploadUrl);
    } catch {
      throw new Error(`URL de upload inválida: ${uploadUrl.slice(0, 120)}`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "googleads.googleapis.com") {
      throw new Error(`URL de upload fora de googleads.googleapis.com recusada: ${parsed.origin}`);
    }
  }

  private static async resumableError(res: Response, step: string): Promise<Error> {
    const raw = await res.text().catch(() => "");
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const err = (Array.isArray(parsed) ? (parsed[0] as Record<string, unknown>)?.error : parsed.error) as
        | Record<string, unknown>
        | undefined;
      if (err) {
        const details = ((err.details as Array<Record<string, unknown>>) ?? [])
          .flatMap((d) => (d.errors as Array<Record<string, unknown>>) ?? [])
          .map((e) => {
            const codes = Object.entries((e.errorCode as Record<string, unknown>) ?? {}).map(([k, v]) => `${k}.${v}`);
            return `${String(e.message ?? "")}${codes.length ? ` [${codes.join(", ")}]` : ""}`;
          })
          .filter(Boolean);
        detail = `${String(err.message ?? "")}${details.length ? ` — ${details.join("; ")}` : ""}`;
      }
    } catch {
      // corpo não-JSON: fica o texto cru
    }
    return new Error(`Google Ads API (${step}, HTTP ${res.status}): ${detail || "sem detalhe"}`);
  }

  /**
   * Abre a sessão de upload resumável. `action` é o caminho depois de customers/{cid}/
   * (ex.: "youTubeVideoUploads:create"). Devolve a URL de upload e a granularidade dos
   * pedaços (todo pedaço, menos o último, precisa ser múltiplo dela).
   */
  async startResumableUpload(
    customerId: string,
    action: string,
    body: unknown,
    totalBytes?: number
  ): Promise<{ uploadUrl: string; chunkGranularity: number }> {
    this.assertResumableAllowed(action);
    const cid = customerId.replace(/-/g, "");
    const url = `https://googleads.googleapis.com/resumable/upload/${API_VERSION}/customers/${cid}/${action}`;
    const headers: Record<string, string> = {
      ...(await this.getHeaders()),
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
    };
    if (totalBytes !== undefined) headers["X-Goog-Upload-Header-Content-Length"] = String(totalBytes);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw await GoogleAdsClient.resumableError(res, "início do upload");
    const uploadUrl = res.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Google Ads API: a resposta do início do upload não trouxe x-goog-upload-url.");
    this.assertUploadUrl(uploadUrl);
    const granularity = parseInt(res.headers.get("x-goog-upload-chunk-granularity") ?? "", 10);
    return { uploadUrl, chunkGranularity: granularity > 0 ? granularity : 262_144 };
  }

  /**
   * Envia um pedaço na posição `offset`. Com finalize=true é o último e a resposta traz o
   * corpo JSON da operação (ex.: { resourceName }). `status` é o X-Goog-Upload-Status
   * ("active" enquanto a sessão aceita mais bytes, "final" ao terminar).
   */
  async sendResumableChunk(
    uploadUrl: string,
    offset: number,
    chunk: Uint8Array,
    finalize: boolean
  ): Promise<{ status: string; body: Record<string, unknown> | null }> {
    this.assertResumableAllowed("envio de bytes");
    this.assertUploadUrl(uploadUrl);
    const token = await this.getAccessToken();
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Goog-Upload-Offset": String(offset),
        "X-Goog-Upload-Command": finalize ? "upload, finalize" : "upload",
      },
      body: chunk as unknown as RequestInit["body"],
    });
    if (!res.ok) throw await GoogleAdsClient.resumableError(res, `envio do pedaço em ${offset}`);
    const status = (res.headers.get("x-goog-upload-status") ?? "").toLowerCase();
    if (!finalize) {
      await res.arrayBuffer().catch(() => undefined);
      return { status: status || "active", body: null };
    }
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      throw new Error(`Google Ads API: o upload terminou com resposta não-JSON (HTTP ${res.status}).`);
    }
    return { status: status || "final", body };
  }

  /** Quantos bytes o servidor já recebeu (X-Goog-Upload-Size-Received), para retomar. */
  async queryResumableUpload(uploadUrl: string): Promise<{ status: string; sizeReceived: number }> {
    this.assertResumableAllowed("consulta do upload");
    this.assertUploadUrl(uploadUrl);
    const token = await this.getAccessToken();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Goog-Upload-Command": "query" },
    });
    if (!res.ok) throw await GoogleAdsClient.resumableError(res, "consulta do upload");
    await res.arrayBuffer().catch(() => undefined);
    return {
      status: (res.headers.get("x-goog-upload-status") ?? "").toLowerCase(),
      sizeReceived: Number(res.headers.get("x-goog-upload-size-received") ?? NaN),
    };
  }

  /** Cancela a sessão (melhor esforço) quando o upload não pode terminar. */
  async cancelResumableUpload(uploadUrl: string): Promise<void> {
    this.assertResumableAllowed("cancelamento do upload");
    this.assertUploadUrl(uploadUrl);
    const token = await this.getAccessToken();
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Goog-Upload-Command": "cancel" },
    });
    await res.arrayBuffer().catch(() => undefined);
  }

  // ── Conta, verificação de identidade e metadados (lote account-auth) ──

  /**
   * CustomerService.MutateCustomer: POST /customers/{cid}:mutate com UMA
   * operação (`operation`, no singular — o :mutate genérico manda `operations`)
   * e validateOnly em dry-run.
   */
  async mutateCustomer(customerId: string, operation: CustomerOperation): Promise<Record<string, unknown>> {
    this.assertWriteAllowed();
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}:mutate`;
    return this.request<Record<string, unknown>>("POST", url, {
      operation: { update: operation.update, updateMask: operation.updateMask },
      ...(this.dryRun ? { validateOnly: true } : {}),
    });
  }

  /* customerGet (GET genérico sob customers/{cid}, ex.: getIdentityVerification) é o
     mesmo do lote experiments-tracking, definido acima — com params opcionais. */

  /** IdentityVerificationService.GetIdentityVerification (rate-limited: faça cache). */
  async getIdentityVerification(customerId: string): Promise<Record<string, unknown>> {
    return this.customerGet(customerId, "getIdentityVerification");
  }

  /**
   * IdentityVerificationService.StartIdentityVerification. O método não tem
   * validate_only: em dry-run customerWriteAction recusa a chamada (fail-closed).
   */
  async startIdentityVerification(customerId: string): Promise<Record<string, unknown>> {
    return this.customerWriteAction(customerId, ":startIdentityVerification", {
      verificationProgram: "ADVERTISER_IDENTITY_VERIFICATION",
    });
  }

  /**
   * GoogleAdsFieldService.SearchGoogleAdsFields (POST /googleAdsFields:search):
   * metadados globais dos campos GAQL — não lê dados de conta. Consulta sem FROM,
   * ex.: SELECT name, selectable WHERE name LIKE 'campaign.%'. Pagina sozinho.
   */
  async searchGoogleAdsFields(query: string, pageSize = 10000): Promise<Array<Record<string, unknown>>> {
    const url = `${API_BASE}/googleAdsFields:search`;
    const results: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const response = await this.request<{ results?: Array<Record<string, unknown>>; nextPageToken?: string }>(
        "POST",
        url,
        { query, pageSize, ...(pageToken ? { pageToken } : {}) }
      );
      results.push(...(response.results ?? []));
      pageToken = response.nextPageToken;
      pages++;
    } while (pageToken && pages < 50);
    return results;
  }

  /** GoogleAdsFieldService.GetGoogleAdsField (GET /googleAdsFields/{nome}): recurso, atributo, segmento ou métrica. */
  async getGoogleAdsField(name: string): Promise<Record<string, unknown>> {
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(name)) {
      throw new Error(`Nome de campo GAQL inválido: "${name}"`);
    }
    return this.request<Record<string, unknown>>("GET", `${API_BASE}/googleAdsFields/${name}`);
  }

  // ── lote account-admin ──

  /**
   * Cópia deste client com outro login-customer-id, para uma chamada só. Aceitar o
   * convite de um gerente exige autenticar como a conta cliente, e as faturas exigem o
   * gerente pagador (paying manager). Compartilha credenciais, dry-run e read-only com
   * o original, como withDryRun.
   */
  withLoginCustomerId(loginCustomerId: string): GoogleAdsClient {
    const id = loginCustomerId.replace(/-/g, "");
    if (!/^\d+$/.test(id)) {
      throw new Error(`login-customer-id inválido: "${loginCustomerId}" (esperado o ID numérico da conta).`);
    }
    const clone = Object.create(this) as GoogleAdsClient;
    clone.loginCustomerId = id;
    return clone;
  }

  /**
   * GET de leitura num endpoint da conta que não é GAQL. Ex.: `invoices`,
   * `paymentsAccounts`, `batchJobs/{id}:listResults`. Os parâmetros vão na query string
   * com os nomes JSON (lowerCamelCase) do request.
   */
  async customerGet<T = Record<string, unknown>>(
    customerId: string,
    path: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const cid = customerId.replace(/-/g, "");
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const qs = query.toString();
    const url = `${API_BASE}/customers/${cid}${path.startsWith(":") ? "" : "/"}${path}${qs ? `?${qs}` : ""}`;
    return this.request<T>("GET", url);
  }
}
