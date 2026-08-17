import type { GoogleAdsCredentials } from "./google-ads-client.js";

const REQUIRED_CREDENTIAL_FIELDS = [
  "token",
  "refresh_token",
  "token_uri",
  "client_id",
  "client_secret",
] as const;

export function parseGoogleAdsCredentialsJson(raw: string): GoogleAdsCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_ADS_CREDENTIALS_JSON must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GOOGLE_ADS_CREDENTIALS_JSON must be a JSON object");
  }
  const credentials = value as Record<string, unknown>;
  for (const field of REQUIRED_CREDENTIAL_FIELDS) {
    if (typeof credentials[field] !== "string" || credentials[field].trim() === "") {
      throw new Error(`GOOGLE_ADS_CREDENTIALS_JSON is missing required field: ${field}`);
    }
  }
  if (credentials.expiry !== undefined && typeof credentials.expiry !== "string") {
    throw new Error("GOOGLE_ADS_CREDENTIALS_JSON field expiry must be a string when present");
  }
  return {
    token: credentials.token as string,
    refresh_token: credentials.refresh_token as string,
    token_uri: credentials.token_uri as string,
    client_id: credentials.client_id as string,
    client_secret: credentials.client_secret as string,
    ...(credentials.expiry ? { expiry: credentials.expiry as string } : {}),
  };
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const hosts = raw.split(",").map((host) => host.trim()).filter(Boolean);
  for (const host of hosts) {
    if (host.includes(":") || host.includes("/") || /\s/.test(host)) {
      throw new Error("MCP_ALLOWED_HOSTS must contain comma-separated hostnames without ports or paths");
    }
  }
  return [...new Set(hosts)];
}

/**
 * Parses ALLOWED_CUSTOMER_IDS, refusing anything that is not a real allowlist.
 *
 * The variable used to be optional, and an absent or empty value meant "do not
 * filter" — which reads as permissive-by-default on a server whose OAuth
 * credential can reach every customer under the MCC. One client's service
 * misconfigured that way would answer for another client's accounts, so the
 * empty case is now a startup failure rather than a wildcard.
 *
 * Ids are stored normalised without hyphens because Google writes them both
 * ways and a mismatch here would silently deny instead of silently allow.
 */
export function parseAllowedCustomerIds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "ALLOWED_CUSTOMER_IDS is required: an empty allowlist is not a wildcard",
    );
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => id.replace(/-/g, ""));
  if (ids.length === 0) {
    throw new Error(
      "ALLOWED_CUSTOMER_IDS is required: an empty allowlist is not a wildcard",
    );
  }
  for (const id of ids) {
    if (!/^\d{10}$/.test(id)) {
      throw new Error(
        "ALLOWED_CUSTOMER_IDS must be comma-separated 10-digit customer ids",
      );
    }
  }
  return [...new Set(ids)];
}

export function assertHostedReadOnlySecurity(options: {
  port: number;
  readOnly: boolean;
  apiKey: string;
  allowedHosts: string[];
  /* Optional in the type so a caller that forgets it lands on the fail-closed
     branch with a readable message instead of a TypeError. Absent is treated
     exactly like empty: nobody said which customers. */
  allowedCustomerIds?: string[];
}): void {
  if (options.port <= 0 || !options.readOnly) return;
  if (!options.apiKey) {
    throw new Error("MCP_API_KEY is required for hosted read-only mode");
  }
  if (options.allowedHosts.length === 0) {
    throw new Error("MCP_ALLOWED_HOSTS is required for hosted read-only mode");
  }
  if ((options.allowedCustomerIds ?? []).length === 0) {
    throw new Error(
      "ALLOWED_CUSTOMER_IDS is required for hosted read-only mode",
    );
  }
}
