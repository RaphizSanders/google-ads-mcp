/**
 * Cliente para Google Ads API (REST).
 * Versão da API configurável via GOOGLE_ADS_API_VERSION env var (default: v25).
 * Auth: OAuth 2.0 com auto-refresh, sem dependências Google.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v25";
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

export interface GoogleAdsCredentials {
  token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  expiry?: string;
}

export interface GoogleAdsClientConfig {
  credentialsPath?: string;
  credentials?: GoogleAdsCredentials;
  developerToken: string;
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

export class GoogleAdsClient {
  private credentials: GoogleAdsCredentials;
  private credentialsPath?: string;
  private developerToken: string;
  private loginCustomerId: string;
  private readOnly: boolean;
  private dryRun: boolean;

  constructor(config: GoogleAdsClientConfig) {
    this.credentialsPath = config.credentialsPath;
    this.developerToken = config.developerToken;
    this.loginCustomerId = config.loginCustomerId.replace(/-/g, "");
    this.readOnly = config.readOnly ?? false;
    this.dryRun = config.dryRun ?? false;

    if (config.credentials) {
      this.credentials = { ...config.credentials };
    } else if (config.credentialsPath) {
      const raw = readFileSync(config.credentialsPath, "utf8");
      this.credentials = JSON.parse(raw) as GoogleAdsCredentials;
    } else {
      throw new Error("Google Ads credentials are required");
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────

  private isTokenExpired(): boolean {
    if (!this.credentials.expiry) return true;
    const expiry = new Date(this.credentials.expiry).getTime();
    // Refresh 5 minutes before expiry
    return Date.now() > expiry - 5 * 60 * 1000;
  }

  private async refreshToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.credentials.refresh_token,
      client_id: this.credentials.client_id,
      client_secret: this.credentials.client_secret,
    });

    const res = await fetch(this.credentials.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth refresh failed (HTTP ${res.status}): ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.credentials.token = data.access_token;
    this.credentials.expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

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
        writeFileSync(tmp, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
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

  private async getAccessToken(): Promise<string> {
    if (this.isTokenExpired()) {
      await this.refreshToken();
    }
    return this.credentials.token;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      "developer-token": this.developerToken,
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
      const errorDetails = details
        .filter((d) => d.errors)
        .flatMap((d) => (d.errors as Array<Record<string, unknown>>) ?? [])
        .map((e) => (e.message as string) ?? "")
        .filter(Boolean);

      const detailStr = errorDetails.length > 0 ? ` — ${errorDetails.join("; ")}` : "";
      throw new Error(`Google Ads API: ${message}${detailStr}`);
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

  /** Get customer details (name, currency, timezone). */
  async getCustomer(customerId: string): Promise<Record<string, unknown>> {
    const results = await this.searchStream(customerId, `
      SELECT customer.id, customer.descriptive_name, customer.currency_code,
             customer.time_zone, customer.manager, customer.status
      FROM customer
      LIMIT 1
    `);
    return results[0] ?? {};
  }

  /** List child accounts of an MCC. */
  async listChildAccounts(mccId?: string): Promise<Array<Record<string, unknown>>> {
    const cid = mccId ?? this.loginCustomerId;
    return this.searchStream(cid, `
      SELECT customer_client.id, customer_client.descriptive_name,
             customer_client.currency_code, customer_client.time_zone,
             customer_client.manager, customer_client.status,
             customer_client.level
      FROM customer_client
      WHERE customer_client.manager = false
        AND customer_client.status = 'ENABLED'
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

  /**
   * GET de leitura sob customers/{cid} — os endpoints de lista que não são GAQL, como
   * experiments/{id}:listExperimentAsyncErrors e campaignDrafts/{base~draft}:listAsyncErrors.
   * Não altera a conta (por isso vale também em read-only e dry-run).
   */
  async customerGet<T = Record<string, unknown>>(
    customerId: string,
    path: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    const cid = customerId.replace(/-/g, "");
    const query = new URLSearchParams(params).toString();
    const url = `${API_BASE}/customers/${cid}${path.startsWith(":") ? "" : "/"}${path}${query ? `?${query}` : ""}`;
    return this.request<T>("GET", url);
  }

  // ── lote conversions-offline ──

  /* Data Manager API (datamanager.googleapis.com/v1): o caminho que o Google indica
     para importação offline depois da restrição de 15/06/2026 no UploadClickConversions.
     Usa o MESMO token OAuth, que precisa ter sido consentido também com o escopo
     https://www.googleapis.com/auth/datamanager — um token só com adwords recebe 403
     (escopo insuficiente). Não usa developer token nem login-customer-id: a conta de
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
}
