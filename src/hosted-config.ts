import { readFileSync } from "node:fs";
import type { GoogleAdsClientConfig, GoogleAdsCredentials, ServiceAccountKey } from "./google-ads-client.js";

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

/**
 * Chave JSON de service account (arquivo baixado do Google Cloud Console).
 * Validada aqui para que uma chave errada falhe com mensagem clara na primeira
 * chamada, e não como "invalid_grant" do endpoint de token.
 */
export function parseServiceAccountKeyJson(raw: string, source = "GOOGLE_ADS_SERVICE_ACCOUNT_JSON"): ServiceAccountKey {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${source} precisa ser um JSON válido (a chave da service account baixada do Cloud Console)`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} precisa ser um objeto JSON`);
  }
  const key = value as Record<string, unknown>;
  if (key.type !== undefined && key.type !== "service_account") {
    throw new Error(`${source}: type="${String(key.type)}" — esperado "service_account" (para OAuth de usuário use GOOGLE_ADS_CREDENTIALS_*)`);
  }
  if (typeof key.client_email !== "string" || !key.client_email.includes("@")) {
    throw new Error(`${source} sem client_email válido`);
  }
  if (typeof key.private_key !== "string" || !key.private_key.includes("PRIVATE KEY")) {
    throw new Error(`${source} sem private_key (PEM)`);
  }
  if (key.token_uri !== undefined && (typeof key.token_uri !== "string" || !key.token_uri.startsWith("https://"))) {
    throw new Error(`${source}: token_uri precisa ser uma URL https`);
  }
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    ...(typeof key.token_uri === "string" ? { token_uri: key.token_uri } : {}),
    ...(typeof key.private_key_id === "string" ? { private_key_id: key.private_key_id } : {}),
  };
}

/** Variáveis de credencial aceitas — exatamente uma precisa estar definida. */
export const CREDENTIAL_ENV_VARS = [
  "GOOGLE_ADS_CREDENTIALS_PATH",
  "GOOGLE_ADS_CREDENTIALS_JSON",
  "GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH",
  "GOOGLE_ADS_SERVICE_ACCOUNT_JSON",
] as const;

/**
 * Monta a parte de autenticação do GoogleAdsClient a partir das variáveis de
 * ambiente. Regras:
 * - exatamente uma credencial: OAuth de usuário (arquivo ou JSON) ou service
 *   account (arquivo ou JSON);
 * - GOOGLE_ADS_LOGIN_CUSTOMER_ID obrigatório;
 * - GOOGLE_ADS_DEVELOPER_TOKEN opcional: desde 09/09/2026 a API ignora o header
 *   e o nível de acesso é do projeto Google Cloud do OAuth client.
 */
export function resolveGoogleAdsAuth(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): Pick<GoogleAdsClientConfig, "credentials" | "credentialsPath" | "serviceAccount" | "developerToken" | "loginCustomerId"> {
  const defined = CREDENTIAL_ENV_VARS.filter((name) => (env[name] ?? "").trim() !== "");
  if (defined.length > 1) {
    throw new Error(`Defina apenas uma credencial — encontradas: ${defined.join(", ")}.`);
  }
  if (defined.length === 0) {
    throw new Error(
      "Nenhuma credencial definida: use GOOGLE_ADS_CREDENTIALS_PATH ou GOOGLE_ADS_CREDENTIALS_JSON (OAuth de usuário), " +
        "ou GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH ou GOOGLE_ADS_SERVICE_ACCOUNT_JSON (service account)."
    );
  }
  const loginCustomerId = (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").trim();
  if (!loginCustomerId) {
    throw new Error("GOOGLE_ADS_LOGIN_CUSTOMER_ID não definido.");
  }
  const developerToken = (env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "").trim() || undefined;
  const expandHome = (path: string) => path.trim().replace(/^~/, env.HOME ?? "");
  const base = { loginCustomerId, ...(developerToken ? { developerToken } : {}) };
  switch (defined[0]) {
    case "GOOGLE_ADS_CREDENTIALS_JSON":
      return { ...base, credentials: parseGoogleAdsCredentialsJson(env.GOOGLE_ADS_CREDENTIALS_JSON as string) };
    case "GOOGLE_ADS_SERVICE_ACCOUNT_JSON":
      return { ...base, serviceAccount: parseServiceAccountKeyJson(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON as string) };
    case "GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH": {
      const path = expandHome(env.GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH as string);
      return { ...base, serviceAccount: parseServiceAccountKeyJson(readFile(path), `GOOGLE_ADS_SERVICE_ACCOUNT_KEY_PATH (${path})`) };
    }
    default:
      return { ...base, credentialsPath: expandHome(env.GOOGLE_ADS_CREDENTIALS_PATH as string) };
  }
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
/** Curinga EXPLICITO: o serviço atende toda conta alcançável pelo MCC do login.
 *  Diferente de vazio — vazio é engano de configuração e continua derrubando o
 *  boot; "*" é o operador declarando o escopo (agência/gestor com um MCC só). */
export const ALLOW_ALL_CUSTOMERS = "*";

export function parseAllowedCustomerIds(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "ALLOWED_CUSTOMER_IDS is required: an empty allowlist is not a wildcard "
        + `(use ${ALLOW_ALL_CUSTOMERS} to serve every account under the login MCC)`,
    );
  }
  if (raw.trim() === ALLOW_ALL_CUSTOMERS) return [ALLOW_ALL_CUSTOMERS];
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => id.replace(/-/g, ""));
  if (ids.length === 0) {
    throw new Error(
      "ALLOWED_CUSTOMER_IDS is required: an empty allowlist is not a wildcard "
        + `(use ${ALLOW_ALL_CUSTOMERS} to serve every account under the login MCC)`,
    );
  }
  if (ids.includes(ALLOW_ALL_CUSTOMERS)) {
    throw new Error(
      `ALLOWED_CUSTOMER_IDS: ${ALLOW_ALL_CUSTOMERS} means every account and cannot be mixed with ids`,
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

/**
 * Gate for any HTTP-exposed run (port > 0). stdio (port 0) is untouched: there
 * the client spawns the process locally and no network surface exists.
 *
 * This used to apply only in read-only mode, which left the dangerous shape
 * unguarded: an HTTP deployment in write mode booted with no MCP_API_KEY, and
 * checkAuth lets every request through when the key is empty — exposing the
 * mutating tools to anyone who can reach the URL. The requirement now keys on
 * exposure, not on mode.
 */
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
  if (options.port <= 0) return;
  const mode = options.readOnly ? "hosted read-only mode" : "hosted write mode";
  if (!options.apiKey) {
    throw new Error(`MCP_API_KEY is required for ${mode}`);
  }
  if (options.allowedHosts.length === 0) {
    throw new Error(`MCP_ALLOWED_HOSTS is required for ${mode}`);
  }
  if ((options.allowedCustomerIds ?? []).length === 0) {
    throw new Error(`ALLOWED_CUSTOMER_IDS is required for ${mode}`);
  }
}
