/**
 * Cliente para Google Ads API (REST).
 * Versão da API configurável via GOOGLE_ADS_API_VERSION env var (default: v18).
 * Auth: OAuth 2.0 com auto-refresh, sem dependências Google.
 */

import { readFileSync, writeFileSync } from "node:fs";

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v23";
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
  credentialsPath: string;
  developerToken: string;
  loginCustomerId: string;
}

export interface MutateOperation {
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  remove?: string;
  updateMask?: string;
}

export class GoogleAdsClient {
  private credentials: GoogleAdsCredentials;
  private credentialsPath: string;
  private developerToken: string;
  private loginCustomerId: string;

  constructor(config: GoogleAdsClientConfig) {
    this.credentialsPath = config.credentialsPath;
    this.developerToken = config.developerToken;
    this.loginCustomerId = config.loginCustomerId.replace(/-/g, "");

    const raw = readFileSync(config.credentialsPath, "utf8");
    this.credentials = JSON.parse(raw) as GoogleAdsCredentials;
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

    // Persist refreshed token
    try {
      writeFileSync(this.credentialsPath, JSON.stringify(this.credentials, null, 2));
    } catch {
      // Non-fatal: token will be refreshed again next time
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

    // Google-specific error handling
    const dataObj = data as Record<string, unknown>;
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

  /** Generic mutate for any resource type. */
  async mutate(
    customerId: string,
    resource: string,
    operations: MutateOperation[]
  ): Promise<Record<string, unknown>> {
    const cid = customerId.replace(/-/g, "");
    const url = `${API_BASE}/customers/${cid}/${resource}:mutate`;
    return this.request<Record<string, unknown>>("POST", url, { operations });
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

  async mutateCampaignAssets(customerId: string, operations: MutateOperation[]) {
    return this.mutate(customerId, "campaignAssets", operations);
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
}
