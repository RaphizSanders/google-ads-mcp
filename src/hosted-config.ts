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

export function assertHostedReadOnlySecurity(options: {
  port: number;
  readOnly: boolean;
  apiKey: string;
  allowedHosts: string[];
}): void {
  if (options.port <= 0 || !options.readOnly) return;
  if (!options.apiKey) {
    throw new Error("MCP_API_KEY is required for hosted read-only mode");
  }
  if (options.allowedHosts.length === 0) {
    throw new Error("MCP_ALLOWED_HOSTS is required for hosted read-only mode");
  }
}
